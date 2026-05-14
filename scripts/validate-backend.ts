#!/usr/bin/env bun
/**
 * Backend validation script — verifies the full metabob-mcp tool surface
 * against ide.metabob.com using a real API key.
 *
 * Usage:
 *   METABOB_API_KEY=mb_live_... bun run scripts/validate-backend.ts [workspace]
 *
 * workspace defaults to the current directory.
 *
 * What it checks:
 *   Phase 1 — auth: session token exchange with ide.metabob.com
 *   Phase 2 — local: init_workspace (CPG parse + file submission)
 *   Phase 3 — api reads: get_metrics, get_problems, search_codebase
 *   Phase 4 — local inference: predict_cochanges, analyze_impact
 *   Phase 5 — api writes: annotate_component (if problems found)
 *   Phase 6 — context: get_analysis_context, assign_git_changes
 */

import { spawn } from 'child_process';
import { resolve } from 'path';

const API_KEY = process.env.METABOB_API_KEY;
const WORKSPACE = resolve(process.argv[2] ?? process.cwd());
const API_URL = process.env.ANALYSIS_API_URL ?? 'https://ide.metabob.com';

if (!API_KEY) {
  console.error('Error: METABOB_API_KEY is required');
  console.error('  METABOB_API_KEY=mb_live_... bun run scripts/validate-backend.ts [workspace]');
  process.exit(1);
}

// ── MCP JSON-RPC over stdio ───────────────────────────────────────────────────

let msgId = 0;
let child: ReturnType<typeof spawn> | null = null;
let buffer = '';
const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();

function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    child = spawn('metabob-mcp', [], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        METABOB_API_KEY: API_KEY!,
        ANALYSIS_API_URL: API_URL,
        SESSION_ID: 'validate-backend',
        LOG_LEVEL: 'error',
        HEALTH_PORT: '18099',
      },
    });

    child.stdout!.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.jsonrpc === '2.0' && msg.id != null) {
            pending.get(msg.id)?.resolve(msg);
            pending.delete(msg.id);
          }
        } catch {}
      }
    });

    child.on('error', reject);

    // Give the server 5s to authenticate and become ready
    setTimeout(resolve, 5000);
  });
}

function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for response to ${method}`));
    }, 30000);

    pending.set(id, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });

    child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await send('tools/call', { name, arguments: args });
  if (res.error) throw new Error(res.error.message ?? JSON.stringify(res.error));
  const content = res.result?.content ?? [];
  const text = content.map((c: any) => c.text ?? '').join('\n');
  return text;
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function check(label: string, fn: () => Promise<string>): Promise<string | null> {
  process.stdout.write(`  ${label}... `);
  try {
    const detail = await fn();
    console.log(`✓ ${detail ?? 'ok'}`);
    passed++;
    return detail;
  } catch (err) {
    console.log(`✗ ${err instanceof Error ? err.message : err}`);
    failed++;
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\nvalidate-backend — metabob-mcp`);
console.log(`  API:       ${API_URL}`);
console.log(`  Workspace: ${WORKSPACE}`);
console.log('');

console.log('Starting server...');
await startServer();

// Phase 1 — protocol handshake
console.log('\nPhase 1: protocol');
await check('tools/list returns 10 tools', async () => {
  const res = await send('tools/list', {});
  const n = res.result?.tools?.length;
  if (n !== 10) throw new Error(`expected 10, got ${n}`);
  return `${n} tools`;
});

// Phase 2 — local + API submission
console.log('\nPhase 2: init_workspace');
await check('CPG parse + file submission', async () => {
  const out = await callTool('init_workspace', {
    workspace_path: WORKSPACE,
    batch_size: 3,
    max_files: 20,
  });
  if (!out.includes('Workspace') && !out.includes('workspace') && !out.includes('files')) {
    throw new Error(`unexpected output: ${out.slice(0, 120)}`);
  }
  const match = out.match(/(\d+)\s*files?/i);
  return match ? match[0] : 'done';
});

// Phase 3 — API reads
console.log('\nPhase 3: api reads');
const metricsOut = await check('get_metrics', async () => {
  const out = await callTool('get_metrics', {});
  return out.slice(0, 80).replace(/\n/g, ' ');
});

let firstProblemId: string | null = null;
await check('get_problems', async () => {
  const out = await callTool('get_problems', { limit: 5 });
  // Try to extract a problem ID for annotate_component
  const idMatch = out.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/);
  if (idMatch) firstProblemId = idMatch[0];
  const lines = out.split('\n').filter(Boolean);
  return `${lines.length} lines returned${firstProblemId ? ', problem ID captured' : ''}`;
});

await check('search_codebase (codebase)', async () => {
  const out = await callTool('search_codebase', { query: 'function', limit: 3, target: 'codebase' });
  return out.slice(0, 80).replace(/\n/g, ' ');
});

// Phase 4 — local inference (needs init_workspace to have run first)
console.log('\nPhase 4: local inference');
await check('predict_cochanges', async () => {
  const files = (await import('fs')).readdirSync(WORKSPACE)
    .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
    .slice(0, 2)
    .map(f => `${WORKSPACE}/${f}`);
  if (!files.length) return 'skipped (no .ts/.js files at workspace root)';
  const out = await callTool('predict_cochanges', { changed_files: files, limit: 3 });
  return out.slice(0, 80).replace(/\n/g, ' ');
});

await check('analyze_impact', async () => {
  const files = (await import('fs')).readdirSync(WORKSPACE)
    .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
    .slice(0, 1)
    .map(f => `${WORKSPACE}/${f}`);
  if (!files.length) return 'skipped (no .ts/.js files at workspace root)';
  const out = await callTool('analyze_impact', { changed_files: files, direction: 'downstream' });
  return out.slice(0, 80).replace(/\n/g, ' ');
});

// Phase 5 — API write (annotation)
console.log('\nPhase 5: api writes');
await check('annotate_component', async () => {
  if (!firstProblemId) return 'skipped (no problem ID from get_problems)';
  const out = await callTool('annotate_component', { problem_id: firstProblemId, mode: 'explain' });
  return out.slice(0, 80).replace(/\n/g, ' ');
});

// Phase 6 — context tools
console.log('\nPhase 6: context');
await check('get_analysis_context', async () => {
  const out = await callTool('get_analysis_context', { problem_limit: 3, scope: 'session' });
  return out.slice(0, 80).replace(/\n/g, ' ');
});

await check('assign_git_changes', async () => {
  const out = await callTool('assign_git_changes', {
    changed_files: [`${WORKSPACE}/src/index.ts`],
    include_cochange_predictions: true,
  });
  return out.slice(0, 80).replace(/\n/g, ' ');
});

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`  Passed: ${passed}   Failed: ${failed}   Total: ${passed + failed}`);
if (failed === 0) {
  console.log('  All checks passed ✓');
} else {
  console.log(`  ${failed} check(s) failed`);
}
console.log('');

child?.kill();
process.exit(failed > 0 ? 1 : 0);
