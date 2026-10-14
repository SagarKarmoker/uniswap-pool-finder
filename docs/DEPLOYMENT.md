# Deployment

This project runs on three targets from one codebase. All indexing, decoding
and HTTP logic lives in `lib/`; each target supplies only a storage adapter
and a scheduler.

| Target | Entry point | Storage | Ingest driver | Freshness |
| :-- | :-- | :-- | :-- | :-- |
| Self-hosted | `server.js` | `node:sqlite` file | interval timer | **3s** |
| Cloudflare Workers | `workers/src/index.js` | D1 | Cron Trigger | 60s |
| Vercel | `api/*.js` | Postgres / Neon | Vercel Cron | 60s |

---

## Picking a target

**Use self-hosted if you can.** It is the only target with real-time ingest and
it has no platform limits. Railway, Render, Fly or a VPS all work.

**Cloudflare Workers** is the best serverless option: the free tier's cron is
per-minute, HTTP-triggered Workers have **no wall-clock duration limit** (so SSE
stays open indefinitely), and D1 is SQLite-compatible, which keeps the data
model identical to self-hosted.

**Vercel** works but has two hard constraints, described below.

---

## Measured behaviour

Recorded against Base mainnet from this repository, on the default tuning:

| Scenario | Duration | Notes |
| :-- | :-- | :-- |
| Steady-state ingest (~30 blocks, 6 pools) | **0.5–5.2s** | The number that matters for cron sizing |
| Cold-start backfill (1200 blocks, ~160 pools) | ~70–90s | Divided across runs by `maxBlocksPerRun` |
| `/api/pools` read | ~2ms | SQLite; comparable for D1/Postgres at this size |

Steady state is cheap because Base produces a block roughly every 2 seconds, so
a 1-minute cron only ever covers ~30 blocks. The expensive case is the initial
5,000-block backfill, which `maxBlocksPerRun` spreads across several invocations.

Throughput on this workload is bounded by **public RPC rate limits**, not by
application code. When a provider returns `429`, the failover logic retries the
second endpoint, which roughly doubles latency for that request.

### A note on V4 state

Reading V4 pool state calls the Reserves lens, and that is genuinely expensive:
a single 60-call batch measures around 10 seconds. Because the V4 `Initialize`
event already carries `sqrtPriceX96` and `tick`, pools are **inserted
immediately and rendered at once**, and only `liquidity` and reserves are
deferred. `TUNING.v4EnrichLimit` (25) caps how many are enriched inline per
invocation; the rest are repaired by `backfillV4State` on a later pass. A pool
may therefore appear with an empty liquidity figure for up to one cycle before
it fills in.

---

## Self-hosted

```bash
npm install
npm start          # node server.js
```

Serves the API, the SSE stream and the static frontend from one process.

| Variable | Default | Purpose |
| :-- | :-- | :-- |
| `PORT` | `3000` | Listen port |
| `STATIC_ROOT` | `process.cwd()` | Directory served statically |
| `DB_PATH` | `$STATIC_ROOT/pools.db` | SQLite file |
| `POLL_INTERVAL_MS` | `3000` | Ingest cadence; `0` disables the timer |

Mount a persistent volume at `DB_PATH` so cursors survive restarts. Without one
the app re-bootstraps from scratch — correct, but slow.

Behind a reverse proxy, forward `Content-Type` untouched and **do not buffer**
`text/event-stream` (set `proxy_buffering off`).

---

## Cloudflare Workers

### Why this target fits

- Cron granularity is 1 minute, the fastest available on any serverless platform.
- HTTP-triggered Workers have **no wall-clock duration limit**, so the SSE
  stream stays open as long as the client holds it.
- D1 is SQLite-compatible and shares the schema used by the self-hosted target.

### Setup

```bash
npm install -g wrangler

wrangler d1 create pool-explorer      # paste the id into wrangler.toml
npx @tailwindcss/cli -i src/input.css -o tailwind.css
wrangler deploy
```

Then uncomment the `[[d1_databases]]` block in `wrangler.toml` and fill in the
returned `database_id`.

The schema is created automatically on first use, so there is no migration step.

### Verify

```bash
curl https://<worker>.workers.dev/api/health
```

Watch `cursors` in the response. If it stops advancing, the cron is not firing.

### Test the cron without waiting

```bash
wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

### Plan limits

| Limit | Free | Paid ($5/mo) |
| :-- | :-- | :-- |
| CPU per request | 10ms | 30s default, raisable to 5min |
| D1 queries per invocation | 50 | 1,000 |
| Subrequests per invocation | 50 | 10,000 |
| Cron triggers per account | 5 | 250 |
| D1 database size | 500 MB | 10 GB |

The **10ms free-tier CPU limit is below what the indexer needs**, so ingest
requires Workers Paid. The read API is fine on Free.

The query budget is why every store lookup is batched — a per-row `SELECT` for
deduplication would exhaust 50 queries on the first busy range. `filterExistingPoolIds`
takes a whole list for exactly this reason.

---

## Vercel

### Two hard constraints

**1. Hobby cannot run this.** Hobby cron jobs are limited to once per day, and
a sub-daily `schedule` in `vercel.json` **fails the deployment outright**:

> Hobby accounts are limited to cron jobs that run once per day. This cron
> expression would run more than once per day.

Use **Pro ($20/mo)** for the `* * * * *` schedule below.

**2. SSE is duration-capped.** With Fluid compute (default on new projects) a
function runs 300s on Hobby and up to 800s on Pro. The stream closes itself at
`TUNING.streamMaxDurationMs` (240s) and the browser reconnects automatically via
`EventSource`, so this is invisible in practice — but each reconnect pays a
cold start.

### Setup

```bash
npm i -g vercel
vercel link

# Provision Postgres in the dashboard (Storage), or point at an existing
# Neon/Postgres URL. The adapter reads POSTGRES_URL or POSTGRES_PRISMA_URL.
vercel env add POSTGRES_URL production
vercel env add CRON_SECRET production      # optional; enables auth on /api/cron
vercel --prod
```

The build command compiles Tailwind; no bundling step is required because the
frontend is served as static files.

### Database client

`api/_store.js` tries `@vercel/postgres` first and falls back to
`@neondatabase/serverless`, since Vercel's Postgres offering has been
transitioning to Neon. Whichever is installed wins.

The adapter uses transactions when the client exposes `sql.begin()` and falls
back to sequential writes otherwise. Correctness does not depend on it: every
write is an idempotent upsert on a primary key, and the scanner refuses to
advance its cursor if an insert comes up short.

### Verify

```bash
curl https://<deployment>.vercel.app/api/health
curl -H "Authorization: Bearer $CRON_SECRET" https://<deployment>.vercel.app/api/cron
```

---

## How the port works

### Storage as a port

`lib/core/store.js` defines the `Store` interface. Three implementations exist:

- `lib/adapters/sqlite.js` — `node:sqlite`, reference implementation
- `lib/adapters/d1.js` — Cloudflare D1
- `lib/adapters/postgres.js` — Vercel Postgres / Neon

`createStore({ d1, sql, db })` picks whichever backend is present. Postgres
differs from SQLite only in positional `$n` binds, which is handled by a
placeholder rewriter, so the data model is identical everywhere.

### Ingest is a resumable step, not a loop

The original design ran an infinite `setTimeout` loop. `runIngest()` is instead
a **single resumable pass**:

1. Read all cursors from the store.
2. For each chain, process at most `maxBlocksPerRun` blocks past the cursor.
3. Advance the cursor **only past what actually completed**.
4. Prune, repair V4 state, write cursors.

An invocation that dies mid-run simply redoes that window next time, because
`filterExistingPoolIds` deduplicates what already landed. On self-hosted this
is driven by a timer; on Cloudflare and Vercel by a cron.

### Why SSE polls instead of broadcasting

The self-hosted server pushed snapshots to an in-memory `Set` of open responses.
That cannot work on a serverless runtime, where two connections may never share
a process. Each stream now re-reads the store every `streamPollMs` and emits
only when the snapshot fingerprint changes — a few indexed reads per connection,
identical behaviour on all three targets, and silent when nothing is happening.

### Reliability guard

`insertPools` returns rows **actually written**, and `processRange` throws if
that is fewer than attempted. The cursor is then left untouched and the range is
re-scanned. Advancing the cursor on a partial write would permanently drop
pools — the one failure this indexer cannot otherwise recover from.

---

## Testing

```bash
npm test           # 44 unit tests, no network
npm run smoke      # live ingest against Base, throwaway database
```

The unit tests cover ABI decoding, the store contract, snapshot assembly and
the HTTP layer. Two of them are explicit regression tests for bugs found during
this port: all-zero ABI words, and `int24` sign-extension (see
`test/decode.test.js`).