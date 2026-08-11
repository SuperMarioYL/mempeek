// src/memory-store.ts
//
// Persistent memory store for MemPeek.
//
// A single SQLite file (better-sqlite3) is the only persistent state. Each
// MemPeekEntry is a row with an embedding blob; readback queries by cosine
// similarity against a caller-supplied (or locally-derived) query embedding.
//
// The zero-token property is preserved here only by the *shape* of what we
// return: the store returns the full MemPeekEntry[]; the caller (readback.ts)
// is responsible for emitting it to the SSE side-channel and returning only
// the fixed-size ReadbackReceipt to the model.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** A single memory record. */
export interface MemPeekEntry {
  id: string;
  session_id: string;
  content: string;
  embedding: Float32Array;
  ts: number;
  in_context: boolean;
}

/** Row shape as persisted in SQLite (embedding serialized as a Buffer). */
interface EntryRow {
  id: string;
  session_id: string;
  content: string;
  embedding: Buffer; // Float32Array bytes
  ts: number;
  in_context: number; // 0 | 1
}

/**
 * A deterministic, dependency-free text embedding used when the caller does
 * not supply an embedding from the agent's own provider. It is a hashed
 * bag-of-words vector: shared vocabulary → higher cosine similarity. This is
 * NOT a trained model or reranker (out_of_scope) — it is a fallback so the
 * store works out of the box. Callers with a real embedding provider should
 * pass `embedding` to write()/readback() and bypass this.
 */
export function embedText(text: string, dim = 128): Float32Array {
  const vec = new Float32Array(dim);
  const tokens = text
    .toLowerCase()
    .split(/[^0-9a-z\u4e00-\u9fff]+/u) // keep CJK runs and alphanumerics
    .filter((t) => t.length > 0);
  for (const tok of tokens) {
    // hash token → bucket + char-ngram sub-buckets for partial overlap
    const buckets = [hash(tok, dim), hash(tok.slice(0, 3) + "#", dim)];
    if (tok.length > 3) buckets.push(hash(tok.slice(-3) + "$", dim));
    for (const b of buckets) {
      vec[b] += 1;
    }
  }
  // L2 normalize so cosine = dot product
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

function hash(s: string, mod: number): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % mod;
}

/** Cosine similarity for two equal-length Float32Arrays (assumed L2-normalized). */
export function cosine(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

/** Serialize a Float32Array to a Buffer for SQLite BLOB storage. */
function embeddingToBuffer(e: Float32Array): Buffer {
  return Buffer.from(e.buffer, e.byteOffset, e.byteLength);
}

/** Deserialize a Buffer back to a Float32Array (copy to avoid SharedArrayBuffer edge cases). */
function bufferToEmbedding(buf: Buffer): Float32Array {
  const out = new Float32Array(buf.length / 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

function rowToEntry(r: EntryRow): MemPeekEntry {
  return {
    id: r.id,
    session_id: r.session_id,
    content: r.content,
    embedding: bufferToEmbedding(r.embedding),
    ts: r.ts,
    in_context: r.in_context === 1,
  };
}

export interface WriteInput {
  content: string;
  embedding?: number[] | Float32Array;
  in_context?: boolean;
  session_id?: string;
  id?: string;
  ts?: number;
}

export interface ReadbackResult {
  entries: MemPeekEntry[];
}

export class MemoryStore {
  private db: Database.Database;
  private sessionId: string;

  constructor(dbPath = "mempeek.db", sessionId = "default") {
    const abs = resolve(dbPath);
    try {
      mkdirSync(dirname(abs), { recursive: true });
    } catch {
      // dirname may be "" for a bare filename
    }
    this.db = new Database(abs);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.sessionId = sessionId;
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        content     TEXT NOT NULL,
        embedding   BLOB NOT NULL,
        ts          INTEGER NOT NULL,
        in_context  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(session_id);
      CREATE INDEX IF NOT EXISTS idx_entries_ts ON entries(ts);
      CREATE INDEX IF NOT EXISTS idx_entries_in_context ON entries(in_context);
      CREATE TABLE IF NOT EXISTS savings (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        found       INTEGER NOT NULL,
        token_saved INTEGER NOT NULL,
        ts          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_savings_session ON savings(session_id);
    `);
  }

  /** Persist a memory entry. Returns the stored entry (with generated id/ts if missing). */
  write(input: WriteInput): MemPeekEntry {
    const embedding =
      input.embedding instanceof Float32Array
        ? input.embedding
        : input.embedding
          ? Float32Array.from(input.embedding)
          : embedText(input.content);
    const entry: MemPeekEntry = {
      id: input.id ?? randomUUID(),
      session_id: input.session_id ?? this.sessionId,
      content: input.content,
      embedding,
      ts: input.ts ?? Date.now(),
      in_context: input.in_context ?? false,
    };
    this.db
      .prepare(
        `INSERT INTO entries (id, session_id, content, embedding, ts, in_context)
         VALUES (@id, @session_id, @content, @embedding, @ts, @in_context)
         ON CONFLICT(id) DO UPDATE SET
           content=excluded.content,
           embedding=excluded.embedding,
           ts=excluded.ts,
           in_context=excluded.in_context`,
      )
      .run({
        id: entry.id,
        session_id: entry.session_id,
        content: entry.content,
        embedding: embeddingToBuffer(entry.embedding),
        ts: entry.ts,
        in_context: entry.in_context ? 1 : 0,
      });
    return entry;
  }

  /**
   * Query the store by cosine similarity. Returns the top-k entries ranked by
   * similarity to `queryEmbedding` (or a locally-derived embedding from
   * `query` text when no embedding is supplied).
   */
  readback(
    query: string,
    opts: { topK?: number; embedding?: number[] | Float32Array; sessionId?: string } = {},
  ): ReadbackResult {
    const topK = opts.topK ?? 10;
    const qEmb =
      opts.embedding instanceof Float32Array
        ? opts.embedding
        : opts.embedding
          ? Float32Array.from(opts.embedding)
          : embedText(query);
    const rows = opts.sessionId
      ? (this.db
          .prepare("SELECT * FROM entries WHERE session_id = ? ORDER BY ts DESC")
          .all(opts.sessionId) as EntryRow[])
      : (this.db
          .prepare("SELECT * FROM entries ORDER BY ts DESC")
          .all() as EntryRow[]);
    const scored = rows
      .map((r) => ({ entry: rowToEntry(r), score: cosine(qEmb, r.embedding ? bufferToEmbedding(r.embedding) : new Float32Array(0)) }))
      .filter((x) => Number.isFinite(x.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((x) => x.entry);
    return { entries: scored };
  }

  /** All entries (dashboard panel a). Newest first. */
  list(sessionId?: string): MemPeekEntry[] {
    const rows = sessionId
      ? (this.db
          .prepare("SELECT * FROM entries WHERE session_id = ? ORDER BY ts DESC")
          .all(sessionId) as EntryRow[])
      : (this.db.prepare("SELECT * FROM entries ORDER BY ts DESC").all() as EntryRow[]);
    return rows.map(rowToEntry);
  }

  /** Entries the agent flagged as in-context (dashboard panel b). */
  inContext(sessionId?: string): MemPeekEntry[] {
    const rows = sessionId
      ? (this.db
          .prepare(
            "SELECT * FROM entries WHERE in_context = 1 AND session_id = ? ORDER BY ts DESC",
          )
          .all(sessionId) as EntryRow[])
      : (this.db
          .prepare("SELECT * FROM entries WHERE in_context = 1 ORDER BY ts DESC")
          .all() as EntryRow[]);
    return rows.map(rowToEntry);
  }

  /** Persist a readback receipt's savings for the live counter + sparkline. */
  recordSavings(sessionId: string, found: number, tokenSaved: number): void {
    this.db
      .prepare(
        "INSERT INTO savings (session_id, found, token_saved, ts) VALUES (?, ?, ?, ?)",
      )
      .run(sessionId, found, tokenSaved, Date.now());
  }

  /** Cumulative token savings + recent per-event series for the sparkline. */
  savings(sessionId?: string): {
    total: number;
    count: number;
    series: { ts: number; saved: number; found: number }[];
  } {
    const seriesRows = sessionId
      ? (this.db
          .prepare("SELECT * FROM savings WHERE session_id = ? ORDER BY ts ASC")
          .all(sessionId) as {
          ts: number;
          saved: number;
          found: number;
        }[])
      : (this.db
          .prepare("SELECT * FROM savings ORDER BY ts ASC")
          .all() as { ts: number; saved: number; found: number }[]);
    const sum = sessionId
      ? (this.db
          .prepare(
            "SELECT COALESCE(SUM(token_saved),0) AS s, COUNT(*) AS c FROM savings WHERE session_id = ?",
          )
          .get(sessionId) as { s: number; c: number })
      : (this.db
          .prepare("SELECT COALESCE(SUM(token_saved),0) AS s, COUNT(*) AS c FROM savings")
          .get() as { s: number; c: number });
    return {
      total: sum.s,
      count: sum.c,
      series: seriesRows.map((r) => ({ ts: r.ts, saved: r.saved, found: r.found })),
    };
  }

  /** Number of entries (used by the dashboard header + demo). */
  count(sessionId?: string): number {
    const r = sessionId
      ? (this.db
          .prepare("SELECT COUNT(*) AS c FROM entries WHERE session_id = ?")
          .get(sessionId) as { c: number })
      : (this.db.prepare("SELECT COUNT(*) AS c FROM entries").get() as { c: number });
    return r.c;
  }

  close(): void {
    this.db.close();
  }
}
