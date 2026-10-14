/**
 * Vercel Postgres store.
 *
 * Postgres differs from SQLite/D1 in two ways that matter here: bind
 * parameters are positional (`$1`, `$2`, ...) rather than `?`, and bind
 * count is far higher, though we still chunk to keep statement sizes sane.
 *
 * The `sql` client is injected rather than imported so this module stays
 * importable from the Worker bundle, where `@vercel/postgres` is absent.
 */

import { PG_PARAM_CHUNK } from "../core/config.js";

/** Rewrite a `?`-placeholder query into Postgres `$n` form. */
function toPgParams(text) {
  let i = 0;
  return text.replace(/\?/g, () => `$${++i}`);
}

/**
 * Run a unit of work in a transaction when the client supports one.
 *
 * `@vercel/postgres` exposes `sql.begin()`; Neon-style clients do not. Both
 * are supported — correctness does not depend on the transaction because every
 * write here is an idempotent upsert keyed on a primary key, and the scanner
 * refuses to advance its cursor if an insert comes up short.
 */
async function withTx(sql, fn) {
  if (typeof sql.begin === "function") {
    return sql.begin(async (tx) => fn(tx));
  }
  return fn(sql);
}

export async function createPostgresStore(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS tokens (
      address TEXT PRIMARY KEY,
      name TEXT,
      symbol TEXT,
      decimals INTEGER
    );
  `;
  await sql`
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
      blockNumber BIGINT,
      txHash TEXT,
      createdAt TEXT
    );
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_pools_created ON pools(createdAt);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pools_v4_state ON pools(protocol, chain, reserves0);`;

  const run = async (text, params) => {
    if (!params || params.length === 0) return sql.query(text.replace(/\?/g, ""));
    return sql.query(toPgParams(text), params);
  };

  return {
    kind: "postgres",

    async getMeta() {
      const rows = await sql`SELECT key, value FROM meta`;
      const out = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    },

    async setMeta(entries) {
      const pairs = Object.entries(entries);
      if (!pairs.length) return;
      await withTx(sql, async (tx) => {
        for (const [k, v] of pairs) {
          await tx`
            INSERT INTO meta(key,value) VALUES(${k}, ${String(v)})
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
          `;
        }
      });
    },

    async getTokens(addresses) {
      const out = new Map();
      for (let i = 0; i < addresses.length; i += PG_PARAM_CHUNK) {
        const chunk = addresses.slice(i, i + PG_PARAM_CHUNK);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = await run(
          `SELECT address,name,symbol,decimals FROM tokens WHERE address IN (${placeholders})`,
          chunk,
        );
        for (const r of rows) {
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
      await withTx(sql, async (tx) => {
        for (const t of tokens) {
          await tx`
            INSERT INTO tokens(address,name,symbol,decimals) VALUES(${t.address}, ${t.name}, ${t.symbol}, ${t.decimals})
            ON CONFLICT(address) DO UPDATE SET
              name=excluded.name, symbol=excluded.symbol, decimals=excluded.decimals
          `;
        }
      });
    },

    async filterExistingPoolIds(ids) {
      const found = new Set();
      for (let i = 0; i < ids.length; i += PG_PARAM_CHUNK) {
        const chunk = ids.slice(i, i + PG_PARAM_CHUNK);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = await run(`SELECT id FROM pools WHERE id IN (${placeholders})`, chunk);
        for (const r of rows) found.add(r.id);
      }
      return found;
    },

    async insertPools(rows) {
      if (!rows.length) return 0;
      // RETURNING gives the true written count. The scanner treats a short
      // write as a failure and refuses to advance its cursor, so this must
      // never over-report.
      let written = 0;
      await withTx(sql, async (tx) => {
        for (const p of rows) {
          const res = await tx`
            INSERT INTO pools(id,chain,protocol,token0,token1,fee,tickSpacing,hooks,sqrtPriceX96,tick,
              liquidity,reserves0,reserves1,blockNumber,txHash,createdAt)
            VALUES(${p.id}, ${p.chain}, ${p.protocol}, ${p.token0}, ${p.token1}, ${p.fee}, ${p.tickSpacing},
              ${p.hooks}, ${p.sqrtPriceX96}, ${p.tick}, ${p.liquidity}, ${p.reserves0}, ${p.reserves1},
              ${p.blockNumber}, ${p.txHash}, ${p.createdAt})
            ON CONFLICT(id) DO NOTHING
            RETURNING id
          `;
          written += Array.isArray(res) ? res.length : res?.rowCount ?? 0;
        }
      });
      return written;
    },

    async updatePoolState(updates) {
      if (!updates.length) return 0;
      await withTx(sql, async (tx) => {
        for (const u of updates) {
          await tx`
            UPDATE pools SET sqrtPriceX96=${u.sqrtPriceX96 ?? null}, tick=${u.tick ?? null},
              liquidity=${u.liquidity ?? null}, reserves0=${u.reserves0 ?? null}, reserves1=${u.reserves1 ?? null}
            WHERE id=${u.id}
          `;
        }
      });
      return updates.length;
    },

    async listPools() {
      return await sql`SELECT * FROM pools ORDER BY blockNumber DESC, id`;
    },

    async prunePools(cutoffIso) {
      const rows = await sql`DELETE FROM pools WHERE createdAt < ${cutoffIso} RETURNING id`;
      return rows.length;
    },

    async listPoolsNeedingState(chain, limit) {
      return await sql`
        SELECT id,chain,protocol,token0,token1,fee,tickSpacing,hooks
        FROM pools
        WHERE protocol='V4' AND chain=${chain} AND (reserves0 IS NULL OR liquidity IS NULL)
        LIMIT ${limit}
      `;
    },
  };
}