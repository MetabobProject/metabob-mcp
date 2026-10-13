// Contract (input schema, behaviour): SPEC §run_goal_async
/**
 * run_goal_async — dispatch a goal to goal-host-vessel WITHOUT blocking.
 *
 * Unlike `run_goal` (which POSTs the impulse-resolver `/resolve` path and
 * blocks up to ~290s for the result), this POSTs goal-host's async
 * `POST /run-goal` endpoint, which returns `202 { dispatchId, status }`
 * immediately. The goal then runs in the background; the caller polls
 * `goal_status` with the returned dispatchId.
 *
 * Use this for long-running goals (composition walks, drafter fallback,
 * recovery loops) where a single synchronous call would hit Bun's hard
 * 300s fetch cap. Use plain `run_goal` for short, one-shot goals.
 *
 * Target discovery is identical to `run_goal`: resolve the `goal_execution`
 * shape via discovery-vessel and host-remap the internal port, or honor an
 * explicit GOAL_HOST_VESSEL_URL.
 *
 * Auth: re-uses METABOB_API_KEY as ApiKey bearer.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { resolveServiceEndpointByShape } from '../discovery.js';
import { operatorId } from '../operator-id.js';

const DISPATCH_TIMEOUT_MS = parseInt(
  process.env.RUN_GOAL_ASYNC_TIMEOUT_MS || '30000',
  10,
);

export const RunGoalAsyncTool = {
  name: 'run_goal_async',
  description:
    "Dispatch a goal to goal-host-vessel asynchronously (POST /run-goal). Returns a dispatchId immediately without waiting for the goal to finish — the goal runs in the background and you poll it with goal_status. Prefer this over run_goal for long-running goals (composition walks, drafter fallback, recovery) that would otherwise exceed the ~290s synchronous cap. Provide either goal (natural-language) or target_template_id (skip Thompson selection). Optional variables seed the execution pool; parent_execution_id + composition_chain thread cross-vessel provenance.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      goal: {
        type: 'string',
        description:
          'Natural-language goal description. Either this or target_template_id is required.',
      },
      target_template_id: {
        type: 'string',
        description:
          'Specific activity template id to execute, bypassing Thompson selection.',
      },
      variables: {
        type: 'object',
        description:
          'Seed variables injected into the execution pool. Templates reference these as {{var}} placeholders.',
        additionalProperties: true,
      },
      parent_execution_id: {
        type: 'string',
        description:
          'Parent execution id for cross-vessel provenance (composition tracking).',
      },
      composition_chain: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Ancestor execution ids, root-first. Threads through to the trace for credit propagation.',
      },
    },
  },
};

export const InputSchema = z
  .object({
    goal: z.string().optional(),
    target_template_id: z.string().optional(),
    variables: z.record(z.unknown()).optional(),
    parent_execution_id: z.string().optional(),
    composition_chain: z.array(z.string()).optional(),
  })
  .refine((v) => Boolean(v.goal || v.target_template_id), {
    message: 'goal or target_template_id is required',
  });

export type RunGoalAsyncInput = z.infer<typeof InputSchema>;

interface DispatchResponse {
  dispatchId?: string;
  status?: string;
  error?: string;
}

export async function handle(
  input: RunGoalAsyncInput,
  apiClient: AnalysisAPIClient,
): Promise<string> {
  if (!apiClient.hasDiscovery() && !process.env.GOAL_HOST_VESSEL_URL) {
    return [
      'run_goal_async requires discovery or an explicit GOAL_HOST_VESSEL_URL.',
      'Configure DISCOVERY_ENDPOINT to point at discovery-vessel,',
      'or set GOAL_HOST_VESSEL_URL directly.',
    ].join(' ');
  }

  const apiKey = process.env.METABOB_API_KEY;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;

  // goal-host's /run-goal accepts the flat body (not the impulse envelope):
  // { goal, targetTemplateId, variables, parent_execution_id, composition_chain }.
  const body: Record<string, unknown> = { operator: operatorId() };
  if (input.goal) body.goal = input.goal;
  if (input.target_template_id) body.targetTemplateId = input.target_template_id;
  if (input.variables) body.variables = input.variables;
  if (input.parent_execution_id) body.parent_execution_id = input.parent_execution_id;
  if (input.composition_chain) body.composition_chain = input.composition_chain;

  const baseUrl = await resolveServiceEndpointByShape({
    explicitUrl: process.env.GOAL_HOST_VESSEL_URL,
    discoveryEndpoint: apiClient.getDiscoveryEndpoint(),
    shape: 'goal_execution',
    apiKey,
  });
  if (!baseUrl) {
    return 'run_goal_async could not find goal-host-vessel via discovery. Set GOAL_HOST_VESSEL_URL explicitly or register goal_execution with discovery.';
  }
  const url = `${baseUrl}/run-goal`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `run_goal_async failed to reach ${url}: ${msg}`;
  }

  const text = await res.text();
  let payload: DispatchResponse;
  try {
    payload = JSON.parse(text) as DispatchResponse;
  } catch {
    return `run_goal_async: ${res.status} (unparseable body) ${text.slice(0, 200)}`;
  }

  if (!res.ok || !payload.dispatchId) {
    return [
      `run_goal_async: ${res.status}`,
      payload.error ? `  error: ${payload.error}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    'Goal dispatched asynchronously.',
    `  dispatchId: ${payload.dispatchId}`,
    `  status:     ${payload.status ?? 'running'}`,
    '',
    `Poll with: goal_status { "dispatch_id": "${payload.dispatchId}" }`,
  ].join('\n');
}
