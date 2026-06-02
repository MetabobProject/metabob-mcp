import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

export const MarkCompleteTool = {
  name: 'mark_complete',
  description:
    'Mark a detected problem as resolved (endorsed = you fixed it) or dismiss it (discarded = false positive). Problem IDs come from get_problems.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      problem_id: {
        type: 'string',
        description: 'Problem ID from get_problems',
      },
      action: {
        type: 'string',
        description: '"endorse" — problem was valid and has been fixed. "discard" — false positive, not a real issue.',
        enum: ['endorse', 'discard'],
        default: 'endorse',
      },
    },
    required: ['problem_id'],
  },
};

export const InputSchema = z.object({
  problem_id: z.string().min(1),
  action: z.enum(['endorse', 'discard']).default('endorse'),
});

export type MarkCompleteInput = z.infer<typeof InputSchema>;

export async function handle(
  input: MarkCompleteInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
): Promise<string> {
  const startTime = Date.now();

  try {
    await apiClient.postFeedback(input.problem_id, sessionId, {
      endorsed: input.action === 'endorse',
      discarded: input.action === 'discard',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err);
    if (msg.includes('404') || msg.includes('not found') || msg.toLowerCase().includes('invalid')) {
      return `Problem ID "${input.problem_id}" not found. Use get_problems to list valid IDs.`;
    }
    return `Failed to update problem: ${msg}`;
  }

  const duration = Date.now() - startTime;
  const verb = input.action === 'endorse' ? 'endorsed (marked resolved)' : 'discarded (marked false positive)';
  return `Problem ${input.problem_id} ${verb} in ${duration}ms`;
}
