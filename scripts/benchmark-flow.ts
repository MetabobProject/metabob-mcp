#!/usr/bin/env bun
/**
 * End-to-end benchmark: session creation → file submit → poll → analysis fetch
 * Usage: METABOB_API_KEY=<key> bun run scripts/benchmark-flow.ts
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

const BASE_URL = process.env.ANALYSIS_API_URL ?? 'https://ide.metabob.com';
const API_KEY  = process.env.METABOB_API_KEY;

if (!API_KEY) {
  console.error('METABOB_API_KEY is required');
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function mark(label: string, startMs: number) {
  const ms = Date.now() - startMs;
  console.log(`  ✓ ${label.padEnd(32)} ${ms}ms`);
  return ms;
}

async function checkResponse(res: Response, step: string): Promise<unknown> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${step} failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

// ── Step 1: Create session ─────────────────────────────────────────────────

console.log('\n── Step 1: Create session (POST /session) ──────────────────');
let t = Date.now();

const sessionRes = await fetch(`${BASE_URL}/session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ apiKey: API_KEY, project: 'default' }),
  signal: AbortSignal.timeout(10_000),
});
const sessionData = await checkResponse(sessionRes, 'POST /session') as { session: string };
const sessionToken = sessionData.session;

mark('POST /session', t);
console.log(`  token: ${sessionToken.slice(0, 12)}…`);

const authHeaders = {
  'Authorization': `Bearer ${sessionToken}`,
  'Content-Type': 'application/json',
};

// ── Step 2: Health check ───────────────────────────────────────────────────

console.log('\n── Step 2: Health check (GET /health) ──────────────────────');
t = Date.now();

const healthRes = await fetch(`${BASE_URL}/health`, {
  headers: { 'Authorization': `Bearer ${sessionToken}` },
  signal: AbortSignal.timeout(5_000),
});
const healthData = await checkResponse(healthRes, 'GET /health');
mark('GET /health', t);
console.log(`  status: ${(healthData as any).status}`);

// ── Step 3: GET /session — verify session is live ─────────────────────────

console.log('\n── Step 3: Verify session (GET /session) ───────────────────');
t = Date.now();

const getSessionRes = await fetch(`${BASE_URL}/session`, {
  headers: { 'Authorization': `Bearer ${sessionToken}` },
  signal: AbortSignal.timeout(5_000),
});
const getSessionData = await checkResponse(getSessionRes, 'GET /session');
mark('GET /session', t);
console.log(`  session: ${JSON.stringify(getSessionData).slice(0, 120)}`);

// ── Step 4: Submit files (POST /v2/submit, multipart) ─────────────────────

console.log('\n── Step 4: Submit files (POST /v2/submit) ──────────────────');
t = Date.now();

// Use a small set of real source files as the test payload
const srcDir = join(import.meta.dir, '..', 'src');
const testFiles = [
  'api-client.ts',
  'session-manager.ts',
  'rate-limiter.ts',
  'circuit-breaker.ts',
  'local-index.ts',
];

const form = new FormData();
let totalBytes = 0;
const filesSubmitted: string[] = [];
for (const name of testFiles) {
  try {
    const content = await readFile(join(srcDir, name), 'utf-8');
    form.append('files', new Blob([content], { type: 'text/plain' }), name);
    totalBytes += content.length;
    filesSubmitted.push(name);
  } catch {
    // skip if file doesn't exist
  }
}

console.log(`  Submitting ${filesSubmitted.length} files (${(totalBytes / 1024).toFixed(1)} KB)`);

const submitRes = await fetch(`${BASE_URL}/v2/submit`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${sessionToken}` },
  body: form,
  signal: AbortSignal.timeout(30_000),
});
const submitData = await checkResponse(submitRes, 'POST /v2/submit') as {
  jobId?: string | null;
  status: string;
  results?: unknown[] | null;
};

mark('POST /v2/submit', t);
console.log(`  status: ${submitData.status}   jobId: ${submitData.jobId ?? 'none'}`);
if (submitData.results?.length) {
  console.log(`  inline results: ${submitData.results.length}`);
}

// ── Step 5: Poll job until complete (if async) ─────────────────────────────

let jobState = submitData.status;
if (submitData.jobId && submitData.status !== 'complete') {
  const jobId = submitData.jobId;
  console.log(`\n── Step 5: Poll job ${jobId} ─────────────────────────────`);

  const pollStart = Date.now();
  const TIMEOUT = 120_000;
  const INTERVAL = 2_000;

  while (Date.now() - pollStart < TIMEOUT) {
    const elapsed = Date.now() - pollStart;
    process.stdout.write(`\r  polling… ${(elapsed / 1000).toFixed(0)}s`);

    const pollRes = await fetch(`${BASE_URL}/jobs/${jobId}/status`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    const pollData = await checkResponse(pollRes, 'GET /jobs/.../status') as { state: string; errorMessage?: string };
    jobState = pollData.state;

    if (pollData.state === 'complete' || pollData.state === 'failed') {
      process.stdout.write('\n');
      mark(`job ${jobState}`, pollStart);
      if (pollData.errorMessage) console.log(`  error: ${pollData.errorMessage}`);
      break;
    }

    await new Promise(r => setTimeout(r, INTERVAL));
  }

  if (jobState !== 'complete' && jobState !== 'failed') {
    console.log(`\n  ⚠ job still ${jobState} after ${TIMEOUT / 1000}s — continuing anyway`);
  }
} else {
  console.log('\n── Step 5: (sync response — no polling needed) ─────────────');
}

// ── Step 6: Fetch analysis results ────────────────────────────────────────

console.log('\n── Step 6: Fetch analysis (GET /analysis) ──────────────────');
t = Date.now();

const analysisRes = await fetch(`${BASE_URL}/analysis`, {
  headers: { 'Authorization': `Bearer ${sessionToken}` },
  signal: AbortSignal.timeout(10_000),
});
const analysisData = await checkResponse(analysisRes, 'GET /analysis') as {
  status: string;
  jobId?: string | null;
  results?: Array<{
    id: string; path: string; category: string;
    startLine: number; severity: string; summary: string;
  }> | null;
};

mark('GET /analysis', t);
console.log(`  status: ${analysisData.status}   results: ${analysisData.results?.length ?? 0}`);

if (analysisData.results?.length) {
  const bySeverity: Record<string, number> = {};
  for (const r of analysisData.results) {
    bySeverity[r.severity ?? 'LOW'] = (bySeverity[r.severity ?? 'LOW'] ?? 0) + 1;
  }
  console.log(`  by severity: ${Object.entries(bySeverity).map(([s, n]) => `${s}:${n}`).join('  ')}`);
  console.log('\n  Sample problems:');
  for (const r of analysisData.results.slice(0, 3)) {
    console.log(`    [${r.severity}] ${r.category}  ${r.path}:${r.startLine}`);
    console.log(`      ${r.summary.slice(0, 100)}`);
    console.log(`      id: ${r.id}`);
  }
}

// ── Step 7: Cleanup — delete session ─────────────────────────────────────

console.log('\n── Step 7: Delete session (DELETE /session) ────────────────');
t = Date.now();

const deleteRes = await fetch(`${BASE_URL}/session`, {
  method: 'DELETE',
  headers: { 'Authorization': `Bearer ${sessionToken}` },
  signal: AbortSignal.timeout(5_000),
});
await checkResponse(deleteRes, 'DELETE /session');
mark('DELETE /session', t);

console.log('\n── Summary ──────────────────────────────────────────────────');
console.log(`  Files submitted: ${filesSubmitted.join(', ')}`);
console.log(`  Analysis status: ${analysisData.status}`);
console.log(`  Problems found:  ${analysisData.results?.length ?? 0}`);
console.log();
