/**
 * Indexer core.
 *
 * `runIngest` performs exactly one pass over each configured chain and is
 * designed to be safe to call from a short-lived runtime: every invocation
 * resumes from a persisted cursor, bounds its own work, and leaves the store
 * consistent. On a long-lived server you simply call it on a timer; on
 * Cloudflare or Vercel a cron invokes it once a minute.
 */

import { CHAINS, CHAIN_IDS, TUNING, POOL_CREATED_TOPIC, POOL_INIT_TOPIC, RESERVES_LENS, NATIVE_TOKEN, SELECTORS } from "./config.js";
import {
  decodeString,
  decodeUint8,
  toSignedWord,
  sleep,
  encodeReservesCall,
  encodeBalanceOf,
  parseReservesResult,
  parseSlot0,
  parseUint,
  topicToAddress,
  topicToBytes32,
} from "./abi.js";
import { rpcCall, batchRpc, fetchLogsRange, batchedMap } from "./rpc.js";

const META_PREFIX_SCAN = "last_scanned_to:";
const META_HEAD = "last_head";
const NATIVE_META = { address: NATIVE_TOKEN, name: "Native Ether", symbol: "ETH", decimals: 18 };

/* ------------------------------------------------------------------ *
 * Token metadata
 * ------------------------------------------------------------------ */

/**
 * Resolve token metadata, reading through to the store for anything the
 * in-request cache does not already know about.
 *
 * On the always-on server this used to be backed by a process-wide Map. That
 * does not survive a cold start, so the store is now the source of truth and
 * the Map is only a within-invocation optimisation.
 */
export async function fetchTokenMetadata(store, addresses, rpcs, tuning = TUNING) {
  const wanted = new Set();
  for (const a of addresses) {
    const lower = String(a).toLowerCase();
    if (lower && lower !== NATIVE_TOKEN) wanted.add(lower);
  }
  if (wanted.size === 0) return;

  const cached = await store.getTokens([...wanted]);
  const missing = [...wanted].filter((a) => !cached.has(a));
  if (missing.length === 0) return;

  const calls = [];
  const index = [];
  for (const a of missing) {
    index.push({ addr: a, kind: "name", pos: calls.length });
    calls.push({ method: "eth_call", params: [{ to: a, data: SELECTORS.name }, "latest"] });
    index.push({ addr: a, kind: "symbol", pos: calls.length });
    calls.push({ method: "eth_call", params: [{ to: a, data: SELECTORS.symbol }, "latest"] });
    index.push({ addr: a, kind: "decimals", pos: calls.length });
    calls.push({ method: "eth_call", params: [{ to: a, data: SELECTORS.decimals }, "latest"] });
  }

  let results;
  try {
    results = await batchedMap(calls, tuning.tokenBatchSize, tuning.tokenBatchDelayMs, (batch) =>
      batchRpc(batch, rpcs),
    );
  } catch (err) {
    console.warn(`token metadata fetch failed: ${err.message}`);
    return;
  }

  const resolved = [];
  for (const a of missing) {
    const meta = { address: a, name: null, symbol: null, decimals: 18 };
    for (const info of index) {
      if (info.addr !== a) continue;
      const raw = results[info.pos];
      if (info.kind === "name") meta.name = decodeString(raw);
      if (info.kind === "symbol") meta.symbol = decodeString(raw);
      if (info.kind === "decimals") {
        const d = decodeUint8(raw);
        if (d != null) meta.decimals = d;
      }
    }
    if (!meta.symbol) meta.symbol = `${a.slice(0, 6)}…${a.slice(-4)}`;
    if (!meta.name) meta.name = meta.symbol;
    if (meta.decimals == null) meta.decimals = 18;
    resolved.push(meta);
  }

  await store.upsertTokens(resolved);
}

/* ------------------------------------------------------------------ *
 * Log decoding
 * ------------------------------------------------------------------ */

/**
 * Read a 32-byte word as a JS integer, tolerating all-zero and empty words.
 *
 * Note the ordering: `"0x" + cleaned` must be computed before deciding
 * whether the word is zero, because `"0x" + ""` is the *truthy* string "0x"
 * rather than a fallback. An earlier draft got this wrong and relied on a
 * surrounding try/catch to absorb the resulting BigInt throw.
 */
function hexWordToInt(hexWord) {
  const cleaned = String(hexWord ?? "").replace(/^0+/, "");
  if (!cleaned) return 0;
  try {
    return Number(BigInt("0x" + cleaned));
  } catch {
    return 0;
  }
}

/** Alias kept for readability at call sites that decode signed `int24`. */
const hexWordToSigned = toSignedWord;

function hexWordToString(hexWord) {
  const cleaned = String(hexWord ?? "").replace(/^0+/, "");
  if (!cleaned) return "0";
  try {
    return BigInt("0x" + cleaned).toString();
  } catch {
    return null;
  }
}

export function decodeV3Pool(log, chain) {
  const data = log.data.slice(2);
  const token0 = topicToAddress(log.topics[1]);
  const token1 = topicToAddress(log.topics[2]);
  const fee = Number(BigInt(log.topics[3]));
  const tickSpacing = hexWordToSigned(data.slice(0, 64));
  const pool = ("0x" + data.slice(64, 128).slice(24)).toLowerCase();
  return {
    id: pool,
    chain,
    protocol: "V3",
    token0,
    token1,
    fee,
    tickSpacing,
    hooks: null,
    sqrtPriceX96: null,
    tick: null,
    liquidity: "0",
    reserves0: null,
    reserves1: null,
    blockNumber: Number(log.blockNumber),
    txHash: log.transactionHash,
    createdAt: new Date().toISOString(),
  };
}

export function decodeV4Pool(log, chain) {
  const id = topicToBytes32(log.topics[1]);
  const token0 = topicToAddress(log.topics[2]);
  const token1 = topicToAddress(log.topics[3]);
  const data = log.data.slice(2);

  // The fee word carries a dynamic-fee flag in its high bit. We store the raw
  // value and let the client decide how to render it.
  const fee = hexWordToInt(data.slice(0, 64));
  const tickSpacing = hexWordToSigned(data.slice(64, 128));
  const hooks = ("0x" + data.slice(128, 192).slice(24)).toLowerCase();
  const sqrtPriceX96 = hexWordToString(data.slice(192, 256));
  const tick = hexWordToSigned(data.slice(256, 320));

  return {
    id,
    chain,
    protocol: "V4",
    token0,
    token1,
    fee,
    tickSpacing,
    hooks,
    sqrtPriceX96,
    tick,
    liquidity: null,
    reserves0: null,
    reserves1: null,
    blockNumber: Number(log.blockNumber),
    txHash: log.transactionHash,
    createdAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Pool state
 * ------------------------------------------------------------------ */

async function enrichV3State(pools, rpcs, tuning) {
  if (pools.length === 0) return;
  const calls = [];
  const index = [];
  for (const p of pools) {
    index.push({ p, kind: "slot0", pos: calls.length });
    calls.push({ method: "eth_call", params: [{ to: p.id, data: SELECTORS.slot0 }, "latest"] });
    index.push({ p, kind: "liquidity", pos: calls.length });
    calls.push({ method: "eth_call", params: [{ to: p.id, data: SELECTORS.liquidity }, "latest"] });
    index.push({ p, kind: "bal0", pos: calls.length });
    calls.push({ method: "eth_call", params: [{ to: p.token0, data: encodeBalanceOf(p.id) }, "latest"] });
    index.push({ p, kind: "bal1", pos: calls.length });
    calls.push({ method: "eth_call", params: [{ to: p.token1, data: encodeBalanceOf(p.id) }, "latest"] });
  }

  let results;
  try {
    results = await batchedMap(calls, tuning.v3BatchSize, tuning.v3BatchDelayMs, (batch) => batchRpc(batch, rpcs));
  } catch (err) {
    console.warn(`v3 state fetch failed: ${err.message}`);
    return;
  }

  const find = (pool, kind) => {
    const hit = index.find((x) => x.p === pool && x.kind === kind);
    return hit ? results[hit.pos] : null;
  };

  for (const p of pools) {
    const slot = parseSlot0(find(p, "slot0"));
    if (slot) {
      p.sqrtPriceX96 = slot.sqrtPriceX96;
      p.tick = slot.tick;
    }
    p.liquidity = parseUint(find(p, "liquidity"), "0");
    p.reserves0 = parseUint(find(p, "bal0"), "0");
    p.reserves1 = parseUint(find(p, "bal1"), "0");
  }
}

async function enrichV4State(store, chain, pools, rpcs, tuning) {
  if (pools.length === 0) return;
  const poolManager = CHAINS[chain].v4PoolManager;

  const calls = pools.map((p) => ({
    method: "eth_call",
    params: [{ to: RESERVES_LENS, data: "0x" + encodeReservesCall(poolManager, p) }, "latest"],
  }));

  let results;
  try {
    results = await batchedMap(calls, tuning.v4BatchSize, tuning.v4BatchDelayMs, (batch) => batchRpc(batch, rpcs));
  } catch (err) {
    console.warn(`v4 state fetch failed: ${err.message}`);
    return;
  }

  const updates = [];
  pools.forEach((p, i) => {
    const parsed = parseReservesResult(results[i]);
    if (!parsed) return;
    Object.assign(p, parsed);
    updates.push({ id: p.id, ...parsed });
  });

  // V4 pools persist without state when an RPC blip interrupts insertion;
  // write back immediately so the read path never has to repair them.
  if (updates.length) await store.updatePoolState(updates);
}

/* ------------------------------------------------------------------ *
 * Range processing
 * ------------------------------------------------------------------ */

/**
 * Index every pool created in `[fromBlock, toBlock]` on one chain.
 *
 * @param {import("./store.js").Store} store
 * @param {string} chain
 * @param {number} fromBlock
 * @param {number} toBlock
 * @returns {Promise<{inserted: number, scanned: number}>}
 */
export async function processRange(store, chain, fromBlock, toBlock, tuning = TUNING) {
  if (fromBlock > toBlock) return { inserted: 0, scanned: 0 };
  const cfg = CHAINS[chain];
  const rpcs = cfg.rpcs;

  const [v3logs, v4logs] = await Promise.all([
    fetchLogsRange(cfg.v3Factory, POOL_CREATED_TOPIC, fromBlock, toBlock, rpcs, tuning),
    fetchLogsRange(cfg.v4PoolManager, POOL_INIT_TOPIC, fromBlock, toBlock, rpcs, tuning),
  ]);

  const candidates = [
    ...v3logs.map((l) => decodeV3Pool(l, chain)),
    ...v4logs.map((l) => decodeV4Pool(l, chain)),
  ];

  // Batch the existence check. A per-row SELECT would blow D1's
  // 50-queries-per-invocation free-tier limit on the first busy range.
  const uniqueIds = [...new Set(candidates.map((p) => p.id))];
  const existing = await store.filterExistingPoolIds(uniqueIds);
  const fresh = candidates.filter((p) => !existing.has(p.id));

  if (fresh.length === 0) return { inserted: 0, scanned: candidates.length };

  await fetchTokenMetadata(store, fresh.flatMap((p) => [p.token0, p.token1]), rpcs, tuning);

  const v4 = fresh.filter((p) => p.protocol === "V4");
  const v3 = fresh.filter((p) => p.protocol === "V3");

  // V4 state is read inline for at most `v4EnrichLimit` pools. The Initialize
  // event already supplied sqrtPriceX96 and tick, so a pool past the limit is
  // still fully renderable — only liquidity and reserves are missing, and
  // `backfillV4State` repairs those on a later, separately bounded pass.
  // This keeps a burst of new V4 pools from exhausting a cron invocation.
  const v4Inline = v4.slice(0, tuning.v4EnrichLimit);
  await enrichV4State(store, chain, v4Inline, rpcs, tuning);
  await enrichV3State(v3, rpcs, tuning);

  const written = await store.insertPools(fresh);

  // A short write means some pools did not land. Throwing here is deliberate:
  // the caller will leave the cursor where it is, so the range is re-scanned
  // next invocation. Re-scanning is safe because `filterExistingPoolIds`
  // already filtered out everything that did land, so this converges rather
  // than duplicating. Silently advancing the cursor here would drop pools
  // permanently, which is the one failure mode this indexer cannot recover
  // from on its own.
  if (written < fresh.length) {
    throw new Error(
      `partial insert on ${chain}: wrote ${written}/${fresh.length} pools`,
    );
  }

  return {
    inserted: written,
    scanned: candidates.length,
    deferredV4: v4.length - v4Inline.length,
  };
}

/* ------------------------------------------------------------------ *
 * V4 repair pass
 * ------------------------------------------------------------------ */

/**
 * Repair V4 rows whose state never resolved.
 *
 * Originally this ran once on server boot, which was the right call for a
 * long-lived process. Serverless runtimes have no reliable "boot", so it now
 * runs at the end of each ingest pass, bounded to a small number of rows so
 * it cannot dominate the invocation.
 */
export async function backfillV4State(store, tuning = TUNING, limit = 40) {
  let repaired = 0;
  for (const chain of CHAIN_IDS) {
    const rows = await store.listPoolsNeedingState(chain, limit);
    if (!rows || rows.length === 0) continue;
    await enrichV4State(store, chain, rows, CHAINS[chain].rpcs, tuning);
    repaired += rows.length;
  }
  return repaired;
}

/* ------------------------------------------------------------------ *
 * Single ingest pass
 * ------------------------------------------------------------------ */

/**
 * Run one indexing pass across all configured chains.
 *
 * This is the single entry point shared by every deployment target. It is
 * idempotent and resumable: cursors live in the store, so an invocation that
 * dies mid-run simply redoes that window next time.
 *
 * @param {Object} opts
 * @param {import("./store.js").Store} opts.store
 * @param {Object} [opts.tuning]
 * @param {string[]} [opts.chains]
 * @returns {Promise<Object>} per-chain stats and totals
 */
export async function runIngest({ store, tuning = TUNING, chains = CHAIN_IDS }) {
  const startedAt = Date.now();
  const summary = { chains: {}, inserted: 0, pruned: 0, repaired: 0, deferredV4: 0, head: null, durationMs: 0 };

  // One meta read for all cursors rather than one query per chain.
  const meta = await store.getMeta();
  const pendingWrites = {};
  let head = null;

  for (const chain of chains) {
    const cfg = CHAINS[chain];
    if (!cfg) continue;
    const rpcs = cfg.rpcs;

    let lastScanned = Number(meta[META_PREFIX_SCAN + chain] ?? 0);

    let latestHex;
    try {
      latestHex = await rpcCall("eth_blockNumber", [], rpcs);
    } catch (err) {
      console.warn(`${chain}: block number unavailable: ${err.message}`);
      summary.chains[chain] = { error: err.message };
      continue;
    }

    const latest = Number(latestHex);
    if (head === null || latest > head) head = latest;

    if (lastScanned === 0) {
      lastScanned = Math.max(0, latest - tuning.bootstrapDepth);
    }

    let inserted = 0;
    let scanned = 0;

    if (latest > lastScanned) {
      // Bound the work per invocation so a cold-start backfill drains over
      // several runs instead of timing out on the first.
      const to = Math.min(latest, lastScanned + tuning.maxBlocksPerRun);
      try {
        const result = await processRange(store, chain, lastScanned + 1, to, tuning);
        inserted = result.inserted;
        scanned = result.scanned;
        summary.deferredV4 += result.deferredV4 ?? 0;
        // Advance only past what we actually finished.
        lastScanned = to;
      } catch (err) {
        // Leave the cursor untouched so the same range is retried. One chain
        // failing must not stop the others from advancing.
        console.error(`${chain}: ingest range failed: ${err.message}`);
        summary.chains[chain] = { latest, cursor: lastScanned, inserted: 0, scanned: 0, error: err.message };
        continue;
      }
    }

    pendingWrites[META_PREFIX_SCAN + chain] = String(lastScanned);
    summary.chains[chain] = { latest, cursor: lastScanned, inserted, scanned };
    summary.inserted += inserted;
  }

  pendingWrites[META_HEAD] = String(head ?? "");

  const cutoff = new Date(Date.now() - tuning.retentionMs).toISOString();
  summary.pruned = await store.prunePools(cutoff);
  summary.repaired = await backfillV4State(store, tuning);
  summary.head = head;
  summary.durationMs = Date.now() - startedAt;

  await store.setMeta(pendingWrites);
  return summary;
}