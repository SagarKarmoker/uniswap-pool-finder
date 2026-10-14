# Uniswap Pool Explorer

A real-time dashboard for discovering **newly listed Uniswap V3 and V4 pools** across the **Base** and **Robinhood Chain** mainnets.

The indexer tails on-chain pool-creation events, enriches each pool with token metadata and live state, and streams snapshots to the browser over Server-Sent Events — no API keys, no third-party indexer, no build step required at runtime.

Runs on three targets from one codebase: self-hosted on SQLite (3-second ingest), Cloudflare Workers on D1, or Vercel on Postgres (60-second ingest). See [Deployment](#deployment).

[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933)
![Runtime](https://img.shields.io/badge/runtime-zero--dependencies-22d3ee)
![Targets](https://img.shields.io/badge/targets-node%20%C2%B7%20cloudflare%20%C2%B7%20vercel-22d3ee)

---

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [How the Indexer Works](#how-the-indexer-works)
- [API Reference](#api-reference)
- [Configuration](#configuration)
- [Data Model](#data-model)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [Testing](#testing)
- [Deployment](#deployment)
- [Design Notes & Limitations](#design-notes--limitations)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Dual-protocol coverage** — tracks Uniswap V3 (`PoolCreated`) and V4 (`Initialize`) pool-creation events side by side.
- **Multi-chain** — scans Base and Robinhood Chain concurrently, with a chain selector in the UI.
- **Rolling live window** — only the last **30 minutes** of newly created pools are retained, so the dashboard stays focused on genuinely fresh launches.
- **Realtime stream** — Server-Sent Events push a snapshot whenever the data changes, with no client-side polling.
- **On-chain enrichment** — token `name` / `symbol` / `decimals` are decoded from raw `eth_call` return data; no ABI libraries required.
- **Pool state** — V3 pools read `slot0()` + `liquidity()` + ERC-20 balances directly; V4 pools read state through a Reserves lens contract.
- **Sparse log scanning** — 3,000-block chunked `eth_getLogs` requests with multi-endpoint failover and polite inter-request delays.
- **Resumable** — scan cursors persist in the database, so restarts never re-scan history and a failed invocation simply redoes its window.
- **Three deploy targets** — one codebase runs self-hosted on SQLite, on Cloudflare Workers with D1, or on Vercel with Postgres. Only the storage adapter and scheduler differ.
- **Zero required runtime dependencies** — the server uses only Node built-ins (`node:http`, `node:sqlite`, global `fetch`).

---

## Quick Start

### Requirements

| Requirement | Version | Notes |
| :-- | :-- | :-- |
| Node.js | **>= 22.5** | `node:sqlite` (`DatabaseSync`) is the storage layer |
| npm / pnpm | any | `package-lock.json` and `pnpm-lock.yaml` are both committed |

> On Node 22 the SQLite module is still flagged experimental and emits a `ExperimentalWarning` on startup. This is expected and harmless. Node 24+ runs it without the warning.

### Install & run

```bash
# 1. install dev dependencies (Vite + Tailwind CLI)
npm install

# 2. start the API server and the Vite dev server together
npm run dev
```

Then open:

| Service | URL | Notes |
| :-- | :-- | :-- |
| Frontend (Vite) | http://localhost:5173 | proxies `/api/*` to the backend |
| API + SSE + static | http://localhost:3000 | can also be opened directly |

The first launch backfills roughly the **last 5,000 blocks** per chain, then switches to incremental polling. On self-hosted that is every 3 seconds; on Cloudflare and Vercel, once per minute. The backfill is spread across several invocations by `maxBlocksPerRun`, so pools start appearing within the first few seconds and the window fills over the next few minutes.

### All scripts

| Script | Command | Purpose |
| :-- | :-- | :-- |
| `npm run dev` | `node scripts/dev.js` | Runs API (:3000) and Vite (:5173) concurrently with HMR |
| `npm run api` | `node server.js` | API server, SSE stream, and static file server only |
| `npm start` | `node server.js` | Production entrypoint (same as `api`) |
| `npm test` | `node --test "test/*.test.js"` | Unit tests, no network required |
| `npm run smoke` | `node scripts/smoke.js` | Live ingest against Base, throwaway database |
| `npm run build` | `vite build` | Bundles the client into `dist/` |
| `npm run preview` | `vite preview --port 5173` | Serves the production bundle locally |
| `npm run tailwind` | `tailwindcss -i src/input.css -o tailwind.css` | Rebuilds the stylesheet |
| `npm run deploy:cloudflare` | `npm run tailwind && wrangler deploy` | Deploy to Cloudflare Workers |
| `npm run deploy:vercel` | `npm run tailwind && vercel --prod` | Deploy to Vercel |

### Regenerating styles

`tailwind.css` is a committed build artifact rather than a runtime step, so the app works immediately after `npm install`. Rebuild it after editing markup or adding classes:

```bash
npm run tailwind
```

---

## Architecture

```
  Base RPC  ─┐                      ┌──────────────────────────────┐
             ├─►  runIngest()   ──► │  lib/core/scanner.js         │
 Robinhood ──┘   getLogs chunks     │  ├─ chain registry           │
                  batched eth_call  │  ├─ log decoders (raw hex)   │
                                     │  └─ resumable single pass    │
                                     └──────────────┬───────────────┘
                                                    │  Store interface
                          ┌─────────────────────────┼─────────────────────────┐
                          ▼                         ▼                         ▼
                   node:sqlite (self)        D1 (Cloudflare)        Postgres (Vercel)
                          │                         │                         │
                          └──────────► lib/api.js ◄─┴─────────────────────────┘
                                       │  /api/pools  /api/stream  /api/health
  Browser ◄──── SSE  /api/stream  ◄─────┘
     │
     └─►  filter (chain · protocol) → paginate (25/page) → render cards
```

`runIngest()` is a resumable pass rather than an infinite loop, so the same code runs on a timer (self-hosted) or on a cron (Cloudflare, Vercel). Ingest and read are fully decoupled: the indexer writes to storage and nothing else.

The system is a single-process design: **indexer + storage + API + static server** all live in `server.js`. The frontend is a dependency-free ES module that consumes the API and mutates the DOM directly.

### Indexing pipeline

`runIngest()` is a single **resumable pass**, not an infinite loop. On self-hosted it is driven by a timer; on Cloudflare and Vercel by a cron.

1. **Bootstrap** — for each chain with no cursor, set `last_scanned = latest_block − 5000`.
2. **Poll** — fetch the head block; if it advanced, process `(last_scanned, head]`, capped at `maxBlocksPerRun` blocks so a cold-start backfill drains over several invocations.
3. **Discover** — two chunked `eth_getLogs` sweeps per chain range, filtered by topic:
   - V3: `PoolCreated` on the chain's V3 factory
   - V4: `Initialize` on the chain's V4 `PoolManager`
4. **Deduplicate** — one batched `SELECT id FROM pools WHERE id IN (...)`, chunked to respect each database's bind-parameter limit.
5. **Resolve tokens** — batched `eth_call`s for `name()` / `symbol()` / `decimals()`, cached in the `tokens` table.
6. **Read state** — V3 via `slot0()` / `liquidity()` / `balanceOf()`; V4 via a Reserves lens call. V4 enrichment is capped at 25 pools per invocation; the rest are inserted with the price and tick the `Initialize` event already provided, and repaired on a later pass.
7. **Persist** — batched inserts that report how many rows were *actually* written.
8. **Prune** — delete rows older than 30 minutes.
9. **Repair** — fill in V4 liquidity for any pool whose state is still null.

The cursor advances **only past what completed**. An invocation that dies mid-run redoes that window next time, deduplicated by step 4, so the scan converges rather than duplicating. A short insert throws rather than advancing, because advancing past a partial write would drop pools permanently.

### Chain registry

Per-chain endpoints and contract addresses live in the `CHAINS` map in `lib/core/config.js`.

| Chain | V3 Factory | V4 PoolManager | RPC endpoints |
| :-- | :-- | :-- | :-- |
| Base | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | `0x498581fF718922c3f8e6A244956aF099B2652b2b` | `base-rpc.publicnode.com`, `mainnet.base.org` |
| Robinhood | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | `rpc.mainnet.chain.robinhood.com`, `robinhood-rpc.publicnode.com` |

Every RPC helper iterates the endpoint list and falls through to the next URL on failure, so a single rate-limited or flaky provider degrades gracefully.

---

## API Reference

Base URL: `http://localhost:3000` (in dev, Vite proxies `/api` here).

### `GET /api/pools`

Returns a JSON array of every pool in the live window, newest block first. Enriched with token metadata.

Query parameters:

| Param | Values | Default | Effect |
| :-- | :-- | :-- | :-- |
| `chain` | `all`, `base`, `robinhood` | `all` | Filters by chain |

```jsonc
[
  {
    "protocol": "V4",              // "V3" | "V4"
    "chain": "base",              // "base" | "robinhood"
    "pool": "0x…",                // pool address (V3) or pool id (V4)
    "token0": "0x…",
    "token1": "0x0000000000000000000000000000000000000000", // native sentinel
    "fee": 3000,                  // hundredths of a bp; >= 0x800000 = dynamic fee
    "tickSpacing": 60,
    "hooks": "0x000…0",           // V4 only, null for V3
    "sqrtPriceX96": "123…",       // string (uint256)
    "tick": -1234,
    "liquidity": "987…",          // string (uint128)
    "bal0": "1000…",              // string (uint256), null until state resolves
    "bal1": "2000…",
    "blockNumber": 12345678,
    "txHash": "0x…",
    "token0Meta": { "name": "Wrapped Ether", "symbol": "WETH", "decimals": 18 },
    "token1Meta": { "name": "Native Ether",  "symbol": "ETH",  "decimals": 18 }
  }
]
```

> All numeric fields are serialized as **strings** to preserve precision across the 64-bit boundary in JavaScript.

### `GET /api/stream` (Server-Sent Events)

Opens a persistent `text/event-stream`. The first frame is always a full `snapshot`, then the stream re-reads storage every 3 seconds and emits only when the snapshot has changed:

| `type` | Payload | When |
| :-- | :-- | :-- |
| `snapshot` | `{ pools: Pool[] }` | On connect, and whenever the content changes |
| `error` | `{ message }` | A poll failed; the stream keeps running |
| `reconnect` | `{ time }` | Sent just before the stream closes itself |

The stream closes itself after `streamMaxDurationMs` (240s) so no connection is held indefinitely by the runtime. The browser's `EventSource` reconnects automatically and receives a fresh snapshot, so this is invisible to users.

> This polls rather than broadcasting. A serverless runtime gives no two connections a shared process, so there is no in-memory set of subscribers to push to. On Cloudflare the stream has no wall-clock limit; on Vercel it is bounded by `maxDuration`.

```bash
curl -N http://localhost:3000/api/stream
```

### `GET /api/health`

Reports liveness, the active storage adapter, pool count, head block, and the per-chain scan cursors. If `cursors` stops advancing, ingest is not running — the fastest way to diagnose a cron that never fires.

```json
{
  "ok": true,
  "adapter": "sqlite",
  "pools": 162,
  "head": 52609456,
  "cursors": { "last_scanned_to:base": "52609456" }
}
```

### `GET /*`

Static assets. `index.html` is served for `/`, paths are resolved against `STATIC_ROOT`, and traversal outside the root is rejected with `403`.

---

## Configuration

All configuration is environment-based; there is no config file to edit.

| Variable | Default | Used by | Purpose |
| :-- | :-- | :-- | :-- |
| `PORT` | `3000` | server, Vite | API port; Vite uses the same value when set |
| `API_PORT` | `3000` | Vite | Backend target for the dev proxy when `PORT` is not set |
| `DB_PATH` | `$STATIC_ROOT/pools.db` | server | SQLite database location |
| `STATIC_ROOT` | `process.cwd()` | server | Root directory for static file serving |
| `POLL_INTERVAL_MS` | `3000` | server | Ingest cadence; `0` disables the timer |
| `RAILWAY_PUBLIC_DOMAIN` | — | Vite | Enables allowed-host checks and WSS HMR |
| `POSTGRES_URL` | — | Vercel | Postgres connection string (also accepts `POSTGRES_PRISMA_URL`) |
| `CRON_SECRET` | — | Vercel | When set, `/api/cron` requires `Authorization: Bearer` |
| `DB` (binding) | — | Cloudflare | D1 binding named `DB` |

```bash
# example: run the API on 8080 with the database elsewhere
STATIC_ROOT=/srv/app DB_PATH=/data/pools.db PORT=8080 node server.js
```

### Tuning constants

All behaviour is configured in one place: the `TUNING` object in `lib/core/config.js`.

| Constant | Value | Effect |
| :-- | :-- | :-- |
| `bootstrapDepth` | `5000` blocks | Initial scan range on a fresh database |
| `maxBlocksPerRun` | `1500` blocks | Work ceiling per invocation, so backfill drains over several runs |
| `logChunkSize` | `3000` blocks | `eth_getLogs` window, with 100 ms between chunks |
| `v4EnrichLimit` | `25` pools | V4 pools enriched inline; the rest are repaired on a later pass |
| `retentionMs` | `30 min` | How long pools stay in the live window |
| `streamPollMs` | `3000 ms` | SSE re-read cadence |
| `streamMaxDurationMs` | `240 s` | Self-imposed SSE lifetime before client reconnect |
| `maxPoolsPerResponse` | `1000` | Cap on a single `/api/pools` payload |
| `tokenBatchSize` | `60` calls | Batch size + 100 ms delay |
| `v3BatchSize` | `40` calls | Batch size + 50 ms delay |
| `v4BatchSize` | `20` calls | Batch size + 200 ms delay |

---

## Data Model

Three tables, created idempotently on first use. D1 and Postgres use the same logical schema as SQLite; Postgres widens `blockNumber` to `BIGINT`.

```sql
meta    (key TEXT PRIMARY KEY, value TEXT)     -- scan cursors, head block
tokens  (address TEXT PRIMARY KEY,
         name TEXT, symbol TEXT, decimals INTEGER)
pools   (id TEXT PRIMARY KEY,                  -- V3 address / V4 pool id
         chain TEXT, protocol TEXT,            -- 'V3' | 'V4'
         token0 TEXT, token1 TEXT,
         fee INTEGER, tickSpacing INTEGER, hooks TEXT,
         sqrtPriceX96 TEXT, tick INTEGER,
         liquidity TEXT, reserves0 TEXT, reserves1 TEXT,
         blockNumber INTEGER, txHash TEXT, createdAt TEXT)
```

`createdAt` is an ISO-8601 UTC timestamp used purely for the retention sweep. On SQLite, a `chain` column is added via a guarded `ALTER TABLE` so databases created before multi-chain support migrate automatically.

Token metadata lives in the `tokens` table, which is the source of truth on every target — a process-level cache cannot be relied on when an invocation may be a cold start. The native-ETH sentinel `0x000…0` is treated as a built-in `{ name: "Native Ether", symbol: "ETH", decimals: 18 }`.

---

## Project Structure

```
.
├── index.html            # Single page shell: header, filters, stats, grid
├── server.js             # Self-hosted entry: wire store + timer + static server
├── lib/                  # Portable core — no node:*, no platform SDKs
│   ├── core/
│   │   ├── config.js     # Chain registry, contract addresses, TUNING
│   │   ├── abi.js        # Raw ABI decoders (no ABI library)
│   │   ├── rpc.js        # JSON-RPC with endpoint failover + batching
│   │   ├── scanner.js    # runIngest() — the indexing pipeline
│   │   ├── snapshot.js   # Snapshot assembly, filters, fingerprinting
│   │   └── store.js      # The Store port (documented contract)
│   ├── adapters/
│   │   ├── sqlite.js     # node:sqlite — self-hosted reference impl
│   │   ├── d1.js         # Cloudflare D1
│   │   └── postgres.js   # Vercel Postgres / Neon
│   ├── api.js            # /api/pools, /api/stream, /api/health
│   └── index.js          # Public surface + createStore factory
├── workers/src/index.js  # Cloudflare Worker: fetch + scheduled handlers
├── api/                  # Vercel Functions: pools, stream, health, cron
├── scripts/
│   ├── dev.js            # Runs API and Vite as children, shared shutdown
│   └── smoke.js          # Live ingest check against a temp database
├── test/                 # node:test suites (abi, decode, store, api)
├── docs/DEPLOYMENT.md    # Per-platform setup, limits, measured perf
├── src/                  # Frontend (vanilla ES modules)
│   ├── main.js           # ES entrypoint with HMR accept
│   ├── app.js            # Fetch + SSE client, filters, pagination, render
│   └── input.css         # Tailwind v4 source
├── wrangler.toml         # Worker, D1 binding, cron trigger
├── vercel.json           # Vercel build, function durations, cron
├── tailwind.css          # Pre-built stylesheet, committed for zero-setup runs
└── pools.db              # SQLite database (gitignored)
```

### Event decoding

Both protocols are decoded from raw log payloads — no ABI or ethers.js on the server.

| Protocol | Event | Topic hash |
| :-- | :-- | :-- |
| V3 | `PoolCreated` | `0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118` |
| V4 | `Initialize` | `0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438` |

V3 state selectors: `slot0()` `0x3850c7bd`, `liquidity()` `0x1a686502`, `balanceOf(address)` `0x70a08231`.
V4 state is read through the Reserves lens `0x0000001b173C3bbF3984D417d8614E3eed34865B` via `f95138f2`, whose 9-word return value yields reserves, `sqrtPriceX96`, `tick`, and `liquidity`.

Signed integers are decoded by sign-extension, not by masking. Solidity sign-extends an `intN` across the full 32-byte word, so a negative `int24 tick` arrives with its top 255 bits set. Reading the word as a signed 256-bit integer yields the exact value in both directions; treating it as a packed 24-bit field is correct only for non-negative inputs.

---

## Tech Stack

**Backend** — Node.js built-ins only: `node:http` for the server, `node:sqlite` for storage, global `fetch` for JSON-RPC, and raw `BigInt` arithmetic for ABI decoding. No framework, no ORM, no required runtime dependencies. Cloudflare and Vercel deployments add only their own storage driver.

**Frontend** — Vanilla ES modules with direct DOM construction. Tailwind CSS v4 (compiled to a static stylesheet). Prices are computed client-side from `sqrtPriceX96` with `BigInt` math.

**Build tooling** — Vite 6 for the dev server and HMR; `@tailwindcss/cli` for style generation.

> The page loads an `ethers` UMD bundle from a CDN for compatibility, but the current client implementation relies only on native `BigInt` and does not depend on it.

---

## Testing

```bash
npm test           # 44 unit tests, no network required
npm run smoke      # live ingest against Base, writes to a throwaway database
```

The unit tests cover ABI decoding, the store contract, snapshot assembly, and the HTTP layer. `scripts/smoke.js` is the end-to-end check: it runs a real ingest pass against Base mainnet against a temporary database and reports how many pools were discovered and enriched.

---

## Deployment

The app runs on three targets from one codebase. All indexing, decoding and HTTP logic lives in `lib/`; each target supplies only a storage adapter and a scheduler.

| Target | Entry point | Storage | Ingest driver | Freshness |
| :-- | :-- | :-- | :-- | :-- |
| Self-hosted | `server.js` | `node:sqlite` file | interval timer | **3s** |
| Cloudflare Workers | `workers/src/index.js` | D1 | Cron Trigger | 60s |
| Vercel | `api/*.js` | Postgres / Neon | Vercel Cron | 60s |

Self-hosted is the best target when you can run a container: it is the only one with real-time ingest and no platform limits. Cloudflare Workers is the best serverless option — per-minute cron, no wall-clock limit on SSE, and SQLite-compatible D1. Vercel works but requires a **Pro** plan: Hobby cron jobs run once per day and a sub-daily schedule fails the deployment.

Full setup instructions, measured performance, and plan limits are in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

### Self-hosted, quick version

```bash
npm install
npm start        # node server.js
```

One process serves the API, the SSE stream, and the static frontend. Persist `DB_PATH` on a mounted volume so scan cursors survive restarts. Behind a reverse proxy, do not buffer `text/event-stream`.

### Cloudflare Workers, quick version

```bash
wrangler d1 create pool-explorer     # paste the id into wrangler.toml
npx @tailwindcss/cli -i src/input.css -o tailwind.css
wrangler deploy
```

The schema is created automatically on first use. Note that the Free tier's 10ms CPU limit is below what the indexer needs, so ingest requires Workers Paid ($5/mo). The read API is fine on Free.

---

## Design Notes & Limitations

**Why event scanning, not an indexer?** Reading creation events directly from public RPC removes API keys, rate-limit tiers, and third-party downtime from the critical path. The trade-off is that scans are bounded by public-provider limits, which is why the poller is chunked, batched, and paced.

**Why is the core platform-agnostic?** `lib/core` imports no `node:*` modules, no Cloudflare bindings, and no Vercel SDK. That keeps it testable with `node:test`, bundleable into a Worker, and honest about the one real dependency: storage. Everything platform-specific is a `Store` implementation in `lib/adapters/`.

**Why does SSE poll instead of push?** The self-hosted server used to broadcast to an in-memory set of subscribers. A serverless runtime never guarantees two connections share a process, so that design cannot be ported. Polling storage on a timer and emitting only on a fingerprint change behaves identically on all three targets, costs a few indexed reads per connection, and stays silent when nothing changes.

**Why a 30-minute window?** The goal is *discovery*, not history. Pools are pruned 30 minutes after insertion, which keeps the database and every snapshot small, keeps the first paint fast, and guarantees the list is dominated by fresh launches.

**Precision.** `uint256` values are stored and transported as strings. Any conversion to `Number` happens only at render time, for display.

**Known gaps.**

- There is no historical archive — pruned pools cannot be recovered without re-scanning from genesis.
- `/api/pools` returns the entire window as one payload, capped at 1000 pools; a longer retention period would want real pagination.
- The V4 Reserves lens address is a module-level constant. Adding a chain whose lens is deployed elsewhere requires parameterising it per chain.
- V4 liquidity can lag discovery by one ingest cycle on serverless targets, because inline enrichment is capped at 25 pools per invocation and the rest are repaired on the next pass.
- Throughput is bounded by public RPC rate limits. When a provider returns `429`, failover retries the secondary endpoint and roughly doubles latency for that request.
- There is no authentication, rate limiting, or TLS termination — all three are expected to be handled by the hosting platform or a reverse proxy.

---

## Contributing

1. Fork the repository and create a feature branch.
2. Install dependencies with `npm install`.
3. Run `npm test` — it must pass with no network access.
4. Run `npm run dev` and verify your change against live pool data.
5. Keep the server dependency-free; prefer Node built-ins over new packages.
6. If you touch storage behaviour, check it against all three adapters — `lib/core/store.js` documents the contract they all implement.
7. Regenerate `tailwind.css` if you touched markup or styles.
8. Open a pull request describing the behaviour change and how you verified it.

---

## License

Released under the [MIT License](LICENSE) © 2026 Sagar Karmoker.