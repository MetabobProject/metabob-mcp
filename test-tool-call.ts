#!/usr/bin/env bun
/**
 * Test MCP tool call over stdio
 */

import { spawn } from 'child_process';

const serverPath = './src/index.ts';

console.error('Starting MCP server...');

const server = spawn('bun', ['run', serverPath], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {
    ...process.env,
    LOG_LEVEL: 'debug',
    ANALYSIS_API_URL: 'http://localhost:8081',
    HEALTH_PORT: '8091',
  },
});

let buffer = '';
const responses: any[] = [];

server.stdout.on('data', (data) => {
  buffer += data.toString();

  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (line.trim()) {
      try {
        const response = JSON.parse(line);
        console.error(`[RESPONSE ${response.id}]`, JSON.stringify(response, null, 2));
        responses.push(response);
      } catch (e) {
        // Ignore non-JSON lines
      }
    }
  }
});

// Wait for server to initialize
await new Promise(resolve => setTimeout(resolve, 2000));

console.error('\n1. Sending initialize request...');
server.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
}) + '\n');

await new Promise(resolve => setTimeout(resolve, 1000));

console.error('\n2. Sending initialized notification...');
server.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  method: 'notifications/initialized',
}) + '\n');

await new Promise(resolve => setTimeout(resolve, 500));

console.error('\n3. Sending tools/call request (get_priority_issues)...');
const toolCallRequest = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: 'get_priority_issues',
    arguments: {
      limit: 5,
      scope: 'session',
    },
  },
};

console.error('Request:', JSON.stringify(toolCallRequest, null, 2));
server.stdin.write(JSON.stringify(toolCallRequest) + '\n');

console.error('\nWaiting for tool response (35 seconds timeout)...');
await new Promise(resolve => setTimeout(resolve, 35000));

if (responses.find(r => r.id === 2)) {
  console.error('\n✅ Tool call response received!');
  process.exit(0);
} else {
  console.error('\n❌ Tool call TIMED OUT - no response after 35 seconds');
  console.error(`Received ${responses.length} total responses`);
  process.exit(1);
}
