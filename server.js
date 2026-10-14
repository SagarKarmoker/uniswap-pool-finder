/**
 * Self-hosted, always-on entrypoint.
 *
 * This is the original deployment target and the only one with a genuinely
 * continuous ingest: `runIngest` is driven by a plain interval timer instead
 * of a cron, so data freshness stays at the full TUNING interval with no
 * platform ceiling.
 *
 * All indexing, decoding and HTTP logic lives in `lib/` and is shared with the
 * Cloudflare Worker and the Vercel Functions; this file only wires the store,
 * the timer and static file serving.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createStore } from "./lib/index.js";
import { routeRequest } from "./lib/api.js";
import { runIngest } from "./lib/core/scanner.js";
import { TUNING } from "./lib/core/config.js";

const STATIC_ROOT = process.env.STATIC_ROOT || process.cwd();
const DB_PATH = process.env.DB_PATH || path.join(STATIC_ROOT, "pools.db");
const PORT = Number(process.env.PORT || 3000);
/** Ingest cadence. `0` or `none` disables the timer (useful when an external
 *  scheduler pokes /api/cron instead). */
const POLL_INTERVAL_MS = process.env.POLL_INTERVAL_MS
  ? Number(process.env.POLL_INTERVAL_MS)
  : 3000;

const db = new DatabaseSync(DB_PATH);
const store = await createStore({ db });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** Files that must never be served as static assets. */
const BLOCKED = new Set(["pools.db", ".env", "package.json", "wrangler.toml", "vercel.json"]);

function serveStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";

  // Normalise before joining so `..` cannot escape STATIC_ROOT.
  const decoded = decodeURIComponent(urlPath);
  const filePath = path.join(STATIC_ROOT, decoded);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(STATIC_ROOT) + path.sep) && resolved !== path.resolve(path.join(STATIC_ROOT, "index.html"))) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Forbidden");
    return;
  }
  if (BLOCKED.has(path.basename(resolved))) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=300",
    });
    res.end(data);
  });
}

/**
 * Bridge the Web `Request`/`Response` used by `lib/api.js` onto node:http.
 *
 * SSE is streamed rather than buffered, so the response body is piped as it
 * arrives rather than awaited — otherwise every event would be held until the
 * stream self-closes.
 */
async function bridgeWebRequest(req, res) {
  const url = `http://${req.headers.host || "localhost"}${req.url}`;
  const ac = new AbortController();
  req.on("close", () => ac.abort());

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers[k] = v;
  }

  const webRequest = new Request(url, {
    method: req.method,
    headers,
    signal: ac.signal,
  });

  let webResponse;
  try {
    webResponse = await routeRequest(store, webRequest);
  } catch (err) {
    console.error(`[api] ${err.message}`);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
    return;
  }

  const outHeaders = {};
  webResponse.headers.forEach((value, key) => {
    outHeaders[key] = value;
  });
  res.writeHead(webResponse.status, outHeaders);

  if (!webResponse.body) {
    res.end();
    return;
  }

  const reader = webResponse.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((r) => res.once("drain", r));
      }
    }
  } catch {
    /* client disconnected mid-stream */
  } finally {
    reader.releaseLock?.();
    res.end();
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    bridgeWebRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Pool Explorer listening on :${PORT}`);
  console.log(`  static root : ${STATIC_ROOT}`);
  console.log(`  database    : ${DB_PATH}`);

  if (!POLL_INTERVAL_MS || POLL_INTERVAL_MS <= 0) {
    console.log("  ingest      : external scheduler (POLL_INTERVAL_MS disabled)");
    return;
  }

  console.log(`  ingest      : every ${POLL_INTERVAL_MS}ms`);
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const summary = await runIngest({ store, tuning: TUNING });
      if (summary.inserted > 0 || summary.pruned > 0) {
        console.log(
          `[ingest] head=${summary.head} +${summary.inserted} -${summary.pruned} ` +
            `repaired=${summary.repaired} in ${summary.durationMs}ms`,
        );
      }
    } catch (err) {
      console.error(`[ingest] ${err.message}`);
    }
    if (!stopped) setTimeout(tick, POLL_INTERVAL_MS);
  };

  tick();
  const shutdown = () => {
    stopped = true;
    server.close(() => {
      try {
        store.close?.();
        db.close();
      } catch {
        /* already closed */
      }
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
});