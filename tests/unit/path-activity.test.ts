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
import { FULL_READ_LIMIT, READ_TTL_MS, clearGapReadCache, gapsForPath, pathMapper, readGaps, renderGap } from '../../src/tools/_gap-activity';
import { handle as pathActivity } from '../../src/tools/path-activity';
import { installShapeStub } from '../helpers/shape-stub';
import type { AnalysisAPIClient } from '../../src/api-client';

const apiClient = {} as AnalysisAPIClient;
const FILE = 'repos/goal-host-vessel/src/index.ts';

const GAPS = [
  { id: 'gap-old-edit', category: 'systematic_failure', route: 'composable', updated_at: '2026-09-01T00:00:00Z',
    classification_metadata: { edit_site: FILE, landing_lease: { holder: 'compose2', attempt: '5435-x', until: '2026-10-20T08:48:11Z' } } },
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
  test('reads the whole open store, held rows included, once per TTL', async () => {
    const stub = await installShapeStub({ substrateGap: () => ({ body: { gaps: GAPS, total: GAPS.length } }) });
    const t0 = 1_000_000;
    expect((await readGaps('open', t0)).ok).toBe(true);
    await readGaps('open', t0 + READ_TTL_MS - 1);
    expect(stub.calls('substrateGap')).toEqual([{ type: 'substrateGap', status: 'open', limit: FULL_READ_LIMIT, include_held: true }]);
    await readGaps('open', t0 + READ_TTL_MS);
    expect(stub.calls('substrateGap')).toHaveLength(2);
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
    expect(out).toContain('held by operator ruling: falsifier cannot run yet; review by 10-22 08:00Z; lift: an operator reviews the reverts');
    expect(out).not.toContain('queued');
  });

  test('a landing lease shows its holder as a claim, and says not to race it', () => {
    const out = renderGap(GAPS[0]!, 'edit site').join('\n');
    expect(out).toContain('landing lease: held by compose2 (the holder\'s own claim), attempt 5435-x, until 10-20 08:48Z: the system is landing this; don\'t race it');
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
      { id: 'landing', classification_metadata: { edit_site: FILE, landing_lease: { holder: 'node2', until: '2026-10-20T10:00:00Z' } } },
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
    expect(out).toContain('A held landing lease: wait and look again');
  });
});
