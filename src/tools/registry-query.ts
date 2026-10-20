// Contract (input schema, behaviour): SPEC §registry_query
/**
 * registry_query — inspect discovery-vessel's registry through MCP, so an
 * operator agent never has to escape to `docker exec … curl discovery`.
 *
 * Both modes resolve a discovery shape through the attachment — discovery
 * `POST /resolve`, answered by discovery itself (CONFORMANCE §c11-attachment-model):
 *   - "shapes":  `vesselRegistry` → every registered vessel with its shapes; the
 *                vocabulary is their union (optionally filtered by a `shape`
 *                substring). Answers "what shapes does the substrate know how to
 *                resolve right now?".
 *   - "vessels": `vesselCapability { shape }` → the vessels advertising a shape,
 *                with their endpoint / protocol / resolve_endpoint. Answers "who
 *                serves this shape?". Requires `shape`.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { RESOLVE_TIMEOUT_MS, describeResolveFailure, resolveShape } from '../attachment.js';

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

interface CapabilityContent {
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
}

interface RegistryContent {
  vessels?: Array<{ shapes?: unknown }>;
}

type Vocabulary = { ok: true; shapes: string[] } | { ok: false; detail: string };

/**
 * The advertised vocabulary: the union of every registered vessel's shapes,
 * from `vesselRegistry` — the same set discovery's `GET /registry/shapes` lists.
 */
export async function fetchShapeVocabulary(): Promise<Vocabulary> {
  let res;
  try {
    res = await resolveShape({ type: 'vesselRegistry' }, { timeoutMs: RESOLVE_TIMEOUT_MS.discovery, read: true });
  } catch (err) {
    return { ok: false, detail: describeResolveFailure(err) };
  }
  if (res.status !== 200) {
    return { ok: false, detail: `vesselRegistry answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}` };
  }
  const content = (res.body as { content?: RegistryContent } | undefined)?.content;
  const vessels = Array.isArray(content?.vessels) ? content.vessels : [];
  const union = new Set<string>();
  for (const v of vessels) {
    if (Array.isArray(v?.shapes)) for (const s of v.shapes) union.add(String(s));
  }
  return { ok: true, shapes: [...union] };
}

async function queryShapes(filter?: string): Promise<string> {
  const vocab = await fetchShapeVocabulary();
  if (!vocab.ok) return `registry_query: ${vocab.detail}`;
  const shapes = vocab.shapes;

  const needle = filter?.toLowerCase();
  const filtered = needle ? shapes.filter((s) => s.toLowerCase().includes(needle)) : shapes;
  filtered.sort();

  const header = needle
    ? `Advertised shapes matching "${filter}" (${filtered.length}/${shapes.length}):`
    : `Advertised shapes (${filtered.length}):`;
  // vesselRegistry is answered by the anchor's own discovery: on a spoke it lists that node's
  // shapes only, while resolves reach peer nodes too. Say so, so an absent shape is not read
  // as unavailable.
  const scope =
    "(This node's vocabulary. Shapes served by peer nodes resolve through it but are not listed; " +
    'ask for one by name with mode: "vessels".)';
  if (!filtered.length) {
    return `${header}\n  (none)\n${scope}`;
  }
  return [header, ...filtered.map((s) => `  ${s}`), scope].join('\n');
}

async function queryVessels(shape: string): Promise<string> {
  let res;
  try {
    res = await resolveShape({ type: 'vesselCapability', shape }, { timeoutMs: RESOLVE_TIMEOUT_MS.discovery, read: true });
  } catch (err) {
    return `registry_query: ${describeResolveFailure(err)}`;
  }
  if (res.status !== 200) {
    return `registry_query: vesselCapability answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`;
  }

  const vessels = (res.body as { content?: CapabilityContent } | undefined)?.content?.vessels ?? [];

  // Cross-check the vesselCapability view against the registry vocabulary.
  // The two views disagreeing (shape listed but no vessels, or vessels
  // advertising a shape absent from the vocabulary) was the diagnostic key for
  // the stale-row incident — flag it instead of making operators diff by hand.
  // Best-effort: with no vocabulary there is no check.
  const vocab = await fetchShapeVocabulary();
  let crossCheck: string | undefined;
  if (vocab.ok) {
    const inShapeList = vocab.shapes.includes(shape);
    if (vessels.length > 0 && !inShapeList) {
      crossCheck = `NOTE: ${vessels.length} vessel(s) advertise "${shape}" via vesselCapability, but this node's vocabulary (vesselRegistry) does not list it. Producers on peer nodes are not in this node's vocabulary; otherwise one view is stale.`;
    } else if (vessels.length === 0 && inShapeList) {
      crossCheck = `WARNING: registry views disagree — the registry vocabulary (vesselRegistry) lists "${shape}", but no vesselCapability rows advertise it. One view is stale.`;
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

export async function handle(input: RegistryQueryInput, _apiClient: AnalysisAPIClient): Promise<string> {
  if (input.mode === 'shapes') {
    return queryShapes(input.shape);
  }
  // mode === 'vessels' (schema guarantees shape is present)
  return queryVessels(input.shape as string);
}
