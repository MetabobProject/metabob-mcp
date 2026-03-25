#!/usr/bin/env bun
/**
 * Test script for MCP server
 * Tests tool registration and basic functionality
 */

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

async function sendMCPRequest(request: MCPRequest): Promise<MCPResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['run', 'src/index.ts'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        SESSION_ID: 'test-session',
        ANALYSIS_API_URL: process.env.ANALYSIS_API_URL || 'http://localhost:8081',
      },
    });

    let output = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Process exited with code ${code}`));
        return;
      }

      try {
        // Find JSON response in output
        const lines = output.split('\n');
        for (const line of lines) {
          if (line.trim().startsWith('{')) {
            const response = JSON.parse(line);
            resolve(response);
            return;
          }
        }
        reject(new Error('No JSON response found'));
      } catch (error) {
        reject(error);
      }
    });

    // Send request
    child.stdin.write(JSON.stringify(request) + '\n');
    child.stdin.end();

    // Timeout after 5 seconds
    setTimeout(() => {
      child.kill();
      reject(new Error('Request timeout'));
    }, 5000);
  });
}

async function testListTools() {
  console.log('\n=== Test 1: List Tools ===');

  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  };

  try {
    const response = await sendMCPRequest(request);

    if (response.error) {
      console.error('❌ Error:', response.error);
      return false;
    }

    const tools = response.result?.tools || [];
    console.log(`✅ Found ${tools.length} tools:`);

    tools.forEach((tool: any) => {
      console.log(`   - ${tool.name}: ${tool.description.slice(0, 60)}...`);
    });

    // Verify expected tools
    const expectedTools = [
      'get_priority_issues',
      'search_codebase',
      'annotate_component',
      'suggest_related_changes',
      'analyze_change_impact',
    ];

    const toolNames = tools.map((t: any) => t.name);
    const allPresent = expectedTools.every(name => toolNames.includes(name));

    if (allPresent) {
      console.log('✅ All expected tools are registered');
      return true;
    } else {
      console.log('❌ Missing some expected tools');
      return false;
    }
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

async function testCallToolWithInvalidParams() {
  console.log('\n=== Test 2: Call Tool with Invalid Params ===');

  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'get_priority_issues',
      arguments: {
        limit: -5, // Invalid: must be positive
      },
    },
  };

  try {
    const response = await sendMCPRequest(request);

    if (response.error) {
      console.log('✅ Correctly rejected invalid params:', response.error.message);
      return true;
    } else {
      console.log('❌ Should have rejected invalid params');
      return false;
    }
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

async function testUnknownTool() {
  console.log('\n=== Test 3: Call Unknown Tool ===');

  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'nonexistent_tool',
      arguments: {},
    },
  };

  try {
    const response = await sendMCPRequest(request);

    if (response.error && response.error.message.includes('Unknown tool')) {
      console.log('✅ Correctly rejected unknown tool');
      return true;
    } else {
      console.log('❌ Should have rejected unknown tool');
      return false;
    }
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

async function main() {
  console.log('🧪 Testing metabob-mcp server\n');
  console.log('Note: These tests do not require analysis-api to be running');
  console.log('They only test tool registration and validation\n');

  const results = await Promise.all([
    testListTools(),
    testCallToolWithInvalidParams(),
    testUnknownTool(),
  ]);

  const passed = results.filter(r => r).length;
  const total = results.length;

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed}/${total} tests passed`);

  if (passed === total) {
    console.log('✅ All tests passed!');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
