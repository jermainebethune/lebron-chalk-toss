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

CREATE TABLE games (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,      -- ISO 'YYYY-MM-DD', sorts correctly as text
  season      TEXT NOT NULL,
  team        TEXT NOT NULL,
  opponent    TEXT NOT NULL,      -- 3-letter code
  home        INTEGER NOT NULL,   -- 1 = home, 0 = away
  points      INTEGER NOT NULL,
  rebounds    INTEGER NOT NULL,
  assists     INTEGER NOT NULL,
  playoff     INTEGER NOT NULL DEFAULT 0,
  note        TEXT,               -- 'Game 6, ECF' — gives the model something to describe
  FOREIGN KEY (season) REFERENCES seasons(season)
);

CREATE INDEX idx_games_points   ON games(points);
CREATE INDEX idx_games_opponent ON games(opponent);
CREATE INDEX idx_games_date     ON games(date);
CREATE INDEX idx_games_playoff  ON games(playoff);
