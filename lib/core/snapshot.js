/**
 * Snapshot assembly — turns raw pool rows into the JSON shape the client
 * renders, and derives a stable fingerprint used to suppress duplicate SSE
 * frames.
 */

import { NATIVE_TOKEN, TUNING } from "./config.js";

const NATIVE_META = Object.freeze({
  name: "Native Ether",
  symbol: "ETH",
  decimals: 18,
});

/**
 * Join pool rows with token metadata.
 *
 * @param {import("./store.js").PoolRow[]} rows
 * @param {Map<string, import("./store.js").TokenMeta>} tokenMap
 * @returns {object[]}
 */
export function buildPools(rows, tokenMap) {
  return rows.map((r) => ({
    protocol: r.protocol,
    chain: r.chain || "base",
    pool: r.id,
    token0: r.token0,
    token1: r.token1,
    fee: r.fee,
    tickSpacing: r.tickSpacing,
    hooks: r.hooks,
    sqrtPriceX96: r.sqrtPriceX96,
    tick: r.tick,
    liquidity: r.liquidity,
    bal0: r.reserves0,
    bal1: r.reserves1,
    blockNumber: r.blockNumber,
    txHash: r.txHash,
    token0Meta: lookup(tokenMap, r.token0),
    token1Meta: lookup(tokenMap, r.token1),
  }));
}

function lookup(tokenMap, address) {
  if (address === NATIVE_TOKEN) return NATIVE_META;
  const hit = tokenMap.get(String(address).toLowerCase());
  if (!hit) return null;
  return { name: hit.name, symbol: hit.symbol, decimals: hit.decimals };
}

/**
 * Apply the chain/protocol filters the API supports server-side.
 * The client re-applies the same filters, but doing it here keeps responses
 * small and lets `/api/pools` be useful to non-browser consumers.
 */
export function filterPools(pools, { chain, protocol } = {}) {
  let out = pools;
  if (chain && chain !== "all") {
    out = out.filter((p) => (p.chain || "base") === chain);
  }
  if (protocol && protocol !== "both") {
    const want = protocol.toLowerCase();
    out = out.filter((p) => p.protocol.toLowerCase() === want);
  }
  return out;
}

/**
 * Stable fingerprint of a snapshot.
 *
 * SSE streams re-read the store on a timer and only emit when this changes,
 * which keeps idle connections quiet and cheap. Built from ids + block
 * numbers so it is sensitive to new pools without changing on pure ordering.
 */
export function fingerprint(pools) {
  const parts = new Array(pools.length);
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    parts[i] = `${p.pool}:${p.blockNumber}:${p.sqrtPriceX96 ?? ""}:${p.liquidity ?? ""}`;
  }
  // Order-independent so a tie in block numbers doesn't cause spurious frames.
  parts.sort();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const joined = parts.join("|");
  for (let i = 0; i < joined.length; i++) {
    const c = joined.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x9e3779b1) >>> 0;
  }
  return `${pools.length}:${h1.toString(36)}${h2.toString(36)}`;
}

/** Trim a snapshot to the configured response cap. */
export function capPools(pools, limit = TUNING.maxPoolsPerResponse) {
  return pools.length > limit ? pools.slice(0, limit) : pools;
}