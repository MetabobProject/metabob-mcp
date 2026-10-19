/**
 * W4 — the skill contract (skills/metabob/SKILL.md). The skill is what an agent
 * actually follows, so the server must serve it as written:
 *   - every tool the skill names is in tools/list;
 *   - every step it tells an agent to take works under the default
 *     configuration (a key and an anchor, nothing opted into);
 *   - a step that depends on an opt-in says so, and the tool says so too.
 */

import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FakeSubstrate } from './harness/fake-substrate';
import { McpServer, cleanupTempDirs, makeWorkspace } from './harness/mcp-client';

// Each server boot is a process spawn; slow CI runners need more than the 5 s default.
setDefaultTimeout(30_000);
const BOOT_TIMEOUT_MS = 30_000;

const SKILL = readFileSync(resolve(import.meta.dir, '..', '..', 'skills', 'metabob', 'SKILL.md'), 'utf8');

/** Identifiers the skill writes in backticks that are values, not tools or parameters. */
const NOT_TOOLS = new Set(['repo_anchor', 'code_finding', 'finding_verdict', 'human_input', 'not_reached']);

let fake: FakeSubstrate;
let server: McpServer;
let workspace: string;
let toolNames: Set<string>;
let paramNames: Set<string>;

beforeAll(async () => {
  fake = await FakeSubstrate.start();
  workspace = makeWorkspace('skill-ws', {
    'src/auth.ts': "import { sweep } from './session';\nexport function refresh() { sweep(); }\n",
    'src/session.ts': 'export function sweep() {}\n',
    'tests/auth.test.ts': "import { refresh } from '../src/auth';\nrefresh();\n",
  });
  server = await McpServer.start({ workspace, env: fake.env() });
  const tools = await server.listTools();
  toolNames = new Set(tools.map(t => t.name));
  paramNames = new Set(tools.flatMap(t => Object.keys(t.inputSchema?.properties ?? {})));
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
  await fake?.stop();
  cleanupTempDirs();
}, BOOT_TIMEOUT_MS);

/** The leading snake_case identifier of every backtick span in the skill. */
function backtickedIdentifiers(md: string): string[] {
  const out = new Set<string>();
  for (const m of md.matchAll(/`([^`\n]+)`/g)) {
    const id = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b(?!\*)/.exec(m[1]!.trim())?.[1];
    if (id) out.add(id);
  }
  return [...out];
}

/** One numbered or bulleted step of the skill, by a phrase it contains. */
function stepMentioning(md: string, phrase: string): string {
  const steps = md.split(/\n(?=\d+\. |- |## )/);
  const step = steps.find(s => s.includes(phrase));
  if (!step) throw new Error(`no step of SKILL.md mentions ${phrase}`);
  return step;
}

/** A step "works" when the tool ran and did not report that it could not. */
function expectWorks(tool: string, out: string): void {
  expect(out, `${tool} returned nothing`).not.toBe('');
  for (const failure of [/not configured/i, /unreachable/i, /could not find/i, /failed to reach/i, /requires (discovery|an explicit)/i]) {
    expect(out, `${tool}: ${out}`).not.toMatch(failure);
  }
}

describe('W4 skill contract', () => {
  test('the server hands the agent instructions at connect, naming only real tools', () => {
    const instructions: string = server.initializeResult?.instructions ?? '';
    expect(instructions).toContain('`metabob` skill');
    // Named attachment and network causes appear in backticks too; they are states, not tools.
    const causes = new Set(['key_rejected', 'anchor_unreachable', 'proxy_auth_required']);
    const named = backtickedIdentifiers(instructions).filter(id => !NOT_TOOLS.has(id) && !causes.has(id));
    expect(named.length).toBeGreaterThan(8);
    expect(named.filter(id => !toolNames.has(id))).toEqual([]);
  });

  test('the instructions name the first-call set in one sentence, so one tool search loads it', () => {
    const instructions: string = server.initializeResult?.instructions ?? '';
    const line = instructions.split('\n').find(l => l.startsWith('First calls:')) ?? '';
    for (const tool of ['get_analysis_context', 'get_problems', 'record_finding', 'mark_complete']) {
      expect(line).toContain(`\`${tool}\``);
      expect(toolNames.has(tool)).toBe(true);
    }
  });

  test('the skill frames participation by role and keeps the agent from grading itself', () => {
    for (const role of ['coordinator', 'operator', 'verifier', 'client of shared memory']) {
      expect(SKILL.toLowerCase()).toContain(`role: ${role}`);
    }
    expect(SKILL).toContain('Never grade your own work');
    expect(SKILL).toContain('learning_mode: "observe"');
    expect(SKILL).toContain('`automated`');
    // Paths the substrate does not yet stamp with a principal are never taught as capabilities.
    expect(SKILL).not.toMatch(/poolImpulse_write|execution-traces/);
  });

  test('every tool the skill names exists in tools/list', () => {
    const named = backtickedIdentifiers(SKILL).filter(id => !paramNames.has(id) && !NOT_TOOLS.has(id));
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter(id => !toolNames.has(id))).toEqual([]);
  });

  test('start of session — orient', async () => {
    expectWorks('get_analysis_context', await server.text('get_analysis_context'));
    expectWorks('get_problems', await server.text('get_problems'));
    expectWorks('concept_search', await server.text('concept_search', { shape: 'code_finding' }));
  });

  test('what this session does not do — nothing is dispatched to a client-only session', async () => {
    const step = stepMentioning(SKILL, '`pull_assigned_work`');
    expect(step).toContain('advertises nothing');
    expect(step).not.toContain('METABOB_AGENT_RESOLVER');

    // Nothing can ever be dispatched here, so the tool says why instead of
    // reporting an empty queue an agent would keep polling.
    const pulled = await server.text('pull_assigned_work');
    expect(pulled).toContain('none can arrive');
    expect(pulled).not.toContain('METABOB_AGENT_RESOLVER');

    const submitted = await server.text('submit_resolution', { task_id: 'no-such-task', outcome: 'declined' });
    expect(submitted).toContain('advertises nothing to the substrate');
    expect(submitted).not.toContain('METABOB_AGENT_RESOLVER');
  });

  test('start of session — index the workspace', async () => {
    const out = await server.text('init_workspace', { workspace_path: workspace });
    expect(out).toMatch(/Local index:\s*[1-9]\d*\/\d+ files parsed/);
  });

  test('working safely in the code, and recording to the ledger', async () => {
    const impact = await server.text('analyze_impact', { changed_files: ['src/session.ts'] });
    expectWorks('analyze_impact', impact);
    expect(impact).not.toMatch(/run init_workspace/i);
    expectWorks('predict_cochanges', await server.text('predict_cochanges', { changed_files: ['src/session.ts'] }));
    const again = await server.text('init_workspace', { recently_changed_files: ['src/session.ts'] });
    expect(again).toMatch(/Local index:/);
    const recorded = await server.text('record_finding', {
      files: ['src/session.ts'], summary: 'sweep holds no lock', severity: 'MEDIUM', category: 'correctness',
      details: 'owns: src/session.ts',
    });
    expectWorks('record_finding', recorded);
    expect(recorded).toContain('shared org-wide via concept-db');
  });

  test('close out — close findings and record decisions', async () => {
    expectWorks('assign_git_changes', await server.text('assign_git_changes', { changed_files: ['src/session.ts'] }));

    const problems = await server.text('get_problems');
    const agf = /ID:\s+(agf_\w+)/.exec(problems)?.[1];
    expect(agf, problems).toBeDefined();
    const closed = await server.text('mark_complete', { problem_id: agf!, action: 'endorse' });
    expectWorks('mark_complete', closed);
    expect(closed).toContain('verdict shared via concept-db');

    const anchor = await server.text('concept_create', {
      content: 'skill-ws: workflow fixture, root /, TypeScript', shape: 'repo_anchor', source_type: 'memo',
    });
    const decision = await server.text('concept_create', {
      content: 'Chose a lock over a queue for the sweep; a queue was rejected because it reorders refreshes.',
      shape: 'design_decision', source_type: 'memo',
    });
    const id = (text: string) => /id:\s+(\S+)/.exec(text)?.[1];
    expect(id(anchor)).toBeDefined();
    const linked = await server.text('concept_link', {
      from_concept_id: id(decision)!, to_concept_id: id(anchor)!, edge_type: 'related_to',
    });
    expect(linked).toContain('Edge created');
  });

  test('stdout carries only JSON-RPC through every step', () => {
    expect(server.strayStdout).toEqual([]);
  });
});
