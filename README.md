# keyfeed

A self-hosted osu!mania country tracker with country rankings, a live score feed, the week's top plays (with pp gain) and player pages. It follows the architecture described in [TEARDOWN.md](TEARDOWN.md), rebuilt from scratch on the **official osu! API v2**.

It runs in two places, with no npm dependencies in either:

- **Cloudflare Workers:** a Worker plus one SQLite-backed Durable Object, with the front end as static assets. See [Deploy on Cloudflare](#deploy-on-cloudflare).
- **Node ≥ 22.5:** `node:sqlite`, `node:http` and `fetch`, for running locally or on a VPS.

## Run it

```bash
npm run mock          # demo with generated data, no osu! account needed → http://localhost:3000
npm test              # 14 tests: pp weighting, rate limiter, tracker, HTTP API, Durable Object harness
```

To track real players:

1. Create an OAuth application at **osu.ppy.sh → Settings → OAuth → New OAuth Application**. Any callback URL works, because client credentials don't use it.
2. `cp .env.example .env` and fill in `OSU_CLIENT_ID` / `OSU_CLIENT_SECRET`.
3. `npm start`

## How it works

```
osu! API v2 ──(token bucket, 60 req/min)──► Tracker ──► SQLite (players, rank_history, scores, best)
                                              │
                                              └─ events ─► SSE hub /api/live ─► browsers
                                                                                (1 connection per browser via Web Locks + BroadcastChannel)
```

- **Roster:** every `RANKINGS_REFRESH_MINUTES`, the tracker pulls the top `ROSTER_SIZE` players per country from `/rankings/mania/performance` and stores a daily snapshot. The ▲/▼ rank changes come from that snapshot.
- **Polling:** it walks the roster calling `/users/{id}/scores/recent?mode=mania` and dedupes by score id. A player's first poll is a silent backfill. Players with a score in the last `HOT_WINDOW_MINUTES` are polled every cycle, and everyone else every `COLD_EVERY` cycles.
- **pp gain:** for a new pp score, it loads the player's top 100 once (`/scores/best`) and recomputes `Σ pp·0.95^i` before and after. If the score lands in the top 100 it becomes a **top play** (`server/pp.js`).
- **Budget:** at 60 req/min with 100 players, a full cold cycle takes about 2 minutes, and hot players are seen about every minute. For more countries, raise `COLD_EVERY` or lower `ROSTER_SIZE` rather than the request rate.

## API

| Route | Notes |
|---|---|
| `GET /api/config` | tracked countries, demo flag |
| `GET /api/rankings?country&page&pageSize` | roster with `rank_change`, `pp_change`, `pp_4k` / `pp_7k` |
| `GET /api/tracker?country&limit&offset` | newest scores first |
| `GET /api/top-plays?country&window=24h\|7d\|30d` | new top-100 plays by pp |
| `GET /api/players/:idOrName` | profile, top 20 best scores and tracked recent scores (cached 5 min) |
| `GET /api/live?country` | SSE events: `hello`, `tracker_score`, `top_play`, `rankings` |
| `GET /api/status` | counters |

## Deploy on Cloudflare

```
browser ──► Worker ──/api/*──► TrackerDO "main"  (SQLite + alarm-driven poller + SSE hub)
              └── everything else ──► static assets (web/), SPA fallback
```

Code lives in `worker/index.js` and `wrangler.jsonc`. The tracker, API and SQL are the same modules the Node server uses. `server/sqlite-do.js` adapts `ctx.storage.sql`.

1. **Connect the repo:** in the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository** and pick this repo. Leave the build command empty. The deploy command is `npx wrangler deploy`. After that, every push to `main` deploys.
   You can also deploy from your own machine with `npx wrangler login && npx wrangler deploy`.
2. **Add osu! credentials:** go to **Worker → Settings → Variables and Secrets** and add `OSU_CLIENT_ID` and `OSU_CLIENT_SECRET` as **Secrets**. Without them the site runs on generated demo data. When you add them, the demo data is wiped and real tracking starts.
3. **Pick countries:** edit `vars` in `wrangler.jsonc` (`COUNTRIES`, `ROSTER_SIZE`, …) and push.

**Free plan budget.** One always-on Durable Object at 128 MB uses about 11k of the 13k GB-s you get per day. Writes are kept low: one country with a 100-player roster comes to roughly 20k–30k of the 100k rows written per day. Each alarm run makes at most 40 osu! requests (the limit is 50 subrequests per invocation). For several large countries, use Workers Paid ($5/mo).

## Deploy on a VPS (Node)

The Node server is a single long-running process. Put it behind Caddy or nginx (turn off proxy buffering for `/api/live`) and keep `data/` on a persistent disk.

## Not yet built (ideas from the teardown)

- **Snipes:** country beatmap leaderboards need a *user* token with osu!supporter. Add the authorization-code flow and watch the leaderboards of maps your roster plays.
- **osu! login** (`/oauth/authorize`) for personal settings.
- **Lazy per-country activation:** only poll countries someone is viewing.
- Avatar accent colours, an OG image endpoint, replays.

## Etiquette

Follow the [osu! API terms](https://osu.ppy.sh/docs/#terms-of-use): identify your app, respect rate limits, and don't present the data as official. This project uses no osu!/ppy branding, fonts or artwork. Avatars and covers are loaded straight from the osu! CDNs.
