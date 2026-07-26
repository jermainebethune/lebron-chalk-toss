/**
 * Scheduled ingestion — the database keeps itself current.
 *
 * A cron trigger (and a key-gated /api/ingest for manual runs) polls the
 * balldontlie API for games newer than MAX(games.date), inserts them, upserts
 * the affected season rows, and stamps data_provenance. During the season the
 * site updates itself the morning after every game; in the offseason each run
 * finds nothing and says so.
 *
 * Design decisions worth keeping:
 *
 * - The watermark is MAX(date), polled per-season from the season the
 *   watermark falls in through the current one — so a stale database (or a
 *   cron that was down for months) backfills whole missed seasons, not just
 *   yesterday.
 * - The stats feed includes DNP rows: games where he was on the roster but
 *   never played, reported as 0 minutes and 0 everything. Those are NOT
 *   games played — ingesting them would poison "his worst scoring game" with
 *   fake zeros. A row must have actual floor time (seconds > 0) to count.
 * - seasons rows are UPSERTed (ON CONFLICT DO UPDATE), never REPLACEd —
 *   REPLACE deletes the parent row first, which games.season references.
 * - Seasons are inserted before games so the foreign key always has a parent.
 * - Everything is idempotent: a re-run after success finds nothing new.
 */

const PLAYER_ID = 237;
const BASE = 'https://api.balldontlie.io/v1';
const BORN = 1984; // age during the bulk of a season starting in year Y is Y - 1984

/** balldontlie labels a season by its starting year: 2013 === '2013-14'. */
const label = (startYear) => `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;

/** Season start-year a date belongs to: Oct-Dec start a season, Jan-Sep finish one. */
const seasonYearOf = (isoDate) => {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  return m >= 10 ? y : y - 1;
};

/** "38:01" -> 2281 seconds. "00" and null -> 0: a DNP, not a game. */
function playedSeconds(min) {
  if (!min || typeof min !== 'string') return 0;
  const [m, s] = min.split(':').map((x) => parseInt(x, 10));
  return (Number.isFinite(m) ? m * 60 : 0) + (Number.isFinite(s) ? s : 0);
}

async function api(env, path, attempt = 1) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: env.BALLDONTLIE_KEY },
  });
  if (res.status === 429 && attempt <= 3) {
    await new Promise((r) => setTimeout(r, 1500 * attempt));
    return api(env, path, attempt + 1);
  }
  if (!res.ok) throw new Error(`balldontlie ${res.status} on ${path}`);
  return res.json();
}

async function newGamesForSeason(env, year, since, teams) {
  const out = [];
  let cursor = null;
  do {
    const q = `/stats?player_ids[]=${PLAYER_ID}&seasons[]=${year}&per_page=100${cursor ? `&cursor=${cursor}` : ''}`;
    const { data, meta } = await api(env, q);
    for (const s of data) {
      const date = s.game?.date?.slice(0, 10);
      if (!date || date <= since) continue;
      if (s.pts == null || playedSeconds(s.min) === 0) continue; // DNP or empty line
      const g = s.game;
      const isHome = g.home_team_id === s.team.id;
      const opponentId = isHome ? g.visitor_team_id : g.home_team_id;
      const tripleDouble = s.pts >= 10 && s.reb >= 10 && s.ast >= 10;
      const notes = [];
      if (g.postseason) notes.push('Playoffs');
      if (tripleDouble) notes.push('Triple-double');
      if (s.pts >= 50) notes.push('50-point game');
      else if (s.pts >= 40) notes.push('40-point game');
      out.push({
        date,
        season: label(g.season),
        team: teams[s.team.id] ?? '???',
        opponent: teams[opponentId] ?? '???',
        home: isHome ? 1 : 0,
        minutes: Math.floor(playedSeconds(s.min) / 60),
        points: s.pts,
        rebounds: s.reb,
        assists: s.ast,
        steals: s.stl ?? null,
        blocks: s.blk ?? null,
        turnovers: s.turnover ?? null,
        playoff: g.postseason ? 1 : 0,
        note: notes.join(', ') || null,
      });
    }
    cursor = meta?.next_cursor ?? null;
  } while (cursor);
  return out;
}

async function upsertSeason(env, year, teamCode) {
  const { data } = await api(env, `/season_averages?season=${year}&player_id=${PLAYER_ID}`);
  if (!data.length) return false;
  const a = data[0];
  await env.DB.prepare(
    `INSERT INTO seasons (season, team, age, games, ppg, rpg, apg, fg_pct)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(season) DO UPDATE SET
       team = ?2, games = ?4, ppg = ?5, rpg = ?6, apg = ?7, fg_pct = ?8`
  ).bind(label(year), teamCode, year - BORN, a.games_played, a.pts, a.reb, a.ast, a.fg_pct).run();
  return true;
}

export async function ingest(env) {
  const started = Date.now();
  const sinceRow = await env.DB.prepare('SELECT MAX(date) AS d FROM games').first();
  const since = sinceRow?.d;
  if (!since) {
    // An empty database is a seeding problem, not an ingestion one. Appending
    // to nothing would silently rebuild the world without provenance.
    throw new Error('games table is empty — seed it before ingesting');
  }

  const now = new Date();
  const currentYear = now.getUTCMonth() + 1 >= 10 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const years = [];
  for (let y = seasonYearOf(since); y <= currentYear; y++) years.push(y);

  const { data: teamData } = await api(env, '/teams');
  const teams = Object.fromEntries(teamData.map((t) => [t.id, t.abbreviation]));

  const rows = [];
  for (const y of years) rows.push(...await newGamesForSeason(env, y, since, teams));
  rows.sort((a, b) => a.date.localeCompare(b.date));

  const summary = {
    since,
    seasonsChecked: years.map(label),
    newGames: rows.length,
    seasonsUpserted: [],
    latest: rows.length ? rows[rows.length - 1].date : since,
    ms: 0,
  };

  if (rows.length) {
    // Season rows first — games.season needs its parent to exist. The team on
    // the season row is the team of his most recent game that season, so a
    // midseason trade ends up recorded under the team he finished with.
    const bySeason = new Map();
    for (const r of rows) bySeason.set(seasonYearOf(r.date), r.team);
    for (const [year, team] of bySeason) {
      if (await upsertSeason(env, year, team)) summary.seasonsUpserted.push(label(year));
    }

    const insert = env.DB.prepare(
      `INSERT INTO games (date, season, team, opponent, home, minutes, points, rebounds, assists, steals, blocks, turnovers, playoff, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < rows.length; i += 50) {
      await env.DB.batch(rows.slice(i, i + 50).map((g) =>
        insert.bind(g.date, g.season, g.team, g.opponent, g.home, g.minutes, g.points,
          g.rebounds, g.assists, g.steals, g.blocks, g.turnovers, g.playoff, g.note)
      ));
    }

    await env.DB.prepare(
      `UPDATE data_provenance SET updated_at = ?1 WHERE id = 1`
    ).bind(now.toISOString().slice(0, 10)).run();
  }

  summary.ms = Date.now() - started;
  return summary;
}
