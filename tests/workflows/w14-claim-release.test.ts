/**
 * A session's claims end with it (SPEC §claim_finding): a server whose client closes stdin releases the claims it
 * took through claim_finding before it exits, so a stopped agent does not hold a task until its claim lapses.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FakeSubstrate } from './harness/fake-substrate';
import { McpServer, cleanupTempDirs, makeWorkspace } from './harness/mcp-client';

let fake: FakeSubstrate;
beforeAll(async () => { fake = await FakeSubstrate.start(); });
afterAll(async () => { await fake?.stop(); cleanupTempDirs(); });

// Concept writes the fake received, as the content each one carried.
const writes = () => fake.state.concepts.map((c) => String((c as { content?: unknown }).content ?? ''));

describe('claims at shutdown', () => {
  test('stdin closed: the claim this session took is withdrawn before the server exits', async () => {
    const server = await McpServer.start({ workspace: makeWorkspace('claim-release'), env: fake.env() });
    let id = '';
    try {
      const rec = await server.call('record_finding', { files: ['src/index.ts'], summary: 'a task to hold', severity: 'LOW', category: 'task' });
      id = /\b(agf_\w+)/.exec(rec.text)?.[1] ?? '';
      expect(id).not.toBe('');
      const claimed = await server.call('claim_finding', { problem_id: id, minutes: 30 });
      expect(claimed.text).toMatch(/Claimed finding|not settled/);
    } finally {
      await server.stop();
    }
    const after = writes();
    expect(after.some((w) => w.includes('claim withdrawn') && w.includes(id))).toBe(true);
    expect(server.stderr).toContain("Released this session's claims at shutdown");
  });
});
