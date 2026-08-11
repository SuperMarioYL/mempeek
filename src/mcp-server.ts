// src/mcp-server.ts
//
// MCP stdio server exposing the ZTMR tools:
//   - mempeek.write(content, embedding?, in_context?, session_id?)
//         Persists a MemPeekEntry to the SQLite store. Returns an ack.
//   - mempeek.readback(query, embedding?, top_k?, session_id?)
//         Queries the store by cosine similarity, emits the full
//         MemPeekEntry[] to the SSE side-channel (the human's dashboard),
//         and returns ONLY the constant-size ReadbackReceipt to the model.
//
// Uses the low-level Server + StdioServerTransport from
// @modelcontextprotocol/sdk so we depend on no schema library beyond the
// SDK itself (plain JSON Schema for tool inputSchema).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MemoryStore } from "./memory-store.js";
import {
  SSEBus,
  computeReceipt,
  receiptToString,
  toLean,
  type ReadbackReceipt,
} from "./readback.js";

export interface McpServerOptions {
  sessionId: string;
  sideChannelUrl: string;
}

export interface ToolDeps {
  store: MemoryStore;
  bus: SSEBus;
}

/** A plain JSON-Schema tool input descriptor (no zod). */
interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const WRITE_TOOL: ToolDef = {
  name: "mempeek.write",
  description:
    "Persist a memory entry to the local MemPeek store. Pass `embedding` " +
    "(from your agent's existing embedding provider) for precise cosine " +
    "recall; omit it to use MemPeek's deterministic fallback vectorizer. " +
    "Set `in_context=true` for facts that are ALSO in the model's context " +
    "window right now (the dashboard shows them separately).",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string", description: "The memory text to store." },
      embedding: {
        type: "array",
        items: { type: "number" },
        description:
          "Optional embedding vector from your own provider. Omit to use the built-in fallback.",
      },
      in_context: {
        type: "boolean",
        description:
          "True if this fact is ALSO currently in the model's context window. Default false.",
        default: false,
      },
      session_id: {
        type: "string",
        description: "Optional session id; defaults to the server's session.",
      },
      id: { type: "string", description: "Optional explicit id (else generated)." },
    },
    required: ["content"],
  },
};

const READBACK_TOOL: ToolDef = {
  name: "mempeek.readback",
  description:
    "Zero-token memory readback. Returns ONLY a constant-size " +
    "ReadbackReceipt `{found, displayed, token_saved, side_channel}` to " +
    "your context window — the full recall content goes to the human's " +
    "dashboard via the SSE side-channel and NEVER enters your context. " +
    "Call this whenever you want to know 'what do I know about X' without " +
    "spending context tokens on the recall.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What you want to recall (natural language).",
      },
      embedding: {
        type: "array",
        items: { type: "number" },
        description: "Optional query embedding from your own provider.",
      },
      top_k: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Max entries to recall. Default 10.",
        default: 10,
      },
      session_id: {
        type: "string",
        description: "Optional session id to scope the recall.",
      },
    },
    required: ["query"],
  },
};

/** Build (but do not connect) the MCP server. */
export function createMcpServer(deps: ToolDeps, opts: McpServerOptions): Server {
  const server = new Server(
    { name: "mempeek", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: WRITE_TOOL.name,
        description: WRITE_TOOL.description,
        inputSchema: WRITE_TOOL.inputSchema,
      },
      {
        name: READBACK_TOOL.name,
        description: READBACK_TOOL.description,
        inputSchema: READBACK_TOOL.inputSchema,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (toolName === WRITE_TOOL.name) {
      return handleWrite(args, deps, opts);
    }
    if (toolName === READBACK_TOOL.name) {
      return handleReadback(args, deps, opts);
    }
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
    };
  });

  return server;
}

function textBlock(text: string) {
  return { type: "text" as const, text };
}

function ok(text: string) {
  return { content: [textBlock(text)] };
}

function err(text: string) {
  return { isError: true, content: [textBlock(text)] };
}

function asNumberArray(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => Number(x)).filter((n) => Number.isFinite(n));
}

function handleWrite(
  args: Record<string, unknown>,
  deps: ToolDeps,
  _opts: McpServerOptions,
) {
  const content = typeof args.content === "string" ? args.content : "";
  if (!content) {
    return err("mempeek.write requires non-empty `content`.");
  }
  const embedding = asNumberArray(args.embedding);
  const in_context = args.in_context === true;
  const session_id = typeof args.session_id === "string" ? args.session_id : undefined;
  const id = typeof args.id === "string" ? args.id : undefined;

  const entry = deps.store.write({
    content,
    embedding,
    in_context,
    session_id,
    id,
  });
  deps.bus.emit({ type: "write", entry: toLean(entry), ts: Date.now() });
  // Refresh snapshot so any connected dashboard updates fully.
  emitSnapshot(deps, _opts);
  return ok(
    JSON.stringify({
      ok: true,
      id: entry.id,
      session_id: entry.session_id,
      in_context: entry.in_context,
      embedding_source: embedding ? "provided" : "fallback",
      ts: entry.ts,
    }),
  );
}

function handleReadback(
  args: Record<string, unknown>,
  deps: ToolDeps,
  opts: McpServerOptions,
) {
  const query = typeof args.query === "string" ? args.query : "";
  if (!query) {
    return err("mempeek.readback requires non-empty `query`.");
  }
  const embedding = asNumberArray(args.embedding);
  const top_k =
    typeof args.top_k === "number" && args.top_k >= 1
      ? Math.min(Math.floor(args.top_k), 100)
      : 10;
  const session_id = typeof args.session_id === "string" ? args.session_id : undefined;

  const { entries } = deps.store.readback(query, { topK: top_k, embedding, sessionId: session_id });
  const receipt: ReadbackReceipt = computeReceipt(entries, {
    displayed: true,
    sideChannel: opts.sideChannelUrl,
  });

  // The full recall → side-channel (dashboard). Never enters the model context.
  deps.bus.emit({
    type: "recall",
    query,
    entries: entries.map(toLean),
    receipt,
    ts: Date.now(),
  });
  // Record savings for the live counter + sparkline.
  deps.store.recordSavings(session_id ?? opts.sessionId, receipt.found, receipt.token_saved);
  deps.bus.emit({
    type: "savings",
    total: deps.store.savings(session_id).total,
    count: deps.store.savings(session_id).count,
    lastSaved: receipt.token_saved,
    ts: Date.now(),
  });
  emitSnapshot(deps, opts);

  // The model receives ONLY the constant-size receipt.
  return ok(receiptToString(receipt));
}

function emitSnapshot(deps: ToolDeps, opts: McpServerOptions) {
  const all = deps.store.list();
  const inContext = deps.store.inContext();
  const s = deps.store.savings();
  deps.bus.emit({
    type: "snapshot",
    entries: all.map(toLean),
    inContext: inContext.map(toLean),
    savings: {
      total: s.total,
      count: s.count,
      series: s.series.map((p) => ({ ts: p.ts, saved: p.saved })),
    },
    ts: Date.now(),
  });
  // also a savings event for the live counter
  deps.bus.emit({
    type: "savings",
    total: s.total,
    count: s.count,
    lastSaved: s.series.length ? s.series[s.series.length - 1].saved : 0,
    ts: Date.now(),
  });
  // touch opts to avoid unused-var lint in callers
  void opts;
}

/** Connect the MCP server over stdio. Returns when the transport closes. */
export async function runStdioMcp(
  deps: ToolDeps,
  opts: McpServerOptions,
): Promise<void> {
  const server = createMcpServer(deps, opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive until stdio closes; StdioServerTransport handles close.
}
