#!/usr/bin/env bun
/**
 * Test script for metabob-mcp server
 * Tests JSON-RPC communication and all 7 MCP tools
 */

import { spawn, type ChildProcess } from 'child_process';
import { setTimeout } from 'timers/promises';

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: any;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

class MCPTester {
  private mcpProcess: ChildProcess | null = null;
  private requestId = 1;
  private pendingRequests = new Map<number, { resolve: Function; reject: Function }>();
  private serverReady = false;

  async start() {
    console.log('Starting MCP server...');

    this.mcpProcess = spawn('bun', ['run', 'src/index.ts'], {
      cwd: '/home/avi/documents/work/exp-repo/metabob-devbob/repos/metabob-mcp',
      env: {
        ...process.env,
        ANALYSIS_API_URL: 'http://localhost:9083',
        SESSION_ID: `test-session-${Date.now()}`,
        LOG_LEVEL: 'debug',
        HEALTH_PORT: '8092',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Handle stdout (JSON-RPC responses)
    this.mcpProcess.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n').filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          const response: JSONRPCResponse = JSON.parse(line);
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            this.pendingRequests.delete(response.id);
            if (response.error) {
              pending.reject(response.error);
            } else {
              pending.resolve(response.result);
            }
          }
        } catch (err) {
          // Ignore non-JSON output
        }
      }
    });

    // Handle stderr (logs)
    this.mcpProcess.stderr?.on('data', (data) => {
      const logs = data.toString().trim();
      console.log('[MCP Server]', logs);

      if (logs.includes('MCP server ready')) {
        this.serverReady = true;
      }
    });

    this.mcpProcess.on('error', (err) => {
      console.error('MCP process error:', err);
    });

    this.mcpProcess.on('exit', (code) => {
      console.log(`MCP process exited with code ${code}`);
    });

    // Wait for server to be ready
    let attempts = 0;
    while (!this.serverReady && attempts < 30) {
      await setTimeout(100);
      attempts++;
    }

    if (!this.serverReady) {
      throw new Error('MCP server failed to start after 3 seconds');
    }

    console.log('MCP server started successfully\n');
  }

  async stop() {
    if (this.mcpProcess) {
      this.mcpProcess.kill();
      this.mcpProcess = null;
    }
  }

  private async sendRequest(method: string, params?: any): Promise<any> {
    if (!this.mcpProcess?.stdin) {
      throw new Error('MCP server not running');
    }

    const id = this.requestId++;
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      const requestLine = JSON.stringify(request) + '\n';
      this.mcpProcess!.stdin!.write(requestLine);

      // Timeout after 30 seconds
      setTimeout(30000).then(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      });
    });
  }

  async testInitialize() {
    console.log('=== Test: Initialize Handshake ===');
    try {
      const result = await this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'test-client',
          version: '1.0.0',
        },
      });
      console.log('✓ Initialize successful');
      console.log('Server info:', JSON.stringify(result.serverInfo, null, 2));
      console.log('Capabilities:', JSON.stringify(result.capabilities, null, 2));
      console.log('');
      return true;
    } catch (error) {
      console.error('✗ Initialize failed:', error);
      console.log('');
      return false;
    }
  }

  async testListTools() {
    console.log('=== Test: List Tools ===');
    try {
      const result = await this.sendRequest('tools/list');
      console.log(`✓ Found ${result.tools.length} tools`);
      for (const tool of result.tools) {
        console.log(`  - ${tool.name}: ${tool.description}`);
      }
      console.log('');
      return result.tools.length === 7;
    } catch (error) {
      console.error('✗ List tools failed:', error);
      console.log('');
      return false;
    }
  }

  async testGetPriorityIssues() {
    console.log('=== Test: get_priority_issues ===');
    try {
      const result = await this.sendRequest('tools/call', {
        name: 'get_priority_issues',
        arguments: {
          limit: 5,
          severity: ['HIGH', 'CRITICAL'],
        },
      });
      console.log('✓ Tool executed successfully');
      console.log('Response:', result.content[0].text.substring(0, 200) + '...');
      console.log('');
      return true;
    } catch (error: any) {
      console.error('✗ Tool failed:', error.message);
      console.log('');
      return false;
    }
  }

  async testSearchCodebase() {
    console.log('=== Test: search_codebase ===');
    try {
      const result = await this.sendRequest('tools/call', {
        name: 'search_codebase',
        arguments: {
          query: 'function',
          limit: 5,
        },
      });
      console.log('✓ Tool executed successfully');
      console.log('Response:', result.content[0].text.substring(0, 200) + '...');
      console.log('');
      return true;
    } catch (error: any) {
      console.error('✗ Tool failed:', error.message);
      console.log('');
      return false;
    }
  }

  async testAnnotateComponent() {
    console.log('=== Test: annotate_component ===');
    try {
      const result = await this.sendRequest('tools/call', {
        name: 'annotate_component',
        arguments: {
          component_id: 'test-component-123',
          annotation_type: 'semantic',
          annotation_value: 'Test annotation',
        },
      });
      console.log('✓ Tool executed successfully');
      console.log('Response:', result.content[0].text);
      console.log('');
      return true;
    } catch (error: any) {
      console.error('✗ Tool failed:', error.message);
      console.log('');
      return false;
    }
  }

  async testSuggestRelatedChanges() {
    console.log('=== Test: suggest_related_changes ===');
    try {
      const result = await this.sendRequest('tools/call', {
        name: 'suggest_related_changes',
        arguments: {
          component_id: 'test-component-123',
          change_description: 'Added new parameter',
          limit: 3,
        },
      });
      console.log('✓ Tool executed successfully');
      console.log('Response:', result.content[0].text.substring(0, 200) + '...');
      console.log('');
      return true;
    } catch (error: any) {
      console.error('✗ Tool failed:', error.message);
      console.log('');
      return false;
    }
  }

  async testAnalyzeChangeImpact() {
    console.log('=== Test: analyze_change_impact ===');
    try {
      const result = await this.sendRequest('tools/call', {
        name: 'analyze_change_impact',
        arguments: {
          component_id: 'test-component-123',
          change_type: 'interface_change',
        },
      });
      console.log('✓ Tool executed successfully');
      console.log('Response:', result.content[0].text.substring(0, 200) + '...');
      console.log('');
      return true;
    } catch (error: any) {
      console.error('✗ Tool failed:', error.message);
      console.log('');
      return false;
    }
  }

  async testMarkProblemComplete() {
    console.log('=== Test: mark_problem_complete ===');
    try {
      const result = await this.sendRequest('tools/call', {
        name: 'mark_problem_complete',
        arguments: {
          problem_id: 'test-problem-123',
          resolution_summary: 'Fixed the issue by updating the logic',
          files_modified: ['src/test.ts'],
        },
      });
      console.log('✓ Tool executed successfully');
      console.log('Response:', result.content[0].text);
      console.log('');
      return true;
    } catch (error: any) {
      console.error('✗ Tool failed:', error.message);
      console.log('');
      return false;
    }
  }

  async testGenerateImplementationSpec() {
    console.log('=== Test: generate_implementation_spec ===');
    try {
      const result = await this.sendRequest('tools/call', {
        name: 'generate_implementation_spec',
        arguments: {
          problem_description: 'Add user authentication',
          affected_components: ['auth-service', 'user-model'],
        },
      });
      console.log('✓ Tool executed successfully');
      console.log('Response:', result.content[0].text.substring(0, 200) + '...');
      console.log('');
      return true;
    } catch (error: any) {
      console.error('✗ Tool failed:', error.message);
      console.log('');
      return false;
    }
  }

  async runAllTests() {
    const results = {
      initialize: false,
      listTools: false,
      getPriorityIssues: false,
      searchCodebase: false,
      annotateComponent: false,
      suggestRelatedChanges: false,
      analyzeChangeImpact: false,
      markProblemComplete: false,
      generateImplementationSpec: false,
    };

    results.initialize = await this.testInitialize();
    results.listTools = await this.testListTools();
    results.getPriorityIssues = await this.testGetPriorityIssues();
    results.searchCodebase = await this.testSearchCodebase();
    results.annotateComponent = await this.testAnnotateComponent();
    results.suggestRelatedChanges = await this.testSuggestRelatedChanges();
    results.analyzeChangeImpact = await this.testAnalyzeChangeImpact();
    results.markProblemComplete = await this.testMarkProblemComplete();
    results.generateImplementationSpec = await this.testGenerateImplementationSpec();

    return results;
  }
}

async function main() {
  console.log('=== metabob-mcp Integration Tests ===\n');

  // Check if port-forward is already running
  console.log('Checking for existing port-forward...');
  const checkPF = spawn('sh', ['-c', 'pgrep -f "port-forward.*metabob-analysis-api"']);
  checkPF.on('exit', (code) => {
    if (code !== 0) {
      console.log('No existing port-forward found. Please run:');
      console.log('  kubectl port-forward -n activity-system svc/metabob-analysis-api 9083:8080');
      console.log('');
    }
  });

  await setTimeout(500);

  const tester = new MCPTester();

  try {
    await tester.start();
    const results = await tester.runAllTests();

    console.log('\n=== Test Summary ===');
    console.log(`Initialize:                   ${results.initialize ? '✓' : '✗'}`);
    console.log(`List Tools:                   ${results.listTools ? '✓' : '✗'}`);
    console.log(`get_priority_issues:          ${results.getPriorityIssues ? '✓' : '✗'}`);
    console.log(`search_codebase:              ${results.searchCodebase ? '✓' : '✗'}`);
    console.log(`annotate_component:           ${results.annotateComponent ? '✓' : '✗'}`);
    console.log(`suggest_related_changes:      ${results.suggestRelatedChanges ? '✓' : '✗'}`);
    console.log(`analyze_change_impact:        ${results.analyzeChangeImpact ? '✓' : '✗'}`);
    console.log(`mark_problem_complete:        ${results.markProblemComplete ? '✓' : '✗'}`);
    console.log(`generate_implementation_spec: ${results.generateImplementationSpec ? '✓' : '✗'}`);

    const totalTests = Object.keys(results).length;
    const passedTests = Object.values(results).filter(r => r).length;

    console.log(`\nPassed: ${passedTests}/${totalTests}`);

    if (passedTests === totalTests) {
      console.log('\n✓ All tests passed!');
      process.exit(0);
    } else {
      console.log('\n✗ Some tests failed');
      process.exit(1);
    }
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  } finally {
    await tester.stop();
  }
}

main();
