/**
 * Regression tests for the two doors this process serves on the resolve path.
 *
 * DISCRIMINATORS (each was GREEN behaviour before the fix, i.e. these assertions
 * FAIL against the old code):
 *   - "anonymous mode: no credential configured → 401". The 401 gate used to be
 *     nested inside `if (apiKey || identityKey)`, so with neither configured the
 *     resolver served EVERY request unauthenticated on 0.0.0.0 while
 *     /v2/capabilities advertised authScheme:'ApiKey'. Old code: 200.
 *   - "allowlist rejects a non-permitted tool" (both via mcp:tool_call and via a
 *     shape pointer). METABOB_TOOLS was enforced only in the MCP request
 *     handlers, so the HTTP resolver — which dispatches through
 *     resolveImpulseContent — accepted any tool in the registry. Old code: resolved and returned the tool's content.
 *
 * The keyed-mode and human_input cases pass before AND after; they are here so a
 * later "simplification" cannot over-tighten the gate into breaking real callers
 * or into gating dispatched-to-agent coordination.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  VesselServer,
  resolveImpulseContent,
  parseToolAllowlist,
  isToolPermitted,
  __resetToolAllowlistForTests,
} from '../../src/vessel-server';
import { DEFAULT_TOOL_SET } from '../../src/tools/index';
import { CircuitState } from '../../src/circuit-breaker';
import { setResolverIdentity } from '../../src/resolver-identity';
import { cleanupTempStores, makeTempStore } from '../helpers/temp-store';

const ENV_KEY = 'METABOB_TOOLS';
const originalAllowlist = process.env[ENV_KEY];

afterEach(() => {
  if (originalAllowlist === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalAllowlist;
  __resetToolAllowlistForTests();
  cleanupTempStores();
});

function setAllowlist(value: string | undefined): void {
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  __resetToolAllowlistForTests();
}

/** A Hono app for the resolver, no socket bound. */
function buildResolverApp(opts: { apiKey?: string; identityKey?: string }) {
  return new VesselServer({
    port: 0,
    apiClient: {} as any,
    circuitBreaker: { getState: () => CircuitState.CLOSED, isAllowed: () => true } as any,
    sessionId: 'sess-test',
    apiKey: opts.apiKey,
    authService: { getIdentityApiKey: () => opts.identityKey } as any,
    localStore: null,
  }).buildApp();
}

function resolveRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://vessel.test/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ pointer: { type: 'code:analysis_context' } }),
  });
}

describe('resolver auth (finding C)', () => {
  test('anonymous mode with NO credential configured refuses every resolve', async () => {
    const app = buildResolverApp({});
    const res = await app.fetch(resolveRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('anonymous mode refuses a caller that presents any key at all', async () => {
    const app = buildResolverApp({});
    const res = await app.fetch(resolveRequest({ authorization: 'ApiKey whatever' }));
    expect(res.status).toBe(401);
  });

  test('configured key + matching ApiKey header is accepted', async () => {
    const app = buildResolverApp({ apiKey: 'k1' });
    const res = await app.fetch(resolveRequest({ authorization: 'ApiKey k1' }));
    expect(res.status).toBe(200);
  });

  test('configured key + wrong key is refused', async () => {
    const app = buildResolverApp({ apiKey: 'k1' });
    const res = await app.fetch(resolveRequest({ authorization: 'ApiKey wrong' }));
    expect(res.status).toBe(401);
  });

  test('identity-vessel key alone still authenticates (Bearer)', async () => {
    const app = buildResolverApp({ identityKey: 'k2' });
    const res = await app.fetch(resolveRequest({ authorization: 'Bearer k2' }));
    expect(res.status).toBe(200);
  });

  test('/v2/capabilities keeps advertising the ApiKey scheme it now honours', async () => {
    const app = buildResolverApp({});
    const res = await app.fetch(new Request('http://vessel.test/v2/capabilities'));
    expect(res.status).toBe(200);
    expect((await res.json()).resolver.authScheme).toBe('ApiKey');
  });
});

describe('METABOB_TOOLS parsing (finding D)', () => {
  test('absent / empty / separator-only values mean the default set; `all` means every tool', () => {
    for (const raw of [undefined, '', '  ', ' , ']) expect([...parseToolAllowlist(raw)!].sort()).toEqual([...DEFAULT_TOOL_SET].sort());
    expect(parseToolAllowlist('all')).toBeNull();
    expect(parseToolAllowlist(' ALL ')).toBeNull();
  });

  test('a comma list is trimmed into a set', () => {
    const set = parseToolAllowlist('get_problems, record_finding ');
    expect(set).not.toBeNull();
    expect([...set!].sort()).toEqual(['get_problems', 'record_finding']);
  });

  test('isToolPermitted reads the env allowlist and honours the reset hook', () => {
    setAllowlist('record_finding');
    expect(isToolPermitted('record_finding')).toBe(true);
    expect(isToolPermitted('get_problems')).toBe(false);
    setAllowlist(undefined);
    expect(isToolPermitted('get_problems')).toBe(true);
    expect(isToolPermitted('run_goal_async')).toBe(false);
    setAllowlist('all');
    expect(isToolPermitted('run_goal_async')).toBe(true);
  });
});

describe('allowlist enforcement on the resolve plane (finding D)', () => {
  // resolveImpulseContent is the HTTP resolver's dispatch, so driving it
  // directly covers that plane.

  test('a non-permitted tool named via mcp:tool_call is refused', async () => {
    setAllowlist('record_finding');
    await expect(
      resolveImpulseContent({ type: 'mcp:tool_call', tool: 'get_problems', input: {} }, {} as any, 'sess', null),
    ).rejects.toThrow(/not enabled for this vessel \(METABOB_TOOLS allowlist\)/);
  });

  test('a non-permitted tool reached via a SHAPE pointer is refused too', async () => {
    setAllowlist('record_finding');
    await expect(
      resolveImpulseContent(
        { type: 'code:impact_analysis', changed_files: ['src/index.ts'] },
        {} as any,
        'sess',
        null,
      ),
    ).rejects.toThrow(/not enabled for this vessel \(METABOB_TOOLS allowlist\)/);
  });

  test('a permitted tool passes the gate and reaches input validation', async () => {
    setAllowlist('record_finding');
    let message = '';
    try {
      await resolveImpulseContent({ type: 'mcp:tool_call', tool: 'record_finding', input: {} }, {} as any, 'sess', null);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toMatch(/METABOB_TOOLS allowlist/);
  });

  test('with no allowlist configured every tool stays reachable', async () => {
    setAllowlist(undefined);
    let message = '';
    try {
      await resolveImpulseContent({ type: 'mcp:tool_call', tool: 'get_problems', input: {} }, {} as any, 'sess', null);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toMatch(/METABOB_TOOLS allowlist/);
  });

  test('human_input stays exempt — it is dispatched-to-agent work, not a registry tool', async () => {
    setAllowlist('record_finding');
    const { store } = makeTempStore('mcp-allowlist-');
    setResolverIdentity({ vesselId: 'metabob-mcp-test', operatorId: 'op' });

    const { toolName, content } = await resolveImpulseContent(
      { type: 'human_input', solicitation_id: 'sid-7', question_markdown: '## Ship it?' },
      {} as any,
      'sess',
      store,
    );

    expect(toolName).toBe('human_input');
    expect(JSON.parse(content as string).accepted).toBe(true);
    expect(store.listPendingAgentTasks('metabob-mcp-test').length).toBe(1);
  });
});
