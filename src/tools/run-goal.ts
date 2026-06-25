/**
 * run_goal — dispatch a goal to the substrate's goal-host-vessel.
 *
 * Uses the impulse-resolver contract (POST /resolve with an
 * { impulse: { pointer: { type: "goal_execution", ... } } } envelope) rather
 * than the convenience POST /run-goal HTTP path. This is the compliant route:
 * the goal becomes an impulse with a typed shape, dispatched through the
 * vessel's advertised resolver endpoint exactly as discovery-vessel would
 * route a cross-vessel resolution.
 *
 * Synchronous: /resolve blocks until the goal completes or Bun's 300s fetch
 * cap fires. For longer-running goals, callers should use minibob or POST
 * directly to /run-goal (async dispatch + polling) — that path is
 * intentionally not surfaced here so this tool remains a single-shape
 * impulse resolver.
 *
 * Auth: vessel mode only. Re-uses METABOB_API_KEY as ApiKey bearer.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { buildResolverUrl, discoverFirstVesselByShape } from '../discovery.js';

const RESOLVE_TIMEOUT_MS = parseInt(
  process.env.RUN_GOAL_TIMEOUT_MS || '290000',
  10,
);

export const RunGoalTool = {
  name: 'run_goal',
  description:
    "Dispatch a goal to the substrate's goal-host-vessel via the impulse-resolver contract (shape: goal_execution). The vessel selects a template via Thompson Sampling, executes it through ias-executor-ts, and returns the executionId + final status. Synchronous: blocks until completion or ~290s timeout. For long-running goals prefer minibob or the /run-goal async path. Provide either goal (natural-language) or targetTemplateId (skip selection). Optional variables seed the execution pool; parent_execution_id + composition_chain thread cross-vessel provenance.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      goal: {
        type: 'string',
        description:
          "Natural-language goal description. Either this or targetTemplateId is required.",
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

export type RunGoalInput = z.infer<typeof InputSchema>;

interface ResolveResponse {
  resolved?: boolean;
  shape?: string;
  executionId?: string;
  status?: string;
  selectedTemplateId?: string;
  error?: string;
}

export async function handle(
  input: RunGoalInput,
  apiClient: AnalysisAPIClient,
): Promise<string> {
  if (!apiClient.hasDiscovery() && !process.env.GOAL_HOST_VESSEL_URL) {
    return [
      'run_goal requires discovery or an explicit GOAL_HOST_VESSEL_URL.',
      'Configure DISCOVERY_ENDPOINT to point at discovery-vessel,',
      'or set GOAL_HOST_VESSEL_URL directly.',
    ].join(' ');
  }

  const start = Date.now();
  const apiKey = process.env.METABOB_API_KEY;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;

  const pointer: Record<string, unknown> = { type: 'goal_execution' };
  if (input.goal) pointer.goal = input.goal;
  if (input.target_template_id) pointer.target_template_id = input.target_template_id;
  if (input.variables) pointer.variables = input.variables;
  if (input.parent_execution_id) pointer.parent_execution_id = input.parent_execution_id;
  if (input.composition_chain) pointer.composition_chain = input.composition_chain;

  const body = JSON.stringify({ impulse: { pointer } });
  const explicitGoalHostUrl = process.env.GOAL_HOST_VESSEL_URL?.replace(/\/$/, '');
  const discoveredGoalHost = explicitGoalHostUrl
    ? null
    : await discoverFirstVesselByShape({
        discoveryEndpoint: apiClient.getDiscoveryEndpoint(),
        shape: 'goal_execution',
        apiKey,
      });
  const url = explicitGoalHostUrl
    ? `${explicitGoalHostUrl}/resolve`
    : discoveredGoalHost
      ? buildResolverUrl(discoveredGoalHost, apiClient.getDiscoveryEndpoint())
      : undefined;
  if (!url) {
    return 'run_goal could not find goal-host-vessel via discovery. Set GOAL_HOST_VESSEL_URL explicitly or register goal_execution with discovery.';
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `run_goal failed to reach ${url}: ${msg}`;
  }

  const duration = Date.now() - start;
  const text = await res.text();
  let payload: ResolveResponse;
  try {
    payload = JSON.parse(text) as ResolveResponse;
  } catch {
    return `run_goal: ${res.status} (unparseable body) ${text.slice(0, 200)}`;
  }

  if (!res.ok || payload.resolved === false) {
    const lines = [
      `run_goal: ${res.status} ${payload.resolved === false ? '(resolver declined)' : ''}`.trim(),
      payload.error ? `  error: ${payload.error}` : null,
      payload.shape ? `  shape: ${payload.shape}` : null,
      `  duration: ${duration}ms`,
    ].filter(Boolean);
    return lines.join('\n');
  }

  const lines = [
    `Goal dispatched via ${payload.shape ?? 'goal_execution'} resolver.`,
    `  executionId:        ${payload.executionId ?? '(unset)'}`,
    `  status:             ${payload.status ?? '(unset)'}`,
    payload.selectedTemplateId
      ? `  selectedTemplateId: ${payload.selectedTemplateId}`
      : null,
    `  duration:           ${duration}ms`,
  ].filter(Boolean);
  return lines.join('\n');
}
