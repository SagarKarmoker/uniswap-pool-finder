/**
 * `GET /api/stream` — Server-Sent Events.
 *
 * Vercel caps function duration (300s Hobby, up to 800s Pro with Fluid
 * compute), so the stream closes itself at TUNING.streamMaxDurationMs and the
 * browser's EventSource reconnects. Each reconnect replays a full snapshot,
 * so the gap is invisible.
 */

import { getStore, fail } from "./_store.js";
import { handleStream } from "../lib/api.js";
import { TUNING } from "../lib/core/config.js";

export const config = { path: "/api/stream" };

// Must sit above the stream's own self-imposed close window.
export const maxDuration = Math.ceil((TUNING.streamMaxDurationMs + 30000) / 1000);

export async function GET(request) {
  try {
    const store = await getStore();
    return handleStream(store, new URL(request.url), { signal: request.signal });
  } catch (err) {
    console.error(`[stream] ${err.message}`);
    return fail(err);
  }
}