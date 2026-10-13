/**
 * init_workspace local coverage tests.
 *
 * Covers:
 *  - One call parses the WHOLE workspace locally, whatever batch_size says
 *  - It never calls the api-client: batch_size and sync_api are accepted and
 *    ignored, and the output says no file content left the machine
 *  - Repeat calls are stable
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
let calls: Array<ReturnType<typeof mock>>;

beforeEach(() => {
  const client = {
    get: mock(async () => ({})),
    post: mock(async () => ({})),
    put: mock(async () => ({})),
  };
  calls = Object.values(client);
  mockApiClient = client as unknown as AnalysisAPIClient;
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

function expectNoApiCalls(): void {
  for (const fn of calls) expect(fn).not.toHaveBeenCalled();
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

  expect(result).toContain('Local index: 3/3 files parsed');
  expect(result).toContain('No file content was sent off the machine');
  expect(result).not.toContain('API sync');
  expectNoApiCalls();

  const index = getLocalIndex();
  for (const rel of Object.keys(THREE_FILES)) {
    expect(index.isParsed(join(workspace, rel))).toBe(true);
    expect(index.componentIdsForFile(join(workspace, rel)).length).toBeGreaterThan(0);
  }
});

test('sync_api:true and sync_api:false both stay local — the flag is accepted and ignored', async () => {
  for (const sync_api of [true, false]) {
    const workspace = writeTempWorkspace(THREE_FILES);
    const input = InitWorkspace.InputSchema.parse({ workspace_path: workspace, sync_api });

    const result = await InitWorkspace.handle(input, mockApiClient, SESSION);

    expect(result).toContain('Local index: 3/3 files parsed');
    expect(result).toContain('No file content was sent off the machine');
  }
  expectNoApiCalls();
});

test('repeated calls stay stable', async () => {
  const workspace = writeTempWorkspace(THREE_FILES);
  const input = InitWorkspace.InputSchema.parse({ workspace_path: workspace });

  const first = await InitWorkspace.handle(input, mockApiClient, SESSION);
  const second = await InitWorkspace.handle(input, mockApiClient, SESSION);

  expect(first).toContain('Local index: 3/3 files parsed');
  expect(second).toContain('Local index: 3/3 files parsed');
  expectNoApiCalls();
});

test('the input schema keeps batch_size (default 20, cap 20) and sync_api', () => {
  const parsed = InitWorkspace.InputSchema.parse({});
  expect(parsed.batch_size).toBe(20);
  expect(parsed.sync_api).toBe(true);
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

  expect(index.parsedCount()).toBe(1);
  expect(index.parsedFilePaths()).toEqual([abs]);
  expect(index.coverage()).toEqual({ parsedFiles: 1, totalFiles: 2 });
});
