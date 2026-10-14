// test/dashboard-client.test.mjs
//
// Regression test for the v0.3.0 dashboard client fix: relTime() in
// src/dashboard/app.js reassigned a `const` binding whenever an entry's
// timestamp was in the future relative to the browser clock (backward clock
// step between write and render, or a caller-supplied future ts), throwing
// `TypeError: Assignment to constant variable` out of the SSE render path and
// freezing every dashboard panel. The clamp now uses `let`.
//
// app.js is a browser script (it touches `document` at module scope), so the
// test extracts the relTime function from the shipped source text and executes
// just that function in node — it uses only Date/Math, no DOM.
//
// Run: node test/dashboard-client.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_JS = readFileSync(join(ROOT, "src", "dashboard", "app.js"), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log("  ✓", msg);
  } else {
    failures++;
    console.error("  ✗ FAIL:", msg);
  }
}

/** Extract the `function relTime(ts) {...}` source by brace counting. */
function extractRelTime(src) {
  const start = src.indexOf("function relTime(ts)");
  if (start === -1) return null;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

const relTimeSrc = extractRelTime(APP_JS);
assert(typeof relTimeSrc === "string" && relTimeSrc.length > 50, "relTime() found in src/dashboard/app.js");

if (relTimeSrc) {
  const relTime = new Function(`return (${relTimeSrc});`)();

  // The crash case: a future timestamp must clamp to 0, not throw.
  let futureResult = null;
  let threw = null;
  try {
    futureResult = relTime(Date.now() + 60_000);
  } catch (err) {
    threw = err;
  }
  assert(threw === null, `relTime(future ts) does not throw${threw ? ` (got ${threw.constructor.name}: ${threw.message})` : ""}`);
  assert(futureResult === "0s", `relTime(future ts) clamps to 0s (got ${JSON.stringify(futureResult)})`);

  // A large future offset (previously also a throw path once d < 0).
  let bigFuture = null;
  try {
    bigFuture = relTime(Date.now() + 24 * 3600 * 1000);
  } catch (err) {
    bigFuture = `THREW ${err.constructor.name}`;
  }
  assert(bigFuture === "0s", `relTime(now + 24h) clamps to 0s (got ${JSON.stringify(bigFuture)})`);

  // Past timestamps keep rendering exactly as before.
  assert(relTime(Date.now() - 5_000) === "5s", "relTime(5s ago) returns 5s");
  assert(relTime(Date.now() - 90_000) === "1m", "relTime(90s ago) returns 1m");
  assert(relTime(Date.now() - 2 * 3600 * 1000) === "2h", "relTime(2h ago) returns 2h");

  // Guard the fix itself: the clamp must be reassignable (let), not const.
  assert(
    /let d = Date\.now\(\) - ts;/.test(relTimeSrc),
    "relTime uses `let d` for the elapsed-time clamp (const reassignment was the crash)",
  );
}

console.log(failures === 0 ? "\nALL DASHBOARD-CLIENT CHECKS PASSED." : `\n${failures} DASHBOARD-CLIENT CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
