import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import type { LocalStore } from '../local-store.js';
import {
  fetchConceptById,
  VERDICT_SHAPE,
  attributionLines,
  conceptIdFromRefs,
  resolveAuthorVesselId,
  postConcept,
  recordConceptUsage,
  resolveConceptDbUrl,
  workspaceRepoName,
} from './_findings.js';
import { plainConceptId } from './_concept-content.js';

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
  //
  // Normalise FIRST: concept-db hands back the same id both bare and
  // ⟨⟩-wrapped (sometimes in one response), and the id get_problems prints
  // keeps the wrapper. Gating on the raw string sent every wrapped id down the
  // legacy path — the very fall-through this comment says was fixed.
  const plainId = plainConceptId(input.problem_id);
  const isConceptId = plainId.startsWith('concept_');
  if (input.problem_id.startsWith('agf_') || isConceptId) {
    if (!localStore) {
      return `Finding "${input.problem_id}" cannot be updated — local store unavailable in this session.`;
    }
    const seed = isConceptId
      // Either stored form matches: getSeedByConceptRef normalises the id and
      // queries both, so a bare id finds a wrapped row and vice versa. The
      // retry that used to live here only covered wrapped-id-against-bare-row.
      ? localStore.getSeedByConceptRef(input.problem_id)
      : localStore.getSeedById(input.problem_id);
    // NO LOCAL SEED, CONCEPT ID: write the verdict from the concept itself.
    //
    // The seed only ever supplied three fields to the concept-db write —
    // file_path, brief and the linked concept id — and a recalled concept
    // already carries all three. Refusing here made the normal fleet case
    // impossible: a manager assigns work one agent found, another agent fixes
    // it, and the endorse step cannot land because the seed lives on a third
    // machine. Measured in artifacts/fleet: mark_complete called twice, zero
    // verdicts written.
    //
    // The LOCAL half (retire/delete the seed) is genuinely local and is simply
    // skipped — stated in the output rather than pretended.
    if (!seed && isConceptId) {
      const remoteDbUrl = await resolveConceptDbUrl(apiClient);
      if (!remoteDbUrl) {
        return `Concept "${input.problem_id}" has no local seed and concept-db is not configured, so no verdict was recorded.`;
      }
      const remote = await fetchConceptById(apiClient, plainId);
      if (!remote) {
        return `Concept "${input.problem_id}" could not be read from concept-db, so no verdict was recorded.\n`
          + `  Check CONCEPT_DB_URL / discovery, or use get_problems to list findings with local agf_* ids.`;
      }
      const verdict = input.action === 'endorse' ? 'endorsed (resolved)' : 'discarded (retracted)';
      const repo = remote.repo || workspaceRepoName() || 'unknown';
      // Join on the agf_* id the finding carries, exactly as the local path
      // does. Keying on the concept id writes a verdict no reader can match —
      // measured: the row landed in concept-db and /findings still showed "no
      // verdict". The `||` fallback could never fire, though: record_finding
      // writes the literal "(not cached locally)" into `finding_ids:` when it
      // had no LocalStore, and a truthy placeholder collides EVERY stateless
      // finding's verdict onto one shared key. Require the real shape.
      const findingKey = /^agf_/.test(remote.findingId) ? remote.findingId : plainId;
      const posted = await postConcept(remoteDbUrl, {
        content: [
          `finding: ${findingKey}`,
          `verdict: ${verdict}`,
          `repo: ${repo}`,
          `files: ${remote.files}`,
          `finding summary: ${remote.summary}`,
          // Author, then provenance — two separate facts. This line used to be
          // `recorded_by: remote (no local seed on this machine)`, which made
          // one key mean both "who" and "where from"; a reader could render
          // neither honestly. `reviewed_by` is now only ever the author.
          ...attributionLines('reviewed_by', await resolveAuthorVesselId(), sessionId),
          `origin: remote`,
        ].join('\n'),
        summary: `[verdict:${input.action}] ${repo}: ${remote.summary}`,
        shape: VERDICT_SHAPE,
        source_type: 'metabob_annotation',
        pointer: { type: VERDICT_SHAPE },
      });
      const usage = await recordConceptUsage(
        remoteDbUrl,
        plainId,
        input.action === 'endorse' ? 'success' : 'failure',
      );
      // Say which key the verdict landed under when it is not the finding id —
      // a verdict readers cannot join is worth reporting as such, not as a
      // bare "verdict shared".
      const keyedNote = findingKey === plainId
        ? `\n  keyed on:   the concept id — this finding carries no agf_* id (recorded with no local store), so finding-id joins will not surface this verdict`
        : '';
      return (
        `Finding ${input.problem_id} ${input.action === 'endorse' ? 'endorsed' : 'discarded'} from the shared record\n` +
        `  concept-db: ${posted.ok ? `verdict shared (concept ${posted.id ?? '?'})` : `write failed (${posted.error})`}\n` +
        `  relevance:  ${usage.ok ? `recorded ${input.action === 'endorse' ? 'success' : 'failure'}` : `not recorded (${usage.error})`}\n` +
        `  local:      no seed on this machine, so nothing local was retired — the finding was recorded elsewhere` +
        keyedNote
      );
    }
    if (!seed) {
      return `Finding "${input.problem_id}" not found in the local store. Use get_problems to list valid IDs.`;
    }

    // Always act on the RESOLVED seed id: with a concept id, input.problem_id
    // matches no seed row and every mutation below would be a silent no-op.
    const seedId = seed.id;

    // A finding recorded across N files is N seeds but ONE concept, and the
    // concept lists every seed id — so cross-agent recall closes the whole
    // finding on a verdict against any one of them. Retire the siblings with it,
    // or the finding reads closed org-wide while still sitting in this machine's
    // problem list: the same finding both done and not done.
    const conceptRef = conceptIdFromRefs(seed.refs_json);
    const siblings = conceptRef ? localStore.getSeedsByConceptRef(conceptRef) : [];
    const toRetire = siblings.length > 0 ? siblings.map(s => s.id) : [seedId];

    for (const id of toRetire) {
      if (input.action === 'endorse') {
        localStore.markSeedStaleById(id); // resolved — stop surfacing
      } else {
        localStore.deleteSeed(id); // retracted / false positive
      }
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
          ...attributionLines('reviewed_by', await resolveAuthorVesselId(), sessionId),
          `origin: local`,
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
      // Same wrapper hazard on the way out: a ⟨⟩-wrapped ref percent-encodes
      // into a 404 at the usage chokepoint, silently skipping the relevance fold.
      const linkedRef = conceptIdFromRefs(seed.refs_json);
      const conceptId = linkedRef ? plainConceptId(linkedRef) : null;
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
