// Contract (behaviour): SPEC §claim_finding
/**
 * Claims on findings: who is working on one, written at the start of the work so another agent does not start
 * the same work.
 *
 * A claim is a `finding_verdict` concept, like every other verdict on a finding:
 *   finding: agf_…              the finding claimed
 *   verdict: claimed            or `claim withdrawn`
 *   claim_minutes: <n>          how long it lasts from when concept-db wrote it (created_at)
 *   claim_until: <ISO time>     the same end, by the claimer's clock, for people reading the row
 *   reviewed_by: <vesselId>     the claimer (declared, as every author line is)
 * with summary `[verdict:claimed]` / `[verdict:withdrawn]`. A reader that knows only endorsed and discarded
 * parses neither as a verdict, so to it the finding stays open, as it is.
 *
 * concept-db has no compare-and-set, so two agents that list a finding and then claim it both succeed. The holder
 * is therefore decided by a rule every reader applies to the same rows (claimHolder): each claimer's current
 * claim began with the first of its claims written while none of its earlier ones was live; of the claimers whose
 * claim is live now, the one whose claim began earliest holds it, the lower concept id breaking a tie. A claimer
 * that writes and then reads back someone else as the holder withdraws.
 *
 * A release of someone else's claim (a manager freeing a stalled task) is a withdrawal written by the releaser with
 * `released_for: <holder>` and `release_reason:`. It ends the holder's claim only for a reader that trusts the
 * releaser, one named in that reader's METABOB_CLAIM_RELEASERS. The releaser is the key that wrote the row, as the host
 * stamped it (`written_by`), else, on a row from before the stamp, its declared `reviewed_by`. Trust is the reader's,
 * since any server could name itself, and it only works when every reader has the same list.
 */

import { stampedWriter, type ConceptRow } from './_concept-db.js';
import { headerBlock, plainConceptId } from './_concept-content.js';

/** Default and longest claim, in minutes: long enough for one task, short enough that a crashed claimer's claim lapses. */
export const CLAIM_DEFAULT_MINUTES = 60;
export const CLAIM_MAX_MINUTES = 240;

/**
 * A claim's end is concept-db's created_at plus its minutes, so every time the rule compares comes from one clock.
 * Only "now" is the reader's: a claim counts as live until this long past its end, so a reader whose clock runs
 * fast never frees a claim early. Erring toward live costs a wait, never a double start.
 */
export const CLAIM_SKEW_MS = 2 * 60_000;

export interface ClaimRecord {
  findingId: string;
  kind: 'claimed' | 'withdrawn';
  /** The claimer whose claim this is: for a release of someone else's claim, the holder released. */
  by: string;
  /** A release of someone else's claim: who released it. */
  releasedBy?: string;
  /** When the concept was written (concept-db's created_at), ms. */
  at: number;
  /** Claims only: when it lapses, ms. */
  until?: number;
  conceptId: string;
}

export interface ClaimHolder {
  by: string;
  /** When the holder's current claim began, ms. */
  since: number;
  until: number;
  conceptId: string;
}

function line(content: string, key: string): string {
  return new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(headerBlock(content))?.[1]?.trim() ?? '';
}

let releasersOverride: ReadonlySet<string> | null = null;

/** The writers (keys, by name or id) this reader trusts to release someone else's claim: METABOB_CLAIM_RELEASERS, comma-separated. */
export function claimReleasers(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  if (releasersOverride) return releasersOverride;
  return new Set((env.METABOB_CLAIM_RELEASERS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

/** Tests only: the trusted releasers, in place of the environment (null restores it). */
export function setClaimReleasersForTests(ids: Iterable<string> | null): void {
  releasersOverride = ids ? new Set(ids) : null;
}

/** Whether this reader takes a release by any of `writer` (a key's name or id, or a declared author) of someone else's claim. */
export function trustedReleaser(writer: string | readonly string[], releasers: ReadonlySet<string> = claimReleasers()): boolean {
  return (typeof writer === 'string' ? [writer] : writer).some((w) => !!w && releasers.has(w));
}

/**
 * A claim or a withdrawal out of a `finding_verdict` row, or null for any other verdict. Unattributed claims are
 * ignored: a holder must be nameable. A release of someone else's claim counts as that holder's withdrawal when
 * this reader trusts the releaser, and is ignored otherwise.
 */
export function parseClaim(row: ConceptRow, releasers: ReadonlySet<string> = claimReleasers()): ClaimRecord | null {
  const content = String(row.content ?? '');
  const findingId = /^finding:\s*(agf_\S+)/m.exec(headerBlock(content))?.[1];
  const verdict = line(content, 'verdict');
  const kind = verdict === 'claimed' ? 'claimed' : verdict === 'claim withdrawn' ? 'withdrawn' : null;
  const by = line(content, 'reviewed_by');
  const at = Date.parse(String(row.created_at ?? ''));
  if (!findingId || !kind || !by || !Number.isFinite(at)) return null;
  const releasedFor = kind === 'withdrawn' ? line(content, 'released_for') : '';
  if (releasedFor && releasedFor !== by) {
    const releaser = stampedWriter(row, by);
    // A stamped row is trusted by its key, named by its name or its id; an older row by its declared author.
    const writer = row.written_by ? [releaser, String(row.written_by_key ?? '')] : [by];
    if (!trustedReleaser(writer, releasers)) return null;
    return { findingId, kind, by: releasedFor, releasedBy: releaser, at, conceptId: plainConceptId(row.id) };
  }
  const record: ClaimRecord = { findingId, kind, by, at, conceptId: plainConceptId(row.id) };
  if (kind === 'claimed') {
    const minutes = Number(line(content, 'claim_minutes'));
    // claim_until (the claimer's clock) only when the row predates claim_minutes.
    const until = Number.isFinite(minutes) && minutes > 0 ? at + minutes * 60_000 : Date.parse(line(content, 'claim_until'));
    if (!Number.isFinite(until)) return null;
    record.until = until;
  }
  return record;
}

// @anchor claim-holder
/** Who holds the claim on one finding at `now`, from all of its claim records; null when no claim is live. */
export function claimHolder(records: ClaimRecord[], now: number): ClaimHolder | null {
  const byClaimer = new Map<string, ClaimRecord[]>();
  for (const r of records) byClaimer.set(r.by, [...(byClaimer.get(r.by) ?? []), r]);
  let best: ClaimHolder | null = null;
  for (const [by, rs] of byClaimer) {
    rs.sort((a, b) => a.at - b.at || a.conceptId.localeCompare(b.conceptId));
    let since = 0;
    let startId = '';
    let until = 0;
    for (const r of rs) {
      if (r.kind === 'withdrawn') {
        until = 0;
        continue;
      }
      // A claim written while none of this claimer's claims was live starts a new claim; otherwise it renews.
      if (r.at > until) {
        since = r.at;
        startId = r.conceptId;
      }
      until = Math.max(until, r.until!);
    }
    if (until + CLAIM_SKEW_MS <= now) continue;
    const candidate = { by, since, until, conceptId: startId };
    if (!best || since < best.since || (since === best.since && startId.localeCompare(best.conceptId) < 0)) best = candidate;
  }
  return best;
}

/** The content lines of a claim (`minutes` set), a withdrawal, or a release of someone else's claim. */
export function claimLines(findingId: string, minutes: number | null, now = Date.now(), release?: { holder: string; reason: string }): string[] {
  if (minutes) return [`finding: ${findingId}`, 'verdict: claimed', `claim_minutes: ${minutes}`, `claim_until: ${new Date(now + minutes * 60_000).toISOString()}`];
  return [`finding: ${findingId}`, 'verdict: claim withdrawn', ...(release ? [`released_for: ${release.holder}`, `release_reason: ${release.reason.replace(/\s+/g, ' ')}`] : [])];
}
