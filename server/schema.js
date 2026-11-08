// SQLite schema shared by Node (node:sqlite) and Cloudflare Durable Objects (ctx.storage.sql).
// One statement per entry: Durable Objects can't run PRAGMA/BEGIN and want single statements.
//
// Bump SCHEMA_VERSION when tables change. On mismatch the data tables are dropped and recreated
// (the tracker rebuilds everything from the osu! API within minutes), so no hand-written migrations.

export const SCHEMA_VERSION = 2;

export const TABLES = {
  players: `CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    avatar_url TEXT,
    cover_url TEXT,
    country TEXT NOT NULL,
    pp REAL, pp_4k REAL, pp_7k REAL,
    global_rank INTEGER, country_rank INTEGER,
    accuracy REAL, play_count INTEGER, ranked_score INTEGER,
    on_roster INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    initialized INTEGER NOT NULL DEFAULT 0,
    best_loaded INTEGER NOT NULL DEFAULT 0,
    last_polled INTEGER NOT NULL DEFAULT 0,
    last_score_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,
  rank_history: `CREATE TABLE IF NOT EXISTS rank_history (
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    country_rank INTEGER, global_rank INTEGER, pp REAL,
    PRIMARY KEY (user_id, day)
  )`,
  scores: `CREATE TABLE IF NOT EXISTS scores (
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
  best: `CREATE TABLE IF NOT EXISTS best (
    user_id INTEGER NOT NULL,
    beatmap_id INTEGER NOT NULL,
    pp REAL NOT NULL,
    accuracy REAL,
    mods TEXT,
    ended_at INTEGER,
    PRIMARY KEY (user_id, beatmap_id)
  )`,
  beatmaps: `CREATE TABLE IF NOT EXISTS beatmaps (
    id INTEGER PRIMARY KEY,
    set_id INTEGER, title TEXT, artist TEXT, version TEXT, creator TEXT,
    keys INTEGER, sr REAL, bpm REAL, status TEXT, cover TEXT, url TEXT
  )`,
  map_best: `CREATE TABLE IF NOT EXISTS map_best (
    country TEXT NOT NULL,
    beatmap_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    score_id INTEGER, total_score INTEGER NOT NULL, accuracy REAL, pp REAL, mods TEXT, rank TEXT, ended_at INTEGER,
    PRIMARY KEY (country, beatmap_id, user_id)
  )`,
  snipes: `CREATE TABLE IF NOT EXISTS snipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country TEXT NOT NULL,
    beatmap_id INTEGER NOT NULL,
    sniper_id INTEGER NOT NULL,
    victim_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    json TEXT NOT NULL
  )`,
  leaderboards: `CREATE TABLE IF NOT EXISTS leaderboards (
    kind TEXT NOT NULL,
    rank INTEGER NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (kind, rank)
  )`,
  charts: `CREATE TABLE IF NOT EXISTS charts (
    beatmap_id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    keys INTEGER,
    queued_at INTEGER NOT NULL DEFAULT 0,
    analyzed_at INTEGER,
    json TEXT
  )`,
  skill_history: `CREATE TABLE IF NOT EXISTS skill_history (
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    keys INTEGER NOT NULL,
    overall REAL,
    json TEXT NOT NULL,
    PRIMARY KEY (user_id, day, keys)
  )`,
  skill_cache: `CREATE TABLE IF NOT EXISTS skill_cache (
    user_id INTEGER NOT NULL,
    keys INTEGER NOT NULL,
    country TEXT,
    overall REAL,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, keys)
  )`,
  country_activity: `CREATE TABLE IF NOT EXISTS country_activity (
    country TEXT NOT NULL,
    hour INTEGER NOT NULL,
    plays INTEGER NOT NULL,
    players INTEGER NOT NULL,
    top_pp REAL,
    top_json TEXT,
    PRIMARY KEY (country, hour)
  )`,
  follows: `CREATE TABLE IF NOT EXISTS follows (
    user_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, target_id)
  )`,
};

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS players_country ON players(country, country_rank)`,
  `CREATE INDEX IF NOT EXISTS scores_country_time ON scores(country, ended_at DESC)`,
  `CREATE INDEX IF NOT EXISTS scores_user_time ON scores(user_id, ended_at DESC)`,
  `CREATE INDEX IF NOT EXISTS scores_beatmap ON scores(beatmap_id)`,
  `CREATE INDEX IF NOT EXISTS map_best_top ON map_best(country, beatmap_id, total_score DESC)`,
  `CREATE INDEX IF NOT EXISTS snipes_country_time ON snipes(country, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS charts_status ON charts(status, queued_at)`,
];

export const DATA_TABLES = Object.keys(TABLES);
const META = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`;

/**
 * Create or migrate the schema. `run(sql, ...args)` executes, `one(sql, ...args)` returns the first row.
 */
export function applySchema(run, one) {
  run(META);
  const v = Number(one(`SELECT value FROM meta WHERE key = 'schema_version'`)?.value || 0);
  if (v !== SCHEMA_VERSION) {
    for (const t of DATA_TABLES) run(`DROP TABLE IF EXISTS ${t}`);
    run(`DELETE FROM meta WHERE key <> 'mode'`);
  }
  for (const sql of Object.values(TABLES)) run(sql);
  for (const sql of INDEXES) run(sql);
  if (v !== SCHEMA_VERSION) run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`, String(SCHEMA_VERSION));
}

export const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
