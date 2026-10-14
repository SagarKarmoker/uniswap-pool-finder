import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const STATIC_ROOT = process.env.STATIC_ROOT || process.cwd();
const DB_PATH = process.env.DB_PATH || path.join(STATIC_ROOT, "pools.db");
const PORT = Number(process.env.PORT || 3000);
const RPCS = ["https://base-rpc.publicnode.com", "https://mainnet.base.org"];
const FACTORY_V3 = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const POOL_MANAGER_V4 = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const INIT_EVENT_V4 = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const RESERVES_LENS = "0x0000001b173C3bbF3984D417d8614E3eed34865B";
const POOL_EVENT = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";

const CHAINS = {
  base: { name: "Base", rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"], v3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", v4PoolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b" },
  robinhood: { name: "Robinhood", rpcs: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"], v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa", v4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951" },
};

const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,
  name TEXT,
  symbol TEXT,
  decimals INTEGER
);
CREATE TABLE IF NOT EXISTS pools (
  id TEXT PRIMARY KEY,
  protocol TEXT NOT NULL,
  token0 TEXT NOT NULL,
  token1 TEXT NOT NULL,
  fee INTEGER,
  tickSpacing INTEGER,
  hooks TEXT,
  sqrtPriceX96 TEXT,
  tick INTEGER,
  liquidity TEXT,
  reserves0 TEXT,
  reserves1 TEXT,
  blockNumber INTEGER,
  txHash TEXT,
  createdAt TEXT
);
`);
try { db.exec("ALTER TABLE pools ADD COLUMN chain TEXT DEFAULT 'base'"); } catch (e) {}
function metaGet(key) {
  const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return r ? r.value : null;
}
function metaSet(key, value) {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

const tokenCache = new Map();
function loadTokenCache() {
  const rows = db.prepare("SELECT * FROM tokens").all();
  for (const r of rows) tokenCache.set(String(r.address).toLowerCase(), { name: r.name, symbol: r.symbol, decimals: r.decimals });
}
loadTokenCache();
backfillV4State().catch((e) => console.error("backfill err", e.message));

const sseClients = new Set();
function broadcast(obj) {
  const data = "data: " + JSON.stringify(obj) + "\n\n";
  for (const res of sseClients) {
    try { res.write(data); } catch {}
  }
}

async function rpcCall(method, params, rpcs = RPCS) {
  let lastErr;
  for (const url of rpcs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "curl/8.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      if (j.error) throw new Error(j.error.message || "RPC error");
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function batchRpc(requests, rpcs = RPCS) {
  const body = requests.map((r, i) => ({
    jsonrpc: "2.0",
    id: i + 1,
    method: r.method,
    params: r.params,
  }));
  let lastErr;
  for (const url of rpcs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "curl/8.0" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const arr = await res.json();
      if (!Array.isArray(arr)) throw new Error("bad response");
      return requests.map((_, i) => {
        const r = arr.find((x) => x.id === i + 1);
        return r && r.result !== undefined ? r.result : null;
      });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function decodeString(hex) {
  if (!hex || hex === "0x") return null;
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length < 128) return null;
  const len = Number(BigInt("0x" + h.slice(64, 128)));
  const slice = h.slice(128, 128 + len * 2);
  try { return Buffer.from(slice, "hex").toString("utf8"); } catch { return null; }
}
function decodeUint8(hex) { if (!hex || hex === "0x") return null; return Number(BigInt(hex)); }
function toInt24(x) { return x >= 0x800000 ? x - 0x1000000 : x; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchTokenMetadata(addrs, rpcs = RPCS) {
  const missing = [...new Set(addrs.map((a) => a.toLowerCase()))].filter((a) => {
    if (a === "0x0000000000000000000000000000000000000000") return false;
    return !tokenCache.has(a);
  });
  if (missing.length === 0) return;
  const calls = [];
  const index = [];
  for (const a of missing) {
    const c0 = calls.length; calls.push({ method: "eth_call", params: [{ to: a, data: "0x06fdde03" }, "latest"] });
    index.push({ addr: a, kind: "name", pos: c0 });
    const c1 = calls.length; calls.push({ method: "eth_call", params: [{ to: a, data: "0x95d89b41" }, "latest"] });
    index.push({ addr: a, kind: "symbol", pos: c1 });
    const c2 = calls.length; calls.push({ method: "eth_call", params: [{ to: a, data: "0x313ce567" }, "latest"] });
    index.push({ addr: a, kind: "decimals", pos: c2 });
  }
  const results = new Array(calls.length);
  const BATCH = 60;
  for (let i = 0; i < calls.length; i += BATCH) {
    const res = await batchRpc(calls.slice(i, i + BATCH), rpcs);
    for (let j = 0; j < res.length; j++) results[i + j] = res[j];
    await sleep(100);
  }
  for (const a of missing) {
    const meta = { name: null, symbol: null, decimals: 18 };
    for (const info of index.filter((x) => x.addr === a)) {
      const r = results[info.pos];
      if (info.kind === "name") meta.name = decodeString(r);
      if (info.kind === "symbol") meta.symbol = decodeString(r);
      if (info.kind === "decimals") meta.decimals = decodeUint8(r);
    }
    if (!meta.symbol) meta.symbol = a.slice(0, 6) + "…" + a.slice(-4);
    if (!meta.name) meta.name = meta.symbol;
    if (meta.decimals == null) meta.decimals = 18;
    tokenCache.set(a, meta);
    db.prepare("INSERT INTO tokens(address,name,symbol,decimals) VALUES(?,?,?,?) ON CONFLICT(address) DO UPDATE SET name=excluded.name, symbol=excluded.symbol, decimals=excluded.decimals")
      .run(a, meta.name, meta.symbol, meta.decimals);
  }
}

function getEnrichedPools() {
  const rows = db.prepare("SELECT * FROM pools ORDER BY blockNumber DESC, id").all();
  const NATIVE = "0x0000000000000000000000000000000000000000";
  return rows.map((r) => {
    const t0 = tokenCache.get(String(r.token0).toLowerCase()) || (r.token0 === NATIVE ? { name: "Native Ether", symbol: "ETH", decimals: 18 } : null);
    const t1 = tokenCache.get(String(r.token1).toLowerCase()) || (r.token1 === NATIVE ? { name: "Native Ether", symbol: "ETH", decimals: 18 } : null);
    return {
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
      token0Meta: t0,
      token1Meta: t1,
    };
  });
}

const chainLastScanned = {};
function getLastScanned(chain) { const v = metaGet("last_scanned_to:" + chain); return v ? Number(v) : 0; }
function setLastScanned(chain, val) { metaSet("last_scanned_to:" + chain, String(val)); }

async function fetchLogsRange(address, topic, fromTotal, toTotal, rpcs) {
  const out = [];
  const total = toTotal - fromTotal + 1;
  const nchunks = Math.ceil(total / 3000);
  for (let i = 0; i < nchunks; i++) {
    const chunkTo = Math.max(fromTotal, toTotal - i * 3000);
    const chunkFrom = Math.max(fromTotal, chunkTo - 3000 + 1);
    if (chunkFrom > chunkTo) break;
    try {
      const res = await rpcCall("eth_getLogs", [
        { fromBlock: "0x" + chunkFrom.toString(16), toBlock: "0x" + chunkTo.toString(16), address, topics: [topic] },
      ], rpcs);
      if (Array.isArray(res)) out.push(...res);
    } catch (e) {
      console.warn("getLogs err", e.message);
    }
    await sleep(100);
  }
  return out;
}

function pad256Addr(a) { return String(a).slice(2).toLowerCase().padStart(64, "0"); }
function pad256Uint(x) { return format(BigInt(x), "64"); }
function pad256Int(x) {
  let n = BigInt(x);
  if (n < 0n) n += (1n << 256n);
  return n.toString(16).padStart(64, "0");
}
function format(v, n) { return v.toString(16).padStart(parseInt(n), "0"); }
function encodeReservesCall(pm, p) {
  let fee = p.fee != null ? p.fee : 0;
  let ts = p.tickSpacing != null ? p.tickSpacing : 0;
  return "f95138f2" + pad256Addr(pm) + pad256Addr(p.token0) + pad256Addr(p.token1) + pad256Uint(fee) + pad256Int(ts) + pad256Addr(p.hooks || "0x0000000000000000000000000000000000000000");
}
function parseReservesResult(hex) {
  if (!hex || hex === "0x" || hex.length < 2 + 14 * 64) return null;
  const h = hex.slice(2);
  const words = h.match(/.{1,64}/g) || [];
  const core0 = BigInt("0x" + words[0]).toString();
  const core1 = BigInt("0x" + words[1]).toString();
  const sqrt = BigInt("0x" + words[6]).toString();
  let tick = Number(BigInt("0x" + words[7]));
  if (tick >= 0x800000) tick -= 0x1000000;
  const liq = BigInt("0x" + words[8]).toString();
  return { reserves0: core0, reserves1: core1, sqrtPriceX96: sqrt, tick, liquidity: liq };
}
async function processRange(chain, fromBlock, toBlock) {
  const cfg = CHAINS[chain];
  const rpcs = cfg.rpcs;
  if (fromBlock > toBlock) return 0;
  const v3logs = await fetchLogsRange(cfg.v3Factory, POOL_EVENT, fromBlock, toBlock, rpcs);
  const v4logs = await fetchLogsRange(cfg.v4PoolManager, INIT_EVENT_V4, fromBlock, toBlock, rpcs);
  const newPools = [];
  for (const log of v3logs) {
    const token0 = ("0x" + log.topics[1].slice(26)).toLowerCase();
    const token1 = ("0x" + log.topics[2].slice(26)).toLowerCase();
    const fee = Number(BigInt(log.topics[3]));
    const data = log.data.slice(2);
    const tickSpacing = parseInt(data.slice(0, 64), 16);
    const poolWord = data.slice(64, 128);
    const pool = ("0x" + poolWord.slice(24)).toLowerCase();
    const id = pool;
    const exists = db.prepare("SELECT 1 FROM pools WHERE id = ?").get(id);
    if (exists) continue;
    const blockNumber = Number(log.blockNumber);
    const txHash = log.transactionHash;
    newPools.push({ protocol: "V3", chain, id, token0, token1, fee, tickSpacing, hooks: null, sqrtPriceX96: null, tick: null, liquidity: "0", reserves0: null, reserves1: null, blockNumber, txHash, needsState: true });
  }
  for (const log of v4logs) {
    const id = log.topics[1].toLowerCase();
    const currency0 = ("0x" + log.topics[2].slice(26)).toLowerCase();
    const currency1 = ("0x" + log.topics[3].slice(26)).toLowerCase();
    const data = log.data.slice(2);
    const feeRaw = parseInt(data.slice(0, 64), 16);
    const fee = feeRaw >= 0x800000 ? feeRaw : feeRaw;
    const tickSpacingRaw = parseInt(data.slice(64, 128), 16);
    const tickSpacing = tickSpacingRaw >= 0x800000 ? tickSpacingRaw - 0x1000000 : tickSpacingRaw;
    const hooksWord = data.slice(128, 192);
    const hooks = ("0x" + hooksWord.slice(24)).toLowerCase();
    const sqrtWord = data.slice(192, 256);
    const sqrtPriceX96 = BigInt("0x" + sqrtWord).toString();
    const tickRaw = parseInt(data.slice(256, 320), 16);
    const tick = tickRaw >= 0x800000 ? tickRaw - 0x1000000 : tickRaw;
    const exists = db.prepare("SELECT 1 FROM pools WHERE id = ?").get(id);
    if (exists) continue;
    const blockNumber = Number(log.blockNumber);
    const txHash = log.transactionHash;
    newPools.push({ protocol: "V4", chain, id, token0: currency0, token1: currency1, fee, tickSpacing, hooks, sqrtPriceX96, tick, liquidity: null, reserves0: null, reserves1: null, blockNumber, txHash, needsState: false });
  }

  const tokenAddrs = new Set();
  for (const p of newPools) { tokenAddrs.add(p.token0); tokenAddrs.add(p.token1); }
  await fetchTokenMetadata([...tokenAddrs], rpcs);

  const v4New = newPools.filter((p) => p.protocol === "V4");
  if (v4New.length > 0) {
    const calls = v4New.map((p) => ({ method: "eth_call", params: [{ to: RESERVES_LENS, data: "0x" + encodeReservesCall(cfg.v4PoolManager, p) }, "latest"] }));
    const results = [];
    const BATCH = 4;
    for (let i = 0; i < calls.length; i += BATCH) {
      const res = await batchRpc(calls.slice(i, i + BATCH), rpcs);
      results.push(...res);
      await sleep(200);
    }
    v4New.forEach((p, idx) => {
      const parsed = parseReservesResult(results[idx]);
      if (parsed) {
        p.reserves0 = parsed.reserves0;
        p.reserves1 = parsed.reserves1;
        p.sqrtPriceX96 = parsed.sqrtPriceX96;
        p.tick = parsed.tick;
        p.liquidity = parsed.liquidity;
      }
    });
  }

  const v3New = newPools.filter((p) => p.protocol === "V3");
  if (v3New.length > 0) {
    const calls = [];
    const metaIndex = [];
    for (const p of v3New) {
      const i0 = calls.length; calls.push({ method: "eth_call", params: [{ to: p.id, data: "0x3850c7bd" }, "latest"] }); metaIndex.push({ p, kind: "slot0", pos: i0 });
      const i1 = calls.length; calls.push({ method: "eth_call", params: [{ to: p.id, data: "0x1a686502" }, "latest"] }); metaIndex.push({ p, kind: "liquidity", pos: i1 });
      const i2 = calls.length; calls.push({ method: "eth_call", params: [{ to: p.token0, data: "0x70a08231" + p.id.slice(2).toLowerCase().padStart(64, "0") }, "latest"] }); metaIndex.push({ p, kind: "bal0", pos: i2 });
      const i3 = calls.length; calls.push({ method: "eth_call", params: [{ to: p.token1, data: "0x70a08231" + p.id.slice(2).toLowerCase().padStart(64, "0") }, "latest"] }); metaIndex.push({ p, kind: "bal1", pos: i3 });
    }
    const results = new Array(calls.length);
    const BATCH = 40;
    for (let i = 0; i < calls.length; i += BATCH) {
      const res = await batchRpc(calls.slice(i, i + BATCH), rpcs);
      for (let j = 0; j < res.length; j++) results[i + j] = res[j];
      await sleep(50);
    }
    for (const p of v3New) {
      const slot = results[metaIndex.find((x) => x.p === p && x.kind === "slot0").pos];
      if (slot && slot !== "0x") {
        const buf = slot.startsWith("0x") ? slot.slice(2) : slot;
        const sqrt = buf.slice(0, 64);
        const tickw = buf.slice(64, 128);
        p.sqrtPriceX96 = BigInt("0x" + sqrt).toString();
        p.tick = toInt24(parseInt(tickw, 16));
      }
      const liq = results[metaIndex.find((x) => x.p === p && x.kind === "liquidity").pos];
      p.liquidity = liq && liq !== "0x" ? BigInt(liq).toString() : "0";
      const b0 = results[metaIndex.find((x) => x.p === p && x.kind === "bal0").pos];
      const b1 = results[metaIndex.find((x) => x.p === p && x.kind === "bal1").pos];
      p.reserves0 = b0 && b0 !== "0x" ? BigInt(b0).toString() : "0";
      p.reserves1 = b1 && b1 !== "0x" ? BigInt(b1).toString() : "0";
    }
  }

  const NATIVE = "0x0000000000000000000000000000000000000000";
  if (!tokenCache.has(NATIVE)) tokenCache.set(NATIVE, { name: "Native Ether", symbol: "ETH", decimals: 18 });
  const insert = db.prepare(`INSERT INTO pools(id,chain,protocol,token0,token1,fee,tickSpacing,hooks,sqrtPriceX96,tick,liquidity,reserves0,reserves1,blockNumber,txHash,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const p of newPools) {
    if (p.protocol === "V3" && p.sqrtPriceX96 == null) p.sqrtPriceX96 = null;
    insert.run(p.id, p.chain, p.protocol, p.token0, p.token1, p.fee, p.tickSpacing, p.hooks, p.sqrtPriceX96, p.tick, p.liquidity, p.reserves0, p.reserves1, p.blockNumber, p.txHash, new Date().toISOString());
  }

  return newPools.length;
}

async function backfillV4State() {
  for (const chain of Object.keys(CHAINS)) {
    const cfg = CHAINS[chain];
    const rpcs = cfg.rpcs;
    const rows = db.prepare("SELECT id,token0,token1,fee,tickSpacing,hooks FROM pools WHERE protocol='V4' AND chain=? AND (reserves0 IS NULL OR liquidity IS NULL)").all(chain);
    if (!rows || rows.length === 0) continue;
    const BATCH = 4;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const calls = chunk.map((r) => {
        const p = { token0: r.token0, token1: r.token1, fee: r.fee, tickSpacing: r.tickSpacing, hooks: r.hooks };
        return { method: "eth_call", params: [{ to: RESERVES_LENS, data: "0x" + encodeReservesCall(cfg.v4PoolManager, p) }, "latest"] };
      });
      try {
        const res = await batchRpc(calls, rpcs);
        for (let j = 0; j < chunk.length; j++) {
          const parsed = parseReservesResult(res[j]);
          if (parsed) {
            db.prepare("UPDATE pools SET sqrtPriceX96=?, tick=?, liquidity=?, reserves0=?, reserves1=? WHERE id=?")
              .run(parsed.sqrtPriceX96, parsed.tick, parsed.liquidity, parsed.reserves0, parsed.reserves1, chunk[j].id);
          }
        }
      } catch (e) {
        console.warn("v4 backfill err", e.message);
      }
      await sleep(300);
    }
  }
}
async function pollLoop() {
  let latestMax = 0;
  try {
    for (const chain of Object.keys(CHAINS)) {
      const cfg = CHAINS[chain];
      const rpcs = cfg.rpcs;
      let ls = getLastScanned(chain);
      if (ls === 0) {
        const latest = await rpcCall("eth_blockNumber", [], rpcs);
        const latestN = Number(latest);
        ls = Math.max(0, latestN - 5000);
        setLastScanned(chain, ls);
      }
      const latest = await rpcCall("eth_blockNumber", [], rpcs);
      const latestN = Number(latest);
      if (latestN > latestMax) latestMax = latestN;
      if (latestN > ls) {
        const n = await processRange(chain, ls + 1, latestN);
        setLastScanned(chain, latestN);
        metaSet("last_block", String(latestN));
        if (n > 0) broadcast({ type: "snapshot", pools: getEnrichedPools(), newCount: n, chain });
      }
    }
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const del = db.prepare("DELETE FROM pools WHERE createdAt < ?").run(cutoff);
    if (del.changes > 0) broadcast({ type: "snapshot", pools: getEnrichedPools(), deleted: del.changes });
  } catch (e) {
    console.error("poll err", e.message);
  }
  broadcast({ type: "heartbeat", block: latestMax, time: Date.now() });
  setTimeout(pollLoop, 3000);
}


const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(STATIC_ROOT, urlPath);
  if (!path.resolve(filePath).startsWith(path.resolve(STATIC_ROOT))) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/pools")) {
      const u = new URL(req.url, "http://localhost");
      const chain = u.searchParams.get("chain");
      let pools = getEnrichedPools();
      if (chain && chain !== "all") pools = pools.filter((p) => (p.chain || "base") === chain);
      res.writeHead(200, { "content-type": "application/json", "user-agent": "curl/8.0" });
      res.end(JSON.stringify(pools));
      return;
    }
    if (req.url.startsWith("/api/stream")) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("data: " + JSON.stringify({ type: "snapshot", pools: getEnrichedPools() }) + "\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    serveStatic(req, res);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server listening on " + PORT);
  pollLoop();
});
