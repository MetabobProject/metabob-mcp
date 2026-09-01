import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { getLocalIndex } from '../local-index.js';
import type { CPGNode } from '../cpg-inference.js';
import type { LocalStore } from '../local-store.js';

export const AnalyzeImpactTool = {
  name: 'analyze_impact',
  description:
    'Analyze the downstream impact of changing the given files by traversing the local Code Property Graph. Shows which components are directly and indirectly affected. Requires init_workspace to have been run first.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      changed_files: {
        type: 'array',
        description: 'Files being changed',
        items: { type: 'string' },
      },
      diff: {
        type: 'string',
        description: 'Optional git diff for precise changed-symbol resolution',
      },
      direction: {
        type: 'string',
        description: 'Traversal direction: forward=dependencies, backward=dependents, both (default: both)',
        enum: ['forward', 'backward', 'both'],
        default: 'both',
      },
      max_depth: {
        type: 'number',
        description: 'Maximum graph traversal depth (default: 5, max: 10)',
        default: 5,
      },
      include_tests: {
        type: 'boolean',
        description: 'Include test files in results (default: true)',
        default: true,
      },
    },
    required: ['changed_files'],
  },
};

export const InputSchema = z.object({
  changed_files: z.array(z.string()).min(1),
  diff: z.string().optional(),
  direction: z.enum(['forward', 'backward', 'both']).default('both'),
  max_depth: z.number().int().min(1).max(10).default(5),
  include_tests: z.boolean().default(true),
});

export type AnalyzeImpactInput = z.infer<typeof InputSchema>;

interface ImpactedComponent {
  component_id: string;
  component_name: string;
  file_path: string;
  start_line: number;
  depth: number;
  risk: 'low' | 'medium' | 'high';
}

function isTestFile(path: string): boolean {
  return /\/(tests?|__tests?__|spec)\//i.test(path) || /\.(test|spec)\.[tj]sx?$/.test(path);
}

function riskLevel(depth: number, totalImpact: number): 'low' | 'medium' | 'high' {
  if (depth === 1 && totalImpact > 5) return 'high';
  if (depth <= 2) return 'medium';
  return 'low';
}

function collectReachable(
  cpg: ReturnType<typeof getLocalIndex>['getCPG'] extends () => infer R ? R : never,
  startIds: string[],
  direction: 'forward' | 'backward',
  maxDepth: number,
): Map<string, { node: CPGNode; depth: number }> {
  const visited = new Map<string, { node: CPGNode; depth: number }>();
  const queue: [string, number][] = startIds.map(id => [id, 0]);

  while (queue.length > 0) {
    const item = queue.shift()!;
    const [nodeId, depth] = item;
    if (visited.has(nodeId) || depth > maxDepth) continue;

    const node = cpg.getNode(nodeId);
    if (!node) continue;
    visited.set(nodeId, { node, depth });

    if (depth < maxDepth) {
      const neighbors: CPGNode[] =
        direction === 'backward' ? cpg.findCallers(nodeId) : cpg.findCallees(nodeId);
      for (const n of neighbors) {
        if (!visited.has(n.id)) queue.push([n.id, depth + 1]);
      }
    }
  }

  return visited;
}

/**
 * Cached problem seeds for the changed files, rendered as a supplementary
 * block — or '' when there are none (in which case the files are enqueued for
 * background analysis). Same shape as predict_cochanges' seed suffix.
 */
function cachedSeedBlock(localStore: LocalStore, changedFiles: string[]): string {
  const allSeeds: ReturnType<LocalStore['getCachedSeeds']> = [];
  let hasAnyCache = false;
  let oldestAgeMs = 0;
  let anyStale = false;

  for (const f of changedFiles) {
    const seeds = localStore.getCachedSeeds(f);
    const freshness = localStore.getFreshness(f);
    if (seeds.length > 0 || freshness.age_ms !== Infinity) hasAnyCache = true;
    if (freshness.age_ms !== Infinity && freshness.age_ms > oldestAgeMs) {
      oldestAgeMs = freshness.age_ms;
    }
    if (freshness.stale) anyStale = true;
    allSeeds.push(...seeds);
  }

  if (!hasAnyCache) {
    for (const f of changedFiles) localStore.enqueue(f, 0 /* P0 */, 'default');
  }
  if (allSeeds.length === 0) return '';

  const ageSec = Math.round(oldestAgeMs / 1000);
  let text = `\n\nKnown problems in changed files (cached, ${ageSec}s old${anyStale ? ', stale' : ''}):\n`;
  for (const s of allSeeds.slice(0, 20)) {
    text += `  • [${s.severity}] ${s.category}  ${s.file_path}:${s.line_start}–${s.line_end} — ${s.brief}\n`;
    text += `    id: ${s.id}\n`;
  }
  if (allSeeds.length > 20) text += `  … and ${allSeeds.length - 20} more\n`;
  return text;
}

export async function handle(
  input: AnalyzeImpactInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  // A cached problem detection is not an impact analysis — they are disjoint
  // data. Returning the seeds *instead of* the traversal silently deleted this
  // tool's entire documented behaviour for any file that happened to carry a
  // seed. Seeds are appended as supplementary context, never substituted, and
  // the block rides along on the early returns too so nothing is lost.
  const seedBlock = localStore ? cachedSeedBlock(localStore, input.changed_files) : '';
  return (await impactReport(input, apiClient, sessionId)) + seedBlock;
}

async function impactReport(
  input: AnalyzeImpactInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
): Promise<string> {
  const startTime = Date.now();
  const localIndex = getLocalIndex();

  if (!localIndex.isReady()) {
    return 'Workspace not indexed. Run init_workspace first.';
  }

  const cpg = localIndex.getCPG();

  // Resolve component IDs for changed files
  const changedComponentIds: string[] = [];
  for (const file of input.changed_files) {
    changedComponentIds.push(...localIndex.componentIdsForFile(file));
  }

  if (changedComponentIds.length === 0) {
    return (
      `No indexed components found for:\n` +
      input.changed_files.map(f => `  - ${f}`).join('\n') +
      `\n\nRun init_workspace again after saving the files.`
    );
  }

  // Collect impacted components via BFS
  const reachable = new Map<string, { node: CPGNode; depth: number }>();

  if (input.direction === 'backward' || input.direction === 'both') {
    for (const [id, v] of collectReachable(cpg, changedComponentIds, 'backward', input.max_depth)) {
      if (!changedComponentIds.includes(id)) reachable.set(id, v);
    }
  }
  if (input.direction === 'forward' || input.direction === 'both') {
    for (const [id, v] of collectReachable(cpg, changedComponentIds, 'forward', input.max_depth)) {
      if (!changedComponentIds.includes(id)) {
        const existing = reachable.get(id);
        if (!existing || v.depth < existing.depth) reachable.set(id, v);
      }
    }
  }

  const allImpacted: ImpactedComponent[] = [];
  for (const [id, { node, depth }] of reachable) {
    const filePath = (node as any).filePath as string ?? '';
    if (!input.include_tests && isTestFile(filePath)) continue;
    allImpacted.push({
      component_id: id,
      component_name: node.name,
      file_path: filePath,
      start_line: node.startLine,
      depth,
      risk: riskLevel(depth, reachable.size),
    });
  }

  // ── File-level import graph — CALLS edges miss module dependencies, so a
  // schema/config file with no callers still has importers that break when it
  // changes. BFS the import graph alongside the component graph.
  const importGraph = localIndex.fileImportGraph();
  const reverseImports = new Map<string, Set<string>>();
  for (const [from, targets] of importGraph) {
    for (const to of targets) {
      if (!reverseImports.has(to)) reverseImports.set(to, new Set());
      reverseImports.get(to)!.add(from);
    }
  }
  const changedAbs = input.changed_files.map(f => localIndex.resolvePath(f));
  const seenFiles = new Map<string, number>();
  let frontier = changedAbs.filter(f => importGraph.has(f));
  for (let depth = 1; depth <= input.max_depth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const file of frontier) {
      const neighbors = [
        ...(input.direction !== 'forward' ? reverseImports.get(file) ?? [] : []),
        ...(input.direction !== 'backward' ? importGraph.get(file) ?? [] : []),
      ];
      for (const n of neighbors) {
        if (changedAbs.includes(n) || seenFiles.has(n)) continue;
        seenFiles.set(n, depth);
        next.push(n);
      }
    }
    frontier = next;
  }
  const coveredFiles = new Set(allImpacted.map(c => c.file_path));
  for (const [file, depth] of seenFiles) {
    if (coveredFiles.has(file)) continue;
    if (!input.include_tests && isTestFile(file)) continue;
    allImpacted.push({
      component_id: `${file}::file`,
      component_name: file.split(/[\\/]/).pop() ?? file,
      file_path: file,
      start_line: 0,
      depth,
      risk: riskLevel(depth, seenFiles.size),
    });
  }

  allImpacted.sort((a, b) => a.depth - b.depth || b.risk.localeCompare(a.risk));

  const direct = allImpacted.filter(c => c.depth === 1);
  const indirect = allImpacted.filter(c => c.depth > 1 && !isTestFile(c.file_path));
  const tests = allImpacted.filter(c => isTestFile(c.file_path));

  const totalImpact = allImpacted.length;
  const overallRisk =
    totalImpact > 20 ? 'critical' : totalImpact > 5 ? 'high' : totalImpact > 1 ? 'medium' : 'low';

  const duration = Date.now() - startTime;

  // Optionally augment with API data (non-blocking, best-effort)
  let apiNote = '';
  try {
    await apiClient.post('/v2/analysis/impact', { changed_files: input.changed_files }, sessionId);
  } catch {
    apiNote = '\n(API augmentation unavailable — results are local CPG only)';
  }

  let text = `Impact Analysis\n`;
  text += `═══════════════\n\n`;
  text += `Changed files:\n`;
  for (const f of input.changed_files) text += `  - ${f}\n`;
  text += `\nOverall risk: ${overallRisk.toUpperCase()}   Total impacted: ${totalImpact}\n\n`;

  if (direct.length > 0) {
    text += `Direct dependents (${direct.length}):\n`;
    for (const c of direct) {
      text += `  • ${c.component_name}  ${c.file_path}:${c.start_line}  [${c.risk}]\n`;
    }
    text += '\n';
  }

  if (indirect.length > 0) {
    const shown = indirect.slice(0, 15);
    text += `Indirect dependents (${indirect.length}):\n`;
    for (const c of shown) {
      text += `  • ${c.component_name}  ${c.file_path}:${c.start_line}  depth=${c.depth}\n`;
    }
    if (indirect.length > 15) text += `  … and ${indirect.length - 15} more\n`;
    text += '\n';
  }

  if (tests.length > 0) {
    text += `Affected tests (${tests.length}):\n`;
    for (const c of tests.slice(0, 10)) {
      text += `  • ${c.component_name}  ${c.file_path}:${c.start_line}\n`;
    }
    if (tests.length > 10) text += `  … and ${tests.length - 10} more\n`;
    text += '\n';
  }

  if (totalImpact === 0) {
    text += 'No dependents found — these files can be changed in isolation.\n';
  }

  text += `\nAnalysis completed in ${duration}ms${apiNote}`;
  return text;
}
