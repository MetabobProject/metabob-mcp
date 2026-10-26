/**
 * What mark_complete actually WRITES.
 *
 * Two gaps this closes:
 *
 * 1. An id that names no finding must not be reported as endorsed or
 *    discarded: the tool refuses it and makes no request.
 *
 * 2. The fleet case — a `concept_*` id with no local seed — is asserted here
 *    against a fake concept-db behind the attachment, because it is the case SKILL.md documented
 *    backwards (it claimed the call refuses). The assertions are on what the
 *    server RECEIVED, not on the handler's prose, so they survive rewording of
 *    the output.
 */
import { test, expect, mock, afterEach } from 'bun:test';
import type { AnalysisAPIClient } from '../../src/api-client';
import * as MarkComplete from '../../src/tools/mark-complete';
import { makeTempStore, cleanupTempStores } from '../helpers/temp-store';
import { setAttachment } from '../../src/attachment';
import { installShapeStub } from '../helpers/shape-stub';
import { NO_GIT } from '../helpers/no-git';

const SESSION = 'mark-complete-verdict-session';

afterEach(() => {
  cleanupTempStores();
});

function makeApiClient(): AnalysisAPIClient {
  return { get: mock(async () => ({})) } as unknown as AnalysisAPIClient;
}

// ===== Ids that name no finding are refused =====

// Every problem this server lists is an agf_* finding or a concept_* id. Any
// other id names nothing that could be written, so the tool refuses it and
// makes no request — it never reports a verdict it did not record.
for (const action of ['endorse', 'discard'] as const) {
  test(`${action} on a non-finding id is refused and writes nothing`, async () => {
    const api = makeApiClient();
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      return new Response('{}');
    }) as unknown as typeof fetch;
    try {
      const input = MarkComplete.InputSchema.parse({ problem_id: 'prob_456', action });
      const out = await MarkComplete.handle(input, api, SESSION, undefined, NO_GIT);
      expect(out).toContain('"prob_456" is not a finding id, so nothing was recorded');
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}


// ===== Finding 14: a concept_* id with no local seed still records a verdict =====

const FLEET_CONCEPT = 'concept_FleetRecall01';
const FLEET_FINDING = 'agf_fleetrecorded1';

/**
 * A concept-db, behind the attachment, that answers the one read mark_complete
 * makes (the `conceptGraph` root) and records every write. The root must carry
 * `finding_ids:`, `files:` and `repo:` header lines — fetchConceptById parses
 * those out of `content`, and a body it cannot parse yields null, which would
 * send the handler down the "could not be read" branch and make the test assert
 * nothing.
 */
async function markCompleteAgainstFakeDb(
  action: 'endorse' | 'discard',
): Promise<{ verdicts: Array<Record<string, unknown>>; usage: Array<Record<string, unknown>>; output: string }> {
  const stub = await installShapeStub({
    conceptGraph: (p) => (p.concept_id === FLEET_CONCEPT
      ? {
          body: {
            content: {
              root: {
                id: `concept:${FLEET_CONCEPT}`,
                summary: 'metabob-mcp: retry() retries every 4xx three times',
                content: [
                  `finding_ids: ${FLEET_FINDING}`,
                  'repo: metabob-mcp',
                  'files: src/api-client.ts',
                  'recorded_by: metabob-mcp-otherhost',
                ].join('\n'),
              },
              edges: [],
            },
          },
        }
      : { status: 404, body: { error: `Concept not found: ${p.concept_id}` } }),
    concept_create_write: () => ({ body: { success: true, content: JSON.stringify({ id: 'concept:concept_verdict01' }) } }),
    conceptUsage_write: () => ({ body: { success: true, content: JSON.stringify({ id: 'usage_1' }) } }),
  });
  try {
    // An EMPTY store: this machine has never seen the finding, which is the
    // whole point — another agent recorded it somewhere else.
    const { store } = makeTempStore('mark-complete-verdict-');
    const input = MarkComplete.InputSchema.parse({ problem_id: FLEET_CONCEPT, action });
    const output = await MarkComplete.handle(input, makeApiClient(), SESSION, store, NO_GIT);
    return {
      verdicts: stub.calls('concept_create_write').map((p) => p.conceptData),
      usage: stub.calls('conceptUsage_write').map((p) => p.usageData),
      output,
    };
  } finally {
    setAttachment(null);
  }
}

test('a recalled concept with no local seed still writes a verdict to concept-db', async () => {
  const { verdicts, usage, output } = await markCompleteAgainstFakeDb('endorse');

  expect(verdicts.length).toBe(1);
  const content = String(verdicts[0]!['content']);
  // Keyed on the agf_* id the FINDING carries, not the concept id — the
  // dashboard's verdict join keys on that, so a verdict written against the
  // concept id lands in the database and is invisible to every reader.
  expect(content).toContain(`finding: ${FLEET_FINDING}`);
  expect(content).not.toContain(`finding: ${FLEET_CONCEPT}`);
  expect(content).toContain('verdict: endorsed (resolved)');
  // Provenance is a separate fact from authorship.
  expect(content).toContain('origin: remote');
  expect(verdicts[0]!['shape']).toBe('finding_verdict');

  // …and the relevance signal, which is what moves the concept's posterior.
  expect(usage.length).toBe(1);
  expect(usage[0]!['concept_id']).toBe(FLEET_CONCEPT);
  expect(usage[0]!['outcome']).toBe('success');

  // Not a refusal. SKILL.md told agents this call refuses; it does not.
  expect(output.toLowerCase()).not.toContain('not found in the local store');
});

test('discarding a recalled concept records the inverse verdict and a failure signal', async () => {
  // Guards the direction: a handler that hardcoded "endorsed"/"success" would
  // pass the test above.
  const { verdicts, usage } = await markCompleteAgainstFakeDb('discard');

  const content = String(verdicts[0]!['content']);
  expect(content).toContain('verdict: discarded (retracted)');
  expect(content).not.toContain('verdict: endorsed (resolved)');

  expect(usage.length).toBe(1);
  expect(usage[0]!['outcome']).toBe('failure');
});

// ===== Finding 14: the doc that ships in the tarball must match the above =====

test('SKILL.md does not tell agents the concept-only call is refused', async () => {
  // skills/**/* ships in the npm tarball and steers agent behaviour directly, so
  // a wrong claim here is not a docs nit: an agent that believes the call will be
  // refused skips it, and the cross-agent verdict above is never written.
  const skill = await Bun.file(
    new URL('../../skills/metabob-substrate/SKILL.md', import.meta.url),
  ).text();

  const lines = skill.split('\n');
  const start = lines.findIndex(l => l.includes('**Close**: `mark_complete`'));
  expect(start).toBeGreaterThan(-1); // the step still exists at all
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => /^\d+\. /.test(l.trim()));
  // The list item is hard-wrapped, so match against it as prose, not as lines.
  const step = [lines[start], ...rest.slice(0, end === -1 ? rest.length : end)]
    .join(' ')
    .replace(/\s+/g, ' ');

  expect(step).not.toMatch(/refuses?\b/i);
  expect(step).not.toMatch(/is read-only here/i);
  // …and states what the code does instead.
  expect(step).toMatch(/no local seed/i);
  expect(step).toMatch(/nothing local was retired/i);
});

// ===== A multi-file finding is ONE finding =====

test('a verdict retires every seed sharing the finding, not just the one named', async () => {
  // record_finding writes one seed per file but a SINGLE concept listing all of
  // their ids, and cross-agent recall closes the whole finding on a verdict
  // against any one of them. Retiring only the named seed left the finding
  // closed org-wide and still open locally — the same finding both done and
  // not done, with the leftovers unreachable by any id an agent would think to use.
  const { store } = makeTempStore('mark-complete-siblings-');
  store.setWorkspaceScope(process.cwd());

  const refs = JSON.stringify(['concept:cf_shared']);
  const base = {
    workspace_id: 'default',
    line_start: 1, line_end: 2,
    category: 'correctness', severity: 'HIGH',
    brief: 'one finding across three files',
    confidence: 1, refs_json: refs,
    produced_at: Date.now(), stale: false,
  };
  store.upsertSeed({ ...base, id: 'agf_f1', file_path: 'src/a.ts' });
  store.upsertSeed({ ...base, id: 'agf_f2', file_path: 'src/b.ts' });
  store.upsertSeed({ ...base, id: 'agf_f3', file_path: 'src/c.ts' });
  expect(store.getAllCachedSeeds()).toHaveLength(3);

  await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: 'agf_f2', action: 'endorse' }),
    makeApiClient(), SESSION, store, NO_GIT,
  );

  // Endorse marks stale: none of the three should still be served.
  expect(store.getAllCachedSeeds()).toHaveLength(0);
  expect(store.getSeedById('agf_f1')?.stale).toBe(true);
  expect(store.getSeedById('agf_f3')?.stale).toBe(true);
});

test('discard removes every seed sharing the finding', async () => {
  const { store } = makeTempStore('mark-complete-siblings-discard-');
  store.setWorkspaceScope(process.cwd());

  const refs = JSON.stringify(['concept:cf_bogus']);
  const base = {
    workspace_id: 'default',
    line_start: 1, line_end: 2,
    category: 'style', severity: 'LOW',
    brief: 'a false positive across two files',
    confidence: 1, refs_json: refs,
    produced_at: Date.now(), stale: false,
  };
  store.upsertSeed({ ...base, id: 'agf_x1', file_path: 'src/x.ts' });
  store.upsertSeed({ ...base, id: 'agf_x2', file_path: 'src/y.ts' });

  await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: 'agf_x1', action: 'discard' }),
    makeApiClient(), SESSION, store, NO_GIT,
  );

  expect(store.getSeedById('agf_x1')).toBeNull();
  expect(store.getSeedById('agf_x2')).toBeNull();
});

test('a finding with no linked concept retires only itself', async () => {
  // The inverse: sibling retirement must key on the shared concept, not fire
  // for every seed in the workspace.
  const { store } = makeTempStore('mark-complete-siblings-solo-');
  store.setWorkspaceScope(process.cwd());

  const base = {
    workspace_id: 'default',
    line_start: 1, line_end: 2,
    category: 'correctness', severity: 'HIGH',
    brief: 'unrelated', confidence: 1, refs_json: '[]',
    produced_at: Date.now(), stale: false,
  };
  store.upsertSeed({ ...base, id: 'agf_solo', file_path: 'src/solo.ts' });
  store.upsertSeed({ ...base, id: 'agf_other', file_path: 'src/other.ts' });

  await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: 'agf_solo', action: 'discard' }),
    makeApiClient(), SESSION, store, NO_GIT,
  );

  expect(store.getSeedById('agf_solo')).toBeNull();
  expect(store.getSeedById('agf_other')).not.toBeNull();
});

test('markCompleteResult names what the reply did, for the call log', () => {
  expect(MarkComplete.markCompleteResult('Finding agf_x left open: fix pending in 3ms')).toBe('pending');
  expect(MarkComplete.markCompleteResult('Finding agf_x left open, fix pending, from the shared record')).toBe('pending');
  expect(MarkComplete.markCompleteResult('Finding agf_x left open: nothing in this checkout changed since it was recorded. No verdict was recorded.')).toBe('not_applied');
  expect(MarkComplete.markCompleteResult('Problem ID "p" is not a finding id, so nothing was recorded.')).toBe('not_applied');
  expect(MarkComplete.markCompleteResult('Finding agf_x endorsed (finding resolved, retired from get_problems) in 2ms\n  concept-db: concept-db unreachable (x) — verdict recorded locally only')).toBe('not_shared');
  expect(MarkComplete.markCompleteResult('Finding agf_x endorsed (finding resolved, retired from get_problems) in 2ms\n  concept-db: verdict shared via concept-db (concept c1)')).toBe('ok');
});
