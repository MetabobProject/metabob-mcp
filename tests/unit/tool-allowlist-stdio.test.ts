/**
 * METABOB_TOOLS on the STDIO plane.
 *
 * The allowlist governs two doors: stdio MCP and the loopback HTTP resolver.
 * vessel-server-auth-allowlist.test.ts covers the resolve path;
 * this covers stdio, which had no test at all — the asymmetry that let the two
 * planes carry independent copies of the parse rule in the first place. Both now
 * call isToolPermitted(), so this file and that one assert the same grammar
 * through different doors, and a change to the rule cannot stay green in one
 * while breaking the other.
 *
 * Drives a real src/index.ts over stdio rather than calling the handler, because
 * the thing under test is the wiring: what tools/list emits and what tools/call
 * refuses, in a process whose env was frozen at start.
 */
import { test, expect } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';

interface MCPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

const INIT = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'allowlist-stdio-test', version: '0' },
  },
};

async function drive(
  allowlist: string,
  requests: Array<Record<string, unknown>>,
): Promise<MCPResponse[]> {
  const runtime = process.execPath;
  const args = process.versions.bun ? ['run', 'src/index.ts'] : ['src/index.ts'];
  const child: ChildProcess = spawn(runtime, args, {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env,
      SESSION_ID: 'allowlist-stdio-test',
      // Not attached to any substrate: these exercise the local server only.
      METABOB_ENDPOINT: '',
      DISCOVERY_ENDPOINT: '',
      // Never bind the port a live sidecar may hold.
      HEALTH_PORT: String(19900 + Math.floor(Math.random() * 90)),
      METABOB_TOOLS: allowlist,
      LOG_LEVEL: 'error',
    },
    cwd: import.meta.dir + '/../..',
  });

  const responses = new Map<number, MCPResponse>();
  let buffer = '';
  child.stdout!.on('data', (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.jsonrpc === '2.0' && typeof parsed.id === 'number') responses.set(parsed.id, parsed);
      } catch {
        // partial / non-JSON line — ignore
      }
    }
  });

  try {
    const out: MCPResponse[] = [];
    for (const req of requests) {
      child.stdin!.write(JSON.stringify(req) + '\n');
      const id = req['id'] as number;
      const deadline = Date.now() + 20000;
      while (!responses.has(id)) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for response id=${id}`);
        await new Promise(r => setTimeout(r, 25));
      }
      out.push(responses.get(id)!);
    }
    return out;
  } finally {
    child.kill();
  }
}

const listReq = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

test('tools/list emits only allowlisted tools', async () => {
  const [, list] = await drive('analyze_impact,get_problems', [INIT, listReq]);

  const names: string[] = list!.result.tools.map((t: { name: string }) => t.name).sort();
  expect(names).toEqual(['analyze_impact', 'get_problems']);
}, 30000);

test('an unlisted tool is still refused when called by name', async () => {
  // Hiding a tool from the listing is not a control: a client can learn the name
  // from a cached schema and call it anyway. The refusal is the control.
  const [, , call] = await drive('analyze_impact', [
    INIT,
    listReq,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'record_finding', arguments: {} } },
  ]);

  expect(call!.error).toBeDefined();
  expect(call!.error!.message).toMatch(/not enabled for this vessel \(METABOB_TOOLS allowlist\)/);
});

test('an allowlisted tool is not refused by the allowlist', async () => {
  // Guards the inverse: a filter that refused everything would pass the two
  // tests above while breaking the server.
  const [, , call] = await drive('analyze_impact', [
    INIT,
    listReq,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'analyze_impact', arguments: {} } },
  ]);

  // It may fail for its own reasons (no workspace indexed); it must not fail
  // because the allowlist refused it.
  const message = call!.error?.message ?? '';
  expect(message).not.toMatch(/METABOB_TOOLS allowlist/);
});

test('an unset allowlist lists every registered tool', async () => {
  const [, list] = await drive('', [INIT, listReq]);

  const names: string[] = list!.result.tools.map((t: { name: string }) => t.name);
  // The exact count is not the contract — "no allowlist means no filtering" is.
  expect(names.length).toBeGreaterThan(20);
  expect(names).toContain('record_finding');
  expect(names).toContain('analyze_impact');
}, 30000);
