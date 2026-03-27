/**
 * Activity Tools for Connection Slot System
 *
 * Tools for interacting with the activity API through metabob-mcp:
 * - resolve_impulse: Route impulses through the tiered resolver
 * - run_goal: Execute a goal using activity recommendations
 * - get_recommendations: Get Thompson Sampling recommendations
 * - submit_trace: Submit execution traces
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

// ============================================================================
// resolve_impulse Tool
// ============================================================================

export const ResolveImpulseTool = {
  name: 'resolve_impulse',
  description: 'Resolve an impulse through the tiered resolver system. Uses pattern matching first (free), then escalates to LLM tiers (Haiku → Sonnet → Opus) based on complexity. Returns 402 if budget exceeded.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      impulse: {
        type: 'object',
        description: 'The impulse to resolve',
        properties: {
          pointer: {
            type: 'object',
            description: 'Pointer to the data',
            properties: {
              type: { type: 'string', description: 'Type of pointer (e.g., memo, file, activityTemplate)' },
            },
            required: ['type'],
          },
          metadata: {
            type: 'object',
            description: 'Impulse metadata for routing',
            properties: {
              shape: { type: 'string', description: 'Shape of the impulse (e.g., code_generation, analysis)' },
              intent: { type: 'string', description: 'What the impulse is trying to accomplish' },
              domain: { type: 'string', description: 'Domain context (e.g., typescript, python)' },
              complexity: { type: 'number', description: 'Estimated complexity (0-1)' },
            },
          },
        },
        required: ['pointer'],
      },
      execution_context: {
        type: 'object',
        description: 'Optional execution context',
        properties: {
          execution_id: { type: 'string' },
          activity_id: { type: 'string' },
          task_index: { type: 'number' },
        },
      },
      prefer_tier: {
        type: 'string',
        description: 'Preferred resolution tier (pattern, haiku, sonnet, opus)',
        enum: ['pattern', 'haiku', 'sonnet', 'opus'],
      },
      messages: {
        type: 'array',
        description: 'Direct LLM messages (for advanced use)',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['user', 'assistant'] },
            content: { type: 'string' },
          },
        },
      },
      system: {
        type: 'string',
        description: 'System prompt for LLM (if used)',
      },
      max_tokens: {
        type: 'number',
        description: 'Maximum tokens for LLM response',
      },
    },
    required: ['impulse'],
  },
};

export const ResolveImpulseInputSchema = z.object({
  impulse: z.object({
    pointer: z.object({
      type: z.string(),
    }).passthrough(),
    metadata: z.object({
      shape: z.string().optional(),
      intent: z.string().optional(),
      domain: z.string().optional(),
      complexity: z.number().min(0).max(1).optional(),
    }).passthrough().optional(),
  }),
  execution_context: z.object({
    execution_id: z.string().optional(),
    activity_id: z.string().optional(),
    task_index: z.number().optional(),
  }).optional(),
  prefer_tier: z.enum(['pattern', 'haiku', 'sonnet', 'opus']).optional(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).optional(),
  system: z.string().optional(),
  max_tokens: z.number().positive().optional(),
});

export type ResolveImpulseInput = z.infer<typeof ResolveImpulseInputSchema>;

export async function handleResolveImpulse(
  input: ResolveImpulseInput,
  apiClient: AnalysisAPIClient,
  sessionId: string
): Promise<string> {
  const startTime = Date.now();

  const result = await apiClient.post<{
    resolver_used: string;
    confidence: number;
    result: any;
    cost_usd: number;
    tokens_used: { input: number; output: number };
    pattern_id?: string;
    trace_id?: string;
    thinking?: string;
  }>('/v2/resolve', input, sessionId);

  const duration = Date.now() - startTime;

  // Format response
  let text = `Resolution completed via ${result.resolver_used} tier\n`;
  text += `Confidence: ${(result.confidence * 100).toFixed(0)}%\n`;
  text += `Cost: $${result.cost_usd.toFixed(6)}\n`;
  text += `Tokens: ${result.tokens_used.input} in / ${result.tokens_used.output} out\n`;

  if (result.pattern_id) {
    text += `Pattern ID: ${result.pattern_id}\n`;
  }

  if (result.trace_id) {
    text += `Trace ID: ${result.trace_id}\n`;
  }

  text += `\nResult:\n${JSON.stringify(result.result, null, 2)}`;

  if (result.thinking) {
    text += `\n\nThinking:\n${result.thinking}`;
  }

  text += `\n\nCompleted in ${duration}ms`;

  return text;
}

// ============================================================================
// run_goal Tool
// ============================================================================

export const RunGoalTool = {
  name: 'run_goal',
  description: 'Execute a goal using activity recommendations. Gets Thompson Sampling recommendations for the goal and executes the best-matching activity.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      goal: {
        type: 'string',
        description: 'Natural language description of the goal to achieve',
      },
      category: {
        type: 'string',
        description: 'Activity category filter',
        enum: ['feature', 'bugfix', 'refactor', 'tool', 'infrastructure'],
      },
      context: {
        type: 'object',
        description: 'Additional context for activity selection',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Relevant file paths',
          },
          error_message: {
            type: 'string',
            description: 'Error message (for bugfix goals)',
          },
          requirements: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific requirements',
          },
        },
      },
      dry_run: {
        type: 'boolean',
        description: 'If true, only return recommendations without executing',
        default: false,
      },
    },
    required: ['goal'],
  },
};

export const RunGoalInputSchema = z.object({
  goal: z.string().min(1),
  category: z.enum(['feature', 'bugfix', 'refactor', 'tool', 'infrastructure']).optional(),
  context: z.object({
    files: z.array(z.string()).optional(),
    error_message: z.string().optional(),
    requirements: z.array(z.string()).optional(),
  }).optional(),
  dry_run: z.boolean().default(false),
});

export type RunGoalInput = z.infer<typeof RunGoalInputSchema>;

export async function handleRunGoal(
  input: RunGoalInput,
  apiClient: AnalysisAPIClient,
  sessionId: string
): Promise<string> {
  const startTime = Date.now();

  // Get recommendations
  const recommendations = await apiClient.post<{
    recommendations: Array<{
      template_id: string;
      name: string;
      category: string;
      score: number;
      success_rate: number;
      sample_count: number;
      reasoning: string;
    }>;
    goal_analysis: {
      parsed_intent: string;
      category_match: string;
      complexity_estimate: number;
    };
  }>('/v2/activities/recommend', {
    goal: input.goal,
    category: input.category,
    context: input.context,
  }, sessionId);

  const duration = Date.now() - startTime;

  if (recommendations.recommendations.length === 0) {
    return 'No matching activities found for this goal. Consider creating a new activity template.';
  }

  // Format recommendations
  let text = `Goal: ${input.goal}\n`;
  text += `Analysis:\n`;
  text += `  Intent: ${recommendations.goal_analysis.parsed_intent}\n`;
  text += `  Category: ${recommendations.goal_analysis.category_match}\n`;
  text += `  Complexity: ${(recommendations.goal_analysis.complexity_estimate * 100).toFixed(0)}%\n\n`;
  text += `Top ${recommendations.recommendations.length} recommendations:\n\n`;

  for (let i = 0; i < recommendations.recommendations.length; i++) {
    const rec = recommendations.recommendations[i]!;
    text += `${i + 1}. ${rec.name} (${rec.template_id})\n`;
    text += `   Category: ${rec.category}\n`;
    text += `   Score: ${(rec.score * 100).toFixed(0)}%\n`;
    text += `   Success Rate: ${(rec.success_rate * 100).toFixed(0)}% (${rec.sample_count} samples)\n`;
    text += `   Reasoning: ${rec.reasoning}\n\n`;
  }

  if (input.dry_run) {
    text += `[Dry run - no execution performed]\n`;
    text += `Completed in ${duration}ms`;
    return text;
  }

  // Execute the top recommendation
  const topRec = recommendations.recommendations[0]!;
  text += `\nExecuting: ${topRec.name}...\n`;

  const execution = await apiClient.post<{
    execution_id: string;
    status: string;
    tasks_completed: number;
    tasks_total: number;
    result?: any;
  }>('/v2/activities/execute', {
    template_id: topRec.template_id,
    variables: input.context || {},
  }, sessionId);

  text += `\nExecution Result:\n`;
  text += `  ID: ${execution.execution_id}\n`;
  text += `  Status: ${execution.status}\n`;
  text += `  Tasks: ${execution.tasks_completed}/${execution.tasks_total}\n`;

  if (execution.result) {
    text += `  Result: ${JSON.stringify(execution.result, null, 2)}\n`;
  }

  const totalDuration = Date.now() - startTime;
  text += `\nCompleted in ${totalDuration}ms`;

  return text;
}

// ============================================================================
// get_recommendations Tool
// ============================================================================

export const GetRecommendationsTool = {
  name: 'get_recommendations',
  description: 'Get activity recommendations using Thompson Sampling. Returns ranked list of activities based on goal match and historical performance.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      goal: {
        type: 'string',
        description: 'Natural language description of the goal',
      },
      category: {
        type: 'string',
        description: 'Filter by activity category',
        enum: ['feature', 'bugfix', 'refactor', 'tool', 'infrastructure'],
      },
      limit: {
        type: 'number',
        description: 'Maximum number of recommendations (default: 5)',
        default: 5,
      },
      include_metrics: {
        type: 'boolean',
        description: 'Include detailed performance metrics',
        default: false,
      },
    },
    required: ['goal'],
  },
};

export const GetRecommendationsInputSchema = z.object({
  goal: z.string().min(1),
  category: z.enum(['feature', 'bugfix', 'refactor', 'tool', 'infrastructure']).optional(),
  limit: z.number().int().positive().max(20).default(5),
  include_metrics: z.boolean().default(false),
});

export type GetRecommendationsInput = z.infer<typeof GetRecommendationsInputSchema>;

export async function handleGetRecommendations(
  input: GetRecommendationsInput,
  apiClient: AnalysisAPIClient,
  sessionId: string
): Promise<string> {
  const startTime = Date.now();

  const result = await apiClient.post<{
    recommendations: Array<{
      template_id: string;
      name: string;
      category: string;
      score: number;
      success_rate: number;
      sample_count: number;
      reasoning: string;
      metrics?: {
        avg_duration_ms: number;
        avg_cost_usd: number;
        avg_tokens: number;
        last_executed: string;
      };
    }>;
  }>('/v2/activities/recommend', {
    goal: input.goal,
    category: input.category,
    limit: input.limit,
    include_metrics: input.include_metrics,
  }, sessionId);

  const duration = Date.now() - startTime;

  if (result.recommendations.length === 0) {
    return `No recommendations found for goal: "${input.goal}"`;
  }

  let text = `Recommendations for: "${input.goal}"\n\n`;

  for (let i = 0; i < result.recommendations.length; i++) {
    const rec = result.recommendations[i]!;
    text += `${i + 1}. ${rec.name}\n`;
    text += `   ID: ${rec.template_id}\n`;
    text += `   Category: ${rec.category}\n`;
    text += `   Thompson Score: ${(rec.score * 100).toFixed(1)}%\n`;
    text += `   Success Rate: ${(rec.success_rate * 100).toFixed(0)}% (n=${rec.sample_count})\n`;
    text += `   Reasoning: ${rec.reasoning}\n`;

    if (input.include_metrics && rec.metrics) {
      text += `   Metrics:\n`;
      text += `     Avg Duration: ${rec.metrics.avg_duration_ms}ms\n`;
      text += `     Avg Cost: $${rec.metrics.avg_cost_usd.toFixed(4)}\n`;
      text += `     Avg Tokens: ${rec.metrics.avg_tokens}\n`;
      text += `     Last Used: ${rec.metrics.last_executed}\n`;
    }

    text += '\n';
  }

  text += `Query completed in ${duration}ms`;

  return text;
}

// ============================================================================
// submit_trace Tool
// ============================================================================

export const SubmitTraceTool = {
  name: 'submit_trace',
  description: 'Submit an execution trace to the activity API for learning. Traces feed Thompson Sampling and pattern extraction.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      execution_id: {
        type: 'string',
        description: 'Unique execution identifier',
      },
      template_id: {
        type: 'string',
        description: 'Activity template that was executed',
      },
      status: {
        type: 'string',
        description: 'Execution status',
        enum: ['success', 'failure', 'partial', 'cancelled'],
      },
      tasks: {
        type: 'array',
        description: 'Task execution results',
        items: {
          type: 'object',
          properties: {
            task_id: { type: 'string' },
            status: { type: 'string' },
            duration_ms: { type: 'number' },
            tokens_used: { type: 'number' },
            error: { type: 'string' },
          },
        },
      },
      state_transition: {
        type: 'object',
        description: 'Files changed during execution',
        properties: {
          files_created: { type: 'array', items: { type: 'string' } },
          files_modified: { type: 'array', items: { type: 'string' } },
          files_deleted: { type: 'array', items: { type: 'string' } },
        },
      },
      duration_ms: {
        type: 'number',
        description: 'Total execution duration',
      },
      cost_usd: {
        type: 'number',
        description: 'Total LLM cost',
      },
      tokens_total: {
        type: 'number',
        description: 'Total tokens used',
      },
    },
    required: ['execution_id', 'template_id', 'status'],
  },
};

export const SubmitTraceInputSchema = z.object({
  execution_id: z.string(),
  template_id: z.string(),
  status: z.enum(['success', 'failure', 'partial', 'cancelled']),
  tasks: z.array(z.object({
    task_id: z.string(),
    status: z.string(),
    duration_ms: z.number().optional(),
    tokens_used: z.number().optional(),
    error: z.string().optional(),
  })).optional(),
  state_transition: z.object({
    files_created: z.array(z.string()).optional(),
    files_modified: z.array(z.string()).optional(),
    files_deleted: z.array(z.string()).optional(),
  }).optional(),
  duration_ms: z.number().optional(),
  cost_usd: z.number().optional(),
  tokens_total: z.number().optional(),
});

export type SubmitTraceInput = z.infer<typeof SubmitTraceInputSchema>;

export async function handleSubmitTrace(
  input: SubmitTraceInput,
  apiClient: AnalysisAPIClient,
  sessionId: string
): Promise<string> {
  const startTime = Date.now();

  const result = await apiClient.post<{
    trace_id: string;
    received_at: string;
    metrics_updated: boolean;
    pattern_candidate: boolean;
  }>('/v2/activities/execution-traces', input, sessionId);

  const duration = Date.now() - startTime;

  let text = `Trace submitted successfully\n`;
  text += `Trace ID: ${result.trace_id}\n`;
  text += `Received: ${result.received_at}\n`;
  text += `Metrics Updated: ${result.metrics_updated ? 'Yes' : 'No'}\n`;
  text += `Pattern Candidate: ${result.pattern_candidate ? 'Yes' : 'No'}\n`;
  text += `\nSubmitted in ${duration}ms`;

  return text;
}
