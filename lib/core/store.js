/**
 * Storage port.
 *
 * Every deployment target talks to a different database, but the scanner and
 * the API layer only ever need the operations described below. Implementations
 * live in `lib/adapters/`:
 *
 *   - `sqlite.js`   — `node:sqlite`, self-hosted always-on server
 *   - `d1.js`       — Cloudflare D1
 *   - `postgres.js` — Vercel Postgres / Neon
 *
 * Two properties matter more than anything else here, because they are what
 * make a store viable on serverless platforms:
 *
 *   1. **Every method is async** and every read is chunked internally to stay
 *      under the target's parameter/bind limits.
 *   2. **Lookups are batch-oriented** (`filterExistingPoolIds` takes a list).
 *      A per-row `SELECT` would blow Cloudflare D1's 50-queries-per-invocation
 *      free-tier limit almost immediately.
 *
 * @typedef {Object} TokenMeta
 * @property {string} address
 * @property {string|null} name
 * @property {string|null} symbol
 * @property {number|null} decimals
 *
 * @typedef {Object} PoolRow
 * @property {string} id
 * @property {string} chain
 * @property {"V3"|"V4"} protocol
 * @property {string} token0
 * @property {string} token1
 * @property {number|null} fee
 * @property {number|null} tickSpacing
 * @property {string|null} hooks
 * @property {string|null} sqrtPriceX96
 * @property {number|null} tick
 * @property {string|null} liquidity
 * @property {string|null} reserves0
 * @property {string|null} reserves1
 * @property {number|null} blockNumber
 * @property {string|null} txHash
 * @property {string} createdAt ISO-8601 UTC
 *
 * @typedef {Object} Store
 * @property {() => Promise<Record<string,string>>} getMeta Read all `meta` rows.
 * @property {(entries: Record<string,string>) => Promise<void>} setMeta Upsert `meta` rows.
 * @property {(addresses: string[]) => Promise<Map<string, TokenMeta>>} getTokens Batch token lookup.
 * @property {(tokens: TokenMeta[]) => Promise<void>} upsertTokens Batch token upsert.
 * @property {(ids: string[]) => Promise<Set<string>>} filterExistingPoolIds Which of these ids already exist.
 * @property {(rows: PoolRow[]) => Promise<number>} insertPools Batch insert; returns rows written.
 * @property {(updates: {id: string, sqrtPriceX96?: string|null, tick?: number|null, liquidity?: string|null, reserves0?: string|null, reserves1?: string|null}[]) => Promise<number>} updatePoolState Batch state write-back.
 * @property {() => Promise<PoolRow[]>} listPools All live-window pools, newest block first.
 * @property {(cutoffIso: string) => Promise<number>} prunePools Delete rows older than `cutoffIso`; returns count.
 * @property {(chain: string, limit: number) => Promise<PoolRow[]>} listPoolsNeedingState V4 rows whose state is still unresolved.
 * @property {(id: string, pool: Partial<PoolRow>) => Promise<void>} saveToken
 * @property {string} kind Adapter identifier, surfaced in `/api/health`.
 */

export {};