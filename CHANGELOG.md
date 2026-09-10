# Changelog

All notable changes to MemPeek are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
semantic versioning.

## [0.2.0] - 2026-09-10

### Fixed

- **Savings sparkline data**: `MemoryStore.savings()` mapped a non-existent
  `saved` column from `SELECT * FROM savings` rows (the column is
  `token_saved`), so every per-readback series point carried `undefined`
  savings. The dashboard sparkline, `GET /api/savings`, SSE snapshots, and the
  MCP `lastSaved` event all silently received malformed data after the first
  readback. The store now selects `token_saved AS saved` explicitly.
- **CLI flag validation**: `--port` and `--seed` accepted arbitrary text and
  silently became `NaN` (`--demo --seed abc` seeded 0 memories, printed
  "Seeding NaN" and exited 0). Invalid or out-of-range values now print a
  clean error and exit 2. `--http-only` combined with `--mcp-only` is
  rejected as a usage error.
- **`--http-only` zombie process**: when the dashboard failed to start (bad
  port, port in use), `--http-only` still printed "running in dashboard-only
  mode" and hung forever with nothing serving, exiting 0 on SIGINT. It now
  prints a fatal message and exits 1. The default MCP + dashboard mode keeps
  its graceful degradation ("dashboard disabled; MCP still available").

### Added

- **200-turn demo session + before/after budget graph**
  (`examples/demo-session.mjs`): simulates a 200-turn agent workload (one
  memory write per turn, a readback every 8 turns) and renders the cumulative
  context-budget comparison — injection baseline vs constant-size receipts —
  as `docs/demo-budget.json` plus an SVG chart `docs/budget-graph.svg`.
- **`--version` / `-V` flag** reporting the packaged version, sourced from
  `package.json` via the new `src/version.ts` (the MCP `serverInfo.version`
  and the help banner use the same source, so the surfaces cannot drift).

### Changed

- Version surfaces bumped in lockstep to 0.2.0: `VERSION`, `package.json`,
  the help banner, MCP `serverInfo.version`, README badges, and
  `web/site.json` `meta.content_version`.
- Test suite expanded: version-lockstep consistency, CLI contract (exit
  codes), demo-session smoke test, and savings-series assertions in the MCP
  stdio end-to-end test; `npm test` now runs all four suites.

## [0.1.0] - 2026-08-11

### Added

- Initial release: zero-token memory readback (ZTMR) for AI agents.
- MCP stdio server exposing `mempeek.write` and `mempeek.readback` — the
  model receives only a constant-size receipt
  (`{found, displayed, token_saved, side_channel}`) while the full recall
  streams to the local dashboard over SSE.
- Local web dashboard at `localhost:7331`: full recall list, in-context
  items, live token-savings counter with sparkline.
- SQLite persistence (better-sqlite3) with cosine-similarity recall and an
  optional caller-supplied embedding path.
- Bounded terminal demo (`--demo`) printing the receipt-vs-full-recall
  contrast and the context-budget comparison.
