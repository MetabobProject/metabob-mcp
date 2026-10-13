// Contract (input schema, behaviour): SPEC §concept_search
/**
 * concept_search — query the substrate's concept-db for accumulated concepts.
 *
 * Lets an MCP-side agent loop read what the concept-bridge-observer (and any
 * future minters) have been writing into concept-db. The bridge auto-mints
 * `impulse_signature` concepts every time analysis-vessel resolves a shape,
 * so over time this becomes a per-shape leaderboard of "which analysis
 * surfaces does the substrate actually exercise."
 *
 * Auth: talks directly to concept-db (CONCEPT_DB_URL, or discovered by its
 * shape) with METABOB_API_KEY as the ApiKey bearer.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { resolveServiceEndpointByShape } from '../discovery.js';
import { renderConceptContent, plainConceptId, PREVIEW_CHAR_BUDGET } from './_concept-content.js';

export const ConceptSearchTool = {
  name: 'concept_search',
  description:
    'Search the substrate concept-db for accumulated concepts. Concepts are the substrate\'s typed knowledge units (impulse signatures, code symbols, learned patterns, recorded decisions and findings) with Bayesian relevance scores. Use to read what previous agents and the substrate itself have written down. Returns concept ids, shapes, summaries, success/load counts, relevance, AND the concept body — the body is previewed (first ~700 chars, verbatim, truncation disclosed) so you can actually read what was recorded. For the whole body of one concept, pass concept_id (direct read, always full); content:"full" returns every match in full.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      concept_id: {
        type: 'string',
        description:
          'Read exactly one concept by id, with its FULL content body. Ignores every other filter. Use this after a search or concept_neighbors surfaced an id you want to read in full.',
      },
      content: {
        type: 'string',
        enum: ['preview', 'full', 'none'],
        description:
          'How much of each concept body to render. preview (default) = verbatim first ~700 chars with truncation disclosed; full = whole body (watch the context budget with a large limit); none = omit bodies.',
        default: 'preview',
      },
      query: {
        type: 'string',
        description: 'Optional natural-language or shape-name query. Empty = list-mode.',
      },
      source_type: {
        type: 'string',
        description:
          'Filter by source_type. Common values: impulse_signature (bridge-minted), goal, memo, human_input, llm, metabob_annotation, write, read, cpg_embedding, extracted, vessel_construction_pattern, impulse_activity_pattern.',
      },
      shape: {
        type: 'string',
        description: 'Filter by shape. Examples: problem_detection, code_annotation, source_code.',
      },
      min_relevance: {
        type: 'number',
        description: 'Only return concepts with relevance >= this threshold (0.0-1.0).',
      },
      limit: {
        type: 'number',
        description: 'Max results (default: 10, max: 50)',
        default: 10,
      },
    },
  },
};

export const InputSchema = z.object({
  concept_id: z.string().optional(),
  content: z.enum(['preview', 'full', 'none']).default('preview'),
  query: z.string().optional(),
  source_type: z.string().optional(),
  shape: z.string().optional(),
  min_relevance: z.number().min(0).max(1).optional(),
  limit: z.number().int().positive().max(50).default(10),
});

export type ConceptSearchInput = z.infer<typeof InputSchema>;

interface ConceptRow {
  id?: string;
  source_type?: string;
  shape?: string;
  summary?: string | null;
  content?: string | null;
  times_loaded?: number;
  times_succeeded?: number;
  times_failed?: number;
  relevance?: number;
  updated_at?: string;
  pointer?: { type?: string; metadata?: Record<string, unknown> };
}

interface ConceptSearchResponse {
  concepts?: ConceptRow[];
  count?: number;
  error?: string;
}

/**
 * Render one concept as the tool's text block, body included.
 *
 * The body is the reason this tool exists: without it a recalling agent can see
 * that a decision was recorded but not what it said.
 */
function renderConceptRow(c: ConceptRow, index: number, mode: 'preview' | 'full' | 'none'): string {
  const rel = typeof c.relevance === 'number' ? c.relevance.toFixed(2) : '–';
  const tl = c.times_loaded ?? 0;
  const ts = c.times_succeeded ?? 0;
  const tf = c.times_failed ?? 0;
  const id = plainConceptId(c.id);
  let out = `${index + 1}. [${c.source_type ?? '∅'}] ${c.shape ?? '∅'}\n`;
  out += `   id:       ${id}\n`;
  if (c.summary) out += `   summary:  ${c.summary}\n`;
  out += `   metrics:  rel=${rel}  loaded=${tl}  succeeded=${ts}${tf ? `  failed=${tf}` : ''}\n`;
  if (c.updated_at) out += `   updated:  ${c.updated_at}\n`;
  out += renderConceptContent(c.content, mode, { conceptId: id, budget: PREVIEW_CHAR_BUDGET });
  out += '\n';
  return out;
}

export async function handle(
  input: ConceptSearchInput,
  apiClient: AnalysisAPIClient,
): Promise<string> {
  if (!apiClient.hasDiscovery() && !process.env.CONCEPT_DB_URL) {
    return [
      'concept_search requires discovery or an explicit CONCEPT_DB_URL.',
      'Configure DISCOVERY_ENDPOINT to point at discovery-vessel,',
      'or set CONCEPT_DB_URL directly.',
    ].join(' ');
  }

  const start = Date.now();
  const apiKey = process.env.METABOB_API_KEY;
  const conceptDbUrl = await resolveServiceEndpointByShape({
    explicitUrl: process.env.CONCEPT_DB_URL,
    discoveryEndpoint: apiClient.getDiscoveryEndpoint(),
    shape: 'conceptGraph',
    apiKey,
  });
  if (!conceptDbUrl) {
    return 'concept_search could not find concept-db via discovery. Set CONCEPT_DB_URL explicitly or register concept-db with discovery.';
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;

  // Direct single-concept read. This is the guaranteed whole-body path: a
  // relevance-ordered search cannot deterministically target one concept, so
  // an agent that has an id (from a previous search, or from concept_neighbors)
  // reads it here. GET /concepts/:id is the same endpoint mark_complete's
  // verdict path already relies on.
  if (input.concept_id) {
    const plain = plainConceptId(input.concept_id);
    let one: Response;
    try {
      one = await fetch(`${conceptDbUrl}/concepts/${encodeURIComponent(plain)}`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `concept_search failed to reach ${conceptDbUrl}: ${msg}`;
    }
    if (one.status === 404) {
      return `No concept ${plain} (404 from concept-db).\n\nQuery completed in ${Date.now() - start}ms.`;
    }
    if (!one.ok) {
      const text = await one.text().catch(() => '');
      return `concept_search: ${one.status} ${text.slice(0, 200)}`;
    }
    const row = (await one.json()) as ConceptRow;
    // A direct read by id is an explicit request for THIS concept — always the
    // whole body, unless the caller explicitly asked for no content.
    const mode = input.content === 'none' ? 'none' : 'full';
    return (
      `1 concept (direct read by id)\n\n` +
      renderConceptRow(row, 0, mode) +
      `Query completed in ${Date.now() - start}ms.`
    );
  }

  const params = new URLSearchParams();
  if (input.query) params.set('query', input.query);
  if (input.source_type) params.set('source_type', input.source_type);
  if (input.shape) params.set('shape', input.shape);
  if (input.min_relevance !== undefined) params.set('min_relevance', String(input.min_relevance));
  params.set('limit', String(input.limit));

  const url = `${conceptDbUrl}/concepts/search?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `concept_search failed to reach ${conceptDbUrl}: ${msg}`;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return `concept_search: ${res.status} ${text.slice(0, 200)}`;
  }

  const payload = (await res.json()) as ConceptSearchResponse;
  const concepts = payload.concepts ?? [];
  const duration = Date.now() - start;

  if (concepts.length === 0) {
    const filters = [
      input.query ? `query="${input.query}"` : null,
      input.source_type ? `source_type=${input.source_type}` : null,
      input.shape ? `shape=${input.shape}` : null,
      input.min_relevance !== undefined ? `min_relevance>=${input.min_relevance}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    return `No concepts match (${filters || 'no filters'}).\n\nQuery completed in ${duration}ms.`;
  }

  let text = `${concepts.length} concept${concepts.length === 1 ? '' : 's'}`;
  if (typeof payload.count === 'number' && payload.count > concepts.length) {
    text += ` (showing ${concepts.length} of ${payload.count})`;
  }
  text += '\n\n';

  for (let i = 0; i < concepts.length; i++) {
    text += renderConceptRow(concepts[i]!, i, input.content);
  }

  text += `Query completed in ${duration}ms.`;
  return text;
}
