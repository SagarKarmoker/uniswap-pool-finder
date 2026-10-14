/**
 * Decoder tests.
 *
 * The ABI helpers were carried over from the original `server.js` during the
 * serverless port. They are pure and cheap to test, and a silent regression
 * here would produce wrong prices in the UI rather than an error, so they get
 * explicit coverage.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeString,
  decodeUint8,
  toInt24,
  toSignedWord,
  encodeBalanceOf,
  encodeReservesCall,
  parseReservesResult,
  parseSlot0,
  parseUint,
  topicToAddress,
  topicToBytes32,
} from "../lib/core/abi.js";

/** ABI-encode a string the way a Solidity `string` return would look. */
function encodeString(str) {
  const bytes = new TextEncoder().encode(str);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const offset = (32).toString(16).padStart(64, "0");
  const length = bytes.length.toString(16).padStart(64, "0");
  return "0x" + offset + length + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
}

test("decodeString reads a padded string return", () => {
  assert.equal(decodeString(encodeString("Wrapped Ether")), "Wrapped Ether");
  assert.equal(decodeString(encodeString("USDC")), "USDC");
});

test("decodeString handles empty and malformed input", () => {
  assert.equal(decodeString("0x"), null);
  assert.equal(decodeString(null), null);
  assert.equal(decodeString("0xdeadbeef"), null, "shorter than an ABI header");
  assert.equal(decodeString(encodeString("")), null, "zero-length string");
});

test("decodeString tolerates non-ASCII", () => {
  assert.equal(decodeString(encodeString("Uniswap V4 ⚡")), "Uniswap V4 ⚡");
});

test("decodeUint8 reads a word", () => {
  assert.equal(decodeUint8("0x" + (18).toString(16).padStart(64, "0")), 18);
  assert.equal(decodeUint8("0x"), null);
});

test("toInt24 applies two's complement to the high bit", () => {
  assert.equal(toInt24(60), 60, "positive small value");
  assert.equal(toInt24(0x800000 + 10), -8388598, "negative value");
  assert.equal(toInt24(0xffffff), -1);
  assert.equal(toInt24(0), 0);
});

test("toSignedWord sign-extends ABI int fields", () => {
  // Positive int24 arrives with zero high bytes (0x3c == 60).
  assert.equal(toSignedWord("0".repeat(62) + "3c"), 60);
  // Negative int24 arrives with the top 255 bits set.
  assert.equal(toSignedWord("f".repeat(62) + "fb"), -5);
  assert.equal(toSignedWord("f".repeat(64)), -1);
  assert.equal(toSignedWord("0".repeat(64)), 0);
  assert.equal(toSignedWord(""), 0);
  // A packed 24-bit value is NOT sign-extended, and must not be mistaken
  // for a negative one.
  assert.equal(toSignedWord("0".repeat(58) + "ffffff"), 16777215);
});

test("topicToAddress extracts the low 20 bytes of a topic", () => {
  const addr = "0x33128a8fc17869897dce68ed026d694621f6fdfd";
  const topic = "0x" + addr.slice(2).padStart(64, "0");
  assert.equal(topicToAddress(topic), addr);
});

test("topicToBytes32 lowercases a V4 pool id", () => {
  const id = "0xAABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899";
  assert.equal(topicToBytes32(id), id.toLowerCase());
});

test("encodeBalanceOf builds a 4-byte selector plus a padded address", () => {
  const data = encodeBalanceOf("0xABCDEF1234567890abcdef1234567890ABCDEF12");
  assert.equal(data.length, 2 + 8 + 64);
  assert.equal(data.slice(0, 10), "0x70a08231");
  assert.equal(data.slice(10), "abcdef1234567890abcdef1234567890abcdef12".padStart(64, "0"));
});

test("encodeReservesCall produces a stable selector and 7 words", () => {
  const call = encodeReservesCall("0x498581fF718922c3f8e6A244956aF099B2652b2b", {
    token0: "0x1111111111111111111111111111111111111111",
    token1: "0x2222222222222222222222222222222222222222",
    fee: 3000,
    tickSpacing: 60,
    hooks: null,
  });
  assert.equal(call.slice(0, 8), "f95138f2");
  // selector, then poolManager, then the 5-field PoolKey struct.
  assert.equal(call.length, 8 + 6 * 64);
});

test("encodeReservesCall two's-complements a negative tickSpacing", () => {
  const call = encodeReservesCall("0x498581fF718922c3f8e6A244956aF099B2652b2b", {
    token0: "0x1111111111111111111111111111111111111111",
    token1: "0x2222222222222222222222222222222222222222",
    fee: 0,
    tickSpacing: -60,
    hooks: null,
  });
  const tickWord = call.slice(8 + 4 * 64, 8 + 5 * 64);
  // `<<` binds looser than `-`, so the shift must be parenthesised here.
  assert.equal(BigInt("0x" + tickWord), (1n << 256n) - 60n);
});

/** Build a 9-word `getReserves` return. */
function encodeReserves({ r0, r1, sqrt, tick, liq }) {
  const w = (v) => BigInt(v).toString(16).padStart(64, "0");
  return "0x" + w(r0) + w(r1) + w(0) + w(0) + w(0) + w(0) + w(sqrt) + w(tick) + w(liq);
}

test("parseReservesResult reads reserves, sqrt price, tick and liquidity", () => {
  const hex = encodeReserves({
    r0: 1000n,
    r1: 2000n,
    sqrt: 79228162514264337593543950336n, // 1 * 2^96
    tick: 0,
    liq: 5000n,
  });
  const parsed = parseReservesResult(hex);
  assert.equal(parsed.reserves0, "1000");
  assert.equal(parsed.reserves1, "2000");
  assert.equal(parsed.sqrtPriceX96, (1n << 96n).toString());
  assert.equal(parsed.tick, 0);
  assert.equal(parsed.liquidity, "5000");
});

test("parseReservesResult interprets a negative tick", () => {
  // Solidity sign-extends int24 across the full 32-byte word, so -1 arrives
  // as 2^256-1 rather than as a packed 0xffffff.
  const hex = encodeReserves({
    r0: 1n,
    r1: 1n,
    sqrt: 1n,
    tick: (1n << 256n) - 1n,
    liq: 1n,
  });
  assert.equal(parseReservesResult(hex).tick, -1);
});

test("parseReservesResult rejects short input", () => {
  assert.equal(parseReservesResult("0x"), null);
  assert.equal(parseReservesResult("0xdeadbeef"), null);
});

test("parseSlot0 reads sqrtPriceX96 and signed tick", () => {
  const w = (v) => BigInt(v).toString(16).padStart(64, "0");
  // int24 -1 sign-extended to 32 bytes.
  const hex = "0x" + w(1n << 96n) + w((1n << 256n) - 1n);
  const slot = parseSlot0(hex);
  assert.equal(slot.sqrtPriceX96, (1n << 96n).toString());
  assert.equal(slot.tick, -1);
});

test("parseSlot0 rejects empty results", () => {
  assert.equal(parseSlot0("0x"), null);
});

test("parseUint falls back rather than throwing", () => {
  assert.equal(parseUint("0x0a"), "10");
  assert.equal(parseUint("0x"), "0");
  assert.equal(parseUint(null), "0");
  assert.equal(parseUint("0x", "fallback"), "fallback");
});