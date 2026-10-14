# Uniswap Pool Explorer

A real-time dashboard for discovering **newly listed Uniswap V3 and V4 pools** across the **Base** and **Robinhood Chain** mainnets.

The indexer tails on-chain pool-creation events, enriches each pool with token metadata and live state, and streams snapshots to the browser over Server-Sent Events — no API keys, no third-party indexer, no build step required at runtime.

[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933)
![Runtime](https://img.shields.io/badge/runtime-zero--dependencies-22d3ee)

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
- [Deployment](#deployment)
- [Design Notes & Limitations](#design-notes--limitations)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Dual-protocol coverage** — tracks Uniswap V3 (`PoolCreated`) and V4 (`Initialize`) pool-creation events side by side.
- **Multi-chain** — scans Base and Robinhood Chain concurrently, with a chain selector in the UI.
- **Rolling live window** — only the last **30 minutes** of newly created pools are retained, so the dashboard stays focused on genuinely fresh launches.
- **Realtime stream** — Server-Sent Events push a full snapshot on every discovery plus a 3-second heartbeat, with no client-side polling.
- **On-chain enrichment** — token `name` / `symbol` / `decimals` are decoded from raw `eth_call` return data; no ABI libraries required.
- **Pool state** — V3 pools read `slot0()` + `liquidity()` + ERC-20 balances directly; V4 pools read state through a Reserves lens contract.
- **Sparse log scanning** — 3,000-block chunked `eth_getLogs` requests with multi-endpoint failover and polite inter-request delays.
- **Resumable** — scan cursors persist in SQLite, so restarts never re-scan history.
- **Self-hosted fallback** — a static file server is built into the API process; one command is enough to run in production.
- **Zero runtime dependencies** — the server uses only Node built-ins (`node:http`, `node:sqlite`, global `fetch`).

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

The first launch backfills roughly the **last 5,000 blocks** per chain, then switches to incremental 3-second polling. Cold start usually takes under a minute before the first pools appear.

### All scripts

| Script | Command | Purpose |
| :-- | :-- | :-- |
| `npm run dev` | `node scripts/dev.js` | Runs API (:3000) and Vite (:5173) concurrently with HMR |
| `npm run api` | `node server.js` | API server, SSE stream, and static file server only |
| `npm start` | `node server.js` | Production entrypoint (same as `api`) |
| `npm run build` | `vite build` | Bundles the client into `dist/` |
| `npm run preview` | `vite preview --port 5173` | Serves the production bundle locally |

### Regenerating styles

`tailwind.css` is a committed build artifact rather than a runtime step, so the app works immediately after `npm install`. Rebuild it after editing markup or adding classes:

```bash
npx @tailwindcss/cli -i src/input.css -o tailwind.css
```

---

## Architecture

```
  Base RPC  ─┐                      ┌──────────────────────────────┐
             ├─►  pollLoop (3s)  ──► │  server.js                   │
 Robinhood ──┘   getLogs chunks     │  ├─ chain registry           │
                  batched eth_call  │  ├─ log decoders (raw hex)   │
                                     │  ├─ pools.db  (node:sqlite) │
                                     │  └─ HTTP + SSE + static      │
                                     └──────────────┬───────────────┘
                                                    │  snapshot / heartbeat
  Browser ◄──── SSE  /api/stream  ◄─────────────────┘
     │
     └─►  filter (chain · protocol) → paginate (25/page) → render cards
```

The system is a single-process design: **indexer + storage + API + static server** all live in `server.js`. The frontend is a dependency-free ES module that consumes the API and mutates the DOM directly.

### Indexing pipeline

1. **Bootstrap** — for each chain, if no cursor exists, set `last_scanned = latest_block − 5000`.
2. **Poll every 3 s** — fetch the head block; if it advanced, process `(last_scanned, head]`.
3. **Discover** — two chunked `eth_getLogs` sweeps per chain range, filtered by topic:
   - V3: `PoolCreated` on the chain's V3 factory
   - V4: `Initialize` on the chain's V4 `PoolManager`
4. **Deduplicate** — a `SELECT 1 FROM pools WHERE id = ?` guard skips pools already indexed; primary keys are the pool addresses.
5. **Resolve tokens** — batched `eth_call`s for `name()` / `symbol()` / `decimals()`, cached in-memory *and* in the `tokens` table.
6. **Read state** — V3 via `slot0()` / `liquidity()` / `balanceOf()`; V4 via a Reserves lens call whose result is decoded from the 9th 32-byte word.
7. **Persist** — a single prepared insert per pool, inside one transaction-free loop.
8. **Prune** — delete rows older than 30 minutes.
9. **Broadcast** — push a snapshot to all SSE subscribers, then a heartbeat with the current block.

On startup, a **V4 backfill pass** repairs any V4 pools whose state columns are still `NULL` (for example after an RPC outage during insertion).

### Chain registry

Per-chain endpoints and contract addresses live in the `CHAINS` map in `server.js`.

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

Opens a persistent `text/event-stream`. The first frame is always a full `snapshot`, then:

| `type` | Payload | When |
| :-- | :-- | :-- |
| `snapshot` | `{ pools: Pool[], newCount?, deleted?, chain? }` | New pools discovered, or rows pruned |
| `heartbeat` | `{ block, time }` | Every 3 seconds |

```bash
curl -N http://localhost:3000/api/stream
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
| `RAILWAY_PUBLIC_DOMAIN` | — | Vite | Enables allowed-host checks and WSS HMR |

```bash
# example: run the API on 8080 with the database elsewhere
STATIC_ROOT=/srv/app DB_PATH=/data/pools.db PORT=8080 node server.js
```

### Tuning constants

Behavioural constants live at the top of `server.js` and are easy to adjust:

| Constant | Value | Effect |
| :-- | :-- | :-- |
| `pollLoop` interval | `3000 ms` | Head-block check cadence |
| retention cutoff | `30 min` | How long pools stay in the window |
| bootstrap depth | `5000` blocks | Initial scan range on a fresh database |
| log chunk size | `3000` blocks | `eth_getLogs` window, with 100 ms between chunks |
| token-metadata batch | `60` calls | Batch size + 100 ms delay |
| V3 state batch | `40` calls | Batch size + 50 ms delay |
| V4 state batch | `4` calls | Batch size + 200 ms delay |

---

## Data Model

Three tables, created idempotently on boot.

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

`createdAt` is an ISO-8601 UTC timestamp used purely for the retention sweep. A `chain` column is added via a guarded `ALTER TABLE` so databases created before multi-chain support migrate automatically.

Token metadata is also held in a process-level `Map` so hot lookups never touch disk. The native-ETH sentinel `0x000…0` is treated as a built-in `{ name: "Native Ether", symbol: "ETH", decimals: 18 }`.

---

## Project Structure

```
.
├── index.html            # Single page shell: header, filters, stats, grid
├── server.js             # Indexer + SQLite store + HTTP/SSE/static server
├── scripts/
│   └── dev.js            # Runs API and Vite as child processes, shared shutdown
├── src/
│   ├── main.js           # ES entrypoint with HMR accept
│   ├── app.js            # Fetch + SSE client, filtering, pagination, rendering
│   └── input.css         # Tailwind v4 source (@config + @import)
├── tailwind.css          # Pre-built stylesheet, committed for zero-setup runs
├── tailwind.config.js    # Content globs and theme extensions
├── vite.config.js        # Dev server, API proxy, Railway host/HMR handling
├── pools.db              # SQLite database (gitignored)
└── package.json
```

### Event decoding

Both protocols are decoded from raw log payloads — no ABI or ethers.js on the server.

| Protocol | Event | Topic hash |
| :-- | :-- | :-- |
| V3 | `PoolCreated` | `0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118` |
| V4 | `Initialize` | `0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438` |

V3 state selectors: `slot0()` `0x3850c7bd`, `liquidity()` `0x1a686502`, `balanceOf(address)` `0x70a08231`.
V4 state is read through the Reserves lens `0x0000001b173C3bbF3984D417d8614E3eed34865B` via `f95138f2`, whose 9-word return value yields reserves, `sqrtPriceX96`, `tick`, and `liquidity`.

---

## Tech Stack

**Backend** — Node.js built-ins only: `node:http` for the server, `node:sqlite` for storage, global `fetch` for JSON-RPC, and raw `BigInt` arithmetic for ABI decoding. No framework, no ORM, no runtime dependencies.

**Frontend** — Vanilla ES modules with direct DOM construction. Tailwind CSS v4 (compiled to a static stylesheet). Prices are computed client-side from `sqrtPriceX96` with `BigInt` math.

**Build tooling** — Vite 6 for the dev server and HMR; `@tailwindcss/cli` for style generation.

> The page loads an `ethers` UMD bundle from a CDN for compatibility, but the current client implementation relies only on native `BigInt` and does not depend on it.

---

## Deployment

The production path is deliberately simple: one process serves the API, the SSE stream, and the static files.

```bash
npm install
npm start        # node server.js
```

- The server binds `0.0.0.0` and serves the project root, so `index.html`, `tailwind.css`, and `src/main.js` are all reachable as-is.
- Persist `DB_PATH` on a mounted volume so scan cursors and the token cache survive restarts. Without a volume the app simply re-bootstraps from scratch — correct, but slower.
- Behind a reverse proxy, forward `Content-Type` untouched and do not buffer `text/event-stream`.

### Railway

`vite.config.js` includes first-class Railway support: when `RAILWAY_PUBLIC_DOMAIN` is set it disables the dev proxy, whitelists the public host, and switches HMR to `wss` on port 443. Deploy with `npm start` and point `STATIC_ROOT` at the directory containing `index.html`.

---

## Design Notes & Limitations

**Why event scanning, not an indexer?** Reading creation events directly from public RPC removes API keys, rate-limit tiers, and third-party downtime from the critical path. The trade-off is that scans are bounded by public-provider limits, which is why the poller is chunked, batched, and paced.

**Why a 30-minute window?** The goal is *discovery*, not history. Pools are pruned 30 minutes after insertion, which keeps SQLite and every snapshot small, keeps the first paint fast, and guarantees the list is dominated by fresh launches.

**Precision.** `uint256` values are stored and transported as strings. Any conversion to `Number` happens only at render time, for display.

**Known gaps.**

- There is no historical archive — pruned pools cannot be recovered without re-scanning from genesis.
- `/api/pools` returns the entire window as one payload; this is fine at current volumes but would want pagination for a longer retention period.
- The V4 Reserves lens address is a module-level constant. Adding a chain whose lens is deployed elsewhere requires parameterising it per chain.
- There is no authentication, rate limiting, or TLS termination — all three are expected to be handled by the hosting platform or a reverse proxy.

---

## Contributing

1. Fork the repository and create a feature branch.
2. Install dependencies with `npm install`.
3. Run `npm run dev` and verify your change against live pool data.
4. Keep the server dependency-free; prefer Node built-ins over new packages.
5. Regenerate `tailwind.css` if you touched markup or styles.
6. Open a pull request describing the behaviour change and how you verified it.

---

## License

Released under the [MIT License](LICENSE) © 2026 Sagar Karmoker.