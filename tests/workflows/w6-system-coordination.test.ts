/**
 * W6 — working alongside the system (skills/metabob/SKILL.md, "Working alongside the
 * system"), through a real server process against the fake substrate:
 *   path_activity reads the whole gap store once and serves later calls from its cache;
 *   analyze_impact adds the in-flight line only from that cache, never starting the read;
 *   resolve_impulse refuses the system's own writes before any request reaches a producer;
 *   a detached server's local tools make no substrate request at all.
 * SPEC §path_activity, SPEC §resolve_impulse
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { FakeSubstrate } from './harness/fake-substrate';
import { McpServer, cleanupTempDirs, makeWorkspace } from './harness/mcp-client';
import { existsSync } from 'node:fs';
import { markerPath } from '../../src/attached-marker';

setDefaultTimeout(30_000);
const BOOT_TIMEOUT_MS = 30_000;

const FILE = 'repos/goal-host-vessel/src/index.ts';

let fake: FakeSubstrate;
let server: McpServer;
let detached: McpServer;
let attachedWs: string;
let detachedWs: string;

beforeAll(async () => {
  fake = await FakeSubstrate.start();
  fake.state.gaps = [
    { id: 'gap-landing', status: 'open', category: 'systematic_failure', route: 'composable', updated_at: '2026-09-01T00:00:00Z',
      classification_metadata: { edit_site: FILE, landing_lease: { holder: 'node2', attempt: 'a-1', until: '2099-01-01T00:00:00Z' } } },
    { id: 'gap-held', status: 'open', category: 'verification', updated_at: '2026-09-02T00:00:00Z',
      classification_metadata: { edit_site: FILE, operator_hold: true, operator_hold_reason: 'operator-reviewed fix only' } },
    { id: 'gap-queued', status: 'open', category: 'edit_intent_route', updated_at: '2026-10-19T00:00:00Z', remedy: { goal: `edit ${FILE}: x` } },
    { id: 'gap-elsewhere', status: 'open', category: 'other', updated_at: '2026-10-20T00:00:00Z',
      classification_metadata: { edit_site: 'repos/activity-api/src/x.ts' } },
  ];
  // A super-repo layout: repos/<vessel>/… at the workspace root.
  const files = { [FILE]: 'export function main() { return 1; }\n' };
  attachedWs = makeWorkspace('w6-super', files);
  detachedWs = makeWorkspace('w6-detached', files);
  [server, detached] = await Promise.all([
    McpServer.start({ workspace: attachedWs, env: fake.env() }),
    McpServer.start({ workspace: detachedWs, env: { METABOB_API_KEY: undefined, METABOB_ENDPOINT: undefined, DISCOVERY_ENDPOINT: undefined } }),
  ]);
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([server?.stop(), detached?.stop()]);
  await fake?.stop();
  cleanupTempDirs();
}, BOOT_TIMEOUT_MS);

const gapReads = () => fake.requestsFor('substrateGapRead');

describe('W6 working alongside the system', () => {
  test('analyze_impact with a cold cache points at path_activity and starts no read', async () => {
    await server.text('init_workspace', {});
    const out = await server.text('analyze_impact', { changed_files: [FILE] });
    expect(out).toContain("Open gaps on these files aren't loaded yet; path_activity shows them.");
    expect(gapReads()).toHaveLength(0);
  });

  test('path_activity reads the whole store once, through discovery, and shows each state', async () => {
    const out = await server.text('path_activity', { paths: [FILE] });
    expect(out).toContain(`${FILE} — 3 open gaps: 1 being landed by the system now, 1 held, 1 queued`);
    expect(out).toContain('landing lease: held by node2 (the holder\'s own claim)');
    expect(out).toContain('held by operator ruling: operator-reviewed fix only');
    expect(out).toContain('no landing lease: queued for the system');
    expect(out).not.toContain('gap-elsewhere');
    const reads = gapReads();
    expect(reads).toHaveLength(1);
    // The full read: the store has no path filter. A filtered read is a deliberate change to this pointer and
    // to this test, never a return to the full read.
    expect(reads[0]!.body).toMatchObject({ type: 'substrateGap', status: 'open', limit: 1_000_000, include_held: true });
    expect(reads[0]!.forwarded).toBe(true);
  });

  test('later calls come from the cache, and analyze_impact uses it', async () => {
    await server.text('path_activity', { paths: [FILE] });
    const out = await server.text('analyze_impact', { changed_files: [FILE] });
    expect(out).toContain(`${FILE}: 3 open gap(s), 1 being landed by the system now, 1 held`);
    expect(gapReads()).toHaveLength(1);
  });

  test('resolve_impulse refuses the system\'s writes before any request, and passes a plain read', async () => {
    const before = fake.requests.length;
    for (const shape of ['maintenanceLease_write', 'substrateGapLease_write', 'activityExecutionTrace_write', 'shell', 'git_push']) {
      expect(await server.text('resolve_impulse', { shape, pointer: {} })).toStartWith(`resolve_impulse: refused: ${shape} `);
    }
    // pointer.type overrides shape: a read's name cannot carry an action past the allowlist.
    expect(await server.text('resolve_impulse', { shape: 'substrateGap', pointer: { type: 'shell' } })).toStartWith('resolve_impulse: refused: shell ');
    expect(fake.requests.length).toBe(before);
    expect(await server.text('resolve_impulse', { shape: 'substrateGap', pointer: { status: 'open', limit: 1 } })).toStartWith('resolve_impulse substrateGap → discovery /resolve [200]');
  });

  test('a detached server\'s local tools make no substrate request', async () => {
    const before = fake.requests.length;
    await detached.text('init_workspace', {});
    const out = await detached.text('analyze_impact', { changed_files: [FILE] });
    expect(out).not.toContain('path_activity');
    // It is truly unattached (its HOME is a temp directory with no config), not attached elsewhere.
    expect(await detached.text('path_activity', { paths: [FILE] })).toContain('not_configured');
    expect(fake.requests.length).toBe(before);
  });

  // The plugin's edit check holds edits only where a server is attached (README §claude-code-plugin).
  test('the attached server keeps the attached marker for its workspace; the detached one keeps none', async () => {
    await server.text('get_analysis_context', {});
    expect(existsSync(markerPath(attachedWs))).toBe(true);
    expect(existsSync(markerPath(detachedWs))).toBe(false);
  });
});
