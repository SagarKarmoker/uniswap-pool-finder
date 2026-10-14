/**
 * Store-contract tests.
 *
 * The `Store` interface is the seam that lets one codebase run on SQLite, D1
 * and Postgres. These tests pin the behaviour the scanner relies on — batched
 * existence checks, idempotent inserts, retention pruning, state repair — so a
 * new adapter cannot silently drift from the contract.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createSqliteStore } from "../lib/adapters/sqlite.js";
import { buildPools, filterPools, fingerprint } from "../lib/core/snapshot.js";

async function freshStore() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  return createSqliteStore(db);
}

const pool = (over = {}) => ({
  id: "0xpool1",
  chain: "base",
  protocol: "V3",
  token0: "0xaaa",
  token1: "0xbbb",
  fee: 3000,
  tickSpacing: 60,
  hooks: null,
  sqrtPriceX96: null,
  tick: null,
  liquidity: "0",
  reserves0: null,
  reserves1: null,
  blockNumber: 100,
  txHash: "0xtx",
  createdAt: new Date().toISOString(),
  ...over,
});

test("insert then batch-filter existing ids", async () => {
  const store = await freshStore();
  await store.insertPools([pool({ id: "0xa" }), pool({ id: "0xb" })]);

  const existing = await store.filterExistingPoolIds(["0xa", "0xb", "0xc"]);
  assert.deepEqual([...existing].sort(), ["0xa", "0xb"]);
  assert.ok(!existing.has("0xc"));
});

test("existence checks chunk beyond the parameter limit", async () => {
  const store = await freshStore();
  const ids = Array.from({ length: 250 }, (_, i) => `0xid${i}`);
  await store.insertPools(ids.map((id) => pool({ id })));

  const existing = await store.filterExistingPoolIds(ids);
  assert.equal(existing.size, 250, "all 250 found across chunks");
});

test("inserts are idempotent and report what was written", async () => {
  const store = await freshStore();
  const first = await store.insertPools([pool({ id: "0xa" })]);
  const second = await store.insertPools([pool({ id: "0xa" })]);

  assert.equal(first, 1);
  assert.equal(second, 0, "duplicate insert writes nothing");
  assert.equal((await store.listPools()).length, 1);
});

test("retention prunes only rows older than the cutoff", async () => {
  const store = await freshStore();
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await store.insertPools([
    pool({ id: "0xold", createdAt: old }),
    pool({ id: "0xnew", createdAt: new Date().toISOString() }),
  ]);

  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const pruned = await store.prunePools(cutoff);

  assert.equal(pruned, 1);
  const remaining = await store.listPools();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, "0xnew");
});

test("meta round-trips and upserts", async () => {
  const store = await freshStore();
  const KEY = "last_scanned_to:base";
  await store.setMeta({ [KEY]: "10", last_head: "20" });
  assert.equal((await store.getMeta())[KEY], "10");

  await store.setMeta({ [KEY]: "99" });
  assert.equal((await store.getMeta())[KEY], "99");
  assert.equal(Object.keys(await store.getMeta()).length, 2);
});

test("token metadata upserts and refreshes", async () => {
  const store = await freshStore();
  await store.upsertTokens([{ address: "0xtok", name: "Token", symbol: "TKN", decimals: 8 }]);

  let map = await store.getTokens(["0xtok"]);
  assert.equal(map.get("0xtok").decimals, 8);

  await store.upsertTokens([{ address: "0xtok", name: "Token", symbol: "TKN2", decimals: 18 }]);
  map = await store.getTokens(["0xtok"]);
  assert.equal(map.get("0xtok").symbol, "TKN2");
  assert.equal(map.get("0xtok").decimals, 18);
});

test("unresolved V4 pools are surfaced for repair", async () => {
  const store = await freshStore();
  await store.insertPools([
    pool({ id: "0xv4a", protocol: "V4", reserves0: null, liquidity: null }),
    pool({ id: "0xv4b", protocol: "V4", reserves0: "5", liquidity: "5" }),
    pool({ id: "0xv3", protocol: "V3", reserves0: null, liquidity: null }),
  ]);

  const needs = await store.listPoolsNeedingState("base", 10);
  assert.equal(needs.length, 1);
  assert.equal(needs[0].id, "0xv4a");
});

test("state repair makes a pool stop appearing in the repair list", async () => {
  const store = await freshStore();
  await store.insertPools([pool({ id: "0xv4a", protocol: "V4", reserves0: null, liquidity: null })]);

  await store.updatePoolState([
    { id: "0xv4a", sqrtPriceX96: "1", tick: 0, liquidity: "9", reserves0: "8", reserves1: "7" },
  ]);

  assert.equal((await store.listPoolsNeedingState("base", 10)).length, 0);
  const row = (await store.listPools())[0];
  assert.equal(row.liquidity, "9");
});

test("pools are returned newest block first", async () => {
  const store = await freshStore();
  await store.insertPools([
    pool({ id: "0xold", blockNumber: 10 }),
    pool({ id: "0xnew", blockNumber: 99 }),
  ]);
  const rows = await store.listPools();
  assert.equal(rows[0].id, "0xnew");
});

/* ---------------- snapshot assembly ---------------- */

test("native ETH is enriched without a token row", async () => {
  const NATIVE = "0x0000000000000000000000000000000000000000";
  const pools = buildPools([pool({ id: "0xn", token0: NATIVE, token1: "0xtok" })], new Map());
  assert.equal(pools[0].token0Meta.symbol, "ETH");
  assert.equal(pools[0].token0Meta.decimals, 18);
  assert.equal(pools[0].token1Meta, null);
});

test("filterPools honours chain and protocol", async () => {
  const pools = [
    { chain: "base", protocol: "V3" },
    { chain: "base", protocol: "V4" },
    { chain: "robinhood", protocol: "V3" },
  ];
  assert.equal(filterPools(pools, {}).length, 3);
  assert.equal(filterPools(pools, { chain: "base" }).length, 2);
  assert.equal(filterPools(pools, { chain: "all" }).length, 3);
  assert.equal(filterPools(pools, { protocol: "v4" }).length, 1);
  assert.equal(filterPools(pools, { protocol: "both" }).length, 3);
});

test("fingerprint changes only when content changes", async () => {
  const a = { pool: "0xa", blockNumber: 1, sqrtPriceX96: "1", liquidity: "1" };
  const b = { pool: "0xb", blockNumber: 2, sqrtPriceX96: "2", liquidity: "2" };
  const changedPrice = { pool: "0xa", blockNumber: 1, sqrtPriceX96: "999", liquidity: "1" };

  assert.equal(fingerprint([a]), fingerprint([{ ...a }]), "identical content matches");
  assert.equal(fingerprint([a, b]), fingerprint([b, a]), "order-independent");
  assert.notEqual(fingerprint([a]), fingerprint([{ ...changedPrice }]), "price change is detected");
  assert.notEqual(fingerprint([a]), fingerprint([a, b]), "new pool is detected");
  assert.notEqual(fingerprint([a]), fingerprint([]), "removal is detected");
});