/**
 * Cron handler — one indexing pass.
 *
 * Vercel invokes this on the schedule in `vercel.json`. When `CRON_SECRET` is
 * set Vercel sends `Authorization: Bearer $CRON_SECRET`; the check below is
 * skipped when it is not, so local testing stays possible.
 */

import { getStore, fail } from "./_store.js";
import { runIngest } from "../lib/core/scanner.js";
import { TUNING } from "../lib/core/config.js";

export const config = { path: "/api/cron" };

// A cold-start backfill drains over several runs, but give the first one room.
export const maxDuration = 300;

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
  }

  try {
    const store = await getStore();
    const summary = await runIngest({ store, tuning: TUNING });

    console.log(
      `[ingest] head=${summary.head} inserted=${summary.inserted} ` +
        `pruned=${summary.pruned} repaired=${summary.repaired} in ${summary.durationMs}ms`,
    );

    return new Response(JSON.stringify(summary), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error(`[cron] ${err.message}`);
    return fail(err);
  }
}