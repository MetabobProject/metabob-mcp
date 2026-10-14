/**
 * Integration tests for MCP server
 * Tests end-to-end MCP protocol communication against the tool surface
 */

import { test, expect, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface MCPRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: any;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: any;
}

/**
 * Send a single MCP request to a fresh server process via stdio.
 */
async function sendMCPRequest(request: MCPRequest): Promise<MCPResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Request timeout after 10 seconds'));
    }, 10000);

    const runtime = process.execPath;
    const args = process.versions.bun ? ['run', 'src/index.ts'] : ['src/index.ts'];

    const child = spawn(runtime, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        SESSION_ID: 'integration-test-session',
        // Not attached to any substrate: these exercise the local server only.
        METABOB_ENDPOINT: '',
        DISCOVERY_ENDPOINT: '',
        LOG_LEVEL: 'error',
      },
      cwd: import.meta.dir + '/../..',
    });

    let output = '';
    let responded = false;

    child.stdout.on('data', (data) => {
      output += data.toString();
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.trim().startsWith('{') && !responded) {
          try {
            const response = JSON.parse(line);
            if (response.jsonrpc === '2.0' && response.id === request.id) {
              responded = true;
              clearTimeout(timeout);
              child.kill();
              resolve(response);
              return;
            }
          } catch (_) {
            // not JSON yet — keep buffering
          }
        }
      }
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code) => {
      if (!responded) {
        clearTimeout(timeout);
        reject(new Error(`Process exited with code ${code} before responding`));
      }
    });

    child.stdin.write(JSON.stringify(request) + '\n');
    child.stdin.end();
  });
}

// ===== tools/list =====

test('MCP server responds to tools/list', async () => {
  const response = await sendMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  expect(response.jsonrpc).toBe('2.0');
  expect(response.id).toBe(1);
  expect(response.result).toBeDefined();
  expect(response.result.tools).toBeArray();
  expect(response.result.tools.length).toBe(28);
});

test('tools/list returns all core tool names', async () => {
  const response = await sendMCPRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const toolNames = (response.result?.tools || []).map((t: any) => t.name);

  const expected = [
    'init_workspace',
    'get_problems',
    'search_codebase',
    'predict_cochanges',
    'analyze_impact',
    'annotate_component',
    'mark_complete',
    'get_metrics',
    'assign_git_changes',
    'get_analysis_context',
  ];

  for (const name of expected) {
    expect(toolNames).toContain(name);
  }
});

test('each tool has required MCP properties', async () => {
  const response = await sendMCPRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  const tools = response.result?.tools || [];

  for (const tool of tools) {
    expect(tool).toHaveProperty('name');
    expect(tool).toHaveProperty('description');
    expect(tool).toHaveProperty('inputSchema');
    expect(typeof tool.name).toBe('string');
    expect(typeof tool.description).toBe('string');
    expect(tool.inputSchema).toBeObject();
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema).toHaveProperty('properties');
  }
});

// ===== Unknown tool =====

test('tools/call rejects unknown tool', async () => {
  const response = await sendMCPRequest({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'unknown_tool_xyz', arguments: {} },
  });
  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Unknown tool');
});

test('server returns proper JSON-RPC error format for unknown tool', async () => {
  const response = await sendMCPRequest({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'no_such_tool', arguments: {} },
  });
  expect(response.jsonrpc).toBe('2.0');
  expect(response.id).toBe(5);
  expect(response.error).toBeDefined();
  expect(response.error).toHaveProperty('code');
  expect(response.error).toHaveProperty('message');
  expect(typeof response.error.code).toBe('number');
  expect(typeof response.error.message).toBe('string');
});

// ===== Input validation =====

test('tools/call validates missing required params (search_codebase query)', async () => {
  const response = await sendMCPRequest({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'search_codebase', arguments: { limit: 10 } }, // missing query
  });
  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Invalid parameters');
});

test('tools/call validates empty required string (search_codebase query)', async () => {
  const response = await sendMCPRequest({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'search_codebase', arguments: { query: '' } },
  });
  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Invalid parameters');
});

test('tools/call validates enum values (get_problems severity)', async () => {
  const response = await sendMCPRequest({
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'get_problems', arguments: { severity: ['INVALID'] } },
  });
  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Invalid parameters');
});

test('tools/call validates empty array (predict_cochanges changed_files)', async () => {
  const response = await sendMCPRequest({
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'predict_cochanges', arguments: { changed_files: [] } },
  });
  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Invalid parameters');
});

test('tools/call validates enum (analyze_impact direction)', async () => {
  const response = await sendMCPRequest({
    jsonrpc: '2.0', id: 10, method: 'tools/call',
    params: { name: 'analyze_impact', arguments: { changed_files: ['f.ts'], direction: 'sideways' } },
  });
  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Invalid parameters');
});

test('tools/call validates missing problem_id (annotate_component)', async () => {
  const response = await sendMCPRequest({
    jsonrpc: '2.0', id: 11, method: 'tools/call',
    params: { name: 'annotate_component', arguments: { mode: 'explain' } },
  });
  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Invalid parameters');
});

test('tools/call validates missing problem_id (mark_complete)', async () => {
  const response = await sendMCPRequest({
    jsonrpc: '2.0', id: 12, method: 'tools/call',
    params: { name: 'mark_complete', arguments: {} },
  });
  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Invalid parameters');
});

// ===== Schema spot-checks =====

test('get_problems schema has correct fields', async () => {
  const response = await sendMCPRequest({ jsonrpc: '2.0', id: 13, method: 'tools/list', params: {} });
  const tool = response.result?.tools.find((t: any) => t.name === 'get_problems');
  expect(tool).toBeDefined();
  expect(tool.inputSchema.properties).toHaveProperty('limit');
  expect(tool.inputSchema.properties).toHaveProperty('severity');
  expect(tool.inputSchema.properties).toHaveProperty('file_path');
});

test('search_codebase schema has correct fields', async () => {
  const response = await sendMCPRequest({ jsonrpc: '2.0', id: 14, method: 'tools/list', params: {} });
  const tool = response.result?.tools.find((t: any) => t.name === 'search_codebase');
  expect(tool).toBeDefined();
  expect(tool.inputSchema.properties).toHaveProperty('query');
  expect(tool.inputSchema.properties).toHaveProperty('limit');
  expect(tool.inputSchema.properties).toHaveProperty('target');
});

test('annotate_component schema has correct fields', async () => {
  const response = await sendMCPRequest({ jsonrpc: '2.0', id: 15, method: 'tools/list', params: {} });
  const tool = response.result?.tools.find((t: any) => t.name === 'annotate_component');
  expect(tool).toBeDefined();
  expect(tool.inputSchema.properties).toHaveProperty('problem_id');
  expect(tool.inputSchema.properties).toHaveProperty('mode');
});

test('predict_cochanges schema has correct fields', async () => {
  const response = await sendMCPRequest({ jsonrpc: '2.0', id: 16, method: 'tools/list', params: {} });
  const tool = response.result?.tools.find((t: any) => t.name === 'predict_cochanges');
  expect(tool).toBeDefined();
  expect(tool.inputSchema.properties).toHaveProperty('changed_files');
  expect(tool.inputSchema.properties).toHaveProperty('confidence_threshold');
});

// ===== Performance =====

test('tools/list responds within 5 seconds', async () => {
  const start = Date.now();
  await sendMCPRequest({ jsonrpc: '2.0', id: 17, method: 'tools/list', params: {} });
  expect(Date.now() - start).toBeLessThan(5000);
});

// ===== The success branch =====
//
// Everything above this line asserts an ERROR. Unknown-tool and Invalid-parameters
// both throw before the handler runs, so the whole success path — the
// `{ content: [{ type: 'text', text }] }` envelope, recordSuccess, trackUsage —
// was reachable by zero assertions: change the envelope to
// `{ content: result }` and the entire suite stayed green while every MCP client
// got a protocol-invalid result for all 28 tools.
//
// sendMCPRequest above also spawns a fresh child per request and kills it on the
// first parse, so nothing that lives ACROSS calls in one process — the in-memory
// CPG index above all — is observable through it. The session harness below keeps
// one process and drives a sequence through it, which is the only way to prove
// that call N+1 sees what call N built.

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/** A two-file TypeScript workspace where beta.ts demonstrably depends on alpha.ts. */
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-server-ws-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'alpha.ts'),
    'export function alphaCompute(x: number): number {\n  return x * 2;\n}\n',
    'utf-8',
  );
  writeFileSync(
    join(dir, 'src', 'beta.ts'),
    "import { alphaCompute } from './alpha';\n\nexport function betaRun(): number {\n  return alphaCompute(21);\n}\n",
    'utf-8',
  );
  return dir;
}

/**
 * Drive a sequence of requests through ONE server process, in order.
 *
 * Same shape as tests/unit/tool-allowlist-stdio.test.ts: persistent child,
 * line-buffered stdout, kill in a finally.
 */
async function driveSession(
  env: Record<string, string>,
  requests: MCPRequest[],
): Promise<MCPResponse[]> {
  // A temp HOME keeps LocalStore off the developer's real ~/.metabob/sidecar.db,
  // and an absent METABOB_CONFIG_PATH keeps the spawned server off whatever
  // backend ./.metabob/config.json in this checkout happens to point at.
  const home = mkdtempSync(join(tmpdir(), 'mcp-server-home-'));
  tempDirs.push(home);

  const runtime = process.execPath;
  const args = process.versions.bun ? ['run', 'src/index.ts'] : ['src/index.ts'];
  const child: ChildProcess = spawn(runtime, args, {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home, // os.homedir() reads this one on Windows
      METABOB_CONFIG_PATH: join(home, 'no-such-config.json'),
      METABOB_API_KEY: '',
      SESSION_ID: 'integration-success-session',
      // Not attached to any substrate: these exercise the local server only.
      METABOB_ENDPOINT: '',
      DISCOVERY_ENDPOINT: '',
      HEALTH_PORT: String(19800 + Math.floor(Math.random() * 90)),
      LOG_LEVEL: 'error',
      ...env,
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
      const deadline = Date.now() + 30000;
      while (!responses.has(req.id)) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for response id=${req.id}`);
        await new Promise(r => setTimeout(r, 25));
      }
      out.push(responses.get(req.id)!);
    }
    return out;
  } finally {
    child.kill();
  }
}

const INITIALIZE: MCPRequest = {
  jsonrpc: '2.0',
  id: 100,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-server-integration-test', version: '0' },
  },
};

/** The MCP content envelope, asserted structurally rather than by shape of the text. */
function expectTextResult(response: MCPResponse): string {
  expect(response.error).toBeUndefined();
  expect(response.result).toBeDefined();
  expect(response.result.content).toBeArray();
  expect(response.result.content.length).toBeGreaterThan(0);
  const block = response.result.content[0];
  expect(block.type).toBe('text');
  expect(typeof block.text).toBe('string');
  expect(block.text.length).toBeGreaterThan(0);
  return block.text as string;
}

test('a successful tools/call returns the MCP text envelope, not just an error', async () => {
  const workspace = makeWorkspace();
  const [, init] = await driveSession({ WORKSPACE_PATH: workspace }, [
    INITIALIZE,
    {
      jsonrpc: '2.0', id: 101, method: 'tools/call',
      params: { name: 'init_workspace', arguments: { workspace_path: workspace } },
    },
  ]);

  const text = expectTextResult(init!);
  // Not merely non-empty: the text has to describe THIS workspace, so a handler
  // stubbed to return a constant cannot satisfy it.
  expect(text).toContain(workspace);
  expect(text).toContain('Local index: 2/2 files parsed');
  // Indexing is local and the result says so; there is no sync half to report.
  expect(text).toContain('No file content was sent off the machine');
  expect(text).not.toContain('API sync');
}, 60000);

test('a later tools/call in the same process sees the index an earlier one built', async () => {
  // The per-request harness at the top of this file cannot express this: it kills
  // the server after every response, so the CPG built by init_workspace never
  // outlives the call that built it.
  const workspace = makeWorkspace();
  const [, , search, impact] = await driveSession({ WORKSPACE_PATH: workspace }, [
    INITIALIZE,
    {
      jsonrpc: '2.0', id: 102, method: 'tools/call',
      params: { name: 'init_workspace', arguments: { workspace_path: workspace } },
    },
    {
      jsonrpc: '2.0', id: 103, method: 'tools/call',
      params: { name: 'search_codebase', arguments: { query: 'alphaCompute' } },
    },
    {
      jsonrpc: '2.0', id: 104, method: 'tools/call',
      params: {
        name: 'analyze_impact',
        arguments: { changed_files: ['src/alpha.ts'], direction: 'backward' },
      },
    },
  ]);

  // Content parsed out of a file written by this test moments ago — reachable
  // only through state the previous call left in the process.
  const searchText = expectTextResult(search!);
  expect(searchText).toContain('alphaCompute');
  expect(searchText).toContain('alpha.ts');

  // beta.ts imports alpha.ts, so a backward walk from alpha.ts must name it.
  // This is the graph answering, not the seed cache: the temp HOME has no seeds.
  const impactText = expectTextResult(impact!);
  expect(impactText).toContain('beta.ts');
  expect(impactText).not.toContain('Workspace not indexed');
}, 60000);
