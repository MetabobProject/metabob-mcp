/**
 * registry_query — inspect discovery-vessel's registry directly through MCP,
 * so an operator agent never has to escape to `docker exec … curl discovery`.
 *
 * Two modes:
 *   - "shapes":  GET {discovery}/registry/shapes → the advertised shape vocabulary
 *                (optionally filtered by a `shape` substring). Answers "what shapes
 *                does the substrate know how to resolve right now?".
 *   - "vessels": POST {discovery}/resolve { pointer: { type: "vesselCapability",
 *                shape } } → the vessels advertising a given shape, with their
 *                endpoint / protocol / resolve_endpoint. Answers "who serves this
 *                shape?". Requires `shape`.
 *
 * Discovery endpoint resolution: prefer DISCOVERY_ENDPOINT, else the client's
 * configured discovery endpoint, else the local default (http://localhost:18100).
 *
 * Auth: re-uses METABOB_API_KEY as ApiKey bearer.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

const TIMEOUT_MS = parseInt(process.env.GOAL_STATUS_TIMEOUT_MS || '15000', 10);
const DEFAULT_DISCOVERY = 'http://localhost:18100';

export const RegistryQueryTool = {
  name: 'registry_query',
  description:
    "Inspect discovery-vessel's registry directly (replaces `docker exec … curl discovery`). mode:\"shapes\" lists the advertised shape vocabulary the substrate can resolve (optionally filtered by a substring in `shape`). mode:\"vessels\" (requires `shape`) lists the vessels advertising that shape — vesselId, endpoint, protocol, resolve_endpoint — via the vesselCapability pointer. Use this to answer \"what shapes exist?\" and \"who serves shape X?\" without host access.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      mode: {
        type: 'string',
        enum: ['shapes', 'vessels'],
        description:
          'shapes = list the advertised shape vocabulary; vessels = list vessels serving a given shape (requires shape).',
      },
      shape: {
        type: 'string',
        description:
          'In vessels mode: the shape to resolve producers for (required). In shapes mode: an optional substring filter over the shape names.',
      },
    },
    required: ['mode'],
  },
};

export const InputSchema = z
  .object({
    mode: z.enum(['shapes', 'vessels']),
    shape: z.string().optional(),
  })
  .refine((v) => v.mode !== 'vessels' || Boolean(v.shape), {
    message: 'shape is required when mode is "vessels"',
  });

export type RegistryQueryInput = z.infer<typeof InputSchema>;

function authHeaders(): Record<string, string> {
  const apiKey = process.env.METABOB_API_KEY;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;
  return headers;
}

function resolveDiscoveryEndpoint(apiClient: AnalysisAPIClient): string {
  const explicit = process.env.DISCOVERY_ENDPOINT;
  if (explicit) return explicit.replace(/\/$/, '');
  const fromClient = apiClient.getDiscoveryEndpoint();
  if (fromClient) return fromClient.replace(/\/$/, '');
  return DEFAULT_DISCOVERY;
}

interface DiscoveryResolveResponse {
  content?: {
    shape?: string;
    found?: boolean;
    vessels?: Array<{
      vesselId?: string;
      vesselName?: string;
      endpoint?: string;
      public_endpoint?: string;
      protocol?: string;
      resolve_endpoint?: string;
    }>;
  };
}

// Accept a few payload shapes: bare array, { shapes: [...] }, or { content: { shapes } }.
function parseShapesPayload(payload: any): string[] {
  if (Array.isArray(payload)) return payload.map(String);
  if (Array.isArray(payload?.shapes)) return payload.shapes.map(String);
  if (Array.isArray(payload?.content?.shapes)) return payload.content.shapes.map(String);
  if (payload && typeof payload === 'object') {
    // Fallback: keys of a { shape: count } map.
    return Object.keys(payload).map(String);
  }
  return [];
}

/**
 * Best-effort fetch of the /registry/shapes vocabulary. Returns null when the
 * list cannot be obtained (unreachable / non-2xx / unparseable) — callers use
 * it only for the cross-view consistency check and must not fail on null.
 */
async function fetchShapeList(discovery: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${discovery}/registry/shapes`, {
      method: 'GET',
      headers: authHeaders(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseShapesPayload(await res.json());
  } catch {
    return null;
  }
}

async function queryShapes(discovery: string, filter?: string): Promise<string> {
  const url = `${discovery}/registry/shapes`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: authHeaders(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return `registry_query failed to reach ${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!res.ok) {
    return `registry_query: ${res.status} from ${url}: ${(await res.text()).slice(0, 200)}`;
  }

  let payload: any;
  try {
    payload = await res.json();
  } catch {
    return `registry_query: unparseable body from ${url}`;
  }

  const shapes = parseShapesPayload(payload);

  const needle = filter?.toLowerCase();
  const filtered = needle ? shapes.filter((s) => s.toLowerCase().includes(needle)) : shapes;
  filtered.sort();

  const header = needle
    ? `Advertised shapes matching "${filter}" (${filtered.length}/${shapes.length}):`
    : `Advertised shapes (${filtered.length}):`;
  if (!filtered.length) {
    return `${header}\n  (none)`;
  }
  return [header, ...filtered.map((s) => `  ${s}`)].join('\n');
}

async function queryVessels(discovery: string, shape: string): Promise<string> {
  const url = `${discovery}/resolve`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ pointer: { type: 'vesselCapability', shape } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return `registry_query failed to reach ${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!res.ok) {
    return `registry_query: ${res.status} from ${url}: ${(await res.text()).slice(0, 200)}`;
  }

  let payload: DiscoveryResolveResponse;
  try {
    payload = (await res.json()) as DiscoveryResolveResponse;
  } catch {
    return `registry_query: unparseable body from ${url}`;
  }

  const vessels = payload.content?.vessels ?? [];

  // Cross-check the vesselCapability view against the /registry/shapes view.
  // The two views disagreeing (shape listed but no vessels, or vessels
  // advertising a shape absent from the vocabulary) was the diagnostic key for
  // the stale-row incident — flag it instead of making operators diff by hand.
  const shapeList = await fetchShapeList(discovery);
  let crossCheck: string | undefined;
  if (shapeList !== null) {
    const inShapeList = shapeList.includes(shape);
    if (vessels.length > 0 && !inShapeList) {
      crossCheck = `WARNING: registry views disagree — ${vessels.length} vessel(s) advertise "${shape}" via vesselCapability, but /registry/shapes does not list it. One view is stale; treat these rows as suspect.`;
    } else if (vessels.length === 0 && inShapeList) {
      crossCheck = `WARNING: registry views disagree — /registry/shapes lists "${shape}", but no vesselCapability rows advertise it. One view is stale.`;
    }
  }

  if (!vessels.length) {
    const base = `No vessels advertise shape "${shape}".`;
    return crossCheck ? `${base}\n${crossCheck}` : base;
  }

  const lines = [`Vessels serving "${shape}" (${vessels.length}):`];
  vessels.forEach((v) => {
    const endpoint = v.public_endpoint || v.endpoint || '(no endpoint)';
    lines.push(`  ${v.vesselId ?? v.vesselName ?? '(unknown)'}`);
    lines.push(`      endpoint:         ${endpoint}`);
    if (v.protocol) lines.push(`      protocol:         ${v.protocol}`);
    lines.push(`      resolve_endpoint: ${v.resolve_endpoint ?? '/v2/impulses/resolve'}`);
  });
  if (crossCheck) lines.push(crossCheck);
  return lines.join('\n');
}

export async function handle(input: RegistryQueryInput, apiClient: AnalysisAPIClient): Promise<string> {
  const discovery = resolveDiscoveryEndpoint(apiClient);
  if (input.mode === 'shapes') {
    return queryShapes(discovery, input.shape);
  }
  // mode === 'vessels' (schema guarantees shape is present)
  return queryVessels(discovery, input.shape as string);
}
