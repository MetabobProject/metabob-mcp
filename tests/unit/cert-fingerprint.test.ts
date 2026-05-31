import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readKnownHosts,
  writeKnownHosts,
  isMonitoredHost,
  pickMonitoredHosts,
} from '../../src/cert-fingerprint';

const tempDirs: string[] = [];

function newStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'metabob-known-hosts-'));
  tempDirs.push(dir);
  return join(dir, 'known-hosts.json');
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('isMonitoredHost', () => {
  test('matches metabob.com subdomains', () => {
    expect(isMonitoredHost('activity.metabob.com')).toBe(true);
    expect(isMonitoredHost('identity.metabob.com')).toBe(true);
    expect(isMonitoredHost('metabob.com')).toBe(true);
  });
  test('rejects unrelated hosts', () => {
    expect(isMonitoredHost('example.com')).toBe(false);
    expect(isMonitoredHost('metabob.example.com')).toBe(false);
  });
});

describe('pickMonitoredHosts', () => {
  test('extracts unique https metabob hosts from URLs', () => {
    const hosts = pickMonitoredHosts([
      'https://activity.metabob.com',
      'https://identity.metabob.com/v1/auth/resolve',
      'https://activity.metabob.com/health',
      'http://insecure.metabob.com',
      undefined,
      'not a url',
      'https://example.com',
    ]);
    expect(hosts.sort()).toEqual(['activity.metabob.com', 'identity.metabob.com']);
  });
});

describe('known-hosts store roundtrip', () => {
  test('reads empty when file does not exist', () => {
    const p = newStorePath();
    expect(readKnownHosts(p)).toEqual({ hosts: {} });
  });

  test('writeKnownHosts creates parent dir and persists JSON', () => {
    const p = newStorePath();
    const data = {
      hosts: {
        'activity.metabob.com': {
          fingerprint: 'abc123',
          recordedAt: '2026-05-31T00:00:00.000Z',
        },
      },
    };
    writeKnownHosts(data, p);
    expect(existsSync(p)).toBe(true);
    expect(readKnownHosts(p)).toEqual(data);
  });

  test('corrupt JSON resolves to empty store, no throw', () => {
    const p = newStorePath();
    writeFileSync(p, '{not json', 'utf-8');
    expect(readKnownHosts(p)).toEqual({ hosts: {} });
  });

  test('change detection via direct store mutation', () => {
    const p = newStorePath();
    writeKnownHosts({
      hosts: { 'activity.metabob.com': { fingerprint: 'old', recordedAt: 't1' } },
    }, p);

    // Simulate a probe noticing a new fingerprint.
    const known = readKnownHosts(p);
    const prior = known.hosts['activity.metabob.com'];
    const newFp = 'new-fingerprint';
    const changed = prior && prior.fingerprint !== newFp;
    expect(changed).toBe(true);

    known.hosts['activity.metabob.com'] = { fingerprint: newFp, recordedAt: 't2' };
    writeKnownHosts(known, p);

    const reread = readKnownHosts(p);
    expect(reread.hosts['activity.metabob.com'].fingerprint).toBe(newFp);
  });

  test('schema preserves only known fields and tolerates extras', () => {
    const p = newStorePath();
    writeFileSync(p, JSON.stringify({
      hosts: { 'x.metabob.com': { fingerprint: 'f', recordedAt: 't', extra: 'ignored' } },
      unknownTopLevel: true,
    }), 'utf-8');
    const data = readKnownHosts(p);
    expect(data.hosts['x.metabob.com'].fingerprint).toBe('f');
  });

  test('write uses 0600 mode (best effort)', () => {
    if (process.platform === 'win32') return; // POSIX-only
    const p = newStorePath();
    writeKnownHosts({ hosts: {} }, p);
    const stat = require('node:fs').statSync(p);
    // Mode bits & 0o777 should be 0o600 — but umask may modify; allow both.
    expect((stat.mode & 0o777) & 0o077).toBe(0); // no group/other access
  });
});
