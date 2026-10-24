/**
 * The goal tools through the one ingress (src/tools/_goal-host.ts): dispatch is
 * `goalDispatchAsync`, the dispatch record is `goalWalkState` (goal-host wraps it
 * as `{ resolved, shape, body }`), the oracle label is
 * `goal_verification_label_write`. run_goal holds no request open: it dispatches,
 * then polls with short reads until the goal leaves `running` or its deadline
 * passes. SPEC §substrate-goal-tools, CONFORMANCE §c11-attachment-model
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { RESOLVE_MAX_TIMEOUT_MS, RESOLVE_TIMEOUT_MS, setAttachment } from '../../src/attachment';
import { handle as runGoal } from '../../src/tools/run-goal';
import { handle as runGoalAsync } from '../../src/tools/run-goal-async';
import { handle as goalStatus } from '../../src/tools/goal-status';
import { handle as goalReasoning } from '../../src/tools/goal-reasoning';
import { handle as provideFeedback } from '../../src/tools/provide-feedback';
import { installShapeStub } from '../helpers/shape-stub';
import { UNIDENTIFIED_OPERATOR, sessionId } from '../../src/operator-id';
import type { AnalysisAPIClient } from '../../src/api-client';

/** The session tag every dispatch carries (a claim). SPEC §client-claim */
const SESSION_TAG = `session:${sessionId()}`;

const apiClient = {} as AnalysisAPIClient;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['MB_OPERATOR_ID', 'RUN_GOAL_TIMEOUT_MS', 'RUN_GOAL_POLL_MS']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.RUN_GOAL_POLL_MS = '1';
});

afterEach(() => {
  setAttachment(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** goal-host's goalWalkState envelope around a dispatch record. */
const walk = (record: Record<string, unknown>) => ({ body: { resolved: true, shape: 'goalWalkState', body: record } });

test('every per-family client cap ends within 60 s', () => {
  for (const ms of Object.values(RESOLVE_TIMEOUT_MS)) expect(ms).toBeLessThanOrEqual(RESOLVE_MAX_TIMEOUT_MS);
  expect(RESOLVE_MAX_TIMEOUT_MS).toBe(60_000);
});

describe('run_goal_async', () => {
  test('dispatches goalDispatchAsync with the operator stamp and the fields goal-host reads', async () => {
    const stub = await installShapeStub({
      goalDispatchAsync: () => ({ status: 202, body: { dispatchId: 'd-1', status: 'running' } }),
    });
    const out = await runGoalAsync(
      { goal: 'edit repos/x/src/a.ts: rename foo', target_template_id: 'tmpl-1', variables: { a: 1 }, parent_execution_id: 'p1', composition_chain: ['r1'] },
      apiClient,
    );
    expect(stub.calls('goalDispatchAsync')).toEqual([{
      type: 'goalDispatchAsync', operator: UNIDENTIFIED_OPERATOR, goal: 'edit repos/x/src/a.ts: rename foo',
      targetTemplateId: 'tmpl-1', variables: { a: 1 }, parent_execution_id: 'p1', composition_chain: ['r1'], tags: [SESSION_TAG],
    }]);
    expect(out).toBe([
      'Goal dispatched asynchronously.',
      '  dispatchId: d-1',
      '  status:     running',
      '',
      'Poll with: goal_status { "dispatch_id": "d-1" }',
    ].join('\n'));
  });

  test('forwards learning_mode and tags as given', async () => {
    const stub = await installShapeStub({
      goalDispatchAsync: () => ({ status: 202, body: { dispatchId: 'd-o', status: 'running' } }),
    });
    await runGoalAsync({ goal: 'how many vessels?', learning_mode: 'observe', tags: ['probe:registry'] }, apiClient);
    expect(stub.calls('goalDispatchAsync')).toEqual([{
      type: 'goalDispatchAsync', operator: UNIDENTIFIED_OPERATOR, goal: 'how many vessels?',
      learning_mode: 'observe', tags: ['probe:registry', SESSION_TAG],
    }]);
  });

  test('a dispatch declares its operator and session: MB_OPERATOR_ID, else the workspace identity, never one shared default', async () => {
    const { setWorkspaceOperator } = await import('../../src/operator-id');
    const stub = await installShapeStub({ goalDispatchAsync: () => ({ status: 202, body: { dispatchId: 'd-w', status: 'running' } }) });
    setWorkspaceOperator('metabob-mcp-abc123');
    try {
      await runGoalAsync({ goal: 'g' }, apiClient);
      process.env.MB_OPERATOR_ID = 'alice-review-bot';
      await runGoalAsync({ goal: 'g' }, apiClient);
    } finally {
      setWorkspaceOperator(undefined);
    }
    expect(stub.calls('goalDispatchAsync').map((p) => p.operator)).toEqual(['metabob-mcp-abc123', 'alice-review-bot']);
    // The session rides as a dispatch tag whether or not writes carry client_claim.
    expect(stub.calls('goalDispatchAsync').every((p) => p.tags.includes(`session:${sessionId()}`))).toBe(true);
  });

  test('states a requested observe mode as a request, not as applied', async () => {
    await installShapeStub({ goalDispatchAsync: () => ({ status: 202, body: { dispatchId: 'd-q', status: 'running' } }) });
    const out = await runGoalAsync({ goal: 'probe', learning_mode: 'observe' }, apiClient);
    expect(out).toContain('learning_mode: observe (requested;');
    expect(out).toContain('a goal-host older than the goalDispatchAsync learning_mode forward still learns');
  });

  test('MB_OPERATOR_ID overrides the operator stamp', async () => {
    process.env.MB_OPERATOR_ID = 'operator-a';
    const stub = await installShapeStub({ goalDispatchAsync: () => ({ status: 202, body: { dispatchId: 'd-2', status: 'running' } }) });
    await runGoalAsync({ goal: 'g' }, apiClient);
    expect(stub.calls('goalDispatchAsync')[0]!.operator).toBe('operator-a');
  });

  test('a spend-rate refusal (429) prints its status and reason', async () => {
    await installShapeStub({
      goalDispatchAsync: () => ({ status: 429, body: { dispatchId: 'd-3', status: 'failed', reached: false, refused: true, goalReachReason: 'deterministic:spend-rate-refused - window full' } }),
    });
    expect(await runGoalAsync({ goal: 'g' }, apiClient)).toBe('run_goal_async: 429\n  error: deterministic:spend-rate-refused - window full');
  });

  test('a dispatch cut at goal-host\'s timeout is named and never retried', async () => {
    const stub = await installShapeStub({
      goalDispatchAsync: () => ({ status: 502, body: { error: 'forward_failed', shape: 'goalDispatchAsync', detail: 'The operation timed out.' } }),
    });
    expect(await runGoalAsync({ goal: 'g' }, apiClient)).toMatch(/^run_goal_async: producer_timeout\(goalDispatchAsync, \d+ms\)/);
    expect(stub.calls('goalDispatchAsync')).toHaveLength(1);
  });
});

describe('run_goal', () => {
  test('dispatches, then polls goalWalkState until the goal leaves running', async () => {
    let polls = 0;
    const stub = await installShapeStub({
      goalDispatchAsync: () => ({ status: 202, body: { dispatchId: 'd-run', status: 'running' } }),
      goalWalkState: (p) => (++polls < 3
        ? walk({ dispatchId: p.dispatchId, status: 'running', reached: null })
        : walk({ dispatchId: p.dispatchId, status: 'completed', reached: true, executionId: 'exec-9', selectedTemplateId: 'tmpl-feature-compose' })),
    });
    const out = await runGoal({ goal: 'g' }, apiClient);
    expect(stub.pointers.map((p) => p.type)).toEqual(['goalDispatchAsync', 'goalWalkState', 'goalWalkState', 'goalWalkState']);
    expect(stub.calls('goalWalkState').every((p) => p.dispatchId === 'd-run')).toBe(true);
    expect(stub.calls('goalDispatchAsync')[0]!.operator).toBe(UNIDENTIFIED_OPERATOR);
    expect(out).toContain('Goal dispatched via goalDispatchAsync, completed per goalWalkState.');
    expect(out).toContain('  dispatchId:         d-run');
    expect(out).toContain('  executionId:        exec-9');
    expect(out).toContain('  reached:            yes');
    expect(out).toContain('  status:             completed');
    expect(out).toContain('  selectedTemplateId: tmpl-feature-compose');
    expect(out).toMatch(/ {2}duration: {11}\d+ms$/);
  });

  test('past the polling deadline it hands back the dispatchId; the goal keeps running', async () => {
    process.env.RUN_GOAL_TIMEOUT_MS = '20';
    process.env.RUN_GOAL_POLL_MS = '5';
    await installShapeStub({
      goalDispatchAsync: () => ({ status: 202, body: { dispatchId: 'd-slow', status: 'running' } }),
      goalWalkState: (p) => walk({ dispatchId: p.dispatchId, status: 'running' }),
    });
    const out = await runGoal({ goal: 'g' }, apiClient);
    expect(out).toStartWith('Goal dispatched via goalDispatchAsync, still running at the 20ms deadline (RUN_GOAL_TIMEOUT_MS)');
    expect(out).toContain('  dispatchId:         d-slow');
    expect(out).toContain('Poll with: goal_status { "dispatch_id": "d-slow" }');
  });

  test('a refused dispatch prints its status, error and duration, and polls nothing', async () => {
    const stub = await installShapeStub({ goalDispatchAsync: () => ({ status: 503, body: { error: 'goal-host draining for restart — retry', draining: true } }) });
    const out = await runGoal({ goal: 'g' }, apiClient);
    expect(out).toMatch(/^run_goal: 503\n {2}error: goal-host draining for restart — retry\n {2}duration: \d+ms$/);
    expect(stub.calls('goalWalkState')).toEqual([]);
  });
});

describe('goal_status and goal_reasoning', () => {
  test('a satisfier reach says it has no task trace and points at goal_reasoning, without a trace read', async () => {
    const stub = await installShapeStub({
      goalWalkState: (p) => walk({ dispatchId: p.dispatchId, status: 'completed', reached: true, executionId: 'walk-satisfier-9z', selectedTemplateId: 'satisfier:shellResult' }),
    });
    const out = await goalStatus({ dispatch_id: 'd-s' }, apiClient);
    expect(out).toContain('(a satisfier reach persists no task trace; goal_reasoning d-s shows the walk)');
    expect(out).not.toContain('read it with execution_trace');
    expect(stub.calls('activityExecutionTrace')).toHaveLength(0);
  });

  test('goal_status reads the goalWalkState record goal-host wraps', async () => {
    const stub = await installShapeStub({
      goalWalkState: (p) => walk({ dispatchId: p.dispatchId, status: 'running', reached: null, operator: 'operator-a', walkLog: ['[goal-host-vessel] selecting template'] }),
    });
    const out = await goalStatus({ dispatch_id: 'd-s' }, apiClient);
    expect(stub.calls('goalWalkState')).toEqual([{ type: 'goalWalkState', dispatchId: 'd-s' }]);
    expect(out.split('\n').slice(0, 4)).toEqual([
      'Dispatch d-s',
      '  reached:            (running)',
      '  (reached = the goal verdict; status below is only the template exit status)',
      '  status:             running',
    ]);
    expect(out).toContain('  operator:           operator-a');
    expect(out).toContain('selecting template');
  });

  test("goal-host's 404 is the pruned-dispatch message", async () => {
    await installShapeStub({ goalWalkState: () => ({ status: 404, body: { resolved: false, shape: 'goalWalkState', error: 'dispatch not found' } }) });
    expect(await goalStatus({ dispatch_id: 'gone' }, apiClient)).toStartWith('goal_status: dispatch gone not found.');
    expect(await goalReasoning({ dispatch_id: 'gone' }, apiClient)).toStartWith('goal_reasoning: dispatch gone not found.');
  });

  test('no producer for goalWalkState is one named line', async () => {
    await installShapeStub({});
    expect(await goalStatus({ dispatch_id: 'd' }, apiClient)).toBe("goal_status: no_producer(goalWalkState): no producer answered, or goal-host has no dispatch d (unknown, or pruned from its in-memory records); discovery's peer forward does not say which");
  });
});

describe('provide_feedback', () => {
  // A misrouted walk records no selected template; its trace row still names the activity that closed it.
  test('a walk with no selected template is labelled with the activity its trace row names', async () => {
    const stub = await installShapeStub({
      goalWalkState: (p) => walk({ dispatchId: p.dispatchId, status: 'completed', reached: false, goal: 'g', executionId: 'walk-satisfier-1a2b' }),
      executionTraceList: () => ({ body: { success: true, content: { content: { traces: [
        { id: 'walk-satisfier-1a2b', templateId: 'satisfier:goal-host-walk-failed', status: 'failure', pointer: { executionId: 'walk-satisfier-1a2b' } },
      ] } } } }),
      goal_verification_label_write: () => ({ body: { success: true, content: JSON.stringify({ id: 'goal_verification_labels:m' }) } }),
    });
    const out = await provideFeedback({ dispatch_id: 'd-m', verdict: 'not_reached', rationale: 'misrouted to federation_probe' }, apiClient);
    expect(stub.calls('goal_verification_label_write')[0]).toMatchObject({ execution_id: 'walk-satisfier-1a2b', activity_id: 'satisfier:goal-host-walk-failed', verdict: 'not_achieved' });
    expect(out).toContain('activity_id:  satisfier:goal-host-walk-failed (the dispatch record named no template; satisfier:goal-host-walk-failed is from its execution trace)');
  });

  test('with no activity anywhere it refuses, and says where the assessment goes instead', async () => {
    await installShapeStub({
      goalWalkState: (p) => walk({ dispatchId: p.dispatchId, status: 'completed', reached: false, goal: 'g', executionId: 'exec-gone' }),
      executionTraceList: () => ({ body: { success: true, content: { content: { traces: [] } } } }),
    });
    const out = await provideFeedback({ dispatch_id: 'd-n', verdict: 'not_reached', rationale: 'r' }, apiClient);
    expect(out).toContain('provide_feedback cannot write a label');
    expect(out).toContain('record_finding (category "goal-routing"');
  });

  test('derives the label from goalWalkState and writes goal_verification_label_write once', async () => {
    const stub = await installShapeStub({
      goalWalkState: (p) => walk({ dispatchId: p.dispatchId, status: 'completed', reached: true, goal: 'make it green', executionId: 'exec-1', selectedTemplateId: 'tmpl-1' }),
      goal_verification_label_write: () => ({ body: { success: true, content: JSON.stringify({ id: 'goal_verification_labels:abc' }) } }),
    });
    const out = await provideFeedback({ dispatch_id: 'd-f', verdict: 'reached', rationale: 'diff checked' }, apiClient);
    expect(stub.calls('goal_verification_label_write')).toEqual([{
      type: 'goal_verification_label_write', goal: 'make it green', execution_id: 'exec-1', activity_id: 'tmpl-1',
      verdict: 'achieved', confidence: 0.9, labeler: 'automated', notes: `diff checked [operator: ${UNIDENTIFIED_OPERATOR}] [session: ${sessionId()}]`,
    }]);
    expect(out).toContain('Feedback recorded for dispatch d-f');
    expect(out).toContain('  oracle label: goal_verification_labels:abc');
  });

  test('never labels an agent verdict as human', async () => {
    const stub = await installShapeStub({
      goalWalkState: (p) => walk({ dispatchId: p.dispatchId, status: 'completed', reached: false, goal: 'g', executionId: 'e', selectedTemplateId: 't' }),
      goal_verification_label_write: () => ({ body: { success: true, content: '{}' } }),
    });
    for (const verdict of ['reached', 'not_reached', 'partial'] as const) {
      await provideFeedback({ dispatch_id: `d-${verdict}`, verdict, rationale: 'r' }, apiClient);
    }
    const labelers = stub.calls('goal_verification_label_write').map((c: any) => c.labeler);
    expect(labelers).toEqual(['automated', 'automated', 'automated']);
  });

  test('a still-running dispatch is refused before any write', async () => {
    const stub = await installShapeStub({ goalWalkState: (p) => walk({ dispatchId: p.dispatchId, status: 'running' }) });
    expect(await provideFeedback({ dispatch_id: 'd-r', verdict: 'partial', rationale: 'r' }, apiClient)).toContain('is still running');
    expect(stub.calls('goal_verification_label_write')).toEqual([]);
  });
  // Through a spoke, a hub producer's 400 ("goal, execution_id, … are required") is relayed by discovery's peer
  // forward as its own no-producer 404.
  test("a label write the peer forward flattens to discovery's 404 says it may have been refused", async () => {
    await installShapeStub({
      goalWalkState: (p) => walk({ dispatchId: p.dispatchId, status: 'completed', reached: true, goal: 'g', executionId: 'e', selectedTemplateId: 't' }),
      goal_verification_label_write: () => ({ status: 404, body: { error: 'Not found', shape: 'goal_verification_label_write' } }),
    });
    const out = await provideFeedback({ dispatch_id: 'd-x', verdict: 'reached', rationale: 'r' }, apiClient);
    expect(out).toStartWith('provide_feedback: no_producer(goal_verification_label_write): ');
    expect(out).toContain('the producer refused the label');
    expect(out).toContain('does not say which');
    expect(out).toContain('no label was written');
  });
});

describe('what a walk taught the substrate', () => {
  test('learningLines reports goal-host\'s learning consequences, and says when none are reported', async () => {
    const { learningLines } = await import('../../src/tools/_goal-host.js');
    expect(learningLines(null)).toEqual(['  learning:           not reported by goal-host for this dispatch']);
    expect(learningLines({ alphaBetaDelta: [], gapsFiled: [], goalPathRecorded: false, oracleLabelWritten: false })).toEqual(['  learning:           none recorded']);
    expect(learningLines({ alphaBetaDelta: [{ templateId: 'satisfier:shellResult', dAlpha: 2 }], gapsFiled: ['gap-x'], goalPathRecorded: true, oracleLabelWritten: false }))
      .toEqual(['  learning:           goal path recorded; posteriors satisfier:shellResult α+2; gaps filed gap-x']);
  });

  test('flags an observe request whose walk taught the substrate anyway', async () => {
    const { learningLines } = await import('../../src/tools/_goal-host.js');
    const taught = learningLines({ goalPathRecorded: true, alphaBetaDelta: [{ templateId: 't', dBeta: 1 }] }, 'observe');
    expect(taught[1]).toContain('observe was requested, but this walk taught the substrate');
    // goal-host sets goalPathRecorded under observe without writing; alone it is not a mismatch.
    const flagOnly = learningLines({ goalPathRecorded: true, alphaBetaDelta: [], gapsFiled: [] }, 'observe');
    expect(flagOnly[1]).toContain('sets that flag without writing one under observe');
    expect(flagOnly.join('\n')).not.toContain('⚠');
    expect(learningLines({ goalPathRecorded: false, alphaBetaDelta: [] }, 'observe')).toEqual(['  learning:           none recorded']);
  });

  test('a graded template with Δ0 is not a posterior change', async () => {
    const { learningLines } = await import('../../src/tools/_goal-host.js');
    // goal-host's record for an observe probe on the lab: the template is listed, unmoved.
    const observed = { alphaBetaDelta: [{ templateId: 'satisfier:shellResult', dAlpha: 0, dBeta: 0 }], gapsFiled: [], goalPathRecorded: true, oracleLabelWritten: false };
    const lines = learningLines(observed, 'observe');
    expect(lines[0]).toBe('  learning:           goal path recorded');
    expect(lines.join('\n')).not.toContain('⚠');
    expect(learningLines({ ...observed, goalPathRecorded: false })).toEqual(['  learning:           none recorded']);
    expect(learningLines({ alphaBetaDelta: [{ templateId: 't', dAlpha: 0, dBeta: -1 }] })[0]).toBe('  learning:           posteriors t β-1');
  });

  test('goal_status shows the learning line for a finished dispatch', async () => {
    await installShapeStub({
      goalWalkState: (p) => walk({ dispatchId: p.dispatchId, status: 'completed', reached: true,
        learning: { alphaBetaDelta: [], gapsFiled: [], goalPathRecorded: true, oracleLabelWritten: false } }),
    });
    expect(await goalStatus({ dispatch_id: 'd-m' }, apiClient)).toContain('learning:           goal path recorded');
  });
});

// ===== Who dispatched: the validated principal, never the claimed label =====

describe('principal rendering', () => {
  const finished = { status: 'completed', reached: true, executionId: 'e', selectedTemplateId: 't' };
  const cases = {
    operator: { ...finished, operator: 'avi', operator_label: 'avi',
      principal: { kind: 'key', operator: true, tag: '0123456789ab' } },
    nonOperator: { ...finished, operator: null, operator_label: 'claude-code-operator',
      principal: { kind: 'key', operator: false, tag: 'abcdef012345' } },
    absent: { ...finished, operator: 'claude-code-operator' },
  } as const;
  const WARNING = 'ran without operator authority: an ordinary keyed caller; directed edits and operator priority do not apply';

  async function render(tool: 'goal_status' | 'goal_reasoning' | 'run_goal', record: Record<string, unknown>) {
    await installShapeStub({
      goalWalkState: (p) => walk({ dispatchId: p.dispatchId, ...record }),
      goalDispatchAsync: () => ({ status: 202, body: { dispatchId: 'd-p', status: 'running' } }),
      activityExecutionTrace: () => ({ status: 404, body: { error: 'not found' } }),
    });
    if (tool === 'goal_status') return goalStatus({ dispatch_id: 'd-p' }, apiClient);
    if (tool === 'goal_reasoning') return goalReasoning({ dispatch_id: 'd-p' }, apiClient);
    return runGoal({ goal: 'g' }, apiClient);
  }

  for (const tool of ['goal_status', 'goal_reasoning', 'run_goal'] as const) {
    test(`${tool}: an operator principal shows validated authority and no warning`, async () => {
      const out = await render(tool, cases.operator);
      expect(out).toContain('principal:          key (0123456789ab)');
      expect(out).toContain('operator authority: yes (validated)');
      expect(out).not.toContain(WARNING);
    });

    test(`${tool}: a labelled non-operator shows the claim as unverified and says it ran without authority`, async () => {
      const out = await render(tool, cases.nonOperator);
      expect(out).toContain('principal:          key (abcdef012345)');
      expect(out).toContain('operator label:     claude-code-operator (claimed, unverified)');
      expect(out).toContain(WARNING);
    });

    test(`${tool}: absent principal fields read "not reported", never non-operator`, async () => {
      const out = await render(tool, cases.absent);
      expect(out).toContain('principal:          not reported');
      expect(out).not.toContain(WARNING);
    });
  }

  test('a pre-amendment raw key label is never displayed', async () => {
    const { principalLines } = await import('../../src/tools/_goal-host.js');
    const lines = principalLines({ principal: { kind: 'key', operator: false, label: 'key:key_SECRETID' } });
    expect(lines.join('\n')).not.toContain('key_SECRETID');
    expect(lines[0]).toContain('key id withheld');
    const nodeSelf = principalLines({ principal: { kind: 'node_self', operator: false, tag: 'node-self:in-process' } });
    expect(nodeSelf[0]).toBe('  principal:          node_self (node-self:in-process)');
    // The node's own key is not "an ordinary keyed caller"; the line says what it is.
    expect(nodeSelf.join('\n')).toContain('ran without operator authority (node self-call)');
    expect(nodeSelf.join('\n')).not.toContain('an ordinary keyed caller');
  });
});
