**English** | [简体中文](README.md)

<picture>
  <source media="(max-width: 640px) and (prefers-color-scheme: dark)" srcset="assets/presentation/hero-mobile-dark.svg">
  <source media="(max-width: 640px)" srcset="assets/presentation/hero-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="assets/presentation/hero-dark.svg">
  <img src="assets/presentation/hero-light.svg" width="1000" alt="Send full recalls to a local dashboard and return compact MCP receipts, so people can review memories without repeating their full text in model context.">
</picture>

**Send full recalls to a local dashboard and return compact MCP receipts, so people can review memories without repeating their full text in model context.**

`v0.2.0` · `Node.js 22+` · [MIT](LICENSE)

[Website](https://mempeek.lei6393.com) · [Demo record](docs/demo-results.json)

## Why use it

Inspecting what an agent remembers and asking a model to reason over those memories are different operations. MemPeek provides a local readback route for inspection: people receive the matching content while the model gets counts and a location receipt. If the model needs the text for reasoning, the caller must provide it separately.

## Architecture

<picture>
  <source media="(max-width: 640px) and (prefers-color-scheme: dark)" srcset="assets/presentation/architecture-mobile-dark.svg">
  <source media="(max-width: 640px)" srcset="assets/presentation/architecture-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="assets/presentation/architecture-dark.svg">
  <img src="assets/presentation/architecture-light.svg" width="1000" alt="MemoryStore persists text and vectors in SQLite and recalls by cosine similarity. MCP readback publishes lean entries through SSEBus to the HTTP/SSE dashboard. The receipt contains found, displayed, token_saved and side_channel. Default vectors are hashed bags of words; callers can supply their own.">
</picture>

MemoryStore persists text and vectors in SQLite and recalls by cosine similarity. MCP readback publishes lean entries through SSEBus to the HTTP/SSE dashboard. The receipt contains found, displayed, token_saved and side_channel. Default vectors are hashed bags of words; callers can supply their own.

Source entry points: [src/index.ts](src/index.ts) · [src/mcp-server.ts](src/mcp-server.ts) · [src/memory-store.ts](src/memory-store.ts) · [src/readback.ts](src/readback.ts) · [src/dashboard/server.ts](src/dashboard/server.ts)

## Install

Requires Node.js 22+. better-sqlite3 needs a binary matching the local Node runtime; native build tools are required if no prebuilt binary is available.

```bash
git clone https://github.com/SuperMarioYL/mempeek.git
cd mempeek
npm ci
npm run build
```

## Quickstart

The script writes two memories to temporary SQLite, explicitly scopes recall to the demo session and delivers full text through an in-process SSEBus. It starts no model or browser dashboard. token_saved is a heuristic content estimate.

```bash
node examples/presentation-demo.mjs
```

Complete inputs and execution steps are included in the commands above and the [demo record](docs/demo-results.json).

## Usage

```bash
node dist/index.js --db mempeek.db --session project-a
node dist/index.js --http-only --db mempeek.db
node dist/index.js --demo --seed 14
```
The dashboard defaults to http://localhost:7331. Configure an MCP client with command node and an absolute dist/index.js path in args. mempeek.write accepts content; mempeek.readback accepts query, top_k and session_id. Supply session_id explicitly when recall must be scoped.

A 200-turn simulated session with the before/after context-budget comparison:

```bash
node examples/demo-session.mjs
```

Writes [docs/demo-budget.json](docs/demo-budget.json) (cumulative injection vs side-channel tokens per readback) and [docs/budget-graph.svg](docs/budget-graph.svg) (the two cumulative curves); `--turns` and `--every` scale the run.

## Recorded demo

<picture>
  <source media="(max-width: 640px) and (prefers-color-scheme: dark)" srcset="assets/presentation/process-mobile-dark.svg">
  <source media="(max-width: 640px)" srcset="assets/presentation/process-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="assets/presentation/process-dark.svg">
  <img src="assets/presentation/process-light.svg" width="1000" alt="The script writes two memories to temporary SQLite, explicitly scopes recall to the demo session and delivers full text through an in-process SSEBus. It starts no model or browser dashboard. token_saved is a heuristic content estimate.">
</picture>

### Inspect the split return

model_receipt omits full text while side_channel_content contains the matching memory.

```text
$ node examples/presentation-demo.mjs
{
  "model_receipt": {
    "found": 1,
    "displayed": true,
    "token_saved": 7,
    "side_channel": "local-demo"
  },
  "side_channel_content": [
    "deployment uses port 8080"
  ],
  "receipt_contains_full_content": false
}
```

## Capabilities and integration

<picture>
  <source media="(max-width: 640px) and (prefers-color-scheme: dark)" srcset="assets/presentation/integrations-mobile-dark.svg">
  <source media="(max-width: 640px)" srcset="assets/presentation/integrations-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="assets/presentation/integrations-dark.svg">
  <img src="assets/presentation/integrations-light.svg" width="1000" alt="MCP stdio and the dashboard normally share one process; either can run alone. session_id filters queries and in_context is a caller-supplied label, not automatic inspection of the agent’s actual context.">
</picture>

MCP stdio and the dashboard normally share one process; either can run alone. session_id filters queries and in_context is a caller-supplied label, not automatic inspection of the agent’s actual context.



## Configuration

`--db=mempeek.db`, `--port=7331`, `--host=127.0.0.1` and `--session=default` control runtime placement. `--http-only`/`--mcp-only` select transports. Embeddings can be supplied to writes and queries. The receipt’s displayed flag is not an acknowledgement that a browser rendered or a person read the content.

## Roadmap and scope

Local storage, MCP and dashboard are implemented. Memory bridges, team sharing and real-tokenizer accounting are future directions.

- Receipts themselves consume tokens; token_saved does not subtract receipt cost and is not measured billing or net savings.
- The default hashed vectorizer is not a semantic model; recall without session_id can span multiple sessions.

![Existing terminal recording](assets/demo-recall.gif)

## License

[MIT](LICENSE)
