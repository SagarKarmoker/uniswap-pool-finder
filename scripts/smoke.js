/**
 * Live smoke test against real RPC endpoints.
 *
 * Not part of `npm test` — it hits public RPC and writes to a throwaway
 * database. Run it manually to confirm the indexer still finds and enriches
 * real pools after a refactor.
 *
 *   node scripts/smoke.js [blocks]
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../lib/index.js";
import { runIngest } from "../lib/core/scanner.js";
import { loadPools } from "../lib/api.js";

const raw = Number(process.argv[2]);
if (!Number.isFinite(raw) || raw <= 0) {
  console.log("usage: node scripts/smoke.js [blocks]   (default 800)");
  process.exit(Number.isFinite(raw) ? 1 : 0);
}
const BLOCKS = raw;

const tmp = path.join(os.tmpdir(), `pool-explorer-smoke-${process.pid}.db`);
if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

const db = new DatabaseSync(tmp);
const store = await createStore({ db });

console.log(`smoke: scanning ~${BLOCKS} blocks on Base (temp db ${tmp})\n`);

const started = Date.now();
const summary = await runIngest({
  store,
  tuning: {
    bootstrapDepth: BLOCKS,
    maxBlocksPerRun: BLOCKS,
    logChunkSize: BLOCKS,
    logChunkDelayMs: 0,
    tokenBatchSize: 50,
    tokenBatchDelayMs: 0,
    v3BatchSize: 40,
    v3BatchDelayMs: 0,
    v4BatchSize: 4,
    v4BatchDelayMs: 0,
    retentionMs: 30 * 60 * 1000,
    streamPollMs: 3000,
    streamMaxDurationMs: 240000,
    maxPoolsPerResponse: 1000,
  },
  chains: ["base"],
});

console.log(`\nhead        ${summary.head}`);
console.log(`cursor      ${summary.chains.base?.cursor}`);
console.log(`inserted    ${summary.inserted}`);
console.log(`elapsed     ${summary.durationMs}ms (wall ${Date.now() - started}ms)\n`);

const pools = await loadPools(store, {});
console.log(`pools in snapshot: ${pools.length}\n`);

let withPrice = 0;
let withTokens = 0;
let withLiquidity = 0;

for (const p of pools) {
  if (p.token0Meta && p.token1Meta) withTokens++;
  if (p.sqrtPriceX96) withPrice++;
  if (p.liquidity && p.liquidity !== "0") withLiquidity++;
}

const fmt = (p) => {
  const t0 = p.token0Meta?.symbol ?? "?";
  const t1 = p.token1Meta?.symbol ?? "?";
  const dec0 = p.token0Meta?.decimals ?? 18;
  const dec1 = p.token1Meta?.decimals ?? 18;
  let price = "—";
  if (p.sqrtPriceX96) {
    try {
      const sqrt = Number(BigInt(p.sqrtPriceX96)) / 2 ** 96;
      const adj = sqrt * sqrt * 10 ** (dec0 - dec1);
      price = Number.isFinite(adj) ? adj.toPrecision(6) : "—";
    } catch {
      /* ignore */
    }
  }
  return (
    `${p.protocol} ${String(t0).padEnd(8)}/${String(t1).padEnd(8)} ` +
    `blk ${String(p.blockNumber).padEnd(9)} price ${String(price).padEnd(12)} ` +
    `liq ${String(p.liquidity ?? "—").slice(0, 12).padEnd(12)} fee ${p.fee}`
  );
};

console.log(`first 8 of ${pools.length}:`);
for (const p of pools.slice(0, 8)) console.log("  " + fmt(p));

console.log(`\nenriched: ${withTokens}/${pools.length} with both token metadata`);
console.log(`          ${withPrice}/${pools.length} with sqrtPriceX96`);
console.log(`          ${withLiquidity}/${pools.length} with non-zero liquidity`);

db.close();
fs.unlinkSync(tmp);
console.log("\nsmoke: done");