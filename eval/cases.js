/**
 * The answer key.
 *
 * Each case pairs a question in English with a query we wrote ourselves and
 * trust. The runner executes both and checks they agree — so we are testing
 * whether the model gets the same ANSWER, not whether it writes the same SQL.
 * There are many correct ways to phrase a query; string-matching them would
 * fail on harmless rewording and pass on subtly wrong logic.
 *
 * Expected values are never hard-coded. They come from running `truth` against
 * the live database, so reloading the dataset moves the expectations with it
 * and fixtures cannot go stale.
 *
 * Cases tagged `regression` are bugs that actually shipped. Each one is now
 * incapable of coming back silently. Do not delete them.
 */

export const cases = [
  // ---------------------------------------------------------------- regressions
  {
    id: 'opponent-not-team',
    tag: 'regression',
    ask: 'When did he score 40 or more against Boston?',
    truth: `SELECT date, points FROM games WHERE opponent = 'BOS' AND points >= 40 ORDER BY date`,
    note: 'bug 2 — generated team = BOS, but team is HIS team. Returned zero rows.',
  },
  {
    id: 'inclusive-forty-plus',
    tag: 'regression',
    ask: 'In how many playoff games did he score 40 or more?',
    truth: `SELECT COUNT(*) AS n FROM games WHERE points >= 40 AND playoff = 1`,
    sqlMatches: />=\s*40/,
    note: 'bug 6 — generated points > 40, silently dropping exactly-40-point games. Scoped to the playoffs so the count stays under the row cap and this tests the operator, not truncation.',
  },
  {
    id: 'truncation-disclosed',
    tag: 'regression',
    ask: 'What games did he score 40+ in?',
    truncates: true,
    note: 'bug 10 — 108 results, capped to 100 by the guard, and presented as complete. Found by this harness on its first full run. The answer must now admit it is partial.',
  },
  {
    id: 'count-uses-seasons',
    tag: 'regression',
    ask: 'How many games did he play in Miami?',
    truth: `SELECT SUM(games) AS total FROM seasons WHERE team = 'MIA'`,
    note: 'bug 3 — counted rows in seasons (2) and reported "2 games in Miami".',
  },
  {
    id: 'awards-refused',
    tag: 'regression',
    ask: 'How many MVPs did he win?',
    refuses: true,
    note: 'bug 5 — answered 0 from an empty accolades column. The worst kind of wrong.',
  },
  {
    id: 'blocks-tie',
    tag: 'regression',
    ask: 'What game did he have the highest number of blocks?',
    truth: `SELECT date, blocks FROM games WHERE blocks = (SELECT MAX(blocks) FROM games) ORDER BY date`,
    note: 'bug 8 — LIMIT 1 reported one game when three share the record.',
  },
  {
    id: 'career-high-minutes',
    tag: 'regression',
    ask: 'How many minutes did he play in his career high game?',
    truth: `SELECT date, minutes, points FROM games ORDER BY points DESC LIMIT 1`,
    note: 'bug 9 — ordered by minutes, returning his longest game (54) not his highest-scoring (41).',
  },
  {
    id: 'blocks-outside-sample',
    tag: 'regression',
    ask: 'What is the most blocks he has had in a game?',
    truth: `SELECT MAX(blocks) AS most FROM games`,
    note: 'bug 7 — the old 238-game sample was curated on scoring, so his best blocking games (21, 17, 15 pts) were absent entirely.',
  },
  {
    id: 'empty-result-not-denied',
    tag: 'regression',
    ask: 'When did he score 50 or more against Chicago?',
    truth: `SELECT date, points FROM games WHERE opponent = 'CHI' AND points >= 50`,
    note: 'bug 4 — the prose model claimed "no matching games" ~1 run in 3 even when rows existed. This case genuinely has none, so it must report that cleanly.',
  },

  // ------------------------------------------------------------------ coverage
  {
    id: 'career-high',
    ask: 'What was his career high?',
    truth: `SELECT MAX(points) AS high FROM games`,
  },
  {
    id: 'best-scoring-season',
    ask: 'What was his best scoring season?',
    truth: `SELECT season, ppg FROM seasons ORDER BY ppg DESC LIMIT 1`,
  },
  {
    id: 'total-games',
    ask: 'How many total regular season games has he played?',
    truth: `SELECT SUM(games) AS total FROM seasons`,
  },
  {
    id: 'playoff-triple-doubles',
    ask: 'Which playoff games were triple-doubles?',
    truth: `SELECT date, points, rebounds, assists FROM games
            WHERE playoff = 1 AND points >= 10 AND rebounds >= 10 AND assists >= 10
            ORDER BY date`,
  },
  {
    id: 'most-steals',
    ask: 'What was his best game for steals?',
    truth: `SELECT date, steals FROM games WHERE steals = (SELECT MAX(steals) FROM games) ORDER BY date`,
  },
  {
    id: 'lakers-games',
    ask: 'How many games did he play for the Lakers?',
    truth: `SELECT SUM(games) AS total FROM seasons WHERE team = 'LAL'`,
  },
  {
    id: 'fifty-point-games',
    ask: 'How many times did he score 50 or more?',
    truth: `SELECT COUNT(*) AS n FROM games WHERE points >= 50`,
  },
  {
    id: 'home-vs-away-forty',
    ask: 'How many 40-point games did he have at home?',
    truth: `SELECT COUNT(*) AS n FROM games WHERE points >= 40 AND home = 1`,
  },

  {
    id: 'last-season-not-stale',
    tag: 'regression',
    ask: 'What was his highest scoring game this past season?',
    truth: `SELECT MAX(points) AS high FROM games WHERE season = (SELECT MAX(season) FROM seasons)`,
    note: 'bug 12 — "this past season" became WHERE season = \'2022-23\': the model resolved "now" against its training data. The prompt now carries today\'s date and the latest season in the database.',
  },

  // ----------------------------------------------------------- follow-ups
  // These send `history` — prior exchanges — and test that the SQL model
  // resolves a conversational question against them. The dangerous failure
  // modes: dropping the carried conditions, or carrying them into a fresh
  // question that should have none.
  {
    id: 'followup-carries-conditions',
    ask: 'What about only the playoffs?',
    history: [{
      question: 'When did he score 40 or more against Boston?',
      sql: `SELECT date, opponent, points FROM games WHERE opponent = 'BOS' AND points >= 40`,
    }],
    truth: `SELECT date, points FROM games WHERE opponent = 'BOS' AND points >= 40 AND playoff = 1 ORDER BY date`,
    note: 'must keep opponent AND threshold from the prior turn while adding playoff = 1',
  },
  {
    id: 'followup-swaps-stat',
    ask: 'What about rebounds?',
    history: [{
      question: 'How many points per game did he average each season?',
      sql: 'SELECT season, ppg FROM seasons',
    }],
    truth: `SELECT season, rpg FROM seasons ORDER BY season`,
    note: 'same shape as the prior turn, different stat',
  },
  {
    id: 'followup-swaps-opponent',
    ask: 'And against Golden State?',
    history: [{
      question: 'When did he score 40 or more against Boston?',
      sql: `SELECT date, opponent, points FROM games WHERE opponent = 'BOS' AND points >= 40`,
    }],
    truth: `SELECT date, points FROM games WHERE opponent = 'GSW' AND points >= 40 ORDER BY date`,
    note: 'replaces the opponent, keeps the threshold',
  },
  {
    id: 'followup-fresh-question',
    ask: 'What was his career high?',
    history: [{
      question: 'When did he score 40 or more against Boston?',
      sql: `SELECT date, opponent, points FROM games WHERE opponent = 'BOS' AND points >= 40`,
    }],
    truth: `SELECT MAX(points) AS high FROM games`,
    note: 'a complete question must NOT inherit the Boston filter from history',
  },

  // ------------------------------------------------------------- must refuse
  {
    id: 'three-point-refused',
    tag: 'regression',
    ask: 'What was his best 3-point percentage season?',
    refuses: true,
    note: 'bug 11 — answered with OVERALL fg_pct as if it were a 3-point stat. There is no three-point data; substituting a different stat is a confidently wrong answer.',
  },
  {
    id: 'salary-refused',
    ask: 'What is his salary?',
    refuses: true,
  },
  {
    id: 'goat-refused',
    ask: 'Who is the greatest basketball player of all time?',
    refuses: true,
  },
  {
    id: 'championships-refused',
    ask: 'How many championships has he won?',
    refuses: true,
    note: 'No awards data. Must refuse rather than infer from anything.',
  },
];
