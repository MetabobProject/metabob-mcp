/**
 * pull_assigned_work — the agent claims work the substrate dispatched to it.
 *
 * The other half of "Claude-Code-as-implicit-vessel" (goal_reasoning is the
 * read half): the substrate solicits a decision (human_input), the vessel
 * durably enqueues it, and the agent drains the queue here. Durable + keyed by
 * the stable vesselId, so a task assigned in one session is claimable in a
 * later one. Answer each with submit_resolution.
 */

import { z } from 'zod';
import type { LocalStore } from '../local-store.js';
import { getResolverVesselId } from '../resolver-identity.js';

export const PullAssignedWorkTool = {
  name: 'pull_assigned_work',
  description:
    'Claim tasks the substrate has dispatched to you as an agent-resolver (e.g. a solicited decision it needs from you). Returns each task_id and its question; answer with submit_resolution. Tasks persist across sessions, so this surfaces work assigned while you were away.',
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
