import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolveVesselId,
  SERVED_SHAPES,
  VESSEL_BASE_NAME,
  VESSEL_VERSION,
} from '../../src/vessel-identity';

function freshWorkspace(): string {
  const dir = join(tmpdir(), `mcp-vid-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('resolveVesselId', () => {
  test('an explicit id wins verbatim (deliberate replica semantics)', async () => {
    const id = await resolveVesselId({ explicit: 'my-vessel', apiKey: 'k', workspaceRoot: freshWorkspace() });
    expect(id).toBe('my-vessel');
  });

  test('explicit id is trimmed', async () => {
    const id = await resolveVesselId({ explicit: '  spaced  ', apiKey: 'k' });
    expect(id).toBe('spaced');
  });

  test('derived id is prefixed and stable across calls (same key + workspace)', async () => {
    const ws = freshWorkspace();
    const a = await resolveVesselId({ apiKey: 'key-abc', workspaceRoot: ws });
    const b = await resolveVesselId({ apiKey: 'key-abc', workspaceRoot: ws });
    expect(a).toBe(b!);
    expect(a!.startsWith(`${VESSEL_BASE_NAME}-`)).toBe(true);
  });

  test('same key + different workspace → different ids (disambiguation)', async () => {
    const a = await resolveVesselId({ apiKey: 'key-abc', workspaceRoot: freshWorkspace() });
    const b = await resolveVesselId({ apiKey: 'key-abc', workspaceRoot: freshWorkspace() });
    expect(a).not.toBe(b!);
  });

  test('same workspace + different key → different ids', async () => {
    const ws = freshWorkspace();
    const a = await resolveVesselId({ apiKey: 'key-1', workspaceRoot: ws });
    const b = await resolveVesselId({ apiKey: 'key-2', workspaceRoot: ws });
    expect(a).not.toBe(b!);
  });

  test('no explicit id and no apiKey → undefined (skip registration, never synthesize)', async () => {
    const id = await resolveVesselId({ workspaceRoot: freshWorkspace() });
    expect(id).toBeUndefined();
  });

  test('an empty explicit id falls through to derivation', async () => {
    const id = await resolveVesselId({ explicit: '   ', apiKey: 'k', workspaceRoot: freshWorkspace() });
    expect(id!.startsWith(`${VESSEL_BASE_NAME}-`)).toBe(true);
  });
});

describe('vessel identity constants', () => {
  test('VESSEL_VERSION is read from package.json (non-empty semver-ish)', () => {
    expect(VESSEL_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('SERVED_SHAPES is the resolver self-description', () => {
    expect(SERVED_SHAPES).toContain('mcp:tool_call');
    expect(SERVED_SHAPES).toContain('code:cochange_prediction');
    expect(SERVED_SHAPES.length).toBe(5);
  });
});
