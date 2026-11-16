// test/store-contracts.test.mjs
//
// Regression test for the v0.4.0 upsert fix:
// MemoryStore.write() upserts by id but its ON CONFLICT branch used to omit
// session_id, so rewriting an existing id under another session returned the
// requested session in the ack while the row stayed in the old session —
// session-scoped readback then silently missed a memory the agent believed it
// had stored there.
//
// Run: node test/store-contracts.test.mjs   (requires `npm run build` first)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../dist/memory-store.js";

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log("  ✓", msg);
  } else {
    failures++;
    console.error("  ✗ FAIL:", msg);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "mempeek-store-test-"));
try {
  const store = new MemoryStore(join(tmp, "store.db"), "s1");

  const first = store.write({ id: "same-id", content: "first write in session s1", session_id: "s1" });
  assert(first.session_id === "s1", "first write lands in s1");

  const second = store.write({ id: "same-id", content: "second write moves to s2", session_id: "s2" });
  assert(second.session_id === "s2", `the returned entry reports the requested session (got ${second.session_id})`);

  const inS2 = store.list("s2");
  assert(inS2.length === 1 && inS2[0].id === "same-id", `list('s2') contains the rewritten row (got ${inS2.length})`);
  assert(store.list("s1").length === 0, `list('s1') is empty after the move (got ${store.list("s1").length})`);
  assert(store.count() === 1, `the upsert did not duplicate the row (count ${store.count()})`);

  const recalled = store.readback("second write moves", { topK: 5, sessionId: "s2" });
  assert(recalled.entries.length === 1 && recalled.entries[0].id === "same-id",
    `session-scoped readback in s2 finds it (got ${recalled.entries.length})`);

  // Content/ts/in_context still update, so the fix did not narrow the upsert.
  store.write({ id: "same-id", content: "third write updates content", session_id: "s2", in_context: true });
  const updated = store.list("s2")[0];
  assert(updated.content === "third write updates content" && updated.in_context === true,
    "upsert still refreshes content and in_context");

  store.close();
  console.log(failures === 0 ? "\nALL STORE-CONTRACT CHECKS PASSED." : `\n${failures} STORE-CONTRACT CHECK(S) FAILED.`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
