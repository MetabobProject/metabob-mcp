/**
 * The attached marker (src/attached-marker.ts): present for the workspace while the attachment is authenticated,
 * absent otherwise and after stop, holding the process id, the org and a time. README §claude-code-plugin
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { keepAttachedMarker, markerPath } from '../../src/attached-marker';
import type { Attachment } from '../../src/attachment';

function fakeAttachment(status: string) {
  const auth: Record<string, unknown> = { status, orgId: 'org_x' };
  return { a: { state: () => ({ auth }), settled: async () => ({ auth }) } as unknown as Attachment, auth };
}

describe('attached marker', () => {
  test('written while authenticated, with pid, org and time; removed on stop', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'marker-ws-'));
    const env = { METABOB_MARKER_DIR: mkdtempSync(join(tmpdir(), 'marker-dir-')) } as NodeJS.ProcessEnv;
    const { a } = fakeAttachment('authenticated');
    const stop = keepAttachedMarker(a, ws, env);
    await Bun.sleep(10);
    const file = markerPath(ws, env);
    const m = JSON.parse(readFileSync(file, 'utf8'));
    expect(m).toMatchObject({ pid: process.pid, orgId: 'org_x' });
    expect(Date.now() - Date.parse(m.at)).toBeLessThan(5_000);
    stop();
    expect(existsSync(file)).toBe(false);
  });

  test('never written for an attachment that is not authenticated', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'marker-ws-'));
    const env = { METABOB_MARKER_DIR: mkdtempSync(join(tmpdir(), 'marker-dir-')) } as NodeJS.ProcessEnv;
    const stop = keepAttachedMarker(fakeAttachment('key_rejected').a, ws, env);
    await Bun.sleep(10);
    expect(existsSync(markerPath(ws, env))).toBe(false);
    stop();
  });
});
