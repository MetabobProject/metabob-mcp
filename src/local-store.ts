/**
 * LocalStore — SQLite-backed local state, always on.
 *
 * Stores problem seeds (agent-recorded findings and any seeds already on disk),
 * MCP session metadata, and the agent-resolver task/resolution queue. Tool
 * handlers read it directly; nothing here is sent off the machine.
 *
 * Database location: ~/.metabob/sidecar.db — ONE file shared by every workspace
 * on the machine, so listing reads are partitioned by the workspace this store
 * is bound to (see WorkspaceScope) and file paths are normalised into that
 * workspace's path space on both write and query.
 *
 * All writes are synchronous (both runtimes' SQLite run synchronously, src/sqlite.ts);
 * the async wrappers exist only for API symmetry with async callers.
 */

// The runtime's SQLite is loaded in init(), not at import, so the CLI loads on a
// runtime without one and names what is missing (src/sqlite.ts).
import { openSqlite, type Sqlite } from './sqlite.js';
import { configuredWorkspace } from './workspace-root.js';
import { homedir } from 'os';
import { mkdirSync, renameSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

// ── Types ─────────────────────────────────────────────────────────────────────

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

export interface SessionRecord {
  session_id: string;
  workspace_id: string;
  started_at: number; // Unix ms
  api_key_hash: string;
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

// ── Workspace scope ───────────────────────────────────────────────────────────

/**
 * The identity of the one workspace a store instance serves.
 *
 * `~/.metabob/sidecar.db` is shared by every workspace on the machine, so a read
 * that does not filter on workspace_id serves repo A's findings as repo B's.
 * Rows on disk carry more than one id format (the absolute workspace
 * path, resolveWorkspaceId()'s hash, and the sentinel 'default'), so the scope
 * carries every alias that means "here" and reads filter on the whole set. New
 * writes are normalised to `id`; the aliases exist for rows already on disk.
 */
export interface WorkspaceScope {
  /** Canonical partition key — resolveWorkspaceId()'s hash of the resolved root. */
  id: string;
  /** Absolute workspace root: the path space file_path is normalised into. */
  root: string;
  /** Every workspace_id value that denotes this workspace. */
  aliases: string[];
}

/**
 * Mirror of resolveWorkspaceId() in src/workspace.ts. Duplicated rather than
 * imported because that helper is async and every store read is synchronous;
 * tests/unit/local-store-workspace-scope.test.ts asserts the two agree, so the
 * copy cannot drift silently.
 */
export function workspaceIdHash(rootPath: string): string {
  let firstCommit = '';
  try {
    firstCommit = execSync('git rev-list --max-parents=0 HEAD', {
      cwd: rootPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not a git repo or git not available — path alone identifies the workspace.
  }
  return createHash('sha256').update(rootPath + firstCommit).digest('hex');
}

// Memoised per raw root: deriving forks git, and a test file opens dozens of stores.
const scopeCache = new Map<string, WorkspaceScope>();

function deriveScope(rawRoot: string): WorkspaceScope {
  const cached = scopeCache.get(rawRoot);
  if (cached) return cached;

  const root = resolve(rawRoot);
  const id = workspaceIdHash(root);
  const aliases = new Set<string>([id, root, rawRoot, workspaceIdHash(rawRoot)]);
  // 'default' / '' are not a real partition: rows on disk that carry them
  // belong to the workspace this process serves. Accepted on read, never written.
  aliases.add('default');
  aliases.add('');

  const scope: WorkspaceScope = { id, root, aliases: [...aliases] };
  scopeCache.set(rawRoot, scope);
  return scope;
}

// ── LocalStore ────────────────────────────────────────────────────────────────

export class LocalStore {
  private db: Sqlite | null = null;
  private dbPath: string;
  private scope: WorkspaceScope | null = null;

  constructor(dbPath?: string) {
    const metabobDir = join(homedir(), '.metabob');
    this.dbPath = dbPath ?? join(metabobDir, 'sidecar.db');
  }

  /** SQLite's own verdict that a file is no database (SQLITE_NOTADB, 26) or corrupt (SQLITE_CORRUPT, 11). */
  private static isUnreadable(err: unknown): boolean {
    const e = err as { code?: unknown; errno?: unknown; errcode?: unknown; message?: unknown };
    const primary = [e.errno, e.errcode].find((n): n is number => typeof n === 'number');
    if (primary !== undefined) return [11, 26].includes(primary & 0xff);
    if (typeof e.code === 'string' && /^SQLITE_(NOTADB|CORRUPT)/.test(e.code)) return true;
    return /file is not a database|database disk image is malformed/i.test(String(e.message ?? ''));
  }

  /** Open the database and prove SQLite can read it (the journal mode and the schema table). */
  private openReadable(): Sqlite {
    const db = openSqlite(this.dbPath);
    try {
      db.exec('PRAGMA journal_mode=WAL;');
      db.query('SELECT count(*) AS n FROM sqlite_master').get();
      return db;
    } catch (err) {
      try { db.close(); } catch { /* already unusable */ }
      throw err;
    }
  }

  /** Open (or create) the database and apply the schema. Idempotent. */
  init(): void {
    // Ensure ~/.metabob/ exists
    mkdirSync(dirname(this.dbPath), { recursive: true });

    // The store is judged by whether SQLite can read it, never by its side files' sizes: a zero-byte -wal beside a
    // non-empty -shm is how macOS's SQLite leaves a healthy store after a clean close, and SQLite rebuilds a stale
    // -shm itself. Only a store SQLite reports as no database or corrupt is set aside, renamed rather than deleted
    // so nothing is lost, and the store starts fresh. Every other error (a lock, I/O, permissions, a full disk, a
    // read-only directory) is raised as it is, with the files left in place: moving a healthy store away because
    // the disk is full would lose it the same way. Before moving it, the open is tried once more, since a server
    // launched beside this one may already have replaced the file with a fresh store.
    // @anchor store-open
    let db: Sqlite | null = null;
    try {
      db = this.openReadable();
    } catch (err) {
      if (!LocalStore.isUnreadable(err)) throw err;
      try {
        db = this.openReadable();
      } catch (again) {
        if (!LocalStore.isUnreadable(again)) throw again;
      }
    }
    if (!db) {
      const message = 'the file is not a database, or it is corrupt';
      const aside = `${this.dbPath}.unreadable-${Date.now()}`;
      for (const suffix of ['', '-wal', '-shm']) {
        try { renameSync(this.dbPath + suffix, aside + suffix); } catch { /* absent */ }
      }
      console.error(`[warn] the local store at ${this.dbPath} could not be read (${message}); it was moved to ${aside} and a new store was started`);
      db = this.openReadable();
    }
    this.db = db;
    this.db.exec('PRAGMA foreign_keys=ON;');

    this.db.exec(`
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

      -- The store keeps no file index and no send queue. A database that
      -- carries those tables loses them here, so no queued workspace paths
      -- linger on disk.
      DROP TABLE IF EXISTS schedule_queue;
      DROP TABLE IF EXISTS files;
    `);
  }

  private get store(): Sqlite {
    if (!this.db) throw new Error('LocalStore not initialised — call init() first');
    return this.db;
  }

  // ── Workspace scope ─────────────────────────────────────────────────────────

  /**
   * Bind this store to a workspace root. Optional: the scope is otherwise
   * derived on first use from WORKSPACE_PATH/cwd. init_workspace calls this
   * when the served workspace is not the launch directory; tests call it too.
   */
  setWorkspaceScope(root: string): void {
    this.scope = deriveScope(root);
  }

  /** The workspace this store partitions on. */
  workspaceScope(): WorkspaceScope {
    if (!this.scope) this.scope = deriveScope(configuredWorkspace());
    return this.scope;
  }

  /** `workspace_id IN (…)` fragment + its bind params, for every scoped read. */
  private scopeFilter(): { sql: string; params: string[] } {
    const aliases = this.workspaceScope().aliases;
    return { sql: `workspace_id IN (${aliases.map(() => '?').join(',')})`, params: aliases };
  }

  /**
   * The workspace_id a new row carries.
   *
   * The sentinels and any alias of this store's own workspace collapse to the
   * canonical id — a writer naming this workspace by its path and a reader
   * filtering by its hash must meet. A value that is genuinely another
   * workspace is stored verbatim, which is what lets a caller (and the
   * isolation tests) write a row this store deliberately cannot read.
   *
   * It does NOT rescue a writer that names a workspace this store does not
   * serve: such a row is written, reported as saved, and then invisible here.
   * Callers holding a store must take the workspace from it — see
   * src/tools/record-finding.ts, which used to take it from the LocalIndex and
   * silently lost every finding whenever the two disagreed.
   */
  private writeScopeId(given: string): string {
    const scope = this.workspaceScope();
    return scope.aliases.includes(given) ? scope.id : given;
  }

  /**
   * One path space: workspace-relative, forward slashes. Writers disagree —
   * record_finding stores relative paths, init_workspace stores whatever the
   * index returned, tool callers query with absolute paths — so a query silently
   * missed rows it named. Normalising both sides is what makes the two meet.
   * Paths outside the workspace stay absolute: they are genuinely other files.
   */
  private normalizePath(p: string): string {
    let s = p.replace(/\\/g, '/').trim();
    const root = this.workspaceScope().root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (root && (s === root || s.startsWith(root + '/'))) s = s.slice(root.length + 1);
    while (s.startsWith('./')) s = s.slice(2);
    return s;
  }

  private static mapSeed(r: Record<string, unknown>): SeedRecord {
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
        this.writeScopeId(seed.workspace_id),
        this.normalizePath(seed.file_path),
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

  /** Seeds for exactly one file (both stale and fresh), in line order. */
  getSeedsForFile(filePath: string): SeedRecord[] {
    const scope = this.scopeFilter();
    const rows = this.store.query(
      `SELECT id, workspace_id, file_path, line_start, line_end, category, severity,
              brief, confidence, refs_json, produced_at, read_at, stale
       FROM seeds WHERE file_path = ? AND ${scope.sql} ORDER BY line_start`,
    ).all(this.normalizePath(filePath), ...scope.params) as Array<Record<string, unknown>>;
    return rows.map(LocalStore.mapSeed);
  }

  /**
   * Non-stale seeds for a file, ordered by severity.
   *
   * The match is a SUBSTRING match, which is what get_problems' `file_path`
   * input has always documented; an exact compare made that description false
   * and — because the two sides store different path spaces — made a relative
   * query against an absolute-stored row return nothing at all. An empty query
   * selects nothing rather than everything: "no filter" is the caller's job.
   */
  getCachedSeeds(filePath: string): SeedRecord[] {
    const needle = this.normalizePath(filePath);
    if (needle === '') return [];
    const scope = this.scopeFilter();
    const rows = this.store.query(
      `SELECT id, workspace_id, file_path, line_start, line_end, category, severity,
              brief, confidence, refs_json, produced_at, read_at, stale
       FROM seeds
       WHERE instr(file_path, ?) > 0 AND stale = 0 AND ${scope.sql}
       ORDER BY
         CASE severity
           WHEN 'CRITICAL' THEN 0
           WHEN 'HIGH'     THEN 1
           WHEN 'MEDIUM'   THEN 2
           WHEN 'LOW'      THEN 3
           ELSE 4
         END,
         line_start`,
    ).all(needle, ...scope.params) as Array<Record<string, unknown>>;
    return rows.map(LocalStore.mapSeed);
  }

  /** Return all non-stale seeds for this workspace, ordered by severity. */
  getAllCachedSeeds(): SeedRecord[] {
    const scope = this.scopeFilter();
    const rows = this.store.query(
      `SELECT id, workspace_id, file_path, line_start, line_end, category, severity,
              brief, confidence, refs_json, produced_at, read_at, stale
       FROM seeds WHERE stale = 0 AND ${scope.sql}
       ORDER BY
         CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 ELSE 4 END,
         file_path, line_start`,
    ).all(...scope.params) as Array<Record<string, unknown>>;
    return rows.map(LocalStore.mapSeed);
  }

  markSeedsStale(filePaths: string[]): void {
    if (filePaths.length === 0) return;
    const paths = filePaths.map(p => this.normalizePath(p));
    const scope = this.scopeFilter();
    this.store.run(
      `UPDATE seeds SET stale = 1
       WHERE file_path IN (${paths.map(() => '?').join(',')}) AND ${scope.sql}`,
      [...paths, ...scope.params],
    );
  }

  /**
   * Fetch the agent-finding seed that carries a given concept id in refs_json
   * (any workspace). `get_problems`' cross-agent recall surfaces findings by
   * their concept id, so that is often the only identifier an agent holds;
   * this maps it back to the `agf_*` seed the verdict path needs.
   *
   * Deliberately NOT workspace-scoped, unlike the listing reads: an agent
   * recalls a finding by an id that is globally unique, and mark_complete is
   * documented to accept one recorded from anywhere. Scoping here would refuse
   * ids that exist; scoping a listing read is what stops one repo's problems
   * being served as another's.
   */
  getSeedByConceptRef(conceptId: string): SeedRecord | null {
    // Normalise here rather than in each caller: concept-db returns the same id
    // bare in one response and ⟨⟩-wrapped in the next, so BOTH forms are on disk
    // in refs_json and both are handed to agents. Matching only the form the
    // caller happened to receive meant an agent holding the bare id against a
    // wrapped row found nothing — and mark_complete then reported that no local
    // seed existed while leaving the seed live, so get_problems kept surfacing a
    // finding the agent had just closed.
    // Order matters — `⟨concept:X⟩` needs the brackets off before the prefix,
    // `concept:⟨X⟩` the reverse. Mirrors plainConceptId in tools/_concept-content;
    // duplicated because the store must not import from the tool layer.
    const plain = conceptId
      .trim()
      .replace(/^concept:/, '')
      .replace(/^⟨/, '')
      .replace(/⟩$/, '')
      .replace(/^concept:/, '');
    return this.seedsByConceptRef(plain)[0] ?? null;
  }

  /**
   * EVERY seed carrying this concept id.
   *
   * record_finding writes one seed per file but a single concept listing all of
   * their `agf_*` ids, so a verdict on any one of them closes the whole finding
   * org-wide. mark_complete must therefore retire the siblings too, or the
   * finding reads closed in cross-agent recall while still sitting in the local
   * problem list — the same finding both done and not done.
   */
  getSeedsByConceptRef(conceptId: string): SeedRecord[] {
    const plain = conceptId
      .trim()
      .replace(/^concept:/, '')
      .replace(/^⟨/, '')
      .replace(/⟩$/, '')
      .replace(/^concept:/, '');
    return this.seedsByConceptRef(plain);
  }

  private seedsByConceptRef(plain: string): SeedRecord[] {
    const rows = this.store.query(
      `SELECT id, workspace_id, file_path, line_start, line_end, category, severity,
              brief, confidence, refs_json, produced_at, read_at, stale
       FROM seeds
       WHERE refs_json LIKE '%"concept:' || ? || '"%'
          OR refs_json LIKE '%"concept:⟨' || ? || '⟩"%'
       ORDER BY produced_at DESC`,
    ).all(plain, plain) as Array<Record<string, unknown>>;
    return rows.map(LocalStore.mapSeed);
  }

  /** Fetch a single seed by its globally-unique id (any workspace — see above). */
  getSeedById(seedId: string): SeedRecord | null {
    const r = this.store.query(
      `SELECT id, workspace_id, file_path, line_start, line_end, category, severity,
              brief, confidence, refs_json, produced_at, read_at, stale
       FROM seeds WHERE id = ? LIMIT 1`,
    ).get(seedId) as Record<string, unknown> | null;
    return r ? LocalStore.mapSeed(r) : null;
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

/**
 * Age tag for a listing of cached seeds: `[cache: Ns old]`, dated from the
 * oldest seed's `produced_at`, with `, stale` when any listed seed is resolved.
 * '' for an empty listing.
 */
export function seedCacheTag(seeds: SeedRecord[]): string {
  if (seeds.length === 0) return '';
  const oldest = Math.min(...seeds.map(s => s.produced_at));
  const ageSec = Math.max(0, Math.round((Date.now() - oldest) / 1000));
  return `[cache: ${ageSec}s old${seeds.some(s => s.stale) ? ', stale' : ''}]`;
}
