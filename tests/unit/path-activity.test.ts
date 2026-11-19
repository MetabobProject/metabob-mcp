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
import { MAX_STALE_MS, READ_TTL_MS, clearGapReadCache, gapsForPath, pathMapper, peekGaps, readGaps, renderGap } from '../../src/tools/_gap-activity';
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

/** Gaps as the detector's records rows: `gap_id` for the id, `meta` for classification_metadata, newest seq last. */
let rowSeq = 0;
function gapRows(gaps: Array<Record<string, any>>): Array<Record<string, any>> {
  return gaps.map(({ id, classification_metadata, ...rest }) => ({
    id: `row_${++rowSeq}`, shape: 'gap', seq: rowSeq, t: '2026-11-19T00:00:00Z', writer: 'pull-sync', role: 'detector', input_refs: [],
    gap_id: id, status: 'open', ...rest, ...(classification_metadata ? { meta: classification_metadata } : {}),
  }));
}
/** A substrate whose records answers these gaps as detector gap rows. */
const serveGaps = (gaps: Array<Record<string, any>>) => installShapeStub({ record_read: () => ({ body: gapRows(gaps) }) });
/** The one pointer the gap read may send. */
const GAP_POINTER = { type: 'record_read', shape: 'gap', where: { role: 'detector' }, stored: true };

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

beforeEach(() => clearGapReadCache());
afterEach(() => setAttachment(null));

describe('the read', () => {
  test('reads the whole open store, held rows included: fresh, then stale while one refresh runs, then anew', async () => {
    const stub = await serveGaps(GAPS);
    expect((await readGaps('open')).ok).toBe(true);
    expect(stub.calls('record_read')).toEqual([GAP_POINTER]);
    await readGaps('open', Date.now() + READ_TTL_MS - 1_000);
    expect(stub.calls('record_read')).toHaveLength(1);
    // Stale: served at once, and one background read refreshes it however many callers ask.
    const stale = Date.now() + READ_TTL_MS + 1_000;
    const [a, b] = await Promise.all([readGaps('open', stale), readGaps('open', stale)]);
    expect(a.ok && b.ok).toBe(true);
    await Bun.sleep(10);
    expect(stub.calls('record_read')).toHaveLength(2);
    // Past MAX_STALE_MS the caller waits for a new read.
    await readGaps('open', Date.now() + MAX_STALE_MS + 1_000);
    expect(stub.calls('record_read')).toHaveLength(3);
  });

  test('concurrent first reads share one request', async () => {
    const stub = await serveGaps(GAPS);
    await Promise.all([readGaps('open'), readGaps('open'), readGaps('open')]);
    expect(stub.calls('record_read')).toHaveLength(1);
  });

  test('peekGaps never starts a read', async () => {
    const stub = await serveGaps(GAPS);
    expect(peekGaps('open')).toBeNull();
    expect(stub.calls('record_read')).toHaveLength(0);
    await readGaps('open');
    expect(peekGaps('open')?.rows.length).toBe(GAPS.length);
  });

  test('the answer is a list of rows, bare or under content; an empty list is an empty store', async () => {
    await installShapeStub({ record_read: () => ({ body: { content: gapRows(GAPS) } }) });
    const wrapped = await readGaps('open');
    expect(wrapped.ok && wrapped.rows.length).toBe(GAPS.length);
    clearGapReadCache();
    await installShapeStub({ record_read: () => ({ body: [] }) });
    expect(await pathActivity({ paths: [FILE] }, apiClient)).toContain(`${FILE} — no open gaps`);
  });

  test('with record_read unserved, the gap rows could not be read: no "nothing to check" answer', async () => {
    await installShapeStub({});
    const out = await pathActivity({ paths: [FILE] }, apiClient);
    expect(out).toStartWith('path_activity: the gap rows could not be read: no_producer(record_read)');
    expect(out).not.toContain('Go ahead');
    expect(out).not.toContain('no open gaps');
  });

  test('a failed read is one named line', async () => {
    await installShapeStub({});
    const r = await readGaps('open');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toStartWith('no_producer(record_read)');
  });
});

// The gaps live in records as the detector's rows of shape gap; path_activity reads them, and nothing else, with one
// constant pointer, and folds them as pull-sync's gap_resolve does: newest seq per gap_id, meta as classification_metadata.
describe("records' gap rows", () => {
  const TEST_FILE = 'repos/goal-host-vessel/test/judge.test.ts';
  const row = (r: Record<string, any>) => ({ shape: 'gap', role: 'detector', writer: 'pull-sync', t: '2026-11-19T00:00:00Z', input_refs: [], status: 'open', ...r });

  test('MUST-FAIL: a file with an open gap returns it, read from record_read gap rows with exactly the one pointer', async () => {
    const stub = await installShapeStub({ record_read: () => ({ body: [
      row({ id: 'row_1', seq: 1, gap_id: 'gap-a', category: 'verification', summary: 'a check fails', meta: { edit_site: FILE } }),
    ] }) });
    const out = await pathActivity({ paths: [FILE], include_closed: true, limit: 3 }, apiClient);
    expect(out).toContain(`${FILE} — 1 open gap`);
    expect(out).toContain('  gap-a  verification  edit site');
    // Every pointer sent is the constant one: no status, limit, path or other caller input widens or steers the read.
    expect(stub.pointers.length).toBeGreaterThan(0);
    for (const p of stub.pointers) expect(p).toEqual(GAP_POINTER);
  });

  test('MUST-FAIL: several rows of one gap_id: the newest numeric seq wins, and a newest closed row is not shown as open', async () => {
    await installShapeStub({ record_read: () => ({ body: [
      row({ id: 'r5', seq: 5, gap_id: 'gap-v', category: 'c5', meta: { edit_site: FILE } }),
      row({ id: 'r9', seq: 9, gap_id: 'gap-v', category: 'c9', meta: { edit_site: FILE } }),
      row({ id: 'rs', seq: '99', gap_id: 'gap-v', category: 'cstring', meta: { edit_site: FILE } }),
      row({ id: 'r7', seq: 7, gap_id: 'gap-v', category: 'c7', meta: { edit_site: FILE } }),
      row({ id: 'rn', gap_id: 'gap-v', category: 'cnoseq', meta: { edit_site: FILE } }),
      row({ id: 'c3', seq: 3, gap_id: 'gap-c', category: 'k3', meta: { edit_site: FILE } }),
      row({ id: 'c8', seq: 8, gap_id: 'gap-c', category: 'k8', status: 'closed', meta: { edit_site: FILE } }),
      row({ id: 'c4', seq: 4, gap_id: 'gap-c', category: 'k4', meta: { edit_site: FILE } }),
    ] }) });
    const out = await pathActivity({ paths: [FILE], include_closed: true }, apiClient);
    expect(out).toContain(`${FILE} — 1 open gap`);
    expect(out).toContain('  gap-v  c9  edit site');
    for (const c of ['c5', 'c7', 'cstring', 'cnoseq']) expect(out).not.toContain(`gap-v  ${c}`);
    expect(out).not.toMatch(/ {2}gap-c {2}k/);
    expect(out).toContain('  closed: gap-c');
  });

  test('MUST-FAIL: a gap row not written by the detector is dropped, and never overrides the detector\'s newest row', async () => {
    await installShapeStub({ record_read: () => ({ body: [
      row({ id: 'p1', seq: 2, gap_id: 'gap-person', role: 'person', category: 'byperson', meta: { edit_site: FILE } }),
      row({ id: 'd1', seq: 3, gap_id: 'gap-d', category: 'bydetector', meta: { edit_site: FILE } }),
      row({ id: 'p2', seq: 4, gap_id: 'gap-d', role: 'person', category: 'personclosed', status: 'closed', meta: { edit_site: FILE } }),
    ] }) });
    const out = await pathActivity({ paths: [FILE] }, apiClient);
    expect(out).toContain(`${FILE} — 1 open gap`);
    expect(out).toContain('  gap-d  bydetector  edit site');
    expect(out).not.toContain('gap-person');
    expect(out).not.toContain('personclosed');
    // This records ignored the read's `where`: the client guard drops the rows and says only how many.
    expect(out).toContain('records answered 2 gap rows not written by the detector to a read narrowed to the detector; they were dropped and are not shown.');
  });

  // A records that honours `where` as records does: each key compared as a string, on the server.
  const honouringWhere = (rows: Array<Record<string, any>>) => (p: Record<string, any>) => ({
    body: rows.filter((r) => (p.shape === undefined || r.shape === p.shape)
      && Object.entries(p.where ?? {}).every(([k, v]) => String(r[k]) === String(v))),
  });
  const PERSON_ROW = row({ id: 'pp', seq: 7, gap_id: 'gap-by-person', role: 'person', category: 'person', summary: `PERSON-ROW-TEXT about ${FILE}`, meta: { edit_site: FILE } });

  test('MUST-FAIL: the read is narrowed to the detector on the server: a person\'s gap row is never served, so never shown or counted', async () => {
    const stub = await installShapeStub({ record_read: honouringWhere([
      row({ id: 'd1', seq: 1, gap_id: 'gap-det', category: 'verification', meta: { edit_site: FILE } }), PERSON_ROW,
    ]) });
    const out = await pathActivity({ paths: [FILE] }, apiClient);
    expect(stub.calls('record_read')).toEqual([GAP_POINTER]);
    expect(stub.calls('record_read')[0]!.where).toEqual({ role: 'detector' });
    expect(out).toContain(`${FILE} — 1 open gap`);
    expect(out).toContain('  gap-det  verification  edit site');
    expect(out).not.toContain('PERSON-ROW-TEXT');
    expect(out).not.toContain('gap-by-person');
    expect(out).not.toContain('not written by the detector');
  });

  test('MUST-FAIL: a returned row of another shape is dropped, counted, and never surfaces', async () => {
    await installShapeStub({ record_read: () => ({ body: [
      row({ id: 'g1', seq: 1, gap_id: 'gap-ok', category: 'verification', meta: { edit_site: FILE } }),
      row({ id: 'row_secret_outcome', seq: 2, shape: 'outcome', gap_id: 'gap-leak', category: 'LEAKED', summary: `LEAKED ${FILE}`, meta: { edit_site: FILE } }),
      row({ id: 'row_secret_world', seq: 3, shape: 'world_changed', gap_id: 'gap-leak2', summary: `LEAKED ${FILE}`, meta: { edit_site: FILE } }),
    ] }) });
    const read = await readGaps('open');
    expect(read.ok && read.rows.map((g) => g.id)).toEqual(['gap-ok']);
    expect(read.ok && read.otherShapes).toBe(2);
    const out = await pathActivity({ paths: [FILE, 'repos/goal-host-vessel/src'] }, apiClient);
    expect(out).toContain(`${FILE} — 1 open gap`);
    for (const s of ['gap-leak', 'LEAKED', 'row_secret', 'outcome', 'world_changed']) expect(out).not.toContain(s);
    expect(out).toContain('records answered 2 rows of another shape to the gap read; they were dropped');
  });

  test('a non-list answer, an error or a 404 is a failed read, never "no gaps"', async () => {
    const answers = [
      { body: { rows: [] } }, { body: { content: JSON.stringify([]) } }, { body: { gaps: [] } }, { body: 'nope' },
      { status: 500, body: { error: 'boom' } }, { status: 403, body: { error: 'caller_lacks_scope' } },
      { body: { content: { summary: 'SECRET-ROW-TEXT' } } }, { status: 502, body: [{ summary: 'SECRET-ROW-TEXT' }] },
    ];
    for (const a of answers) {
      clearGapReadCache();
      await installShapeStub({ record_read: () => a });
      const out = await pathActivity({ paths: [FILE] }, apiClient);
      expect(out).toStartWith('path_activity: the gap rows could not be read');
      expect(out).not.toContain('no open gaps');
      // A failure names the answer's form, never its values: no row text reaches the output.
      expect(out).not.toContain('SECRET-ROW-TEXT');
      expect(out).not.toContain('caller_lacks_scope');
    }
    clearGapReadCache();
    await installShapeStub({});
    expect(await pathActivity({ paths: [FILE] }, apiClient)).toStartWith('path_activity: the gap rows could not be read');
  });

  test('a cut meta stays as stored: the gap matches only by summary, and nothing crashes', async () => {
    const cut = { cut: true, bytes: 5120, start: `{"edit_site":"${FILE}","landing_lease":{"holder":"x"` };
    await installShapeStub({ record_read: () => ({ body: [
      row({ id: 'k1', seq: 1, gap_id: 'gap-cut', category: 'big', summary: `drifted: ${FILE} disagrees`, meta: cut }),
      row({ id: 'k2', seq: 2, gap_id: 'gap-cut-silent', category: 'big', summary: 'names no file', meta: cut }),
    ] }) });
    const read = await readGaps('open');
    expect(read.ok && read.rows.find((g) => g.id === 'gap-cut')?.classification_metadata).toEqual(cut);
    const out = await pathActivity({ paths: [FILE] }, apiClient);
    expect(out).toContain('  gap-cut  big  mentioned');
    expect(out).not.toContain('gap-cut-silent');
  });

  test('MUST-FAIL: a gap naming the file in protected_files (as the failing-test generator writes it) is returned', async () => {
    await installShapeStub({ record_read: () => ({ body: [
      row({ id: 't1', seq: 1, gap_id: 'gap-test', category: 'failing_test', repo: 'goal-host-vessel', walkable: true, summary: 'Failing test(s), detected by pull-sync',
        meta: { protected_files: [TEST_FILE], filed_by: 'pull-sync failing-test generator', failure_class: 'assertion' } }),
      row({ id: 't2', seq: 2, gap_id: 'gap-rel', category: 'failing_test', repo: 'goal-host-vessel', summary: 'Failing test(s)',
        meta: { protected_files: ['test/other.test.ts'], filed_by: 'pull-sync failing-test generator' } }),
      row({ id: 't3', seq: 3, gap_id: 'gap-site', category: 'verification', summary: 'x', meta: { edit_site: TEST_FILE } }),
    ] }) });
    const out = await pathActivity({ paths: [TEST_FILE, 'repos/goal-host-vessel/test/other.test.ts'] }, apiClient);
    expect(out).toContain(`${TEST_FILE} — 2 open gaps`);
    expect(out).toContain('  gap-test  failing_test  names the file');
    // Edit site first, then a file the gap names.
    expect(out.indexOf('gap-site')).toBeLessThan(out.indexOf('gap-test'));
    expect(out).toContain('repos/goal-host-vessel/test/other.test.ts — 1 open gap');
    expect(out).toContain('  gap-rel  failing_test  names the file');
  });

  test('a directory path returns a gap whose protected file lies under it, even when its summary does not name the directory', async () => {
    await installShapeStub({ record_read: () => ({ body: [
      row({ id: 'u1', seq: 1, gap_id: 'gap-under', category: 'failing_test', repo: 'goal-host-vessel', summary: 'Failing test(s), detected by pull-sync',
        meta: { protected_files: ['repos/goal-host-vessel/test/x.test.ts'], filed_by: 'pull-sync failing-test generator' } }),
    ] }) });
    const out = await pathActivity({ paths: ['repos/goal-host-vessel/test'] }, apiClient);
    expect(out).toContain('repos/goal-host-vessel/test — 1 open gap');
    expect(out).toContain('  gap-under  failing_test  names the file');
  });

  test('wording: open gaps naming the paths, never "in flight", and no promise of a landing now', async () => {
    const { PathActivityTool } = await import('../../src/tools/path-activity');
    expect(PathActivityTool.description).toContain('naming');
    expect(PathActivityTool.description).not.toMatch(/in flight|right now/i);
    expect(PathActivityTool.description).toContain('only if a gap row still carries one');
    await serveGaps(GAPS);
    for (const paths of [[FILE], ['repos/activity-api/src/none.ts']]) {
      clearGapReadCache();
      const out = await pathActivity({ paths }, apiClient);
      expect(out).toContain('naming');
      expect(out).not.toMatch(/in flight/i);
    }
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
    expect(onSrc).toContain(`test_writing (check file only): it writes ${CHECK}, not this file, and the check it lands tests this file; queued for the system`);
    expect(onSrc).not.toContain('the system is landing a change to this file');
    await serveGaps([g]);
    expect(await pathActivity({ paths: [FILE] }, apiClient)).toContain(`${FILE} — 1 open gap: 0 being landed by the system now, 0 held, 1 queued`);
    const onCheck = await pathActivity({ paths: [CHECK] }, apiClient);
    expect(onCheck).toContain(`${CHECK} — 1 open gap: 1 being landed by the system now, 0 held, 0 queued`);
    expect(onCheck).toContain('gap-leased  systematic_failure  lease writes');
    expect(onCheck).toContain('test_writing (check file only): the system is landing a change to this file');
  });

  test('controls: a src lease, and a lease with no compose_mode, are landings on the edit site as before', async () => {
    // A write that escapes the vessel once normalised is the src reading too: it fails closed.
    for (const lease of [{ compose_mode: 'src', writes: ['src/index.ts'] }, {}, { compose_mode: 'test_writing' },
      { compose_mode: 'test_writing', writes: ['../other-vessel/test/x.check.ts'] }, { compose_mode: 'test_writing', writes: ['test/../../b/x.ts'] }]) {
      const g = leased(lease);
      expect(renderGap(g, 'edit site', FILE).join('\n')).toMatch(/held by key-595289e706e5 \(the holder's own claim\), attempt 2851260-x, until 2099-10-30 06:16Z \(in \d+ h\): the system is landing a change to this file/);
      clearGapReadCache();
      await serveGaps([g]);
      expect(await pathActivity({ paths: [FILE] }, apiClient)).toContain(`${FILE} — 1 open gap: 1 being landed by the system now, 0 held, 0 queued`);
    }
  });

  test('a lapsed landing lease is not being landed: it is shown lapsed and counted as queued', async () => {
    const lapsed = { id: 'gap-lapsed', category: 'edit_intent_route', classification_metadata: { edit_site: FILE, landing_lease: { holder: 'compose2', attempt: 'x', until: '2026-10-20T12:05:00Z' } } };
    const out = renderGap(lapsed, 'edit site').join('\n');
    expect(out).toMatch(/landing lease lapsed at 2026-10-20 12:05Z \(\d+ (h|min) ago\) \(held by compose2\): not being landed now; queued for the system/);
    expect(out).not.toContain("don't race it");
    await serveGaps([lapsed]);
    expect(await pathActivity({ paths: [FILE] }, apiClient)).toContain(`${FILE} — 1 open gap: 0 being landed by the system now, 0 held, 1 queued`);
  });

  test('a lease with no expiry is flagged as possibly stale, and one inside the skew allowance is still live', async () => {
    const { leaseState, LEASE_SKEW_MS } = await import('../../src/tools/_gap-activity');
    const noExpiry = { id: 'gap-ne', classification_metadata: { edit_site: FILE, landing_lease: { holder: 'n1' } } };
    expect(renderGap(noExpiry, 'edit site').join('\n')).toContain('landing lease held by n1, no expiry recorded (may be stale): not counted as being landed');
    const now = Date.parse('2026-10-20T12:00:00Z');
    expect(leaseState({ holder: 'h', until: new Date(now - LEASE_SKEW_MS / 2).toISOString() }, now)).toBe('live');
    expect(leaseState({ holder: 'h', until: new Date(now - LEASE_SKEW_MS - 1).toISOString() }, now)).toBe('lapsed');
    await serveGaps([noExpiry]);
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
    await serveGaps(many);
    const out = await pathActivity({ paths: [FILE], limit: 5 }, apiClient);
    expect(out).toContain(`${FILE} — 31 open gaps: 1 being landed by the system now, 0 held, 30 queued`);
    expect(out).toContain('  landing  ');
    expect(out.split('\n').filter((l) => /^  q\d+/.test(l))).toHaveLength(5);
    expect(out).toContain('… and 25 more');
  });

  test('lists each path\'s gaps with what to do next', async () => {
    await serveGaps(GAPS);
    const out = await pathActivity({ paths: [FILE, 'repos/activity-api/src/none.ts'] }, apiClient);
    expect(out).toContain(`${FILE} — 3 open gaps: 1 being landed by the system now, 1 held, 1 queued`);
    expect(out).toContain('repos/activity-api/src/none.ts — no open gaps');
    expect(out).toContain('Being landed: an edit before the lease ends is lost or conflicts when the change lands. Tell your user before editing this file.');
    expect(out).toContain('Queued: prefer letting the system land it');
    expect(out).toContain('No open gap names these paths: make the change, and record it.');
  });

  test('the legend names only what is present', async () => {
    await serveGaps(GAPS);
    const out = await pathActivity({ paths: ['repos/activity-api/src/none.ts'] }, apiClient);
    expect(out).toContain('No open gap names these paths');
    expect(out).not.toContain('Being landed:');
    expect(out).not.toContain('Queued:');
  });

  test('a repository the substrate does not mount says so, instead of "nothing in flight"', async () => {
    const root = mkdtempSync(join(tmpdir(), 'unmounted-'));
    git(root, 'init', '-q');
    git(root, 'remote', 'add', 'origin', 'https://github.com/org/metabob-mcp.git');
    await serveGaps(GAPS);
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
    await serveGaps([...GAPS, ...DRIFT]);
    const out = await pathActivityReport({ paths: ['docs/', 'repos/activity-api/src/none.ts'] }, superRepo());
    expect(out).toContain('docs/ — no gap names this path (the gap store places gaps on repos/<vessel>/… paths)');
    expect(out).toContain('4 open gaps carry no edit site (docs-drift 3, edit_intent_route 1), so they are matched to a path only where their text names it');
    expect(out).toContain('No gap names these paths, but gaps without an edit site are not ruled out');
    expect(out).not.toContain('No open gap names these paths');
  });

  test('siteless gaps are counted only for the vessel of the path: another vessel\'s give no count', async () => {
    const placed = GAPS.filter((g) => g.classification_metadata?.edit_site);
    const theirs = DRIFT.map((g) => ({ ...g, remedy: { vessel: 'goal-host-vessel' } }));
    await serveGaps([...placed, ...theirs]);
    const other = await pathActivityReport({ paths: ['repos/activity-api/src/none.ts', 'docs/'] }, superRepo());
    expect(other).not.toContain('no edit site');
    expect(other).toContain('No open gap names these paths: make the change, and record it.');
    clearGapReadCache();
    const own = await pathActivityReport({ paths: ['repos/goal-host-vessel/src/none.ts'] }, superRepo());
    expect(own).toContain('3 open gaps carry no edit site (docs-drift 3)');
  });

  test('with every open gap placed on a path, "no open gaps" is nothing in flight', async () => {
    await serveGaps(GAPS.filter((g) => g.classification_metadata?.edit_site));
    const out = await pathActivityReport({ paths: ['repos/activity-api/src/none.ts'] }, superRepo());
    expect(out).toContain('repos/activity-api/src/none.ts — no open gaps');
    expect(out).not.toContain('no edit site');
    expect(out).toContain('No open gap names these paths: make the change, and record it.');
  });
});

describe('the summary in analyze_impact and assign_git_changes', () => {
  test('uses only a warm cache, and never starts the store read itself', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vessel-sum-'));
    git(root, 'init', '-q');
    git(root, 'remote', 'add', 'origin', 'git@github.com:org/goal-host-vessel.git');
    const stub = await serveGaps(GAPS);
    expect(await gapSummaryLines(['src/index.ts'], root)).toEqual(['', "Open gaps on these files aren't loaded yet; path_activity shows them."]);
    expect(stub.calls('record_read')).toHaveLength(0);
    await readGaps('open');
    const warm = await gapSummaryLines(['src/index.ts'], root);
    expect(warm.join('\n')).toContain('src/index.ts: 3 open gap(s), 1 being landed by the system now, 1 held');
    expect(stub.calls('record_read')).toHaveLength(1);
  });
});
