#!/usr/bin/env node
// examples/demo-session.mjs
//
// m3 demo session: simulates a 200-turn agent workload against a temporary
// SQLite store — one memory write per turn, one readback every `--every`
// turns — and renders the before/after context-budget comparison:
//
//   injection baseline : what an injection-based memory tool would have put
//                        into the context (full recall text, every readback)
//   side-channel       : what MemPeek puts into the context (constant-size
//                        receipts only; the full recall goes to the dashboard)
//
// Outputs (deterministic, no timestamps):
//   --out   JSON budget record (default docs/demo-budget.json)
//   --graph SVG line chart of the two cumulative curves (default docs/budget-graph.svg)
//
// Usage:
//   node examples/demo-session.mjs [--turns 200] [--every 8] [--top-k 5]
//                                  [--out docs/demo-budget.json]
//                                  [--graph docs/budget-graph.svg]
//
// No servers are started; token counts are heuristic estimates (estimateTokens).

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MemoryStore } from '../dist/memory-store.js';
import { computeReceipt, estimateTokens, receiptToString } from '../dist/readback.js';

// ---- args ----

const args = process.argv.slice(2);
function argOf(flag, fallback) {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return fallback;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`demo-session: invalid value for ${flag}: ${args[i + 1]}\n`);
    process.exit(2);
  }
  return n;
}

const TURNS = argOf('--turns', 200);
const EVERY = argOf('--every', 8);
const TOP_K = argOf('--top-k', 5);
const OUT = argOf2('--out', 'docs/demo-budget.json');
const GRAPH = argOf2('--graph', 'docs/budget-graph.svg');

function argOf2(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
}

// ---- deterministic corpus ----

const TOPICS = [
  'deployment', 'database', 'auth', 'rate limiting', 'object storage',
  'observability', 'ci pipeline', 'frontend', 'billing', 'on-call',
  'feature flags', 'migrations',
];
const DECISIONS = [
  'runs on us-east-1 behind an ALB with 3x c6i.2xlarge',
  'uses postgres 16 with pool size 20 and two read replicas',
  'issues JWTs (RS256) with 15-min access and 30-day refresh tokens',
  'enforces 100 req/min per token at the gateway',
  'ships assets from S3 through CloudFront with a 1h TTL',
  'sends logs to Loki with 30d hot and 1y cold retention',
  'runs lint and tests on every push and deploys on tags',
  'is a Next.js 14 app on Vercel with 60s ISR',
  'runs a nightly idempotent Airflow DAG with 3 retries',
  'rotates two engineers weekly via PagerDuty',
  'is controlled through LaunchDarkly with a wired kill-switch',
  'is forward-only via golang-migrate and reviewed in #platform',
];

function memoryContent(turn) {
  const t = TOPICS[turn % TOPICS.length];
  const d = DECISIONS[turn % DECISIONS.length];
  return `${t} ${d}; decided at turn ${turn} (ref mp-${String(turn).padStart(3, '0')})`;
}

function queryFor(readbackIndex) {
  return `what do I know about the ${TOPICS[readbackIndex % TOPICS.length]} setup?`;
}

// ---- simulate ----

const SESSION = 'demo-session';
const folder = mkdtempSync(join(tmpdir(), 'mempeek-session-'));
const store = new MemoryStore(join(folder, 'session.db'), SESSION);

let injectionTotal = 0;
let sidechannelTotal = 0;
let savedTotal = 0;
const series = [];
let readbackIndex = 0;

try {
  for (let turn = 1; turn <= TURNS; turn++) {
    store.write({ content: memoryContent(turn), session_id: SESSION });

    if (turn % EVERY === 0) {
      const query = queryFor(readbackIndex);
      const { entries } = store.readback(query, { topK: TOP_K, sessionId: SESSION });
      const receipt = computeReceipt(entries, { displayed: true, sideChannel: 'local-dashboard' });

      // what an injection-based memory tool would have put into context
      const injection = entries.reduce((s, e) => s + estimateTokens(e.content), 0);
      // what MemPeek puts into context: the constant-size receipt only
      const sidechannel = estimateTokens(receiptToString(receipt));

      injectionTotal += injection;
      sidechannelTotal += sidechannel;
      savedTotal += receipt.token_saved;
      store.recordSavings(SESSION, receipt.found, receipt.token_saved);
      series.push({
        turn,
        injection_cum: injectionTotal,
        sidechannel_cum: sidechannelTotal,
      });
      readbackIndex++;
    }
  }
} finally {
  store.close();
  rmSync(folder, { recursive: true, force: true });
}

const readbacks = series.length;
const record = {
  turns: TURNS,
  readback_every: EVERY,
  top_k: TOP_K,
  readbacks,
  injection_total: injectionTotal,
  sidechannel_total: sidechannelTotal,
  saved_total: savedTotal,
  series,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(record, null, 2) + '\n');
mkdirSync(dirname(GRAPH), { recursive: true });
writeFileSync(GRAPH, renderSvg(record));

// ---- report ----

const pct = injectionTotal > 0 ? Math.round((1 - sidechannelTotal / injectionTotal) * 100) : 0;
console.log(`MemPeek demo session — ${TURNS} turns, ${readbacks} readbacks (every ${EVERY})`);
console.log('');
console.log('  Context-budget comparison (cumulative tokens into the model context):');
console.log(`    injection-based memory : ${String(injectionTotal).padStart(7)} tokens (full recall text on every readback)`);
console.log(`    MemPeek side-channel   : ${String(sidechannelTotal).padStart(7)} tokens (constant-size receipts only)`);
console.log(`    net context reduction  : ${pct}% (${injectionTotal} -> ${sidechannelTotal} tokens)`);
console.log(`    gross tokens avoided   : ${String(savedTotal).padStart(7)} tokens (receipt cost not subtracted, per token_saved)`);
console.log('');
console.log(`  Budget record: ${OUT}`);
console.log(`  Budget graph : ${GRAPH}`);

// ---- SVG chart (dependency-free) ----

function renderSvg(r) {
  const W = 960, H = 380;
  const L = 80, R = 30, T = 56, B = 52;
  const iw = W - L - R, ih = H - T - B;
  const maxY = Math.max(1, ...r.series.map((p) => p.injection_cum));
  const n = r.series.length;
  const x = (i) => (n > 1 ? L + (i / (n - 1)) * iw : L + iw / 2);
  const y = (v) => T + ih - (v / maxY) * ih;
  const line = (key) => r.series.map((p, i) => `${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const fmt = (v) => v.toLocaleString('en-US');
  const ticks = 5;
  let grid = '';
  for (let i = 0; i <= ticks; i++) {
    const v = Math.round((maxY / ticks) * i);
    const gy = y(v);
    grid += `  <line x1="${L}" y1="${gy.toFixed(1)}" x2="${W - R}" y2="${gy.toFixed(1)}" stroke="#3a3a42" stroke-width="1"/>`
      + `  <text x="${L - 10}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-family="monospace" font-size="12" fill="#8e8e96">${fmt(v)}</text>\n`;
  }
  const xTicks = 4;
  let xlabels = '';
  for (let i = 0; i <= xTicks; i++) {
    const idx = Math.round(((n - 1) / xTicks) * i);
    xlabels += `  <text x="${x(idx).toFixed(1)}" y="${H - B + 22}" text-anchor="middle" font-family="monospace" font-size="12" fill="#8e8e96">turn ${r.series[idx].turn}</text>\n`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative context tokens over ${r.turns} turns: injection baseline versus MemPeek side-channel">
  <rect width="${W}" height="${H}" fill="#16161a"/>
  <text x="${L}" y="28" font-family="monospace" font-size="15" fill="#e8e8ed">Context budget over ${r.turns} turns — injection vs side-channel</text>
${grid}${xlabels}
  <polyline points="${line('injection_cum')}" fill="none" stroke="#e5484d" stroke-width="2.5"/>
  <polyline points="${line('sidechannel_cum')}" fill="none" stroke="#2dc79a" stroke-width="2.5"/>
  <line x1="${L}" y1="${T + ih}" x2="${W - R}" y2="${T + ih}" stroke="#8e8e96" stroke-width="1.5"/>
  <line x1="${L}" y1="${T}" x2="${L}" y2="${T + ih}" stroke="#8e8e96" stroke-width="1.5"/>
  <rect x="${L}" y="${T - 34}" width="14" height="4" fill="#e5484d"/>
  <text x="${L + 22}" y="${T - 29}" font-family="monospace" font-size="12" fill="#e8e8ed">injection: ${fmt(r.injection_total)} tokens</text>
  <rect x="${L + 220}" y="${T - 34}" width="14" height="4" fill="#2dc79a"/>
  <text x="${L + 242}" y="${T - 29}" font-family="monospace" font-size="12" fill="#e8e8ed">side-channel: ${fmt(r.sidechannel_total)} tokens</text>
</svg>
`;
}
