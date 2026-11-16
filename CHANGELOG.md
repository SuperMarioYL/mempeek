# Changelog

All notable changes to MemPeek are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
semantic versioning.

## [0.4.0] - 2026-11-17

### Fixed

- **Embedding contract**: `mempeek.write`/`mempeek.readback` coerced a supplied
  embedding with `Number()` and dropped non-finite elements, so
  `[0.5,"abc",0.25]` silently became a two-element vector and `[]` was
  accepted as a "provided" embedding. `cosine()` then compared only
  `min(len(a), len(b))` elements, so a vector from a different provider (for
  example a 1536-dim query against 128-dim fallback rows) was ranked by an
  unnormalized prefix with no error — recall degenerated to newest-first with
  an invented similarity. Supplied embeddings are now validated (non-empty,
  every element a finite number) and readback scores only same-dimension
  entries, reporting `embedding dimension mismatch` instead of a false ranking.
- **Session id lost on upsert**: `write()` upserted by id but its conflict
  branch never updated `session_id` while still returning the requested session
  in the ack. Rewriting an existing id under another session therefore
  acknowledged the new session while the row stayed in the old one, and a
  session-scoped readback silently missed it. The upsert now moves the row.
- **Dashboard cut every memory at 240 characters**: the dashboard is the only
  surface where a human reads recalled content, yet `rowHtml` rendered
  `truncate(entry.content, 240)` and no view, tooltip or API exposed the rest.
  Long memories are now fully readable through a localized "show full text"
  expander while the compact preview stays.
- **Receipt claimed a display that did not exist**: under `--mcp-only`, or when
  the dashboard failed to start (e.g. port in use), readback still returned
  `displayed:true` with a `side_channel` URL where nothing listened, and
  recorded `token_saved` as if the recall had been shown. Receipts now report
  `displayed:false`, `token_saved:0` and `side_channel:"not-running"` in that
  state and record no savings.

### Changed

- Version surfaces bumped in lockstep to 0.4.0 — `VERSION`, `package.json`,
  `package-lock.json`, `web/site.json` `meta.content_version` and `footer.tag`,
  `docs/demo-results.json`, and both README badges. The test suite gained the
  `embedding-contract`, `store-contracts` and `dashboard-render` suites (127
  assertions) and the stdio end-to-end test now covers the `--mcp-only` receipt
  contract.

## [0.3.0] - 2026-10-14

### Fixed

- **Dashboard sparkline duplication**: `emitSnapshot` emitted a trailing
  `savings` event whose `lastSaved` was always the last series point the
  accompanying snapshot had just delivered, and the dashboard client appends
  every savings event to its sparkline series — so every `mempeek.write` or
  `mempeek.readback` added a duplicate point and the live sparkline diverged
  from the store's true series. The redundant emit is gone; incremental
  savings updates now come only from `handleReadback` (with the genuinely new
  receipt).
- **Dashboard render crash on future timestamps**: `relTime()` reassigned a
  `const` binding when an entry's timestamp was in the future relative to the
  browser clock (a backward clock step, or a caller-supplied `ts`), throwing
  `TypeError: Assignment to constant variable` and freezing all dashboard
  panel rendering. The clamp now uses `let` and future timestamps render as
  "0s".
- **Clean CLI error for a bad `--db` target**: pointing `--db` at a non-SQLite
  file, an empty string, or an unwritable path dumped a raw `SqliteError`
  with node_modules stack frames. Store construction at the CLI layer now
  prints one named line (`mempeek: cannot open memory store at <path>:
  <reason>`) and exits 1, matching the clean-error contract v0.2.0
  established for invalid flag values.

### Changed

- Version surfaces bumped in lockstep to 0.3.0 — including
  `docs/demo-results.json`, which the live site consumes via
  `web/site.json` `meta.demo_source` and which had silently stayed at 0.1.0
  through the v0.2.0 bump. The version-consistency test now also guards
  `docs/demo-results.json`'s version and `web/site.json`'s footer tag, the
  two surfaces the previous lockstep sweep missed.

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
