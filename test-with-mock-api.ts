#!/usr/bin/env bun
/**
 * Integration test with mock analysis API
 * Tests full MCP tool execution flow
 */

import { spawn, type ChildProcess } from 'child_process';

// Mock API server
async function startMockAPI() {
  const mockServer = Bun.serve({
    port: 8082,
    async fetch(req) {
      const url = new URL(req.url);

      // Health endpoint
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok' });
      }

      // Priority issues endpoint
      if (url.pathname === '/v2/analysis/priority') {
        return Response.json({
          issues: [
            {
              id: 'problem:test123',
              session_id: 'test-session',
              component_id: 'src/auth.ts::function::login::15',
              severity: 'HIGH',
              category: 'security',
              message: 'Potential SQL injection vulnerability',
              impact_score: 0.85,
              status: 'open',
              created_at: '2026-03-24T12:00:00Z',
              updated_at: '2026-03-24T12:00:00Z',
            },
          ],
          total_issues: 1,
          query_time_ms: 50,
        });
      }

      // Search endpoint
      if (url.pathname === '/v2/analysis/search') {
        return Response.json({
          results: [
            {
              id: 'problem:test456',
              component_id: 'src/api.ts::function::handleRequest::20',
              severity: 'MEDIUM',
              category: 'performance',
              message: 'N+1 query detected',
              impact_score: 0.6,
              status: 'open',
              similarity_score: 0.78,
              match_reason: 'Keywords: query, performance',
            },
          ],
          query_time_ms: 120,
        });
      }

      // Annotations endpoint
      if (url.pathname === '/v2/analysis/annotations') {
        return Response.json(
          {
            annotation_id: 'annotation:test789',
            annotation: {
              id: 'annotation:test789',
              component_id: 'src/auth.ts::function::login::15',
              text: 'Test annotation',
              type: 'implementation_note',
              session_id: 'test-session',
              created_by: 'test-user',
              created_at: '2026-03-24T12:30:00Z',
            },
          },
          { status: 201 }
        );
      }

      // Co-change suggestions
      if (url.pathname === '/v2/analysis/cochange/suggest') {
        return Response.json({
          suggestions: [
            {
              file_path: 'src/auth/session.ts',
              confidence: 0.82,
              reason: 'hybrid',
              affected_components: ['src/auth/session.ts::function::createSession::10'],
              historical_frequency: 5,
              embedding_similarity: 0.89,
            },
          ],
          model_version: 'cochange-v2.3',
          query_time_ms: 200,
        });
      }

      // Impact analysis
      if (url.pathname === '/v2/analysis/impact') {
        return Response.json({
          analysis: {
            changed_components: ['src/auth/login.ts::function::login::15'],
            direct_dependencies: [
              {
                component_id: 'src/db.ts::function::query::5',
                component_name: 'query',
                file_path: 'src/db.ts',
                depth: 1,
                risk: 'high',
                reason: 'Called by changed component',
                annotations: [],
              },
            ],
            indirect_dependencies: [],
            affected_tests: [],
            risk_level: 'medium',
          },
          query_time_ms: 300,
        });
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  console.log('✅ Mock API started on port 8082');
  return mockServer;
}

// Test MCP tool call
async function testMCPToolCall(
  toolName: string,
  args: any
): Promise<{ success: boolean; result?: any; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', 'src/index.ts'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        SESSION_ID: 'test-session',
        ANALYSIS_API_URL: 'http://localhost:8082',
        LOG_LEVEL: 'error', // Quiet logs
      },
    });

    let output = '';
    let errorOccurred = false;

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.on('error', () => {
      errorOccurred = true;
    });

    child.on('close', (code) => {
      if (errorOccurred) {
        resolve({ success: false, error: 'Process error' });
        return;
      }

      try {
        // Find JSON response
        const lines = output.split('\n');
        for (const line of lines) {
          if (line.trim().startsWith('{')) {
            const response = JSON.parse(line);

            if (response.error) {
              resolve({ success: false, error: response.error.message });
            } else {
              resolve({ success: true, result: response.result });
            }
            return;
          }
        }

        resolve({ success: false, error: 'No JSON response found' });
      } catch (error) {
        resolve({ success: false, error: String(error) });
      }
    });

    // Send request
    const request = {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    };

    child.stdin.write(JSON.stringify(request) + '\n');
    child.stdin.end();

    // Timeout
    setTimeout(() => {
      child.kill();
      resolve({ success: false, error: 'Timeout' });
    }, 5000);
  });
}

async function main() {
  console.log('🧪 Integration Test: MCP Server with Mock API\n');

  // Start mock API
  const mockServer = await startMockAPI();

  // Wait for server to be ready
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Test 1: get_priority_issues
  console.log('\n=== Test 1: get_priority_issues ===');
  const test1 = await testMCPToolCall('get_priority_issues', {
    limit: 5,
    severity: ['HIGH'],
  });

  if (test1.success) {
    console.log('✅ Tool executed successfully');
    const text = test1.result?.content?.[0]?.text || '';
    if (text.includes('SQL injection')) {
      console.log('✅ Response contains expected issue');
    } else {
      console.log('❌ Response missing expected content');
    }
  } else {
    console.log('❌ Tool failed:', test1.error);
  }

  // Test 2: search_codebase
  console.log('\n=== Test 2: search_codebase ===');
  const test2 = await testMCPToolCall('search_codebase', {
    query: 'find performance issues',
    limit: 5,
  });

  if (test2.success) {
    console.log('✅ Tool executed successfully');
    const text = test2.result?.content?.[0]?.text || '';
    if (text.includes('N+1 query')) {
      console.log('✅ Response contains search results');
    } else {
      console.log('❌ Response missing expected content');
    }
  } else {
    console.log('❌ Tool failed:', test2.error);
  }

  // Test 3: annotate_component
  console.log('\n=== Test 3: annotate_component ===');
  const test3 = await testMCPToolCall('annotate_component', {
    component_id: 'src/auth.ts::function::login::15',
    content: 'Test annotation',
    type: 'implementation_note',
  });

  if (test3.success) {
    console.log('✅ Tool executed successfully');
    const text = test3.result?.content?.[0]?.text || '';
    if (text.includes('Annotation created')) {
      console.log('✅ Annotation was created');
    } else {
      console.log('❌ Response missing expected content');
    }
  } else {
    console.log('❌ Tool failed:', test3.error);
  }

  // Test 4: suggest_related_changes
  console.log('\n=== Test 4: suggest_related_changes ===');
  const test4 = await testMCPToolCall('suggest_related_changes', {
    changed_files: ['src/auth/login.ts'],
    limit: 5,
  });

  if (test4.success) {
    console.log('✅ Tool executed successfully');
    const text = test4.result?.content?.[0]?.text || '';
    if (text.includes('session.ts')) {
      console.log('✅ Co-change suggestions returned');
    } else {
      console.log('❌ Response missing expected content');
    }
  } else {
    console.log('❌ Tool failed:', test4.error);
  }

  // Test 5: analyze_change_impact
  console.log('\n=== Test 5: analyze_change_impact ===');
  const test5 = await testMCPToolCall('analyze_change_impact', {
    changed_files: ['src/auth/login.ts'],
    max_depth: 5,
  });

  if (test5.success) {
    console.log('✅ Tool executed successfully');
    const text = test5.result?.content?.[0]?.text || '';
    if (text.includes('Impact Analysis')) {
      console.log('✅ Impact analysis returned');
    } else {
      console.log('❌ Response missing expected content');
    }
  } else {
    console.log('❌ Tool failed:', test5.error);
  }

  // Cleanup
  mockServer.stop();

  const results = [test1, test2, test3, test4, test5];
  const passed = results.filter((r) => r.success).length;

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed}/${results.length} tests passed`);

  if (passed === results.length) {
    console.log('✅ All integration tests passed!');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
