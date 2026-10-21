// Contract (input schema, behaviour): SPEC §mark_complete
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
  conceptDbReachable,
  conceptDbUnavailable,
  repoLines,
  workspaceRepo,
  fixLines,
} from './_findings.js';
import { plainConceptId } from './_concept-content.js';
import { fixLocation, type FixLocation } from '../repo-identity.js';
import { activeWorkspacePath } from '../local-index.js';

/**
 * An endorse of a fix that is still uncommitted does not close the finding: the fix exists only in this
 * checkout's working tree, and every other checkout of the repository still has the bug. It is recorded as a
 * pending fix instead, and the finding stays open org-wide until an endorse can name a commit. SPEC §mark_complete
 */
function pendingNote(loc: Extract<FixLocation, { kind: 'uncommitted' }>): string {
  return loc.outside
    ? 'The finding\'s files are clean and no commit since the finding touches them, but this checkout has uncommitted changes '
      + 'in other files. If the fix is among them, commit it, then mark_complete endorse again; until then the finding stays '
      + 'open for other agents (shown "fix pending").'
    : 'The fix is uncommitted in this checkout, so the finding stays open for other agents (shown "fix pending"). '
      + 'Commit it, then mark_complete endorse again to close the finding with its commit.';
}

/** Nothing in this checkout postdates the finding, so nothing here can be its fix: no verdict is written. */
function noFixHere(id: string, recordedAt: Date | undefined): string {
  return `Finding ${id} left open: nothing in this checkout changed since it was recorded${recordedAt ? ` (${recordedAt.toISOString()})` : ''}`
    + ' — no commit since then and no uncommitted change — so nothing here can be its fix, and no verdict was recorded.\n'
    + '  If the fix is in another checkout, endorse it there, or pull it and endorse here. If it was never a bug, discard it.';
}

function fixShown(loc: FixLocation): string {
  if (loc.kind === 'commit') {
    return `commit ${loc.sha.slice(0, 10)}${loc.branch ? ` on ${loc.branch}` : ''}${loc.pushed ? '' : ' (not on any remote branch yet)'}`
      + (loc.elsewhere ? ' — the newest commit since the finding; it touches none of the finding\'s files' : '');
  }
  if (loc.kind === 'uncommitted') return `uncommitted in this checkout${loc.branch ? ` on ${loc.branch}` : ''}${loc.outside ? ' (in files other than the finding\'s)' : ''}`;
  return 'unknown (not a git checkout, or the finding\'s files are not in it), so the finding is closed without a commit';
}

export const MarkCompleteTool = {
  name: 'mark_complete',
  description:
    'Mark a finding as resolved (endorsed = you fixed it) or dismiss it (discarded = false positive). Ids are agf_* (from record_finding / get_problems) or concept_* (from cross-agent recall): endorse retires the finding as resolved and records the commit that holds the fix, discard retracts it. Endorse after committing: a fix still uncommitted in this checkout leaves the finding open, marked fix pending. Any other id is refused.',
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
  /** The checkout whose state says where the fix is; the active workspace by default. */
  workspace: string = activeWorkspacePath(),
): Promise<string> {
  const startTime = Date.now();

  // ── Agent-recorded findings (record_finding → agf_* ids) ───────────────────
  // These live in the LocalStore + concept-db.
  //
  // A `concept_*` id is accepted too: the cross-agent recall surfaces findings
  // by concept id, so that is frequently the only identifier an agent holds
  // (see getSeedByConceptRef).
  //
  // Normalise FIRST: concept-db hands back the same id both bare and
  // ⟨⟩-wrapped (sometimes in one response), and an agent may paste either
  // form, so gating on the raw string would refuse a wrapped id. Every id this
  // tool prints is the plain form.
  const plainId = plainConceptId(input.problem_id);
  const isConceptId = plainId.startsWith('concept_');
  if (input.problem_id.startsWith('agf_') || isConceptId) {
    if (!localStore) {
      return `Finding "${plainId}" cannot be updated — local store unavailable in this session.`;
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
      if (!(await conceptDbReachable())) {
        return `Concept "${plainId}" has no local seed and concept-db is unavailable (${await conceptDbUnavailable()}), so no verdict was recorded.`;
      }
      const remote = await fetchConceptById(apiClient, plainId);
      if (!remote) {
        return `Concept "${plainId}" could not be read from concept-db, so no verdict was recorded.\n`
          + `  Check the attachment (/health), or use get_problems to list findings with local agf_* ids.`;
      }
      const loc = input.action === 'endorse' ? fixLocation(workspace, remote.files.split(','), remote.recordedAt) : null;
      if (loc?.kind === 'none') return noFixHere(plainId, remote.recordedAt);
      const pending = loc?.kind === 'uncommitted';
      const verdict = pending ? 'fix pending (uncommitted)' : input.action === 'endorse' ? 'endorsed (resolved)' : 'discarded (retracted)';
      const tag = pending ? 'pending' : input.action;
      // The finding's own repo line when it has one; else this workspace's.
      const here = workspaceRepo();
      const repoContent = remote.repo
        ? [`repo: ${remote.repo}`, ...(remote.repoName ? [`repo_name: ${remote.repoName}`] : [])]
        : repoLines(here);
      const repoShown = remote.repoName || remote.repo || here?.name || 'unknown';
      // Join on the agf_* id the finding carries, exactly as the local path
      // does. Keying on the concept id writes a verdict no reader can match —
      // measured: the row landed in concept-db and /findings still showed "no
      // verdict". The `||` fallback could never fire, though: record_finding
      // writes the literal "(not cached locally)" into `finding_ids:` when it
      // had no LocalStore, and a truthy placeholder collides EVERY stateless
      // finding's verdict onto one shared key. Require the real shape.
      const findingKey = /^agf_/.test(remote.findingId) ? remote.findingId : plainId;
      const posted = await postConcept({
        content: [
          `finding: ${findingKey}`,
          `verdict: ${verdict}`,
          ...(loc ? fixLines(loc) : []),
          ...repoContent,
          `files: ${remote.files}`,
          `finding summary: ${remote.summary}`,
          // Author, then provenance — two separate facts. This line used to be
          // `recorded_by: remote (no local seed on this machine)`, which made
          // one key mean both "who" and "where from"; a reader could render
          // neither honestly. `reviewed_by` is now only ever the author.
          ...attributionLines('reviewed_by', await resolveAuthorVesselId(), sessionId),
          `origin: remote`,
        ].join('\n'),
        summary: `[verdict:${tag}] ${repoShown}: ${remote.summary}`,
        shape: VERDICT_SHAPE,
        source_type: 'metabob_annotation',
        pointer: { type: VERDICT_SHAPE },
      });
      // A pending fix credits nothing yet: the endorse that names a commit does.
      const usage = pending ? null : await recordConceptUsage(
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
        `Finding ${plainId} ${pending ? 'left open, fix pending,' : input.action === 'endorse' ? 'endorsed' : 'discarded'} from the shared record\n` +
        `  concept-db: ${posted.ok ? `verdict shared (concept ${posted.id ?? '?'})` : `write failed (${posted.error})`}\n` +
        (loc ? `  fix:        ${fixShown(loc)}\n` : '') +
        `  relevance:  ${!usage ? 'not recorded until the fix is committed' : usage.ok ? `recorded ${input.action === 'endorse' ? 'success' : 'failure'}` : `not recorded (${usage.error})`}\n` +
        `  local:      no seed on this machine, so nothing local was retired — the finding was recorded elsewhere` +
        keyedNote +
        (loc?.kind === 'uncommitted' ? `\n  ${pendingNote(loc)}` : '')
      );
    }
    if (!seed) {
      return `Finding "${plainId}" not found in the local store. Use get_problems to list valid IDs.`;
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
    const files = siblings.length > 0 ? [...new Set(siblings.map(s => s.file_path))] : [seed.file_path];
    // The finding's recorded time: its earliest seed, since record_finding writes all of them at once.
    const recordedAt = new Date(Math.min(...(siblings.length > 0 ? siblings : [seed]).map(s => s.produced_at)));
    const loc = input.action === 'endorse' ? fixLocation(workspace, files, recordedAt) : null;
    if (loc?.kind === 'none') return noFixHere(seedId, recordedAt);
    const pending = loc?.kind === 'uncommitted';

    // A pending fix retires nothing: the finding is still open, here as everywhere else.
    for (const id of pending ? [] : toRetire) {
      if (input.action === 'endorse') {
        localStore.markSeedStaleById(id); // resolved — stop surfacing
      } else {
        localStore.deleteSeed(id); // retracted / false positive
      }
    }

    // Best-effort verdict into concept-db so other agents see the outcome.
    let conceptStatus = 'concept-db not configured — verdict recorded locally only';
    let relevanceStatus = '';
    if (!(await conceptDbReachable())) {
      conceptStatus = `${await conceptDbUnavailable()} — verdict recorded locally only`;
    } else {
      const here = workspaceRepo();
      const verdict = pending ? 'fix pending (uncommitted)' : input.action === 'endorse' ? 'endorsed (resolved)' : 'discarded (retracted)';
      const result = await postConcept({
        content: [
          `finding: ${seedId}`,
          `verdict: ${verdict}`,
          ...(loc ? fixLines(loc) : []),
          ...repoLines(here),
          `files: ${seed.file_path}`,
          `finding summary: ${seed.brief}`,
          ...attributionLines('reviewed_by', await resolveAuthorVesselId(), sessionId),
          `origin: local`,
        ].join('\n'),
        summary: `[verdict:${pending ? 'pending' : input.action}] ${here?.name ?? seed.workspace_id}: ${seed.brief}`,
        shape: VERDICT_SHAPE,
        source_type: 'metabob_annotation',
        pointer: { type: VERDICT_SHAPE },
      });
      conceptStatus = result.ok
        ? `verdict shared via concept-db (concept ${result.id ?? '?'})`
        : /^key_read_only/.test(result.error ?? '') ? `not shared (${result.error}) — verdict recorded locally only; other agents will not see it` : `concept-db unreachable (${result.error}) — verdict recorded locally only`;

      // Fold the verdict into the finding concept's relevance directly: an
      // endorsed finding proved useful (success), a discarded one was a false
      // positive (failure). This is what makes the operator's judgment move
      // relevance instead of only leaving a parallel verdict concept.
      // Same wrapper hazard on the way out: a ⟨⟩-wrapped ref percent-encodes
      // into a 404 at the usage chokepoint, silently skipping the relevance fold.
      const linkedRef = conceptIdFromRefs(seed.refs_json);
      const conceptId = linkedRef ? plainConceptId(linkedRef) : null;
      if (pending) {
        relevanceStatus = 'relevance: not recorded until the fix is committed';
      } else if (conceptId) {
        const outcome = input.action === 'endorse' ? 'success' : 'failure';
        const usage = await recordConceptUsage(conceptId, outcome);
        relevanceStatus = usage.ok
          ? `relevance: recorded ${outcome} on concept ${conceptId}`
          : `relevance: could not record ${outcome} on concept ${conceptId} (${usage.error})`;
      } else {
        relevanceStatus = 'relevance: no linked concept on this finding — signal skipped';
      }
    }

    const duration = Date.now() - startTime;
    const verb = pending
      ? 'left open: fix pending'
      : input.action === 'endorse'
      ? 'endorsed (finding resolved, retired from get_problems)'
      : 'discarded (finding retracted and removed)';
    const shown = isConceptId ? `${seedId} (via ${plainId})` : seedId;
    let out = `Finding ${shown} ${verb} in ${duration}ms\n  concept-db: ${conceptStatus}`;
    if (loc) out += `\n  fix: ${fixShown(loc)}`;
    if (relevanceStatus) out += `\n  ${relevanceStatus}`;
    if (loc?.kind === 'uncommitted') out += `\n  ${pendingNote(loc)}`;
    return out;
  }

  // Every problem this server lists is an agent finding (agf_*) or a recalled
  // concept (concept_*): there is no server-side analysis whose detections
  // another id could name. Anything else is refused rather than reported done.
  return (
    `Problem ID "${input.problem_id}" is not a finding id, so nothing was recorded. ` +
    'Findings are agf_* ids (from record_finding or get_problems) or concept_* ids (from cross-agent recall); ' +
    'use get_problems to list them.'
  );
}
