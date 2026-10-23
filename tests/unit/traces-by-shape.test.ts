/**
 * Execution traces through the one ingress (src/tools/_traces.ts): the
 * `activityExecutionTrace` shape with `format: "json"`, as activity-api's
 * resolver answers it — `{ success, content: "<row JSON>" }`, the per-task
 * sequence under `execution_trace.tasks`, or 404 for a satisfier-only reach.
 * SPEC §execution_trace
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { setAttachment } from '../../src/attachment';
import { readExecutionTrace } from '../../src/tools/_traces';
import { handle as executionTrace } from '../../src/tools/execution-trace';
import { installShapeStub } from '../helpers/shape-stub';
import type { AnalysisAPIClient } from '../../src/api-client';

const apiClient = {} as AnalysisAPIClient;

afterEach(() => setAttachment(null));

/** A stored execution row as activity-api's legacy path returns it (live node1 form). */
const ROW = {
  activity_id: 'development-vessel:cost-expectation-audit-tick',
  execution_id: 'exec_978a4b53-8a0',
  status: 'success',
  tags: ['dispatcher_used:light-dispatch', 'reach_graded:true', 'reached:true', 'operator:operator-a'],
  output_impulse_shapes: ['costExpectationReport'],
  execution_trace: {
    tasks: [{ resolver_id: 'cost_expectation_scan', resolver_tier: 'deterministic', success: true, output_shapes: ['costExpectationReport'] }],
  },
};

describe('activityExecutionTrace', () => {
  test('sends the execution id with format json, as a read', async () => {
    const stub = await installShapeStub({
      activityExecutionTrace: () => ({ body: { success: true, content: JSON.stringify(ROW) } }),
    });
    const read = await readExecutionTrace('exec_978a4b53-8a0');
    expect(stub.calls('activityExecutionTrace')).toEqual([{ type: 'activityExecutionTrace', executionId: 'exec_978a4b53-8a0', format: 'json' }]);
    expect(read.kind).toBe('ok');
    // The per-task sequence is lifted from execution_trace.tasks.
    expect(read.kind === 'ok' && read.trace.tasks).toEqual(ROW.execution_trace.tasks);
  });

  test('execution_trace renders the row: tags, tasks', async () => {
    await installShapeStub({
      activityExecutionTrace: () => ({ body: { success: true, content: JSON.stringify(ROW) } }),
    });
    const out = await executionTrace({ execution_id: 'exec_978a4b53-8a0' }, apiClient);
    expect(out).toContain('Execution trace exec_978a4b53-8a0');
    expect(out).toContain('  status:               success');
    expect(out).toContain('  activity_template_id: development-vessel:cost-expectation-audit-tick');
    expect(out).toContain('  reached:true');
    expect(out).toContain('  operator:operator-a');
    expect(out).toContain('Tasks (1):');
    expect(out).toContain('  #1 ✓ cost_expectation_scan/deterministic  ∅ → costExpectationReport');
  });

  test("a producer 404 is the satisfier-only message", async () => {
    await installShapeStub({
      activityExecutionTrace: (p) => ({ status: 404, body: { success: false, error: `Execution trace not found: ${p.executionId}` } }),
    });
    const out = await executionTrace({ execution_id: 'e-missing' }, apiClient);
    expect(out).toStartWith('execution_trace: no durable trace for e-missing.');
    expect(out).toContain('satisfier-only reach');
  });

  test('a trace read cut at the producer timeout retries, then reports one named line', async () => {
    const stub = await installShapeStub({
      activityExecutionTrace: () => ({ status: 502, body: { error: 'forward_failed', shape: 'activityExecutionTrace', detail: 'The operation timed out.' } }),
    });
    const out = await executionTrace({ execution_id: 'e1' }, apiClient);
    expect(out).toMatch(/^execution_trace: producer_timeout\(activityExecutionTrace, \d+ms\)/);
    expect(out.split('\n')).toHaveLength(1);
    expect(stub.calls('activityExecutionTrace')).toHaveLength(3);
  });

  test('no producer for the shape is one named line', async () => {
    await installShapeStub({});
    expect(await executionTrace({ execution_id: 'e1' }, apiClient)).toBe(
      "execution_trace: no_producer(activityExecutionTrace): no producer answered, or the trace e1 does not exist (a satisfier-only reach persists no trace); discovery's peer forward does not say which",
    );
  });
});

/** executionTraceList as activity-api answers it (live node1 form, limit 2). */
const LIST = {
  loaded: false,
  metadata: { rowCount: 2, summary: { successCount: 1, failureCount: 1 } },
  content: {
    traces: [
      { id: 'v_paradigm_execution_traces:⟨exec_0d772278-57d⟩', templateId: 'development-vessel:gap_closing_auto', status: 'success', duration_ms: 1256,
        created_at: '2026-10-20T03:52:18.867Z', pointer: { type: 'activityExecutionTrace', executionId: 'v_paradigm_execution_traces:⟨exec_0d772278-57d⟩' } },
      { id: 'v_paradigm_execution_traces:⟨exec_cb46b5aa-b31⟩', templateId: 'development-vessel:feature_compose', status: 'failure', duration_ms: 165,
        created_at: '2026-10-20T03:52:09.413Z', pointer: { type: 'activityExecutionTrace', executionId: 'v_paradigm_execution_traces:⟨exec_cb46b5aa-b31⟩' } },
    ],
  },
};

describe('recent traces: execution_trace with no id', () => {
  test('lists executionTraceList rows with their bare ids, as a read', async () => {
    const stub = await installShapeStub({
      executionTraceList: () => ({ body: { success: true, content: JSON.stringify(LIST) } }),
    });
    const out = await executionTrace({}, apiClient);
    expect(stub.calls('executionTraceList')).toEqual([{ type: 'executionTraceList', limit: 10 }]);
    expect(out).toStartWith('Recent execution traces, newest first: 2 (success 1, failure 1)');
    expect(out).toContain('  exec_0d772278-57d  success 1256ms  development-vessel:gap_closing_auto  2026-10-20T03:52:18.867Z');
    expect(out).toContain('  exec_cb46b5aa-b31  failure 165ms  development-vessel:feature_compose');
    expect(out).not.toContain('⟨');
    expect(out).toContain('Read one: execution_trace { execution_id: "<id>" }.');
  });

  test('passes limit, and says so when nothing is recorded', async () => {
    const stub = await installShapeStub({
      executionTraceList: () => ({ body: { success: true, content: { metadata: { rowCount: 0 }, content: { traces: [] } } } }),
    });
    expect(await executionTrace({ limit: 3 }, apiClient)).toBe('execution_trace: no execution traces are recorded for your org yet.');
    expect(stub.calls('executionTraceList')).toEqual([{ type: 'executionTraceList', limit: 3 }]);
  });

  test('no producer for the listing is one named line', async () => {
    await installShapeStub({});
    expect(await executionTrace({}, apiClient)).toStartWith('execution_trace: no_producer(executionTraceList)');
  });

  test('a stored record id reads as its bare execution id', async () => {
    const stub = await installShapeStub({
      activityExecutionTrace: () => ({ body: { success: true, content: JSON.stringify(ROW) } }),
    });
    await executionTrace({ execution_id: 'v_paradigm_execution_traces:⟨exec_978a4b53-8a0⟩' }, apiClient);
    expect(stub.calls('activityExecutionTrace')[0]?.executionId).toBe('exec_978a4b53-8a0');
  });
});

describe('satisfier reaches', () => {
  test('the listing marks them as having no task trace', async () => {
    await installShapeStub({
      executionTraceList: () => ({ body: { success: true, content: { content: { traces: [
        { id: 'walk-satisfier-1', templateId: 'satisfier:shellResult', status: 'success', pointer: { executionId: 'walk-satisfier-1' } },
      ] } } } }),
    });
    expect(await executionTrace({}, apiClient)).toContain('walk-satisfier-1  success  satisfier:shellResult  (satisfier reach: no task trace; goal_reasoning on its dispatch shows the walk)');
  });

  test('reading one answers with goal_reasoning, and makes no request', async () => {
    const stub = await installShapeStub({ activityExecutionTrace: () => ({ status: 404, body: { error: 'Not found', shape: 'activityExecutionTrace' } }) });
    const out = await executionTrace({ execution_id: 'walk-satisfier-1' }, apiClient);
    expect(out).toStartWith('execution_trace: walk-satisfier-1 is a satisfier reach');
    expect(out).toContain('goal_reasoning { dispatch_id } shows it');
    expect(stub.calls('activityExecutionTrace')).toHaveLength(0);
  });
});
