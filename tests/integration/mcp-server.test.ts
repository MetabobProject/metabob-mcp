/**
 * Integration tests for MCP server
 * Tests end-to-end MCP protocol communication against the current 10-tool surface
 */

import { test, expect } from 'bun:test';
import { spawn } from 'child_process';

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
        ANALYSIS_API_URL: 'http://localhost:8081',
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
  expect(response.result.tools.length).toBe(10);
});

test('tools/list returns all 10 current tool names', async () => {
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
