// test/mcp-stdio.test.mjs
//
// Drives the MemPeek MCP server over real stdio and asserts the m1 acceptance
// criterion: the model-context return is the constant-size ReadbackReceipt,
// while >=10 entries are retrievable from the SSE side-channel (dashboard).
//
// Run:  node test/mcp-stdio.test.mjs
//
// Spawns `node dist/index.js` (MCP stdio + dashboard in one process), speaks
// JSON-RPC line-by-line, and curls the dashboard's JSON API.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 7399; // avoid clashing with a real session on 7331
const child = spawn(
  process.execPath,
  ["dist/index.js", "--port", String(PORT), "--db", "test-mempeek.db", "--session", "m1-test"],
  { stdio: ["pipe", "pipe", "pipe"] },
);

let nextId = 1;
const pending = new Map();
const stderrBuf = [];
const rl = createInterface({ input: child.stdout });
child.stderr.on("data", (d) => stderrBuf.push(d.toString()));

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  // notifications have no id; responses have id matching a request
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

function send(req) {
  const id = req.id ?? nextId++;
  const frame = { ...req, id };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify(frame) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for id=${id} (${req.method})`));
      }
    }, 8000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log("  ✓", msg);
  } else {
    failures++;
    console.error("  ✗ FAIL:", msg);
  }
}

async function fetchJson(url) {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`dashboard never came up at ${url}`);
}

try {
  // 1. initialize
  const init = await send({
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mempeek-stdio-test", version: "0.0.1" },
    },
  });
  assert(init?.result?.serverInfo?.name === "mempeek", "initialize returns serverInfo.name=mempeek");
  notify("notifications/initialized", {});

  // 2. tools/list
  const list = await send({ jsonrpc: "2.0", method: "tools/list", params: {} });
  const names = (list?.result?.tools ?? []).map((t) => t.name);
  assert(names.includes("mempeek.write"), "tools/list advertises mempeek.write");
  assert(names.includes("mempeek.readback"), "tools/list advertises mempeek.readback");

  // 3. write 12 entries
  const SEED = [
    "deployment config: prod on us-east-1, 3x c6i.2xlarge behind an ALB",
    "DB: postgres 16, pool 20, 2 read replicas, pgbouncer transaction mode",
    "API keys in AWS Secrets Manager under /prod/api/*; rotate every 90 days",
    "auth service issues JWTs (RS256), 15-min access + 30-day refresh",
    "rate limit: 100 req/min per token, 1000 req/min per org",
    "embeddings index uses pgvector on the read replica, 1536-dim",
    "CI runs on GitHub Actions: lint+test on push, deploy on tag",
    "frontend is Next.js 14 on Vercel, ISR every 60s",
    "object storage: S3 prod-assets, CloudFront in front, TTL 1h",
    "logs ship to Loki via promtail, retention 30d hot 1y cold",
    "on-call rotation: 2 engineers weekly, PagerDuty 'platform-prod'",
    "billing pipeline is a nightly Airflow DAG, idempotent, retries 3x",
  ];
  for (let i = 0; i < SEED.length; i++) {
    const r = await send({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "mempeek.write", arguments: { content: SEED[i], in_context: i % 5 === 0 } },
    });
    const ack = JSON.parse(r?.result?.content?.[0]?.text ?? "{}");
    assert(ack.ok === true && ack.id, `mempeek.write #${i + 1} acks ok with id`);
  }

  // 4. readback — model receives ONLY the constant-size receipt
  const rb = await send({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "mempeek.readback", arguments: { query: "what do I know about the deployment config?", top_k: 5 } },
  });
  const text = rb?.result?.content?.[0]?.text ?? "";
  let receipt;
  try { receipt = JSON.parse(text); } catch { receipt = null; }
  assert(receipt != null, "readback returns parseable JSON");
  assert(
    receipt &&
      typeof receipt.found === "number" &&
      typeof receipt.displayed === "boolean" &&
      typeof receipt.token_saved === "number" &&
      typeof receipt.side_channel === "string",
    "readback return is the constant-size ReadbackReceipt {found, displayed, token_saved, side_channel}",
  );
  assert(receipt && receipt.found >= 1, `receipt.found >= 1 (got ${receipt?.found})`);
  assert(
    receipt && receipt.token_saved > 0,
    `receipt.token_saved > 0 (got ${receipt?.token_saved}) — full recall kept out of context`,
  );
  // The receipt text must NOT contain any recall content (zero-token contract).
  assert(!/postgres|Airflow|pgvector/.test(text), "receipt body leaks no recall content");

  // 5. >=10 entries retrievable from the SSE side-channel (dashboard JSON)
  const stats = await fetchJson(`http://127.0.0.1:${PORT}/api/stats`);
  assert(stats.entries >= 10, `dashboard side-channel has >=10 entries (got ${stats.entries})`);
  assert(stats.total > 0, `dashboard savings counter reflects the readback (total=${stats.total})`);

  const entries = await fetchJson(`http://127.0.0.1:${PORT}/api/entries`);
  assert(
    (entries.entries ?? []).length >= 10,
    `/api/entries returns >=10 entries from the side-channel (got ${entries.entries?.length})`,
  );

  console.log(failures === 0 ? "\nALL CHECKS PASSED — m1 acceptance criterion met over real stdio." : `\n${failures} CHECK(S) FAILED.`);
} catch (err) {
  failures++;
  console.error("\nFATAL:", err?.stack ?? err);
  if (stderrBuf.length) console.error("--- server stderr ---\n" + stderrBuf.join(""));
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
  // cleanup test db
  const fs = await import("node:fs");
  for (const f of ["test-mempeek.db", "test-mempeek.db-wal", "test-mempeek.db-shm"]) {
    try { fs.unlinkSync(f); } catch {}
  }
  process.exit(failures === 0 ? 0 : 1);
}
