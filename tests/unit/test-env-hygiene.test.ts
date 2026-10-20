/**
 * No test sets, on the process environment, a variable that changes how a server
 * connects: proxies, trust, the endpoints, the key, or the config file that names them.
 * Bun runs every test file in one process, and a workflow test's child servers inherit
 * that environment, so a proxy set by a unit test (and restored too late) sent later
 * servers through a dead proxy. Such a test passes the environment as a parameter instead.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const CONNECTION_VAR = '(?:HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|all_proxy|NODE_EXTRA_CA_CERTS|METABOB_ENDPOINT|DISCOVERY_ENDPOINT|IDENTITY_ENDPOINT|METABOB_API_KEY|SUBSTRATE_API_KEY|SUBSTRATE_ENDPOINT|METABOB_CONFIG_PATH|SUBSTRATE_CONFIG_PATH)';
/** `process.env.X = …` or `process.env['X'] = …` for a connection variable. */
const NAMED_WRITE = new RegExp(`process\\.env(?:\\.|\\[['"])${CONNECTION_VAR}(?:['"]\\])?\\s*=(?!=)`);
/** Writes whose key the line does not name: replacing or merging into process.env, or a computed key. */
const WHOLESALE = /Object\.assign\(\s*process\.env\b|(?<![.\w])process\.env\s*=(?!=)/;
const DYNAMIC_WRITE = /process\.env\[(?!['"])[^\]]+\]\s*=(?!=)/;
/** Putting back the value saved before the test is not setting one. */
const RESTORE = /=\s*(?:saved|prev|orig|original|before)\w*\s*;?\s*$/i;
/** A computed-key write inside a loop over the saved values. */
const RESTORE_LOOP = /Object\.entries\(\s*(?:saved|prev|orig|original|before)\w*\s*\)/i;
/** Computed-key writes known not to touch a connection variable, with why. */
const DYNAMIC_OK: Record<string, string> = {
  'unit/vessel-server-auth-allowlist.test.ts': 'ENV_KEY is METABOB_TOOLS, the tool allowlist',
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? (name === 'node_modules' ? [] : files(p)) : /\.ts$/.test(name) ? [p] : [];
  });
}

describe('test environment hygiene', () => {
  test('no test sets a connection variable on process.env', () => {
    const self = relative(ROOT, import.meta.path);
    const hits = files(ROOT).flatMap((f) => {
      const rel = relative(ROOT, f);
      if (rel === self) return [];
      const lines = readFileSync(f, 'utf8').split('\n');
      return lines.flatMap((line, i) => {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return [];
        const nearRestoreLoop = lines.slice(Math.max(0, i - 3), i).some((l) => RESTORE_LOOP.test(l));
        const bad = (NAMED_WRITE.test(line) && !RESTORE.test(line))
          || WHOLESALE.test(line)
          || (DYNAMIC_WRITE.test(line) && !RESTORE.test(line) && !nearRestoreLoop && !Object.hasOwn(DYNAMIC_OK, rel));
        return bad ? [`${rel}:${i + 1}: ${line.trim()}`] : [];
      });
    });
    expect(hits).toEqual([]);
  });
});
