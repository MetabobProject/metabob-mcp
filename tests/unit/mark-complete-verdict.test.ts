/**
 * What mark_complete actually WRITES.
 *
 * Two gaps this closes:
 *
 * 1. `tools.test.ts` asserted `expect(postFeedback).toHaveBeenCalled()` — arity
 *    zero. The payload is the entire semantic content of the tool: swap the two
 *    booleans and every endorse tells the backend "false positive" while the
 *    return string, built independently from `input.action`, still reads
 *    "endorsed". Suite green, detection-quality signal inverted for every
 *    non-agent problem.
 *
 * 2. The fleet case — a `concept_*` id with no local seed — is asserted here
 *    against a fake concept-db, because it is the case SKILL.md documented
 *    backwards (it claimed the call refuses). The assertions are on what the
 *    server RECEIVED, not on the handler's prose, so they survive rewording of
 *    the output.
 */
import { test, expect, mock, afterEach } from 'bun:test';
import type { AnalysisAPIClient } from '../../src/api-client';
import * as MarkComplete from '../../src/tools/mark-complete';
import { makeTempStore, cleanupTempStores } from '../helpers/temp-store';

const SESSION = 'mark-complete-verdict-session';

afterEach(() => {
  cleanupTempStores();
});

function makeApiClient(): AnalysisAPIClient {
  return {
    postFeedback: mock(async () => ({})),
    hasDiscovery: mock(() => false),
    getDiscoveryEndpoint: mock(() => undefined),
  } as unknown as AnalysisAPIClient;
}

// ===== Finding 33: the directional verdict on the legacy API =====

test('endorse posts endorsed=true / discarded=false', async () => {
  const api = makeApiClient();
  const input = MarkComplete.InputSchema.parse({ problem_id: 'prob_456', action: 'endorse' });
  await MarkComplete.handle(input, api, SESSION);

  expect(api.postFeedback).toHaveBeenCalledWith('prob_456', SESSION, {
    endorsed: true,
    discarded: false,
  });
});

test('discard posts endorsed=false / discarded=true', async () => {
  const api = makeApiClient();
  const input = MarkComplete.InputSchema.parse({ problem_id: 'prob_456', action: 'discard' });
  await MarkComplete.handle(input, api, SESSION);

  expect(api.postFeedback).toHaveBeenCalledWith('prob_456', SESSION, {
    endorsed: false,
    discarded: true,
  });
});

// ===== Finding 14: a concept_* id with no local seed still records a verdict =====

interface CapturedPost {
  path: string;
  body: Record<string, unknown>;
}

const FLEET_CONCEPT = 'concept_FleetRecall01';
const FLEET_FINDING = 'agf_fleetrecorded1';

/**
 * A concept-db that answers the one GET mark_complete makes and records every
 * write. The GET body must carry `finding_ids:`, `files:` and `repo:` header
 * lines — fetchConceptById parses those out of `content`, and a body it cannot
 * parse yields null, which would send the handler down the "could not be read"
 * branch and make the test assert nothing.
 */
function startFakeConceptDb(): { url: string; posts: CapturedPost[]; stop: () => void } {
  const posts: CapturedPost[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === `/concepts/${FLEET_CONCEPT}`) {
        return Response.json({
          id: `concept:${FLEET_CONCEPT}`,
          summary: 'metabob-mcp: retry() retries every 4xx three times',
          content: [
            `finding_ids: ${FLEET_FINDING}`,
            'repo: metabob-mcp',
            'files: src/api-client.ts',
            'recorded_by: metabob-mcp-otherhost',
          ].join('\n'),
        });
      }
      if (req.method === 'POST') {
        posts.push({ path: url.pathname, body: (await req.json()) as Record<string, unknown> });
        return Response.json({ id: 'concept:concept_verdict01' });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    posts,
    stop: () => server.stop(true),
  };
}

async function markCompleteAgainstFakeDb(
  action: 'endorse' | 'discard',
): Promise<{ posts: CapturedPost[]; output: string }> {
  const db = startFakeConceptDb();
  const previous = process.env.CONCEPT_DB_URL;
  process.env.CONCEPT_DB_URL = db.url;
  try {
    // An EMPTY store: this machine has never seen the finding, which is the
    // whole point — another agent recorded it somewhere else.
    const { store } = makeTempStore('mark-complete-verdict-');
    const input = MarkComplete.InputSchema.parse({ problem_id: FLEET_CONCEPT, action });
    const output = await MarkComplete.handle(input, makeApiClient(), SESSION, store);
    return { posts: db.posts, output };
  } finally {
    if (previous === undefined) delete process.env.CONCEPT_DB_URL;
    else process.env.CONCEPT_DB_URL = previous;
    db.stop();
  }
}

test('a recalled concept with no local seed still writes a verdict to concept-db', async () => {
  const { posts, output } = await markCompleteAgainstFakeDb('endorse');

  const verdicts = posts.filter(p => p.path === '/concepts');
  expect(verdicts.length).toBe(1);
  const content = String(verdicts[0]!.body['content']);
  // Keyed on the agf_* id the FINDING carries, not the concept id — the
  // dashboard's verdict join keys on that, so a verdict written against the
  // concept id lands in the database and is invisible to every reader.
  expect(content).toContain(`finding: ${FLEET_FINDING}`);
  expect(content).not.toContain(`finding: ${FLEET_CONCEPT}`);
  expect(content).toContain('verdict: endorsed (resolved)');
  // Provenance is a separate fact from authorship.
  expect(content).toContain('origin: remote');
  expect(verdicts[0]!.body['shape']).toBe('finding_verdict');

  // …and the relevance signal, which is what moves the concept's posterior.
  const usage = posts.filter(p => p.path.endsWith('/usage'));
  expect(usage.length).toBe(1);
  expect(usage[0]!.path).toBe(`/concepts/${FLEET_CONCEPT}/usage`);
  expect(usage[0]!.body['outcome']).toBe('success');

  // Not a refusal. SKILL.md told agents this call refuses; it does not.
  expect(output.toLowerCase()).not.toContain('not found in the local store');
});

test('discarding a recalled concept records the inverse verdict and a failure signal', async () => {
  // Guards the direction: a handler that hardcoded "endorsed"/"success" would
  // pass the test above.
  const { posts } = await markCompleteAgainstFakeDb('discard');

  const content = String(posts.filter(p => p.path === '/concepts')[0]!.body['content']);
  expect(content).toContain('verdict: discarded (retracted)');
  expect(content).not.toContain('verdict: endorsed (resolved)');

  const usage = posts.filter(p => p.path.endsWith('/usage'));
  expect(usage.length).toBe(1);
  expect(usage[0]!.body['outcome']).toBe('failure');
});

// ===== Finding 14: the doc that ships in the tarball must match the above =====

test('SKILL.md does not tell agents the concept-only call is refused', async () => {
  // skills/**/* ships in the npm tarball and steers agent behaviour directly, so
  // a wrong claim here is not a docs nit: an agent that believes the call will be
  // refused skips it, and the cross-agent verdict above is never written.
  const skill = await Bun.file(
    new URL('../../skills/metabob/SKILL.md', import.meta.url),
  ).text();

  const lines = skill.split('\n');
  const start = lines.findIndex(l => l.includes('`mark_complete` for **every** problem'));
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
