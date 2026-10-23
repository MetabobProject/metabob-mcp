/**
 * `attach --check` names the runtime it ran under and where the MCP server itself runs (SPEC §runtime): in the same
 * runtime when it has SQLite, never a fixed "under bun".
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachCheck, renderAttachCheck } from '../../src/attach-check';

describe('attach --check runtime line', () => {
  test('a runtime with SQLite runs the MCP server in-process', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mcp-attach-rt-'));
    const report = await attachCheck({ HOME: home, USERPROFILE: home, SUBSTRATE_CONFIG_PATH: join(home, 'none.json') });
    expect(report.attached).toBe(false);
    expect(report.serverRuntime).toBe('the MCP server runs under it too');
    const head = renderAttachCheck(report).split('\n')[0]!;
    expect(head).toBe(`metabob-mcp attach --check  (runtime: bun ${Bun.version}; the MCP server runs under it too)`);
  });
});
