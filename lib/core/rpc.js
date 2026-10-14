/**
 * JSON-RPC helpers with multi-endpoint failover.
 *
 * Uses only the global `fetch`, which exists in Node 18+, Cloudflare Workers
 * and Vercel Edge/Node runtimes alike.
 */

import { sleep } from "./abi.js";

/** JSON-RPC request body builders. */
const rpcRequest = (method, params, id) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

let requestId = 0;
function nextId() {
  requestId = (requestId + 1) % 1_000_000_000;
  return requestId;
}

/**
 * Single JSON-RPC call, trying each endpoint in order until one answers.
 *
 * @param {string} method
 * @param {unknown[]} params
 * @param {string[]} rpcs
 * @returns {Promise<any>}
 */
export async function rpcCall(method, params, rpcs) {
  let lastErr;
  for (const url of rpcs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rpcRequest(method, params, nextId())),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || "RPC error");
      return json.result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("all RPC endpoints failed");
}

/**
 * Batched JSON-RPC call. Responses are realigned to request order by id, and
 * individual failures come back as `null` rather than failing the batch —
 * partial results are still useful for enrichment.
 *
 * @param {{method: string, params: unknown[]}[]} requests
 * @param {string[]} rpcs
 * @returns {Promise<any[]>}
 */
export async function batchRpc(requests, rpcs) {
  let lastErr;
  for (const url of rpcs) {
    try {
      const body = requests.map((r, i) => rpcRequest(r.method, r.params, i + 1));
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = await res.json();
      if (!Array.isArray(arr)) throw new Error("batch response was not an array");

      const byId = new Map();
      for (const item of arr) {
        if (item && item.id != null) byId.set(item.id, item);
      }
      return requests.map((_, i) => {
        const item = byId.get(i + 1);
        if (!item || item.error) return null;
        return item.result === undefined ? null : item.result;
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("all RPC endpoints failed");
}

/**
 * Fetch logs over a block range, chunked to stay under provider limits.
 *
 * Chunk failures are logged and skipped rather than aborting the sweep — a
 * partial range is far better than none, and the cursor still advances so the
 * run makes forward progress.
 *
 * @returns {Promise<any[]>}
 */
export async function fetchLogsRange(address, topic, fromBlock, toBlock, rpcs, tuning) {
  const out = [];
  if (fromBlock > toBlock) return out;

  const chunkSize = tuning.logChunkSize;
  const delay = tuning.logChunkDelayMs;

  for (let to = toBlock; to >= fromBlock; to -= chunkSize) {
    const from = Math.max(fromBlock, to - chunkSize + 1);
    try {
      const res = await rpcCall(
        "eth_getLogs",
        [
          {
            fromBlock: "0x" + toBlock2hex(from),
            toBlock: "0x" + toBlock2hex(to),
            address,
            topics: [topic],
          },
        ],
        rpcs,
      );
      if (Array.isArray(res)) out.push(...res);
    } catch (err) {
      console.warn(`getLogs ${address} ${from}-${to} failed: ${err.message}`);
    }
    if (delay) await sleep(delay);
  }
  return out;
}

const toBlock2hex = (n) => Number(n).toString(16);

/**
 * Run an async mapper over `items` in fixed-size batches, pacing between
 * batches to stay polite to public RPC endpoints.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} batchSize
 * @param {number} delayMs
 * @param {(batch: T[]) => Promise<R[]>} fn
 * @returns {Promise<R[]>}
 */
export async function batchedMap(items, batchSize, delayMs, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    out.push(...(await fn(chunk)));
    if (delayMs && i + batchSize < items.length) await sleep(delayMs);
  }
  return out;
}