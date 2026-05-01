import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

export const AnnotateComponentTool = {
  name: 'annotate_component',
  description:
    'Get an AI-generated explanation or recommendation for a detected problem. Use "explain" to understand the root cause, or "recommend" to get a concrete fix suggestion.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      problem_id: {
        type: 'string',
        description: 'Problem ID from get_problems',
      },
      mode: {
        type: 'string',
        description: '"explain" — AI explanation of the problem. "recommend" — AI fix recommendation.',
        enum: ['explain', 'recommend'],
        default: 'explain',
      },
      context: {
        type: 'string',
        description: 'Additional context to guide the explanation (optional)',
      },
    },
    required: ['problem_id'],
  },
};

export const InputSchema = z.object({
  problem_id: z.string().min(1),
  mode: z.enum(['explain', 'recommend']).default('explain'),
  context: z.string().optional(),
});

export type AnnotateComponentInput = z.infer<typeof InputSchema>;

interface ExplainResponse { prompt?: string | null; description: string }
interface RecommendResponse { prompt?: string | null; recommendation: string }

export async function handle(
  input: AnnotateComponentInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
): Promise<string> {
  const startTime = Date.now();

  if (input.mode === 'explain') {
    const result = await apiClient.post<ExplainResponse>(
      '/explain',
      { problemId: input.problem_id, context: input.context },
      sessionId,
    );
    const duration = Date.now() - startTime;
    let text = `Explanation for ${input.problem_id}\n${'═'.repeat(40)}\n\n`;
    text += result.description || '(no explanation returned)';
    text += `\n\nGenerated in ${duration}ms`;
    return text;
  }

  const result = await apiClient.post<RecommendResponse>(
    '/recommend',
    { problemId: input.problem_id, context: input.context },
    sessionId,
  );
  const duration = Date.now() - startTime;
  let text = `Recommendation for ${input.problem_id}\n${'═'.repeat(40)}\n\n`;
  text += result.recommendation || '(no recommendation returned)';
  text += `\n\nGenerated in ${duration}ms`;
  return text;
}
