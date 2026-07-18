/**
 * The two prompts. Both are deliberately narrow.
 *
 * The model is never asked what it knows about basketball. It is asked to
 * translate a question into SQL, and later to describe rows it was handed.
 * Every number the user sees comes from D1 in between.
 */

export const SCHEMA = `
-- USE THIS TABLE to count games played. seasons.games is the true total.
CREATE TABLE seasons (
  season TEXT PRIMARY KEY,   -- '2012-13'
  team TEXT,                 -- 'CLE' | 'MIA' | 'LAL'
  age INTEGER,
  games INTEGER,             -- REGULAR SEASON games played that season. SUM(games) for a career or team total.
  ppg REAL, rpg REAL, apg REAL, fg_pct REAL
);
-- NOTE: there is no awards/championships data. MVPs, rings and All-NBA
-- selections are NOT in this database — such questions are UNANSWERABLE.

-- A SAMPLE of notable games only, NOT every game he played.
-- NEVER use COUNT(*) on this table to answer "how many games" — it will undercount.
CREATE TABLE games (
  id INTEGER PRIMARY KEY,
  date TEXT,                 -- 'YYYY-MM-DD'
  season TEXT,               -- joins seasons.season
  team TEXT,                 -- HIS OWN team that season: 'CLE' | 'MIA' | 'LAL'
  opponent TEXT,             -- the team he played AGAINST: 'BOS', 'GSW', 'SAS'
  home INTEGER,              -- 1 home, 0 away
  points INTEGER, rebounds INTEGER, assists INTEGER,
  playoff INTEGER,           -- 1 playoff, 0 regular season
  note TEXT                  -- e.g. 'Game 6, ECF'
);`.trim();

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
- Select the columns needed to answer, not just one — include date, opponent and the relevant stat so the answer can be checked.
- IMPORTANT: the games table holds only selected notable games, NOT every game played. Never use it to count how many games he played.
- To count games played, use seasons.games — e.g. total games for a team is SELECT SUM(games) FROM seasons WHERE team = 'MIA'.
- Use the games table only for questions about individual game performances.
- A "triple-double" means points >= 10 AND rebounds >= 10 AND assists >= 10.
- "Playoffs" or "postseason" means playoff = 1.
- If the question cannot be answered from these tables, reply exactly: UNANSWERABLE`,
    },
    { role: 'user', content: question },
  ];
}

export function prosePrompt(question, sql, rows) {
  return [
    {
      role: 'system',
      content: `You describe database results in one or two plain sentences.

Absolute rules:
- Use ONLY the numbers in the provided rows. They are the only facts you have.
- Never add statistics, dates, context, or commentary from your own knowledge.
- The rows are never empty. Every row given to you is a real result — describe them all.
- Never say there are no results, no matches, or no data.
- No preamble. No "Based on the data". Just the answer.`,
    },
    {
      role: 'user',
      content: `Question: ${question}

Query that ran:
${sql}

Rows returned (${rows.length}):
${rows.length ? JSON.stringify(rows, null, 2) : '(none)'}`,
    },
  ];
}
