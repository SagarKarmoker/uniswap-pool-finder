/**
 * `GET /api/pools` — read API.
 */

import { getStore, fail } from "./_store.js";
import { handlePools } from "../lib/api.js";

export const config = { path: "/api/pools" };

export async function GET(request) {
  try {
    const store = await getStore();
    return await handlePools(store, new URL(request.url));
  } catch (err) {
    console.error(`[pools] ${err.message}`);
    return fail(err);
  }
}