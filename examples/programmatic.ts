// examples/programmatic.ts
//
// Use MemPeek's store + readback directly (no MCP transport), e.g. inside your
// own agent loop or a script. The zero-token contract is yours to honor: only
// forward the ReadbackReceipt to the model — never the full `entries`.
//
// Run:  npx tsx examples/programmatic.ts

import { MemoryStore, embedText } from "../src/memory-store.js";
import { computeReceipt, receiptToString, estimateTokens } from "../src/readback.js";

const store = new MemoryStore("./example.db", "demo");

store.write({ content: "deployment config: prod on us-east-1, 3x c6i.2xlarge behind an ALB.", in_context: true });
store.write({ content: "DB: postgres 16, pool 20, 2 read replicas, pgbouncer transaction mode." });
store.write({ content: "API keys live in AWS Secrets Manager under /prod/api/*; rotate every 90 days." });

const query = "what do I know about the deployment config?";
const { entries } = store.readback(query, { topK: 3, embedding: embedText(query) });

// → forward ONLY this to the model (constant-size, regardless of recall volume)
const receipt = computeReceipt(entries, { displayed: true, sideChannel: "http://localhost:7331" });
console.log("model gets:", receiptToString(receipt));

// → the full recall goes to your side-channel (here, just the console)
console.log(`side-channel gets ${entries.length} entries (${estimateTokens(entries.map(e=>e.content).join(" "))} tokens that never entered context):`);
for (const e of entries) console.log(`  - [${e.in_context ? "in-context" : "recall"}] ${e.content}`);

store.close();
