/**
 * record_finding does not record an open finding twice (SPEC §record_finding).
 * An agent that skipped orientation re-recorded findings that were already
 * open; on a match the existing id comes back instead, unless `force: true`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisAPIClient } from '../../src/api-client';
import { LocalStore } from '../../src/local-store';
import { setAttachment } from '../../src/attachment';
import * as RecordFinding from '../../src/tools/record-finding';
import * as MarkComplete from '../../src/tools/mark-complete';
import { DUPLICATE_JACCARD, sameFindingSummary, workspaceRepo } from '../../src/tools/_findings';
import { installShapeStub, type ShapeStub } from '../helpers/shape-stub';
import { NO_GIT } from '../helpers/no-git';

const apiClient = {} as AnalysisAPIClient;
type Row = { id: string; shape: string; summary: string; content: string };

let store: LocalStore;
let dbPath: string;
let concepts: Row[];
let stub: ShapeStub;

beforeEach(async () => {
  dbPath = join(tmpdir(), `metabob-dup-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  store = new LocalStore(dbPath);
  store.init();
  concepts = [];
  stub = await installShapeStub({
    concept_create_write: (p) => {
      const row = { id: `concept_${concepts.length + 1}`, ...p.conceptData };
      concepts.push(row);
      return { body: { success: true, content: JSON.stringify(row) } };
    },
    conceptSearch: (p) => ({ body: { content: concepts.filter(c => c.shape === p.shape) } }),
    conceptUsage_write: () => ({ body: { success: true, content: JSON.stringify({ id: 'u' }) } }),
  });
});

afterEach(() => {
  store.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  setAttachment(null);
});

function record(files: string[], summary: string, extra: Record<string, unknown> = {}): Promise<string> {
  return RecordFinding.handle(
    RecordFinding.InputSchema.parse({ files, summary, severity: 'HIGH', category: 'correctness', ...extra }),
    apiClient, 's', store,
  );
}

const agf = (out: string) => out.match(/agf_[a-z0-9]+/)![0];
const findings = () => concepts.filter(c => c.shape === 'code_finding');

describe('sameFindingSummary', () => {
  test('normalized text equality: case, punctuation and spacing do not matter', () => {
    expect(sameFindingSummary('Off-by-one in the pager!', 'off by one   in the PAGER')).toBe(true);
  });

  test(`word-set Jaccard at or above ${DUPLICATE_JACCARD} is the same finding`, () => {
    // 5 shared of 6 words: 0.83
    expect(sameFindingSummary('the cache key ignores the tenant id', 'cache key ignores tenant id')).toBe(true);
  });

  test('two findings about one area with a shared vocabulary stay distinct', () => {
    // 4 shared of 8 words: 0.5
    expect(sameFindingSummary('token refresh races the session sweep', 'session sweep logs the raw token')).toBe(false);
  });
});

describe('record_finding duplicate check', () => {
  test('an open local finding on the same file comes back instead of a second one', async () => {
    const first = await record(['src/pager.ts'], 'Off-by-one in the pager');
    const second = await record(['./src/pager.ts', 'src/other.ts'], 'off by one in the pager.');
    expect(second).toStartWith(`Already recorded (open): ${agf(first)} — use mark_complete or add details there.`);
    expect(second).toContain('where:    local store (concept concept_1)');
    expect(second).toContain('force: true');
    expect(store.getAllCachedSeeds()).toHaveLength(1);
    expect(findings()).toHaveLength(1);
  });

  test('the same summary on a different file is a different finding', async () => {
    await record(['src/a.ts'], 'unbounded retry loop');
    const out = await record(['src/b.ts'], 'unbounded retry loop');
    expect(out).toStartWith('Finding recorded');
    expect(findings()).toHaveLength(2);
  });

  test('a distinct summary on the same file is recorded', async () => {
    await record(['src/auth.ts'], 'token refresh races the session sweep');
    const out = await record(['src/auth.ts'], 'session sweep logs the raw token');
    expect(out).toStartWith('Finding recorded');
  });

  test('an open finding another agent recorded is matched through the recall', async () => {
    const repo = workspaceRepo()!;
    concepts.push({
      id: 'concept_remote',
      shape: 'code_finding',
      summary: `[HIGH][security] ${repo.name}: The webhook signature is never verified`,
      content: `repo: ${repo.id}\nrepo_name: ${repo.name}\nfiles: src/hooks.ts, src/server.ts\nstatus: open\nfinding_ids: agf_elsewhere`,
    });
    const out = await record(['src/server.ts'], 'webhook signature is never verified');
    expect(out).toStartWith('Already recorded (open): concept_remote — use mark_complete or add details there.');
    expect(out).toContain('where:    recorded by agents on this codebase');
    expect(store.getAllCachedSeeds()).toHaveLength(0);
    expect(stub.calls('concept_create_write')).toHaveLength(0);
  });

  test('a closed finding is not a duplicate: endorsed locally, or closed by a verdict', async () => {
    const first = await record(['src/x.ts'], 'stale cache after deploy');
    await MarkComplete.handle(MarkComplete.InputSchema.parse({ problem_id: agf(first), action: 'endorse' }), apiClient, 's', store, NO_GIT);
    // The seed is stale and the shared concept carries a finding_verdict now.
    const again = await record(['src/x.ts'], 'stale cache after deploy');
    expect(again).toStartWith('Finding recorded');
  });

  test('force: true records it anyway', async () => {
    await record(['src/f.ts'], 'leaks a file descriptor');
    const out = await record(['src/f.ts'], 'leaks a file descriptor', { force: true });
    expect(out).toStartWith('Finding recorded');
    expect(store.getAllCachedSeeds()).toHaveLength(2);
  });

  test('a finding recorded with a status other than open is not checked', async () => {
    await record(['src/g.ts'], 'documented constraint');
    const out = await record(['src/g.ts'], 'documented constraint', { status: 'fixed' });
    expect(out).toStartWith('Finding recorded');
  });
});
