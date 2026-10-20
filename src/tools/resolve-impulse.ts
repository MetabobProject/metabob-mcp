// Contract (input schema, behaviour): SPEC §resolve_impulse
/**
 * resolve_impulse — a GENERAL impulse-resolve passthrough, so an operator agent
 * can resolve or write ANY shape through MCP instead of raw `curl … /resolve`
 * POSTs.
 *
 * ADVANCED / ESCAPE HATCH: prefer the dedicated tools when they fit — run_goal /
 * run_goal_async for goals, goal_reasoning for walk inspection, provide_feedback
 * for oracle-corpus verdicts. Reach for resolve_impulse only when no dedicated
 * tool covers the shape.
 *
 * A thin passthrough of the attachment's resolve() (src/attachment.ts@attachment-resolve):
 * `{ pointer: { type: shape, ...pointer } }` to discovery `POST /resolve`, which
 * picks the shape's producer and forwards it (CONFORMANCE §c11-attachment-model).
 * The shape may be a write, so it is sent once and never retried.
 *
 * The one exception to the passthrough: the substrate's own coordination writes
 * (COORDINATION_WRITES) are refused before any request. They are a rail against an
 * agent taking or releasing the system's leases by accident, not a security
 * boundary; the holder check belongs to the producer. SPEC §resolve_impulse
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { RESOLVE_MAX_TIMEOUT_MS, describeResolveFailure, resolveShape } from '../attachment.js';

const MAX_CONTENT = 2048;

/**
 * The substrate's own coordination writes, with why an agent does not make them. An
 * agent reads these leases (`maintenanceLease`, `substrateGap`); it never takes or
 * releases them.
 */
// @anchor coordination-writes
export const COORDINATION_WRITES: Readonly<Record<string, string>> = {
  maintenanceLease_write:
    "maintenanceLease_write is the substrate's own coordination (maintenance windows, the auto-pick lane); an agent does not take or release it. To have maintenance done, dispatch it as a goal",
  substrateGapLease_write:
    "substrateGapLease_write is the substrate's own coordination (landing a gap is the system's work); an agent does not claim or release a gap's landing lease. To have a gap closed, let the system land it or dispatch it as a goal",
};

/** The request cap: RESOLVE_IMPULSE_TIMEOUT_MS (default 30 s), never above 60 s. */
function timeoutMs(): number {
  const ms = parseInt(process.env.RESOLVE_IMPULSE_TIMEOUT_MS || '30000', 10);
  return Math.min(Number.isFinite(ms) && ms > 0 ? ms : 30_000, RESOLVE_MAX_TIMEOUT_MS);
}

export const ResolveImpulseTool = {
  name: 'resolve_impulse',
  description:
    "ADVANCED escape hatch: a general impulse-resolve passthrough to resolve or write ANY shape via MCP instead of raw `curl /resolve` POSTs (e.g. memoryNote, feature_compose, goal_verification_label, *_write shapes). The pointer goes to discovery's /resolve, which forwards it to the shape's producer. Prefer the dedicated tools when they fit — run_goal / run_goal_async (goals), goal_reasoning (walk inspection), provide_feedback (oracle verdicts). pointer merges into { type: shape, ... }. Returns the producer's HTTP status and raw JSON response. Refuses the substrate's own lease writes (maintenanceLease_write, substrateGapLease_write): an agent reads those leases, never takes or releases them.",
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
    },
    required: ['shape'],
  },
};

export const InputSchema = z.object({
  shape: z.string().min(1, 'shape is required'),
  pointer: z.record(z.unknown()).optional(),
});

export type ResolveImpulseInput = z.infer<typeof InputSchema>;

function truncate(text: string): string {
  return text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT)}\n… [truncated ${text.length - MAX_CONTENT} chars]` : text;
}

export async function handle(input: ResolveImpulseInput, _apiClient: AnalysisAPIClient): Promise<string> {
  const pointer: Record<string, unknown> = { type: input.shape, ...(input.pointer ?? {}) };
  const why = typeof pointer.type === 'string' ? COORDINATION_WRITES[pointer.type] : undefined;
  if (why) {
    return `resolve_impulse: refused: ${why}. If a lease looks stuck or held by something other than the system, record a finding with its holder, name and expiry.`;
  }

  let res;
  try {
    res = await resolveShape(pointer, { timeoutMs: timeoutMs() });
  } catch (err) {
    return `resolve_impulse: ${describeResolveFailure(err)}`;
  }

  const header = `resolve_impulse ${input.shape} → discovery /resolve [${res.status}]`;
  return `${header}\n${truncate(JSON.stringify(res.body, null, 2))}`;
}
