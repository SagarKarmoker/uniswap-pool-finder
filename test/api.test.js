/**
 * HTTP layer tests.
 *
 * The handlers are shared verbatim by the Worker, the Vercel Functions and
 * `server.js`, so this is the one place the three targets' contract is
 * pinned: routing, filtering, CORS, and the SSE framing.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { routeRequest, handlePools, handlePreflight } from "../lib/api.js";
import { createSqliteStore } from "../lib/adapters/sqlite.js";
import { TUNING } from "../lib/core/config.js";

async function storeWith(pools = []) {
  const { DatabaseSync } = await import("node:sqlite");
  const store = await createSqliteStore(new DatabaseSync(":memory:"));
  if (pools.length) {
    await store.insertPools(
      pools.map((p, i) => ({
        id: p.id ?? `0xp${i}`,
        chain: "base",
        protocol: "V3",
        token0: "0xaaa",
        token1: "0x0000000000000000000000000000000000000000",
        fee: 3000,
        tickSpacing: 60,
        hooks: null,
        sqrtPriceX96: "79228162514264337593543950336",
        tick: 0,
        liquidity: "1000",
        reserves0: "5",
        reserves1: "6",
        blockNumber: 100 + i,
        txHash: "0xtx",
        createdAt: new Date().toISOString(),
        ...p,
      })),
    );
  }
  return store;
}

const req = (path) => new Request(`https://example.test${path}`);

test("GET /api/pools returns the enriched snapshot", async () => {
  const store = await storeWith([{}]);
  const res = await routeRequest(store, req("/api/pools"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);

  const body = await res.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].token1Meta.symbol, "ETH", "native token enriched");
  assert.equal(body[0].bal0, "5");
});

test("GET /api/pools honours chain and protocol filters", async () => {
  const store = await storeWith([
    { id: "0xa", chain: "base", protocol: "V3" },
    { id: "0xb", chain: "base", protocol: "V4" },
    { id: "0xc", chain: "robinhood", protocol: "V3" },
  ]);

  const all = await (await routeRequest(store, req("/api/pools"))).json();
  assert.equal(all.length, 3);

  const base = await (await routeRequest(store, req("/api/pools?chain=base"))).json();
  assert.equal(base.length, 2);

  const v4 = await (await routeRequest(store, req("/api/pools?protocol=v4"))).json();
  assert.equal(v4.length, 1);
  assert.equal(v4[0].pool, "0xb", "API exposes the address as `pool`");
});

test("responses carry permissive CORS headers", async () => {
  const store = await storeWith();
  const res = await routeRequest(store, req("/api/pools"));
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("OPTIONS preflight returns 204 with CORS", async () => {
  const res = handlePreflight();
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-methods"), /GET/);
});

test("unknown API routes 404", async () => {
  const store = await storeWith();
  const res = await routeRequest(store, req("/api/nope"));
  assert.equal(res.status, 404);
});

test("GET /api/health reports adapter, pool count and cursors", async () => {
  const store = await storeWith([{}]);
  await store.setMeta({ last_head: "12345", "last_scanned_to:base": "12000" });

  const res = await routeRequest(store, req("/api/health"));
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.equal(body.adapter, "sqlite");
  assert.equal(body.pools, 1);
  assert.equal(body.head, 12345);
  assert.equal(body.cursors["last_scanned_to:base"], "12000");
});

test("GET /api/stream opens with a snapshot frame", async () => {
  const store = await storeWith([{}]);
  const res = await routeRequest(store, req("/api/stream"));

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");

  const reader = res.body.getReader();
  const { value } = await reader.read();
  const frame = new TextDecoder().decode(value);

  assert.match(frame, /^data: /, "SSE data framing");
  const payload = JSON.parse(frame.slice(6));
  assert.equal(payload.type, "snapshot");
  assert.equal(payload.pools.length, 1);

  await reader.cancel();
});

test("SSE closes itself before the runtime has to kill it", async () => {
  const store = await storeWith();
  const shortTuning = { ...TUNING, streamMaxDurationMs: 200, streamPollMs: 50 };
  const original = TUNING.streamMaxDurationMs;
  TUNING.streamMaxDurationMs = shortTuning.streamMaxDurationMs;
  TUNING.streamPollMs = shortTuning.streamPollMs;

  try {
    const res = await routeRequest(store, req("/api/stream"));
    const reader = res.body.getReader();

    const chunks = [];
    let sawReconnect = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      chunks.push(text);
      if (text.includes('"reconnect"')) {
        sawReconnect = true;
        break;
      }
    }
    assert.ok(sawReconnect, "stream emits a reconnect frame before closing");
    assert.ok(chunks.length >= 1);
  } finally {
    TUNING.streamMaxDurationMs = original;
    TUNING.streamPollMs = 3000;
  }
});