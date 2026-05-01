import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

export const GenerateSpecTool = {
  name: 'generate_spec',
  description:
    'Generate a fix plan for a set of problems. Calls POST /recommend for each problem ID and compiles the results into a structured action plan.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      problem_ids: {
        type: 'array',
        description: 'Problem IDs from get_problems to generate recommendations for (max 10)',
        items: { type: 'string' },
      },
      context: {
        type: 'string',
        description: 'Additional context to guide recommendations (optional, max 500 chars)',
      },
    },
    required: ['problem_ids'],
  },
};

export const InputSchema = z.object({
  problem_ids: z.array(z.string().min(1)).min(1).max(10),
  context: z.string().max(500).optional(),
});

export type GenerateSpecInput = z.infer<typeof InputSchema>;

interface RecommendResponse { recommendation: string }

export async function handle(
  input: GenerateSpecInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
): Promise<string> {
  const startTime = Date.now();

  const results = await Promise.allSettled(
    input.problem_ids.map(id =>
      apiClient.post<RecommendResponse>('/recommend', { problemId: id, context: input.context }, sessionId)
        .then(r => ({ id, recommendation: r.recommendation })),
    ),
  );

  const duration = Date.now() - startTime;

  let text = `Fix Plan (${input.problem_ids.length} problem${input.problem_ids.length === 1 ? '' : 's'})\n`;
  text += `${'═'.repeat(50)}\n\n`;

  for (let i = 0; i < results.length; i++) {
    const id = input.problem_ids[i]!;
    const r = results[i]!;
    text += `${i + 1}. Problem: ${id}\n`;
    if (r.status === 'fulfilled') {
      text += r.value.recommendation || '(no recommendation)';
    } else {
      text += `   (error: ${(r.reason as Error).message ?? 'unknown'})`;
    }
    text += '\n\n';
  }

  text += `Generated in ${duration}ms`;
  return text;
}
