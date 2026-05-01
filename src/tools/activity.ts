import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

export const ActivityTool = {
  name: 'activity',
  description:
    'Unified activity lifecycle tool for devbob workflow integration. Use action="resolve_impulse" to route an impulse, "run_goal" to execute a goal, "get_recommendations" to get Thompson Sampling recommendations, or "submit_trace" to record an execution trace.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['resolve_impulse', 'run_goal', 'get_recommendations', 'submit_trace'],
        description: 'Which activity operation to perform',
      },
      impulse: {
        type: 'object',
        description: 'Required for action=resolve_impulse',
        properties: {
          pointer: {
            type: 'object',
            properties: {
              type: { type: 'string' },
            },
            required: ['type'],
          },
          metadata: {
            type: 'object',
            properties: {
              shape: { type: 'string' },
              intent: { type: 'string' },
              domain: { type: 'string' },
              complexity: { type: 'number' },
            },
          },
        },
      },
      goal: {
        type: 'object',
        description: 'Required for action=run_goal',
        properties: {
          goal_id: { type: 'string' },
          parameters: { type: 'object' },
        },
      },
      recommendations: {
        type: 'object',
        description: 'Required for action=get_recommendations',
        properties: {
          context: { type: 'object' },
          limit: { type: 'number', default: 5 },
        },
      },
      trace: {
        type: 'object',
        description: 'Required for action=submit_trace',
        properties: {
          goal_id: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string' },
                input: { type: 'object' },
                output: { type: 'string' },
                duration_ms: { type: 'number' },
                success: { type: 'boolean' },
              },
            },
          },
          outcome: { type: 'string', enum: ['success', 'failure', 'partial'] },
          total_duration_ms: { type: 'number' },
        },
      },
    },
    required: ['action'],
  },
};

const ImpulseSchema = z.object({
  pointer: z.object({ type: z.string() }).and(z.record(z.unknown())),
  metadata: z.record(z.unknown()).optional(),
});

const TraceStepSchema = z.object({
  tool: z.string(),
  input: z.record(z.unknown()),
  output: z.string(),
  duration_ms: z.number(),
  success: z.boolean(),
});

export const InputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('resolve_impulse'),
    impulse: ImpulseSchema,
  }),
  z.object({
    action: z.literal('run_goal'),
    goal: z.object({
      goal_id: z.string(),
      parameters: z.record(z.unknown()).optional(),
    }),
  }),
  z.object({
    action: z.literal('get_recommendations'),
    recommendations: z.object({
      context: z.record(z.unknown()),
      limit: z.number().int().positive().default(5),
    }),
  }),
  z.object({
    action: z.literal('submit_trace'),
    trace: z.object({
      goal_id: z.string(),
      steps: z.array(TraceStepSchema),
      outcome: z.enum(['success', 'failure', 'partial']),
      total_duration_ms: z.number(),
    }),
  }),
]);

export type ActivityInput = z.infer<typeof InputSchema>;

export async function handle(
  input: ActivityInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
): Promise<string> {
  const startTime = Date.now();

  let result: Record<string, unknown>;

  switch (input.action) {
    case 'resolve_impulse':
      // List learned impulses from the analysis API
      result = await apiClient.get<Record<string, unknown>>('/v2/impulses/learned', {}, sessionId);
      break;
    case 'run_goal':
      result = await apiClient.post<Record<string, unknown>>('/v2/activities/record/start', input.goal, sessionId);
      break;
    case 'get_recommendations':
      result = await apiClient.post<Record<string, unknown>>('/activity-recommendations/recommendations', input.recommendations, sessionId);
      break;
    case 'submit_trace':
      result = await apiClient.post<Record<string, unknown>>('/v2/activities/record/complete', input.trace, sessionId);
      break;
  }
  const duration = Date.now() - startTime;

  let text = `Activity: ${input.action}\n\n`;
  text += JSON.stringify(result, null, 2);
  text += `\n\nCompleted in ${duration}ms`;
  return text;
}
