import { z } from 'zod';
import type { AnalysisAPIClient, AnalysisResult } from '../api-client.js';
import { getLocalIndex } from '../local-index.js';
import type { LocalStore } from '../local-store.js';

export const GetAnalysisContextTool = {
  name: 'get_analysis_context',
  description:
    'Return the current analysis state: CPG index stats, open problems summary, and co-change predictions for recently changed files. Designed to feed an LLM deciding what to do next or what problems have appeared.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      recently_changed_files: {
        type: 'array',
        description: 'Files changed in the current session — used to generate co-change predictions',
        items: { type: 'string' },
      },
      problem_limit: {
        type: 'number',
        description: 'Max open problems to include (default: 10)',
        default: 10,
      },
      scope: {
        type: 'string',
        description: 'Problem scope (default: session)',
        enum: ['session', 'project', 'org'],
        default: 'session',
      },
    },
  },
};

export const InputSchema = z.object({
  recently_changed_files: z.array(z.string()).optional(),
  problem_limit: z.number().int().positive().max(50).default(10),
  scope: z.enum(['session', 'project', 'org']).default('session'),
});

export type GetAnalysisContextInput = z.infer<typeof InputSchema>;

export async function handle(
  input: GetAnalysisContextInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  const startTime = Date.now();
  const localIndex = getLocalIndex();

  // ── Local CPG stats ───────────────────────────────────────────────────────
  const cpgStats = localIndex.isReady()
    ? localIndex.stats()
    : null;

  // ── Co-change predictions for recently changed files (local, best-effort) ─
  const cochangePredictions: string[] = [];
  if (cpgStats && input.recently_changed_files?.length) {
    const allIds: string[] = [];
    for (const f of input.recently_changed_files) {
      allIds.push(...localIndex.componentIdsForFile(f));
    }
    if (allIds.length > 0) {
      try {
        const preds = await localIndex.predictor.predictCochanges(allIds, 10);
        for (const p of preds.filter(p => p.similarityScore >= 0.3).slice(0, 8)) {
          cochangePredictions.push(
            `  • ${p.componentName} (${p.componentType})  ${p.filePath}:${p.startLine}  ${(p.similarityScore * 100).toFixed(0)}%`,
          );
        }
      } catch {
        // non-fatal
      }
    }
  }

  // ── Sidecar mode: read problems from local cache ───────────────────────────
  let cacheTag: string | null = null;
  let cachedProblems: Array<{ severity: string; category: string; file_path: string; line_start: number; brief: string; id: string }> = [];
  if (localStore && input.recently_changed_files?.length) {
    for (const f of input.recently_changed_files) {
      const seeds = localStore.getCachedSeeds(f);
      cachedProblems.push(...seeds.map(s => ({
        severity: s.severity,
        category: s.category,
        file_path: s.file_path,
        line_start: s.line_start,
        brief: s.brief,
        id: s.id,
      })));
    }
    if (cachedProblems.length > 0) {
      const freshness = localStore.getFreshness(input.recently_changed_files[0]!);
      const ageSec = Math.round(freshness.age_ms / 1000);
      cacheTag = `[cache: ${ageSec}s old${freshness.stale ? ', stale' : ''}]`;
    }
  }

  // ── Open problems from analysis API (same source as get_problems) ────────
  let problemsText = '(analysis pending or unavailable)';
  let criticalCount = 0;
  let highCount = 0;
  let totalOpen = 0;
  let recentProblems: string[] = [];

  try {
    const analysis = await apiClient.getAnalysis(sessionId);

    if (analysis.status === 'complete') {
      const results: AnalysisResult[] = (analysis.results ?? []).filter(r => !r.discarded);
      totalOpen = results.length;

      const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
      const sorted = [...results].sort((a, b) => {
        const sa = SEVERITY_ORDER[a.severity?.toUpperCase() ?? ''] ?? 99;
        const sb = SEVERITY_ORDER[b.severity?.toUpperCase() ?? ''] ?? 99;
        return sa !== sb ? sa - sb : a.path.localeCompare(b.path);
      });

      for (const p of sorted) {
        if (p.severity?.toUpperCase() === 'CRITICAL') criticalCount++;
        if (p.severity?.toUpperCase() === 'HIGH') highCount++;
      }

      for (const p of sorted.slice(0, input.problem_limit)) {
        recentProblems.push(
          `  • [${p.severity ?? 'LOW'}] ${p.category}  ${p.path}:${p.startLine}\n    ${p.summary.slice(0, 100)}\n    id: ${p.id}`,
        );
      }
      problemsText = `${totalOpen} open (${criticalCount} critical, ${highCount} high)`;
    } else if (analysis.status === 'pending' || analysis.status === 'running') {
      problemsText = `(analysis ${analysis.status} — run init_workspace then try again)`;
    } else if (analysis.status === 'failed') {
      problemsText = `(analysis failed — re-submit files via init_workspace)`;
    }
  } catch {
    // keep unavailable message
  }

  const duration = Date.now() - startTime;

  // ── Build structured context for LLM consumption ─────────────────────────
  let text = `Analysis Context\n`;
  text += `════════════════\n\n`;

  // CPG state
  if (cpgStats) {
    text += `CPG index:\n`;
    text += `  Workspace:  ${cpgStats.workspacePath ?? 'unknown'}\n`;
    text += `  Files:      ${cpgStats.filesIndexed}\n`;
    text += `  Components: ${cpgStats.componentsIndexed}\n\n`;
  } else {
    text += `CPG index: not initialised (run init_workspace)\n\n`;
  }

  // Problems
  text += `Open problems: ${problemsText}\n`;
  if (recentProblems.length > 0) {
    text += `\nMost recent (${recentProblems.length} shown):\n`;
    text += recentProblems.join('\n') + '\n';
  }
  text += '\n';

  // Co-change predictions
  if (input.recently_changed_files?.length) {
    text += `Co-change predictions for recently changed files:\n`;
    if (cochangePredictions.length > 0) {
      text += cochangePredictions.join('\n') + '\n';
    } else {
      text += '  (none above threshold or workspace not indexed)\n';
    }
    text += '\n';
  }

  // Guidance for LLM
  text += `Suggested next actions:\n`;
  if (!cpgStats) {
    text += `  1. Run init_workspace to enable local CPG analysis\n`;
  } else if (criticalCount > 0) {
    text += `  1. Address ${criticalCount} CRITICAL problem${criticalCount > 1 ? 's' : ''} — use get_problems for details\n`;
    text += `  2. Check co-change predictions above to avoid incomplete fixes\n`;
  } else if (highCount > 0) {
    text += `  1. Review ${highCount} HIGH severity problem${highCount > 1 ? 's' : ''} — use get_problems for details\n`;
  } else if (cochangePredictions.length > 0) {
    text += `  1. Update co-change candidates listed above before committing\n`;
  } else {
    text += `  1. No critical issues detected — continue current work\n`;
  }

  text += `\nContext generated in ${duration}ms`;
  if (cacheTag) text += `\n\n${cacheTag}`;
  return text;
}
