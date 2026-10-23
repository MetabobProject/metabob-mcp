/**
 * The CPG's native modules load on first use (SPEC §init_workspace): one that cannot load makes the local code
 * tools answer with a named cause, while the ledger tools run as usual and nothing fails at startup.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalIndexUnavailable, getLocalIndex, setCpgImportForTests } from '../../src/local-index';
import * as InitWorkspace from '../../src/tools/init-workspace';
import * as RecordFinding from '../../src/tools/record-finding';
import * as GetProblems from '../../src/tools/get-problems';
import { makeTempStore } from '../helpers/temp-store';

afterEach(() => setCpgImportForTests(null));

const failing = () => Promise.reject(new Error("Cannot find module 'tree-sitter'\nRequire stack: …"));

describe('the CPG loads lazily', () => {
  test('a native module that cannot load is named, once, and kept for later calls', async () => {
    let imports = 0;
    setCpgImportForTests(() => { imports++; return failing(); });
    const index = getLocalIndex();
    expect(index.isReady()).toBe(false);
    expect(index.stats().componentsIndexed).toBe(0);
    const first = await index.init().catch((e: unknown) => e);
    expect(first).toBeInstanceOf(LocalIndexUnavailable);
    expect((first as LocalIndexUnavailable).module).toBe('tree-sitter');
    await index.init().catch(() => {});
    expect(imports).toBe(1);
  });

  test('init_workspace answers with the cause; record_finding and get_problems work', async () => {
    setCpgImportForTests(failing);
    const ws = mkdtempSync(join(tmpdir(), 'lazy-ws-'));
    writeFileSync(join(ws, 'a.ts'), 'export const a = 1;\n');
    const out = await InitWorkspace.handle(InitWorkspace.InputSchema.parse({ workspace_path: ws }), {} as never);
    expect(out).toMatch(/^local_index_unavailable\(tree-sitter: Cannot find module 'tree-sitter'\): the local code tools cannot run here; the ledger, memory and substrate tools are unaffected$/);
    // The other local tools name the same cause rather than asking for init_workspace again.
    const AnalyzeImpact = await import('../../src/tools/analyze-impact');
    expect(await AnalyzeImpact.handle(AnalyzeImpact.InputSchema.parse({ changed_files: ['a.ts'] }), {} as never)).toBe(out);
    const { store } = makeTempStore('lazy-');
    const recorded = await RecordFinding.handle(RecordFinding.InputSchema.parse({ files: ['a.ts'], summary: 'still recorded', severity: 'LOW', category: 'test' }), {} as never, 's', store);
    expect(recorded).toContain('Finding recorded');
    expect(await GetProblems.handle(GetProblems.InputSchema.parse({}), {} as never, 's', store)).toContain('still recorded');
  });

  test('with the real module, the index initialises on first use', async () => {
    const index = getLocalIndex();
    await index.init();
    expect(index.isReady()).toBe(true);
  });
});
