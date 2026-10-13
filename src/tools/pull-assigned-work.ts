// Contract (input schema, behaviour): SPEC §pull_assigned_work
/**
 * pull_assigned_work — the agent claims work dispatched to it.
 *
 * A human_input impulse that reaches the loopback resolver is durably enqueued,
 * keyed by the stable vesselId, and the agent drains the queue here; a task
 * enqueued in one session is claimable in a later one. Answer each with
 * submit_resolution.
 *
 * The session is a client of the substrate and offers nothing inbound
 * (CONFORMANCE §c11-attachment-model), so the substrate has nowhere to dispatch
 * a task to it. With nothing queued, the tool says that nothing can arrive
 * rather than reporting an empty queue an agent would keep polling.
 */

import { z } from 'zod';
import type { LocalStore } from '../local-store.js';
import { getResolverVesselId } from '../resolver-identity.js';

/** Why the queue is empty and stays empty: nothing is offered inbound. CONFORMANCE §c11-attachment-model */
export const NO_INBOUND_OFFER =
  'No assigned work, and none can arrive: this session is a client of the substrate and advertises no ' +
  'shape, so the substrate has no inbound offer to dispatch a task to (CONFORMANCE §c11-attachment-model).';

export const PullAssignedWorkTool = {
  name: 'pull_assigned_work',
  description:
    'Claim tasks dispatched to you as an agent-resolver (a solicited decision delivered to this session\'s local queue). Returns each task_id and its question; answer with submit_resolution. Tasks persist across sessions. This session advertises nothing to the substrate, so the substrate dispatches nothing here; with the queue empty the tool says that nothing can arrive.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: {
        type: 'number',
        description: 'Max tasks to claim (default 10)',
      },
    },
  },
};

export const InputSchema = z.object({
  limit: z.number().int().positive().max(100).optional(),
});

export async function handle(
  input: z.infer<typeof InputSchema>,
  _apiClient: unknown,
  sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  if (!localStore) {
    return 'Agent-resolver coordination is unavailable: the local store failed to open (see the startup log).';
  }
  const vesselId = getResolverVesselId();
  if (!vesselId) {
    return 'No coordination identity yet — a configured API key + workspace is required to receive assigned work.';
  }

  localStore.expireStaleTasks(vesselId);
  const tasks = localStore.listPendingAgentTasks(vesselId, input.limit ?? 10);
  if (tasks.length === 0) {
    return NO_INBOUND_OFFER;
  }

  const now = Date.now();
  const lines: string[] = [`${tasks.length} assigned task(s):`, ''];
  for (const t of tasks) {
    localStore.claimAgentTask(vesselId, t.task_id, sessionId);
    const remainingS = Math.max(0, Math.round((t.deadline_ms - now) / 1000));
    lines.push(`• task_id: ${t.task_id}`);
    if (t.dispatch_id) lines.push(`  dispatch_id: ${t.dispatch_id}`);
    lines.push(`  respond within: ~${remainingS}s`);
    lines.push('  question:');
    lines.push(t.question_markdown.split('\n').map((l) => `    ${l}`).join('\n'));
    lines.push('');
  }
  lines.push('Answer each with submit_resolution({ task_id, outcome: "answered"|"declined"|"insufficient_context", answer }).');
  return lines.join('\n');
}
