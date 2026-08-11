// src/dashboard/server.ts
//
// Local HTTP server at http://localhost:7331 serving the MemPeek recall
// dashboard. Built on Hono + Node's built-in `node:http` (no extra server
// dependency — stays within the 3 key_deps).
//
// Data surfaces:
//   (a) GET /api/entries      — full recall list (JSON)
//   (b) GET /api/in-context  — entries flagged in_context (JSON)
//   (c) GET /api/savings      — cumulative token-savings + sparkline series (JSON)
//   (+) GET /api/events       — SSE: live writes, recalls, savings, snapshots
//
// Dashboard HTML/JS are served from <project-root>/src/dashboard/ so the
// same path works in dev (tsx) and prod (node dist/) without a copy step.

import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { toLean, SSEBus, type SSEEvent } from "../readback.js";
import type { MemoryStore } from "../memory-store.js";

export interface DashboardDeps {
  store: MemoryStore;
  bus: SSEBus;
}

export interface DashboardOptions {
  port: number;
  host: string;
}

/** Walk up from this module's location to find the dir containing package.json. */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

const PROJECT_ROOT = findProjectRoot(
  dirname(fileURLToPath(import.meta.url)),
);
const ASSETS_DIR = join(PROJECT_ROOT, "src", "dashboard");

function assetPath(file: string): string {
  return resolvePath(ASSETS_DIR, file);
}

/** Fail fast at boot if a required asset is missing. */
function assertAssets(): void {
  for (const f of ["index.html", "app.js"]) {
    if (!existsSync(assetPath(f))) {
      throw new Error(`dashboard asset missing: ${assetPath(f)}`);
    }
  }
}

export function createDashboardApp(deps: DashboardDeps): Hono {
  const { store } = deps;
  const app = new Hono();

  app.get("/api/entries", (c) => {
    const sessionId = c.req.query("session_id");
    return c.json({ entries: store.list(sessionId).map(toLean) });
  });

  app.get("/api/in-context", (c) => {
    const sessionId = c.req.query("session_id");
    return c.json({ entries: store.inContext(sessionId).map(toLean) });
  });

  app.get("/api/savings", (c) => {
    const sessionId = c.req.query("session_id");
    return c.json(store.savings(sessionId));
  });

  app.get("/api/stats", (c) => {
    const sessionId = c.req.query("session_id");
    return c.json({
      entries: store.count(sessionId),
      in_context: store.inContext(sessionId).length,
      ...store.savings(sessionId),
    });
  });

  app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

  return app;
}

/** Build a web-standard Request from a Node IncomingMessage. */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const host = (req.headers.host as string | undefined) ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else headers.set(k, v);
  }
  const method = req.method ?? "GET";
  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    body = Buffer.concat(chunks);
  }
  // `BodyInit`/`RequestInit` aren't in TS's ES2023 lib; cast via the
  // global Request constructor (Buffer is a valid BodyInit at runtime).
  return new Request(url, { method, headers, body } as unknown as RequestInit);
}

/** Pipe a web-standard Response back into a Node ServerResponse. */
async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  // For SSE, flush headers immediately so streaming clients see them right away.
  if (res.getHeader("content-type") === "text/event-stream") {
    res.flushHeaders?.();
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

/** Raw SSE handler (bypasses Hono for long-lived streaming reliability). */
function handleSSE(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: DashboardDeps,
): void {
  const { store, bus } = deps;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();

  const send = (evt: SSEEvent) => {
    res.write(`event: ${evt.type}\n`);
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  // Backfill snapshot so a fresh tab immediately sees current state.
  const sv = store.savings();
  send({
    type: "snapshot",
    entries: store.list().map(toLean),
    inContext: store.inContext().map(toLean),
    savings: {
      total: sv.total,
      count: sv.count,
      series: sv.series.map((p) => ({ ts: p.ts, saved: p.saved })),
    },
    ts: Date.now(),
  });

  const unsubscribe = bus.subscribe((evt) => {
    try {
      send(evt);
    } catch {
      // dead socket
    }
  });

  const cleanup = () => {
    unsubscribe();
    try {
      res.end();
    } catch {
      // already ended
    }
  };
  res.on("close", cleanup);
}

export interface DashboardHandle {
  port: number;
  host: string;
  url: string;
  close: () => Promise<void>;
}

/** Start the dashboard HTTP server. Resolves with a handle once listening. */
export function startDashboard(
  deps: DashboardDeps,
  opts: DashboardOptions,
): Promise<DashboardHandle> {
  assertAssets();
  const app = createDashboardApp(deps);

  return new Promise((resolveP, rejectP) => {
    const server: Server = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const url = new URL(
            req.url ?? "/",
            `http://${(req.headers.host as string | undefined) ?? "localhost"}`,
          );
          // SSE is handled raw (long-lived stream).
          if (url.pathname === "/api/events") {
            return handleSSE(req, res, deps);
          }
          // Static assets.
          if (url.pathname === "/" || url.pathname === "/index.html") {
            const body = await readFile(assetPath("index.html"));
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(body);
            return;
          }
          if (url.pathname === "/app.js") {
            const body = await readFile(assetPath("app.js"));
            res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
            res.end(body);
            return;
          }
          // Everything else → Hono.
          const request = await toRequest(req);
          const response = await app.fetch(request);
          await sendResponse(res, response);
        } catch (err) {
          if (!res.headersSent) res.writeHead(500);
          res.end(err instanceof Error ? String(err.stack ?? err) : String(err));
        }
      },
    );

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        rejectP(new Error(`port ${opts.port} in use (EADDRINUSE)`));
      } else {
        rejectP(err);
      }
    });
    server.on("listening", () => {
      const url = `http://${opts.host}:${opts.port}`;
      resolveP({
        port: opts.port,
        host: opts.host,
        url,
        close: () =>
          new Promise<void>((res2) => server.close(() => res2())),
      });
    });
    server.listen(opts.port, opts.host);
  });
}

/** Read an asset at boot (used by callers that want eager validation). */
export function readAsset(file: string): string {
  const abs = assetPath(file);
  if (!existsSync(abs)) throw new Error(`dashboard asset missing: ${abs}`);
  return readFileSync(abs, "utf8");
}
