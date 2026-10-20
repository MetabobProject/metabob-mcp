/**
 * The outgoing-text guard (src/outgoing-guard.ts): secrets refuse the call without being
 * repeated, home paths are redacted in prose and refused where the text is acted on, and
 * every field has a size cap. SPEC §outgoing-text-guard
 */
import { describe, expect, test } from 'bun:test';
import { homedir, userInfo } from 'node:os';

import { describeArgsForLog, findSecret, guardToolInput, secretValues } from '../../src/outgoing-guard';

const KEY = 'mbk_Q7f3Zp9LxV2cR8tW1yN4hJ6kD0sGmA5e'; // gitleaks:allow (synthetic fixture)
const env = { METABOB_API_KEY: KEY, PORT: '8080', DEBUG_TOKEN: 'true', SHORT_SECRET: 'dev' } as NodeJS.ProcessEnv;

describe('secrets', () => {
  test('the attachment key refuses the call, naming the field and kind, never the value', () => {
    const r = guardToolInput('record_finding', { summary: 'ok', details: `the key is ${KEY}`, files: ['a.ts'] }, env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('record_finding: refused: outgoing_secret(environment_secret, details). Nothing was sent. Remove the credential from details and call again; the value is not repeated here.');
    expect(r.refusal).not.toContain(KEY);
  });

  test('a short or common value in a secret-named variable is not a secret', () => {
    expect(secretValues(env)).toEqual([KEY]);
    expect(guardToolInput('provide_feedback', { rationale: 'set DEBUG_TOKEN=true on port 8080 in dev' }, env).ok).toBe(true);
  });

  test('a long random value in any secret-named variable is', () => {
    const e = { ...env, GH_DEPLOY_PASSWORD: 'Zx8!qL2#vR9@pT4$wN7%' } as NodeJS.ProcessEnv;
    expect(secretValues(e)).toContain('Zx8!qL2#vR9@pT4$wN7%');
  });

  test.each([
    ['private_key', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc'],
    ['aws_access_key', 'AKIAIOSFODNN7EXAMPLE'], // gitleaks:allow (synthetic fixture)
    ['github_token', `ghp_${'a1B2'.repeat(9)}`],
    ['anthropic_key', `sk-ant-api03-${'x'.repeat(24)}`],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'], // gitleaks:allow (synthetic fixture)
    ['auth_header', 'Authorization: ApiKey abcdefghijklmnop1234'],
    ['url_credentials', 'https://user:hunter2@example.com/repo.git'],
  ])('%s is caught', (kind, text) => {
    expect(findSecret(text, [])).toBe(kind);
  });

  test('ordinary prose is not a secret', () => {
    expect(findSecret('the walk reached; see repos/goal-host-vessel/src/index.ts:120 and sk-learn docs', [])).toBeNull();
  });

  test('nested values of acted fields are scanned', () => {
    const r = guardToolInput('resolve_impulse', { shape: 'memoryNote', pointer: { a: { b: [`token ${KEY}`] } } }, env);
    expect(r.ok).toBe(false);
  });
});

describe('home paths', () => {
  const home = homedir();
  test('in prose they are redacted to ~ and the reply says so', () => {
    const r = guardToolInput('record_finding', { summary: 's', details: `see ${home}/work/x.ts`, files: ['x.ts'] }, env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.details).toBe('see ~/work/x.ts');
    expect(r.notes).toEqual(['details: the home directory was replaced with ~ before sending.']);
  });

  test('in a field the substrate acts on they refuse the call', () => {
    const r = guardToolInput('run_goal_async', { goal: `edit ${home}/work/repo/src/a.ts` }, env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toStartWith('run_goal_async: refused: outgoing_local_path(goal).');
  });

  test('another user\'s home is not this user\'s', () => {
    const other = userInfo().username === 'zz-other' ? 'zz-another' : 'zz-other';
    expect(guardToolInput('run_goal', { goal: `read /home/${other}/notes` }, env).ok).toBe(true);
  });
});

describe('size and scope', () => {
  test('an oversized field is refused with its size and limit', () => {
    const r = guardToolInput('record_finding', { summary: 'x'.repeat(3000), files: ['a'] }, env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('record_finding: refused: outgoing_too_large(summary, 3000 bytes; the limit is 2048). Shorten it; the substrate keeps a summary, not a dump.');
  });

  test('a tool with no guarded fields passes unchanged', () => {
    const input = { workspace_path: `${homedir()}/x` };
    const r = guardToolInput('init_workspace', input, env);
    expect(r).toEqual({ ok: true, input, notes: [] });
  });

  test('the log sees field names and sizes, never values', () => {
    expect(describeArgsForLog({ details: `key ${KEY}`, limit: 3 })).toEqual({ details: `string(${`key ${KEY}`.length})`, limit: 'number' });
  });
});
