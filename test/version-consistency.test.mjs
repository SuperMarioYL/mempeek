// test/version-consistency.test.mjs
//
// Version lockstep test: every version surface must report the same version.
//   1. VERSION file
//   2. package.json version
//   3. package-lock.json root version
//   4. CLI --version output
//   5. MCP initialize serverInfo.version (driven over stdio)
//   6. web/site.json meta.content_version
// plus CHANGELOG.md must carry both the [0.1.0] and [0.2.0] sections.
//
// Run: node test/version-consistency.test.mjs   (requires `npm run build` first)

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist", "index.js");
const TMP = mkdtempSync(join(tmpdir(), "mempeek-version-test-"));

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log("  ✓", msg);
  } else {
    failures++;
    console.error("  ✗ FAIL:", msg);
  }
}

const versionFile = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
const site = JSON.parse(readFileSync(join(ROOT, "web", "site.json"), "utf8"));

const r = spawnSync(process.execPath, [DIST, "--version"], { encoding: "utf8", timeout: 15000 });
const cliVersion = (r.stdout || "").trim().replace(/^mempeek\s+/, "");

// Drive the MCP server over stdio for serverInfo.version.
const child = spawn(process.execPath, [DIST, "--mcp-only", "--db", join(TMP, "v.db")], {
  stdio: ["pipe", "pipe", "ignore"],
});
let serverInfoVersion = null;
const rl = createInterface({ input: child.stdout });
const initialized = new Promise((resolve) => {
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1 && msg.result?.serverInfo) {
        serverInfoVersion = msg.result.serverInfo.version;
        resolve();
      }
    } catch { /* not json */ }
  });
});
child.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "version-test", version: "0.0.0" },
    },
  }) + "\n",
);
await Promise.race([initialized, new Promise((res) => setTimeout(res, 8000))]);
child.kill("SIGTERM");
rmSync(TMP, { recursive: true, force: true });

const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

assert(versionFile === "0.2.0", `VERSION file is 0.2.0 (got ${versionFile})`);
assert(pkg.version === versionFile, `package.json version matches VERSION file (${pkg.version} == ${versionFile})`);
assert(lock.version === versionFile, `package-lock.json root version matches (${lock.version} == ${versionFile})`);
assert(lock.packages?.[""]?.version === versionFile, `package-lock.json packages[""] version matches (${lock.packages?.[""]?.version})`);
assert(r.status === 0 && cliVersion === versionFile, `CLI --version reports ${versionFile} (got "${cliVersion}", exit ${r.status})`);
assert(serverInfoVersion === versionFile, `MCP serverInfo.version reports ${versionFile} (got ${serverInfoVersion})`);
assert(site.meta?.content_version === versionFile, `web/site.json meta.content_version is ${versionFile} (got ${site.meta?.content_version})`);
assert(changelog.includes("## [0.1.0]"), "CHANGELOG.md has a [0.1.0] section");
assert(changelog.includes("## [0.2.0]"), "CHANGELOG.md has a [0.2.0] section");

console.log(failures === 0 ? "\nALL VERSION-CONSISTENCY CHECKS PASSED." : `\n${failures} VERSION-CONSISTENCY CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
