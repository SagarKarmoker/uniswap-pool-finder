/**
 * HTTP layer shared by every deployment target.
 *
 * Handlers are written against the Web `Request`/`Response` types, which
 * Cloudflare Workers and Vercel Edge/Node runtimes both provide natively and
 * which `server.js` can bridge to `node:http` with a thin adapter.
 *
 * ## Why SSE polls instead of broadcasting
 *
 * The original always-on server kept an in-memory `Set` of open responses and
 * pushed to them the instant the indexer found something. That cannot survive
 * a serverless runtime: an edge Worker has no shared process memory between
 * invocations, so no two connections can see each other's broadcast set.
 *
 * Instead each stream re-reads the store on a timer and emits only when the
 * snapshot fingerprint changes. That is a few cheap indexed reads per
 * connection, it behaves identically on every platform, and idle connections
 * send nothing. `TUNING.streamPollMs` sets the cadence.
 */

import { TUNING } from "./core/config.js";
import { buildPools, filterPools, fingerprint, capPools } from "./core/snapshot.js";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

/** Permissive CORS — the data is public on-chain state. */
export function withCors(headers = {}) {
  return {
    ...headers,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

/**
 * Load pools joined with token metadata, filtered and capped.
 * Shared by the REST and SSE paths so both always agree.
 */
export async function loadPools(store, { chain, protocol } = {}) {
  const rows = await store.listPools();
  // Token metadata is only needed for addresses we actually return.
  const wanted = new Set();
  for (const r of rows) {
    wanted.add(String(r.token0).toLowerCase());
    wanted.add(String(r.token1).toLowerCase());
  }
  const tokenMap = await store.getTokens([...wanted]);
  const pools = buildPools(rows, tokenMap);
  return capPools(filterPools(pools, { chain, protocol }));
}

/** `GET /api/pools` */
export async function handlePools(store, url) {
  const chain = url.searchParams.get("chain") ?? "all";
  const protocol = url.searchParams.get("protocol") ?? "both";
  const pools = await loadPools(store, { chain, protocol });
  return new Response(JSON.stringify(pools), {
    headers: withCors({ ...jsonHeaders, "user-agent": "pool-explorer" }),
  });
}

/** `GET /api/health` */
export async function handleHealth(store) {
  let pools = 0;
  let error = null;
  try {
    pools = (await store.listPools()).length;
  } catch (err) {
    error = err.message;
  }
  const meta = error ? {} : await store.getMeta();
  return new Response(
    JSON.stringify({
      ok: !error,
      adapter: store.kind,
      pools,
      head: meta.last_head ? Number(meta.last_head) : null,
      cursors: Object.fromEntries(
        Object.entries(meta).filter(([k]) => k.startsWith("last_scanned_to:")),
      ),
      error,
      time: Date.now(),
    }),
    { headers: withCors(jsonHeaders) },
  );
}

/**
 * `GET /api/stream` — Server-Sent Events.
 *
 * Sends a snapshot immediately on connect, then re-polls and emits only on
 * change, closing after `streamMaxDurationMs` so that no connection is ever
 * held indefinitely. Clients (`EventSource`) reconnect automatically and get
 * a fresh snapshot on the next connection, so the close is invisible to users.
 */
export function handleStream(store, url, { signal } = {}) {
  const chain = url.searchParams.get("chain") ?? "all";
  const protocol = url.searchParams.get("protocol") ?? "both";
  const maxDuration = TUNING.streamMaxDurationMs;
  const pollMs = TUNING.streamPollMs;

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const cleanup = () => {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const onAbort = () => cleanup();
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      try {
        const first = await loadPools(store, { chain, protocol });
        send({ type: "snapshot", pools: first });
        let lastPrint = fingerprint(first);

        const deadline = Date.now() + maxDuration;
        while (!closed && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, pollMs));
          if (closed) break;
          try {
            const pools = await loadPools(store, { chain, protocol });
            const print = fingerprint(pools);
            if (print !== lastPrint) {
              lastPrint = print;
              send({ type: "snapshot", pools });
            }
          } catch (err) {
            send({ type: "error", message: err.message });
          }
        }

        // Ask the client to reconnect so the stream is reaped predictably
        // rather than lingering until the runtime kills it.
        send({ type: "reconnect", time: Date.now() });
      } catch (err) {
        send({ type: "error", message: err.message });
      } finally {
        if (signal) signal.removeEventListener("abort", onAbort);
        cleanup();
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: withCors({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    }),
  });
}

/** `OPTIONS *` preflight. */
export function handlePreflight() {
  return new Response(null, { status: 204, headers: withCors() });
}

/**
 * Route an incoming request. Used by the Worker and by `server.js`.
 */
export async function routeRequest(store, request) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (request.method === "OPTIONS") return handlePreflight();

  switch (pathname) {
    case "/api/pools":
      return handlePools(store, url);
    case "/api/stream":
      return handleStream(store, url, { signal: request.signal });
    case "/api/health":
      return handleHealth(store);
    default:
      return new Response("Not found", { status: 404 });
  }
}