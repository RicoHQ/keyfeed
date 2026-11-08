# Mania Tracker teardown

What I could see of how **mania-tracker.com** works. I looked at it on 8 Nov 2026 from the public site, using only unauthenticated GET requests in a browser.

Each finding is tagged with how I know it:

- **[observed]**: I saw it in a response, a header or the live DOM.
- **[bundle]**: I read it in the shipped JavaScript.
- **[inferred]**: my best explanation, not verified.

## 1. Stack

| Layer | What it is | Evidence |
|---|---|---|
| Front-end framework | **React** SSR app on **TanStack Start**, using TanStack Router | [observed] `window.__TSR_ROUTER__`, `window.__TSS_START_OPTIONS__`, `/_serverFn/<sha256>?payload=…` server-function calls |
| Build | **Vite** (hashed `/assets/*-<hash>.js` chunks, `modulepreload`), about 169 lazy chunks, about 6.7 MB of JS in total | [observed] |
| Styling | Tailwind-style utility classes (`min-h-screen flex flex-col font-sans antialiased`). The theme is a single CSS variable, `--theme-hue: 333`, stored in localStorage under `mania-hub-theme-v1` | [observed] |
| Fonts | Torus (the osu! UI font) and Venera, self-hosted | [observed] `/fonts/Torus-*.woff2` |
| Heavy client libs | d3 (charts), PixiJS and three.js (replay viewer, card effects), Lingui (i18n), zustand | [bundle] string hits |
| Edge | **Cloudflare** (`server: cloudflare`, `cf-ray`, NEL). HTML is sent `s-maxage=60, stale-while-revalidate=300` and zstd-compressed | [observed] |
| Origin | **Caddy** reverse proxy (`via: 1.1 Caddy`). That points to a self-hosted VPS rather than serverless | [observed] / [inferred] |
| API host | Separate origin, `https://api.mania-tracker.com`. Requests use `credentials: "omit"`, so public data is cookie-less and cacheable | [observed] / [bundle] |
| PWA | `/sw.js` precaches fonts, grade badges and the nav background (`static-v6`) | [observed] |
| Codename | Internal name **"mania-hub"** (`__maniaHubRootSlowContext`, `mania-hub-sse:` lock names, `mania-hub.local` dev host) | [observed] |

## 2. Architecture

```
            ┌──────────────────────── Cloudflare ────────────────────────┐
 browser ──►│ mania-tracker.com (SSR HTML, 60s edge cache)               │
            │ api.mania-tracker.com (JSON + SSE)                         │
            └───────────────┬──────────────────────────┬─────────────────┘
                            ▼                          ▼
                Caddy ► TanStack Start SSR      Caddy ► API / worker process
                (React, server fns)             ├─ "snapshots" (precomputed JSON)
                                                ├─ SSE hub  /api/live, /api/updates/stream
                                                └─ pollers ──► osu! API v2
                                                               (rankings, recent scores,
                                                                best scores, leaderboards)
```

**The core idea [inferred, strongly supported]:** the osu! API has no firehose, so the site keeps a **roster** of players per country. It polls each roster player's recent scores, dedupes them, and pushes new ones to browsers over SSE.

- `__maniaHubRootSlowContext.countryFeatures` lists every country with a `featureTier` (`live` or `snipes`) and a `rosterSize`, e.g. US 1863, KR 1137, CN 2251. Most countries sit at about 100. [observed]
- Opening a country page fires `GET /api/countries/activate?country=CY`. My reading is lazy activation: polling for a country ramps up when someone is actually viewing it. [observed request] / [inferred purpose]
- Most read endpoints live under `/api/snapshots/*` and return `fetchedAt` or `scannedAt` timestamps. So they are precomputed blobs served from memory or cache, not live queries. [observed]

## 3. Real-time layer

- `GET /api/live?country=XX` is an **SSE** stream. Its events are `hello`, `tracker_score`, `companella_score`, `score_gain`, `top_play` and `snipe`. [bundle + observed: `hello {"country":"US","status":"connected"}` arrived, then a `tracker_score` carrying a full score object within seconds]
- **One connection per browser:** a `navigator.locks` exclusive lock (`mania-hub-sse:<url>`) elects a leader tab. The leader holds the EventSource and fans events out to the other tabs over a `BroadcastChannel`. This is a neat trick worth copying. [bundle]
- `/api/updates/stream` and `/api/replay/presence` are further SSE streams, used for presence and site notices. They take signed identity params (`uid`, `name`, `exp`, `sig`), which is HMAC-style stateless auth. [bundle]

## 4. Public API surface (selected)

All of these are on `https://api.mania-tracker.com`.

| Endpoint | Shape (observed) |
|---|---|
| `/api/snapshots/rankings?country&page&pageSize≤50&sort=rank&dir` | `{ranking:[{rank,user:{id,username,avatar_url,cover_url,country_code,avatar_accent},pp,pp_4k,pp_7k,global_rank,country_rank,hit_accuracy,play_count,ranked_score,grade_counts,global_change,country_change}],total,page,pageSize,fetchedAt}` |
| `/api/snapshots/global-rankings` | same shape, global |
| `/api/snapshots/tracker?country&limit&offset` | `{country,scores:[osu! v2 solo_score + trimmed beatmap/beatmapset/user],gains:{},total,offset,fetchedAt}` |
| `/api/snapshots/top-plays?country&window=7d` | `{popoffs:[{pp,weightedPP,ppGain,time,score,user}],page,pageSize,total,window,scannedAt}` (about 1.6 MB uncompressed for US/7d) |
| `/api/snapshots/snipes?country` | `{events:[{sniper,victim,beatmap,beatmapset,totalScore,pp,boardRank,victimTotalScore,victimPp,detectedAt,…}]}` |
| `/api/profiles/:userId/{recent,skills,keymode-pp,about,skill-history,maniacard-history}` | needs a numeric id (a username returns `invalid_user_id`) |
| `/api/avatar-accents` | dominant colour per avatar, precomputed server-side (`avatar_accent: "#dba081"`) |
| `/api/background?beatmapsetId`, `/api/osz`, `/api/audio`, `/api/preview-audio` | asset proxies. `osz` falls back across beatmap mirrors: nekoha, sayobot, catboy.best, nerinyan, hinamizawa |
| `/api/auth/osu`, `/api/auth/discord` | OAuth login |

The bundle references about 120 `/api/*` paths. Beyond the tracker, they cover card packs and gacha, skins, replays, teams, map recommendations, dan estimates, a "Companella" desktop-client integration, and admin tools.

**Score objects are raw osu! API v2 lazer-format scores**: `type: "solo_score"`, `statistics.perfect/great/good/ok/meh/miss`, `mods:[{acronym}]`, `legacy_total_score`, `ruleset_id: 3`. That means the backend calls the osu! API with `x-api-version ≥ 20220705` and passes scores through mostly untouched, adding only `avatar_accent`. [observed]

## 5. How each feature is probably computed

| Feature | Likely method |
|---|---|
| Country rankings | `GET /api/v2/rankings/mania/performance?country=XX`, paged. It is snapshotted on a schedule, and `country_change` / `global_change` come from diffing against the previous snapshot. `pp_4k` / `pp_7k` come from the mania key-variant stats. [inferred] |
| Live score feed | Round-robin `GET /users/{id}/scores/recent?mode=mania` over the roster, dedupe by score id, then emit `tracker_score`. [inferred, consistent with observed latency of about 1 min] |
| Top plays / pp gain | For a new pp score, recompute the user's weighted top-100 (`Σ pp·0.95^i`). `weightedPP` is the score's weighted contribution, and `ppGain` is the change in total. [inferred from field names: `weightedPP == pp` exactly for #1 plays] |
| Snipes | Watch country beatmap leaderboards. When a roster player takes #1 from another, record sniper, victim and `boardRank`. Country leaderboards on the official API need a supporter user token, which explains the separate `snipes` tier. [inferred] |

## 6. Things to copy, and things not to

**Copy (as patterns):** a precomputed-snapshot API behind an edge cache, one SSE connection per browser through Web Locks and BroadcastChannel, lazy per-country activation, passing osu! score objects through untouched, and server-side avatar accent colours.

**Don't copy:** their code, Torus or Venera fonts (osu!/ppy assets), artwork, or the "Mania Tracker" name. Also don't scrape `api.mania-tracker.com` as a data source. Use the official osu! API v2 with your own OAuth client, and keep within its usage guidelines (about 60 requests per minute sustained).
