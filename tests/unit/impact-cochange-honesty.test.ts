/**
 * Output-honesty tests for analyze_impact and predict_cochanges (Area D).
 *
 * - analyze_impact defaults to direction:'backward'; forward edges are reported
 *   in a separate "Dependencies (this file imports — NOT impacted by this
 *   change)" section and never as "Direct dependents"; risk is computed from
 *   dependents only.
 * - predict_cochanges labels the GCN section as a name-similarity ranking (not
 *   structural evidence) without percentage "confidence" figures, and caveats
 *   git-history mining.
 * - Both tools report unindexed files honestly, with index coverage.
 */

import { test, expect, mock, beforeAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisAPIClient } from '../../src/api-client';
import { getLocalIndex } from '../../src/local-index.js';
import * as AnalyzeImpact from '../../src/tools/analyze-impact';
import * as PredictCochanges from '../../src/tools/predict-cochanges';

const SESSION = 'test-session';

const mockApiClient = {
  get: mock(async () => ({})),
  post: mock(async () => ({})),
  put: mock(async () => ({})),
  isVesselMode: mock(() => false),
} as unknown as AnalysisAPIClient;

let ws: string;

beforeAll(async () => {
  ws = mkdtempSync(join(tmpdir(), 'impact-honesty-test-'));
  const files: Record<string, string> = {
    'src/core.ts': 'export function coreThing() { return 1; }\n',
    'src/user.ts':
      "import { coreThing } from './core.js';\nexport function useCoreThing() { return coreThing(); }\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(ws, rel, '..'), { recursive: true });
    writeFileSync(join(ws, rel), content, 'utf-8');
  }

  const index = getLocalIndex();
  await index.init();
  await index.setWorkspace(ws, Object.keys(files).length);
  for (const rel of Object.keys(files)) {
    const abs = join(ws, rel);
    const content = readFileSync(abs, 'utf-8');
    await index.predictor.addFile(abs, content);
    index.recordImports(abs, content);
    index.markParsed(abs);
  }
});

process.on('exit', () => {
  if (ws) rmSync(ws, { recursive: true, force: true });
});

// ===== analyze_impact =====

test('analyze_impact: direction defaults to backward', () => {
  const result = AnalyzeImpact.InputSchema.parse({ changed_files: ['src/core.ts'] });
  expect(result.direction).toBe('backward');
});

test('analyze_impact backward: importers appear as dependents, no dependencies section', async () => {
  const input = AnalyzeImpact.InputSchema.parse({ changed_files: [join(ws, 'src/core.ts')] });
  const result = await AnalyzeImpact.handle(input, mockApiClient, SESSION);
  expect(result).toContain('user.ts');
  expect(result).toContain('risk is computed from dependents only');
  expect(result).not.toContain('Dependencies (this file imports');
});

test('analyze_impact both: imports are labeled Dependencies, never Direct dependents; risk from dependents only', async () => {
  const input = AnalyzeImpact.InputSchema.parse({
    changed_files: [join(ws, 'src/user.ts')],
    direction: 'both',
  });
  const result = await AnalyzeImpact.handle(input, mockApiClient, SESSION);
  // user.ts imports core.ts — core is a dependency, not a dependent.
  expect(result).toContain('Dependencies (this file imports — NOT impacted by this change)');
  expect(result).toContain('core.ts');
  expect(result).not.toContain('Direct dependents');
  // Nothing depends on user.ts, so dependents (and therefore risk input) is 0.
  expect(result).toContain('Dependents impacted: 0');
  expect(result).toContain('Overall risk: LOW');
  expect(result).toContain('No dependents found');
});

test('analyze_impact forward: dependencies only, no dependents sections', async () => {
  const input = AnalyzeImpact.InputSchema.parse({
    changed_files: [join(ws, 'src/user.ts')],
    direction: 'forward',
  });
  const result = await AnalyzeImpact.handle(input, mockApiClient, SESSION);
  expect(result).toContain('Dependencies (this file imports — NOT impacted by this change)');
  expect(result).not.toContain('Direct dependents');
  expect(result).not.toContain('No dependents found');
});

test('analyze_impact: unindexed file returns honest not-indexed error with coverage', async () => {
  const input = AnalyzeImpact.InputSchema.parse({ changed_files: [join(ws, 'src/ghost.ts')] });
  const result = await AnalyzeImpact.handle(input, mockApiClient, SESSION);
  expect(result).toContain('not in the local index');
  expect(result).toContain('Index coverage:');
  expect(result).toContain('not yet indexed — run init_workspace');
  expect(result).not.toContain('Run init_workspace again after saving');
});

// ===== predict_cochanges =====

test('predict_cochanges: GCN section is labeled name-similarity without percentage confidences', async () => {
  const input = PredictCochanges.InputSchema.parse({
    changed_files: [join(ws, 'src/core.ts')],
    confidence_threshold: 0,
  });
  const result = await PredictCochanges.handle(input, mockApiClient, SESSION);
  expect(result).toContain('Name-similarity ranking (experimental; NOT structural evidence');
  expect(result).not.toContain('From name similarity (embedded GCN)');
  // The name-similarity section must not print scores as percentages. The
  // git-history section is empty here (tmp dir is not a git repo), so any
  // "Confidence: NN%" line would come from the GCN section.
  expect(result).not.toMatch(/Confidence:\s*\d/);
  expect(result).toContain('name-similarity');
});

test('predict_cochanges: unindexed file returns honest not-indexed error with coverage', async () => {
  const input = PredictCochanges.InputSchema.parse({
    changed_files: [join(ws, 'src/ghost.ts')],
  });
  const result = await PredictCochanges.handle(input, mockApiClient, SESSION);
  expect(result).toContain('not in the local index');
  expect(result).toContain('Index coverage:');
  expect(result).toContain('not yet indexed — run init_workspace');
  expect(result).not.toContain('can likely be changed independently');
});
