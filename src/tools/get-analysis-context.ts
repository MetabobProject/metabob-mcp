// Contract (input schema, behaviour): SPEC §get_analysis_context
import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { activeWorkspacePath, getLocalIndex, sessionWorkspacePath } from '../local-index.js';
import { clientRootPaths, identityWorkspacePath, workspaceSource } from '../workspace-root.js';
import { getAttachment } from '../attachment.js';
import { redactUrl } from '../net.js';
import { seedCacheTag, type LocalStore } from '../local-store.js';
import { mineGitCochanges } from '../git-cochange.js';
import { repoIdentity } from '../repo-identity.js';
import {
  noServerAnalysis,
  fetchAgentFindings,
  openFindingsHeadline,
  renderFindingsSection,
  retireClosedSeeds,
  TASK_CATEGORY,
  withoutTasks,
  workspaceRepo,
  resolveAuthorVesselId,
} from './_findings.js';
import type { SeedRecord } from '../local-store.js';

export const GetAnalysisContextTool = {
  name: 'get_analysis_context',
  description:
    'Return the current analysis state: one open-findings count across the local store and findings other agents recorded on this codebase, CPG index stats, the local store\'s open problems, co-change predictions for recently changed files, and a compact recall of the shared findings. Designed to feed an LLM deciding what to do next. There is no server-side analysis: no workspace content leaves the machine.',
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

// @anchor attachment-line
/**
 * Where this session writes, and as whom: the attachment's org and discovery endpoint (never the key), this
 * session's vesselId and session id, or the named cause when it is not attached. Agents writing to the shared ledger
 * had no read that showed it. SPEC §get_analysis_context
 */
export async function attachmentLines(sessionId: string): Promise<string[]> {
  const a = getAttachment();
  const vesselId = await resolveAuthorVesselId();
  const where = workspaceLine();
  const who = `  as:         ${vesselId ?? 'no vessel identity'} (session ${sessionId || 'unknown'})${where.identity}`;
  if (!a) return ['Attachment: not attached (no API key or endpoint configured); substrate tools are unavailable', who, where.line];
  const st = a.state();
  if (st.auth.status === 'authenticated' && !st.cause) {
    return [`Attachment: attached to org ${st.auth.orgId ?? '?'} via discovery ${st.anchor.discovery ? redactUrl(st.anchor.discovery) : '?'}`, who, where.line];
  }
  if (!st.cause && st.auth.status === 'pending') return ['Attachment: attaching (first attempt in progress)', who, where.line];
  return [`Attachment: not attached: ${st.message ?? st.cause ?? st.auth.status}`, who, where.line];
}

/** The workspace the ledger is keyed by and where it came from (SPEC §workspace), and the identity's own. */
function workspaceLine(): { line: string; identity: string } {
  const workspace = activeWorkspacePath();
  const source = sessionWorkspacePath() ? 'init_workspace' : workspaceSource();
  const others = clientRootPaths().filter((r) => r !== workspace);
  const fromIdentity = identityWorkspacePath();
  const repo = repoIdentity(workspace);
  const keyedBy = repo.source === 'origin' ? 'its origin remote'
    : repo.source === 'root' ? 'its first commit (no origin remote)'
    : 'this directory alone (no commit yet): nothing recorded here is shared with another checkout';
  return {
    line: `  workspace:  ${workspace} (from ${source})${others.length ? `; other roots: ${others.join(', ')}` : ''}\n`
      + `  ledger:     ${repo.id}, keyed by ${keyedBy}`,
    identity: fromIdentity && fromIdentity !== workspace ? `; identity derived from ${fromIdentity}, kept for this session` : '',
  };
}

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

  // ── Co-change for recently changed files, from git history (local, best-effort) ─
  // The threshold is predict_cochanges' default (SPEC §get_analysis_context).
  const cochangePredictions: string[] = [];
  if (input.recently_changed_files?.length) {
    try {
      const root = activeWorkspacePath();
      const preds = await mineGitCochanges(root, input.recently_changed_files, 10);
      for (const p of preds.filter(p => p.confidence >= 0.3).slice(0, 8)) {
        cochangePredictions.push(
          `  • ${p.filePath}  ${(p.confidence * 100).toFixed(0)}% (${p.cooccurrences} commit${p.cooccurrences === 1 ? '' : 's'})`,
        );
      }
    } catch {
      // non-fatal
    }
  }

  // ── Cross-agent findings recall (concept-db, best-effort, compact) ────────
  // Phase-0 orientation sees other agents' recorded findings without an extra
  // call. Non-fatal: unreachable concept-db renders a one-line note.
  // Scoped by repo only: this is an orientation snapshot, so a finding about
  // any part of this codebase is relevant, not just the files touched so far.
  // Read before the local cache, so a verdict recorded by another session
  // retires this session's seeds of that finding first. SPEC §get_analysis_context
  const recall = await fetchAgentFindings(apiClient, { repo: workspaceRepo() });
  retireClosedSeeds(recall, localStore);
  const findingsSection = renderFindingsSection(withoutTasks(recall), { max: 5, compact: true });
  const sharedOpen = recall.status === 'ok' ? withoutTasks(recall).findings.filter(f => !f.verdict).length : 0;

  // ── Open problems in the local store (same source as get_problems) ───────
  let cacheTag: string | null = null;
  let problemsText = '(no local store in this session — it failed to open; see the startup log)';
  let criticalCount = 0;
  let highCount = 0;
  const recentProblems: string[] = [];
  let localSeeds: SeedRecord[] | null = null;

  if (localStore) {
    // Seeds arrive ordered by severity, then location.
    const all = localStore.getAllCachedSeeds();
    localSeeds = all;
    // Tasks are work assigned, not problems: the headline counts them apart (SPEC §get_problems).
    const seeds = all.filter(s => s.category.toLowerCase() !== TASK_CATEGORY);
    for (const s of seeds) {
      if (s.severity.toUpperCase() === 'CRITICAL') criticalCount++;
      if (s.severity.toUpperCase() === 'HIGH') highCount++;
    }
    for (const s of seeds.slice(0, input.problem_limit)) {
      recentProblems.push(
        `  • [${s.severity}] ${s.category}  ${s.file_path}${s.line_start > 0 ? `:${s.line_start}` : ''}\n    ${s.brief.slice(0, 100)}\n    id: ${s.id}`,
      );
    }
    problemsText = `${seeds.length} open (${criticalCount} critical, ${highCount} high)`;
    cacheTag = seedCacheTag(seeds) || null;
  }


  const duration = Date.now() - startTime;

  // ── Build structured context for LLM consumption ─────────────────────────
  let text = `Analysis Context\n`;
  text += `════════════════\n\n`;
  text += (await attachmentLines(sessionId)).join('\n') + '\n\n';

  // CPG state
  if (cpgStats) {
    text += `CPG index:\n`;
    text += `  Workspace:  ${cpgStats.workspacePath ?? 'unknown'}\n`;
    text += `  Files:      ${cpgStats.filesIndexed}\n`;
    text += `  Components: ${cpgStats.componentsIndexed}\n\n`;
  } else {
    text += `CPG index: not initialised (run init_workspace)\n\n`;
  }

  // Problems: one count across the local store and the recall first, so the
  // first line never reads "0" while shared findings are open.
  text += `${openFindingsHeadline(localSeeds, recall)}\n`;
  text += `  local store: ${problemsText}\n`;
  if (recentProblems.length > 0) {
    text += `\nTop by severity (${recentProblems.length} shown):\n`;
    text += recentProblems.join('\n') + '\n';
  }
  text += `${noServerAnalysis()}\n\n`;

  // Co-change predictions
  if (input.recently_changed_files?.length) {
    text += `Co-changes from git history for recently changed files:\n`;
    if (cochangePredictions.length > 0) {
      text += cochangePredictions.join('\n') + '\n';
    } else {
      text += '  (none above 30% confidence in git history)\n';
    }
    text += '\n';
  }

  // Cross-agent recall
  if (findingsSection) {
    text += findingsSection + '\n\n';
  }

  // Guidance for LLM
  text += `Suggested next actions:\n`;
  const actions: string[] = [];
  if (!cpgStats) actions.push('Run init_workspace to enable local CPG analysis');
  if (criticalCount > 0) {
    actions.push(`Address ${criticalCount} CRITICAL problem${criticalCount > 1 ? 's' : ''} — use get_problems for details`);
    if (cpgStats) actions.push('Check co-change predictions above to avoid incomplete fixes');
  } else if (highCount > 0) {
    actions.push(`Review ${highCount} HIGH severity problem${highCount > 1 ? 's' : ''} — use get_problems for details`);
  }
  // Open shared findings are work too, whatever the local store holds.
  if (sharedOpen > 0) {
    actions.push(`Review ${sharedOpen} open finding${sharedOpen > 1 ? 's' : ''} recorded by agents on this codebase — use get_problems for details`);
  }
  if (cpgStats && actions.length === 0 && cochangePredictions.length > 0) {
    actions.push('Update co-change candidates listed above before committing');
  }
  if (actions.length === 0) {
    actions.push('No critical or high problems recorded — continue current work, and record what you notice with record_finding');
  }
  text += actions.map((a, i) => `  ${i + 1}. ${a}\n`).join('');

  text += `\nContext generated in ${duration}ms`;
  if (cacheTag) text += `\n\n${cacheTag}`;
  return text;
}
