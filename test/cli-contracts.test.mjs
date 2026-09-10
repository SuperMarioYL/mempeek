// test/cli-contracts.test.mjs
//
// CLI contract tests for the v0.2.0 fixes:
//   - invalid numeric flag values exit 2 with a clean message (no stack trace)
//   - --http-only + --mcp-only is rejected as a usage error
//   - --http-only exits non-zero when the dashboard cannot start (v0.1.0 hung
//     forever as a zombie serving nothing and exited 0 on SIGINT)
//   - --version prints the packaged version
//   - valid --demo invocations keep working (regression)
//
// Run: node test/cli-contracts.test.mjs   (requires `npm run build` first)

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";

const ROOT = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist", "index.js");

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log("  ✓", msg);
  } else {
    failures++;
    console.error("  ✗ FAIL:", msg);
  }
}

function run(args, extra = {}) {
  return spawnSync(process.execPath, [DIST, ...args], {
    encoding: "utf8",
    timeout: 15000,
    ...extra,
  });
}

const tmp = mkdtempSync(join(tmpdir(), "mempeek-cli-test-"));
try {
  // 1. invalid numeric flags -> exit 2, clean message, no stack trace
  for (const [flag, value] of [["--seed", "abc"], ["--port", "abc"], ["--port", "0"], ["--seed", "0"], ["--seed", "99"]]) {
    const r = run([flag, value, "--demo", "--db", join(tmp, "t.db")]);
    assert(r.status === 2, `${flag} ${value} exits 2 (got ${r.status})`);
    assert(
      r.stderr.includes(flag) && /invalid/i.test(r.stderr),
      `${flag} ${value} stderr names the flag and says invalid: ${JSON.stringify(r.stderr.trim())}`,
    );
    assert(!r.stderr.includes("    at "), `${flag} ${value} prints no stack trace`);
  }

  // 2. mutually exclusive modes -> exit 2
  {
    const r = run(["--http-only", "--mcp-only", "--db", join(tmp, "t.db")]);
    assert(r.status === 2, "--http-only --mcp-only exits 2 (got " + r.status + ")");
    assert(
      /mutually exclusive/.test(r.stderr),
      "--http-only --mcp-only stderr explains the conflict",
    );
  }

  // 3. --version prints the packaged version and exits 0
  {
    const r = run(["--version"]);
    assert(r.status === 0, "--version exits 0");
    assert(/^mempeek \d+\.\d+\.\d+\n$/.test(r.stdout), `--version prints "mempeek <semver>" (got ${JSON.stringify(r.stdout)})`);
  }

  // 4. --http-only with an occupied port must EXIT (v0.1.0 hung forever)
  {
    const blocker = createServer();
    const occupied = await new Promise((resolve) => blocker.listen(0, "127.0.0.1", () => resolve(blocker.address().port)));
    const child = spawn(process.execPath, [DIST, "--http-only", "--port", String(occupied), "--db", join(tmp, "t.db")], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    let exited = null;
    const exitCode = await Promise.race([
      new Promise((resolve) => child.on("exit", (c) => { exited = c; resolve(c); })),
      sleep(5000).then(() => { child.kill("SIGKILL"); return "TIMEOUT"; }),
    ]);
    assert(exitCode !== "TIMEOUT" && exitCode !== 0 && exitCode !== null,
      `--http-only on an occupied port exits non-zero instead of hanging (got ${exitCode})`);
    assert(/fatal|failed/i.test(stderr), `--http-only failure explains itself on stderr: ${JSON.stringify(stderr.trim())}`);
    blocker.close();
  }

  // 5. regression: valid demo invocations still work
  {
    const r = run(["--demo", "--seed", "3", "--db", join(tmp, "demo.db")]);
    assert(r.status === 0, `--demo --seed 3 still exits 0 (got ${r.status})`);
    assert(r.stdout.includes("seeded 3 entries"), "--demo --seed 3 seeds 3 entries");
  }
  {
    const r = run(["--demo", "--db", join(tmp, "demo2.db")]);
    assert(r.status === 0, `--demo with default seed still exits 0 (got ${r.status})`);
  }

  console.log(failures === 0 ? "\nALL CLI-CONTRACT CHECKS PASSED." : `\n${failures} CLI-CONTRACT CHECK(S) FAILED.`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
