/**
 * `node:sqlite` store — powers the self-hosted, always-on server.
 *
 * This is the reference implementation of the Store interface and the only
 * adapter that benefits from an in-process token cache, since the process
 * outlives individual requests.
 */

import { SQL_PARAM_CHUNK } from "../core/config.js";

export async function createSqliteStore(db) {
  ensureSchema(db);

  const tokenCache = new Map();
  const primed = new Map();

  function refreshCache() {
    if (primed.get("tokens")) return;
    for (const r of db.prepare("SELECT address,name,symbol,decimals FROM tokens").all()) {
      tokenCache.set(String(r.address).toLowerCase(), {
        address: String(r.address).toLowerCase(),
        name: r.name,
        symbol: r.symbol,
        decimals: r.decimals,
      });
    }
    primed.set("tokens", true);
  }

  const insertPoolStmt = db.prepare(
    `INSERT INTO pools(id,chain,protocol,token0,token1,fee,tickSpacing,hooks,sqrtPriceX96,tick,
      liquidity,reserves0,reserves1,blockNumber,txHash,createdAt)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO NOTHING`,
  );
  const updateStateStmt = db.prepare(
    "UPDATE pools SET sqrtPriceX96=?, tick=?, liquidity=?, reserves0=?, reserves1=? WHERE id=?",
  );
  const upsertTokenStmt = db.prepare(
    `INSERT INTO tokens(address,name,symbol,decimals) VALUES(?,?,?,?)
     ON CONFLICT(address) DO UPDATE SET name=excluded.name, symbol=excluded.symbol, decimals=excluded.decimals`,
  );

  return {
    kind: "sqlite",

    async getMeta() {
      const out = {};
      for (const r of db.prepare("SELECT key,value FROM meta").all()) out[r.key] = r.value;
      return out;
    },

    async setMeta(entries) {
      const stmt = db.prepare(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      );
      db.exec("BEGIN");
      try {
        for (const [k, v] of Object.entries(entries)) stmt.run(k, String(v));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    async getTokens(addresses) {
      refreshCache();
      const out = new Map();
      for (const a of addresses) {
        const key = String(a).toLowerCase();
        const hit = tokenCache.get(key);
        if (hit) out.set(key, hit);
      }
      return out;
    },

    async upsertTokens(tokens) {
      if (!tokens.length) return;
      db.exec("BEGIN");
      try {
        for (const t of tokens) {
          upsertTokenStmt.run(t.address, t.name, t.symbol, t.decimals);
          tokenCache.set(t.address, { ...t });
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    async filterExistingPoolIds(ids) {
      const found = new Set();
      for (let i = 0; i < ids.length; i += SQL_PARAM_CHUNK) {
        const chunk = ids.slice(i, i + SQL_PARAM_CHUNK);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = db.prepare(`SELECT id FROM pools WHERE id IN (${placeholders})`).all(...chunk);
        for (const r of rows) found.add(r.id);
      }
      return found;
    },

    async insertPools(rows) {
      if (!rows.length) return 0;
      // Must report rows *actually written*, not rows attempted: the scanner
      // relies on a short count to detect a partial insert and refuse to
      // advance its cursor. `ON CONFLICT DO NOTHING` makes those differ.
      let written = 0;
      db.exec("BEGIN");
      try {
        for (const p of rows) {
          written += insertPoolStmt.run(
            p.id, p.chain, p.protocol, p.token0, p.token1, p.fee, p.tickSpacing, p.hooks,
            p.sqrtPriceX96, p.tick, p.liquidity, p.reserves0, p.reserves1,
            p.blockNumber, p.txHash, p.createdAt,
          ).changes;
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return written;
    },

    async updatePoolState(updates) {
      if (!updates.length) return 0;
      db.exec("BEGIN");
      try {
        for (const u of updates) {
          updateStateStmt.run(
            u.sqrtPriceX96 ?? null, u.tick ?? null, u.liquidity ?? null,
            u.reserves0 ?? null, u.reserves1 ?? null, u.id,
          );
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return updates.length;
    },

    async listPools() {
      return db.prepare("SELECT * FROM pools ORDER BY blockNumber DESC, id").all();
    },

    async prunePools(cutoffIso) {
      return db.prepare("DELETE FROM pools WHERE createdAt < ?").run(cutoffIso).changes;
    },

    async listPoolsNeedingState(chain, limit) {
      return db
        .prepare(
          `SELECT id,chain,protocol,token0,token1,fee,tickSpacing,hooks
           FROM pools
           WHERE protocol='V4' AND chain=? AND (reserves0 IS NULL OR liquidity IS NULL)
           LIMIT ?`,
        )
        .all(chain, limit);
    },

    close() {
      db.close();
    },
  };
}

function ensureSchema(db) {
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
  // Migrate databases created before multi-chain support. Ignored if present.
  try {
    db.exec("ALTER TABLE pools ADD COLUMN chain TEXT DEFAULT 'base'");
  } catch {
    /* already migrated */
  }
}