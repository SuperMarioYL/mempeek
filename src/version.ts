// src/version.ts
//
// Single runtime source for the MemPeek version. Walks up from this module to
// the nearest package.json (mirroring findProjectRoot in dashboard/server.ts)
// and reads its `version` field, so the CLI --version flag, the HELP banner,
// and the MCP serverInfo all report the packaged version and cannot drift.
// test/version-consistency.test.mjs asserts they match the root VERSION file.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          version?: string;
        };
        if (typeof pkg.version === "string" && pkg.version) return pkg.version;
      } catch {
        // unreadable package.json — try the next candidate dir
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0-unknown";
}

export const MEMPEEK_VERSION = readVersion();
