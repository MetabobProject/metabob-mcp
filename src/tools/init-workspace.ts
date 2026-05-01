import { z } from 'zod';
import { readdir, readFile, stat } from 'fs/promises';
import { join, extname, dirname } from 'path';
import type { AnalysisAPIClient } from '../api-client.js';
import { getLocalIndex } from '../local-index.js';

export const InitWorkspaceTool = {
  name: 'init_workspace',
  description:
    'Initialize the local CPG index and incrementally sync the most relevant files to the analysis server. ' +
    'Pass recently_changed_files to prioritise those files and their co-change neighbours in the sync batch. ' +
    'Call repeatedly as you work to keep the server up to date — each call submits one small batch.',
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

async function scanFiles(
  dir: string,
  extensions: Set<string>,
  excludeDirs: Set<string>,
  out: Map<string, string>,
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
        await scanFiles(full, extensions, excludeDirs, out, limit);
      }
    } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
      try {
        const s = await stat(full);
        if (s.size <= 200_000) {
          out.set(full, await readFile(full, 'utf-8'));
        }
      } catch {
        // skip unreadable files
      }
    }
  }
}

/**
 * Rank all scanned files by relevance to the recently changed set.
 * Tier 1 — the changed files themselves
 * Tier 2 — CPG co-change predictions for those files
 * Tier 3 — files in the same directories as changed files
 * Tier 4 — everything else (stable order so repeated calls make progress)
 */
function rankByRelevance(
  files: Map<string, string>,
  recentlyChanged: string[],
  cochangePaths: Set<string>,
): string[] {
  const changedSet = new Set(recentlyChanged);
  const changedDirs = new Set(recentlyChanged.map(f => dirname(f)));

  const tier1: string[] = [];
  const tier2: string[] = [];
  const tier3: string[] = [];
  const tier4: string[] = [];

  for (const path of files.keys()) {
    if (changedSet.has(path)) { tier1.push(path); continue; }
    if (cochangePaths.has(path)) { tier2.push(path); continue; }
    if (changedDirs.has(dirname(path))) { tier3.push(path); continue; }
    tier4.push(path);
  }

  // Tier 4 alphabetically so successive calls step through the codebase predictably
  tier4.sort();
  return [...tier1, ...tier2, ...tier3, ...tier4];
}

export async function handle(
  input: InitWorkspaceInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
): Promise<string> {
  const startTime = Date.now();
  const workspacePath = input.workspace_path ?? process.env.WORKSPACE_PATH ?? process.cwd();
  const extensions = input.include
    ? new Set(input.include.map(e => (e.startsWith('.') ? e : `.${e}`)))
    : DEFAULT_EXTENSIONS;
  const excludeDirs = input.exclude ? new Set(input.exclude) : DEFAULT_EXCLUDE;

  // ── Local CPG indexing (always — all files) ────────────────────────────────
  const localIndex = getLocalIndex();
  await localIndex.init();

  const files = new Map<string, string>();
  await scanFiles(workspacePath, extensions, excludeDirs, files);

  if (files.size === 0) {
    return `No indexable files found under ${workspacePath}.\nCheck the path and extensions: ${[...extensions].join(', ')}.`;
  }

  let newComponents = 0;
  for (const [path, content] of files) {
    try {
      const result = await localIndex.predictor.addFile(path, content);
      newComponents += result.componentsAdded;
    } catch {
      // skip unparseable files
    }
  }
  localIndex.setWorkspace(workspacePath, files.size);

  const languages = new Set<string>();
  for (const path of files.keys()) {
    const ext = extname(path).toLowerCase();
    if (['.ts', '.tsx'].includes(ext)) languages.add('typescript');
    else if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) languages.add('javascript');
    else if (ext === '.py') languages.add('python');
  }

  // ── Determine CPG co-change neighbours of recently changed files ───────────
  const recentlyChanged = input.recently_changed_files ?? [];
  const cochangePaths = new Set<string>();

  if (recentlyChanged.length > 0 && localIndex.isReady()) {
    const allIds: string[] = [];
    for (const f of recentlyChanged) {
      allIds.push(...localIndex.componentIdsForFile(f));
    }
    if (allIds.length > 0) {
      try {
        const preds = await localIndex.predictor.predictCochanges(allIds, 20);
        for (const p of preds) {
          if (p.filePath) cochangePaths.add(p.filePath);
        }
      } catch {
        // non-fatal
      }
    }
  }

  // ── Incremental API sync — submit one ranked batch ─────────────────────────
  let submitted: string[] = [];
  let jobId: string | null = null;
  let syncStatus = 'skipped';

  if (input.sync_api) {
    const ranked = rankByRelevance(files, recentlyChanged, cochangePaths);
    const batch = ranked.slice(0, input.batch_size);
    const remaining = ranked.length - batch.length;

    try {
      const fileList = batch.map(path => ({ path, content: files.get(path)! }));
      const result = await apiClient.submitFiles(fileList, sessionId);

      submitted = batch;
      if (result.status === 'complete') {
        syncStatus = 'complete';
      } else if (result.jobId) {
        jobId = result.jobId;
        syncStatus = `pending (job: ${result.jobId})`;
      } else {
        syncStatus = result.status;
      }

      if (remaining > 0) {
        syncStatus += ` — ${remaining} file${remaining === 1 ? '' : 's'} not yet submitted (call again to continue)`;
      }
    } catch (err) {
      syncStatus = `failed: ${(err as Error).message}`;
    }
  }

  const duration = Date.now() - startTime;

  let text = `Workspace: ${workspacePath}\n\n`;
  text += `Local CPG index\n`;
  text += `  Files scanned:   ${files.size}\n`;
  text += `  New components:  ${newComponents}\n`;
  text += `  Languages:       ${[...languages].join(', ')}\n\n`;

  text += `API sync (batch ${input.batch_size})\n`;
  text += `  Status:   ${syncStatus}\n`;
  if (submitted.length > 0) {
    text += `  Submitted (${submitted.length}):\n`;
    for (const p of submitted) text += `    ${p}\n`;
  }
  if (recentlyChanged.length > 0) {
    text += `  Co-change neighbours included: ${cochangePaths.size}\n`;
  }

  text += `\nDuration: ${duration}ms`;
  return text;
}
