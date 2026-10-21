/**
 * W8 — the opt-in call log (METABOB_CALL_LOG), through a real server process: one line per tool call with the
 * tool, argument names and sizes and the outcome, never an argument's value, so the cell lab can score the order of
 * metabob calls for any harness. SPEC §call-log
 */

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FakeSubstrate } from './harness/fake-substrate';
import { McpServer, cleanupTempDirs, makeWorkspace, tempDir } from './harness/mcp-client';

setDefaultTimeout(30_000);

let fake: FakeSubstrate;
let server: McpServer;
let logFile: string;
// A credential-shaped value the outgoing guard refuses, which must not reach the log either.
const SECRET = 'AKIA' + 'Q3EGRTZXWV7NP4LB';

beforeAll(async () => {
  fake = await FakeSubstrate.start();
  logFile = join(tempDir('w8-log'), 'calls.jsonl');
  server = await McpServer.start({ workspace: makeWorkspace('w8'), env: { ...fake.env(), METABOB_CALL_LOG: logFile, SESSION_ID: 'w8-session' } });
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await fake?.stop();
  cleanupTempDirs();
}, 30_000);

test('each call is one line: tool, argument names and sizes, outcome; never a value', async () => {
  await server.text('get_metrics', {});
  await server.call('record_finding', { files: ['src/index.ts'], summary: `key ${SECRET} committed`, severity: 'HIGH', category: 'security' });
  await server.call('get_problems', { limit: 'many' });
  expect(existsSync(logFile)).toBe(true);
  const raw = readFileSync(logFile, 'utf8');
  expect(raw).not.toContain(SECRET);
  expect(raw).not.toContain('committed');
  const lines = raw.trim().split('\n').map(l => JSON.parse(l));
  expect(lines.map(l => [l.tool, l.outcome])).toEqual([['get_metrics', 'ok'], ['record_finding', 'refused'], ['get_problems', 'error']]);
  expect(lines[1]).toMatchObject({ session: 'w8-session', args: { summary: expect.stringMatching(/^string\(\d+\)$/), severity: 'string(4)' } });
  expect(typeof lines[0].ms).toBe('number');
  if (process.platform !== 'win32') expect(statSync(logFile).mode & 0o777).toBe(0o600);
});

test('a loopback resolver call is logged too, marked as the loopback\'s; arrays keep their length', async () => {
  const port = await server.vesselPort();
  const res = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'ApiKey mb_test_workflow_key' },
    body: JSON.stringify({ pointer: { type: 'mcp:tool_call', tool: 'get_problems', input: { category: ['security', 'task'] } } }),
  });
  expect(res.status).toBe(200);
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const loop = lines.filter(l => l.via === 'loopback');
  expect(loop).toHaveLength(1);
  expect(loop[0]).toMatchObject({ tool: 'get_problems', outcome: 'ok', args: { category: 'array(2)' } });
  expect(lines.filter(l => l.via === 'stdio').length).toBe(3);
});

test('mcp:tool_call takes its input as `arguments` too, as MCP clients name it', async () => {
  const port = await server.vesselPort();
  const post = (pointer: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'ApiKey mb_test_workflow_key' }, body: JSON.stringify({ pointer }),
  });
  expect((await post({ type: 'mcp:tool_call', tool: 'get_problems', arguments: { category: ['security'] } })).status).toBe(200);
  const last = readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
  expect(last).toMatchObject({ via: 'loopback', tool: 'get_problems', args: { category: 'array(1)' } });
  const both = await post({ type: 'mcp:tool_call', tool: 'get_problems', input: {}, arguments: {} });
  expect(JSON.stringify(await both.json())).toContain('not both');
});

test('a tool that answers with a refusal logs its result kind, not just "ok"', async () => {
  await server.call('claim_finding', { problem_id: 'agf_not_here' });
  await server.call('mark_complete', { problem_id: 'prob_not_a_finding' });
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  expect(lines.find(l => l.tool === 'claim_finding')).toMatchObject({ outcome: 'ok', result: 'refused' });
  expect(lines.find(l => l.tool === 'mark_complete')).toMatchObject({ outcome: 'ok', result: 'not_applied' });
});
