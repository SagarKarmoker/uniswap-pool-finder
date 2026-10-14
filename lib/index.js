/**
 * Public surface of the portable core.
 *
 * Deployment entrypoints (`server.js`, `workers/src/index.js`, `api/*.js`)
 * import from here so that none of them need to know which storage adapter
 * they are wired to.
 */

export * from "./core/config.js";
export * from "./core/abi.js";
export * from "./core/rpc.js";
export * from "./core/scanner.js";
export * from "./core/snapshot.js";
export { runIngest, processRange, fetchTokenMetadata, backfillV4State } from "./core/scanner.js";
export { routeRequest, handlePools, handleStream, handleHealth, loadPools } from "./api.js";

import { createSqliteStore } from "./adapters/sqlite.js";
import { createD1Store } from "./adapters/d1.js";
import { createPostgresStore } from "./adapters/postgres.js";

/**
 * Build a store from a runtime's environment.
 *
 * Exactly one backend variable must be present:
 *   - `D1` binding            → Cloudflare D1
 *   - `POSTGRES_URL`          → Vercel Postgres / Neon
 *   - `SQLITE_PATH`/`node:sqlite` handle → self-hosted
 *
 * @param {Object} opts
 * @param {any} [opts.d1]
 * @param {any} [opts.sql]
 * @param {any} [opts.db]
 */
export async function createStore({ d1, sql, db } = {}) {
  if (d1) return createD1Store(d1);
  if (sql) return createPostgresStore(sql);
  if (db) return createSqliteStore(db);
  throw new Error(
    "createStore: no backend configured. Provide a D1 binding, a Vercel Postgres `sql` client, or a node:sqlite DatabaseSync handle.",
  );
}

export { createSqliteStore, createD1Store, createPostgresStore };