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

// Type-only: the runtime binding is required lazily in init() so the bundled
// CLI can load under Node for --help/--version/doctor and print an actionable
// "requires Bun" error, instead of dying at ESM load on the bun: scheme.
import type { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { mkdirSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';

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

/**
 * A task the substrate dispatched to this agent-resolver (a solicited
 * `human_input` decision). Durable and partitioned by `vessel_id` (stable per
 * apiKey+workspace) so a later session in the same workspace resumes it.
 */
export interface AgentTaskRecord {
  task_id: string; // = solicitation_id from the inbound pointer
  vessel_id: string; // cross-session partition key
  operator_id: string; // task owner (claude-code-operator)
  session_id: string; // ephemeral: the run that claimed it (non-authoritative)
  shape: string; // 'human_input'
  dispatch_id: string | null;
  question_markdown: string;
  respond_via_json: string; // {shape, heartbeat_shape}
  deadline_ms: number; // now + timeout_ms
  status: string; // 'pending' | 'claimed' | 'resolved'
  enqueued_at: number;
  claimed_at: number | null;
}

/**
 * The agent's answer to an AgentTaskRecord, recorded BEFORE delivery so it
 * survives a failed post-back / dead network and is retried on a later session
 * (delivered=0 until the substrate confirms receipt).
 */
export interface AgentResolutionRecord {
  task_id: string;
  vessel_id: string;
  outcome: string; // 'answered' | 'declined' | 'insufficient_context'
  answer: string | null;
  delivered: number; // 0 | 1
  attempts: number;
  last_attempt_at: number | null;
  last_error: string | null;
  created_at: number;
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
    mkdirSync(dirname(this.dbPath), { recursive: true });

    // Abrupt process kills leave a corrupted WAL state: sidecar.db-wal is
    // zero bytes but sidecar.db-shm is non-empty. Bun's SQLite cannot open
    // this. Detect the pattern and delete all three files to start fresh.
    try {
      const { statSync } = require('fs') as typeof import('fs');
      const walSize = statSync(this.dbPath + '-wal').size;
      if (walSize === 0) {
        for (const p of [this.dbPath, this.dbPath + '-wal', this.dbPath + '-shm']) {
          try { unlinkSync(p); } catch { /* already gone */ }
        }
      }
    } catch { /* -wal file doesn't exist — clean state */ }

    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
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

      CREATE TABLE IF NOT EXISTS agent_tasks (
        task_id           TEXT    NOT NULL,
        vessel_id         TEXT    NOT NULL,
        operator_id       TEXT    NOT NULL,
        session_id        TEXT    NOT NULL,
        shape             TEXT    NOT NULL,
        dispatch_id       TEXT,
        question_markdown TEXT    NOT NULL,
        respond_via_json  TEXT    NOT NULL DEFAULT '{}',
        deadline_ms       INTEGER NOT NULL,
        status            TEXT    NOT NULL DEFAULT 'pending',
        enqueued_at       INTEGER NOT NULL,
        claimed_at        INTEGER,
        PRIMARY KEY (vessel_id, task_id)
      );

      CREATE INDEX IF NOT EXISTS agent_tasks_vessel_status ON agent_tasks(vessel_id, status);

      CREATE TABLE IF NOT EXISTS agent_resolutions (
        task_id         TEXT    NOT NULL,
        vessel_id       TEXT    NOT NULL,
        outcome         TEXT    NOT NULL,
        answer          TEXT,
        delivered       INTEGER NOT NULL DEFAULT 0,
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        last_error      TEXT,
        created_at      INTEGER NOT NULL,
        PRIMARY KEY (vessel_id, task_id)
      );

      CREATE INDEX IF NOT EXISTS agent_res_undelivered ON agent_resolutions(vessel_id, delivered);
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

  /** Return all non-stale seeds across all files, ordered by severity. */
  getAllCachedSeeds(): SeedRecord[] {
    const rows = this.store.query(
      `SELECT id, workspace_id, file_path, line_start, line_end, category, severity,
              brief, confidence, refs_json, produced_at, read_at, stale
       FROM seeds WHERE stale = 0
       ORDER BY
         CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 ELSE 4 END,
         file_path, line_start`,
    ).all() as Array<Record<string, unknown>>;
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
      stale: false,
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

  /** Fetch a single seed by id (any workspace). */
  getSeedById(seedId: string): SeedRecord | null {
    const r = this.store.query(
      `SELECT id, workspace_id, file_path, line_start, line_end, category, severity,
              brief, confidence, refs_json, produced_at, read_at, stale
       FROM seeds WHERE id = ? LIMIT 1`,
    ).get(seedId) as Record<string, unknown> | null;
    if (!r) return null;
    return {
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
    };
  }

  /** Mark a single seed stale by id (resolved — stops surfacing in get_problems). */
  markSeedStaleById(seedId: string): void {
    this.store.run('UPDATE seeds SET stale = 1 WHERE id = ?', [seedId]);
  }

  /** Delete a single seed by id (retracted / false positive). */
  deleteSeed(seedId: string): void {
    this.store.run('DELETE FROM seeds WHERE id = ?', [seedId]);
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

  /** Remove a single queue item by id (called after successful or unrecoverable send). */
  removeFromQueue(id: string): void {
    this.store.run('DELETE FROM schedule_queue WHERE id = ?', [id]);
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

  // ── Agent coordination (cross-session) ───────────────────────────────────────

  private static mapTask(r: Record<string, unknown>): AgentTaskRecord {
    return {
      task_id: r['task_id'] as string,
      vessel_id: r['vessel_id'] as string,
      operator_id: r['operator_id'] as string,
      session_id: r['session_id'] as string,
      shape: r['shape'] as string,
      dispatch_id: (r['dispatch_id'] as string | null) ?? null,
      question_markdown: r['question_markdown'] as string,
      respond_via_json: r['respond_via_json'] as string,
      deadline_ms: r['deadline_ms'] as number,
      status: r['status'] as string,
      enqueued_at: r['enqueued_at'] as number,
      claimed_at: (r['claimed_at'] as number | null) ?? null,
    };
  }

  private static mapResolution(r: Record<string, unknown>): AgentResolutionRecord {
    return {
      task_id: r['task_id'] as string,
      vessel_id: r['vessel_id'] as string,
      outcome: r['outcome'] as string,
      answer: (r['answer'] as string | null) ?? null,
      delivered: r['delivered'] as number,
      attempts: r['attempts'] as number,
      last_attempt_at: (r['last_attempt_at'] as number | null) ?? null,
      last_error: (r['last_error'] as string | null) ?? null,
      created_at: r['created_at'] as number,
    };
  }

  /**
   * Durably record a task the substrate dispatched to this agent. Idempotent:
   * re-delivery of the same solicitation (same vessel_id+task_id) is a no-op, so
   * goal-host retrying the solicitation POST never double-enqueues.
   */
  enqueueAgentTask(rec: AgentTaskRecord): void {
    this.store.run(
      `INSERT INTO agent_tasks
         (task_id, vessel_id, operator_id, session_id, shape, dispatch_id,
          question_markdown, respond_via_json, deadline_ms, status, enqueued_at, claimed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(vessel_id, task_id) DO NOTHING`,
      [
        rec.task_id, rec.vessel_id, rec.operator_id, rec.session_id, rec.shape,
        rec.dispatch_id, rec.question_markdown, rec.respond_via_json, rec.deadline_ms,
        rec.status, rec.enqueued_at, rec.claimed_at,
      ],
    );
  }

  /** Un-resolved, un-expired tasks for a vessel, oldest first. */
  listPendingAgentTasks(vesselId: string, limit = 20, now = Date.now()): AgentTaskRecord[] {
    const rows = this.store.query(
      `SELECT * FROM agent_tasks
       WHERE vessel_id = ? AND status IN ('pending','claimed') AND deadline_ms > ?
       ORDER BY enqueued_at ASC LIMIT ?`,
    ).all(vesselId, now, limit) as Array<Record<string, unknown>>;
    return rows.map(LocalStore.mapTask);
  }

  getAgentTask(vesselId: string, taskId: string): AgentTaskRecord | null {
    const r = this.store.query(
      'SELECT * FROM agent_tasks WHERE vessel_id = ? AND task_id = ? LIMIT 1',
    ).get(vesselId, taskId) as Record<string, unknown> | null;
    return r ? LocalStore.mapTask(r) : null;
  }

  /** Mark a task claimed by the current session and return the fresh row. */
  claimAgentTask(vesselId: string, taskId: string, sessionId: string): AgentTaskRecord | null {
    this.store.run(
      `UPDATE agent_tasks SET status = 'claimed', session_id = ?, claimed_at = ?
       WHERE vessel_id = ? AND task_id = ? AND status != 'resolved'`,
      [sessionId, Date.now(), vesselId, taskId],
    );
    return this.getAgentTask(vesselId, taskId);
  }

  /**
   * Durably record the agent's answer (delivered=0) and flip the task to
   * resolved. Idempotent on (vessel_id, task_id).
   */
  recordResolution(rec: AgentResolutionRecord): void {
    this.store.run(
      `INSERT INTO agent_resolutions
         (task_id, vessel_id, outcome, answer, delivered, attempts, last_attempt_at, last_error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(vessel_id, task_id) DO UPDATE SET
         outcome = excluded.outcome, answer = excluded.answer`,
      [
        rec.task_id, rec.vessel_id, rec.outcome, rec.answer, rec.delivered ? 1 : 0,
        rec.attempts, rec.last_attempt_at, rec.last_error, rec.created_at,
      ],
    );
    this.store.run(
      `UPDATE agent_tasks SET status = 'resolved' WHERE vessel_id = ? AND task_id = ?`,
      [rec.vessel_id, rec.task_id],
    );
  }

  /** Answers recorded but not yet confirmed delivered to the substrate. */
  getUndeliveredResolutions(vesselId: string): AgentResolutionRecord[] {
    const rows = this.store.query(
      `SELECT * FROM agent_resolutions WHERE vessel_id = ? AND delivered = 0 ORDER BY created_at ASC`,
    ).all(vesselId) as Array<Record<string, unknown>>;
    return rows.map(LocalStore.mapResolution);
  }

  markResolutionDelivered(vesselId: string, taskId: string): void {
    this.store.run(
      `UPDATE agent_resolutions SET delivered = 1, last_attempt_at = ? WHERE vessel_id = ? AND task_id = ?`,
      [Date.now(), vesselId, taskId],
    );
  }

  /** Record a failed delivery attempt (for retry visibility / backoff). */
  bumpResolutionAttempt(vesselId: string, taskId: string, error: string): void {
    this.store.run(
      `UPDATE agent_resolutions
       SET attempts = attempts + 1, last_attempt_at = ?, last_error = ?
       WHERE vessel_id = ? AND task_id = ?`,
      [Date.now(), error.slice(0, 500), vesselId, taskId],
    );
  }

  /** Bound growth: resolve tasks whose deadline passed without an answer. */
  expireStaleTasks(vesselId: string, now = Date.now()): void {
    this.store.run(
      `UPDATE agent_tasks SET status = 'resolved'
       WHERE vessel_id = ? AND status != 'resolved' AND deadline_ms < ?`,
      [vesselId, now],
    );
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
