/**
 * No test sets, on the process environment, a variable that changes how a server
 * connects: proxies, trust, the endpoints or the key. Bun runs every test file in one
 * process, and a workflow test's child servers inherit that environment, so a proxy set
 * by a unit test (and restored too late) sent later servers through a dead proxy.
 * Such a test passes the environment as a parameter instead.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const CONNECTION_VARS = /process\.env(?:\.|\[['"])((?:HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|NODE_EXTRA_CA_CERTS|METABOB_ENDPOINT|DISCOVERY_ENDPOINT|IDENTITY_ENDPOINT|METABOB_API_KEY|SUBSTRATE_API_KEY|SUBSTRATE_ENDPOINT))(?:['"]\])?\s*=(?!=)/;

/** Putting back the value saved before the test is not setting one. */
const RESTORE = /=\s*(?:saved|prev|orig|original|before)\w*\s*;?\s*$/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? (name === 'node_modules' ? [] : files(p)) : /\.ts$/.test(name) ? [p] : [];
  });
}

describe('test environment hygiene', () => {
  test('no test assigns a connection variable on process.env', () => {
    const hits = files(ROOT).flatMap((f) =>
      readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
        CONNECTION_VARS.test(line) && !line.trimStart().startsWith('//') && !RESTORE.test(line) ? [`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`] : []));
    expect(hits).toEqual([]);
  });
});
