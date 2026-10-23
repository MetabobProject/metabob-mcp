// Contract (input schema, behaviour): SPEC §init_workspace
import { z } from 'zod';
import { readdir, readFile, stat } from 'fs/promises';
import { join, extname, resolve } from 'path';
import type { AnalysisAPIClient } from '../api-client.js';
import { getLocalIndex, LocalIndexUnavailable } from '../local-index.js';
import { configuredWorkspace } from '../workspace-root.js';
import type { LocalStore } from '../local-store.js';

export const InitWorkspaceTool = {
  name: 'init_workspace',
  description:
    'Parse and index the WHOLE workspace into the local CPG in one call (local tools like predict_cochanges, ' +
    'analyze_impact, assign_git_changes and search_codebase work immediately after). ' +
    'Indexing is local: no file content leaves the machine and there is no server-side analysis to wait for. ' +
    'Pass recently_changed_files to report their co-change neighbours. ' +
    'A very large workspace may need a second call to finish parsing; the output says so.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      workspace_path: {
        type: 'string',
        description: 'Absolute path to workspace root (defaults to $WORKSPACE_PATH or cwd)',
      },
      recently_changed_files: {
        type: 'array',
        description: 'Files changed in the current session — the output reports how many co-change neighbours they have',
        items: { type: 'string' },
      },
      batch_size: {
        type: 'number',
        description: 'Accepted and ignored: init_workspace sends no files anywhere, and local indexing covers the whole workspace.',
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
        description: 'Accepted and ignored: init_workspace sends no files anywhere, whatever its value.',
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

export async function handle(
  input: InitWorkspaceInput,
  _apiClient: AnalysisAPIClient,
  _sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  const startTime = Date.now();
  const workspacePath = resolve(input.workspace_path ?? configuredWorkspace());
  const extensions = input.include
    ? new Set(input.include.map(e => (e.startsWith('.') ? e : `.${e}`)))
    : DEFAULT_EXTENSIONS;
  const excludeDirs = input.exclude ? new Set(input.exclude) : DEFAULT_EXCLUDE;

  const localIndex = getLocalIndex();
  try {
    await localIndex.init();
  } catch (err) {
    // A native module that cannot load stops the local code tools only, and says which one.
    if (err instanceof LocalIndexUnavailable) return err.message;
    throw err;
  }

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

  // ── Parse + index the workspace locally ─────────────────────────────────────
  // One call covers the whole workspace for any ordinary repository, so the
  // local tools (predict_cochanges, analyze_impact, assign_git_changes) never
  // operate on a partial index. File content is read here and nowhere else:
  // it goes into the in-process CPG and is not sent off the machine.
  //
  // Bounded by wall clock, not by faith. Parsing is NOT flatly cheap: addFile
  // scans the accumulated node set, so per-file cost grows with the graph and
  // the total grows faster than the file count. Unbounded, a large monorepo would hang the
  // first call of every session, and the index is not persisted across them.
  // So parse until the budget is spent, then stop and SAY so; the next call
  // resumes where this one stopped (isParsed skips what is already done).
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

  // ── Co-change neighbours of the recently changed files (local) ──────────────
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

  const duration = Date.now() - startTime;

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
  if (recentlyChanged.length > 0) {
    text += `  Co-change neighbours of recently changed files: ${cochangePaths.size}\n`;
  }
  text += `\n`;

  text += `No file content was sent off the machine: the index is local, and there is no server-side analysis.\n`;
  text += `Record issues you notice with record_finding; get_problems lists them with other agents' findings.\n`;

  text += `\nDuration: ${duration}ms`;
  return text;
}
