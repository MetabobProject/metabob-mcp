/**
 * The outgoing-text guard (src/outgoing-guard.ts): secrets refuse the call without being
 * repeated, home paths are redacted in prose and refused where the text is acted on, and
 * every field has a size cap. SPEC §outgoing-text-guard
 */
import { describe, expect, test } from 'bun:test';
import { homedir, userInfo } from 'node:os';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeArgsForLog, findSecret, guardOutgoingPointer, guardToolInput, knownSecrets, secretValues } from '../../src/outgoing-guard';

const KEY = 'mbk_Q7f3Zp9LxV2cR8tW1yN4hJ6kD0sGmA5e'; // gitleaks:allow (synthetic fixture)
const env = { METABOB_API_KEY: KEY, PORT: '8080', DEBUG_TOKEN: 'true', SHORT_SECRET: 'dev' } as NodeJS.ProcessEnv;

describe('secrets', () => {
  test('the attachment key refuses the call, naming the field and kind, never the value', () => {
    const r = guardToolInput('record_finding', { summary: 'ok', details: `the key is ${KEY}`, files: ['a.ts'] }, env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('record_finding: refused: outgoing_secret(known_secret, details). Nothing was sent, and the value is not repeated here. Remove the credential from details, or describe it with the value masked (e.g. postgres://admin:***@host, Authorization: Bearer ***), and call again.');
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
    ['aws_access_key', 'AKIAZ7QX2LMN4PRT8VWY'], // gitleaks:allow (synthetic fixture)
    ['github_token', `ghp_${'a1B2'.repeat(9)}`],
    ['anthropic_key', `sk-ant-api03-${'x'.repeat(24)}`],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'], // gitleaks:allow (synthetic fixture)
    ['auth_header', 'Authorization: ApiKey q7Zp9LxV2cR8tW1y'],
    ['url_credentials', 'https://deploy:Zq8vR2pL9xT4wN7k@example.com/repo.git'],
    ['config_assignment', 'DB_PASSWORD=hunter2Xq9!zR7vL'],
    ['cookie', 'Cookie: session=4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c'],
    // Weak real passwords are the commonest leak; no entropy floor for them.
    ['config_assignment', 'DB_PASSWORD=hunter2hunter2hunter2'], // gitleaks:allow (synthetic fixture)
    ['url_credentials', 'postgres://admin:admin@localhost:5432/app'], // gitleaks:allow (synthetic fixture)
  ])('%s is caught', (kind, text) => {
    expect(findSecret(text, [])).toBe(kind);
  });

  // From qa's probe: prose about credentials, placeholders and documented examples pass.
  test.each([
    'README example sends Authorization: Bearer xxxxxxxxxxxxxxxxxxxx',
    'curl -H "Authorization: Bearer YOUR_TOKEN_GOES_HERE"',
    'Authorization: ApiKey ${METABOB_API_KEY}',
    'the x-api-key: header is validated before the body is read',
    'clone https://USER:PASS@host/repo.git with your own credentials',
    'the docs use AWS\'s example key AKIAIOSFODNN7EXAMPLE', // gitleaks:allow (synthetic fixture)
    'set API_KEY=<your key> in .env',
    'git@github.com:org/repo.git',
    'MAX_TOKENS=4096',
    'TOKEN_TTL=3600',
    'KEY_ROTATION_DAYS=90',
    'max_tokens: 1024',
    'SESSION_TOKEN_TIMEOUT=30m',
  ])('passes: %s', (text) => {
    expect(findSecret(text, [])).toBeNull();
  });

  test('a secret-named variable holding a path, an id or a short value is not a secret', () => {
    const e = { ...env, SSH_KEY_PATH: '/home/someone/.ssh/id_ed25519_work', GPG_KEY_ID: 'ABCDEF0123456789', AWS_SHARED_CREDENTIALS_FILE: '/x/credentials', METABOB_API_KEY: 'dev' } as NodeJS.ProcessEnv; // gitleaks:allow (synthetic fixture)
    expect(secretValues(e)).toEqual([]);
    expect(guardToolInput('record_finding', { summary: 'the dev server signs with key ABCDEF0123456789 from /home/someone/.ssh/id_ed25519_work', files: ['a'] }, e).ok).toBe(true);
  });

  test('a secret in the workspace\'s .env is known, without being in the environment', () => {
    const ws = mkdtempSync(join(tmpdir(), 'guard-ws-'));
    writeFileSync(join(ws, '.env'), 'PORT=3000\nSTRIPE_SECRET=Zx8qL2vR9pT4wN7mK3\nPUBLIC_URL=https://example.com\n');
    const e = { WORKSPACE_PATH: ws } as NodeJS.ProcessEnv;
    // The user's own credential files are read too, so the set is checked for this value only.
    const known = knownSecrets(e, ws);
    expect(known.includes('Zx8qL2vR9pT4wN7mK3')).toBe(true);
    expect(known.includes('3000')).toBe(false);
    const r = guardToolInput('record_finding', { summary: 's', details: 'the config I used: Zx8qL2vR9pT4wN7mK3', files: ['a'] }, e);
    expect(r.ok).toBe(false);
  });

  test('every string field of a sending tool is guarded, listed or not', () => {
    expect(guardToolInput('record_finding', { summary: 's', files: ['a'], status: `open ${KEY}` }, env).ok).toBe(false);
    expect(guardToolInput('concept_record_usage', { concept_id: 'c', outcome: 'success', trace_id: KEY }, env).ok).toBe(false);
    expect(guardToolInput('concept_search', { query: `find ${KEY}` }, env).ok).toBe(false);
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

  test('a local tool passes unchanged: its input never leaves the machine', () => {
    const input = { workspace_path: `${homedir()}/x` };
    const r = guardToolInput('init_workspace', input, env);
    expect(r).toEqual({ ok: true, input, notes: [] });
  });

  test('the log sees field names and sizes, never values', () => {
    expect(describeArgsForLog({ details: `key ${KEY}`, limit: 3 })).toEqual({ details: `string(${`key ${KEY}`.length})`, limit: 'number' });
    expect(describeArgsForLog({ files: ['a', 'b', 'c'], opts: {} })).toEqual({ files: 'array(3)', opts: 'object' });
  });
});

describe('the backstop over server-composed writes (guardOutgoingPointer)', () => {
  const home = homedir();

  test('a home path anywhere in a pointer is replaced with ~ and named by its field path; other values pass', () => {
    const r = guardOutgoingPointer({ type: 'concept_create_write', conceptData: { content: `workspace: ${home}/work/x`, tags: ['a', `${home}/b`], n: 3 } }, env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.redacted).toEqual(['conceptData.content', 'conceptData.tags[1]']);
    expect(JSON.stringify(r.pointer)).not.toContain(home);
    expect((r.pointer.conceptData as Record<string, unknown>).n).toBe(3);
  });

  test('a known secret refuses, naming the field path, never the value; `extra` adds the attachment key', () => {
    const r = guardOutgoingPointer({ type: 'x', conceptData: { content: `k=${KEY}` } }, env);
    expect(r).toEqual({ ok: false, field: 'conceptData.content' });
    const viaExtra = guardOutgoingPointer({ type: 'x', usageData: { trace_id: 'mcp:attach-key-abcdef12' } }, {}, ['attach-key-abcdef12']);
    expect(viaExtra).toEqual({ ok: false, field: 'usageData.trace_id' });
  });

  test('ids and hashes are not read as credentials: only exact known values refuse', () => {
    const r = guardOutgoingPointer({ type: 'x', conceptData: { content: 'fix: commit 3039ca85d27ad7839299bb10f2460c336967714a\nworkspace: 9f2c1d0e8b7a6f5e', summary: 'trace mcp:7d1e2f3a-4b5c-6d7e-8f90-a1b2c3d4e5f6' } }, env);
    expect(r.ok).toBe(true);
  });
});

describe('the backstop in the attachment: every write, never a read', () => {
  test('a server-composed write leaves with the home path redacted; one carrying the key is not sent; a read passes untouched', async () => {
    const { installShapeStub, STUB_KEY } = await import('../helpers/shape-stub');
    const { getAttachment, setAttachment } = await import('../../src/attachment');
    const stub = await installShapeStub({
      concept_create_write: () => ({ body: { success: true, content: JSON.stringify({ id: 'c1' }) } }),
      conceptSearch: () => ({ body: { content: [] } }),
    });
    const a = getAttachment()!;
    await a.resolve({ type: 'concept_create_write', conceptData: { content: `workspace: ${homedir()}/w` } });
    expect(JSON.stringify(stub.calls('concept_create_write')[0])).not.toContain(homedir());
    await expect(a.resolve({ type: 'concept_create_write', conceptData: { content: `leak ${STUB_KEY}` } })).rejects.toThrow(/outgoing_secret\(known_secret, conceptData\.content\): the concept_create_write write was not sent/);
    expect(stub.calls('concept_create_write')).toHaveLength(1);
    await a.resolve({ type: 'conceptSearch', query: `${homedir()}/q` }, { read: true });
    expect(stub.calls('conceptSearch')[0]!.query).toBe(`${homedir()}/q`);
    setAttachment(null);
  });
});
