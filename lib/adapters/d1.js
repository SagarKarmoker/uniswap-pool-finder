/**
 * Cloudflare D1 store.
 *
 * D1 is SQLite-compatible, so the schema is shared with the node:sqlite
 * adapter, but three platform limits shape this implementation:
 *
 *   - **50 queries per invocation on the Free plan** (1000 on Paid). Every
 *     lookup here is batched or run through `db.batch()`.
 *   - **100 bound parameters per query**, so `IN (...)` lists are chunked.
 *   - **Single-threaded per database.** Writes are serialised by the platform
 *     automatically, so no application-level locking is needed.
 */

import { SQL_PARAM_CHUNK } from "../core/config.js";

export async function createD1Store(d1) {
  await d1.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  await d1.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      address TEXT PRIMARY KEY,
      name TEXT,
      symbol TEXT,
      decimals INTEGER
    );
  `);
  await d1.exec(`
    CREATE TABLE IF NOT EXISTS pools (
      id TEXT PRIMARY KEY,
      chain TEXT NOT NULL DEFAULT 'base',
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
  await d1.exec(`CREATE INDEX IF NOT EXISTS idx_pools_created ON pools(createdAt);`);
  await d1.exec(`CREATE INDEX IF NOT EXISTS idx_pools_v4_state ON pools(protocol, chain, reserves0);`);

  return {
    kind: "d1",

    async getMeta() {
      const { results } = await d1.prepare("SELECT key, value FROM meta").all();
      const out = {};
      for (const r of results) out[r.key] = r.value;
      return out;
    },

    async setMeta(entries) {
      const pairs = Object.entries(entries);
      if (!pairs.length) return;
      const stmts = pairs.map(([k, v]) =>
        d1
          .prepare(
            "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .bind(k, String(v)),
      );
      // One round trip instead of N.
      await d1.batch(stmts);
    },

    async getTokens(addresses) {
      const out = new Map();
      for (let i = 0; i < addresses.length; i += SQL_PARAM_CHUNK) {
        const chunk = addresses.slice(i, i + SQL_PARAM_CHUNK);
        const placeholders = chunk.map(() => "?").join(",");
        const { results } = await d1
          .prepare(`SELECT address,name,symbol,decimals FROM tokens WHERE address IN (${placeholders})`)
          .bind(...chunk)
          .all();
        for (const r of results) {
          out.set(String(r.address).toLowerCase(), {
            address: String(r.address).toLowerCase(),
            name: r.name,
            symbol: r.symbol,
            decimals: r.decimals,
          });
        }
      }
      return out;
    },

    async upsertTokens(tokens) {
      if (!tokens.length) return;
      const stmts = tokens.map((t) =>
        d1
          .prepare(
            `INSERT INTO tokens(address,name,symbol,decimals) VALUES(?,?,?,?)
             ON CONFLICT(address) DO UPDATE SET name=excluded.name, symbol=excluded.symbol, decimals=excluded.decimals`,
          )
          .bind(t.address, t.name, t.symbol, t.decimals),
      );
      for (let i = 0; i < stmts.length; i += 50) {
        await d1.batch(stmts.slice(i, i + 50));
      }
    },

    async filterExistingPoolIds(ids) {
      const found = new Set();
      for (let i = 0; i < ids.length; i += SQL_PARAM_CHUNK) {
        const chunk = ids.slice(i, i + SQL_PARAM_CHUNK);
        const placeholders = chunk.map(() => "?").join(",");
        const { results } = await d1
          .prepare(`SELECT id FROM pools WHERE id IN (${placeholders})`)
          .bind(...chunk)
          .all();
        for (const r of results) found.add(r.id);
      }
      return found;
    },

    async insertPools(rows) {
      if (!rows.length) return 0;
      const stmts = rows.map((p) =>
        d1
          .prepare(
            `INSERT INTO pools(id,chain,protocol,token0,token1,fee,tickSpacing,hooks,sqrtPriceX96,tick,
              liquidity,reserves0,reserves1,blockNumber,txHash,createdAt)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO NOTHING`,
          )
          .bind(
            p.id, p.chain, p.protocol, p.token0, p.token1, p.fee, p.tickSpacing, p.hooks,
            p.sqrtPriceX96, p.tick, p.liquidity, p.reserves0, p.reserves1,
            p.blockNumber, p.txHash, p.createdAt,
          ),
      );
      // D1 caps batches at 100 statements per call.
      let written = 0;
      for (let i = 0; i < stmts.length; i += 100) {
        const res = await d1.batch(stmts.slice(i, i + 100));
        for (const r of res.results) written += r?.meta?.changes ?? 0;
      }
      return written;
    },

    async updatePoolState(updates) {
      if (!updates.length) return 0;
      const stmts = updates.map((u) =>
        d1
          .prepare(
            "UPDATE pools SET sqrtPriceX96=?, tick=?, liquidity=?, reserves0=?, reserves1=? WHERE id=?",
          )
          .bind(u.sqrtPriceX96 ?? null, u.tick ?? null, u.liquidity ?? null, u.reserves0 ?? null, u.reserves1 ?? null, u.id),
      );
      let written = 0;
      for (let i = 0; i < stmts.length; i += 100) {
        const res = await d1.batch(stmts.slice(i, i + 100));
        for (const r of res.results) written += r?.meta?.changes ?? 0;
      }
      return written;
    },

    async listPools() {
      const { results } = await d1
        .prepare("SELECT * FROM pools ORDER BY blockNumber DESC, id")
        .all();
      return results;
    },

    async prunePools(cutoffIso) {
      const res = await d1.prepare("DELETE FROM pools WHERE createdAt < ?").bind(cutoffIso).run();
      return res.meta?.changes ?? 0;
    },

    async listPoolsNeedingState(chain, limit) {
      const { results } = await d1
        .prepare(
          `SELECT id,chain,protocol,token0,token1,fee,tickSpacing,hooks
           FROM pools
           WHERE protocol='V4' AND chain=? AND (reserves0 IS NULL OR liquidity IS NULL)
           LIMIT ?`,
        )
        .bind(chain, limit)
        .all();
      return results;
    },
  };
}