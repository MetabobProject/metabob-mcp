/**
 * Scheduler — three-tier send loop for sidecar mode.
 *
 * Dequeues files from the local SQLite schedule_queue (P0 > P1 > P2) every 2s,
 * builds a context bundle for each, POSTs it to the analysis API, and caches
 * the response. Handles 429 / backoff hints from the server.
 *
 * Priority tiers:
 *   P0 — cache-miss (triggered by tool read with no cached results)
 *   P1 — file/git event (triggered by watcher or git-watcher)
 *   P2 — idle background scan (only when P0+P1 queue empty and budget allows)
 *
 * P2 guard: at most 1 P2 per 10 sends; P2 paused when localSpend > $4.50.
 */

import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { extname, isAbsolute, join, relative } from 'path';
import type { LocalStore, QueueItem } from './local-store.js';
import { fetchWithBearerFallback } from './auth-header.js';
import type { Telemetry } from './telemetry.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RecentCommit {
  hash: string;
  message: string;
  files_changed: string[];
}

interface Bundle {
  request_id: string;
  file_path: string;
  excerpt: string;
  language: string;
  workspace_id: string;
  cpg_neighbors: string[];
  embedding_neighbors: string[];
  recent_commits: RecentCommit[];
  priority: number;
}

type BackoffHint = 'none' | 'reduce-proactive' | 'reduce-event' | 'reactive-only';

// ── Language map ──────────────────────────────────────────────────────────────

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  cs: 'csharp',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  c: 'c', h: 'c',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  scala: 'scala',
  sh: 'shell', bash: 'shell',
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  md: 'markdown',
  html: 'html', htm: 'html',
  css: 'css', scss: 'scss', sass: 'sass',
};

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).replace(/^\./, '').toLowerCase();
  return EXT_LANG[ext] ?? 'text';
}

// ── Context bundle builder ────────────────────────────────────────────────────

const MAX_TOKEN_ESTIMATE = 8000;
const CHARS_PER_TOKEN = 4;
const MAX_CHARS = MAX_TOKEN_ESTIMATE * CHARS_PER_TOKEN; // 32000 chars

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function readExcerpt(filePath: string): string {
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    if (lines.length <= 100) {
      // Short file: include all
      const full = content;
      if (estimateTokens(full) <= MAX_TOKEN_ESTIMATE) return full;
      return full.slice(0, MAX_CHARS);
    }

    // Larger file: try to find the last-modified area by stat mtime
    // We can't easily find it without git, so take up to 60 lines from start
    const excerpt = lines.slice(0, 60).join('\n');
    if (estimateTokens(excerpt) <= MAX_TOKEN_ESTIMATE) return excerpt;
    return excerpt.slice(0, MAX_CHARS);
  } catch {
    return '';
  }
}

/**
 * Exported for tests. argv form, never a shell string: `rel` is an arbitrary
 * workspace filename, so `git log ... -- "${rel}"` let a file named
 * `a$(touch PWNED).ts` run commands when the watcher enqueued it. The argv form
 * is also strictly more correct — a shell rewrites such a path before git sees
 * it, silently losing that file's history.
 */
export function readRecentCommits(filePath: string, workspaceRoot: string): RecentCommit[] {
  try {
    const rel = relative(workspaceRoot, filePath);
    const output = execFileSync('git', ['log', '--oneline', '-3', '--', rel], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    return output
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const spaceIdx = line.indexOf(' ');
        const hash = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
        const message = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1).trim();
        return { hash, message, files_changed: [] };
      });
  } catch {
    return [];
  }
}

async function buildBundle(
  store: LocalStore,
  filePath: string,
  workspaceRoot: string,
  workspaceId: string,
): Promise<Bundle> {
  // Resolve relative paths against workspaceRoot
  const absolutePath = isAbsolute(filePath) ? filePath : join(workspaceRoot, filePath);
  const excerpt = readExcerpt(absolutePath);
  const language = detectLanguage(filePath);
  const recent_commits = readRecentCommits(absolutePath, workspaceRoot);

  return {
    request_id: randomUUID(),
    file_path: filePath,
    excerpt,
    language,
    workspace_id: workspaceId,
    cpg_neighbors: [],
    embedding_neighbors: [],
    recent_commits,
    priority: 1,
  };
}

// ── Analysis API response shape ───────────────────────────────────────────────

interface AnalysisRunResponse {
  seeds?: Array<{
    id: string;
    file_path: string;
    line_start: number;
    line_end: number;
    category: string;
    severity: string;
    brief: string;
    confidence: number;
    refs?: string[];
  }>;
  backoff_hint?: string;
  retry_after?: number;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/**
 * How long a claimed row stays spoken-for if its send never settles. Well past
 * the 30s send ceiling, so it only ever fires on a wedged promise — re-delivery
 * is deliberate, never the default.
 */
const CLAIM_LEASE_MS = 120_000;

export class Scheduler {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /**
   * Claimed queue rows: id → lease expiry. `dequeue()` does not claim — it
   * selects `WHERE processing = 0` and nothing writes 1 — and the row is
   * deleted only after the send completes, so a 7s analysis against a 2s tick
   * re-selected the same row and POSTed the same bundle three times. The claim
   * lives here rather than in the `processing` column because LocalStore owns
   * its handle; that makes this a per-process claim, which is exactly the
   * scope of the bug (one scheduler, many ticks).
   */
  private readonly claimed = new Map<string, number>();
  private ticking = false;
  private pausedUntil = 0;                  // epoch ms — all sends paused
  private p1PausedUntil = 0;               // P1+P2 sends paused (reduce-event / reactive-only)
  private p2PausedUntil = 0;              // P2 sends paused (reduce-proactive)
  private backoffHint: BackoffHint = 'none';

  // Budget tracking (current session)
  private localSpend = 0;
  private sendCount = 0;                    // total sends this session (for P2 slice guard)
  private p2SendCount = 0;                  // P2 sends this session

  // Workspace root — resolved at start, used for relative file paths
  private workspaceRoot = '';

  constructor(
    private store: LocalStore,
    private workspaceId: string,
    private analysisApiUrl: string,
    private apiKey: string,
    private telemetry: Telemetry,
    workspaceRoot?: string,
  ) {
    this.workspaceRoot = workspaceRoot ?? process.env['WORKSPACE_PATH'] ?? process.cwd();
  }

  start(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      this.tick().catch(() => {/* non-fatal */});
    }, 2000);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    // Flush remaining P0 items synchronously (best-effort)
    this.drainP0().catch(() => {});
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /** Rows nothing is currently sending, expired leases swept. */
  private unclaimed(items: QueueItem[]): QueueItem[] {
    const now = Date.now();
    for (const [id, expiry] of this.claimed) {
      if (expiry <= now) this.claimed.delete(id);
    }
    return items.filter(i => !this.claimed.has(i.id));
  }

  /**
   * Take ownership, synchronously and before any await: a concurrent drainP0
   * must never see a row between selection and claim. Only rows we are about
   * to send are marked — a row the pause filters drop stays free for the tick
   * that can actually send it.
   */
  private claim(items: QueueItem[]): QueueItem[] {
    const expiry = Date.now() + CLAIM_LEASE_MS;
    for (const i of items) this.claimed.set(i.id, expiry);
    return items;
  }

  private async tick(): Promise<void> {
    // A send slower than the tick must not be re-entered two seconds later.
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.runTick();
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(): Promise<void> {
    const now = Date.now();
    if (this.pausedUntil > now) return;

    // Dequeue up to 3 items respecting pauses. Rows already in flight are
    // dropped before the slice so they cannot eat the per-tick budget.
    const items = this.unclaimed(this.store.dequeue(10)); // fetch more, filter below
    const toProcess = items
      .filter(item => {
        if (item.priority === 0) return true; // P0 always
        if (item.priority === 1 && this.p1PausedUntil > now) return false; // P1 paused
        if (item.priority === 2) {
          if (this.p2PausedUntil > now) return false;
          if (this.p1PausedUntil > now) return false;
          if (this.backoffHint !== 'none') return false;
          if (this.localSpend > 4.5) return false;
          // 10% slice: at most 1 P2 per 10 sends
          if (this.p2SendCount > 0 && this.p2SendCount * 10 > this.sendCount) return false;
        }
        return true;
      })
      .slice(0, 3);

    for (const item of this.claim(toProcess)) {
      await this.processItem(item.file_path, item.id, item.priority);
    }
  }

  private async drainP0(): Promise<void> {
    const items = this.claim(this.unclaimed(this.store.dequeue(50)).filter(i => i.priority === 0));
    for (const item of items) {
      await this.processItem(item.file_path, item.id, item.priority);
    }
  }

  private async processItem(filePath: string, queueId: string, priority: number): Promise<void> {
    try {
      await this.sendItem(filePath, queueId, priority);
    } finally {
      // Release the claim however this ended. A 429 leaves the row queued on
      // purpose; the next unpaused tick is then free to pick it up again.
      this.claimed.delete(queueId);
    }
  }

  private async sendItem(filePath: string, queueId: string, priority: number): Promise<void> {
    let bundle: Bundle;
    try {
      bundle = await buildBundle(this.store, filePath, this.workspaceRoot, this.workspaceId);
    } catch {
      // Remove from queue and skip
      this.removeFromQueue(queueId);
      return;
    }

    const startTime = Date.now();
    let success = false;
    let responseData: AnalysisRunResponse = {};

    try {
      let res = await fetchWithBearerFallback({
        url: `${this.analysisApiUrl}/v2/mcp/analysis/run`,
        apiKey: this.apiKey,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bundle),
          signal: AbortSignal.timeout(30000),
        },
      });

      if (res.status === 429) {
        // Rate limited — parse Retry-After
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 300;
        this.pausedUntil = Date.now() + retryAfter * 1000;
        return; // Leave item in queue
      }

      if (!res.ok) {
        // Non-retryable error — remove from queue
        this.removeFromQueue(queueId);
        return;
      }

      responseData = await res.json() as AnalysisRunResponse;
      success = true;

      // Apply backoff hint from response
      const hint = (responseData.backoff_hint ?? 'none') as BackoffHint;
      this.applyBackoffHint(hint);

      // Track approximate spend (rough heuristic: $0.001 per request)
      this.localSpend += 0.001;

    } catch {
      // Network error — remove from queue to avoid infinite retry
      this.removeFromQueue(queueId);
      return;
    }

    // Cache seeds from response
    if (success && responseData.seeds) {
      const now = Date.now();
      for (const seed of responseData.seeds) {
        try {
          this.store.upsertSeed({
            id: seed.id,
            workspace_id: this.workspaceId,
            file_path: filePath,
            line_start: seed.line_start,
            line_end: seed.line_end,
            category: seed.category,
            severity: seed.severity,
            brief: seed.brief,
            confidence: seed.confidence,
            refs_json: JSON.stringify(seed.refs ?? []),
            produced_at: now,
            stale: false,
          });
        } catch {
          // Non-fatal
        }
      }
      // Also update the file record freshness
      try {
        this.store.upsertFile(filePath, this.workspaceId, '');
      } catch {
        // Non-fatal
      }
    }

    // Remove from queue on success
    this.removeFromQueue(queueId);

    // Track send counts
    this.sendCount++;
    if (priority === 2) this.p2SendCount++;

    // Emit telemetry
    try {
      this.telemetry.record({
        tool_name: 'scheduler_send',
        success,
        duration_ms: Date.now() - startTime,
        file: filePath,
      });
    } catch {
      // Non-fatal
    }
  }

  private removeFromQueue(queueId: string): void {
    try {
      this.store.removeFromQueue(queueId);
    } catch {
      // Non-fatal — store may be closed during shutdown
    }
  }

  private applyBackoffHint(hint: BackoffHint): void {
    this.backoffHint = hint;
    const now = Date.now();
    switch (hint) {
      case 'reduce-proactive':
        // Pause P2 for 60s
        this.p2PausedUntil = now + 60_000;
        break;
      case 'reduce-event':
        // Pause P1+P2 for 120s
        this.p1PausedUntil = now + 120_000;
        this.p2PausedUntil = now + 120_000;
        break;
      case 'reactive-only':
        // Pause P1+P2 for 300s, reset localSpend on clearance
        this.p1PausedUntil = now + 300_000;
        this.p2PausedUntil = now + 300_000;
        // Reset budget when we come back online
        setTimeout(() => {
          this.localSpend = 0;
          this.backoffHint = 'none';
        }, 300_000);
        break;
      case 'none':
        // Clear pauses
        this.p2PausedUntil = 0;
        this.p1PausedUntil = 0;
        break;
    }
  }
}
