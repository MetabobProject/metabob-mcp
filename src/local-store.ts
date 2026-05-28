/**
 * LocalStore — SQLite-backed cache for sidecar mode.
 *
 * Stores file index records, analysis seeds (problems), a scheduling queue,
 * and MCP session metadata. Used by sidecar-mode tool handlers to serve
 * cache-first responses without blocking on the remote analysis API.
 *
 * Database location: ~/.metabob/sidecar.db
 *
 * All writes are synchronous (Bun's SQLite runs synchronously by design);
 * the async wrappers exist only for API symmetry with async callers.
 */

import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
import { join } from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FileRecord {
  path: string;
  workspace_id: string;
  content_hash: string;
  indexed_at: number; // Unix ms
}

export interface SeedRecord {
  id: string;
  workspace_id: string;
  file_path: string;
  line_start: number;
  line_end: number;
  category: string;
  severity: string;
  brief: string;
  confidence: number;
  refs_json: string; // JSON-encoded string[]
  produced_at: number; // Unix ms
  read_at: number | null;
  stale: boolean;
}

export interface QueueItem {
  id: string;
  file_path: string;
  priority: number;
  enqueued_at: number; // Unix ms
  processing: boolean;
  workspace_id: string;
}

export interface SessionRecord {
  session_id: string;
  workspace_id: string;
  started_at: number; // Unix ms
  api_key_hash: string;
}

export interface Freshness {
  fresh: boolean;
  age_ms: number;
  stale: boolean;
}

// ── LocalStore ────────────────────────────────────────────────────────────────

const FRESH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export class LocalStore {
  private db: Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    const metabobDir = join(homedir(), '.metabob');
    this.dbPath = dbPath ?? join(metabobDir, 'sidecar.db');
  }

  /** Open (or create) the database and apply the schema. Idempotent. */
  init(): void {
    // Ensure ~/.metabob/ exists
    const dir = this.dbPath.substring(0, this.dbPath.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });

    this.db = new Database(this.dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA foreign_keys=ON;');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path        TEXT    NOT NULL,
        workspace_id TEXT   NOT NULL,
        content_hash TEXT   NOT NULL,
        indexed_at  INTEGER NOT NULL,
        PRIMARY KEY (path, workspace_id)
      );

      CREATE TABLE IF NOT EXISTS seeds (
        id           TEXT    NOT NULL,
        workspace_id TEXT    NOT NULL,
        file_path    TEXT    NOT NULL,
        line_start   INTEGER NOT NULL,
        line_end     INTEGER NOT NULL,
        category     TEXT    NOT NULL,
        severity     TEXT    NOT NULL,
        brief        TEXT    NOT NULL,
        confidence   REAL    NOT NULL,
        refs_json    TEXT    NOT NULL DEFAULT '[]',
        produced_at  INTEGER NOT NULL,
        read_at      INTEGER,
        stale        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (id, workspace_id)
      );

      CREATE INDEX IF NOT EXISTS seeds_file ON seeds(file_path, workspace_id);

      CREATE TABLE IF NOT EXISTS schedule_queue (
        id           TEXT    NOT NULL PRIMARY KEY,
        file_path    TEXT    NOT NULL,
        priority     INTEGER NOT NULL DEFAULT 0,
        enqueued_at  INTEGER NOT NULL,
        processing   INTEGER NOT NULL DEFAULT 0,
        workspace_id TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS queue_priority ON schedule_queue(priority DESC, enqueued_at ASC);

      CREATE TABLE IF NOT EXISTS mcp_sessions (
        session_id   TEXT    NOT NULL PRIMARY KEY,
        workspace_id TEXT    NOT NULL,
        started_at   INTEGER NOT NULL,
        api_key_hash TEXT    NOT NULL DEFAULT ''
      );
    `);
  }

  private get store(): Database {
    if (!this.db) throw new Error('LocalStore not initialised — call init() first');
    return this.db;
  }

  // ── File records ────────────────────────────────────────────────────────────

  upsertFile(path: string, workspaceId: string, contentHash: string): void {
    this.store.run(
      `INSERT INTO files (path, workspace_id, content_hash, indexed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(path, workspace_id) DO UPDATE SET
         content_hash = excluded.content_hash,
         indexed_at   = excluded.indexed_at`,
      [path, workspaceId, contentHash, Date.now()],
    );
  }

  getFile(path: string): FileRecord | null {
    return (this.store.query(
      'SELECT path, workspace_id, content_hash, indexed_at FROM files WHERE path = ? LIMIT 1',
    ).get(path) as FileRecord | null) ?? null;
  }

  // ── Seed records ────────────────────────────────────────────────────────────

  upsertSeed(seed: Omit<SeedRecord, 'read_at'> & { read_at?: number | null }): void {
    this.store.run(
      `INSERT INTO seeds
         (id, workspace_id, file_path, line_start, line_end, category, severity,
          brief, confidence, refs_json, produced_at, read_at, stale)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id, workspace_id) DO UPDATE SET
         file_path   = excluded.file_path,
         line_start  = excluded.line_start,
         line_end    = excluded.line_end,
         category    = excluded.category,
         severity    = excluded.severity,
         brief       = excluded.brief,
         confidence  = excluded.confidence,
         refs_json   = excluded.refs_json,
         produced_at = excluded.produced_at,
         stale       = excluded.stale`,
      [
        seed.id,
        seed.workspace_id,
        seed.file_path,
        seed.line_start,
        seed.line_end,
        seed.category,
        seed.severity,
        seed.brief,
        seed.confidence,
        seed.refs_json,
        seed.produced_at,
        seed.read_at ?? null,
        seed.stale ? 1 : 0,
      ],
    );
  }

  getSeedsForFile(filePath: string): SeedRecord[] {
    const rows = this.store.query(
      `SELECT id, workspace_id, file_path, line_start, line_end, category, severity,
              brief, confidence, refs_json, produced_at, read_at, stale
       FROM seeds WHERE file_path = ? ORDER BY line_start`,
    ).all(filePath) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: r['id'] as string,
      workspace_id: r['workspace_id'] as string,
      file_path: r['file_path'] as string,
      line_start: r['line_start'] as number,
      line_end: r['line_end'] as number,
      category: r['category'] as string,
      severity: r['severity'] as string,
      brief: r['brief'] as string,
      confidence: r['confidence'] as number,
      refs_json: r['refs_json'] as string,
      produced_at: r['produced_at'] as number,
      read_at: r['read_at'] as number | null,
      stale: !!(r['stale'] as number),
    }));
  }

  /** Return non-stale seeds for a file, ordered by severity. */
  getCachedSeeds(filePath: string): SeedRecord[] {
    const rows = this.store.query(
      `SELECT id, workspace_id, file_path, line_start, line_end, category, severity,
              brief, confidence, refs_json, produced_at, read_at, stale
       FROM seeds
       WHERE file_path = ? AND stale = 0
       ORDER BY
         CASE severity
           WHEN 'CRITICAL' THEN 0
           WHEN 'HIGH'     THEN 1
           WHEN 'MEDIUM'   THEN 2
           WHEN 'LOW'      THEN 3
           ELSE 4
         END,
         line_start`,
    ).all(filePath) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: r['id'] as string,
      workspace_id: r['workspace_id'] as string,
      file_path: r['file_path'] as string,
      line_start: r['line_start'] as number,
      line_end: r['line_end'] as number,
      category: r['category'] as string,
      severity: r['severity'] as string,
      brief: r['brief'] as string,
      confidence: r['confidence'] as number,
      refs_json: r['refs_json'] as string,
      produced_at: r['produced_at'] as number,
      read_at: r['read_at'] as number | null,
      stale: !!(r['stale'] as number),
    }));
  }

  markSeedsStale(filePaths: string[]): void {
    if (filePaths.length === 0) return;
    const placeholders = filePaths.map(() => '?').join(',');
    this.store.run(
      `UPDATE seeds SET stale = 1 WHERE file_path IN (${placeholders})`,
      filePaths,
    );
  }

  markSeedRead(seedId: string): void {
    this.store.run(
      'UPDATE seeds SET read_at = ? WHERE id = ?',
      [Date.now(), seedId],
    );
  }

  // ── Schedule queue ──────────────────────────────────────────────────────────

  enqueue(filePath: string, priority: number, workspaceId: string): void {
    const id = `${workspaceId}::${filePath}`;
    this.store.run(
      `INSERT INTO schedule_queue (id, file_path, priority, enqueued_at, processing, workspace_id)
       VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET
         priority    = MAX(excluded.priority, schedule_queue.priority),
         enqueued_at = MIN(excluded.enqueued_at, schedule_queue.enqueued_at),
         processing  = 0`,
      [id, filePath, priority, Date.now(), workspaceId],
    );
  }

  dequeue(limit: number): QueueItem[] {
    const rows = this.store.query(
      `SELECT id, file_path, priority, enqueued_at, processing, workspace_id
       FROM schedule_queue
       WHERE processing = 0
       ORDER BY priority DESC, enqueued_at ASC
       LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: r['id'] as string,
      file_path: r['file_path'] as string,
      priority: r['priority'] as number,
      enqueued_at: r['enqueued_at'] as number,
      processing: !!(r['processing'] as number),
      workspace_id: r['workspace_id'] as string,
    }));
  }

  // ── Freshness ───────────────────────────────────────────────────────────────

  getFreshness(filePath: string): Freshness {
    const row = this.store.query(
      'SELECT indexed_at FROM files WHERE path = ? LIMIT 1',
    ).get(filePath) as { indexed_at: number } | null;

    if (!row) {
      return { fresh: false, age_ms: Infinity, stale: true };
    }

    const age_ms = Date.now() - row.indexed_at;
    const hasStaleSeeds = !!(this.store.query(
      'SELECT 1 FROM seeds WHERE file_path = ? AND stale = 1 LIMIT 1',
    ).get(filePath));

    return {
      fresh: age_ms <= FRESH_WINDOW_MS && !hasStaleSeeds,
      age_ms,
      stale: hasStaleSeeds,
    };
  }

  // ── Sessions ─────────────────────────────────────────────────────────────────

  upsertSession(session: SessionRecord): void {
    this.store.run(
      `INSERT INTO mcp_sessions (session_id, workspace_id, started_at, api_key_hash)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         api_key_hash = excluded.api_key_hash`,
      [session.session_id, session.workspace_id, session.started_at, session.api_key_hash],
    );
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
