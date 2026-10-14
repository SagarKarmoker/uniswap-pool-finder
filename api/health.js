/**
 * `GET /api/health` — liveness plus indexer cursors.
 *
 * The cursor fields are the fastest way to tell whether ingest is actually
 * advancing on a given deployment; if `cursors` stops advancing, the cron is
 * not firing (the most common cause on Hobby, where crons run daily).
 */

import { getStore, fail } from "./_store.js";
import { handleHealth } from "../lib/api.js";

export const config = { path: "/api/health" };

export async function GET(request) {
  try {
    const store = await getStore();
    return await handleHealth(store);
  } catch (err) {
    console.error(`[health] ${err.message}`);
    return fail(err);
  }
}