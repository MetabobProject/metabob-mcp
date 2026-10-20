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
 * The one exception to the passthrough: writes an agent does not make
 * (COORDINATION_WRITES: the system's leases, its graded record, the oracle corpus
 * outside provide_feedback, walk input, gap filing, system policy) are refused before
 * any request. They keep this cockpit from being the convenient route to them; they are
 * not a security boundary, which belongs to each producer. SPEC §resolve_impulse
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { RESOLVE_MAX_TIMEOUT_MS, describeResolveFailure, resolveShape } from '../attachment.js';

const MAX_CONTENT = 2048;

const LEASE = (shape: string, what: string, instead: string) =>
  `${shape} is the substrate's own coordination (${what}); an agent does not take or release it. ${instead}. If a lease looks stuck or held by something other than the system, record a finding with its holder, name and expiry`;
const GRADED = (shape: string) =>
  `${shape} writes the substrate's graded record; an agent never writes a trace. Dispatch the work as a goal, so goal-host traces it and its judge grades it`;
const POLICY = (shape: string) =>
  `${shape} changes system policy, an operator's decision and not an agent's; this cockpit key carries no operator authority. Ask the person, or record a finding proposing the change`;

/**
 * Writes an agent does not make through the escape hatch, with why and what to do
 * instead: the system's coordination leases, its graded record, the oracle corpus
 * outside provide_feedback, walk input before it carries a stamped principal, gap
 * filing (gaps come from the system's detectors), and system policy.
 */
// @anchor coordination-writes
export const COORDINATION_WRITES: Readonly<Record<string, string>> = {
  maintenanceLease_write: LEASE('maintenanceLease_write', 'maintenance windows, the auto-pick lane', 'To have maintenance done, dispatch it as a goal'),
  substrateGapLease_write: LEASE('substrateGapLease_write', "a gap's landing lease; landing a gap is the system's work", 'To have a gap closed, let the system land it or dispatch it as a goal'),
  activityExecutionTrace_write: GRADED('activityExecutionTrace_write'),
  execution_write: GRADED('execution_write'),
  goal_verification_label_write:
    "goal_verification_label_write is the oracle corpus; provide_feedback is the one path into it from this cockpit, and records your verdict as an automated label with the operator folded in",
  poolImpulse_write:
    "poolImpulse_write adds content to a running walk, and the substrate does not yet stamp who contributed it; until it does, an agent does not feed walks. Dispatch a goal, or record a finding with what the walk is missing",
  substrateGap_write:
    "substrateGap_write files a gap; gaps come from the system's own detectors, and an agent-filed gap counts as hand-fed. Record a finding instead (record_finding), and the detectors and other agents see it",
  pushPolicy_write: POLICY('pushPolicy_write'),
  llmModelPolicy_write: POLICY('llmModelPolicy_write'),
  docFixPolicy_write: POLICY('docFixPolicy_write'),
  renderPolicy_write: POLICY('renderPolicy_write'),
};

/** The request cap: RESOLVE_IMPULSE_TIMEOUT_MS (default 30 s), never above 60 s. */
function timeoutMs(): number {
  const ms = parseInt(process.env.RESOLVE_IMPULSE_TIMEOUT_MS || '30000', 10);
  return Math.min(Number.isFinite(ms) && ms > 0 ? ms : 30_000, RESOLVE_MAX_TIMEOUT_MS);
}

export const ResolveImpulseTool = {
  name: 'resolve_impulse',
  description:
    "ADVANCED escape hatch: a general impulse-resolve passthrough to resolve or write ANY shape via MCP instead of raw `curl /resolve` POSTs (e.g. memoryNote, feature_compose, goal_verification_label, *_write shapes). The pointer goes to discovery's /resolve, which forwards it to the shape's producer. Prefer the dedicated tools when they fit — run_goal / run_goal_async (goals), goal_reasoning (walk inspection), provide_feedback (oracle verdicts). pointer merges into { type: shape, ... }. Returns the producer's HTTP status and raw JSON response. Refuses writes an agent does not make: the system's leases, traces (the graded record), the oracle corpus outside provide_feedback, walk input, gap filing and system policy; the reply says what to do instead.",
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
    return `resolve_impulse: refused: ${why}.`;
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
