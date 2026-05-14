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
 * Phases (API tools tested before init_workspace to avoid event-loop blocking):
 *   Phase 1 — auth + protocol: session token exchange, tools/list
 *   Phase 2 — api reads: get_metrics, get_problems, search_codebase
 *   Phase 3 — api writes: annotate_component (if problems found)
 *   Phase 4 — local CPG: init_workspace (parse + submission)
 *   Phase 5 — local inference: predict_cochanges, analyze_impact
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
    // Use bun to run the source directly — avoids the Node.js ~4GB heap limit
    // that ONNX + Tree-sitter grammars exceed when running via dist/cli.js.
    const serverDir = new URL('../', import.meta.url).pathname;
    child = spawn('bun', ['run', 'src/index.ts'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: serverDir,
      env: {
        ...process.env,
        METABOB_API_KEY: API_KEY!,
        ANALYSIS_API_URL: API_URL,
        SESSION_ID: 'validate-backend',
        LOG_LEVEL: 'error',
        HEALTH_PORT: '18099',
        NODE_OPTIONS: '--max-old-space-size=8192',
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

    // Give the server 8s to authenticate and become ready
    setTimeout(resolve, 8000);
  });
}

function send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<any> {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    pending.set(id, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });

    child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function callTool(name: string, args: Record<string, unknown> = {}, timeoutMs = 30000): Promise<string> {
  const res = await send('tools/call', { name, arguments: args }, timeoutMs);
  if (res.error) throw new Error(res.error.message ?? JSON.stringify(res.error));
  const content = res.result?.content ?? [];
  return content.map((c: any) => c.text ?? '').join('\n');
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

// Phase 1 — protocol
console.log('\nPhase 1: protocol');
await check('tools/list returns 10 tools', async () => {
  const res = await send('tools/list', {});
  const n = res.result?.tools?.length;
  if (n !== 10) throw new Error(`expected 10, got ${n}`);
  return `${n} tools`;
});

// Phase 2 — API reads (no workspace needed, tests auth + session)
console.log('\nPhase 2: api reads');
await check('get_metrics', async () => {
  const out = await callTool('get_metrics', {});
  return out.trim().split('\n')[0] ?? '(empty)';
});

let firstProblemId: string | null = null;
await check('get_problems', async () => {
  const out = await callTool('get_problems', { limit: 5 });
  const idMatch = out.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/);
  if (idMatch) firstProblemId = idMatch[0];
  const lines = out.split('\n').filter(Boolean);
  return `${lines.length} lines${firstProblemId ? ', ID captured' : ''}`;
});

await check('search_codebase', async () => {
  const out = await callTool('search_codebase', { query: 'error', limit: 3, target: 'both' });
  return out.trim().split('\n')[0] ?? '(empty)';
});

// Phase 3 — API write
console.log('\nPhase 3: api writes');
await check('annotate_component', async () => {
  if (!firstProblemId) return 'skipped (no problems in session)';
  const out = await callTool('annotate_component', { problem_id: firstProblemId, mode: 'explain' });
  return out.trim().split('\n')[0] ?? '(empty)';
});

// Phase 4 — local CPG (CPU-intensive, runs last to avoid blocking API calls)
console.log('\nPhase 4: local CPG');
await check('init_workspace', async () => {
  const out = await callTool('init_workspace', {
    workspace_path: WORKSPACE,
    batch_size: 3,
    sync_api: true,
  }, 180000); // 3 min — ONNX + Tree-sitter parse can be slow
  const match = out.match(/Files scanned:\s*(\d+)/);
  return match ? `${match[1]} files scanned` : out.trim().split('\n')[0];
});

// Phase 5 — local inference (after init_workspace)
console.log('\nPhase 5: local inference');
const { readdirSync } = await import('fs');
const tsFiles = readdirSync(WORKSPACE)
  .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
  .slice(0, 2)
  .map(f => `${WORKSPACE}/${f}`);

await check('predict_cochanges', async () => {
  if (!tsFiles.length) return 'skipped (no .ts/.js at workspace root)';
  const out = await callTool('predict_cochanges', { changed_files: tsFiles, limit: 3 }, 60000);
  return out.trim().split('\n')[0] ?? '(empty)';
});

await check('analyze_impact', async () => {
  if (!tsFiles.length) return 'skipped (no .ts/.js at workspace root)';
  const out = await callTool('analyze_impact', { changed_files: tsFiles.slice(0, 1), direction: 'forward' }, 60000);
  return out.trim().split('\n')[0] ?? '(empty)';
});

// Phase 6 — context
console.log('\nPhase 6: context');
await check('get_analysis_context', async () => {
  const out = await callTool('get_analysis_context', { problem_limit: 3, scope: 'session' });
  return out.trim().split('\n')[0] ?? '(empty)';
});

await check('assign_git_changes', async () => {
  const out = await callTool('assign_git_changes', {
    changed_files: [`${WORKSPACE}/src/index.ts`],
    include_cochange_predictions: true,
  });
  return out.trim().split('\n')[0] ?? '(empty)';
});

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`  Passed: ${passed}   Failed: ${failed}   Total: ${passed + failed}`);
console.log(failed === 0 ? '  All checks passed ✓' : `  ${failed} check(s) failed`);
console.log('');

child?.kill();
process.exit(failed > 0 ? 1 : 0);
