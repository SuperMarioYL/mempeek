// test/demo-session.test.mjs
//
// Smoke test for examples/demo-session.mjs (the m3 200-turn demo session):
//   - a short run (--turns 40) exits 0 and produces a well-formed budget
//     record + SVG graph at the requested paths
//   - the committed docs/demo-budget.json records the full 200-turn run
//     and docs/budget-graph.svg exists
//
// Run: node test/demo-session.test.mjs   (requires `npm run build` first)

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";

const ROOT = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "examples", "demo-session.mjs");

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log("  ✓", msg);
  } else {
    failures++;
    console.error("  ✗ FAIL:", msg);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "mempeek-session-test-"));
try {
  const out = join(tmp, "budget.json");
  const graph = join(tmp, "graph.svg");
  const r = spawnSync(process.execPath, [SCRIPT, "--turns", "40", "--every", "8", "--out", out, "--graph", graph], {
    encoding: "utf8",
    timeout: 60000,
  });
  assert(r.status === 0, `demo-session --turns 40 exits 0 (got ${r.status}; stderr: ${r.stderr?.slice(0, 200)})`);

  const record = JSON.parse(readFileSync(out, "utf8"));
  assert(record.turns === 40, `budget record has turns=40 (got ${record.turns})`);
  assert(record.readbacks === 5, `budget record has 5 readbacks (got ${record.readbacks})`);
  assert(
    record.injection_total > record.sidechannel_total && record.sidechannel_total > 0,
    `injection_total > sidechannel_total > 0 (${record.injection_total} > ${record.sidechannel_total} > 0)`,
  );
  assert(
    Array.isArray(record.series) && record.series.length === 5,
    `series has one point per readback (got ${record.series?.length})`,
  );
  assert(
    record.series.every((p) => p.injection_cum >= p.sidechannel_cum && p.sidechannel_cum > 0),
    "every series point shows the side-channel cheaper than injection",
  );

  const svg = readFileSync(graph, "utf8");
  assert(svg.includes("<svg"), "graph file is an SVG document");

  // committed artifacts reflect the full 200-turn run
  const committed = JSON.parse(readFileSync(join(ROOT, "docs", "demo-budget.json"), "utf8"));
  assert(committed.turns === 200, `committed docs/demo-budget.json records turns=200 (got ${committed.turns})`);
  assert(existsSync(join(ROOT, "docs", "budget-graph.svg")), "committed docs/budget-graph.svg exists");

  console.log(failures === 0 ? "\nALL DEMO-SESSION CHECKS PASSED." : `\n${failures} DEMO-SESSION CHECK(S) FAILED.`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
