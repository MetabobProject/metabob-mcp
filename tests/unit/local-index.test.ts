import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalIndex } from '../../src/local-index.js';

const tempDirs: string[] = [];

function makeWorkspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-index-test-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content, 'utf-8');
  }
  return dir;
}

process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function indexWorkspace(index: LocalIndex, ws: string, files: string[]): Promise<void> {
  await index.setWorkspace(ws, files.length);
  for (const rel of files) {
    const abs = join(ws, rel);
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(abs, 'utf-8');
    await index.predictor.addFile(abs, content);
    index.recordImports(abs, content);
    index.markParsed(abs);
  }
}

test('switching workspaces drops the previous graph — no cross-repo matches', async () => {
  const wsA = makeWorkspace({
    'src/config.ts': 'export function loadConfig() { return 1; }\n',
  });
  const wsB = makeWorkspace({
    'src/other.ts': 'export function other() { return 2; }\n',
  });

  const index = new LocalIndex();
  await index.init();
  await indexWorkspace(index, wsA, ['src/config.ts']);
  expect(index.componentIdsForFile(join(wsA, 'src/config.ts')).length).toBeGreaterThan(0);

  await indexWorkspace(index, wsB, ['src/other.ts']);

  // Workspace A's file must no longer resolve — and crucially, a same-suffix
  // path in workspace B must not match workspace A's leftover components.
  expect(index.componentIdsForFile(join(wsA, 'src/config.ts'))).toEqual([]);
  expect(index.componentIdsForFile(join(wsB, 'src/config.ts'))).toEqual([]);
});

test('relative queries resolve against the active workspace only', async () => {
  const ws = makeWorkspace({
    'src/service.ts': 'export function run() { return 1; }\n',
  });
  const index = new LocalIndex();
  await index.init();
  await indexWorkspace(index, ws, ['src/service.ts']);

  const viaRelative = index.componentIdsForFile('src/service.ts');
  const viaAbsolute = index.componentIdsForFile(join(ws, 'src/service.ts'));
  expect(viaRelative).toEqual(viaAbsolute);
  expect(viaAbsolute.length).toBeGreaterThan(0);
});

test('const-only files fall back to their file-level CPG node', async () => {
  const ws = makeWorkspace({
    'src/schema.ts': "export const FIELDS = ['a', 'b'] as const;\nexport interface Wire { a: string }\n",
  });
  const index = new LocalIndex();
  await index.init();
  await indexWorkspace(index, ws, ['src/schema.ts']);

  const ids = index.componentIdsForFile(join(ws, 'src/schema.ts'));
  expect(ids.length).toBeGreaterThan(0);
  expect(ids.every(id => /::file-\d+$/.test(id))).toBe(true);
});

test('fileImportGraph resolves relative .js specifiers to indexed .ts files', async () => {
  const ws = makeWorkspace({
    'src/config.ts': 'export const config = { port: 1 };\n',
    'src/util/logger.ts': "import { config } from '../config.js';\nexport function log() { return config.port; }\n",
  });
  const index = new LocalIndex();
  await index.init();
  await indexWorkspace(index, ws, ['src/config.ts', 'src/util/logger.ts']);

  const graph = index.fileImportGraph();
  const loggerImports = graph.get(join(ws, 'src/util/logger.ts'));
  expect(loggerImports).toBeDefined();
  expect([...(loggerImports ?? [])]).toContain(join(ws, 'src/config.ts'));
});
