/**
 * path_activity and its shared gap reader (src/tools/_gap-activity.ts): the full read of
 * the gap store, cached across calls; the path mapping for the super-repo, a vessel's
 * checkout and anything else; match order; held, leased and queued gaps.
 * SPEC §path_activity
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setAttachment } from '../../src/attachment';
import { FULL_READ_LIMIT, MAX_STALE_MS, READ_TTL_MS, clearGapReadCache, gapsForPath, pathMapper, peekGaps, readGaps, renderGap } from '../../src/tools/_gap-activity';
import { handle as pathActivity, pathActivityReport } from '../../src/tools/path-activity';
import { gapSummaryLines } from '../../src/tools/_gap-activity';
import { installShapeStub } from '../helpers/shape-stub';
import type { AnalysisAPIClient } from '../../src/api-client';

const apiClient = {} as AnalysisAPIClient;
const FILE = 'repos/goal-host-vessel/src/index.ts';

const GAPS = [
  { id: 'gap-old-edit', category: 'systematic_failure', route: 'composable', updated_at: '2026-09-01T00:00:00Z',
    classification_metadata: { edit_site: FILE, landing_lease: { holder: 'compose2', attempt: '5435-x', until: '2099-10-20T08:48:11Z' } } },
  { id: 'gap-dir', category: 'verification', updated_at: '2026-10-19T00:00:00Z', classification_metadata: { edit_site: 'repos/goal-host-vessel/src/judge/a.ts' } },
  { id: 'gap-mentioned', category: 'edit_intent_route', route: 'dispatchable', updated_at: '2026-10-20T00:00:00Z', remedy: { goal: `edit ${FILE}: x` } },
  { id: 'gap-held', category: 'verification', updated_at: '2026-10-18T00:00:00Z',
    classification_metadata: { edit_site: FILE, operator_hold: true, operator_hold_reason: 'falsifier cannot run yet', disposition: 'needs_information',
      auto_revert_hold: { review_by: '2026-10-22T08:00:00Z', lift: 'an operator reviews the reverts' } } },
  { id: 'gap-other', category: 'other', classification_metadata: { edit_site: 'repos/activity-api/src/x.ts' } },
];

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

beforeEach(() => clearGapReadCache());
afterEach(() => setAttachment(null));

describe('the read', () => {
  test('reads the whole open store, held rows included: fresh, then stale while one refresh runs, then anew', async () => {
    const stub = await installShapeStub({ substrateGap: () => ({ body: { gaps: GAPS, total: GAPS.length } }) });
    expect((await readGaps('open')).ok).toBe(true);
    expect(stub.calls('substrateGap')).toEqual([{ type: 'substrateGap', status: 'open', limit: FULL_READ_LIMIT, include_held: true }]);
    await readGaps('open', Date.now() + READ_TTL_MS - 1_000);
    expect(stub.calls('substrateGap')).toHaveLength(1);
    // Stale: served at once, and one background read refreshes it however many callers ask.
    const stale = Date.now() + READ_TTL_MS + 1_000;
    const [a, b] = await Promise.all([readGaps('open', stale), readGaps('open', stale)]);
    expect(a.ok && b.ok).toBe(true);
    await Bun.sleep(10);
    expect(stub.calls('substrateGap')).toHaveLength(2);
    // Past MAX_STALE_MS the caller waits for a new read.
    await readGaps('open', Date.now() + MAX_STALE_MS + 1_000);
    expect(stub.calls('substrateGap')).toHaveLength(3);
  });

  test('concurrent first reads share one request', async () => {
    const stub = await installShapeStub({ substrateGap: () => ({ body: { gaps: GAPS } }) });
    await Promise.all([readGaps('open'), readGaps('open'), readGaps('open')]);
    expect(stub.calls('substrateGap')).toHaveLength(1);
  });

  test('peekGaps never starts a read', async () => {
    const stub = await installShapeStub({ substrateGap: () => ({ body: { gaps: GAPS } }) });
    expect(peekGaps('open')).toBeNull();
    expect(stub.calls('substrateGap')).toHaveLength(0);
    await readGaps('open');
    expect(peekGaps('open')?.rows.length).toBe(GAPS.length);
  });

  test('reads the resolver\'s own { shape, body: { gaps } } answer, and a content-wrapped one', async () => {
    await installShapeStub({ substrateGap: () => ({ body: { shape: 'substrateGap', body: { gaps: GAPS, total: 5 } } }) });
    const direct = await readGaps('open');
    expect(direct.ok && direct.rows.length).toBe(GAPS.length);
    clearGapReadCache();
    await installShapeStub({ substrateGap: () => ({ body: { success: true, content: JSON.stringify({ gaps: GAPS }) } }) });
    const wrapped = await readGaps('open');
    expect(wrapped.ok && wrapped.rows.length).toBe(GAPS.length);
  });

  test('a substrate with no gap store says there is nothing in flight, not an error', async () => {
    await installShapeStub({});
    const out = await pathActivity({ paths: [FILE] }, apiClient);
    expect(out).toStartWith('path_activity: this substrate keeps no gap store (no substrateGap producer answered)');
    expect(out).toContain('Go ahead with the edit');
  });

  test('a failed read is one named line', async () => {
    await installShapeStub({});
    const r = await readGaps('open');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toStartWith('no_producer(substrateGap)');
  });
});

describe('matching and rendering', () => {
  test('edit site first, then in directory, then mentioned; newest first within each', () => {
    const hits = gapsForPath(GAPS, FILE);
    expect(hits.map((h) => [h.gap.id, h.match])).toEqual([
      ['gap-held', 'edit site'], ['gap-old-edit', 'edit site'], ['gap-mentioned', 'mentioned'],
    ]);
    expect(gapsForPath(GAPS, 'repos/goal-host-vessel/src/judge').map((h) => h.match)).toEqual(['in directory']);
  });

  test('a held gap shows its ruling, review date and lift, never "queued"', () => {
    const out = renderGap(GAPS[3]!, 'edit site').join('\n');
    expect(out).toContain('held by operator ruling: falsifier cannot run yet; review by 2026-10-22 08:00Z');
    expect(out).not.toContain('queued');
  });

  test('a landing lease shows its holder as a claim, and says not to race it', () => {
    const out = renderGap(GAPS[0]!, 'edit site').join('\n');
    expect(out).toMatch(/landing lease: held by compose2 \(the holder's own claim\), attempt 5435-x, until 2099-10-20 08:48Z \(in \d+ h\): the system is landing a change to this file\. An edit made before then is lost or conflicts when it lands\. Whether to edit it now is your user's decision/);
  });

  // A test_writing compose may write only its check file: its lease is not a landing on the gap's src edit site.
  const CHECK = 'repos/goal-host-vessel/test/checks/judge-only-reach.check.ts';
  const leased = (lease: Record<string, unknown>) => ({ id: 'gap-leased', category: 'systematic_failure', updated_at: '2026-10-30T04:16:00Z',
    classification_metadata: { edit_site: FILE, landing_lease: { holder: 'key-595289e706e5', attempt: '2851260-x', until: '2099-10-30T06:16:21Z', ...lease } } });

  test('a test_writing lease is rendered against its check file, not as a landing on the src edit site', async () => {
    const g = leased({ compose_mode: 'test_writing', writes: ['test/checks/judge-only-reach.check.ts'] });
    const onSrc = renderGap(g, 'edit site', FILE).join('\n');
    expect(onSrc).toContain(`test_writing (check file only): it writes ${CHECK}, not this file; queued for the system`);
    expect(onSrc).not.toContain('the system is landing a change to this file');
    await installShapeStub({ substrateGap: () => ({ body: { gaps: [g] } }) });
    expect(await pathActivity({ paths: [FILE] }, apiClient)).toContain(`${FILE} — 1 open gap: 0 being landed by the system now, 0 held, 1 queued`);
    const onCheck = await pathActivity({ paths: [CHECK] }, apiClient);
    expect(onCheck).toContain(`${CHECK} — 1 open gap: 1 being landed by the system now, 0 held, 0 queued`);
    expect(onCheck).toContain('gap-leased  systematic_failure  lease writes');
    expect(onCheck).toContain('test_writing (check file only): the system is landing a change to this file');
  });

  test('controls: a src lease, and a lease with no compose_mode, are landings on the edit site as before', async () => {
    for (const lease of [{ compose_mode: 'src', writes: ['src/index.ts'] }, {}, { compose_mode: 'test_writing' }]) {
      const g = leased(lease);
      expect(renderGap(g, 'edit site', FILE).join('\n')).toMatch(/held by key-595289e706e5 \(the holder's own claim\), attempt 2851260-x, until 2099-10-30 06:16Z \(in \d+ h\): the system is landing a change to this file/);
      clearGapReadCache();
      await installShapeStub({ substrateGap: () => ({ body: { gaps: [g] } }) });
      expect(await pathActivity({ paths: [FILE] }, apiClient)).toContain(`${FILE} — 1 open gap: 1 being landed by the system now, 0 held, 0 queued`);
    }
  });

  test('a lapsed landing lease is not being landed: it is shown lapsed and counted as queued', async () => {
    const lapsed = { id: 'gap-lapsed', category: 'edit_intent_route', classification_metadata: { edit_site: FILE, landing_lease: { holder: 'compose2', attempt: 'x', until: '2026-10-20T12:05:00Z' } } };
    const out = renderGap(lapsed, 'edit site').join('\n');
    expect(out).toMatch(/landing lease lapsed at 2026-10-20 12:05Z \(\d+ (h|min) ago\) \(held by compose2\): not being landed now; queued for the system/);
    expect(out).not.toContain("don't race it");
    await installShapeStub({ substrateGap: () => ({ body: { gaps: [lapsed] } }) });
    expect(await pathActivity({ paths: [FILE] }, apiClient)).toContain(`${FILE} — 1 open gap: 0 being landed by the system now, 0 held, 1 queued`);
  });

  test('a lease with no expiry is flagged as possibly stale, and one inside the skew allowance is still live', async () => {
    const { leaseState, LEASE_SKEW_MS } = await import('../../src/tools/_gap-activity');
    const noExpiry = { id: 'gap-ne', classification_metadata: { edit_site: FILE, landing_lease: { holder: 'n1' } } };
    expect(renderGap(noExpiry, 'edit site').join('\n')).toContain('landing lease held by n1, no expiry recorded (may be stale): not counted as being landed');
    const now = Date.parse('2026-10-20T12:00:00Z');
    expect(leaseState({ holder: 'h', until: new Date(now - LEASE_SKEW_MS / 2).toISOString() }, now)).toBe('live');
    expect(leaseState({ holder: 'h', until: new Date(now - LEASE_SKEW_MS - 1).toISOString() }, now)).toBe('lapsed');
    await installShapeStub({ substrateGap: () => ({ body: { gaps: [noExpiry] } }) });
    expect(await pathActivity({ paths: [FILE] }, apiClient)).toContain('0 being landed by the system now');
  });

  test('an unleased, unheld gap is queued for the system', () => {
    expect(renderGap(GAPS[2]!, 'mentioned').join('\n')).toContain('no landing lease: queued for the system');
  });
});

describe('path mapping', () => {
  test('the super-repo maps relative to its root', () => {
    const root = mkdtempSync(join(tmpdir(), 'super-'));
    mkdirSync(join(root, 'repos', 'goal-host-vessel', 'src'), { recursive: true });
    git(root, 'init', '-q');
    const m = pathMapper(root);
    expect(m.kind).toBe('super-repo');
    expect(m.toStorePath('repos/goal-host-vessel/src/index.ts')).toBe(FILE);
    expect(m.toStorePath(join(root, 'repos', 'goal-host-vessel', 'src', 'index.ts'))).toBe(FILE);
  });

  test('a vessel checkout maps under repos/<origin basename>', () => {
    const root = mkdtempSync(join(tmpdir(), 'vessel-'));
    git(root, 'init', '-q');
    git(root, 'remote', 'add', 'origin', 'git@github.com:org/goal-host-vessel.git');
    const m = pathMapper(root);
    expect(m.kind).toBe('vessel');
    expect(m.toStorePath('src/index.ts')).toBe(FILE);
    expect(m.toStorePath('../outside.ts')).toBeNull();
  });

  test('anything else names only repos/… paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'plain-'));
    const m = pathMapper(root);
    expect(m.kind).toBe('none');
    expect(m.toStorePath('src/index.ts')).toBeNull();
    expect(m.toStorePath(FILE)).toBe(FILE);
  });
});

describe('path_activity', () => {
  test('a long list leads with counts, lists every gap being landed, and caps the rest', async () => {
    const many = [
      ...Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, classification_metadata: { edit_site: FILE } })),
      { id: 'landing', classification_metadata: { edit_site: FILE, landing_lease: { holder: 'node2', until: '2099-10-20T10:00:00Z' } } },
    ];
    await installShapeStub({ substrateGap: () => ({ body: { gaps: many } }) });
    const out = await pathActivity({ paths: [FILE], limit: 5 }, apiClient);
    expect(out).toContain(`${FILE} — 31 open gaps: 1 being landed by the system now, 0 held, 30 queued`);
    expect(out).toContain('  landing  ');
    expect(out.split('\n').filter((l) => /^  q\d+/.test(l))).toHaveLength(5);
    expect(out).toContain('… and 25 more');
  });

  test('lists each path\'s gaps with what to do next', async () => {
    await installShapeStub({ substrateGap: () => ({ body: { gaps: GAPS, total: GAPS.length } }) });
    const out = await pathActivity({ paths: [FILE, 'repos/activity-api/src/none.ts'] }, apiClient);
    expect(out).toContain(`${FILE} — 3 open gaps: 1 being landed by the system now, 1 held, 1 queued`);
    expect(out).toContain('repos/activity-api/src/none.ts — no open gaps');
    expect(out).toContain('Being landed: an edit before the lease ends is lost or conflicts when the change lands. Tell your user before editing this file.');
    expect(out).toContain('Queued: prefer letting the system land it');
    expect(out).toContain('Nothing in flight: make the change, and record it.');
  });

  test('the legend names only what is present', async () => {
    await installShapeStub({ substrateGap: () => ({ body: { gaps: GAPS } }) });
    const out = await pathActivity({ paths: ['repos/activity-api/src/none.ts'] }, apiClient);
    expect(out).toContain('Nothing in flight');
    expect(out).not.toContain('Being landed:');
    expect(out).not.toContain('Queued:');
  });

  test('a repository the substrate does not mount says so, instead of "nothing in flight"', async () => {
    const root = mkdtempSync(join(tmpdir(), 'unmounted-'));
    git(root, 'init', '-q');
    git(root, 'remote', 'add', 'origin', 'https://github.com/org/metabob-mcp.git');
    await installShapeStub({ substrateGap: () => ({ body: { gaps: GAPS } }) });
    const out = await pathActivityReport({ paths: ['src/index.ts', FILE] }, root);
    expect(out).toContain('metabob-mcp may not be a repository this substrate mounts (no open gap names repos/metabob-mcp/)');
    expect(out).toContain('src/index.ts — no gap names this path (the gap store places gaps on repos/<vessel>/… paths)');
    expect(out).not.toContain('carries no edit site');
    expect(out).toContain(`${FILE} — 3 open gaps`);
  });
});

describe('gaps without an edit site', () => {
  function superRepo() {
    const root = mkdtempSync(join(tmpdir(), 'super-unplaced-'));
    git(root, 'init', '-q');
    mkdirSync(join(root, 'repos', 'goal-host-vessel'), { recursive: true });
    return root;
  }
  const DRIFT = Array.from({ length: 3 }, (_, i) => ({ id: `drift${i}`, category: 'docs-drift', summary: 'a doc drifted from the code' }));

  test('a super-repo root path no gap names counts the gaps that name no path, instead of "nothing in flight"', async () => {
    await installShapeStub({ substrateGap: () => ({ body: { gaps: [...GAPS, ...DRIFT] } }) });
    const out = await pathActivityReport({ paths: ['docs/', 'repos/activity-api/src/none.ts'] }, superRepo());
    expect(out).toContain('docs/ — no gap names this path (the gap store places gaps on repos/<vessel>/… paths)');
    expect(out).toContain('4 open gaps carry no edit site (docs-drift 3, edit_intent_route 1), so they are matched to a path only where their text names it');
    expect(out).toContain('No gap names these paths, but gaps without an edit site are not ruled out');
    expect(out).not.toContain('Nothing in flight');
  });

  test('siteless gaps are counted only for the vessel of the path: another vessel\'s give no count', async () => {
    const placed = GAPS.filter((g) => g.classification_metadata?.edit_site);
    const theirs = DRIFT.map((g) => ({ ...g, remedy: { vessel: 'goal-host-vessel' } }));
    await installShapeStub({ substrateGap: () => ({ body: { gaps: [...placed, ...theirs] } }) });
    const other = await pathActivityReport({ paths: ['repos/activity-api/src/none.ts', 'docs/'] }, superRepo());
    expect(other).not.toContain('no edit site');
    expect(other).toContain('Nothing in flight: make the change, and record it.');
    clearGapReadCache();
    const own = await pathActivityReport({ paths: ['repos/goal-host-vessel/src/none.ts'] }, superRepo());
    expect(own).toContain('3 open gaps carry no edit site (docs-drift 3)');
  });

  test('with every open gap placed on a path, "no open gaps" is nothing in flight', async () => {
    await installShapeStub({ substrateGap: () => ({ body: { gaps: GAPS.filter((g) => g.classification_metadata?.edit_site) } }) });
    const out = await pathActivityReport({ paths: ['repos/activity-api/src/none.ts'] }, superRepo());
    expect(out).toContain('repos/activity-api/src/none.ts — no open gaps');
    expect(out).not.toContain('no edit site');
    expect(out).toContain('Nothing in flight: make the change, and record it.');
  });
});

describe('the summary in analyze_impact and assign_git_changes', () => {
  test('uses only a warm cache, and never starts the store read itself', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vessel-sum-'));
    git(root, 'init', '-q');
    git(root, 'remote', 'add', 'origin', 'git@github.com:org/goal-host-vessel.git');
    const stub = await installShapeStub({ substrateGap: () => ({ body: { gaps: GAPS } }) });
    expect(await gapSummaryLines(['src/index.ts'], root)).toEqual(['', "Open gaps on these files aren't loaded yet; path_activity shows them."]);
    expect(stub.calls('substrateGap')).toHaveLength(0);
    await readGaps('open');
    const warm = await gapSummaryLines(['src/index.ts'], root);
    expect(warm.join('\n')).toContain('src/index.ts: 3 open gap(s), 1 being landed by the system now, 1 held');
    expect(stub.calls('substrateGap')).toHaveLength(1);
  });
});
