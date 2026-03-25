#!/usr/bin/env bun
/**
 * Test MCP server stdio communication
 * Sends a JSON-RPC request and checks for response
 */

import { spawn } from 'child_process';

const serverPath = './src/index.ts';

console.error('Starting MCP server...');

const server = spawn('bun', ['run', serverPath], {
  stdio: ['pipe', 'pipe', 'inherit'], // stdin pipe, stdout pipe, stderr inherit
  env: {
    ...process.env,
    LOG_LEVEL: 'debug',
    ANALYSIS_API_URL: 'http://localhost:8081',
    HEALTH_PORT: '8090',
  },
});

let responseReceived = false;
let buffer = '';

server.stdout.on('data', (data) => {
  buffer += data.toString();
  console.error(`[SERVER STDOUT] ${data.toString()}`);

  // Try to parse JSON-RPC responses
  const lines = buffer.split('\n');
  buffer = lines.pop() || ''; // Keep incomplete line in buffer

  for (const line of lines) {
    if (line.trim()) {
      try {
        const response = JSON.parse(line);
        console.error(`[PARSED RESPONSE]`, response);
        responseReceived = true;
      } catch (e) {
        console.error(`[NON-JSON LINE] ${line}`);
      }
    }
  }
});

server.on('error', (err) => {
  console.error(`[ERROR] Failed to start server: ${err}`);
  process.exit(1);
});

// Wait for server to initialize
await new Promise(resolve => setTimeout(resolve, 2000));

console.error('\nSending initialize request...');
const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {
      name: 'test-client',
      version: '1.0.0',
    },
  },
};

server.stdin.write(JSON.stringify(initializeRequest) + '\n');

// Wait for response
await new Promise(resolve => setTimeout(resolve, 3000));

if (!responseReceived) {
  console.error('\n❌ NO RESPONSE RECEIVED - Server is not responding to JSON-RPC requests');
} else {
  console.error('\n✅ Response received - Server is working');
}

console.error('\nSending tools/list request...');
const listToolsRequest = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
};

server.stdin.write(JSON.stringify(listToolsRequest) + '\n');

// Wait for response
await new Promise(resolve => setTimeout(resolve, 3000));

console.error('\nShutting down server...');
server.kill('SIGTERM');

await new Promise(resolve => setTimeout(resolve, 1000));

process.exit(responseReceived ? 0 : 1);
