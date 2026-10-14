/**
 * Log-decoding tests.
 *
 * Regression cover for real bugs found while porting the indexer to
 * serverless runtimes.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { decodeV3Pool as decodeV3PoolForTest, decodeV4Pool as decodeV4PoolForTest } from "../lib/core/scanner.js";

const word = (v) => BigInt(v).toString(16).padStart(64, "0");

/** ABI encodes negative integers as 256-bit two's complement. */
const signedWord = (v) => word(BigInt(v) < 0n ? (1n << 256n) + BigInt(v) : BigInt(v));

/** A topic word is 32 bytes; an indexed address occupies the low 20. */
const topicFor = (hexByte) => "0x" + "00".repeat(12) + hexByte.repeat(20);
const ADDR_A = "0x" + "aa".repeat(20);
const ADDR_B = "0x" + "bb".repeat(20);

/** Minimal V3 `PoolCreated` log. */
function v3Log({ tickSpacing = 60, pool = "0x" + "ab".repeat(20) } = {}) {
  return {
    topics: [
      "0x" + "0".repeat(64),
      topicFor("aa"),
      topicFor("bb"),
      "0x" + word(3000),
    ],
    data: "0x" + word(tickSpacing) + "0".repeat(24) + pool.slice(2),
    blockNumber: "0x64",
    transactionHash: "0xtx",
  };
}

/** Minimal V4 `Initialize` log. */
function v4Log({ fee = 500, tickSpacing = 60, sqrt = 1n << 96n, tick = -5 } = {}) {
  return {
    topics: [
      "0x" + "0".repeat(64),
      "0x" + "cd".repeat(32),
      topicFor("aa"),
      topicFor("bb"),
    ],
    data:
      "0x" +
      word(fee) +
      word(tickSpacing) +
      "0".repeat(24) + "ef".repeat(20) +
      word(sqrt) +
      signedWord(tick),
    blockNumber: "0x64",
    transactionHash: "0xtx",
  };
}

test("V3 decode reads token pair, fee, tickSpacing and pool address", () => {
  const p = decodeV3PoolForTest(v3Log(), "base");
  assert.equal(p.protocol, "V3");
  assert.equal(p.chain, "base");
  assert.equal(p.token0, ADDR_A);
  assert.equal(p.token1, ADDR_B);
  assert.equal(p.fee, 3000);
  assert.equal(p.tickSpacing, 60);
  assert.equal(p.id, "0x" + "ab".repeat(20));
  assert.equal(p.blockNumber, 100);
});

test("V3 decode survives an all-zero tickSpacing word", () => {
  // Regression: the ported code built the BigInt argument as
  // `"0x" + cleaned || "0x0"`, and since `"0x" + ""` is the truthy string
  // "0x", the fallback never applied and BigInt("0x") threw.
  const p = decodeV3PoolForTest(v3Log({ tickSpacing: 0n }), "base");
  assert.equal(p.tickSpacing, 0);
});

test("V3 decode applies int24 sign to a negative tickSpacing", () => {
  // A negative int24 tickSpacing is sign-extended across the whole word.
  const p = decodeV3PoolForTest(v3Log({ tickSpacing: (1n << 256n) - 60n }), "base");
  assert.equal(p.tickSpacing, -60);
});

test("V4 decode reads fee, tickSpacing, hooks, price and tick", () => {
  const p = decodeV4PoolForTest(v4Log(), "base");
  assert.equal(p.protocol, "V4");
  assert.equal(p.id, "0x" + "cd".repeat(32));
  assert.equal(p.fee, 500);
  assert.equal(p.tickSpacing, 60);
  assert.equal(p.hooks, "0x" + "ef".repeat(20));
  assert.equal(p.sqrtPriceX96, (1n << 96n).toString());
  assert.equal(p.tick, -5);
});

test("V4 decode survives all-zero fee, tickSpacing and sqrtPrice words", () => {
  const log = v4Log({ fee: 0n, tickSpacing: 0n, sqrt: 0n, tick: 0n });
  const p = decodeV4PoolForTest(log, "base");
  assert.equal(p.fee, 0);
  assert.equal(p.tickSpacing, 0);
  assert.equal(p.sqrtPriceX96, "0", "zero price must not become null or throw");
  assert.equal(p.tick, 0);
});

test("V4 decode preserves the dynamic-fee flag in the fee field", () => {
  const p = decodeV4PoolForTest(v4Log({ fee: 0x800000 }), "base");
  assert.equal(p.fee, 0x800000, "flag is stored raw for the client to interpret");
});

test("decoders stamp an ISO createdAt used by retention", () => {
  const p = decodeV3PoolForTest(v3Log(), "base");
  assert.match(p.createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
});