/**
 * Cloudflare Worker entrypoint.
 *
 * Exposes two things:
 *   - `fetch`  — the read API (`/api/pools`, `/api/stream`, `/api/health`)
 *   - `scheduled` — one indexing pass, fired by a 1-minute cron
 *
 * The ingest and read paths are fully decoupled: the Worker holds no state
 * between invocations and no in-memory caches, because neither is guaranteed
 * to survive. All shared state lives in D1.
 *
 * Static assets are served by the platform's asset binding (see
 * `wrangler.toml`), so anything not matching an API route falls through to
 * the uploaded site files.
 */

import { createStore } from "../../lib/index.js";
import { routeRequest } from "../../lib/api.js";
import { runIngest } from "../../lib/core/scanner.js";
import { TUNING } from "../../lib/core/config.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      // Let the static asset pipeline handle it.
      return env.ASSETS.fetch(request);
    }

    try {
      const store = await createStore({ d1: env.DB });
      return await routeRequest(store, request);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } },
      );
    }
  },

  /**
   * One indexing pass. Resumable: if an invocation dies partway, the next
   * cron simply continues from the last persisted cursor.
   */
  async scheduled(event, env, ctx) {
    try {
      const store = await createStore({ d1: env.DB });
      const summary = await runIngest({ store, tuning: TUNING });

      // Non-blocking metric; useful in the dashboard without a log scrape.
      ctx.waitUntil?.(logOutcome(summary));

      console.log(
        `[ingest] head=${summary.head} inserted=${summary.inserted} ` +
          `pruned=${summary.pruned} repaired=${summary.repaired} in ${summary.durationMs}ms`,
      );
    } catch (err) {
      console.error(`[ingest] failed: ${err.message}`);
      throw err;
    }
  },
};

async function logOutcome(summary) {
  try {
    const detail = Object.entries(summary.chains)
      .map(([chain, s]) => `${chain}:${s.error ? `err(${s.error})` : `+${s.inserted}@${s.cursor}`}`)
      .join(" ");
    console.log(`[ingest] ${detail}`);
  } catch {
    /* metrics must never fail the run */
  }
}