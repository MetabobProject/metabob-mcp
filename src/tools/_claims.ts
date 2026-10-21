// Contract (behaviour): SPEC §claim_finding
/**
 * Claims on findings: who is working on one, written at the start of the work so another agent does not start
 * the same work.
 *
 * A claim is a `finding_verdict` concept, like every other verdict on a finding:
 *   finding: agf_…              the finding claimed
 *   verdict: claimed            or `claim withdrawn`
 *   claim_until: <ISO time>     a claim lapses then unless renewed
 *   reviewed_by: <vesselId>     the claimer (declared, as every author line is)
 * with summary `[verdict:claimed]` / `[verdict:withdrawn]`. A reader that knows only endorsed and discarded
 * parses neither as a verdict, so to it the finding stays open, as it is.
 *
 * concept-db has no compare-and-set, so two agents that list a finding and then claim it both succeed. The holder
 * is therefore decided by a rule every reader applies to the same rows (claimHolder): each claimer's current
 * claim began with the first of its claims written while none of its earlier ones was live; of the claimers whose
 * claim is live now, the one whose claim began earliest holds it, the lower concept id breaking a tie. A claimer
 * that writes and then reads back someone else as the holder withdraws.
 */

import type { ConceptRow } from './_concept-db.js';
import { plainConceptId } from './_concept-content.js';

/** Default and longest claim, in minutes: long enough for one task, short enough that a crashed claimer's claim lapses. */
export const CLAIM_DEFAULT_MINUTES = 60;
export const CLAIM_MAX_MINUTES = 240;

export interface ClaimRecord {
  findingId: string;
  kind: 'claimed' | 'withdrawn';
  by: string;
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
  return new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(content)?.[1]?.trim() ?? '';
}

/** A claim or a withdrawal out of a `finding_verdict` row, or null for any other verdict. Unattributed claims are ignored: a holder must be nameable. */
export function parseClaim(row: ConceptRow): ClaimRecord | null {
  const content = String(row.content ?? '');
  const findingId = /^finding:\s*(agf_\S+)/m.exec(content)?.[1];
  const verdict = line(content, 'verdict');
  const kind = verdict === 'claimed' ? 'claimed' : verdict === 'claim withdrawn' ? 'withdrawn' : null;
  const by = line(content, 'reviewed_by');
  const at = Date.parse(String(row.created_at ?? ''));
  if (!findingId || !kind || !by || !Number.isFinite(at)) return null;
  const record: ClaimRecord = { findingId, kind, by, at, conceptId: plainConceptId(row.id) };
  if (kind === 'claimed') {
    const until = Date.parse(line(content, 'claim_until'));
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
    if (until <= now) continue;
    const candidate = { by, since, until, conceptId: startId };
    if (!best || since < best.since || (since === best.since && startId.localeCompare(best.conceptId) < 0)) best = candidate;
  }
  return best;
}

/** The content lines of a claim (`until` set) or a withdrawal. */
export function claimLines(findingId: string, until: Date | null): string[] {
  return until
    ? [`finding: ${findingId}`, 'verdict: claimed', `claim_until: ${until.toISOString()}`]
    : [`finding: ${findingId}`, 'verdict: claim withdrawn'];
}
