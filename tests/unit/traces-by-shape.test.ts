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
  tags: ['dispatcher_used:light-dispatch', 'reach_graded:true', 'reached:true', 'operator:dev-mcp'],
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
    expect(out).toContain('  operator:dev-mcp');
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
