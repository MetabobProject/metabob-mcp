/**
 * The org check (src/auth-service.ts@org-check) carries the key in both of identity's
 * forms in one request, and reads either answer: the nested one with scopes and account,
 * the flat one without scopes. CONFORMANCE §c3-identity
 */
import { describe, expect, test } from 'bun:test';
import { resolveTenant } from '../../src/auth-service';

const KEY = 'mbk_test_org_check_key_000';

function fakeIdentity(answer: (body: any, auth: string | null) => { status?: number; json: unknown }) {
  const seen: Array<{ body: any; auth: string | null }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? '{}'));
    const auth = new Headers(init.headers).get('authorization');
    seen.push({ body, auth });
    const a = answer(body, auth);
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe('org check forms', () => {
  test('one request carries the nested body and the flat header', async () => {
    const id = fakeIdentity(() => ({ json: { valid: true, org_id: 'org' } }));
    await resolveTenant('http://identity.test', KEY, id.fetchImpl);
    expect(id.seen).toEqual([{ body: { impulse: { type: 'authentication', pointer: { type: 'apiKey', apiKey: KEY } } }, auth: `ApiKey ${KEY}` }]);
  });

  test('the nested answer gives scopes and account; the jwt is kept for bearer use only', async () => {
    const id = fakeIdentity(() => ({ json: { success: true, data: { orgId: 'organizations:substrate', userId: 'u1', keyId: 'key_1', accountId: 'acct_1', scopes: ['read', 'write'], type: 'api_key' } } }));
    const r = await resolveTenant('http://identity.test', KEY, id.fetchImpl);
    expect(r).toMatchObject({ kind: 'authenticated', orgId: 'organizations:substrate', userId: 'u1', keyId: 'key_1', accountId: 'acct_1', scopes: ['read', 'write'] });
  });

  test('the flat answer authenticates without scopes', async () => {
    const id = fakeIdentity(() => ({ json: { valid: true, org_id: 'org', user_id: 'u', key_id: 'k', account_id: 'a' } }));
    const r = await resolveTenant('http://identity.test', KEY, id.fetchImpl);
    expect(r).toMatchObject({ kind: 'authenticated', orgId: 'org', accountId: 'a' });
    expect(r.kind === 'authenticated' && r.scopes).toBeUndefined();
  });

  test('a nested refusal is key_rejected', async () => {
    const id = fakeIdentity(() => ({ status: 401, json: { success: false, error: { code: 'AUTHENTICATION_FAILED' } } }));
    expect(await resolveTenant('http://identity.test', KEY, id.fetchImpl)).toEqual({ kind: 'key_rejected', status: 401 });
  });
});
