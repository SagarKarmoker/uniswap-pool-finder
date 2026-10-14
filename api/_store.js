/**
 * Lazily construct the Postgres-backed store.
 *
 * Both `@vercel/postgres` and `@neondatabase/serverless` are supported because
 * Vercel's Postgres offering has been transitioning to Neon; whichever is
 * installed wins. Resolution happens per cold start rather than at module
 * load so a missing optional dependency surfaces as a clear 500 instead of a
 * build failure.
 */
let cached = null;

export async function getStore() {
  if (cached) return cached;

  const url = process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL;
  if (!url) {
    throw new Error(
      "No POSTGRES_URL set. Provision a Vercel Postgres (or Neon) database and link it to this project.",
    );
  }

  let client;
  try {
    const vercelPg = await import("@vercel/postgres");
    client = vercelPg.sql;
  } catch {
    const neon = await import("@neondatabase/serverless");
    client = neon.neon(url);
  }

  const { createStore } = await import("../lib/index.js");
  cached = await createStore({ sql: client });
  return cached;
}

/** Standard error envelope for function routes. */
export function fail(err, status = 500) {
  return new Response(JSON.stringify({ error: err.message }), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}