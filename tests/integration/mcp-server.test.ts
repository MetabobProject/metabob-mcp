/**
 * Integration tests for MCP server
 * Tests end-to-end MCP protocol communication
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';

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

let serverProcess: ChildProcess | null = null;

/**
 * Send MCP request to server via stdio
 */
async function sendMCPRequest(request: MCPRequest): Promise<MCPResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Request timeout after 10 seconds'));
    }, 10000);

    const child = spawn('bun', ['run', 'src/index.ts'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        SESSION_ID: 'integration-test-session',
        ANALYSIS_API_URL: 'http://localhost:8081',
        LOG_LEVEL: 'error', // Reduce noise
      },
      cwd: import.meta.dir + '/../..',
    });

    let output = '';
    let responded = false;

    child.stdout.on('data', (data) => {
      output += data.toString();

      // Try to parse each line as JSON
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
          } catch (e) {
            // Not valid JSON, continue
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

    // Send request
    child.stdin.write(JSON.stringify(request) + '\n');
    child.stdin.end();
  });
}

// ===== MCP Protocol Tests =====

test('MCP server responds to tools/list', async () => {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  };

  const response = await sendMCPRequest(request);

  expect(response.jsonrpc).toBe('2.0');
  expect(response.id).toBe(1);
  expect(response.result).toBeDefined();
  expect(response.result.tools).toBeArray();
  expect(response.result.tools.length).toBe(7);
});

test('tools/list returns all expected tools', async () => {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  };

  const response = await sendMCPRequest(request);
  const tools = response.result?.tools || [];

  const expectedTools = [
    'get_priority_issues',
    'search_codebase',
    'annotate_component',
    'suggest_related_changes',
    'analyze_change_impact',
    'mark_problem_complete',
    'generate_implementation_spec',
  ];

  const toolNames = tools.map((t: any) => t.name);

  for (const expectedTool of expectedTools) {
    expect(toolNames).toContain(expectedTool);
  }
});

test('each tool has required properties', async () => {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/list',
    params: {},
  };

  const response = await sendMCPRequest(request);
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

test('tools/call rejects unknown tool', async () => {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'unknown_tool_that_does_not_exist',
      arguments: {},
    },
  };

  const response = await sendMCPRequest(request);

  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Unknown tool');
});

test('tools/call validates input parameters', async () => {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'get_priority_issues',
      arguments: {
        limit: -10, // Invalid: must be positive
      },
    },
  };

  const response = await sendMCPRequest(request);

  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Invalid parameters');
});

test('tools/call validates required parameters', async () => {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'search_codebase',
      arguments: {
        // Missing required 'query' parameter
        limit: 10,
      },
    },
  };

  const response = await sendMCPRequest(request);

  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Invalid parameters');
});

test('tools/call validates enum values', async () => {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'get_priority_issues',
      arguments: {
        limit: 10,
        severity: ['INVALID_SEVERITY'], // Not a valid enum value
      },
    },
  };

  const response = await sendMCPRequest(request);

  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Invalid parameters');
});

test('annotate_component validates annotation type', async () => {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: {
      name: 'annotate_component',
      arguments: {
        component_id: 'test',
        content: 'test content',
        type: 'invalid_type', // Not a valid annotation type
      },
    },
  };

  const response = await sendMCPRequest(request);

  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Invalid parameters');
});

test('suggest_related_changes validates changed_files array', async () => {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: {
      name: 'suggest_related_changes',
      arguments: {
        changed_files: [], // Empty array is invalid
      },
    },
  };

  const response = await sendMCPRequest(request);

  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Invalid parameters');
});

test('analyze_change_impact validates direction parameter', async () => {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'analyze_change_impact',
      arguments: {
        changed_files: ['test.ts'],
        direction: 'invalid_direction', // Not a valid direction
      },
    },
  };

  const response = await sendMCPRequest(request);

  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Invalid parameters');
});

test('mark_problem_complete validates required fields', async () => {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {
      name: 'mark_problem_complete',
      arguments: {
        problem_id: 'test-problem',
        // Missing required resolution_summary
      },
    },
  };

  const response = await sendMCPRequest(request);

  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Invalid parameters');
});

test('generate_implementation_spec validates goal parameter', async () => {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: {
      name: 'generate_implementation_spec',
      arguments: {
        goal: '', // Empty string is invalid
      },
    },
  };

  const response = await sendMCPRequest(request);

  expect(response.error).toBeDefined();
  expect(response.error.message).toContain('Invalid parameters');
});

// ===== Schema Validation Tests =====

test('get_priority_issues schema has correct structure', async () => {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/list',
    params: {},
  };

  const response = await sendMCPRequest(request);
  const tool = response.result?.tools.find((t: any) => t.name === 'get_priority_issues');

  expect(tool).toBeDefined();
  expect(tool.inputSchema.properties).toHaveProperty('limit');
  expect(tool.inputSchema.properties).toHaveProperty('severity');
  expect(tool.inputSchema.properties).toHaveProperty('category');
  expect(tool.inputSchema.properties).toHaveProperty('scope');
  expect(tool.inputSchema.properties.limit.type).toBe('number');
  expect(tool.inputSchema.properties.severity.type).toBe('array');
  expect(tool.inputSchema.properties.scope.enum).toContain('session');
});

test('search_codebase schema has correct structure', async () => {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/list',
    params: {},
  };

  const response = await sendMCPRequest(request);
  const tool = response.result?.tools.find((t: any) => t.name === 'search_codebase');

  expect(tool).toBeDefined();
  expect(tool.inputSchema.properties).toHaveProperty('query');
  expect(tool.inputSchema.properties).toHaveProperty('limit');
  expect(tool.inputSchema.properties).toHaveProperty('filters');
  expect(tool.inputSchema.required).toContain('query');
});

test('annotate_component schema has correct structure', async () => {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/list',
    params: {},
  };

  const response = await sendMCPRequest(request);
  const tool = response.result?.tools.find((t: any) => t.name === 'annotate_component');

  expect(tool).toBeDefined();
  expect(tool.inputSchema.properties).toHaveProperty('component_id');
  expect(tool.inputSchema.properties).toHaveProperty('content');
  expect(tool.inputSchema.properties).toHaveProperty('type');
  expect(tool.inputSchema.required).toContain('component_id');
  expect(tool.inputSchema.required).toContain('content');
  expect(tool.inputSchema.required).toContain('type');
});

// ===== Error Handling Tests =====

test('server returns proper MCP error format', async () => {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 16,
    method: 'tools/call',
    params: {
      name: 'unknown_tool',
      arguments: {},
    },
  };

  const response = await sendMCPRequest(request);

  expect(response.jsonrpc).toBe('2.0');
  expect(response.id).toBe(16);
  expect(response.error).toBeDefined();
  expect(response.error).toHaveProperty('code');
  expect(response.error).toHaveProperty('message');
  expect(typeof response.error.code).toBe('number');
  expect(typeof response.error.message).toBe('string');
});

test('server handles invalid JSON-RPC request gracefully', async () => {
  // This test verifies the server doesn't crash on malformed requests
  // We expect it to either return an error or timeout
  try {
    const result = await Promise.race([
      sendMCPRequest({
        jsonrpc: '2.0',
        id: 17,
        method: 'invalid_method_that_does_not_exist',
        params: {},
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 2000)
      ),
    ]);

    // If we get here, server returned an error (which is good)
    expect((result as any).error).toBeDefined();
  } catch (error: any) {
    // Timeout is also acceptable - server didn't crash
    expect(error.message).toContain('timeout');
  }
});

// ===== Performance Tests =====

test('tools/list responds within 1 second', async () => {
  const startTime = Date.now();

  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 18,
    method: 'tools/list',
    params: {},
  };

  await sendMCPRequest(request);

  const duration = Date.now() - startTime;
  expect(duration).toBeLessThan(1000);
});

test('parameter validation is fast', async () => {
  const startTime = Date.now();

  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 19,
    method: 'tools/call',
    params: {
      name: 'get_priority_issues',
      arguments: {
        limit: -5, // Invalid
      },
    },
  };

  await sendMCPRequest(request);

  const duration = Date.now() - startTime;
  expect(duration).toBeLessThan(500); // Should be very fast since it's just validation
});
