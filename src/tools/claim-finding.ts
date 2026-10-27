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
  linkVerdict,
  scanVerdicts,
  verdictRowsFor,
  workspaceRepo,
} from './_findings.js';
import type { RepoIdentity } from '../repo-identity.js';
import { reportResult } from '../call-log.js';
import { getAttachment } from '../attachment.js';
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
    + 'A claim lapses at its end unless renewed; a mark_complete that closes the finding ends it (a pending endorse does not), and this session\'s claims are released when its server shuts down. '
    + 'A key the fleet trusts (METABOB_CLAIM_RELEASERS) may release a claim someone else holds, with a reason, to free a stalled task. Ids are agf_* or concept_*.',
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
        type: 'integer',
        default: CLAIM_DEFAULT_MINUTES,
        maximum: CLAIM_MAX_MINUTES,
        description: `How long the claim lasts, from now (default ${CLAIM_DEFAULT_MINUTES}, at most ${CLAIM_MAX_MINUTES})`,
      },
      reason: {
        type: 'string',
        description: 'Release only: why you release a claim someone else holds (a stalled worker). Needed for that, and honoured only by agents whose METABOB_CLAIM_RELEASERS names the key you write with',
      },
    },
    required: ['problem_id'],
  },
};

export const InputSchema = z.object({
  problem_id: z.string().min(1),
  action: z.enum(['claim', 'renew', 'release']).default('claim'),
  minutes: z.number().int().positive().max(CLAIM_MAX_MINUTES).default(CLAIM_DEFAULT_MINUTES),
  reason: z.string().trim().min(1).optional(),
});

export type ClaimFindingInput = z.infer<typeof InputSchema>;

interface Target {
  /** Every agf_* id the finding carries: a multi-file finding is one finding with one id per file. */
  ids: string[];
  summary: string;
  /** The finding's concept, which its verdicts and claims are linked to (src/tools/_findings.ts@link-verdict). */
  conceptId?: string;
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
    return { ids: siblings.length ? siblings.map(s => s.id) : [seed.id], summary: seed.brief, conceptId: ref ? plainConceptId(ref) : undefined };
  }
  if (!isConcept) return `Finding "${plainId}" is not in the local store; claim it by the concept_* id get_problems shows for it.`;
  const remote = await readConceptById(plainId);
  if ('error' in remote) return `Concept "${plainId}" could not be read (${remote.error}), so nothing was claimed.`;
  if (!remote.findingIds.length) return `Concept "${plainId}" carries no agf_* finding id, so it cannot be claimed: verdicts on a finding join on that id.`;
  return { ids: remote.findingIds, summary: remote.summary, conceptId: plainId };
}

/** The finding's verdict state from concept-db: whether it is closed, and its claim holder now. */
export async function state(ids: string[], ownId?: string, conceptId?: string): Promise<{ closed: string | null; holder: ClaimHolder | null; truncated: boolean; seenOwn: boolean } | string> {
  const scan = await scanVerdicts();
  if (!scan.ok) return `concept-db could not be read (${scan.detail}), so nothing was claimed.`;
  const rows = await verdictRowsFor(scan, conceptId ? [conceptId] : []);
  const wanted = new Set(ids);
  let closed: string | null = null;
  const claims = [];
  let seenOwn = false;
  for (const row of rows) {
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
 * Pauses before each read-back. A read can miss a concept written moments before (concept-db's own lookup can
 * miss a concept it has just created), so the read-back counts only once it shows this claim.
 */
export const READ_BACK_PAUSES_MS = [150, 500, 1_500];
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

export type ClaimOutcome =
  | 'claimed' | 'renewed' | 'released'
  | 'held' | 'lost' | 'unsettled' | 'closed' | 'refused' | 'error';

export interface ClaimResult {
  outcome: ClaimOutcome;
  message: string;
  /** The finding's agf_* key the verdicts are written under, once it resolved. */
  key?: string;
  /** The holder after the call, when one is known. */
  holder?: { by: string; until: number };
}

export interface ClaimOptions {
  /** The read-back pauses; tests pass zeros. */
  pauses?: readonly number[];
  /** The repository the claim names; the active workspace's by default (task pull names the task's). */
  repo?: RepoIdentity | null;
  /**
   * Withdraw a claim the read-back never shows (`unsettled`), so it cannot hold the finding while the caller moves
   * on: what task pull does, since its next step is another task. An agent's claim_finding leaves it to renew.
   */
  withdrawUnsettled?: boolean;
}

// @anchor session-claims
/**
 * The claims this server process holds through claim_finding, by finding key, so they are released when it shuts
 * down (SPEC §claim_finding): a session that stops while holding a task otherwise blocks it until the claim lapses.
 * Only a claim the tool takes is recorded here; `task pull` calls claim() directly, so its claim outlives its own
 * process for the cell's harness to work, and the harness's server renewing it under the same identity does not
 * record it either. A kill or a crash releases nothing, and the claim lapses at its end.
 */
const sessionClaims = new Map<string, { problemId: string; repo: RepoIdentity | null | undefined; localStore: LocalStore | null | undefined }>();
/** The claims this process wrote whose read-back did not settle: the call that confirms one is kept as taken here. */
const unsettledHere = new Set<string>();

export async function handle(
  input: ClaimFindingInput,
  _apiClient: AnalysisAPIClient,
  sessionId: string,
  localStore?: LocalStore | null,
  opts: ClaimOptions = {},
): Promise<string> {
  const result = await claim(input, sessionId, localStore, opts);
  reportResult(result.outcome);
  if (result.key) {
    // A renewal adds nothing: a claim this process did not take (task pull's, under the same identity) outlives it.
    // The exception is the claim this process wrote whose read-back had not settled: its confirming call renews it.
    const confirmed = result.outcome === 'renewed' && unsettledHere.has(result.key);
    if (result.outcome === 'claimed' || confirmed) sessionClaims.set(result.key, { problemId: input.problem_id, repo: opts.repo, localStore });
    else if (['released', 'lost', 'closed', 'held'].includes(result.outcome)) sessionClaims.delete(result.key);
    if (result.outcome === 'unsettled') unsettledHere.add(result.key);
    else unsettledHere.delete(result.key);
  }
  return result.message;
}

/** The claims this process holds through claim_finding, by finding key. */
export function heldSessionClaims(): string[] {
  return [...sessionClaims.keys()];
}

/**
 * Release the claims this process took through claim_finding and still holds, at shutdown, within `budgetMs`
 * altogether. A finding closed since is left alone (claim() answers `closed` and writes nothing), and so is a claim
 * another agent holds now. Best effort: what is not released in the budget lapses at its end.
 */
export async function releaseSessionClaims(sessionId: string, budgetMs = 5_000): Promise<{ released: string[]; left: string[] }> {
  const released: string[] = [];
  const work = (async () => {
    for (const [key, { problemId, repo, localStore }] of [...sessionClaims]) {
      const r = await claim(InputSchema.parse({ problem_id: problemId, action: 'release' }), sessionId, localStore, { repo, pauses: [] });
      if (r.outcome === 'released') released.push(key);
      sessionClaims.delete(key);
    }
  })().catch(() => undefined);
  await Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, budgetMs).unref?.())]);
  return { released, left: [...sessionClaims.keys()] };
}

/** Tests only: forget the claims this process recorded. */
export function resetSessionClaimsForTests(): void {
  sessionClaims.clear();
  unsettledHere.clear();
}

/** claim_finding's work, with its outcome as a value: what `metabob-mcp task pull` acts on. */
export async function claim(
  input: ClaimFindingInput,
  sessionId: string,
  localStore?: LocalStore | null,
  opts: ClaimOptions = {},
): Promise<ClaimResult> {
  const pauses = opts.pauses ?? READ_BACK_PAUSES_MS;
  const repo = opts.repo === undefined ? workspaceRepo() : opts.repo;
  const r = (outcome: ClaimOutcome, message: string, extra: Partial<ClaimResult> = {}): ClaimResult => ({ outcome, message, ...extra });
  const found = await target(input, localStore);
  if (typeof found === 'string') return r('refused', found);
  if (!(await conceptDbReachable())) return r('error', `${await conceptDbUnavailable()}: a claim is shared through concept-db, so nothing was claimed.`);
  const me = await resolveAuthorVesselId();
  if (!me) return r('refused', 'No vessel identity resolves for this session, so a claim could not name its holder; nothing was claimed.');
  const key = found.ids[0]!;
  const findingConceptId = found.conceptId;

  const before = await state(found.ids, undefined, found.conceptId);
  if (typeof before === 'string') return r('error', before, { key });
  const scanNote = before.truncated ? '\n  (concept-db\'s verdicts were read up to the scan limit; the finding\'s linked claims were read too, but an older claim written before claims were linked may not have been seen)' : '';
  if (before.closed) {
    return r('closed', `Finding ${key} is already closed (${before.closed}), so there is nothing to claim. get_problems shows it under Closed findings.`, { key });
  }
  const mine = before.holder?.by === me;
  const holder = before.holder ? { by: before.holder.by, until: before.holder.until } : undefined;

  const write = async (minutes: number | null, tag: 'claimed' | 'withdrawn', release?: { holder: string; reason: string }) => postConcept({
    content: [
      ...claimLines(key, minutes, Date.now(), release),
      ...repoLines(repo),
      `finding summary: ${found.summary}`,
      ...attributionLines('reviewed_by', me, sessionId),
    ].join('\n'),
    summary: `[verdict:${tag}] ${repo?.name ?? 'unknown'}: ${found.summary}`,
    shape: VERDICT_SHAPE,
    source_type: 'metabob_annotation',
    pointer: { type: VERDICT_SHAPE },
  });
  // A held claim and a release are linked to the finding, so its holder is read even when the verdicts outgrow a
  // scan. The link is written only once the holder is settled: under a race it would double the writes the race
  // makes, and a loser's own claim and withdrawal settle nothing a later reader needs past the scan.
  const link = (id: string | undefined) => linkVerdict(id, findingConceptId);
  const failed = (error?: string) => r(/^key_read_only/.test(error ?? '') ? 'refused' : 'error', /^key_read_only/.test(error ?? '')
    ? `Not claimed (${error}): this key cannot write, so other agents would not see a claim.`
    : `Not claimed: concept-db refused the write (${error}).`, { key });

  if (input.action === 'release') {
    if (!mine && before.holder && input.reason) {
      // Releasing someone else's claim: each reader decides, by the key the host stamps on the row, whether it trusts
      // the releaser, so the release is written and the reply says where it counts.
      const ownKey = getAttachment()?.state().auth.keyId;
      const posted = await write(null, 'withdrawn', { holder: before.holder.by, reason: input.reason });
      if (posted.ok) await link(posted.id);
      return posted.ok
        ? r('released', `Released ${before.holder.by}'s claim on finding ${key} (${input.reason}). It is open for another agent wherever METABOB_CLAIM_RELEASERS names the key this server writes with (${ownKey ? `id ${ownKey}, ` : ''}or its name in Access); elsewhere it holds until ${when(before.holder.until)}.`, { key })
        : failed(posted.error);
    }
    if (!mine) return r('refused', `You hold no claim on finding ${key}, so there is nothing to release.${before.holder ? ` ${before.holder.by} holds it until ${when(before.holder.until)}; to release a stalled claim, pass a reason (it takes METABOB_CLAIM_RELEASERS naming you).` : ''}`, { key, holder });
    const posted = await write(null, 'withdrawn');
    if (posted.ok) await link(posted.id);
    return posted.ok ? r('released', `Released your claim on finding ${key}; it is open for another agent.`, { key }) : failed(posted.error);
  }

  if (before.holder && !mine) {
    return r('held', `Finding ${key} is claimed by ${before.holder.by} until ${when(before.holder.until)}: someone is working on it, so it was not claimed. `
      + 'Pick another finding, or wait until the claim lapses.' + scanNote, { key, holder });
  }
  if (input.action === 'renew' && !mine) {
    return r('refused', `You hold no claim on finding ${key} to renew; claim it with action "claim".`, { key });
  }

  const until = new Date(Date.now() + input.minutes * 60_000);
  let posted = await write(input.minutes, 'claimed');
  // Under concurrent writes concept-db can give up on a write (answered as no_producer). A claim write is safe to repeat, since under the holder rule a second claim of one's own renews
  // it, so it is retried once after a short random pause.
  if (!posted.ok && /^(no_producer|producer_timeout)/.test(posted.error ?? '')) {
    await pause(pauses.length && pauses[0] === 0 ? 0 : 200 + Math.floor(Math.random() * 400));
    posted = await write(input.minutes, 'claimed');
  }
  if (!posted.ok) return failed(posted.error);

  // Two claimers can both get here: read back and apply the rule every reader applies, but only once the read
  // shows this claim. Until then it says nothing about who holds the finding.
  let after: Awaited<ReturnType<typeof state>> = 'not read back';
  for (const ms of pauses) {
    await pause(ms);
    after = await state(found.ids, posted.id, found.conceptId);
    if (typeof after === 'string' || after.seenOwn) break;
  }
  if ((typeof after === 'string' || !after.seenOwn) && opts.withdrawUnsettled) {
    const withdrawn = await write(null, 'withdrawn');
    return r('unsettled', `Claim written (concept ${posted.id ?? '?'}) but not shown by concept-db's reads, so it was withdrawn${withdrawn.ok ? '' : ` (the withdrawal failed: ${withdrawn.error}; it lapses on its own)`}.`, { key });
  }
  if (typeof after === 'string') return r('unsettled', `Claim written (concept ${posted.id ?? '?'}), but it could not be read back to confirm it holds: ${after}`, { key });
  if (!after.seenOwn) {
    return r('unsettled', `Claim written (concept ${posted.id ?? '?'}), but concept-db's reads do not show it yet, so whether it holds is not settled. `
      + 'Run claim_finding again in a moment to confirm before you start; it lapses on its own if you do not.', { key });
  }
  if (after.holder && after.holder.by !== me) {
    const withdrawn = await write(null, 'withdrawn');
    return r('lost', `Finding ${key} was claimed by ${after.holder.by} first (until ${when(after.holder.until)}), so your claim was withdrawn${withdrawn.ok ? '' : ` (the withdrawal failed: ${withdrawn.error}; it lapses at ${when(until.getTime())})`}. `
      + 'Pick another finding.' + scanNote, { key, holder: { by: after.holder.by, until: after.holder.until } });
  }
  await link(posted.id);
  const verb = mine ? 'Renewed your claim on' : 'Claimed';
  const heldUntil = after.holder?.until ?? until.getTime();
  return r(mine ? 'renewed' : 'claimed', `${verb} finding ${key} until ${when(heldUntil)}. Other agents see it as claimed by ${me}. `
    + 'Renew it if the work runs longer; mark_complete closes the finding and ends the claim; release it if you stop.' + scanNote, { key, holder: { by: me, until: heldUntil } });
}

/**
 * mark_complete's line when someone other than this vessel holds a live claim on the finding being endorsed:
 * the endorse still goes ahead, since the claimer may be gone and the fix is what counts. Empty otherwise,
 * including when the claims cannot be read. SPEC §mark_complete
 */
export async function claimWarning(ids: string[], conceptId?: string): Promise<string> {
  const me = await resolveAuthorVesselId();
  const now = await state(ids, undefined, conceptId);
  if (typeof now === 'string' || !now.holder || now.holder.by === me) return '';
  return `claimed by ${now.holder.by} until ${when(now.holder.until)}; this endorse closes it anyway, which ends their claim`;
}
