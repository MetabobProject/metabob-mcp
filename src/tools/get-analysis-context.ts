// Contract (input schema, behaviour): SPEC §get_analysis_context
import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { getLocalIndex } from '../local-index.js';
import { seedCacheTag, type LocalStore } from '../local-store.js';
import { NO_SERVER_ANALYSIS, fetchAgentFindings, renderFindingsSection, retireClosedSeeds, workspaceRepoName } from './_findings.js';

export const GetAnalysisContextTool = {
  name: 'get_analysis_context',
  description:
    'Return the current local analysis state: CPG index stats, open problems in the local store, co-change predictions for recently changed files, and a compact recall of findings other agents recorded on this codebase. Designed to feed an LLM deciding what to do next. There is no server-side analysis: no workspace content leaves the machine.',
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
        description: 'Accepted; problems always come from this workspace\'s local store (default: session)',
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
  _sessionId: string,
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

  // ── Cross-agent findings recall (concept-db, best-effort, compact) ────────
  // Phase-0 orientation sees other agents' recorded findings without an extra
  // call. Non-fatal: unreachable concept-db renders a one-line note.
  // Scoped by repo only: this is an orientation snapshot, so a finding about
  // any part of this codebase is relevant, not just the files touched so far.
  // Read before the local cache, so a verdict recorded by another session
  // retires this session's seeds of that finding first. SPEC §get_analysis_context
  const recall = await fetchAgentFindings(apiClient, { repo: workspaceRepoName() });
  retireClosedSeeds(recall, localStore);
  const findingsSection = renderFindingsSection(recall, { max: 5, compact: true });

  // ── Open problems in the local store (same source as get_problems) ───────
  let cacheTag: string | null = null;
  let problemsText = '(no local store in this session — it failed to open; see the startup log)';
  let criticalCount = 0;
  let highCount = 0;
  const recentProblems: string[] = [];

  if (localStore) {
    // Seeds arrive ordered by severity, then location.
    const seeds = localStore.getAllCachedSeeds();
    for (const s of seeds) {
      if (s.severity.toUpperCase() === 'CRITICAL') criticalCount++;
      if (s.severity.toUpperCase() === 'HIGH') highCount++;
    }
    for (const s of seeds.slice(0, input.problem_limit)) {
      recentProblems.push(
        `  • [${s.severity}] ${s.category}  ${s.file_path}:${s.line_start}\n    ${s.brief.slice(0, 100)}\n    id: ${s.id}`,
      );
    }
    problemsText = `${seeds.length} open (${criticalCount} critical, ${highCount} high)`;
    cacheTag = seedCacheTag(seeds) || null;
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
  text += `Open problems (local store): ${problemsText}\n`;
  if (recentProblems.length > 0) {
    text += `\nTop by severity (${recentProblems.length} shown):\n`;
    text += recentProblems.join('\n') + '\n';
  }
  text += `${NO_SERVER_ANALYSIS}\n\n`;

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

  // Cross-agent recall
  if (findingsSection) {
    text += findingsSection + '\n\n';
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
    text += `  1. No critical or high problems recorded — continue current work, and record what you notice with record_finding\n`;
  }

  text += `\nContext generated in ${duration}ms`;
  if (cacheTag) text += `\n\n${cacheTag}`;
  return text;
}
