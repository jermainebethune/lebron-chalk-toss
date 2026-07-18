#!/usr/bin/env node
/**
 * Generate seed.sql from the balldontlie API.
 *
 * Run:  node extract.mjs > seed.sql
 *
 * Reads the API key from ~/.balldontlie_key so it never lands in the repo.
 * The key is only needed here — the deployed Worker reads D1 and nothing else.
 *
 * Two tables come out:
 *   seasons — one row per season, from /season_averages (authoritative totals)
 *   games   — a CURATED SAMPLE of notable games, filtered from /stats
 *
 * The games table is deliberately not every game. The schema and the model
 * prompt both say so, and counting questions are routed to seasons.games
 * instead. Loading 1,500 rows would bloat the demo without answering anything
 * the sample can't.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY = readFileSync(join(homedir(), '.balldontlie_key'), 'utf8').trim();
const PLAYER_ID = 237;
const BASE = 'https://api.balldontlie.io/v1';

// balldontlie labels a season by its starting year: 2013 === the 2013-14 season.
const FIRST_SEASON = 2003;
const LAST_SEASON = 2024;

// Team id -> abbreviation, resolved once from /teams.
let TEAMS = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, attempt = 1) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: KEY } });

  if (res.status === 429) {
    // Rate limited. Back off and retry rather than producing a partial file —
    // a seed.sql with silently missing seasons is worse than a failed run.
    if (attempt > 5) throw new Error(`rate limited repeatedly on ${path}`);
    const wait = 2000 * attempt;
    console.error(`  rate limited, waiting ${wait}ms (attempt ${attempt})`);
    await sleep(wait);
    return api(path, attempt + 1);
  }

  if (!res.ok) throw new Error(`${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

const esc = (s) => String(s).replace(/'/g, "''");

/** Season label balldontlie's start-year uses: 2013 -> '2013-14'. */
const label = (startYear) => `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;

async function loadTeams() {
  const { data } = await api('/teams');
  TEAMS = Object.fromEntries(data.map((t) => [t.id, t.abbreviation]));
}

async function seasonRows() {
  const rows = [];
  for (let year = FIRST_SEASON; year <= LAST_SEASON; year++) {
    console.error(`season_averages ${label(year)}`);
    const { data } = await api(`/season_averages?season=${year}&player_id=${PLAYER_ID}`);
    if (!data.length) {
      console.error(`  no data for ${label(year)}, skipping`);
      continue;
    }
    rows.push({ year, avg: data[0] });
    await sleep(250);
  }
  return rows;
}

/** Every game log for the career, following the cursor. */
async function allGames() {
  const seasons = Array.from(
    { length: LAST_SEASON - FIRST_SEASON + 1 },
    (_, i) => `seasons[]=${FIRST_SEASON + i}`
  ).join('&');

  const out = [];
  let cursor = null;
  let page = 0;

  do {
    page++;
    const q = `/stats?player_ids[]=${PLAYER_ID}&${seasons}&per_page=100${cursor ? `&cursor=${cursor}` : ''}`;
    const { data, meta } = await api(q);
    out.push(...data);
    cursor = meta?.next_cursor ?? null;
    console.error(`game logs page ${page} (${out.length} so far)`);
    await sleep(250);
  } while (cursor);

  return out;
}

/**
 * Pick the games worth keeping.
 *
 * Selection is by objective statistical threshold, not by reputation — every
 * included game earns its place from its own line, so the sample is defensible
 * and reproducible rather than a matter of taste.
 */
function curate(stats) {
  const notable = (s) => {
    const tripleDouble = s.pts >= 10 && s.reb >= 10 && s.ast >= 10;
    return (
      s.pts >= 40 ||                              // big scoring nights
      (s.game.postseason && s.pts >= 35) ||       // playoff explosions
      (tripleDouble && s.game.postseason) ||      // playoff triple-doubles
      (tripleDouble && s.pts >= 25)               // heavy regular-season TDs
    );
  };

  return stats
    .filter((s) => s.pts != null && s.game?.date && notable(s))
    .sort((a, b) => a.game.date.localeCompare(b.game.date));
}

function toGameRow(s) {
  const g = s.game;
  const myTeamId = s.team.id;
  const isHome = g.home_team_id === myTeamId;
  const opponentId = isHome ? g.visitor_team_id : g.home_team_id;

  const tripleDouble = s.pts >= 10 && s.reb >= 10 && s.ast >= 10;
  const notes = [];
  if (g.postseason) notes.push('Playoffs');
  if (tripleDouble) notes.push('Triple-double');
  if (s.pts >= 50) notes.push('50-point game');
  else if (s.pts >= 40) notes.push('40-point game');

  return {
    date: g.date.slice(0, 10),
    season: label(g.season),
    team: TEAMS[myTeamId] ?? '???',
    opponent: TEAMS[opponentId] ?? '???',
    home: isHome ? 1 : 0,
    points: s.pts,
    rebounds: s.reb,
    assists: s.ast,
    playoff: g.postseason ? 1 : 0,
    note: notes.join(', ') || null,
  };
}

async function main() {
  console.error('resolving teams...');
  await loadTeams();

  const seasons = await seasonRows();
  const stats = await allGames();
  const curated = curate(stats).map(toGameRow);

  console.error(`\n${seasons.length} seasons, ${stats.length} games played, ${curated.length} curated\n`);

  const teamFor = (year) => {
    const g = stats.find((s) => s.game.season === year);
    return g ? TEAMS[g.team.id] ?? '???' : '???';
  };

  const out = [];
  out.push('-- Generated by extract.mjs from the balldontlie API.');
  out.push(`-- Source: api.balldontlie.io  |  Player ID ${PLAYER_ID}  |  Seasons ${label(FIRST_SEASON)}..${label(LAST_SEASON)}`);
  out.push('-- Do not hand-edit. Re-run: node extract.mjs > seed.sql');
  out.push('');
  out.push('DELETE FROM games;');
  out.push('DELETE FROM seasons;');
  out.push('DELETE FROM data_provenance;');
  out.push('');

  out.push('INSERT INTO seasons (season, team, age, games, ppg, rpg, apg, fg_pct) VALUES');
  const seasonVals = seasons.map(({ year, avg }) => {
    // Born 30 Dec 1984 — age during the bulk of a season starting in `year`.
    const age = year - 1984;
    return `  ('${label(year)}', '${teamFor(year)}', ${age}, ${avg.games_played}, ` +
      `${avg.pts}, ${avg.reb}, ${avg.ast}, ${avg.fg_pct})`;
  });
  out.push(seasonVals.join(',\n') + ';');
  out.push('');

  out.push('INSERT INTO games (date, season, team, opponent, home, points, rebounds, assists, playoff, note) VALUES');
  const gameVals = curated.map((g) =>
    `  ('${g.date}', '${g.season}', '${g.team}', '${g.opponent}', ${g.home}, ` +
    `${g.points}, ${g.rebounds}, ${g.assists}, ${g.playoff}, ` +
    `${g.note ? `'${esc(g.note)}'` : 'NULL'})`
  );
  out.push(gameVals.join(',\n') + ';');
  out.push('');

  const today = new Date().toISOString().slice(0, 10);
  out.push('INSERT INTO data_provenance (id, verified, source, updated_at) VALUES');
  out.push(`  (1, 1, 'balldontlie API (api.balldontlie.io), player ${PLAYER_ID}', '${today}');`);

  console.log(out.join('\n'));
}

main().catch((err) => {
  console.error('\nEXTRACTION FAILED:', err.message);
  console.error('No seed.sql written. Fix the error and re-run — a partial file would be worse.');
  process.exit(1);
});
