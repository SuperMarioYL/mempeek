#!/usr/bin/env node
// src/index.ts
//
// MemPeek — zero-token memory readback for AI agents.
//
// Modes:
//   mempeek                                  Default: MCP stdio server
//                                            + dashboard HTTP (localhost:7331).
//   mempeek --demo [--seed N]                Bounded demo: seeds N memories,
//                                            runs readbacks, prints the ZTMR
//                                            receipt-vs-full-recall contrast
//                                            + savings budget to stdout, exits 0.
//   mempeek --http-only                      Dashboard HTTP only (no MCP stdio).
//                                            Inspect a store / drive the UI.
//   mempeek --mcp-only                       MCP stdio only (no dashboard).
//
// Flags: --db <path>  --port <n>  --host <h>  --session <id>

import { MemoryStore } from "./memory-store.js";
import { SSEBus, computeReceipt, receiptToString, estimateTokens } from "./readback.js";
import { runStdioMcp } from "./mcp-server.js";
import { startDashboard } from "./dashboard/server.js";
import { MEMPEEK_VERSION } from "./version.js";

interface CliArgs {
  demo: boolean;
  httpOnly: boolean;
  mcpOnly: boolean;
  db: string;
  port: number;
  host: string;
  session: string;
  seed: number;
  help: boolean;
  version: boolean;
}

/** Print a clean usage error and exit 2 (never a raw stack trace). */
function usageError(message: string): never {
  process.stderr.write(`mempeek: ${message}\n`);
  process.exit(2);
}

/** Parse an integer CLI value; reject NaN / out-of-range with a clean error. */
function parseIntArg(flag: string, raw: string | undefined, min: number, max: number): number {
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n < min || n > max) {
    usageError(
      `invalid value for ${flag}: ${raw ?? "(missing)"} (expected an integer ${min}-${max})`,
    );
  }
  return n;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    demo: false,
    httpOnly: false,
    mcpOnly: false,
    db: "mempeek.db",
    port: 7331,
    host: "127.0.0.1",
    session: "default",
    seed: 14,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--demo": a.demo = true; break;
      case "--http-only": a.httpOnly = true; break;
      case "--mcp-only": a.mcpOnly = true; break;
      case "--help": case "-h": a.help = true; break;
      case "--version": case "-V": a.version = true; break;
      case "--db": a.db = argv[++i] ?? a.db; break;
      case "--port": a.port = parseIntArg("--port", argv[++i], 1, 65535); break;
      case "--host": a.host = argv[++i] ?? a.host; break;
      case "--session": a.session = argv[++i] ?? a.session; break;
      case "--seed": a.seed = parseIntArg("--seed", argv[++i], 1, SEED_MEMORIES.length); break;
      default:
        if (arg.startsWith("--")) {
          process.stderr.write(`mempeek: unknown flag ${arg}\n`);
        }
    }
  }
  return a;
}

const HELP = `MemPeek — zero-token memory readback (v${MEMPEEK_VERSION})

Usage:
  mempeek                       MCP stdio server + dashboard (default)
  mempeek --demo [--seed N]     Bounded demo, prints the ZTMR primitive + savings
  mempeek --http-only           Dashboard HTTP only (no MCP stdio)
  mempeek --mcp-only            MCP stdio only (no dashboard)

Flags:
  --db <path>      SQLite path (default: ./mempeek.db)
  --port <n>       Dashboard port (default: 7331)
  --host <h>       Dashboard host (default: 127.0.0.1)
  --session <id>   Session id (default: default)
  --seed <N>       Demo seed count (default: 14)
  --version        Print version and exit
  --help           Show this help

Exit codes:
  0  success
  1  runtime failure (e.g. dashboard could not start in --http-only mode)
  2  usage error (unknown mode combination, invalid flag value)

Connect your agent (Claude Code):
  /mcp add mempeek node /path/to/dist/index.js

Then open http://localhost:7331
`;

function log(...parts: unknown[]): void {
  // Always to stderr so stdout stays clean for MCP stdio JSON-RPC.
  process.stderr.write(parts.join(" ") + "\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(`mempeek ${MEMPEEK_VERSION}\n`);
    return;
  }
  if (args.httpOnly && args.mcpOnly) {
    usageError("--http-only and --mcp-only are mutually exclusive");
  }
  if (args.demo) {
    await runDemo(args);
    return;
  }
  await runServer(args);
}

async function runServer(args: CliArgs): Promise<void> {
  const store = new MemoryStore(args.db, args.session);
  const bus = new SSEBus();
  const sideChannelUrl = `http://${args.host}:${args.port}`;
  const wantDashboard = !args.mcpOnly;
  const wantMcp = !args.httpOnly;

  let dashboardUrl: string | null = null;
  if (wantDashboard) {
    try {
      const handle = await startDashboard(
        { store, bus },
        { port: args.port, host: args.host },
      );
      dashboardUrl = handle.url;
      log(`MemPeek dashboard: ${handle.url}`);
    } catch (err) {
      log(`MemPeek: dashboard disabled (${(err as Error).message}); MCP still available.`);
    }
  }

  const sideChannel = dashboardUrl ?? sideChannelUrl;

  if (!wantMcp) {
    // http-only: the dashboard is the only service — if it failed to start
    // there is nothing left to serve, so exit instead of hanging as a zombie.
    if (!dashboardUrl) {
      log(`MemPeek: fatal: dashboard failed to start; --http-only has nothing to serve. Exiting.`);
      process.exit(1);
    }
    log(`MemPeek running in dashboard-only mode. Ctrl+C to stop.`);
    process.on("SIGINT", () => process.exit(0));
    return;
  }

  log(`MemPeek MCP server listening on stdio (session: ${args.session}).`);
  await runStdioMcp({ store, bus }, { sessionId: args.session, sideChannelUrl: sideChannel });
}

// ---------------------------------------------------------------------------
// Bounded demo — seeds memories, runs readbacks, prints the ZTMR contrast +
// savings budget. No servers started. Exits 0.
// ---------------------------------------------------------------------------

const SEED_MEMORIES: { content: string; in_context?: boolean }[] = [
  { content: "deployment config: prod runs on us-east-1, 3x c6i.2xlarge behind an ALB; staging on eu-west-1.", in_context: true },
  { content: "DB connection: postgres 16, pool size 20, read replicas=2, pgbouncer transaction mode.", in_context: true },
  { content: "API keys are stored in AWS Secrets Manager under /prod/api/*; rotate every 90 days." },
  { content: "the auth service issues JWTs (RS256), 15-min access + 30-day refresh; jwks at /.well-known/jwks.json" },
  { content: "rate limit: 100 req/min per token, 1000 req/min per org; enforced at the gateway." },
  { content: "the embeddings index uses pgvector on the read replica; 1536-dim, ivfflat lists=100." },
  { content: "CI runs on GitHub Actions: lint + test on push, deploy on tag v*.*.* via goreleaser." },
  { content: "the frontend is a Next.js 14 app on Vercel; ISR every 60s for marketing pages." },
  { content: "object storage: S3 bucket prod-assets, CloudFront in front, TTL 1h for /static/*." },
  { content: "logs ship to Loki via promtail; retention 30d hot, 1y cold (S3)." },
  { content: "on-call rotation: 2 engineers, weekly; PagerDuty service 'platform-prod'." },
  { content: "the billing pipeline is a nightly Airflow DAG; idempotent, retries 3x, alerts on skew >5%." },
  { content: "feature flags via LaunchDarkly; 'new_checkout' at 20% rollout, kill-switch wired." },
  { content: "migrations: golang-migrate, forward-only, reviewed in #platform-reviews; never hot-fix prod." },
];

const DEMO_QUERIES = [
  "what do I know about the deployment config?",
  "how does the auth service issue tokens?",
  "where are API keys stored and how often rotated?",
];

function c(code: string, s: string): string {
  return `\x1b[${code}m${s}\x1b[0m`;
}
const C = {
  dim: (s: string) => c("2;37", s),
  cyan: (s: string) => c("1;36", s),
  green: (s: string) => c("1;32", s),
  yellow: (s: string) => c("1;33", s),
  purple: (s: string) => c("1;35", s),
  red: (s: string) => c("1;31", s),
  bold: (s: string) => c("1", s),
};

async function runDemo(args: CliArgs): Promise<void> {
  const dbPath = args.db === "mempeek.db" ? "mempeek-demo.db" : args.db;
  const store = new MemoryStore(dbPath, args.session);

  process.stdout.write(C.cyan("╭─ MemPeek ZTMR demo ───────────────────────────────────────────────╮\n"));
  process.stdout.write(C.dim("│  Seeding ") + C.yellow(String(args.seed)) + C.dim(" memories into a local SQLite store…") + "\n");

  const seed = SEED_MEMORIES.slice(0, Math.min(args.seed, SEED_MEMORIES.length));
  for (const m of seed) {
    store.write({ content: m.content, in_context: m.in_context, session_id: args.session });
  }
  process.stdout.write(C.green(`│  ✓ seeded ${seed.length} entries (${store.inContext().length} flagged in_context)\n`));

  process.stdout.write(C.cyan("╰──────────────────────────────────────────────────────────────────╯\n\n"));

  let injectionBaseline = 0;
  let sidechannelCost = 0;
  let savedTotal = 0;

  for (let i = 0; i < DEMO_QUERIES.length; i++) {
    const query = DEMO_QUERIES[i];
    process.stdout.write(C.bold(`▶ Readback #${i + 1}: ${C.purple(`"${query}"`)}\n`));

    const { entries } = store.readback(query, { topK: 5, sessionId: args.session });
    const receipt = computeReceipt(entries, { displayed: true });

    // injection baseline: the model would have received the full recall text
    const injectionTokens = entries.reduce((s, e) => s + estimateTokens(e.content), 0);
    const receiptTokens = estimateTokens(receiptToString(receipt));
    injectionBaseline += injectionTokens;
    sidechannelCost += receiptTokens;
    savedTotal += receipt.token_saved;

    process.stdout.write(C.dim("  → model context receives (constant-size receipt, O(1)):\n"));
    process.stdout.write(`    ${C.green(receiptToString(receipt))}\n`);
    process.stdout.write(C.dim(`  → dashboard side-channel receives (full recall, ${entries.length} entries — never enters context):\n`));
    for (const e of entries) {
      const tag = e.in_context ? C.yellow("[in-context]") : C.dim("[recall]   ");
      process.stdout.write(`    ${tag} ${e.content.slice(0, 90)}${e.content.length > 90 ? "…" : ""}\n`);
    }
    // record savings so the dashboard (if later started on this DB) shows them
    store.recordSavings(args.session, receipt.found, receipt.token_saved);
    process.stdout.write(C.green(`  → saved this readback: ${receipt.token_saved} tokens\n\n`));
  }

  // Budget comparison (m3 before/after graph is a stub; this is the m2 text version)
  process.stdout.write(C.bold("── Context-budget comparison ──────────────────────────────────────\n"));
  process.stdout.write(`  injection-based memory (baseline):    ${C.red(String(injectionBaseline))} tokens into context (full recall each readback)\n`);
  process.stdout.write(`  MemPeek side-channel readback:        ${C.green(String(sidechannelCost))} tokens into context (constant-size receipts only)\n`);
  process.stdout.write(`  ${C.yellow("context tokens avoided:")}            ${C.green(String(savedTotal))} tokens kept out of the window\n\n`);

  process.stdout.write(C.dim(`Store: ${dbPath} (${store.count()} entries, ${store.savings().count} readbacks logged)\n`));
  process.stdout.write(C.cyan("Dashboard: ") + `http://${args.host}:${args.port}\n`);
  process.stdout.write(C.dim("Run ") + C.bold("mempeek") + C.dim(" (or --http-only) to serve the dashboard and inspect this store.\n"));

  store.close();
}

main().catch((err) => {
  process.stderr.write(`mempeek: fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
