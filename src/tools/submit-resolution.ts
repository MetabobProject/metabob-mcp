// Contract (input schema, behaviour): SPEC §submit_resolution
/**
 * submit_resolution — the agent answers a task the substrate dispatched to it.
 *
 * Records the answer durably FIRST (so it survives a failed post-back), then
 * delivers it to the substrate as solicitationResponse_write, unblocking the
 * parked walk. If delivery fails (substrate briefly unreachable), the answer
 * stays queued and is retried on the next session's startup reconcile — the
 * cross-session "provide information back" guarantee.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import type { LocalStore } from '../local-store.js';
import { getResolverVesselId } from '../resolver-identity.js';
import { deliverResolution } from '../agent-delivery.js';

export const SubmitResolutionTool = {
  name: 'submit_resolution',
  description:
    'Answer a task the substrate dispatched to you (from pull_assigned_work). The answer is recorded durably and delivered back to the substrate to unblock its walk; if the substrate is briefly unreachable it is retried automatically on a later session. Use outcome "answered" with an answer, "declined" to pass, or "insufficient_context" if you lack what you would need. This session advertises nothing to the substrate, so the substrate dispatches no tasks to it.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'The task_id from pull_assigned_work' },
      outcome: {
        type: 'string',
        enum: ['answered', 'declined', 'insufficient_context'],
        description: 'answered (provide answer) | declined | insufficient_context',
      },
      answer: { type: 'string', description: 'Your answer (required when outcome is "answered")' },
    },
    required: ['task_id', 'outcome'],
  },
};

export const InputSchema = z
  .object({
    task_id: z.string().min(1),
    outcome: z.enum(['answered', 'declined', 'insufficient_context']),
    answer: z.string().optional(),
  })
  .refine((v) => v.outcome !== 'answered' || (!!v.answer && v.answer.trim().length > 0), {
    message: 'answer is required when outcome is "answered"',
    path: ['answer'],
  });

export async function handle(
  input: z.infer<typeof InputSchema>,
  apiClient: AnalysisAPIClient,
  _sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  if (!localStore) {
    return 'Agent-resolver coordination is unavailable: the local store failed to open (see the startup log).';
  }
  const vesselId = getResolverVesselId();
  if (!vesselId) {
    return 'No coordination identity yet — a configured API key + workspace is required.';
  }

  const task = localStore.getAgentTask(vesselId, input.task_id);
  if (!task) {
    return `No assigned task "${input.task_id}" — it may have been resolved or expired, or never queued: this session advertises nothing to the substrate, so the substrate dispatches no tasks to it (CONFORMANCE §c11-attachment-model). Run pull_assigned_work to see the queue.`;
  }

  const answer = input.outcome === 'answered' ? (input.answer ?? '') : null;
  // Durability first: record the answer before attempting delivery.
  localStore.recordResolution({
    task_id: input.task_id,
    vessel_id: vesselId,
    outcome: input.outcome,
    answer,
    delivered: 0,
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
    created_at: Date.now(),
  });

  const res = { task_id: input.task_id, vessel_id: vesselId, outcome: input.outcome, answer,
    delivered: 0, attempts: 0, last_attempt_at: null, last_error: null, created_at: Date.now() };
  const outcome = await deliverResolution(apiClient, res);

  if (outcome.ok) {
    localStore.markResolutionDelivered(vesselId, input.task_id);
    return `Resolution for ${input.task_id} delivered to the substrate (outcome: ${input.outcome}).`;
  }
  if (outcome.terminal) {
    localStore.markResolutionDelivered(vesselId, input.task_id);
    return `Recorded ${input.task_id}, but the substrate is no longer waiting for it (${outcome.error}). No retry.`;
  }
  localStore.bumpResolutionAttempt(vesselId, input.task_id, outcome.error ?? 'unknown');
  return `Recorded ${input.task_id} durably, but delivery failed (${outcome.error}). It will be retried automatically on the next session.`;
}
