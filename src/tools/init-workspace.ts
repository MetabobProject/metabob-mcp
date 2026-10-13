// Contract (input schema, behaviour): SPEC §init_workspace
import { z } from 'zod';
import { readdir, readFile, stat } from 'fs/promises';
import { join, extname, dirname, resolve } from 'path';
import type { AnalysisAPIClient } from '../api-client.js';
import { getLocalIndex } from '../local-index.js';
import type { LocalStore } from '../local-store.js';

export const InitWorkspaceTool = {
  name: 'init_workspace',
  description:
    'Parse and index the WHOLE workspace into the local CPG in one call (local tools like predict_cochanges, ' +
    'analyze_impact and assign_git_changes work immediately after), and incrementally sync the most relevant ' +
    'files to the analysis server (one batch per call). ' +
    'Pass recently_changed_files to prioritise those files and their co-change neighbours in the sync batch. ' +
    'Call repeatedly with sync_api:true to continue submitting API batches; local coverage is complete after the first call. ' +
    'Analysis may remain pending for a while after submission, so agents should prefer async follow-up when working with Metabob.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      workspace_path: {
        type: 'string',
        description: 'Absolute path to workspace root (defaults to $WORKSPACE_PATH or cwd)',
      },
      recently_changed_files: {
        type: 'array',
        description: 'Files changed in the current session — these and their CPG neighbours are submitted first',
        items: { type: 'string' },
      },
      batch_size: {
        type: 'number',
        description: 'Number of files to submit to the analysis server per call (default: 20, max: 20). Local indexing always covers the whole workspace regardless.',
        default: 20,
      },
      include: {
        type: 'array',
        description: 'File extensions to include (default: ts, tsx, js, jsx, mjs, cjs, py)',
        items: { type: 'string' },
      },
      exclude: {
        type: 'array',
        description: 'Directory names to skip (default: node_modules, .git, dist, build, .next, coverage)',
        items: { type: 'string' },
      },
      sync_api: {
        type: 'boolean',
        description: 'Sync a batch with the analysis server (default: true). false = pure local indexing, no API call.',
      },
    },
  },
};

export const InputSchema = z.object({
  workspace_path: z.string().optional(),
  recently_changed_files: z.array(z.string()).optional(),
  batch_size: z.number().int().min(1).max(20).default(20),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  sync_api: z.boolean().default(true),
});

export type InitWorkspaceInput = z.infer<typeof InputSchema>;

/**
 * Wall-clock budget for local parsing in ONE call.
 *
 * Sized so an ordinary repository finishes in a single call — this one (101
 * files) takes ~2.3s, and 500 real source files take ~14.6s — while a monorepo
 * large enough to hang the call instead stops, reports, and resumes on the next
 * one. A time budget rather than a file count because per-file cost grows with
 * the graph, so N files is not a fixed amount of work.
 */
const PARSE_BUDGET_MS = 20_000;

const DEFAULT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
const DEFAULT_EXCLUDE = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.turbo', '.cache', '__pycache__', '.venv', 'venv', 'vendor',
]);

// Scan directory for eligible paths only — no file reading.
async function scanPaths(
  dir: string,
  extensions: Set<string>,
  excludeDirs: Set<string>,
  out: Set<string>,
  limit = 2000,
): Promise<void> {
  if (out.size >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.size >= limit) break;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!excludeDirs.has(entry.name) && !entry.name.startsWith('.')) {
        await scanPaths(full, extensions, excludeDirs, out, limit);
      }
    } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
      out.add(full);
    }
  }
}

// Read a file, returning null if it's too large or unreadable.
async function readSourceFile(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    if (s.size > 200_000) return null;
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Rank all file paths by relevance to the recently changed set.
 * Tier 1 — the changed files themselves
 * Tier 2 — CPG co-change predictions for those files
 * Tier 3 — files in the same directories as changed files
 * Tier 4 — everything else (stable alphabetical order for deterministic progress)
 */
function rankByRelevance(
  allPaths: Set<string>,
  recentlyChanged: string[],
  cochangePaths: Set<string>,
): string[] {
  const changedSet = new Set(recentlyChanged);
  const changedDirs = new Set(recentlyChanged.map(f => dirname(f)));

  const tier1: string[] = [];
  const tier2: string[] = [];
  const tier3: string[] = [];
  const tier4: string[] = [];

  for (const path of allPaths) {
    if (changedSet.has(path)) { tier1.push(path); continue; }
    if (cochangePaths.has(path)) { tier2.push(path); continue; }
    if (changedDirs.has(dirname(path))) { tier3.push(path); continue; }
    tier4.push(path);
  }

  tier4.sort();
  return [...tier1, ...tier2, ...tier3, ...tier4];
}

export async function handle(
  input: InitWorkspaceInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  const startTime = Date.now();
  const workspacePath = resolve(input.workspace_path ?? process.env.WORKSPACE_PATH ?? process.cwd());
  const extensions = input.include
    ? new Set(input.include.map(e => (e.startsWith('.') ? e : `.${e}`)))
    : DEFAULT_EXTENSIONS;
  const excludeDirs = input.exclude ? new Set(input.exclude) : DEFAULT_EXCLUDE;

  const localIndex = getLocalIndex();
  await localIndex.init();

  // ── Scan paths only — O(total_files) of cheap FS readdir calls ───────────────
  const allPaths = new Set<string>();
  await scanPaths(workspacePath, extensions, excludeDirs, allPaths);

  if (allPaths.size === 0) {
    return `No indexable files found under ${workspacePath}.\nCheck the path and extensions: ${[...extensions].join(', ')}.`;
  }

  await localIndex.setWorkspace(workspacePath, allPaths.size);

  // Bind the store to the SAME root the index just adopted. Without this the
  // store falls back to WORKSPACE_PATH/cwd while record_finding stamps seeds
  // with activeWorkspacePath() — the root set on the line above. Whenever the
  // two differ (init_workspace({workspace_path: …}), the documented way to
  // point at a repo other than the launch directory) every seed is written
  // under one workspace and read under another, so get_problems returns
  // nothing and the finding is silently unrecallable.
  localStore?.setWorkspaceScope(workspacePath);

  // Resolve against the workspace root — a relative path left as-is would be
  // read against the SERVER's cwd and index a different repo's file into this
  // workspace's graph.
  const recentlyChanged = (input.recently_changed_files ?? []).map(f => resolve(workspacePath, f));

  // ── Parse + index the workspace locally — decoupled from API batching ───────
  // One call covers the whole workspace for any ordinary repository, so the
  // local tools (predict_cochanges, analyze_impact, assign_git_changes) stop
  // operating on a partial index.
  //
  // Bounded by wall clock, not by faith. Parsing is NOT flatly cheap: addFile
  // scans the accumulated node set, so per-file cost grows with the graph.
  // Measured on real sources: 100 files 2.3s, 250 files 5.3s, 500 files 14.6s —
  // 2x the files for 2.75x the time. Unbounded, a large monorepo would hang the
  // first call of every session, and the index is not persisted across them.
  // So parse until the budget is spent, then stop and SAY so; the next call
  // resumes where this one stopped (isParsed skips what is already done),
  // exactly as API submission is already resumable.
  let newComponents = 0;
  const languages = new Set<string>();
  const parseDeadline = Date.now() + PARSE_BUDGET_MS;
  let parseBudgetSpent = false;

  for (const path of allPaths) {
    const ext = extname(path).toLowerCase();
    if (['.ts', '.tsx'].includes(ext)) languages.add('typescript');
    else if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) languages.add('javascript');
    else if (ext === '.py') languages.add('python');

    if (localIndex.isParsed(path)) continue;
    if (Date.now() >= parseDeadline) { parseBudgetSpent = true; break; }
    const content = await readSourceFile(path);
    if (content === null) continue; // too large / unreadable — reported via coverage below
    try {
      const r = await localIndex.predictor.addFile(path, content);
      newComponents += r.componentsAdded;
    } catch { /* skip unparseable */ }
    localIndex.recordImports(path, content);
    localIndex.markParsed(path);
  }

  // ── Co-change ranking for API prioritisation (index is already complete) ─────
  const cochangePaths = new Set<string>();
  if (recentlyChanged.length > 0) {
    const allIds: string[] = [];
    for (const f of recentlyChanged) allIds.push(...localIndex.componentIdsForFile(f));
    if (allIds.length > 0) {
      try {
        const preds = await localIndex.predictor.predictCochanges(allIds, 20);
        for (const p of preds) { if (p.filePath) cochangePaths.add(p.filePath); }
      } catch { /* non-fatal */ }
    }
  }

  // ── API sync: pick batch (rank → filter submitted → slice) and submit ────────
  let submitted: string[] = [];
  let syncStatus = 'skipped (sync_api:false — local index only)';
  let remaining = 0;

  if (input.sync_api) {
    const ranked = rankByRelevance(allPaths, recentlyChanged, cochangePaths);
    const unsubmitted = ranked.filter(p => !localIndex.isSubmitted(p));
    const batch = unsubmitted.slice(0, input.batch_size);
    remaining = unsubmitted.length - batch.length;

    if (batch.length === 0) {
      syncStatus = `all ${localIndex.submittedCount()} files already submitted`;
    } else {
      try {
        const fileList: Array<{ path: string; content: string }> = [];
        for (const p of batch) {
          const content = await readSourceFile(p);
          if (content !== null) fileList.push({ path: p, content });
        }

        if (fileList.length > 0) {
          const result = await apiClient.submitFiles(fileList, sessionId);
          localIndex.markSubmitted(batch);
          submitted = batch;

          // Persist detection seeds returned synchronously at submit time —
          // this is what fills the sidecar cache that get_problems and
          // predict_cochanges read (the vessel cannot read our filesystem).
          if (localStore && result.results) {
            const now = Date.now();
            for (const r of result.results) {
              try {
                localStore.upsertSeed({
                  id: r.id,
                  workspace_id: workspacePath,
                  file_path: r.path,
                  line_start: r.startLine,
                  line_end: r.endLine,
                  category: r.category,
                  severity: r.severity,
                  brief: r.summary,
                  confidence: r.confidence ?? 1,
                  refs_json: '[]',
                  produced_at: now,
                  stale: false,
                });
              } catch {
                // Non-fatal: cache miss just means a live fetch later.
              }
            }
          }

          // A bare "failed" / "complete" is what made the vessel-submit
          // protocol mismatch read as a backend outage for months. The
          // per-file counts and the first reason are the only evidence the
          // agent can see — stderr is invisible to an MCP client.
          const failedCount = result.failed ?? 0;
          const attempted = (result.submitted ?? 0) + failedCount;
          const firstFailure = result.failures?.[0];
          const reason = firstFailure
            ? (firstFailure.reason ?? `HTTP ${firstFailure.status}`).slice(0, 160)
            : '';
          if (result.status === 'complete') {
            syncStatus = failedCount > 0
              ? `complete — ${failedCount}/${attempted} file${failedCount === 1 ? '' : 's'} not analyzed: ${reason}`
              : 'complete';
          } else if (result.jobId) {
            syncStatus = `pending (job: ${result.jobId})`;
          } else if (result.status === 'failed' && failedCount > 0) {
            syncStatus = `failed — none of the ${attempted} submitted file${attempted === 1 ? '' : 's'} were analyzed: ${reason}`;
          } else {
            syncStatus = result.status;
          }
        } else {
          syncStatus = 'skipped (no readable files in batch)';
        }

        if (remaining > 0) {
          syncStatus += ` — ${remaining} file${remaining === 1 ? '' : 's'} not yet submitted (call again to continue)`;
        }
      } catch (err) {
        const error = err as { code?: string; message?: string };
        if (error.code === 'API_TIMEOUT') {
          syncStatus =
            'response timeout — the server may still be processing this batch; prefer async follow-up with get_analysis_context or get_problems before retrying';
        } else {
          syncStatus = `failed: ${error.message ?? String(err)}`;
        }
      }
    }
  }

  const duration = Date.now() - startTime;
  const totalSubmitted = localIndex.submittedCount();

  // Honest coverage: how much of THIS workspace is actually in the local CPG.
  let parsedCount = 0;
  for (const p of allPaths) {
    if (localIndex.isParsed(p)) parsedCount++;
  }

  let text = `Workspace: ${workspacePath}\n\n`;
  text += `Local index: ${parsedCount}/${allPaths.size} files parsed`;
  if (languages.size > 0) text += ` (${[...languages].join(', ')})`;
  text += `\n`;
  const unparsed = allPaths.size - parsedCount;
  if (unparsed > 0 && parseBudgetSpent) {
    // Distinguish "ran out of time" from "cannot be parsed at all" — the first
    // is resumable and the caller must know to call again, the second is not.
    text += `  ${unparsed} file${unparsed === 1 ? '' : 's'} not yet parsed — parse budget reached, call again to continue\n`;
  } else if (unparsed > 0) {
    text += `  ${unparsed} file${unparsed === 1 ? '' : 's'} skipped (too large or unreadable)\n`;
  }
  if (newComponents > 0) text += `  New CPG components: ${newComponents}\n`;
  text += `  Total CPG components: ${localIndex.stats().componentsIndexed}\n`;
  text += `\n`;

  text += `API sync: ${totalSubmitted}/${allPaths.size} files submitted\n`;
  text += `  Status: ${syncStatus}\n`;
  if (submitted.length > 0 && remaining > 0) {
    text += `  This batch: ${submitted.map(p => p.replace(workspacePath + '/', '')).join(', ')}\n`;
  }
  if (recentlyChanged.length > 0) {
    text += `  Co-change neighbours: ${cochangePaths.size}\n`;
  }

  text += `\nDuration: ${duration}ms`;
  return text;
}
