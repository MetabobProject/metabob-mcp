#!/usr/bin/env bun
/**
 * Direct API testing without MCP layer
 * Tests each endpoint that the MCP tools will call
 */

const API_URL = 'http://localhost:9083';
const SESSION_ID = `test-direct-${Date.now()}`;

interface TestResult {
  name: string;
  endpoint: string;
  success: boolean;
  status?: number;
  error?: string;
  duration: number;
  response?: any;
}

const results: TestResult[] = [];

async function testEndpoint(
  name: string,
  method: 'GET' | 'POST' | 'PUT',
  endpoint: string,
  body?: any
): Promise<TestResult> {
  const startTime = Date.now();
  const result: TestResult = {
    name,
    endpoint,
    success: false,
    duration: 0,
  };

  try {
    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': SESSION_ID,
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${API_URL}${endpoint}`, options);
    result.status = response.status;
    result.duration = Date.now() - startTime;

    if (response.ok) {
      result.response = await response.json();
      result.success = true;
    } else {
      const errorText = await response.text();
      result.error = `HTTP ${response.status}: ${errorText}`;
    }
  } catch (error) {
    result.duration = Date.now() - startTime;
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

async function main() {
  console.log('=== Direct API Testing ===');
  console.log(`API URL: ${API_URL}`);
  console.log(`Session ID: ${SESSION_ID}`);
  console.log('');

  // Test 1: Health check
  console.log('1. Testing health endpoint...');
  const health = await testEndpoint('Health Check', 'GET', '/health');
  results.push(health);
  console.log(`   ${health.success ? '✓' : '✗'} ${health.duration}ms`);
  if (!health.success) console.log(`   Error: ${health.error}`);
  console.log('');

  // Test 2: Get priority issues
  console.log('2. Testing GET /v2/analysis/priority...');
  const priority = await testEndpoint(
    'Get Priority Issues',
    'GET',
    '/v2/analysis/priority?limit=5&severity[]=HIGH&severity[]=CRITICAL&scope=session'
  );
  results.push(priority);
  console.log(`   ${priority.success ? '✓' : '✗'} ${priority.duration}ms`);
  if (priority.success) {
    console.log(`   Found ${priority.response?.issues?.length || 0} issues`);
  } else {
    console.log(`   Error: ${priority.error}`);
  }
  console.log('');

  // Test 3: Search codebase
  console.log('3. Testing POST /v2/analysis/search...');
  const search = await testEndpoint('Search Codebase', 'POST', '/v2/analysis/search', {
    query: 'function',
    limit: 5,
  });
  results.push(search);
  console.log(`   ${search.success ? '✓' : '✗'} ${search.duration}ms`);
  if (search.success) {
    console.log(`   Found ${search.response?.results?.length || 0} results`);
  } else {
    console.log(`   Error: ${search.error}`);
  }
  console.log('');

  // Test 4: Annotate component
  console.log('4. Testing POST /v2/analysis/components/:id/annotate...');
  const annotate = await testEndpoint(
    'Annotate Component',
    'POST',
    '/v2/analysis/components/test-component-123/annotate',
    {
      annotation_type: 'semantic',
      annotation_value: 'Test annotation',
    }
  );
  results.push(annotate);
  console.log(`   ${annotate.success ? '✓' : '✗'} ${annotate.duration}ms`);
  if (!annotate.success) console.log(`   Error: ${annotate.error}`);
  console.log('');

  // Test 5: Suggest related changes
  console.log('5. Testing POST /v2/analysis/components/:id/related-changes...');
  const related = await testEndpoint(
    'Suggest Related Changes',
    'POST',
    '/v2/analysis/components/test-component-123/related-changes',
    {
      change_description: 'Added new parameter',
      limit: 3,
    }
  );
  results.push(related);
  console.log(`   ${related.success ? '✓' : '✗'} ${related.duration}ms`);
  if (related.success) {
    console.log(`   Found ${related.response?.suggestions?.length || 0} suggestions`);
  } else {
    console.log(`   Error: ${related.error}`);
  }
  console.log('');

  // Test 6: Analyze change impact
  console.log('6. Testing POST /v2/analysis/components/:id/impact...');
  const impact = await testEndpoint(
    'Analyze Change Impact',
    'POST',
    '/v2/analysis/components/test-component-123/impact',
    {
      change_type: 'interface_change',
    }
  );
  results.push(impact);
  console.log(`   ${impact.success ? '✓' : '✗'} ${impact.duration}ms`);
  if (impact.success) {
    console.log(`   Impact level: ${impact.response?.impact_level || 'N/A'}`);
  } else {
    console.log(`   Error: ${impact.error}`);
  }
  console.log('');

  // Test 7: Mark problem complete
  console.log('7. Testing PUT /v2/analysis/problems/:id/complete...');
  const complete = await testEndpoint(
    'Mark Problem Complete',
    'PUT',
    '/v2/analysis/problems/test-problem-123/complete',
    {
      resolution_summary: 'Fixed the issue',
      files_modified: ['src/test.ts'],
    }
  );
  results.push(complete);
  console.log(`   ${complete.success ? '✓' : '✗'} ${complete.duration}ms`);
  if (!complete.success) console.log(`   Error: ${complete.error}`);
  console.log('');

  // Test 8: Generate implementation spec
  console.log('8. Testing POST /v2/analysis/implementation-spec...');
  const spec = await testEndpoint(
    'Generate Implementation Spec',
    'POST',
    '/v2/analysis/implementation-spec',
    {
      problem_description: 'Add user authentication',
      affected_components: ['auth-service', 'user-model'],
    }
  );
  results.push(spec);
  console.log(`   ${spec.success ? '✓' : '✗'} ${spec.duration}ms`);
  if (spec.success) {
    console.log(`   Generated spec with ${spec.response?.steps?.length || 0} steps`);
  } else {
    console.log(`   Error: ${spec.error}`);
  }
  console.log('');

  // Summary
  console.log('=== Test Summary ===');
  const passed = results.filter(r => r.success).length;
  const total = results.length;

  results.forEach(r => {
    console.log(`${r.success ? '✓' : '✗'} ${r.name} (${r.duration}ms)`);
    if (!r.success && r.error) {
      console.log(`  Error: ${r.error}`);
    }
  });

  console.log(`\nPassed: ${passed}/${total}`);

  if (passed === total) {
    console.log('\n✓ All API endpoints working correctly!');
    process.exit(0);
  } else {
    console.log('\n✗ Some endpoints failed. Check errors above.');
    process.exit(1);
  }
}

main();
