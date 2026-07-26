-- Stat Oracle schema.
--
-- Kept deliberately small and flat. The whole schema is pasted into the model's
-- prompt on every request, so every column here costs tokens and every extra
-- table is another chance for the model to write a bad join.

DROP TABLE IF EXISTS games;
DROP TABLE IF EXISTS seasons;
DROP TABLE IF EXISTS data_provenance;

-- Where the numbers came from, and whether they can be trusted.
-- While verified = 0 the UI shows a placeholder banner. The app is designed to
-- be honest about its own data before it is honest about anything else.
CREATE TABLE data_provenance (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  verified    INTEGER NOT NULL DEFAULT 0,
  source      TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE seasons (
  season      TEXT PRIMARY KEY,   -- '2012-13'
  team        TEXT NOT NULL,      -- 'CLE' | 'MIA' | 'LAL'
  age         INTEGER NOT NULL,
  games       INTEGER NOT NULL,
  ppg         REAL NOT NULL,
  rpg         REAL NOT NULL,
  apg         REAL NOT NULL,
  fg_pct      REAL
);

-- EVERY game, regular season and playoffs — not a sample.
--
-- This started as a curated 238-game subset chosen by scoring thresholds. That
-- was a mistake: "his best blocking game" would have searched only games picked
-- for their scoring, returned a local maximum, and presented it as a career
-- high. A partial table answers questions it cannot actually answer.
CREATE TABLE games (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,      -- ISO 'YYYY-MM-DD', sorts correctly as text
  season      TEXT NOT NULL,
  team        TEXT NOT NULL,
  opponent    TEXT NOT NULL,      -- 3-letter code
  home        INTEGER NOT NULL,   -- 1 = home, 0 = away
  minutes     INTEGER,            -- whole minutes played
  points      INTEGER NOT NULL,
  rebounds    INTEGER NOT NULL,
  assists     INTEGER NOT NULL,
  steals      INTEGER,
  blocks      INTEGER,
  turnovers   INTEGER,
  playoff     INTEGER NOT NULL DEFAULT 0,
  note        TEXT,               -- 'Playoffs, Triple-double' — something to describe
  FOREIGN KEY (season) REFERENCES seasons(season)
);

-- Every ingestion run, successful or not.
--
-- The cron used to console.log its summary and that was the whole record,
-- which left the worst failure invisible: the feed changes shape, ingestion
-- finds zero new games every night, and the cron keeps reporting success.
-- Nothing alerts because nothing errored. A row per run makes "it has been
-- quietly doing nothing since Tuesday" something you can actually see.
CREATE TABLE ingest_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at           TEXT    NOT NULL,   -- ISO timestamp, UTC
  trigger          TEXT    NOT NULL,   -- 'cron' | 'manual'
  ok               INTEGER NOT NULL,   -- 1 success, 0 threw
  new_games        INTEGER NOT NULL DEFAULT 0,
  seasons_upserted TEXT,               -- JSON array of season labels
  since            TEXT,               -- watermark going in
  latest           TEXT,               -- watermark coming out
  ms               INTEGER,
  error            TEXT                -- message when ok = 0
);

CREATE INDEX idx_ingest_runs_ran_at ON ingest_runs(ran_at);

CREATE INDEX idx_games_points   ON games(points);
CREATE INDEX idx_games_opponent ON games(opponent);
CREATE INDEX idx_games_date     ON games(date);
CREATE INDEX idx_games_playoff  ON games(playoff);
CREATE INDEX idx_games_blocks   ON games(blocks);
CREATE INDEX idx_games_steals   ON games(steals);
