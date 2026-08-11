// src/readback.ts
//
// Zero-Token Memory Readback (ZTMR) — the core primitive.
//
// A readback query produces TWO outputs:
//   1. The full MemPeekEntry[] → SSE side-channel (the human's dashboard).
//   2. An O(1) fixed-size ReadbackReceipt → the model's context window (via
//      MCP stdio).
//
// The zero-token property holds because the receipt is constant-size
// regardless of recall volume: a 3-entry recall and a 3000-entry recall
// both return exactly `{ found, displayed, token_saved }`.

import type { MemPeekEntry } from "./memory-store.js";

/**
 * A lean entry shape for transport to the dashboard / SSE. Embeddings are
 * stripped (the UI never needs them; shipping 128 floats per entry would
 * bloat the side-channel and Float32Array serializes awkwardly to JSON).
 */
export interface LeanEntry {
  id: string;
  session_id: string;
  content: string;
  ts: number;
  in_context: boolean;
}

/** Strip the embedding from an entry for dashboard transport. */
export function toLean(e: MemPeekEntry): LeanEntry {
  return {
    id: e.id,
    session_id: e.session_id,
    content: e.content,
    ts: e.ts,
    in_context: e.in_context,
  };
}

/** Fixed-size receipt returned to the model. Always O(1). */
export interface ReadbackReceipt {
  found: number;
  displayed: boolean;
  token_saved: number;
  /** Hint to the model on how to consult the side-channel (UI surface). */
  side_channel: string;
}

/**
 * Rough token estimate for savings accounting only (NOT billed tokens).
 * Blends a CJK heuristic (≈1.5 tok/char) with the latin ≈4 char/tok rule.
 * Sufficient for the savings counter; replace with a real tokenizer if you
 * want billed-token precision (out of scope for v0.1).
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.5 + rest / 4);
}

/** Build the constant-size receipt for a readback result. */
export function computeReceipt(
  entries: MemPeekEntry[],
  opts: { displayed?: boolean; sideChannel?: string } = {},
): ReadbackReceipt {
  const displayed = opts.displayed ?? true;
  const tokenSaved = displayed
    ? entries.reduce((sum, e) => sum + estimateTokens(e.content), 0)
    : 0;
  return {
    found: entries.length,
    displayed,
    token_saved: tokenSaved,
    side_channel: opts.sideChannel ?? "http://localhost:7331",
  };
}

/** Serialize a receipt for the model (compact JSON, fixed shape). */
export function receiptToString(r: ReadbackReceipt): string {
  return JSON.stringify(r);
}

// ---------------------------------------------------------------------------
// SSE event bus — the side-channel transport from MCP server → dashboard.
// ---------------------------------------------------------------------------

export type SSEEvent =
  | { type: "write"; entry: LeanEntry; ts: number }
  | {
      type: "recall";
      query: string;
      entries: LeanEntry[];
      receipt: ReadbackReceipt;
      ts: number;
    }
  | {
      type: "savings";
      total: number;
      count: number;
      lastSaved: number;
      ts: number;
    }
  | {
      type: "snapshot";
      entries: LeanEntry[];
      inContext: LeanEntry[];
      savings: { total: number; count: number; series: { ts: number; saved: number }[] };
      ts: number;
    };

type Subscriber = (e: SSEEvent) => void;

/**
 * In-memory pub/sub bus. The MCP server publishes; the dashboard's SSE
 * endpoint subscribes. No persistence — subscribers only see events after
 * they connect (a full snapshot is sent on connect to backfill state).
 */
export class SSEBus {
  private subscribers = new Set<Subscriber>();

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  emit(e: SSEEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(e);
      } catch {
        // a dead subscriber should not break the bus
      }
    }
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
