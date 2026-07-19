/**
 * The two prompts. Both are deliberately narrow.
 *
 * The model is never asked what it knows about basketball. It is asked to
 * translate a question into SQL, and later to describe rows it was handed.
 * Every number the user sees comes from D1 in between.
 *
 * Note on how this model behaves: it follows SCHEMA COMMENTS far more reliably
 * than rules in the system prompt. A fix that was ignored as a prompt rule
 * worked immediately once moved into a comment on the column. When something
 * isn't being respected, put it in the schema.
 */

export const SCHEMA = `
-- Season averages. USE THIS TABLE to count games played; seasons.games is the
-- authoritative regular-season total.
CREATE TABLE seasons (
  season TEXT PRIMARY KEY,   -- '2012-13'
  team TEXT,                 -- 'CLE' | 'MIA' | 'LAL'
  age INTEGER,
  games INTEGER,             -- REGULAR SEASON games played that season. SUM(games) for a career or team total.
  ppg REAL, rpg REAL, apg REAL,
  fg_pct REAL,               -- decimal proportion, e.g. 0.417 = 41.7%. Present it as a percentage.
);

-- EVERY game he has played, regular season and playoffs. Complete, not a sample.
CREATE TABLE games (
  id INTEGER PRIMARY KEY,
  date TEXT,                 -- 'YYYY-MM-DD'
  season TEXT,               -- joins seasons.season
  team TEXT,                 -- HIS OWN team that season: 'CLE' | 'MIA' | 'LAL'
  opponent TEXT,             -- the team he played AGAINST: 'BOS', 'GSW', 'SAS'
  home INTEGER,              -- 1 home, 0 away
  minutes INTEGER,
  points INTEGER, rebounds INTEGER, assists INTEGER,
  steals INTEGER, blocks INTEGER, turnovers INTEGER,
  playoff INTEGER,           -- 1 playoff, 0 regular season
  note TEXT                  -- e.g. 'Playoffs, Triple-double'
);

-- NOTE: there is no awards, salary, draft, or biographical data. MVPs, rings,
-- All-NBA selections and contracts are NOT in this database — such questions
-- are UNANSWERABLE.`.trim();

export function sqlPrompt(question) {
  return [
    {
      role: 'system',
      content: `You translate questions about a basketball statistics database into SQLite queries.

Schema:
${SCHEMA}

Rules:
- Reply with ONE SQLite SELECT statement and nothing else.
- No explanation, no markdown fences, no trailing semicolon.
- Only SELECT. Never INSERT, UPDATE, DELETE, DROP, or PRAGMA.
- Team and opponent are 3-letter uppercase codes.
- "against X" / "versus X" / "played X" always means opponent = 'X', never team = 'X'.
- "40+", "40 or more", "at least 40" are INCLUSIVE: use >= 40, never > 40. Off-by-one here silently drops real games.
- A "triple-double" means points >= 10 AND rebounds >= 10 AND assists >= 10.
- "Playoffs" or "postseason" means playoff = 1. Questions that don't mention the playoffs cover both.
- For "most/best/highest X in a game", do NOT use LIMIT 1 — it hides ties and the answer would claim one game when several share the record. Use:
  SELECT date, opponent, X FROM games WHERE X = (SELECT MAX(X) FROM games) ORDER BY date
- "career high" on its own always means POINTS. "Minutes in his career high game" means the minutes of the highest-scoring game: SELECT date, opponent, minutes, points FROM games ORDER BY points DESC LIMIT 1 — order by the stat named, not by the stat asked for.
- Select the columns needed to answer, not just one — include date, opponent and the relevant stat so the answer can be checked.
- If the question cannot be answered from these tables, reply exactly: UNANSWERABLE`,
    },
    { role: 'user', content: question },
  ];
}

export function prosePrompt(question, sql, rows, truncated = false) {
  return [
    {
      role: 'system',
      content: `You describe database results in one or two plain sentences.

Absolute rules:
- Use ONLY the numbers in the provided rows. They are the only facts you have.
- Never add statistics, dates, context, or commentary from your own knowledge.
- The rows are never empty. Every row given to you is a real result — describe them all.
- Never say there are no results, no matches, or no data.
- If several rows tie for the top value, say so rather than picking one.
- Any column ending in _pct is a decimal proportion. ALWAYS express it as a percentage to one decimal place: 0.417 becomes 41.7%, 0.565 becomes 56.5%. Never read the raw decimal aloud.
- If the rows are marked CAPPED, do not state a total count — the list is incomplete. Describe what is shown without implying it is all of them.
- No preamble. No "Based on the data". Just the answer.`,
    },
    {
      role: 'user',
      content: `Question: ${question}

Query that ran:
${sql}

Rows returned (${rows.length}${truncated ? ', CAPPED — there are more results than shown' : ''}):
${rows.length ? JSON.stringify(rows, null, 2) : '(none)'}`,
    },
  ];
}
