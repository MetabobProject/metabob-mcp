// Contract (input schema, behaviour): SPEC §mark_complete
import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import type { LocalStore } from '../local-store.js';
import {
  readConceptById,
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
  filesHere,
  linkVerdict,
} from './_findings.js';
import { plainConceptId } from './_concept-content.js';
import { fixLocation, hasRemote, type FixLocation } from '../repo-identity.js';
import { activeWorkspacePath } from '../local-index.js';
import { claimWarning } from './claim-finding.js';
import { reportResult } from '../call-log.js';

/**
 * An endorse of a fix that is still uncommitted does not close the finding: the fix exists only in this
 * checkout's working tree, and every other checkout of the repository still has the bug. It is recorded as a
 * pending fix instead, and the finding stays open org-wide until an endorse can name a commit. SPEC §mark_complete
 */
/**
 * A fix commit no remote branch holds, in a checkout that has a remote, does not close the finding either: other
 * checkouts cannot get it, and in a cell it is gone with the work directory. A checkout with no remote at all still
 * closes, since no one else can have its commits. SPEC §mark_complete
 */
function unpushedFix(loc: FixLocation | null, workspace: string): loc is Extract<FixLocation, { kind: 'commit' }> {
  return loc?.kind === 'commit' && !loc.pushed && hasRemote(workspace);
}

/**
 * A fix pushed only to task branches is not integrated yet: a review merges a task branch, so other checkouts on the
 * integration branch still have the bug. It is recorded as `fix pending (awaiting merge)`, as close by commit records
 * it (src/finding-close.ts), and closes when an endorse finds it merged, or when finding close sees the merge. SPEC §mark_complete
 */
function awaitingMerge(loc: FixLocation | null): loc is Extract<FixLocation, { kind: 'commit' }> & { awaitingMerge: string } {
  return loc?.kind === 'commit' && loc.pushed && !!loc.awaitingMerge;
}

const AWAITING_NOTE = (sha: string, target: string) =>
  `The fix commit ${sha.slice(0, 10)} is only on task branches, so it is not merged into ${target} yet and the finding stays open (shown "fix pending: … awaiting merge"). `
  + 'Once it is merged, fetch and mark_complete endorse again, or run finding close.';

/** Why an endorse leaves the finding open, or null when it closes it. */
type PendingKind = 'uncommitted' | 'unpushed' | 'awaiting merge';
function pendingKind(loc: FixLocation | null, workspace: string): PendingKind | null {
  if (loc?.kind === 'uncommitted') return 'uncommitted';
  if (unpushedFix(loc, workspace)) return 'unpushed';
  if (awaitingMerge(loc)) return 'awaiting merge';
  return null;
}

/** What the fix still needs before the endorse that credits the finding. */
const UNTIL: Record<PendingKind, string> = { uncommitted: 'committed', unpushed: 'pushed', 'awaiting merge': 'merged' };

/** The note an endorse that leaves the finding open ends with. */
function pendingTail(loc: FixLocation | null, kind: PendingKind | null, fixCommit?: string): string {
  if (loc?.kind === 'uncommitted') return pendingNote(loc, fixCommit);
  if (loc?.kind === 'commit' && kind === 'unpushed') return UNPUSHED_NOTE(loc.sha);
  if (awaitingMerge(loc)) return AWAITING_NOTE(loc.sha, loc.awaitingMerge);
  return '';
}

const UNPUSHED_NOTE = (sha: string) =>
  `The fix commit ${sha.slice(0, 10)} is not on any remote branch, so other checkouts cannot get it and the finding stays open (shown "fix pending"). `
  + 'Push it, then mark_complete endorse again.';

function pendingNote(loc: Extract<FixLocation, { kind: 'uncommitted' }>, claimed?: string): string {
  if (claimed && !loc.outside) {
    return `fix_commit ${claimed} was not applied: the finding's files have uncommitted changes, so the finding stays open for other agents (shown "fix pending"). `
      + 'Commit them and endorse again, or, if they are unrelated to the fix, commit or set them aside and endorse with fix_commit again.';
  }
  return loc.outside
    ? 'The finding\'s files are clean and no commit since the finding touches them, but this checkout has uncommitted changes '
      + 'in other files. If the fix is among them, commit it, then mark_complete endorse again; until then the finding stays '
      + 'open for other agents (shown "fix pending").'
    : 'The fix is uncommitted in this checkout, so the finding stays open for other agents (shown "fix pending"). '
      + 'Commit it, then mark_complete endorse again to close the finding with its commit.';
}

/**
 * Nothing in this checkout can be shown to be the fix, so no verdict is written: the finding's files are not here
 * (`absent`); no commit since the finding touches them and nothing is uncommitted, or it has no recorded time to
 * tell (`none`); or the claimed `fix_commit` failed a check (`rejected`).
 */
function noFixHere(id: string, loc: FixLocation, recordedAt: Date | undefined): string {
  if (loc.kind === 'rejected') {
    return `Finding ${id} left open: ${loc.claim ? 'fix_commit ' : ''}${loc.reason}. No verdict was recorded.`;
  }
  if (loc.kind === 'none' && loc.newest) {
    const files = loc.newest.files;
    const shown = files.slice(0, 3).join(', ') + (files.length > 3 ? `, and ${files.length - 3} more` : '');
    return `Finding ${id} left open: no commit since it was recorded touches its files, and none of them has an uncommitted change. `
      + `The newest commit since then is ${loc.newest.sha.slice(0, 10)}${shown ? `, touching ${shown}` : ''}, which is not taken as the fix on its own. No verdict was recorded.\n`
      + `  If that commit is the fix, endorse with fix_commit: "${loc.newest.sha.slice(0, 10)}". If the fix is elsewhere, endorse where it is. If it was never a bug, discard it.`;
  }
  const why = loc.kind === 'absent'
    ? 'none of its files is in this checkout, so this is not the checkout the fix is in'
    : recordedAt
    ? `nothing in this checkout changed since it was recorded (${recordedAt.toISOString()}) — no commit since then and no uncommitted change — so nothing here can be its fix`
    : 'it has no recorded time, so no commit here can be shown to postdate it, and this checkout has no uncommitted change';
  return `Finding ${id} left open: ${why}. No verdict was recorded.\n`
    + '  If the fix is in another checkout, endorse it there, or pull it and endorse here. If it was never a bug, discard it.';
}

/** Kinds for which an endorse writes nothing. */
const NO_FIX = new Set<FixLocation['kind']>(['none', 'absent', 'rejected']);

function fixShown(loc: FixLocation): string {
  if (loc.kind === 'commit') {
    return `commit ${loc.sha.slice(0, 10)}${loc.branch ? ` on ${loc.branch}` : ''}${loc.pushed ? '' : ' (not on any remote branch yet)'}`
      + (loc.claimed ? (loc.predates ? ' (named as the fix; it predates the finding, which was recorded after it)' : ' (named as the fix)') : '')
      + (loc.elsewhere ? ' — it touches none of the finding\'s files' : '');
  }
  if (loc.kind === 'untracked') return 'local to this checkout: the finding\'s files are ignored, so no commit can hold the fix, and no other checkout can check it';
  if (loc.kind === 'uncommitted') return `uncommitted in this checkout${loc.branch ? ` on ${loc.branch}` : ''}${loc.outside ? ' (in files other than the finding\'s)' : ''}`;
  return 'unknown (not a git checkout), so the finding is closed without a commit';
}

export const MarkCompleteTool = {
  name: 'mark_complete',
  description:
    'Mark a finding as resolved (endorsed = you fixed it) or dismiss it (discarded = false positive). Ids are agf_* (from record_finding / get_problems) or concept_* (from cross-agent recall): endorse retires the finding as resolved and records the commit that holds the fix, discard retracts it. Endorse after committing and pushing: a fix still uncommitted in this checkout, on no remote branch yet, or only on a task/* branch awaiting review leaves the finding open, marked fix pending, and a finding no commit since it touches stays open unless you name its fix with fix_commit. Any other id is refused.',
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
      fix_commit: {
        type: 'string',
        description: 'Endorse only: the commit that fixes it, when no commit since the finding touches its files: a fix in another file (the symptom is in one file, the fix in another), or a fix committed before the finding was recorded. It must be in this checkout\'s HEAD, and postdate the finding or touch its files.',
      },
    },
    required: ['problem_id'],
  },
};

export const InputSchema = z.object({
  problem_id: z.string().min(1),
  action: z.enum(['endorse', 'discard']).default('endorse'),
  fix_commit: z.string().trim().regex(/^[0-9a-f]{7,40}$/i, 'a commit sha (7 to 40 hex digits)').optional(),
});

export type MarkCompleteInput = z.infer<typeof InputSchema>;

/**
 * The result kind of a mark_complete reply, for the call log (SPEC §call-log): `pending` (left open with a fix
 * pending), `not_applied` (left open, nothing written, or an id it refuses), `not_shared` (closed locally, but the
 * shared verdict was not written), else `ok`. Read from the reply's own fixed wording.
 */
export function markCompleteResult(out: string): string {
  if (/left open(:|,) fix pending/.test(out)) return 'pending';
  if (/left open:|is not a finding id|not found in the local store|cannot be updated|could not be read|no verdict was recorded/i.test(out)) return 'not_applied';
  if (/concept-db: (write failed|not shared|concept-db unreachable|.*verdict recorded locally only)/.test(out)) return 'not_shared';
  return 'ok';
}

export async function handle(...args: Parameters<typeof closeOrPend>): Promise<string> {
  const out = await closeOrPend(...args);
  reportResult(markCompleteResult(out));
  return out;
}

async function closeOrPend(
  input: MarkCompleteInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
  localStore?: LocalStore | null,
  /** The checkout whose state says where the fix is; the active workspace by default. */
  workspace: string = activeWorkspacePath(),
  /** Close by commit: the ref a fix_commit must be in (default the checkout's HEAD), and how the fix was named. */
  opts: { head?: string; via?: 'trailer' } = {},
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
    // A concept id needs no local store: with no seed, the verdict is written from the recalled concept (below),
    // which is how `metabob-mcp finding close` closes a finding in a cell, where there is no local store.
    if (!localStore && !isConceptId) {
      return `Finding "${plainId}" cannot be updated — local store unavailable in this session.`;
    }
    const seed = !localStore ? null : isConceptId
      // Either stored form matches: getSeedByConceptRef normalises the id and
      // queries both, so a bare id finds a wrapped row and vice versa.
      ? localStore.getSeedByConceptRef(input.problem_id)
      : localStore.getSeedById(input.problem_id);
    // NO LOCAL SEED, CONCEPT ID: write the verdict from the concept itself.
    //
    // The seed only ever supplied three fields to the concept-db write —
    // file_path, brief and the linked concept id — and a recalled concept
    // already carries all three. Refusing here made the normal fleet case
    // impossible: a manager assigns work one agent found, another agent fixes
    // it, and the endorse step cannot land because the seed lives on a third
    // machine, so no verdict would ever be written.
    //
    // The LOCAL half (retire/delete the seed) is genuinely local and is simply
    // skipped — stated in the output rather than pretended.
    if (!seed && isConceptId) {
      if (!(await conceptDbReachable())) {
        return `Concept "${plainId}" has no local seed and concept-db is unavailable (${await conceptDbUnavailable()}), so no verdict was recorded.`;
      }
      const remote = await readConceptById(plainId);
      if ('error' in remote) {
        return `Concept "${plainId}" could not be read (${remote.error}), so no verdict was recorded.\n`
          + `  Check the attachment (/health), or use get_problems to list findings with local agf_* ids.`;
      }
      const loc = input.action === 'endorse' ? fixLocation(workspace, filesHere(remote.content, workspace), remote.recordedAt, input.fix_commit, opts.head) : null;
      if (loc && NO_FIX.has(loc.kind)) return noFixHere(plainId, loc, remote.recordedAt);
      const kind = pendingKind(loc, workspace);
      const pending = kind !== null;
      const verdict = kind ? `fix pending (${kind})` : input.action === 'endorse' ? 'endorsed (resolved)' : 'discarded (retracted)';
      const tag = pending ? 'pending' : input.action;
      // The finding's own repo line when it has one; else this workspace's.
      const here = workspaceRepo();
      const repoContent = remote.repo
        ? [`repo: ${remote.repo}`, ...(remote.repoName ? [`repo_name: ${remote.repoName}`] : [])]
        : repoLines(here);
      const repoShown = remote.repoName || remote.repo || here?.name || 'unknown';
      // Join on the agf_* id the finding carries, exactly as the local path
      // does. Keying on the concept id writes a verdict no reader can match:
      // the row lands in concept-db and recall still shows no verdict. The `||` fallback could never fire, though: record_finding
      // writes the literal "(not cached locally)" into `finding_ids:` when it
      // had no LocalStore, and a truthy placeholder collides EVERY stateless
      // finding's verdict onto one shared key. Require the real shape.
      const findingKey = /^agf_/.test(remote.findingId) ? remote.findingId : plainId;
      const posted = await postConcept({
        content: [
          `finding: ${findingKey}`,
          `verdict: ${verdict}`,
          ...(loc ? fixLines(loc) : []),
          ...(opts.via ? [`fix_via: ${opts.via}`] : []),
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
      if (posted.ok) await linkVerdict(posted.id, plainId);
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
      const claimed = input.action === 'endorse' ? await claimWarning(remote.findingIds.length ? remote.findingIds : [findingKey], plainId) : '';
      return (
        `Finding ${plainId} ${pending ? 'left open, fix pending,' : input.action === 'endorse' ? 'endorsed' : 'discarded'} from the shared record\n` +
        (claimed ? `  claim:      ${claimed}\n` : '') +
        `  concept-db: ${posted.ok ? `verdict shared (concept ${posted.id ?? '?'})` : `write failed (${posted.error})`}\n` +
        (loc ? `  fix:        ${fixShown(loc)}\n` : '') +
        `  relevance:  ${!usage ? `not recorded until the fix is ${kind ? UNTIL[kind] : 'committed'}` : usage.ok ? `recorded ${input.action === 'endorse' ? 'success' : 'failure'}` : `not recorded (${usage.error})`}\n` +
        `  local:      no seed on this machine, so nothing local was retired — the finding was recorded elsewhere` +
        keyedNote +
        (kind ? `\n  ${pendingTail(loc, kind, input.fix_commit)}` : '')
      );
    }
    if (!seed || !localStore) {
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
    const loc = input.action === 'endorse' ? fixLocation(workspace, files, recordedAt, input.fix_commit, opts.head) : null;
    if (loc && NO_FIX.has(loc.kind)) return noFixHere(seedId, loc, recordedAt);
    const kind = pendingKind(loc, workspace);
    const pending = kind !== null;

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
      const verdict = kind ? `fix pending (${kind})` : input.action === 'endorse' ? 'endorsed (resolved)' : 'discarded (retracted)';
      const result = await postConcept({
        content: [
          `finding: ${seedId}`,
          `verdict: ${verdict}`,
          ...(loc ? fixLines(loc) : []),
          ...(opts.via ? [`fix_via: ${opts.via}`] : []),
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
      if (result.ok && conceptRef) await linkVerdict(result.id, plainConceptId(conceptRef));
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
        relevanceStatus = `relevance: not recorded until the fix is ${UNTIL[kind!]}`;
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
    if (input.action === 'endorse' && conceptStatus.startsWith('verdict shared')) {
      const claimed = await claimWarning(toRetire, conceptRef ? plainConceptId(conceptRef) : undefined);
      if (claimed) out += `\n  claim: ${claimed}`;
    }
    if (relevanceStatus) out += `\n  ${relevanceStatus}`;
    if (kind) out += `\n  ${pendingTail(loc, kind, input.fix_commit)}`;
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
