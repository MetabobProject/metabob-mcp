import { afterEach, describe, expect, test } from 'bun:test';

import { resolveImpulseContent, isAgentTaskShape } from '../../src/vessel-server';
import { LocalStore } from '../../src/local-store';
import { setResolverIdentity } from '../../src/resolver-identity';
import { cleanupTempStores, makeTempStore } from '../helpers/temp-store';

afterEach(cleanupTempStores);

function freshStore(): LocalStore {
  return makeTempStore('mcp-inbound-').store;
}

describe('isAgentTaskShape', () => {
  test('human_input is an agent-task shape; code shapes are not', () => {
    expect(isAgentTaskShape('human_input')).toBe(true);
    expect(isAgentTaskShape('code:cochange_prediction')).toBe(false);
    expect(isAgentTaskShape(undefined)).toBe(false);
  });
});

describe('inbound enqueue via resolveImpulseContent', () => {
  test('a human_input pointer is durably enqueued and ACKed', async () => {
    const store = freshStore();
    setResolverIdentity({ vesselId: 'metabob-mcp-test', operatorId: 'claude-code-operator' });

    const pointer = {
      type: 'human_input',
      solicitation_id: 'sid-42',
      dispatch_id: 'disp-9',
      question_markdown: '## Should we retire X?',
      timeout_ms: 300_000,
      respond_via: { shape: 'solicitationResponse_write', heartbeat_shape: 'solicitationHeartbeat_write' },
    };

    const { toolName, content } = await resolveImpulseContent(pointer, {} as any, 'sess-A', store);
    expect(toolName).toBe('human_input');
    const ack = JSON.parse(content as string);
    expect(ack.accepted).toBe(true);
    expect(ack.solicitation_id).toBe('sid-42');
    expect(ack.will_respond_via).toBe('solicitationResponse_write');

    // durably queued under the vesselId
    const pending = store.listPendingAgentTasks('metabob-mcp-test');
    expect(pending.length).toBe(1);
    expect(pending[0]!.task_id).toBe('sid-42');
    expect(pending[0]!.question_markdown).toBe('## Should we retire X?');
    expect(pending[0]!.dispatch_id).toBe('disp-9');
  });

  test('a non-decision-ready human_input is rejected (throws → loaded:false)', async () => {
    const store = freshStore();
    setResolverIdentity({ vesselId: 'metabob-mcp-test', operatorId: 'op' });
    await expect(
      resolveImpulseContent({ type: 'human_input', solicitation_id: 's', question_markdown: '   ' }, {} as any, 'sess', store),
    ).rejects.toThrow(/insufficient_context/);
  });

  test('enqueue is unavailable without a vesselId', async () => {
    const store = freshStore();
    setResolverIdentity({ vesselId: undefined });
    await expect(
      resolveImpulseContent({ type: 'human_input', solicitation_id: 's', question_markdown: '## Q' }, {} as any, 'sess', store),
    ).rejects.toThrow(/coordination unavailable/);
  });
});
