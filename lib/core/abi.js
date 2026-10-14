/**
 * Raw ABI decoding helpers.
 *
 * The indexer deliberately avoids an ABI library: every value it needs is
 * either a fixed-width word or a dynamic string, which is cheap to decode
 * directly. Keeping this pure (no platform APIs) makes it trivially testable
 * and safe to bundle anywhere.
 */

import { SELECTORS, RESERVES_LENS_SELECTOR, DYNAMIC_FEE_FLAG } from "./config.js";

const toHex = (n) => BigInt(n).toString(16);

/** Decode a Solidity `string` return value from `eth_call` hex data. */
export function decodeString(hex) {
  if (!hex || hex === "0x") return null;
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  // offset word (64) + length word (64) = 128 hex chars of header
  if (h.length < 128) return null;
  const len = Number(BigInt("0x" + h.slice(64, 128)));
  if (!Number.isFinite(len) || len <= 0) return null;
  const slice = h.slice(128, 128 + len * 2);
  if (slice.length < len * 2) return null;
  try {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = parseInt(slice.substr(i * 2, 2), 16);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decode a signed ABI word.
 *
 * Solidity sign-extends `intN` to fill the whole 32-byte word, so a negative
 * `int24 tick` arrives with the top 255 bits set. Interpreting the word as a
 * signed 256-bit integer therefore yields the exact `intN` value for both
 * positive and negative inputs — no masking required.
 *
 * The previous approach read the word as a *packed* 24-bit value and applied
 * the 24-bit sign bit. That agrees for positive values but produced values
 * around 1.16e77 for negative ones.
 */
export function toSignedWord(hexWord) {
  const cleaned = String(hexWord ?? "").replace(/^0+/, "");
  if (!cleaned) return 0;
  try {
    let v = BigInt("0x" + cleaned);
    if (v >= 1n << 255n) v -= 1n << 256n;
    return Number(v);
  } catch {
    return 0;
  }
}

/** Decode a `uint8`/`uint256` return value. */
export function decodeUint8(hex) {
  if (!hex || hex === "0x") return null;
  return Number(BigInt(hex));
}

/**
 * Convert a 24-bit two's-complement word to a signed integer.
 *
 * Uniswap packs fee (24 bits) and tickSpacing (24 bits) into one word, and
 * ticks are signed, so the high bit must be interpreted as a sign bit.
 */
export function toInt24(x) {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n)) return null;
  return n >= DYNAMIC_FEE_FLAG ? n - 0x1000000 : n;
}

/** Split a packed 24-bit fee/tickSpacing word. */
export function unpackPacked24(word) {
  const raw = Number(word);
  const fee = raw >>> 0;
  return {
    fee,
    isDynamicFee: fee >= DYNAMIC_FEE_FLAG,
    dynamicFeeFlag: fee >= DYNAMIC_FEE_FLAG,
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ *
 * Address / word padding for calldata encoding
 * ------------------------------------------------------------------ */

function padAddress(addr) {
  return String(addr).slice(2).toLowerCase().padStart(64, "0");
}

function padUint(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

/** Two's-complement encode a possibly-negative integer into one word. */
function padInt(value) {
  let n = BigInt(value);
  if (n < 0n) n += 1n << 256n;
  return n.toString(16).padStart(64, "0");
}

/** Build the calldata for `ReservesLens.getReserves(PoolKey)`. */
export function encodeReservesCall(poolManager, pool) {
  return (
    RESERVES_LENS_SELECTOR +
    padAddress(poolManager) +
    padAddress(pool.token0) +
    padAddress(pool.token1) +
    padUint(pool.fee ?? 0) +
    padInt(pool.tickSpacing ?? 0) +
    padAddress(pool.hooks || "0x0000000000000000000000000000000000000000")
  );
}

/** Encode `balanceOf(address)` calldata for a given owner. */
export function encodeBalanceOf(owner) {
  return SELECTORS.balanceOf + String(owner).slice(2).toLowerCase().padStart(64, "0");
}

/**
 * Decode the `getReserves` return tuple.
 *
 * Layout (9 words): amount0, amount1, .., sqrtPriceX96 (word 6),
 * tick (word 7, signed int24), liquidity (word 8).
 */
export function parseReservesResult(hex) {
  if (!hex || hex === "0x" || hex.length < 2 + 9 * 64) return null;
  const h = hex.slice(2);
  const words = h.match(/.{1,64}/g) || [];
  if (words.length < 9) return null;
  try {
    const reserves0 = BigInt("0x" + words[0]).toString();
    const reserves1 = BigInt("0x" + words[1]).toString();
    const sqrtPriceX96 = BigInt("0x" + words[6]).toString();
    const tick = toSignedWord(words[7]);
    const liquidity = BigInt("0x" + words[8]).toString();
    return { reserves0, reserves1, sqrtPriceX96, tick, liquidity };
  } catch {
    return null;
  }
}

/** Decode V3 `slot0()` — sqrtPriceX96 (word 0) and signed tick (word 1). */
export function parseSlot0(hex) {
  if (!hex || hex === "0x") return null;
  const buf = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (buf.length < 128) return null;
  try {
    const sqrtPriceX96 = BigInt("0x" + buf.slice(0, 64)).toString();
    const tick = toSignedWord(buf.slice(64, 128));
    return { sqrtPriceX96, tick };
  } catch {
    return null;
  }
}

/** Decode a bare `uint256`/`uint128` return value, tolerating empty results. */
export function parseUint(hex, fallback = "0") {
  if (!hex || hex === "0x" || hex === "0x0") return fallback;
  try {
    return BigInt(hex).toString();
  } catch {
    return fallback;
  }
}

/**
 * Extract a topic word as a lowercase address.
 * Indexed address params occupy the low 20 bytes of the 32-byte word.
 */
export function topicToAddress(topic) {
  return ("0x" + topic.slice(26)).toLowerCase();
}

/** Extract a topic word as a lowercase bytes32 id (V4 pool id). */
export function topicToBytes32(topic) {
  return topic.toLowerCase();
}

export { toHex };