import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import type { LocalStore } from '../local-store.js';
import {
  VERDICT_SHAPE,
  conceptIdFromRefs,
  postConcept,
  recordConceptUsage,
  resolveConceptDbUrl,
  workspaceRepoName,
} from './_findings.js';

export const MarkCompleteTool = {
  name: 'mark_complete',
  description:
    'Mark a detected problem as resolved (endorsed = you fixed it) or dismiss it (discarded = false positive). Problem IDs come from get_problems. Works for agent-recorded findings too (agf_* ids from record_finding): endorse retires the finding as resolved, discard retracts it.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      problem_id: {
        type: 'string',
        description: 'Problem ID from get_problems',
      },
      action: {
        type: 'string',
        description: '"endorse" — problem was valid and has been fixed. "discard" — false positive, not a real issue.',
        enum: ['endorse', 'discard'],
        default: 'endorse',
      },
    },
    required: ['problem_id'],
  },
};

export const InputSchema = z.object({
  problem_id: z.string().min(1),
  action: z.enum(['endorse', 'discard']).default('endorse'),
});

export type MarkCompleteInput = z.infer<typeof InputSchema>;

export async function handle(
  input: MarkCompleteInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  const startTime = Date.now();

  // ── Agent-recorded findings (record_finding → agf_* ids) ───────────────────
  // These live in the LocalStore + concept-db, not the legacy analysis API.
  //
  // A `concept_*` id is accepted too: the cross-agent recall surfaces findings
  // by concept id, so that is frequently the only identifier an agent holds.
  // Letting one fall through to the legacy analysis path below reported
  // "endorsed" for a write that never happened — see getSeedByConceptRef.
  const isConceptId = input.problem_id.startsWith('concept_');
  if (input.problem_id.startsWith('agf_') || isConceptId) {
    if (!localStore) {
      return `Finding "${input.problem_id}" cannot be updated — local store unavailable in this session.`;
    }
    const seed = isConceptId
      ? localStore.getSeedByConceptRef(input.problem_id)
      : localStore.getSeedById(input.problem_id);
    if (!seed) {
      return isConceptId
        ? `Concept "${input.problem_id}" has no agent-finding seed on this machine, so no verdict was recorded.\n`
          + `  Verdicts are written against the local seed created by record_finding; a finding recalled from\n`
          + `  concept-db can be read anywhere but only endorsed where it was recorded.\n`
          + `  Use get_problems to list findings with local agf_* ids.`
        : `Finding "${input.problem_id}" not found in the local store. Use get_problems to list valid IDs.`;
    }

    // Always act on the RESOLVED seed id: with a concept id, input.problem_id
    // matches no seed row and every mutation below would be a silent no-op.
    const seedId = seed.id;

    if (input.action === 'endorse') {
      localStore.markSeedStaleById(seedId); // resolved — stop surfacing
    } else {
      localStore.deleteSeed(seedId); // retracted / false positive
    }

    // Best-effort verdict into concept-db so other agents see the outcome.
    let conceptStatus = 'concept-db not configured — verdict recorded locally only';
    let relevanceStatus = '';
    const conceptDbUrl = await resolveConceptDbUrl(apiClient);
    if (conceptDbUrl) {
      const repo = workspaceRepoName() ?? seed.workspace_id;
      const verdict = input.action === 'endorse' ? 'endorsed (resolved)' : 'discarded (retracted)';
      const result = await postConcept(conceptDbUrl, {
        content: [
          `finding: ${seedId}`,
          `verdict: ${verdict}`,
          `repo: ${repo}`,
          `files: ${seed.file_path}`,
          `finding summary: ${seed.brief}`,
        ].join('\n'),
        summary: `[verdict:${input.action}] ${repo}: ${seed.brief}`,
        shape: VERDICT_SHAPE,
        source_type: 'metabob_annotation',
        pointer: { type: VERDICT_SHAPE },
      });
      conceptStatus = result.ok
        ? `verdict shared via concept-db (concept ${result.id ?? '?'})`
        : `concept-db unreachable (${result.error}) — verdict recorded locally only`;

      // Fold the verdict into the finding concept's relevance directly: an
      // endorsed finding proved useful (success), a discarded one was a false
      // positive (failure). This is what makes the operator's judgment move
      // relevance instead of only leaving a parallel verdict concept.
      const conceptId = conceptIdFromRefs(seed.refs_json);
      if (conceptId) {
        const outcome = input.action === 'endorse' ? 'success' : 'failure';
        const usage = await recordConceptUsage(conceptDbUrl, conceptId, outcome);
        relevanceStatus = usage.ok
          ? `relevance: recorded ${outcome} on concept ${conceptId}`
          : `relevance: could not record ${outcome} on concept ${conceptId} (${usage.error})`;
      } else {
        relevanceStatus = 'relevance: no linked concept on this finding — signal skipped';
      }
    }

    const duration = Date.now() - startTime;
    const verb = input.action === 'endorse'
      ? 'endorsed (finding resolved, retired from get_problems)'
      : 'discarded (finding retracted and removed)';
    const shown = isConceptId ? `${seedId} (via ${input.problem_id})` : seedId;
    let out = `Finding ${shown} ${verb} in ${duration}ms\n  concept-db: ${conceptStatus}`;
    if (relevanceStatus) out += `\n  ${relevanceStatus}`;
    return out;
  }

  try {
    await apiClient.postFeedback(input.problem_id, sessionId, {
      endorsed: input.action === 'endorse',
      discarded: input.action === 'discard',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err);
    if (msg.includes('404') || msg.includes('not found') || msg.toLowerCase().includes('invalid')) {
      return `Problem ID "${input.problem_id}" not found. Use get_problems to list valid IDs.`;
    }
    return `Failed to update problem: ${msg}`;
  }

  const duration = Date.now() - startTime;
  const verb = input.action === 'endorse' ? 'endorsed (marked resolved)' : 'discarded (marked false positive)';
  return `Problem ${input.problem_id} ${verb} in ${duration}ms`;
}
