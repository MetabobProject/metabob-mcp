/**
 * init_workspace parse/sync decoupling tests (Area B).
 *
 * Covers:
 *  - One call parses the WHOLE workspace locally regardless of batch_size
 *  - sync_api:false is a pure full-local-index operation (no API call, no
 *    no-progress loop — repeat calls are stable and never consume batches)
 *  - Output reports honest coverage: local parsed vs API submitted vs total
 *  - LocalIndex coverage accessors (parsedCount / parsedFilePaths / coverage)
 */

import { test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisAPIClient } from '../../src/api-client';

import * as InitWorkspace from '../../src/tools/init-workspace';
import { getLocalIndex, LocalIndex } from '../../src/local-index';

const SESSION = 'test-session';
const tempPaths: string[] = [];

let mockApiClient: AnalysisAPIClient;

beforeEach(() => {
  mockApiClient = {
    get: mock(async () => ({})),
    post: mock(async () => ({})),
    put: mock(async () => ({})),
    submitFiles: mock(async () => ({ status: 'pending', jobId: 'job_123' })),
    getAnalysis: mock(async () => ({ status: 'complete', results: [] })),
    postFeedback: mock(async () => ({})),
    isVesselMode: mock(() => false),
  } as unknown as AnalysisAPIClient;
});

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function writeTempWorkspace(files: Record<string, string>): string {
  const dir = join(tmpdir(), `metabob-init-cov-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), contents, 'utf-8');
  }
  tempPaths.push(dir);
  return dir;
}

const THREE_FILES = {
  'src/a.ts': 'export function alpha() { return 1; }\n',
  'src/b.ts': "import { alpha } from './a.js';\nexport function beta() { return alpha() + 1; }\n",
  'src/c.ts': 'export function gamma() { return 3; }\n',
};

test('one call parses the whole workspace locally even with batch_size:1', async () => {
  const workspace = writeTempWorkspace(THREE_FILES);
  const input = InitWorkspace.InputSchema.parse({
    workspace_path: workspace,
    batch_size: 1,
  });

  const result = await InitWorkspace.handle(input, mockApiClient, SESSION);

  // Full local coverage in ONE call — parsing is decoupled from the API batch.
  expect(result).toContain('Local index: 3/3 files parsed');
  // API submission stays incremental at batch_size.
  expect(result).toContain('API sync: 1/3 files submitted');
  expect(mockApiClient.submitFiles).toHaveBeenCalledTimes(1);

  const index = getLocalIndex();
  for (const rel of Object.keys(THREE_FILES)) {
    expect(index.isParsed(join(workspace, rel))).toBe(true);
    expect(index.componentIdsForFile(join(workspace, rel)).length).toBeGreaterThan(0);
  }
});

test('sync_api:false is a pure local-index operation — no API call, no batch consumed', async () => {
  const workspace = writeTempWorkspace(THREE_FILES);
  const input = InitWorkspace.InputSchema.parse({
    workspace_path: workspace,
    sync_api: false,
  });

  const result = await InitWorkspace.handle(input, mockApiClient, SESSION);

  expect(result).toContain('Local index: 3/3 files parsed');
  expect(result).toContain('API sync: 0/3 files submitted');
  expect(result).toContain('sync_api:false');
  expect(mockApiClient.submitFiles).not.toHaveBeenCalled();
});

test('repeated sync_api:false calls stay stable (no re-pick loop) and later sync makes progress', async () => {
  const workspace = writeTempWorkspace(THREE_FILES);

  const localOnly = InitWorkspace.InputSchema.parse({ workspace_path: workspace, sync_api: false });
  const first = await InitWorkspace.handle(localOnly, mockApiClient, SESSION);
  const second = await InitWorkspace.handle(localOnly, mockApiClient, SESSION);

  expect(first).toContain('Local index: 3/3 files parsed');
  expect(second).toContain('Local index: 3/3 files parsed');
  expect(mockApiClient.submitFiles).not.toHaveBeenCalled();

  // Turning sync on afterwards submits distinct batches call over call.
  const syncing = InitWorkspace.InputSchema.parse({ workspace_path: workspace, batch_size: 2 });
  const third = await InitWorkspace.handle(syncing, mockApiClient, SESSION);
  expect(third).toContain('API sync: 2/3 files submitted');

  const fourth = await InitWorkspace.handle(syncing, mockApiClient, SESSION);
  expect(fourth).toContain('API sync: 3/3 files submitted');

  // Fully synced — a further call submits nothing new.
  const fifth = await InitWorkspace.handle(syncing, mockApiClient, SESSION);
  expect(fifth).toContain('all 3 files already submitted');
  expect(mockApiClient.submitFiles).toHaveBeenCalledTimes(2);
});

test('default batch_size is 20 (schema cap)', () => {
  const parsed = InitWorkspace.InputSchema.parse({});
  expect(parsed.batch_size).toBe(20);
  expect(() => InitWorkspace.InputSchema.parse({ batch_size: 21 })).toThrow();
});

test('LocalIndex exposes additive coverage accessors', async () => {
  const workspace = writeTempWorkspace({
    'src/x.ts': 'export function ex() { return 1; }\n',
    'src/y.ts': 'export function why() { return 2; }\n',
  });

  const index = new LocalIndex();
  await index.init();
  await index.setWorkspace(workspace, 2);

  expect(index.parsedCount()).toBe(0);
  expect(index.parsedFilePaths()).toEqual([]);

  const abs = join(workspace, 'src/x.ts');
  await index.predictor.addFile(abs, 'export function ex() { return 1; }\n');
  index.markParsed(abs);
  index.markSubmitted([abs]);

  expect(index.parsedCount()).toBe(1);
  expect(index.parsedFilePaths()).toEqual([abs]);
  expect(index.coverage()).toEqual({ parsedFiles: 1, submittedFiles: 1, totalFiles: 2 });
});
