// test/dashboard-render.test.mjs
//
// Regression test for the v0.4.0 dashboard content fix: rowHtml rendered
// truncate(entry.content, 240) and nothing else exposed the remainder, so a
// memory longer than 240 characters was unreadable in the only human-facing
// surface (the model only receives a receipt). entryContentHtml now renders
// the complete escaped text in a collapsible element.
//
// app.js is a browser script (it touches `document` at module scope), so this
// test extracts the pure render helpers from the shipped source text and runs
// just those — they use no DOM.
//
// Run: node test/dashboard-render.test.mjs

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

/** Extract `function name(...) {...}` by brace counting. */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
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

const parts = ["escapeHtml", "truncate", "entryContentHtml"].map((n) => extractFn(APP_JS, n));
assert(parts.every((p) => typeof p === "string" && p.length > 20),
  "escapeHtml/truncate/entryContentHtml found in src/dashboard/app.js");

if (parts.every((p) => typeof p === "string")) {
  const { entryContentHtml } = new Function(`${parts.join("\n")}; return { entryContentHtml };`)();

  // A long memory must be fully present — preview plus complete text.
  const tail = "UNIQUE_TAIL_MARKER_0123456789";
  const long = "x".repeat(1196) + tail; // 1220 chars total
  const longHtml = entryContentHtml(long);
  assert(longHtml.includes(tail), "a 1220-char memory keeps its tail in the rendered row");
  assert(longHtml.includes(long), "the complete content is rendered (not only a prefix)");
  assert(longHtml.includes("<details"), "long memories render a collapsible full-text element");
  assert(longHtml.includes('data-zh') && longHtml.includes('data-en'), "the expander label is bilingual");
  assert(longHtml.includes("…"), "the collapsed preview still ends with an ellipsis");

  // Short memories keep the original single-div shape.
  const short = "deployment uses port 8080";
  const shortHtml = entryContentHtml(short);
  assert(!shortHtml.includes("<details"), "a short memory renders no expander");
  assert(shortHtml.includes(short) && shortHtml.includes('class="content"'),
    "a short memory renders inline");

  // Escaping applies to the complete text, not just the preview.
  const evil = `<script>alert("x")</script>` + "y".repeat(300);
  const evilHtml = entryContentHtml(evil);
  assert(!evilHtml.includes("<script>"), "the full text is HTML-escaped");
  assert(evilHtml.includes("&lt;script&gt;"), "escaped markup is still visible as text");
  assert(evilHtml.includes("&quot;"), "quotes are escaped in the full text");
}

console.log(failures === 0 ? "\nALL DASHBOARD-RENDER CHECKS PASSED." : `\n${failures} DASHBOARD-RENDER CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
