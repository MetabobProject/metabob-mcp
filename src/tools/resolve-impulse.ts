/**
 * resolve_impulse — a GENERAL impulse-resolve passthrough, so an operator agent
 * can resolve or write ANY shape through MCP instead of raw `curl … /v2/impulses/
 * resolve` POSTs. This session repeatedly escaped to raw POSTs for feature_compose,
 * memoryNote, goal_verification_label, etc.; this closes that gap.
 *
 * ADVANCED / ESCAPE HATCH: prefer the dedicated tools when they fit — run_goal /
 * run_goal_async for goal_execution, goal_reasoning for walk inspection,
 * provide_feedback for oracle-corpus verdicts. Reach for resolve_impulse only when
 * no dedicated tool covers the shape.
 *
 * Target resolution:
 *   - activity_api === true  → POST {activityApiUrl}/v2/impulses/resolve.
 *   - vessel_shape present    → resolve the owning vessel via discovery
 *                               (vesselCapability on vessel_shape) and POST to its
 *                               endpoint + resolve_endpoint (default /v2/impulses/resolve).
 *   - neither given           → default to activity-api (owner of most core shapes).
 *
 * Body: { impulse: { pointer: { type: shape, ...(pointer ?? {}) } } }.
 * Auth: re-uses METABOB_API_KEY as ApiKey bearer.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { buildResolverUrl, discoverFirstVesselByShape } from '../discovery.js';

const TIMEOUT_MS = parseInt(process.env.RESOLVE_IMPULSE_TIMEOUT_MS || '30000', 10);
const MAX_CONTENT = 2048;

export const ResolveImpulseTool = {
  name: 'resolve_impulse',
  description:
    "ADVANCED escape hatch: a general impulse-resolve passthrough to resolve or write ANY shape via MCP instead of raw `curl /v2/impulses/resolve` POSTs (e.g. memoryNote, feature_compose, goal_verification_label, *_write shapes). Prefer the dedicated tools when they fit — run_goal / run_goal_async (goal_execution), goal_reasoning (walk inspection), provide_feedback (oracle verdicts). Target: set activity_api:true to hit activity-api; give vessel_shape to route to the owning vessel via discovery; otherwise defaults to activity-api. pointer merges into { type: shape, ... }. Returns the raw JSON response.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      shape: {
        type: 'string',
        description: 'The impulse shape / pointer.type to resolve (e.g. memoryNote, feature_compose, impulseRelevance_write).',
      },
      pointer: {
        type: 'object',
        description: 'Extra pointer fields merged into { type: shape, ... } (e.g. { note_type: "feedback", limit: 2 }).',
        additionalProperties: true,
      },
      vessel_shape: {
        type: 'string',
        description:
          'Discovery shape used to find the owning vessel, if different from `shape`. Presence routes the POST to that vessel instead of activity-api.',
      },
      activity_api: {
        type: 'boolean',
        description:
          'Force the POST to activity-api (/v2/impulses/resolve). Defaults to true when vessel_shape is absent.',
      },
    },
    required: ['shape'],
  },
};

export const InputSchema = z.object({
  shape: z.string().min(1, 'shape is required'),
  pointer: z.record(z.unknown()).optional(),
  vessel_shape: z.string().optional(),
  activity_api: z.boolean().optional(),
});

export type ResolveImpulseInput = z.infer<typeof InputSchema>;

function authHeaders(): Record<string, string> {
  const apiKey = process.env.METABOB_API_KEY;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;
  return headers;
}

function truncate(text: string): string {
  return text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT)}\n… [truncated ${text.length - MAX_CONTENT} chars]` : text;
}

function prettyBody(text: string): string {
  try {
    return truncate(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    return truncate(text);
  }
}

export async function handle(input: ResolveImpulseInput, apiClient: AnalysisAPIClient): Promise<string> {
  const apiKey = process.env.METABOB_API_KEY;

  // Decide the target: explicit activity_api wins; else vessel_shape routes to a
  // discovered vessel; else default to activity-api.
  const useActivityApi = input.activity_api ?? !input.vessel_shape;

  const pointer: Record<string, unknown> = { type: input.shape, ...(input.pointer ?? {}) };
  const body = JSON.stringify({ impulse: { pointer } });

  let url: string | undefined;
  if (useActivityApi) {
    const activityApiUrl = apiClient.getActivityApiUrl();
    if (!activityApiUrl) {
      return 'resolve_impulse (activity-api mode) requires an activity-api URL (configure metabob.endpoint).';
    }
    url = `${activityApiUrl.replace(/\/$/, '')}/v2/impulses/resolve`;
  } else {
    if (!apiClient.hasDiscovery() && !process.env.DISCOVERY_ENDPOINT) {
      return 'resolve_impulse (vessel mode) requires discovery. Set DISCOVERY_ENDPOINT or use activity_api:true.';
    }
    const capability = await discoverFirstVesselByShape({
      discoveryEndpoint: process.env.DISCOVERY_ENDPOINT?.replace(/\/$/, '') ?? apiClient.getDiscoveryEndpoint(),
      shape: input.vessel_shape ?? input.shape,
      apiKey,
    });
    if (!capability) {
      return `resolve_impulse could not find a vessel advertising "${input.vessel_shape ?? input.shape}" via discovery.`;
    }
    url = buildResolverUrl(capability, process.env.DISCOVERY_ENDPOINT?.replace(/\/$/, '') ?? apiClient.getDiscoveryEndpoint());
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(),
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return `resolve_impulse failed to reach ${url}: ${err instanceof Error ? err.message : String(err)}`;
  }

  const text = await res.text();
  const header = `resolve_impulse ${input.shape} → ${url} [${res.status}]`;
  return `${header}\n${prettyBody(text)}`;
}
