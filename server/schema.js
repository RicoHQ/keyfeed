// SQLite schema shared by Node (node:sqlite) and Cloudflare Durable Objects (ctx.storage.sql).
// One statement per array entry: Durable Objects can't run PRAGMA/BEGIN and prefer single statements.

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    avatar_url TEXT,
    cover_url TEXT,
    country TEXT NOT NULL,
    pp REAL, pp_4k REAL, pp_7k REAL,
    global_rank INTEGER, country_rank INTEGER,
    accuracy REAL, play_count INTEGER, ranked_score INTEGER,
    on_roster INTEGER NOT NULL DEFAULT 0,
    initialized INTEGER NOT NULL DEFAULT 0,
    best_loaded INTEGER NOT NULL DEFAULT 0,
    last_polled INTEGER NOT NULL DEFAULT 0,
    last_score_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS players_country ON players(country, country_rank)`,
  `CREATE TABLE IF NOT EXISTS rank_history (
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    country_rank INTEGER, global_rank INTEGER, pp REAL,
    PRIMARY KEY (user_id, day)
  )`,
  `CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    country TEXT NOT NULL,
    beatmap_id INTEGER,
    pp REAL,
    pp_gain REAL NOT NULL DEFAULT 0,
    weighted_pp REAL NOT NULL DEFAULT 0,
    best_position INTEGER NOT NULL DEFAULT -1,
    ended_at INTEGER NOT NULL,
    json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS scores_country_time ON scores(country, ended_at DESC)`,
  `CREATE INDEX IF NOT EXISTS scores_user_time ON scores(user_id, ended_at DESC)`,
  `CREATE TABLE IF NOT EXISTS best (
    user_id INTEGER NOT NULL,
    beatmap_id INTEGER NOT NULL,
    pp REAL NOT NULL,
    PRIMARY KEY (user_id, beatmap_id)
  )`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
];

export const DATA_TABLES = ['players', 'rank_history', 'scores', 'best'];

export const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
