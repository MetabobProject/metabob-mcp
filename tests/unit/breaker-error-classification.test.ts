/**
 * Circuit-breaker failure classification (audit 0.2.20, finding E).
 *
 * The bug: src/index.ts excluded rate-limit errors with
 * `errorObj.code !== 'RATE_LIMIT_EXCEEDED'`, but McpError.code is the NUMERIC
 * ErrorCode enum — the string sentinel lives in `error.data.code`. The compare
 * was therefore always true, so every Zod validation failure, unknown-tool
 * refusal, rate-limit rejection and even the breaker's own open-circuit
 * rejection recorded a failure. Five bad arguments opened the breaker and
 * locked out purely local tools.
 *
 * Two layers, both required. The pure layer pins the predicate; the wiring
 * layer drives the real MCP server over stdio, because the predicate can be
 * correct while the call site still uses the old compare — which is exactly how
 * this shipped.
 */

import { test, expect } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { CircuitBreaker, CircuitState, shouldTripBreaker } from '../../src/circuit-breaker';

// ===== Layer 1: the predicate =====

// Shapes thrown on the client-error paths of src/index.ts's CallTool handler.
const NON_UPSTREAM: Array<[string, unknown]> = [
  ['Zod / InvalidParams (McpError, no data)', { code: -32602, message: 'Invalid parameters for tool search_codebase: query: Required' }],
  ['unknown tool / allowlist refusal (MethodNotFound)', { code: -32601, message: 'Tool "x" is not enabled for this vessel' }],
  ['rate limit rejection', { code: -32603, data: { code: 'RATE_LIMIT_EXCEEDED', resetTimeMs: 1, limit: 60 } }],
  ['the breaker\'s own open-circuit rejection', { code: -32603, data: { code: 'CIRCUIT_OPEN', circuitState: 'OPEN' } }],
  ['api-client 401', { code: 'UNAUTHORIZED' }],
  ['api-client 404', { code: 'NOT_FOUND' }],
  ['api-client 400', { code: 'INVALID_PARAMS' }],
  ['api-client 429 (upstream alive, applying back-pressure)', { code: 'RATE_LIMITED' }],
  ['budget', { code: 'BUDGET_EXCEEDED' }],
  ['bare Error', new Error('boom')],
  ['null', null],
  ['string', 'nope'],
];

for (const [label, err] of NON_UPSTREAM) {
  test(`shouldTripBreaker is false for ${label}`, () => {
    expect(shouldTripBreaker(err)).toBe(false);
  });
}

const UPSTREAM: Array<[string, unknown]> = [
  ['5xx / ECONNREFUSED', { code: 'SERVICE_UNAVAILABLE' }],
  ['timeout', { code: 'API_TIMEOUT' }],
  ['generic api-client failure', { code: 'INTERNAL_ERROR' }],
  ['TLS interception', { code: 'TLS_INTERCEPTED' }],
  ['MCP-wrapped upstream failure', { code: -32603, data: { code: 'SERVICE_UNAVAILABLE' } }],
];

for (const [label, err] of UPSTREAM) {
  test(`shouldTripBreaker is true for ${label}`, () => {
    expect(shouldTripBreaker(err)).toBe(true);
  });
}

test('five validation failures leave the circuit closed; five API failures open it', () => {
  const validation = new CircuitBreaker({ failureThreshold: 5 });
  for (let i = 0; i < 5; i++) {
    const e = { code: -32602, message: 'Invalid parameters' };
    if (shouldTripBreaker(e)) validation.recordFailure();
  }
  expect(validation.getFailureCount()).toBe(0);
  expect(validation.getState()).toBe(CircuitState.CLOSED);
  expect(validation.isAllowed()).toBe(true);

  const upstream = new CircuitBreaker({ failureThreshold: 5 });
  for (let i = 0; i < 5; i++) {
    const e = { code: 'SERVICE_UNAVAILABLE' };
    if (shouldTripBreaker(e)) upstream.recordFailure();
  }
  expect(upstream.getState()).toBe(CircuitState.OPEN);
});

// ===== Layer 2: the wiring in src/index.ts =====

interface MCPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

/**
 * Drive ONE server process with N sequential requests. The existing integration
 * helper spawns a fresh process per request, so it can never accumulate breaker
 * state — which is why this defect was invisible to it.
 */
async function sendSequential(requests: Array<Record<string, unknown>>): Promise<MCPResponse[]> {
  const runtime = process.execPath;
  const args = process.versions.bun ? ['run', 'src/index.ts'] : ['src/index.ts'];
  const child: ChildProcess = spawn(runtime, args, {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env,
      SESSION_ID: 'breaker-classification-test',
      // Not attached to any substrate: these exercise the local server only.
      METABOB_ENDPOINT: '',
      DISCOVERY_ENDPOINT: '',
      // Never bind the port a live sidecar may hold.
      HEALTH_PORT: String(19000 + Math.floor(Math.random() * 900)),
      METABOB_TOOLS: '',
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

test(
  'invalid arguments never open the breaker: a local tool still runs after 6 bad calls',
  async () => {
    const requests: Array<Record<string, unknown>> = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'breaker-test', version: '0' } } },
    ];
    // 6 > failureThreshold (5): under the old compare the breaker is already
    // OPEN by the 6th and rejects it.
    for (let i = 0; i < 6; i++) {
      requests.push({
        jsonrpc: '2.0', id: 10 + i, method: 'tools/call',
        params: { name: 'search_codebase', arguments: { limit: 5 } }, // missing required `query`
      });
    }
    // A purely local tool. It may legitimately fail (no indexed workspace in the
    // child), so assert on the breaker's unique marker rather than on success.
    requests.push({
      jsonrpc: '2.0', id: 99, method: 'tools/call',
      params: { name: 'analyze_impact', arguments: { changed_files: ['src/index.ts'] } },
    });

    const responses = await sendSequential(requests);
    const toolCalls = responses.filter(r => r.id >= 10);

    for (const r of toolCalls) {
      expect(r.error?.message ?? '').not.toContain('Circuit breaker is open');
    }
    // Anti-cheat: the bad calls must still have been rejected as invalid params,
    // so this cannot pass by the validation path quietly disappearing.
    for (const r of toolCalls.filter(r => r.id < 99)) {
      expect(r.error?.message ?? '').toContain('Invalid parameters');
    }
  },
  60000,
);
