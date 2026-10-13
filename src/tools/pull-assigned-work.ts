// Contract (input schema, behaviour): SPEC §pull_assigned_work
/**
 * pull_assigned_work — the agent claims work the substrate dispatched to it.
 *
 * The other half of "Claude-Code-as-implicit-vessel" (goal_reasoning is the
 * read half): the substrate solicits a decision (human_input), the vessel
 * durably enqueues it, and the agent drains the queue here. Durable + keyed by
 * the stable vesselId, so a task assigned in one session is claimable in a
 * later one. Answer each with submit_resolution.
 *
 * The queue fills only while the session advertises human_input, which is
 * opt-in (METABOB_AGENT_RESOLVER). With the role off and nothing queued, the
 * tool says that nothing can arrive rather than reporting an empty queue an
 * agent would keep polling. A task already queued is listed either way: an
 * inbound human_input impulse is enqueued whether or not it was advertised.
 */

import { z } from 'zod';
import type { LocalStore } from '../local-store.js';
import { getResolverVesselId } from '../resolver-identity.js';
import { agentResolverEnabled } from '../vessel-identity.js';

/** Why the queue is empty and stays empty while the agent-resolver role is off. CONFORMANCE §c7-shapes */
export const NO_INBOUND_OFFER =
  'No assigned work, and none can arrive: this session does not advertise human_input, so the substrate ' +
  'has no inbound offer to dispatch a task to (human_input is opt-in, CONFORMANCE §c7-shapes). ' +
  'Set METABOB_AGENT_RESOLVER=1 to opt in, only where a human is at this terminal.';

export const PullAssignedWorkTool = {
  name: 'pull_assigned_work',
  description:
    'Claim tasks the substrate has dispatched to you as an agent-resolver (e.g. a solicited decision it needs from you). Returns each task_id and its question; answer with submit_resolution. Tasks persist across sessions, so this surfaces work assigned while you were away. Work is dispatched here only when this session opts in to the agent-resolver role (METABOB_AGENT_RESOLVER=1, off by default); without it the tool reports that nothing can arrive.',
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
    return 'Agent-resolver coordination is unavailable (the local store is not active — not in sidecar mode).';
  }
  const vesselId = getResolverVesselId();
  if (!vesselId) {
    return 'No coordination identity yet — a configured API key + workspace is required to receive assigned work.';
  }

  localStore.expireStaleTasks(vesselId);
  const tasks = localStore.listPendingAgentTasks(vesselId, input.limit ?? 10);
  if (tasks.length === 0) {
    if (!agentResolverEnabled()) return NO_INBOUND_OFFER;
    return 'No assigned work. The substrate has not dispatched any tasks to this agent-resolver.';
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
