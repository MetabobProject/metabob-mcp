#!/usr/bin/env bun
/**
 * Simple test: List tools via MCP protocol
 */

import { spawn } from 'child_process';

async function testListTools() {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['run', 'src/index.ts'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SESSION_ID: 'test-session',
        ANALYSIS_API_URL: 'http://localhost:8082',
        LOG_LEVEL: 'error',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });

    // Send tools/list request
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    };

    child.stdin.write(JSON.stringify(request) + '\n');
    child.stdin.end();

    // Timeout
    setTimeout(() => {
      child.kill();
      reject(new Error('Timeout'));
    }, 5000);
  });
}

async function main() {
  console.log('🧪 Testing MCP Server - List Tools\n');

  try {
    const result = await testListTools() as any;

    console.log('=== STDOUT ===');
    console.log(result.stdout);

    if (result.stderr) {
      console.log('\n=== STDERR ===');
      console.log(result.stderr);
    }

    // Parse JSON response
    const lines = result.stdout.split('\n');
    for (const line of lines) {
      if (line.trim().startsWith('{')) {
        const response = JSON.parse(line);

        if (response.error) {
          console.log('\n❌ Error:', response.error);
          process.exit(1);
        }

        if (response.result?.tools) {
          const tools = response.result.tools;
          console.log(`\n✅ Found ${tools.length} tools:`);

          tools.forEach((tool: any) => {
            console.log(`   - ${tool.name}`);
          });

          // Check for expected tools
          const expectedTools = [
            'get_priority_issues',
            'search_codebase',
            'annotate_component',
            'suggest_related_changes',
            'analyze_change_impact',
          ];

          const toolNames = tools.map((t: any) => t.name);
          const allPresent = expectedTools.every((name) => toolNames.includes(name));

          if (allPresent) {
            console.log('\n✅ All expected tools are registered');
            process.exit(0);
          } else {
            console.log('\n❌ Some expected tools are missing');
            process.exit(1);
          }
        }
      }
    }

    console.log('\n❌ No valid JSON response found');
    process.exit(1);
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

main();
