/**
 * Claims on findings (SPEC §claim_finding): who is working on one, decided by one rule every reader applies,
 * since concept-db has no compare-and-set and two agents can both write a claim.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { AnalysisAPIClient } from '../../src/api-client';
import type { SeedRecord } from '../../src/local-store';
import { setAttachment } from '../../src/attachment';
import { CLAIM_SKEW_MS, claimHolder, parseClaim, type ClaimRecord } from '../../src/tools/_claims';
import { fetchAgentFindings, renderFindingsSection, resolveAuthorVesselId } from '../../src/tools/_findings';
import * as ClaimFinding from '../../src/tools/claim-finding';
import * as MarkComplete from '../../src/tools/mark-complete';
import { NO_GIT } from '../helpers/no-git';
import { setResolverIdentity } from '../../src/resolver-identity';
import { installShapeStub } from '../helpers/shape-stub';
import { cleanupTempStores, makeTempStore } from '../helpers/temp-store';

// This process's vessel identity: the claimer every claim here names.
beforeAll(() => setResolverIdentity({ vesselId: 'metabob-mcp-thiscell' }));
afterAll(() => setResolverIdentity({ vesselId: undefined }));

afterEach(() => {
  cleanupTempStores();
  setAttachment(null);
  ClaimFinding.resetSessionClaimsForTests();
});

const api = {} as AnalysisAPIClient;
const MIN = 60_000;
const T = Date.parse('2026-10-21T12:00:00Z');

const claim = (by: string, at: number, until: number, id = `c_${by}_${at}`): ClaimRecord =>
  ({ findingId: 'agf_x', kind: 'claimed', by, at, until, conceptId: id });
const withdraw = (by: string, at: number): ClaimRecord =>
  ({ findingId: 'agf_x', kind: 'withdrawn', by, at, conceptId: `w_${by}_${at}` });

describe('claimHolder', () => {
  test('a live claim holds; a lapsed one does not', () => {
    expect(claimHolder([claim('a', T, T + 60 * MIN)], T + MIN)?.by).toBe('a');
    // A reader allows CLAIM_SKEW_MS past the end before freeing it, since "now" is its own clock.
    expect(claimHolder([claim('a', T, T + 60 * MIN)], T + 61 * MIN)?.by).toBe('a');
    expect(claimHolder([claim('a', T, T + 60 * MIN)], T + 60 * MIN + CLAIM_SKEW_MS)).toBeNull();
  });

  test('the earlier claim holds; a tie goes to the lower concept id', () => {
    expect(claimHolder([claim('b', T + 1, T + 60 * MIN), claim('a', T, T + 60 * MIN)], T + MIN)?.by).toBe('a');
    expect(claimHolder([claim('b', T, T + 60 * MIN, 'c_2'), claim('a', T, T + 60 * MIN, 'c_9')], T + MIN)?.by).toBe('b');
  });

  test('a renewal keeps the claim\'s start, so a later claimer never overtakes the holder', () => {
    const records = [claim('a', T, T + 10 * MIN), claim('b', T + 5 * MIN, T + 65 * MIN), claim('a', T + 9 * MIN, T + 70 * MIN)];
    const h = claimHolder(records, T + 30 * MIN)!;
    expect(h).toMatchObject({ by: 'a', since: T, until: T + 70 * MIN });
  });

  test('a withdrawal ends the claim, and a claim after a lapse starts again', () => {
    expect(claimHolder([claim('a', T, T + 60 * MIN), withdraw('a', T + MIN), claim('b', T + 2 * MIN, T + 60 * MIN)], T + 3 * MIN)?.by).toBe('b');
    // a lapsed at T+10; b claimed at T+12; a claims again at T+13: b began first.
    const records = [claim('a', T, T + 10 * MIN), claim('b', T + 12 * MIN, T + 60 * MIN), claim('a', T + 13 * MIN, T + 60 * MIN)];
    expect(claimHolder(records, T + 20 * MIN)?.by).toBe('b');
  });

  test('parseClaim reads claims and withdrawals, and nothing else', () => {
    const row = (content: string) => ({ id: 'concept:c1', created_at: '2026-10-21T12:00:00Z', content });
    expect(parseClaim(row('finding: agf_x\nverdict: claimed\nclaim_until: 2026-10-21T13:00:00Z\nreviewed_by: v1'))).toMatchObject({ kind: 'claimed', by: 'v1', until: T + 60 * MIN, conceptId: 'c1' });
    // claim_minutes counts from concept-db's created_at, whatever the claimer's clock wrote in claim_until.
    expect(parseClaim(row('finding: agf_x\nverdict: claimed\nclaim_minutes: 30\nclaim_until: 2030-01-01T00:00:00Z\nreviewed_by: v1'))?.until).toBe(T + 30 * MIN);
    expect(parseClaim(row('finding: agf_x\nverdict: claim withdrawn\nreviewed_by: v1'))?.kind).toBe('withdrawn');
    expect(parseClaim(row('finding: agf_x\nverdict: endorsed (resolved)\nreviewed_by: v1'))).toBeNull();
    // A claim must name its holder.
    expect(parseClaim(row('finding: agf_x\nverdict: claimed\nclaim_until: 2026-10-21T13:00:00Z'))).toBeNull();
  });
});

/** A concept-db that keeps what is written: verdict rows by shape, each stamped with created_at and an id. */
async function db(opts: { rows?: Array<Record<string, unknown>>; onWrite?: (rows: Array<Record<string, unknown>>, at: number) => void; lagReads?: boolean } = {}) {
  const rows = opts.rows ?? [];
  let n = 0;
  const stub = await installShapeStub({
    // lagReads: list reads never show this test's own writes, as a lagging read path would.
    conceptSearch: (p) => ({ body: { content: rows.filter(r => r.shape === p.shape && !(opts.lagReads && String(r.id).startsWith('concept:v'))) } }),
    concept_create_write: (p) => {
      const at = Date.now() + n;
      n++;
      opts.onWrite?.(rows, at);
      const id = `v${String(n).padStart(3, '0')}`;
      rows.push({ id: `concept:${id}`, shape: p.conceptData.shape, summary: p.conceptData.summary, content: p.conceptData.content, created_at: new Date(at).toISOString() });
      return { body: { success: true, content: JSON.stringify({ id }) } };
    },
  });
  return { stub, rows };
}

function seeded() {
  const { store } = makeTempStore('claim-');
  const seed: SeedRecord = {
    id: 'agf_task1', workspace_id: 'default', file_path: 'src/stats.ts', line_start: 1, line_end: 1,
    category: 'task', severity: 'MEDIUM', brief: 'fix average()', confidence: 1,
    refs_json: JSON.stringify(['concept:cf_task1']), produced_at: Date.now(), read_at: null, stale: false,
  };
  store.upsertSeed(seed);
  return store;
}

const other = (verdict: string, at: number, extra = '') => ({
  id: `concept:o${at}`, shape: 'finding_verdict', created_at: new Date(at).toISOString(),
  content: `finding: agf_task1\nverdict: ${verdict}\n${extra}reviewed_by: metabob-mcp-other`,
});

describe('claim_finding', () => {
  const run = (store: ReturnType<typeof seeded>, args: Record<string, unknown> = {}) =>
    ClaimFinding.handle(ClaimFinding.InputSchema.parse({ problem_id: 'agf_task1', ...args }), api, 's1', store, { pauses: [0, 0, 0] });

  test('claims, renews, releases; each write is a finding_verdict naming the claimer', async () => {
    const { rows } = await db();
    const store = seeded();
    const me = await resolveAuthorVesselId();
    expect(await run(store)).toContain('Claimed finding agf_task1 until');
    expect(String(rows[0]!.content)).toMatch(new RegExp(`^verdict: claimed$[\\s\\S]*^claim_until: \\S+$[\\s\\S]*^reviewed_by: ${me}$`, 'm'));
    expect(String(rows[0]!.summary)).toStartWith('[verdict:claimed]');
    expect(await run(store, { action: 'renew', minutes: 90 })).toContain('Renewed your claim on finding agf_task1');
    expect(await run(store, { action: 'release' })).toContain('Released your claim');
    expect(String(rows[2]!.content)).toContain('verdict: claim withdrawn');
    expect(await run(store, { action: 'release' })).toContain('You hold no claim');
  });

  test('at shutdown the claims this session took are released; a closed finding is left alone', async () => {
    const { rows } = await db();
    const store = seeded();
    await run(store);
    expect(ClaimFinding.heldSessionClaims()).toEqual(['agf_task1']);
    const out = await ClaimFinding.releaseSessionClaims('s1', 5_000);
    expect(out).toEqual({ released: ['agf_task1'], left: [] });
    expect(String(rows.at(-1)!.content)).toContain('verdict: claim withdrawn');

    // Claimed, then closed: the release writes nothing.
    const closed = await db();
    const store2 = seeded();
    await run(store2);
    await MarkComplete.handle(MarkComplete.InputSchema.parse({ problem_id: 'agf_task1' }), api, 's1', store2, NO_GIT);
    const writes = closed.rows.length;
    expect((await ClaimFinding.releaseSessionClaims('s1', 5_000)).released).toEqual([]);
    expect(closed.rows).toHaveLength(writes);
  });

  test('a claim made by calling claim() directly (task pull) is not released at shutdown', async () => {
    const { rows } = await db();
    const store = seeded();
    const r = await ClaimFinding.claim(ClaimFinding.InputSchema.parse({ problem_id: 'agf_task1' }), 's1', store, { pauses: [0, 0, 0] });
    expect(r.outcome).toBe('claimed');
    expect(ClaimFinding.heldSessionClaims()).toEqual([]);
    expect(await ClaimFinding.releaseSessionClaims('s1', 5_000)).toEqual({ released: [], left: [] });
    expect(rows).toHaveLength(1);
  });

  test('a finding another agent holds is reported with its holder and not claimed', async () => {
    const { rows } = await db({ rows: [other('claimed', Date.now() - MIN, `claim_until: ${new Date(Date.now() + 30 * MIN).toISOString()}\n`)] });
    const out = await run(seeded());
    expect(out).toContain('is claimed by metabob-mcp-other until');
    expect(out).toContain('it was not claimed');
    expect(rows).toHaveLength(1);
  });

  test('a race: a claim written first by another agent wins on read-back, and this claim is withdrawn', async () => {
    const { rows } = await db({
      onWrite: (rs, at) => {
        // The other agent's claim lands between our check and our write, stamped just before ours.
        if (!rs.some(r => String(r.content).includes('metabob-mcp-other'))) {
          rs.push(other('claimed', at - 1, `claim_until: ${new Date(at + 60 * MIN).toISOString()}\n`));
        }
      },
    });
    const out = await run(seeded());
    expect(out).toContain('was claimed by metabob-mcp-other first');
    expect(out).toContain('your claim was withdrawn');
    expect(String(rows.at(-1)!.content)).toContain('verdict: claim withdrawn');
  });

  test('a claim the read-back does not show yet is not settled: nothing is reported as held', async () => {
    const { rows } = await db({ lagReads: true });
    const out = await run(seeded());
    expect(out).toContain("concept-db's reads do not show it yet, so whether it holds is not settled");
    expect(out).not.toContain('Claimed finding');
    expect(rows).toHaveLength(1);
  });

  test('endorsing a finding another agent holds goes ahead, and says whose claim it ends', async () => {
    await db({ rows: [other('claimed', Date.now() - MIN, 'claim_minutes: 60\n')] });
    const out = await MarkComplete.handle(MarkComplete.InputSchema.parse({ problem_id: 'agf_task1' }), api, 's1', seeded(), NO_GIT);
    expect(out).toContain('endorsed');
    expect(out).toMatch(/claim: claimed by metabob-mcp-other until \S+ \S+Z; this endorse closes it anyway, which ends their claim/);
  });

  test('the holder\'s own endorse carries no claim line', async () => {
    const { rows } = await db();
    const store = seeded();
    await run(store);
    expect(rows).toHaveLength(1);
    const out = await MarkComplete.handle(MarkComplete.InputSchema.parse({ problem_id: 'agf_task1' }), api, 's1', store, NO_GIT);
    expect(out).not.toContain('claim:');
  });

  test('a claim write concept-db gives up on is retried once', async () => {
    let refused = 0;
    const { rows } = await db({ onWrite: () => {} });
    const stub = await installShapeStub({
      conceptSearch: (p) => ({ body: { content: rows.filter(r => r.shape === p.shape) } }),
      concept_create_write: (p) => {
        if (refused++ === 0) return { status: 404, body: { error: 'Not found', shape: 'concept_create_write' } };
        rows.push({ id: 'concept:v900', shape: p.conceptData.shape, summary: p.conceptData.summary, content: p.conceptData.content, created_at: new Date().toISOString() });
        return { body: { success: true, content: JSON.stringify({ id: 'v900' }) } };
      },
    });
    expect(await run(seeded())).toContain('Claimed finding agf_task1');
    expect(stub.calls('concept_create_write')).toHaveLength(2);
  });

  test('a closed finding cannot be claimed', async () => {
    const { rows } = await db({ rows: [other('endorsed (resolved)', Date.now() - MIN)] });
    expect(await run(seeded())).toContain('is already closed (fixed)');
    expect(rows).toHaveLength(1);
  });

  test('with no vessel identity nothing is claimed, since a claim must name its holder', async () => {
    await db();
    setResolverIdentity({ vesselId: undefined });
    try {
      // resolveAuthorVesselId re-derives from METABOB_API_KEY when boot set none; this test process has no key.
      const out = await run(seeded());
      if (!(await resolveAuthorVesselId())) expect(out).toContain('could not name its holder; nothing was claimed');
    } finally {
      setResolverIdentity({ vesselId: 'metabob-mcp-thiscell' });
    }
  });

  test('a read-only key writes no claim and says so', async () => {
    await installShapeStub({ conceptSearch: () => ({ body: { content: [] } }) }, { scopes: ['read'] });
    expect(await run(seeded())).toContain('key_read_only');
  });

  test('recall shows a live claim on an open finding, and none once it is closed', async () => {
    const finding = { id: 'concept:cf_task1', shape: 'code_finding', summary: '[MEDIUM][task] kappa: fix average()', content: 'repo: kappa\nfiles: src/stats.ts\nfinding_ids: agf_task1' };
    const live = other('claimed', Date.now() - MIN, `claim_until: ${new Date(Date.now() + 30 * MIN).toISOString()}\n`);
    await db({ rows: [finding, live] });
    let r = await fetchAgentFindings(api, { repo: 'kappa' });
    expect(r.findings[0]!.claim).toMatchObject({ by: 'metabob-mcp-other', here: false });
    expect(renderFindingsSection(r, { max: 10 })).toMatch(/\[claimed by metabob-mcp-other until \S+ \S+Z: someone is working on it\]/);
    await db({ rows: [finding, live, other('endorsed (resolved)', Date.now())] });
    r = await fetchAgentFindings(api, { repo: 'kappa' });
    expect(r.findings[0]!.claim).toBeUndefined();
    expect(r.findings[0]!.verdict).toBe('fixed');
  });
});
