/**
 * Unit tests for the agent-side findings plane:
 *  - record_finding (LocalStore write path + non-fatal concept-db push)
 *  - mark_complete on agf_* ids (endorse/discard via LocalStore)
 *  - get_problems "Findings recorded by agents on this codebase" rendering
 */

import { test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisAPIClient } from '../../src/api-client';
import { LocalStore } from '../../src/local-store';

import * as RecordFinding from '../../src/tools/record-finding';
import * as MarkComplete from '../../src/tools/mark-complete';
import * as GetProblems from '../../src/tools/get-problems';
import { workspaceRepoName } from '../../src/tools/_findings';
import * as AnnotateComponent from '../../src/tools/annotate-component';
import { setResolverIdentity } from '../../src/resolver-identity';
import { setAttachment } from '../../src/attachment';
import { installShapeStub, type ShapeHandler } from '../helpers/shape-stub';

const SESSION = 'test-session';

let mockApiClient: AnalysisAPIClient;
let localStore: LocalStore;
let dbPath: string;
// Author resolution reads these; a developer machine with a real key set would
// otherwise make the "no identity → no recorded_by line" test pass vacuously.
let savedVesselId: string | undefined;
let savedApiKey: string | undefined;

/** concept-db's write answer: the result row as JSON in `content`. */
const written = (row: Record<string, unknown>) => ({ body: { success: true, content: JSON.stringify(row) } });

/** concept-db behind the attachment, answering these shapes (discovery's 404 for any other). */
function conceptDb(handlers: Record<string, ShapeHandler>) {
  return installShapeStub(handlers);
}

/** Discovery's answer when it cannot reach concept-db: every shape is producer_unreachable. */
const unreachable: ShapeHandler = (p) => ({ status: 502, body: { error: 'forward_failed', shape: p.type, detail: 'Unable to connect' } });

beforeEach(() => {
  mockApiClient = {
    get: mock(async () => ({})),
    post: mock(async () => ({})),
  } as unknown as AnalysisAPIClient;

  dbPath = join(tmpdir(), `metabob-finding-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  localStore = new LocalStore(dbPath);
  localStore.init();


  savedVesselId = process.env.VESSEL_ID;
  savedApiKey = process.env.METABOB_API_KEY;
  delete process.env.VESSEL_ID;
  delete process.env.METABOB_API_KEY;
  // resolver-identity is a module-global holder — clear it so an identity set
  // by another test (or by import-time boot) cannot leak into these.
  setResolverIdentity({ vesselId: undefined });
});

afterEach(() => {
  localStore.close();
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(dbPath + suffix, { force: true });
  }
  if (savedVesselId === undefined) delete process.env.VESSEL_ID;
  else process.env.VESSEL_ID = savedVesselId;
  if (savedApiKey === undefined) delete process.env.METABOB_API_KEY;
  else process.env.METABOB_API_KEY = savedApiKey;
  setResolverIdentity({ vesselId: undefined });
  setAttachment(null);
});

// ===== schema =====

test('record_finding: schema requires files, summary, severity, category', () => {
  expect(() => RecordFinding.InputSchema.parse({})).toThrow();
  expect(() => RecordFinding.InputSchema.parse({ files: [], summary: 's', severity: 'HIGH', category: 'security' })).toThrow();
  expect(() => RecordFinding.InputSchema.parse({ files: ['a.ts'], summary: 's', severity: 'EXTREME', category: 'security' })).toThrow();
});

test('record_finding: schema defaults status to open', () => {
  const result = RecordFinding.InputSchema.parse({
    files: ['src/db/client.ts'], summary: 'SQL injection', severity: 'HIGH', category: 'security',
  });
  expect(result.status).toBe('open');
});

// ===== localStore write path =====

test('record_finding: writes a seed per file that get_problems cache serves', async () => {
  const input = RecordFinding.InputSchema.parse({
    files: ['src/db/client.ts', 'src/db/pool.ts'],
    summary: 'SQL injection via string interpolation',
    severity: 'HIGH',
    category: 'security',
    line_start: 12,
    line_end: 18,
  });
  const output = await RecordFinding.handle(input, mockApiClient, SESSION, localStore);

  expect(output).toContain('agf_');
  expect(output).toContain('cached locally');
  expect(output).toContain('concept-db not configured');

  const seeds = localStore.getCachedSeeds('src/db/client.ts');
  expect(seeds.length).toBe(1);
  expect(seeds[0]!.id.startsWith('agf_')).toBe(true);
  expect(seeds[0]!.brief).toBe('SQL injection via string interpolation');
  expect(seeds[0]!.severity).toBe('HIGH');
  expect(seeds[0]!.category).toBe('security');
  expect(seeds[0]!.line_start).toBe(12);
  expect(seeds[0]!.line_end).toBe(18);
  expect(seeds[0]!.confidence).toBe(1);

  expect(localStore.getCachedSeeds('src/db/pool.ts').length).toBe(1);

  // The seed now surfaces through get_problems' local cache branch
  const problems = await GetProblems.handle(
    GetProblems.InputSchema.parse({ file_path: 'src/db/client.ts' }),
    mockApiClient, SESSION, localStore,
  );
  expect(problems).toContain('SQL injection via string interpolation');
  expect(problems).toContain('[HIGH] security');
});

test('record_finding: concept-db unreachable is non-fatal and reported', async () => {
  await conceptDb({ concept_create_write: unreachable }); // discovery cannot reach concept-db
  const input = RecordFinding.InputSchema.parse({
    files: ['src/a.ts'], summary: 'off-by-one', severity: 'LOW', category: 'correctness',
  });
  const output = await RecordFinding.handle(input, mockApiClient, SESSION, localStore);
  expect(output).toContain('concept-db unreachable');
  expect(output).toContain('recorded locally only');
  expect(localStore.getCachedSeeds('src/a.ts').length).toBe(1);
});

// A read-scoped key must never report a shared write (SPEC §read-only-key).
test('record_finding: with a read-scoped key the finding stays local and is reported as not shared', async () => {
  const stub = await installShapeStub({ concept_create_write: () => written({ id: 'concept:never' }) }, { scopes: ['read'] });
  const input = RecordFinding.InputSchema.parse({ files: ['src/a.ts'], summary: 'off by one', severity: 'LOW', category: 'correctness' });
  const output = await RecordFinding.handle(input, mockApiClient, SESSION, localStore);
  expect(output).toContain('not shared (key_read_only: this key has scopes [read]; the concept_create_write write was not sent)');
  expect(output).toContain('other agents will not see it');
  expect(output).not.toContain('shared org-wide');
  expect(stub.calls('concept_create_write')).toHaveLength(0);
  expect(localStore.getCachedSeeds('src/a.ts').length).toBeGreaterThan(0);
});

test('record_finding: pushes a code_finding concept when concept-db is up', async () => {
  let received: Record<string, unknown> | null = null;
  await conceptDb({
    concept_create_write: (p) => {
      received = p.conceptData;
      return written({ id: 'concept:cf_test1', shape: 'code_finding' });
    },
  });

  const input = RecordFinding.InputSchema.parse({
    files: ['src/db/client.ts'], summary: 'SQL injection', severity: 'HIGH', category: 'security',
    details: 'user input concatenated into query',
  });
  const output = await RecordFinding.handle(input, mockApiClient, SESSION, localStore);

  expect(output).toContain('shared org-wide via concept-db');
  expect(output).toContain('cf_test1');
  expect(received).not.toBeNull();
  expect(received!['shape']).toBe('code_finding');
  expect(received!['source_type']).toBe('metabob_annotation');
  expect(String(received!['summary'])).toContain('[HIGH][security]');
  expect(String(received!['content'])).toContain('src/db/client.ts');
  expect(String(received!['content'])).toContain('user input concatenated into query');
});

test('record_finding: stashes the minted concept id on the seed refs', async () => {
  await conceptDb({ concept_create_write: () => written({ id: 'concept:cf_refs1', shape: 'code_finding' }) });

  const output = await RecordFinding.handle(
    RecordFinding.InputSchema.parse({
      files: ['src/db/client.ts'], summary: 'SQL injection', severity: 'HIGH', category: 'security',
    }),
    mockApiClient, SESSION, localStore,
  );
  const id = output.match(/agf_[a-z0-9]+/)![0];
  expect(localStore.getSeedById(id)?.refs_json).toContain('concept:cf_refs1');
});

// ===== mark_complete on agf_* ids =====

test('mark_complete: endorse records a success usage on the finding concept', async () => {
  const stub = await conceptDb({
    concept_create_write: () => written({ id: 'concept:cf_usage1', shape: 'code_finding' }),
    conceptUsage_write: () => written({ id: 'usage_x', outcome: 'success' }),
  });

  const recordOut = await RecordFinding.handle(
    RecordFinding.InputSchema.parse({ files: ['src/x.ts'], summary: 'off by one', severity: 'MEDIUM', category: 'correctness' }),
    mockApiClient, SESSION, localStore,
  );
  const id = recordOut.match(/agf_[a-z0-9]+/)![0];

  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: id, action: 'endorse' }),
    mockApiClient, SESSION, localStore,
  );

  const usageHits = stub.calls('conceptUsage_write').map((p) => p.usageData);
  expect(usageHits.length).toBe(1);
  expect(usageHits[0]!['concept_id']).toBe('cf_usage1');
  expect(usageHits[0]!['outcome']).toBe('success');
  expect(String(usageHits[0]!['trace_id'])).not.toMatch(/^\{\{/);
  expect(out).toContain('relevance: recorded success on concept cf_usage1');
});

test('mark_complete: discard records a failure usage on the finding concept', async () => {
  const stub = await conceptDb({
    concept_create_write: () => written({ id: 'concept:cf_usage2', shape: 'code_finding' }),
    conceptUsage_write: () => written({ id: 'usage_y', outcome: 'failure' }),
  });

  const recordOut = await RecordFinding.handle(
    RecordFinding.InputSchema.parse({ files: ['src/y.ts'], summary: 'false alarm', severity: 'LOW', category: 'noise' }),
    mockApiClient, SESSION, localStore,
  );
  const id = recordOut.match(/agf_[a-z0-9]+/)![0];

  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: id, action: 'discard' }),
    mockApiClient, SESSION, localStore,
  );

  const usageHits = stub.calls('conceptUsage_write').map((p) => p.usageData);
  expect(usageHits.length).toBe(1);
  expect(usageHits[0]!['concept_id']).toBe('cf_usage2');
  expect(usageHits[0]!['outcome']).toBe('failure');
  expect(out).toContain('relevance: recorded failure on concept cf_usage2');
});

test('mark_complete: endorse retires an agf_* finding from the cache', async () => {
  const recordOut = await RecordFinding.handle(
    RecordFinding.InputSchema.parse({ files: ['src/b.ts'], summary: 'leak', severity: 'MEDIUM', category: 'resources' }),
    mockApiClient, SESSION, localStore,
  );
  const id = recordOut.match(/agf_[a-z0-9]+/)![0];

  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: id, action: 'endorse' }),
    mockApiClient, SESSION, localStore,
  );
  expect(out).toContain('endorsed');
  expect(localStore.getCachedSeeds('src/b.ts').length).toBe(0);
  // seed still exists (stale), not deleted
  expect(localStore.getSeedById(id)?.stale).toBe(true);
});

test('mark_complete: discard deletes an agf_* finding', async () => {
  const recordOut = await RecordFinding.handle(
    RecordFinding.InputSchema.parse({ files: ['src/c.ts'], summary: 'not a bug', severity: 'INFO', category: 'noise' }),
    mockApiClient, SESSION, localStore,
  );
  const id = recordOut.match(/agf_[a-z0-9]+/)![0];

  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: id, action: 'discard' }),
    mockApiClient, SESSION, localStore,
  );
  expect(out).toContain('discarded');
  expect(localStore.getSeedById(id)).toBeNull();
});

test('mark_complete: unknown agf_* id reports not found', async () => {
  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: 'agf_doesnotexist' }),
    mockApiClient, SESSION, localStore,
  );
  expect(out).toContain('not found');
});

// ===== author attribution (recorded_by / reviewed_by / origin) =====
//
// The author contract: the dashboard parses concept CONTENT as newline-separated
// `key: value` lines. `recorded_by`/`reviewed_by` mean WHO wrote it and nothing
// else; `origin` is a separate provenance note. An unresolvable identity must
// OMIT the author line rather than write a placeholder.

/** Capture every concept written; answer a concept read (the conceptGraph root) from `remote`. */
async function conceptCaptureServer(opts: { remoteContent?: string; remoteSummary?: string } = {}) {
  const posts: Array<Record<string, unknown>> = [];
  await conceptDb({
    concept_create_write: (p) => {
      posts.push(p.conceptData);
      return written({ id: 'concept:cf_attr', shape: 'code_finding' });
    },
    conceptGraph: (p) => (opts.remoteContent
      ? { body: { content: { root: { id: p.concept_id, summary: opts.remoteSummary ?? 'recalled finding', content: opts.remoteContent }, edges: [] } } }
      : { status: 404, body: { error: `Concept not found: ${p.concept_id}` } }),
    conceptUsage_write: () => written({ id: 'usage_z', outcome: 'success' }),
  });
  return posts;
}

const contentOf = (body: Record<string, unknown> | undefined): string => String(body?.['content'] ?? '');

test('record_finding: stamps recorded_by (vesselId) and session on the shared concept', async () => {
  process.env.VESSEL_ID = 'metabob-mcp-aabbccddeeff';
  const posts = await conceptCaptureServer();

  await RecordFinding.handle(
    RecordFinding.InputSchema.parse({
      files: ['src/db/client.ts'], summary: 'SQL injection', severity: 'HIGH', category: 'security',
      details: 'user input concatenated into query',
    }),
    mockApiClient, SESSION, localStore,
  );

  expect(posts.length).toBe(1);
  const content = contentOf(posts[0]);
  expect(content).toContain('recorded_by: metabob-mcp-aabbccddeeff');
  expect(content).toContain(`session: ${SESSION}`);
  // Attribution stays in the key:value header block — the free-text details
  // body follows a blank line and is not parsed by the dashboard.
  expect(content.indexOf('recorded_by:')).toBeLessThan(content.indexOf('user input concatenated'));
});

test('record_finding: unresolvable identity omits recorded_by entirely but keeps session', async () => {
  // No VESSEL_ID, no METABOB_API_KEY, no boot-set resolver identity → undefined.
  const posts = await conceptCaptureServer();

  await RecordFinding.handle(
    RecordFinding.InputSchema.parse({
      files: ['src/db/client.ts'], summary: 'SQL injection', severity: 'HIGH', category: 'security',
    }),
    mockApiClient, SESSION, localStore,
  );

  expect(posts.length).toBe(1);
  const content = contentOf(posts[0]);
  expect(content).not.toContain('recorded_by');
  expect(content).toContain(`session: ${SESSION}`);
});

test('record_finding: the boot-resolved vesselId is used when no env id is set', async () => {
  setResolverIdentity({ vesselId: 'metabob-mcp-000111222333' });
  const posts = await conceptCaptureServer();

  await RecordFinding.handle(
    RecordFinding.InputSchema.parse({
      files: ['src/a.ts'], summary: 'x', severity: 'LOW', category: 'correctness',
    }),
    mockApiClient, SESSION, localStore,
  );
  expect(contentOf(posts[0])).toContain('recorded_by: metabob-mcp-000111222333');
});

test('mark_complete (local-seed path): verdict carries reviewed_by, session and origin: local', async () => {
  process.env.VESSEL_ID = 'metabob-mcp-aabbccddeeff';
  const posts = await conceptCaptureServer();

  const recordOut = await RecordFinding.handle(
    RecordFinding.InputSchema.parse({ files: ['src/x.ts'], summary: 'off by one', severity: 'MEDIUM', category: 'correctness' }),
    mockApiClient, SESSION, localStore,
  );
  const id = recordOut.match(/agf_[a-z0-9]+/)![0];

  await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: id, action: 'endorse' }),
    mockApiClient, SESSION, localStore,
  );

  // posts[0] is the finding; posts[1] is the verdict.
  expect(posts.length).toBe(2);
  const verdict = posts[1]!;
  expect(verdict['shape']).toBe('finding_verdict');
  const content = contentOf(verdict);
  expect(content).toContain('reviewed_by: metabob-mcp-aabbccddeeff');
  expect(content).toContain(`session: ${SESSION}`);
  expect(content).toContain('origin: local');
  // The verdict is keyed on the agf_* finding id, never the concept id.
  expect(content).toContain(`finding: ${id}`);
  // `recorded_by` must never appear on a verdict — it means author-of-finding.
  expect(content).not.toContain('recorded_by');
});

test('mark_complete (remote/recalled path): verdict carries reviewed_by, session and origin: remote', async () => {
  process.env.VESSEL_ID = 'metabob-mcp-aabbccddeeff';
  const posts = await conceptCaptureServer({
    remoteSummary: '[HIGH][security] repo-x: SQL injection',
    remoteContent: [
      'repo: repo-x',
      'files: src/db/client.ts',
      'severity: HIGH',
      'finding_ids: agf_remote01',
      'recorded_by: metabob-mcp-ffeeddccbbaa',
    ].join('\n'),
  });

  const out = await MarkComplete.handle(
    // No local seed exists for this concept id — the fleet case.
    MarkComplete.InputSchema.parse({ problem_id: 'concept_cf_remote', action: 'endorse' }),
    mockApiClient, SESSION, localStore,
  );
  expect(out).toContain('verdict shared');

  expect(posts.length).toBe(1);
  const content = contentOf(posts[0]);
  expect(posts[0]!['shape']).toBe('finding_verdict');
  expect(content).toContain('reviewed_by: metabob-mcp-aabbccddeeff');
  expect(content).toContain(`session: ${SESSION}`);
  expect(content).toContain('origin: remote');
  // Keyed on the agf_* id carried by the recalled finding, not the concept id.
  expect(content).toContain('finding: agf_remote01');
  expect(content).not.toContain('finding: concept_cf_remote');
  // The old free-text locality-in-the-author line is gone.
  expect(content).not.toContain('recorded_by');
  expect(content).not.toContain('no local seed on this machine');
});

test('mark_complete (remote path): unresolvable identity still stamps origin: remote', async () => {
  const posts = await conceptCaptureServer({
    remoteContent: 'repo: repo-x\nfiles: src/a.ts\nfinding_ids: agf_remote02',
  });

  await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: 'concept_cf_anon', action: 'discard' }),
    mockApiClient, SESSION, localStore,
  );

  const content = contentOf(posts[0]);
  expect(content).not.toContain('reviewed_by');
  expect(content).toContain('origin: remote');
  expect(content).toContain(`session: ${SESSION}`);
});

// ===== get_problems cross-agent findings rendering =====

test('get_problems: renders findings recorded by agents on this codebase', async () => {
  // Recall is scoped by repo first: a finding shows because it is about THIS
  // repository, and file_path only narrows within it — a matching path in
  // another repository must not pull that repository's findings in.
  //
  // Ask for the repo name rather than pinning WORKSPACE_PATH: activeWorkspacePath()
  // prefers the LocalIndex singleton over the env var, so any earlier test in the
  // process that indexed a workspace would silently win and make this order-dependent.
  const thisRepo = workspaceRepoName() ?? 'unknown-repo';

  await conceptDb({
    conceptSearch: (p) => {
      expect(p.query).toBeUndefined(); // list mode only
      // Recall scans two shapes: the findings, then the verdicts that close
      // them. No verdicts here, so every finding below stays open.
      if (p.shape === 'finding_verdict') {
        return { body: { content: [] } };
      }
      expect(p.shape).toBe('code_finding');
      return {
        body: {
          content: [
            {
              id: 'concept:cf_match',
              shape: 'code_finding',
              summary: `[HIGH][security] ${thisRepo}: SQL injection via string interpolation`,
              content: `repo: ${thisRepo}\nfiles: src/db/client.ts\nseverity: HIGH`,
              updated_at: '2026-07-16T00:00:00Z',
            },
            {
              id: 'concept:cf_other',
              shape: 'code_finding',
              summary: '[LOW][style] other-repo: naming drift',
              // Same file path as the match above, a different repository. Under
              // the pre-fix filter the path alone was enough to surface this.
              content: 'repo: other-repo\nfiles: src/db/client.ts',
            },
          ],
        },
      };
    },
  });

  const out = await GetProblems.handle(
    GetProblems.InputSchema.parse({ file_path: 'src/db/client.ts' }),
    mockApiClient, SESSION, null,
  );
  expect(out).toContain('Findings recorded by agents on this codebase');
  expect(out).toContain('SQL injection via string interpolation');
  expect(out).toContain('cf_match');
  // Another repository's finding is filtered out even though its files: line
  // matches the requested path exactly.
  expect(out).not.toContain('naming drift');
});

test('get_problems: concept-db unreachable is non-fatal', async () => {
  await conceptDb({ conceptSearch: unreachable }); // discovery cannot reach concept-db
  const out = await GetProblems.handle(
    GetProblems.InputSchema.parse({ file_path: 'src/db/client.ts' }),
    mockApiClient, SESSION, null,
  );
  expect(typeof out).toBe('string');
  expect(out).toContain('concept-db unreachable');
});

// ===== annotate_component on agf_* ids =====

async function recordOne(): Promise<string> {
  const input = RecordFinding.InputSchema.parse({
    files: ['src/api.ts'],
    summary: 'handleAdd does not validate input before store mutation',
    severity: 'MEDIUM',
    category: 'input-validation',
    line_start: 2,
    line_end: 2,
  });
  const out = await RecordFinding.handle(input, mockApiClient, SESSION, localStore);
  const id = out.match(/agf_[a-z0-9]+/)?.[0];
  if (!id) throw new Error('no agf id in record_finding output');
  return id;
}

test('annotate_component: explain notes for an agf_* finding come from the local seed', async () => {
  const id = await recordOne();
  const out = await AnnotateComponent.handle(
    AnnotateComponent.InputSchema.parse({ problem_id: id, mode: 'explain' }),
    mockApiClient, SESSION, localStore,
  );
  expect(out).toContain('agent-recorded finding');
  expect(out).toContain('handleAdd does not validate input');
  expect(out).toContain('Why this matters');
  expect(out).toContain('src/api.ts:2-2');
  expect(out).toContain('Status: open');
  // Built locally: no request for agf ids
  expect((mockApiClient.get as any)).not.toHaveBeenCalled();
  expect((mockApiClient.post as any)).not.toHaveBeenCalled();
});

test('annotate_component: recommend mode renders fix steps for an agf_* finding', async () => {
  const id = await recordOne();
  const out = await AnnotateComponent.handle(
    AnnotateComponent.InputSchema.parse({ problem_id: id, mode: 'recommend' }),
    mockApiClient, SESSION, localStore,
  );
  expect(out).toContain('How to address it');
  expect(out).toContain('1. ');
});

test('annotate_component: unknown agf_* id reports not found', async () => {
  const out = await AnnotateComponent.handle(
    AnnotateComponent.InputSchema.parse({ problem_id: 'agf_nope' }),
    mockApiClient, SESSION, localStore,
  );
  expect(out).toContain('not found in the local store');
});

test('annotate_component: agf_* id without a local store is a clean error', async () => {
  const out = await AnnotateComponent.handle(
    AnnotateComponent.InputSchema.parse({ problem_id: 'agf_x' }),
    mockApiClient, SESSION, null,
  );
  expect(out).toContain('the local store failed to open');
});
