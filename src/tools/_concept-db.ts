/**
 * concept-db, reached through the attachment — discovery `POST /resolve`, which
 * forwards to concept-db's resolver (CONFORMANCE §c11-attachment-model). Shared
 * by the concept tools and the concept-db half of the mixed tools
 * (SPEC §concept-graph-tools).
 *
 * Only shapes concept-db alone produces are used: `concept` is advertised by
 * development-vessel as well, and discovery picks the first direct row, so
 * which vessel answers it depends on registry order.
 *
 * Pointer contracts, from concept-db src/routes/impulses.ts:
 *   - `conceptSearch { query?, shape?, source_type?, min_relevance?, limit }` →
 *     `{ content: Concept[], metadata }` (relevance DESC; no offset; rows carry
 *     their embedding vectors).
 *   - `conceptGraph { concept_id, direction?, edge_types?, limit? }` →
 *     `{ content: { root: Concept, edges: [{ edge, neighbor: Concept }] } }`, or
 *     `404 { error: "Concept not found: …" }`. `root` is the row `GET /concepts/:id`
 *     returns.
 *   - `conceptSequence { concept_id, direction?, limit? }` → `{ content: [{ concept_id, weight, times_traversed }] }`.
 *   - `conceptUsageStats { concept_id }` → `{ content: { total_uses, success_rate, failure_rate, neutral_rate } }`.
 *   - `concept_create_write { conceptData }`, `conceptLink_write { linkData }`,
 *     `conceptUsage_write { usageData }` → `200 { success: true, content: "<result JSON>" }`
 *     or `400 { success: false, error }`. `conceptLink_write` upserts: a repeated
 *     (from, to, edge_type) moves the existing edge's weight by EMA.
 * Reads are retried when concept-db is cut at its timeout; writes never are.
 */

import { RESOLVE_TIMEOUT_MS, describeResolveFailure, getAttachment, resolveShape, substrateRefusal } from '../attachment.js';

export interface ConceptRow {
  id?: string;
  source_type?: string;
  shape?: string;
  summary?: string | null;
  content?: string | null;
  times_loaded?: number;
  times_succeeded?: number;
  times_failed?: number;
  relevance?: number;
  budget?: number;
  priority?: number;
  created_at?: string;
  updated_at?: string;
  pointer?: { type?: string; metadata?: Record<string, unknown> };
}

export type Read<T> = { ok: true; value: T } | { ok: false; status?: number; error: string };

/** True when the attachment may make keyed calls: concept-db is reachable through it. */
export async function conceptDbAvailable(): Promise<boolean> {
  return getAttachment() !== null && (await substrateRefusal()) === null;
}

async function read(pointer: Record<string, unknown>): Promise<Read<{ status: number; body: any }>> {
  try {
    const res = await resolveShape(pointer, { timeoutMs: RESOLVE_TIMEOUT_MS.concept, read: true });
    return { ok: true, value: { status: res.status, body: res.body } };
  } catch (err) {
    return { ok: false, error: describeResolveFailure(err) };
  }
}

function failure(shape: string, status: number, body: any): string {
  const detail = body?.error ?? body?.message ?? JSON.stringify(body ?? {}).slice(0, 200);
  return `${shape} answered ${status}: ${String(detail).slice(0, 200)}`;
}

export interface SearchFilters {
  query?: string;
  source_type?: string;
  shape?: string;
  min_relevance?: number;
  limit: number;
  /** Rows to skip, for paging list mode; a concept-db that does not honour it answers the first page again. */
  offset?: number;
}

export async function searchConcepts(filters: SearchFilters): Promise<Read<ConceptRow[]>> {
  const pointer: Record<string, unknown> = { type: 'conceptSearch', limit: filters.limit };
  if (filters.query) pointer.query = filters.query;
  if (filters.source_type) pointer.source_type = filters.source_type;
  if (filters.shape) pointer.shape = filters.shape;
  if (filters.min_relevance !== undefined) pointer.min_relevance = filters.min_relevance;
  if (filters.offset) pointer.offset = filters.offset;
  const r = await read(pointer);
  if (!r.ok) return r;
  if (r.value.status !== 200) return { ok: false, status: r.value.status, error: failure('conceptSearch', r.value.status, r.value.body) };
  const rows = r.value.body?.content;
  return { ok: true, value: Array.isArray(rows) ? rows : [] };
}

export interface ConceptGraph {
  root: ConceptRow;
  edges: Array<{ edge: Record<string, any>; neighbor: ConceptRow }>;
}

/** A concept and its edges; `null` when concept-db has no such concept (its 404). */
export async function conceptGraph(
  conceptId: string,
  opts: { direction?: string; edge_types?: string[]; limit?: number } = {},
): Promise<Read<ConceptGraph | null>> {
  const pointer: Record<string, unknown> = { type: 'conceptGraph', concept_id: conceptId };
  if (opts.direction) pointer.direction = opts.direction;
  if (opts.edge_types?.length) pointer.edge_types = opts.edge_types;
  if (opts.limit !== undefined) pointer.limit = opts.limit;
  const r = await read(pointer);
  if (!r.ok) return r;
  if (r.value.status === 404) return { ok: true, value: null };
  if (r.value.status !== 200) return { ok: false, status: r.value.status, error: failure('conceptGraph', r.value.status, r.value.body) };
  const content = r.value.body?.content ?? {};
  return {
    ok: true,
    value: {
      root: (content.root ?? {}) as ConceptRow,
      edges: Array.isArray(content.edges) ? content.edges : [],
    },
  };
}

/** One concept by id — the row `GET /concepts/:id` returns — or `null` when there is none. */
export async function getConcept(conceptId: string): Promise<Read<ConceptRow | null>> {
  const r = await conceptGraph(conceptId, { limit: 1 });
  if (!r.ok) return r;
  return { ok: true, value: r.value ? r.value.root : null };
}

export async function conceptSequence(conceptId: string, direction: string, limit: number): Promise<Read<Array<Record<string, any>>>> {
  const r = await read({ type: 'conceptSequence', concept_id: conceptId, direction, limit });
  if (!r.ok) return r;
  if (r.value.status !== 200) return { ok: false, status: r.value.status, error: failure('conceptSequence', r.value.status, r.value.body) };
  const rows = r.value.body?.content;
  return { ok: true, value: Array.isArray(rows) ? rows : [] };
}

export async function conceptUsageStats(conceptId: string): Promise<Read<Record<string, any>>> {
  const r = await read({ type: 'conceptUsageStats', concept_id: conceptId });
  if (!r.ok) return r;
  if (r.value.status !== 200) return { ok: false, status: r.value.status, error: failure('conceptUsageStats', r.value.status, r.value.body) };
  return { ok: true, value: (r.value.body?.content ?? {}) as Record<string, any> };
}

/** A `*_write` shape: one attempt, its result parsed out of `content`. */
async function write(shape: string, field: string, data: Record<string, unknown>): Promise<Read<Record<string, any>>> {
  let res;
  try {
    res = await resolveShape({ type: shape, [field]: data }, { timeoutMs: RESOLVE_TIMEOUT_MS.concept });
  } catch (err) {
    return { ok: false, error: describeResolveFailure(err) };
  }
  const body = res.body as { success?: boolean; content?: unknown; error?: string } | undefined;
  if (res.status !== 200 || body?.success === false) {
    return { ok: false, status: res.status, error: failure(shape, res.status, body) };
  }
  let result: unknown = body?.content;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      result = {};
    }
  }
  return { ok: true, value: (result && typeof result === 'object' ? result : {}) as Record<string, any> };
}

/** `concept_create_write` — the body `POST /concepts` takes. */
export function createConcept(conceptData: Record<string, unknown>): Promise<Read<Record<string, any>>> {
  return write('concept_create_write', 'conceptData', conceptData);
}

/** `conceptLink_write` — `{ from_concept_id, to_concept_id, edge_type, description?, weight? }`. */
export function linkConcepts(linkData: Record<string, unknown>): Promise<Read<Record<string, any>>> {
  return write('conceptLink_write', 'linkData', linkData);
}

/** `conceptUsage_write` — `{ concept_id, trace_id, outcome, activity_id?, task_id? }`. */
export function recordUsage(usageData: Record<string, unknown>): Promise<Read<Record<string, any>>> {
  return write('conceptUsage_write', 'usageData', usageData);
}
