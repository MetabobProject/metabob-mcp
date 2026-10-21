// Contract (input schema, behaviour): SPEC §claim_finding
import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import type { LocalStore } from '../local-store.js';
import {
  VERDICT_SHAPE,
  attributionLines,
  conceptDbReachable,
  conceptDbUnavailable,
  conceptIdFromRefs,
  readConceptById,
  parseVerdictConcept,
  postConcept,
  repoLines,
  resolveAuthorVesselId,
  scanVerdicts,
  workspaceRepo,
} from './_findings.js';
import { plainConceptId } from './_concept-content.js';
import {
  CLAIM_DEFAULT_MINUTES,
  CLAIM_MAX_MINUTES,
  claimHolder,
  claimLines,
  parseClaim,
  type ClaimHolder,
} from './_claims.js';

export const ClaimFindingTool = {
  name: 'claim_finding',
  description:
    'Say you are starting work on a finding, so other agents do not start the same work: claim it before you begin, renew while you work, release if you stop. '
    + 'get_problems shows a live claim as "claimed by … until …". A finding someone else holds is reported with its holder and is not claimed. '
    + 'Two agents claiming at once are settled the same way for every reader: the earlier claim holds it, and the later claimer withdraws. '
    + 'A claim lapses at its end unless renewed; mark_complete ends it. Ids are agf_* or concept_*.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      problem_id: { type: 'string', description: 'The finding: an agf_* id (get_problems, record_finding) or a concept_* id (recall)' },
      action: {
        type: 'string',
        enum: ['claim', 'renew', 'release'],
        default: 'claim',
        description: '"claim" before you start, "renew" to keep a claim you hold, "release" when you stop without closing it',
      },
      minutes: {
        type: 'number',
        description: `How long the claim lasts, from now (default ${CLAIM_DEFAULT_MINUTES}, at most ${CLAIM_MAX_MINUTES})`,
      },
    },
    required: ['problem_id'],
  },
};

export const InputSchema = z.object({
  problem_id: z.string().min(1),
  action: z.enum(['claim', 'renew', 'release']).default('claim'),
  minutes: z.number().int().positive().max(CLAIM_MAX_MINUTES).default(CLAIM_DEFAULT_MINUTES),
});

export type ClaimFindingInput = z.infer<typeof InputSchema>;

interface Target {
  /** Every agf_* id the finding carries: a multi-file finding is one finding with one id per file. */
  ids: string[];
  summary: string;
}

async function target(input: ClaimFindingInput, localStore?: LocalStore | null): Promise<Target | string> {
  const plainId = plainConceptId(input.problem_id);
  const isConcept = plainId.startsWith('concept_');
  if (!plainId.startsWith('agf_') && !isConcept) {
    return `"${input.problem_id}" is not a finding id, so nothing was claimed. Findings are agf_* or concept_* ids; get_problems lists them.`;
  }
  const seed = localStore ? (isConcept ? localStore.getSeedByConceptRef(input.problem_id) : localStore.getSeedById(plainId)) : null;
  if (seed) {
    const ref = conceptIdFromRefs(seed.refs_json);
    const siblings = ref ? localStore!.getSeedsByConceptRef(ref) : [];
    return { ids: siblings.length ? siblings.map(s => s.id) : [seed.id], summary: seed.brief };
  }
  if (!isConcept) return `Finding "${plainId}" is not in the local store; claim it by the concept_* id get_problems shows for it.`;
  const remote = await readConceptById(plainId);
  if ('error' in remote) return `Concept "${plainId}" could not be read (${remote.error}), so nothing was claimed.`;
  if (!remote.findingIds.length) return `Concept "${plainId}" carries no agf_* finding id, so it cannot be claimed: verdicts on a finding join on that id.`;
  return { ids: remote.findingIds, summary: remote.summary };
}

/** The finding's verdict state from concept-db: whether it is closed, and its claim holder now. */
export async function state(ids: string[], ownId?: string): Promise<{ closed: string | null; holder: ClaimHolder | null; truncated: boolean; seenOwn: boolean } | string> {
  const scan = await scanVerdicts();
  if (!scan.ok) return `concept-db could not be read (${scan.detail}), so nothing was claimed.`;
  const wanted = new Set(ids);
  let closed: string | null = null;
  const claims = [];
  let seenOwn = false;
  for (const row of scan.rows) {
    const claim = parseClaim(row);
    if (claim) {
      if (wanted.has(claim.findingId)) claims.push(claim);
      if (ownId && claim.conceptId === plainConceptId(ownId)) seenOwn = true;
      continue;
    }
    const v = parseVerdictConcept(String(row.content ?? ''), String(row.summary ?? ''));
    if (v && wanted.has(v.findingId) && (v.verdict === 'fixed' || v.verdict === 'retracted')) closed = v.verdict;
  }
  return { closed, holder: claimHolder(claims, Date.now()), truncated: scan.truncated, seenOwn };
}

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

/**
 * Pauses before each read-back. A read can miss a concept written moments before (seen on the lab: concept-db's
 * own lookup missed a concept it had just created), so the read-back counts only once it shows this claim.
 */
export const READ_BACK_PAUSES_MS = [150, 500, 1_500];
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function handle(
  input: ClaimFindingInput,
  _apiClient: AnalysisAPIClient,
  sessionId: string,
  localStore?: LocalStore | null,
  /** The read-back pauses; tests pass zeros. */
  pauses: readonly number[] = READ_BACK_PAUSES_MS,
): Promise<string> {
  const found = await target(input, localStore);
  if (typeof found === 'string') return found;
  if (!(await conceptDbReachable())) return `${await conceptDbUnavailable()}: a claim is shared through concept-db, so nothing was claimed.`;
  const me = await resolveAuthorVesselId();
  if (!me) return 'No vessel identity resolves for this session, so a claim could not name its holder; nothing was claimed.';
  const key = found.ids[0]!;

  const before = await state(found.ids);
  if (typeof before === 'string') return before;
  const scanNote = before.truncated ? '\n  (concept-db\'s verdicts were read up to the scan limit; an older claim may not have been seen)' : '';
  if (before.closed) {
    return `Finding ${key} is already closed (${before.closed}), so there is nothing to claim. get_problems shows it under Closed findings.`;
  }
  const mine = before.holder?.by === me;

  const write = async (minutes: number | null, tag: 'claimed' | 'withdrawn') => postConcept({
    content: [
      ...claimLines(key, minutes),
      ...repoLines(workspaceRepo()),
      `finding summary: ${found.summary}`,
      ...attributionLines('reviewed_by', me, sessionId),
    ].join('\n'),
    summary: `[verdict:${tag}] ${workspaceRepo()?.name ?? 'unknown'}: ${found.summary}`,
    shape: VERDICT_SHAPE,
    source_type: 'metabob_annotation',
    pointer: { type: VERDICT_SHAPE },
  });
  const failed = (error?: string) => /^key_read_only/.test(error ?? '')
    ? `Not claimed (${error}): this key cannot write, so other agents would not see a claim.`
    : `Not claimed: concept-db refused the write (${error}).`;

  if (input.action === 'release') {
    if (!mine) return `You hold no claim on finding ${key}, so there is nothing to release.${before.holder ? ` ${before.holder.by} holds it until ${when(before.holder.until)}.` : ''}`;
    const posted = await write(null, 'withdrawn');
    return posted.ok ? `Released your claim on finding ${key}; it is open for another agent.` : failed(posted.error);
  }

  if (before.holder && !mine) {
    return `Finding ${key} is claimed by ${before.holder.by} until ${when(before.holder.until)}: someone is working on it, so it was not claimed. `
      + 'Pick another finding, or wait until the claim lapses.' + scanNote;
  }
  if (input.action === 'renew' && !mine) {
    return `You hold no claim on finding ${key} to renew; claim it with action "claim".`;
  }

  const until = new Date(Date.now() + input.minutes * 60_000);
  const posted = await write(input.minutes, 'claimed');
  if (!posted.ok) return failed(posted.error);

  // Two claimers can both get here: read back and apply the rule every reader applies, but only once the read
  // shows this claim. Until then it says nothing about who holds the finding.
  let after: Awaited<ReturnType<typeof state>> = 'not read back';
  for (const ms of pauses) {
    await pause(ms);
    after = await state(found.ids, posted.id);
    if (typeof after === 'string' || after.seenOwn) break;
  }
  if (typeof after === 'string') return `Claim written (concept ${posted.id ?? '?'}), but it could not be read back to confirm it holds: ${after}`;
  if (!after.seenOwn) {
    return `Claim written (concept ${posted.id ?? '?'}), but concept-db's reads do not show it yet, so whether it holds is not settled. `
      + 'Run claim_finding again in a moment to confirm before you start; it lapses on its own if you do not.';
  }
  if (after.holder && after.holder.by !== me) {
    const withdrawn = await write(null, 'withdrawn');
    return `Finding ${key} was claimed by ${after.holder.by} first (until ${when(after.holder.until)}), so your claim was withdrawn${withdrawn.ok ? '' : ` (the withdrawal failed: ${withdrawn.error}; it lapses at ${when(until.getTime())})`}. `
      + 'Pick another finding.' + scanNote;
  }
  const verb = mine ? 'Renewed your claim on' : 'Claimed';
  return `${verb} finding ${key} until ${when(after.holder?.until ?? until.getTime())}. Other agents see it as claimed by ${me}. `
    + 'Renew it if the work runs longer; mark_complete closes the finding and ends the claim; release it if you stop.' + scanNote;
}

/**
 * mark_complete's line when someone other than this vessel holds a live claim on the finding being endorsed:
 * the endorse still goes ahead, since the claimer may be gone and the fix is what counts. Empty otherwise,
 * including when the claims cannot be read. SPEC §mark_complete
 */
export async function claimWarning(ids: string[]): Promise<string> {
  const me = await resolveAuthorVesselId();
  const now = await state(ids);
  if (typeof now === 'string' || !now.holder || now.holder.by === me) return '';
  return `claimed by ${now.holder.by} until ${when(now.holder.until)}; this endorse closes it anyway, which ends their claim`;
}
