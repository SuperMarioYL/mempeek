// test/embedding-contract.test.mjs
//
// Regression test for the v0.4.0 embedding contract:
//   - a caller-supplied embedding must be a non-empty array of finite numbers;
//     v0.3.0 coerced with Number() and silently dropped the invalid elements,
//     changing the vector's dimension ([0.5,"abc",0.25] -> [0.5,0.25]);
//   - a query vector whose dimension differs from the stored vectors must be
//     reported, not ranked by a truncated dot product. v0.3.0 scored
//     min(len) elements, so a 2-dim query over 128-dim rows returned a
//     plausible-looking ranking built from an unnormalized prefix.
//
// Run: node test/embedding-contract.test.mjs   (requires `npm run build` first)

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { MemoryStore } from "../dist/memory-store.js";

const ROOT = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist", "index.js");
const TMP = mkdtempSync(join(tmpdir(), "mempeek-embed-test-"));

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log("  ✓", msg);
  } else {
    failures++;
    console.error("  ✗ FAIL:", msg);
  }
}

// ---- store-level: dimension mismatch must throw, nearest match must rank first ----
{
  const db = join(TMP, "store.db");
  const store = new MemoryStore(db, "s1");
  store.write({ content: "deployment config: prod runs on us-east-1 behind an ALB", session_id: "s1" });
  store.write({ content: "the auth service issues JWTs with a 15-min access token", session_id: "s1" });
  store.write({ content: "logs ship to Loki via promtail, retention 30d", session_id: "s1" });

  const nearest = store.readback("deployment config prod us-east-1", { topK: 1, sessionId: "s1" });
  assert(nearest.entries.length === 1, `fallback readback returns one entry (got ${nearest.entries.length})`);
  assert(
    /deployment/.test(nearest.entries[0]?.content ?? ""),
    `nearest entry ranks first (got ${JSON.stringify(nearest.entries[0]?.content?.slice(0, 40))})`,
  );

  let threw = null;
  try {
    store.readback("anything", { topK: 3, embedding: [1, 0, 0], sessionId: "s1" });
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, "3-dim query against 128-dim rows throws instead of ranking a prefix");
  assert(
    threw?.name === "EmbeddingDimensionError" && /128/.test(threw.message) && /3/.test(threw.message),
    `the error names both dimensions (got ${threw?.name}: ${threw?.message})`,
  );
  assert(store.list("s1").length === 3, "the failed readback wrote nothing");
  store.close();
}

// ---- MCP boundary over real stdio ----
const db = join(TMP, "mcp.db");
const child = spawn(
  process.execPath,
  [DIST, "--mcp-only", "--db", db, "--session", "s1"],
  { stdio: ["pipe", "pipe", "pipe"] },
);

let nextId = 1;
const pending = new Map();
const stderrBuf = [];
createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});
child.stderr.on("data", (d) => stderrBuf.push(d.toString()));

function send(req) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ ...req, id }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for id=${id} (${req.method})`));
      }
    }, 8000);
  });
}

function call(name, args) {
  return send({ jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args } });
}

try {
  await send({
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "embedding-contract-test", version: "0.0.1" },
    },
  });

  // 1. a vector with a non-numeric element is rejected, not shortened
  const bad = await call("mempeek.write", { content: "should not be stored", embedding: [0.5, "abc", 0.25] });
  const badText = bad?.result?.content?.[0]?.text ?? "";
  assert(bad?.result?.isError === true, "write with embedding [0.5,'abc',0.25] is an error");
  assert(/embedding/.test(badText) && /finite/.test(badText), `error names the offending embedding (got ${JSON.stringify(badText)})`);

  // 2. an empty vector is rejected (v0.3.0 treated [] as a provided embedding)
  const empty = await call("mempeek.write", { content: "should not be stored either", embedding: [] });
  const emptyText = empty?.result?.content?.[0]?.text ?? "";
  assert(empty?.result?.isError === true, "write with embedding [] is an error");
  assert(/empty/.test(emptyText), `error says the embedding is empty (got ${JSON.stringify(emptyText)})`);

  // 3. three valid fallback writes
  for (const text of [
    "deployment config: prod runs on us-east-1 behind an ALB",
    "the auth service issues JWTs with a 15-min access token",
    "logs ship to Loki via promtail, retention 30d",
  ]) {
    const r = await call("mempeek.write", { content: text });
    const ack = JSON.parse(r?.result?.content?.[0]?.text ?? "{}");
    assert(ack.ok === true && ack.embedding_source === "fallback", `fallback write acks ok (${JSON.stringify(ack.embedding_source)})`);
  }

  // 4. rejected writes never reached the store
  const probe = await call("mempeek.readback", { query: "deployment config" });
  const probeReceipt = JSON.parse(probe?.result?.content?.[0]?.text ?? "{}");
  assert(probeReceipt.found === 3, `only the 3 valid writes are stored (found ${probeReceipt.found})`);

  // 5. a wrong-dimension query is an error that names both dimensions
  const mismatch = await call("mempeek.readback", { query: "deployment", embedding: [1, 0, 0] });
  const mmText = mismatch?.result?.content?.[0]?.text ?? "";
  assert(mismatch?.result?.isError === true, "readback with a 3-dim embedding against 128-dim rows is an error");
  assert(/dimension mismatch/.test(mmText) && /128/.test(mmText) && /3/.test(mmText),
    `mismatch error names both dimensions (got ${JSON.stringify(mmText)})`);

  // 6. a matching readback still returns the constant-size receipt
  assert(
    probeReceipt &&
      typeof probeReceipt.found === "number" &&
      typeof probeReceipt.displayed === "boolean" &&
      typeof probeReceipt.token_saved === "number" &&
      typeof probeReceipt.side_channel === "string",
    "a valid readback still returns the four-key receipt",
  );

  console.log(failures === 0 ? "\nALL EMBEDDING-CONTRACT CHECKS PASSED." : `\n${failures} EMBEDDING-CONTRACT CHECK(S) FAILED.`);
} catch (err) {
  failures++;
  console.error("\nFATAL:", err?.stack ?? err);
  if (stderrBuf.length) console.error("--- server stderr ---\n" + stderrBuf.join(""));
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { child.kill("SIGKILL"); setTimeout(resolve, 250); }, 2000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  await sleep(50);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}
