import { z } from 'zod';
import { readdir, readFile, stat } from 'fs/promises';
import { join, extname, dirname, resolve } from 'path';
import type { AnalysisAPIClient } from '../api-client.js';
import { getLocalIndex } from '../local-index.js';

export const InitWorkspaceTool = {
  name: 'init_workspace',
  description:
    'Initialize the local CPG index and incrementally sync the most relevant files to the analysis server. ' +
    'Pass recently_changed_files to prioritise those files and their co-change neighbours in the sync batch. ' +
    'Call repeatedly as you work to keep the server up to date — each call submits one small batch. ' +
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
        description: 'Number of files to submit to the analysis server per call (default: 5, max: 20)',
        default: 5,
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
        description: 'Sync a batch with the analysis server (default: true)',
      },
    },
  },
};

export const InputSchema = z.object({
  workspace_path: z.string().optional(),
  recently_changed_files: z.array(z.string()).optional(),
  batch_size: z.number().int().min(1).max(20).default(5),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  sync_api: z.boolean().default(true),
});

export type InitWorkspaceInput = z.infer<typeof InputSchema>;

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

  // Resolve against the workspace root — a relative path left as-is would be
  // read against the SERVER's cwd and index a different repo's file into this
  // workspace's graph.
  const recentlyChanged = (input.recently_changed_files ?? []).map(f => resolve(workspacePath, f));

  // ── Ensure recently-changed files are parsed so co-change ranking works ──────
  const cochangePaths = new Set<string>();
  if (recentlyChanged.length > 0) {
    for (const f of recentlyChanged) {
      if (!localIndex.isParsed(f)) {
        const content = await readSourceFile(f);
        if (content !== null) {
          try {
            await localIndex.predictor.addFile(f, content);
          } catch { /* skip unparseable */ }
          localIndex.recordImports(f, content);
          localIndex.markParsed(f);
        }
      }
    }
    const allIds: string[] = [];
    for (const f of recentlyChanged) allIds.push(...localIndex.componentIdsForFile(f));
    if (allIds.length > 0) {
      try {
        const preds = await localIndex.predictor.predictCochanges(allIds, 20);
        for (const p of preds) { if (p.filePath) cochangePaths.add(p.filePath); }
      } catch { /* non-fatal */ }
    }
  }

  // ── Pick batch: rank → filter submitted → slice ───────────────────────────────
  const ranked = rankByRelevance(allPaths, recentlyChanged, cochangePaths);
  const unsubmitted = ranked.filter(p => !localIndex.isSubmitted(p));
  const batch = unsubmitted.slice(0, input.batch_size);
  const remaining = unsubmitted.length - batch.length;

  // ── Parse + index only the batch files — O(batch_size) of CPG work ───────────
  let newComponents = 0;
  const languages = new Set<string>();
  const batchContents = new Map<string, string>();

  for (const path of batch) {
    const ext = extname(path).toLowerCase();
    if (['.ts', '.tsx'].includes(ext)) languages.add('typescript');
    else if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) languages.add('javascript');
    else if (ext === '.py') languages.add('python');

    if (!localIndex.isParsed(path)) {
      const content = await readSourceFile(path);
      if (content !== null) {
        batchContents.set(path, content);
        try {
          const r = await localIndex.predictor.addFile(path, content);
          newComponents += r.componentsAdded;
        } catch { /* skip unparseable */ }
        localIndex.recordImports(path, content);
        localIndex.markParsed(path);
      }
    } else {
      // Already in CPG — still need content for API submission
      const content = await readSourceFile(path);
      if (content !== null) batchContents.set(path, content);
    }
  }

  // ── API sync ──────────────────────────────────────────────────────────────────
  let submitted: string[] = [];
  let syncStatus = 'skipped';

  if (input.sync_api) {
    if (batch.length === 0) {
      syncStatus = `all ${localIndex.submittedCount()} files already submitted`;
    } else {
      try {
        const fileList = batch
          .filter(p => batchContents.has(p))
          .map(p => ({ path: p, content: batchContents.get(p)! }));

        if (fileList.length > 0) {
          const result = await apiClient.submitFiles(fileList, sessionId);
          localIndex.markSubmitted(batch);
          submitted = batch;

          if (result.status === 'complete') {
            syncStatus = 'complete';
          } else if (result.jobId) {
            syncStatus = `pending (job: ${result.jobId})`;
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

  let text = `Workspace: ${workspacePath}\n\n`;
  text += `Files scanned: ${allPaths.size}`;
  if (languages.size > 0) text += ` (${[...languages].join(', ')})`;
  text += `\n`;
  if (newComponents > 0) text += `New CPG components: ${newComponents}\n`;
  text += `\n`;

  text += `API sync\n`;
  text += `  Status:   ${syncStatus}\n`;
  text += `  Progress: ${totalSubmitted}/${allPaths.size} files submitted\n`;
  if (submitted.length > 0 && remaining > 0) {
    text += `  This batch: ${submitted.map(p => p.replace(workspacePath + '/', '')).join(', ')}\n`;
  }
  if (recentlyChanged.length > 0) {
    text += `  Co-change neighbours: ${cochangePaths.size}\n`;
  }

  text += `\nDuration: ${duration}ms`;
  return text;
}
