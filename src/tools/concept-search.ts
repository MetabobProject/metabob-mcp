/**
 * concept_search — query the substrate's concept-db for accumulated concepts.
 *
 * Lets an MCP-side agent loop read what the concept-bridge-observer (and any
 * future minters) have been writing into concept-db. The bridge auto-mints
 * `impulse_signature` concepts every time analysis-vessel resolves a shape,
 * so over time this becomes a per-shape leaderboard of "which analysis
 * surfaces does the substrate actually exercise."
 *
 * Auth: this tool only runs in vessel mode (when ANALYSIS_API_URL points at
 * the substrate stack). It bypasses the legacy api-client routes and talks
 * directly to concept-db over CONCEPT_DB_URL.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

const DEFAULT_CONCEPT_DB_URL = process.env.CONCEPT_DB_URL || 'http://127.0.0.1:18260';

export const ConceptSearchTool = {
  name: 'concept_search',
  description:
    'Search the substrate concept-db for accumulated concepts. Concepts are the substrate\'s typed knowledge units (impulse signatures, code symbols, learned patterns) with Bayesian relevance scores. Use to inspect what the substrate has been observing and learning from MCP traffic and from autonomous activity executions. Returns concept ids, shapes, summaries, success/load counts, and relevance.',
  inputSchema: {
    type: 'object' as const,
    properties: {
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

export async function handle(
  input: ConceptSearchInput,
  apiClient: AnalysisAPIClient,
): Promise<string> {
  if (!apiClient.isVesselMode()) {
    return [
      'concept_search is only available in vessel mode.',
      'Configure ANALYSIS_API_URL to point at a substrate analysis-vessel,',
      'and ensure CONCEPT_DB_URL points at the substrate concept-db (default http://127.0.0.1:18260).',
    ].join(' ');
  }

  const start = Date.now();
  const apiKey = process.env.METABOB_API_KEY;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;

  const params = new URLSearchParams();
  if (input.query) params.set('query', input.query);
  if (input.source_type) params.set('source_type', input.source_type);
  if (input.shape) params.set('shape', input.shape);
  if (input.min_relevance !== undefined) params.set('min_relevance', String(input.min_relevance));
  params.set('limit', String(input.limit));

  const url = `${DEFAULT_CONCEPT_DB_URL}/concepts/search?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `concept_search failed to reach ${DEFAULT_CONCEPT_DB_URL}: ${msg}`;
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
    const c = concepts[i]!;
    const rel = typeof c.relevance === 'number' ? c.relevance.toFixed(2) : '–';
    const tl = c.times_loaded ?? 0;
    const ts = c.times_succeeded ?? 0;
    const tf = c.times_failed ?? 0;
    const id = (c.id ?? '').replace(/^concept:/, '');
    text += `${i + 1}. [${c.source_type ?? '∅'}] ${c.shape ?? '∅'}\n`;
    text += `   id:       ${id}\n`;
    if (c.summary) text += `   summary:  ${c.summary}\n`;
    text += `   metrics:  rel=${rel}  loaded=${tl}  succeeded=${ts}${tf ? `  failed=${tf}` : ''}\n`;
    if (c.updated_at) text += `   updated:  ${c.updated_at}\n`;
    text += '\n';
  }

  text += `Query completed in ${duration}ms.`;
  return text;
}
