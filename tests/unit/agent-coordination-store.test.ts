import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { LocalStore, type AgentTaskRecord } from '../../src/local-store';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshStore(): { store: LocalStore; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-coord-'));
  dirs.push(dir);
  const dbPath = join(dir, 'sidecar.db');
  const store = new LocalStore(dbPath);
  store.init();
  return { store, dbPath };
}

function task(over: Partial<AgentTaskRecord> = {}): AgentTaskRecord {
  return {
    task_id: 'sid-1',
    vessel_id: 'metabob-mcp-aaa',
    operator_id: 'claude-code-operator',
    session_id: 'sess-1',
    shape: 'human_input',
    dispatch_id: 'disp-1',
    question_markdown: '## Decide X',
    respond_via_json: JSON.stringify({ shape: 'solicitationResponse_write' }),
    deadline_ms: Date.now() + 300_000,
    status: 'pending',
    enqueued_at: Date.now(),
    claimed_at: null,
    ...over,
  };
}

describe('agent task queue', () => {
  test('enqueue → list → claim', () => {
    const { store } = freshStore();
    store.enqueueAgentTask(task());
    const pending = store.listPendingAgentTasks('metabob-mcp-aaa');
    expect(pending.length).toBe(1);
    expect(pending[0]!.question_markdown).toBe('## Decide X');

    const claimed = store.claimAgentTask('metabob-mcp-aaa', 'sid-1', 'sess-2');
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.session_id).toBe('sess-2');
  });

  test('enqueue is idempotent on (vessel_id, task_id)', () => {
    const { store } = freshStore();
    store.enqueueAgentTask(task());
    store.enqueueAgentTask(task({ question_markdown: '## Different' }));
    const pending = store.listPendingAgentTasks('metabob-mcp-aaa');
    expect(pending.length).toBe(1);
    expect(pending[0]!.question_markdown).toBe('## Decide X'); // first write wins
  });

  test('tasks are partitioned by vessel_id', () => {
    const { store } = freshStore();
    store.enqueueAgentTask(task({ vessel_id: 'metabob-mcp-aaa' }));
    store.enqueueAgentTask(task({ vessel_id: 'metabob-mcp-bbb', task_id: 'sid-2' }));
    expect(store.listPendingAgentTasks('metabob-mcp-aaa').length).toBe(1);
    expect(store.listPendingAgentTasks('metabob-mcp-bbb').length).toBe(1);
    expect(store.listPendingAgentTasks('metabob-mcp-ccc').length).toBe(0);
  });

  test('expired tasks drop out of the pending list', () => {
    const { store } = freshStore();
    store.enqueueAgentTask(task({ deadline_ms: Date.now() - 1 }));
    expect(store.listPendingAgentTasks('metabob-mcp-aaa').length).toBe(0);
    store.expireStaleTasks('metabob-mcp-aaa');
    expect(store.getAgentTask('metabob-mcp-aaa', 'sid-1')?.status).toBe('resolved');
  });
});

describe('resolutions + delivery tracking', () => {
  test('record → undelivered → mark delivered', () => {
    const { store } = freshStore();
    store.enqueueAgentTask(task());
    store.recordResolution({
      task_id: 'sid-1', vessel_id: 'metabob-mcp-aaa', outcome: 'answered',
      answer: 'use B', delivered: 0, attempts: 0, last_attempt_at: null,
      last_error: null, created_at: Date.now(),
    });
    // recording an answer flips the task to resolved
    expect(store.getAgentTask('metabob-mcp-aaa', 'sid-1')?.status).toBe('resolved');

    const undelivered = store.getUndeliveredResolutions('metabob-mcp-aaa');
    expect(undelivered.length).toBe(1);
    expect(undelivered[0]!.answer).toBe('use B');

    store.markResolutionDelivered('metabob-mcp-aaa', 'sid-1');
    expect(store.getUndeliveredResolutions('metabob-mcp-aaa').length).toBe(0);
  });

  test('failed delivery bumps attempts + records error', () => {
    const { store } = freshStore();
    store.recordResolution({
      task_id: 'sid-1', vessel_id: 'metabob-mcp-aaa', outcome: 'answered',
      answer: 'x', delivered: 0, attempts: 0, last_attempt_at: null,
      last_error: null, created_at: Date.now(),
    });
    store.bumpResolutionAttempt('metabob-mcp-aaa', 'sid-1', 'ECONNREFUSED');
    const r = store.getUndeliveredResolutions('metabob-mcp-aaa')[0]!;
    expect(r.attempts).toBe(1);
    expect(r.last_error).toBe('ECONNREFUSED');
  });
});

describe('cross-session durability', () => {
  test('a task + undelivered resolution survive a store re-open (new session, same DB)', () => {
    const { store, dbPath } = freshStore();
    store.enqueueAgentTask(task());
    store.recordResolution({
      task_id: 'sid-1', vessel_id: 'metabob-mcp-aaa', outcome: 'answered',
      answer: 'persisted', delivered: 0, attempts: 0, last_attempt_at: null,
      last_error: null, created_at: Date.now(),
    });
    store.close();

    // Simulate a NEW session/process: same on-disk DB, same vesselId.
    const next = new LocalStore(dbPath);
    next.init();
    const undelivered = next.getUndeliveredResolutions('metabob-mcp-aaa');
    expect(undelivered.length).toBe(1);
    expect(undelivered[0]!.answer).toBe('persisted');
    // and the task row is still there (now resolved)
    expect(next.getAgentTask('metabob-mcp-aaa', 'sid-1')?.task_id).toBe('sid-1');
    next.close();
  });
});
