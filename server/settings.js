// Turns an env-like object (process.env in Node, `env` bindings on Cloudflare) into config.
// Shared by both runtimes, so no Node-only imports here.

const int = (v, d) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export function makeConfig(env = {}, { autoMock = false } = {}) {
  const osuClientId = env.OSU_CLIENT_ID || '';
  const osuClientSecret = env.OSU_CLIENT_SECRET || '';
  const mock = env.MOCK === '1' || (autoMock && !(osuClientId && osuClientSecret));
  return {
    port: int(env.PORT, 3000),
    mock,
    dbPath: env.DB_PATH || 'data/keyfeed.db',
    osuClientId,
    osuClientSecret,
    // Countries to track, e.g. "US,DE,KR". The first is the default on the home page.
    countries: String(env.COUNTRIES || 'US').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean),
    // How many top players per country are polled for new scores.
    rosterSize: int(env.ROSTER_SIZE, 100),
    // osu! asks API consumers to stay around 60 req/min sustained.
    requestsPerMinute: int(env.REQUESTS_PER_MINUTE, 60),
    // How often the country rankings (and therefore the roster) refresh.
    rankingsRefreshMinutes: int(env.RANKINGS_REFRESH_MINUTES, 30),
    // Players with a score in this window are "hot" and polled every cycle; others every Nth cycle.
    hotWindowMinutes: int(env.HOT_WINDOW_MINUTES, 120),
    coldEvery: int(env.COLD_EVERY, 4),
    // Scores older than this are deleted to keep storage bounded.
    retentionDays: int(env.RETENTION_DAYS, 35),
    // Countries outside COUNTRIES are tracked on demand while someone is viewing them.
    onDemandRoster: int(env.ON_DEMAND_ROSTER, 50),
    activeTtlMinutes: int(env.ACTIVE_TTL_MINUTES, 30),
    maxActiveCountries: int(env.MAX_ACTIVE_COUNTRIES, 4),
    leaderboardTtlMinutes: int(env.LEADERBOARD_TTL_MINUTES, 60),
    // 1 in N tracker steps downloads and analyses a chart for the skill analyzer.
    analyzeEvery: int(env.ANALYZE_EVERY, 3),
    // Players tracked outside rosters (signed-in users and who they follow).
    maxPinned: int(env.MAX_PINNED, 300),
    // Signs login cookies. Falls back to a key derived from the osu! client secret.
    sessionSecret: env.SESSION_SECRET || '',
    // Public origin used for OAuth redirects and share links (defaults to the request's origin).
    publicUrl: env.PUBLIC_URL || '',
  };
}
