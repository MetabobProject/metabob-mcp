/**
 * concept_link — write a typed edge between two concepts.
 *
 * The write half of the MCP↔concept-db surface. Pairs with the four read tools
 * (concept_search, concept_neighbors, concept_usage_stats, concept_sequence)
 * so an agent loop can both observe and contribute to the substrate's
 * concept graph during a session.
 *
 * Use cases:
 *  - Mark two concepts as `contradicts` when the agent observes one disproving
 *    the assumption the other encodes.
 *  - Add a `derived_from` edge when the agent generates a new concept from
 *    an existing one.
 *  - Record a `description_of` link from an explanation concept to the
 *    code-symbol concept it describes.
 *  - Add `example_of` when the agent finds a concrete instance of a pattern.
 *
 * Concept-db's upkeep activities (decay-stale-relevance, prune-irrelevant-
 * neighbors) will eventually adjust or retire low-weight edges that don't
 * accumulate evidence, so the agent's writes are advisory not authoritative.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

const DEFAULT_CONCEPT_DB_URL = process.env.CONCEPT_DB_URL || 'http://127.0.0.1:18260';

const EDGE_TYPES = [
  'related_to',
  'derived_from',
  'resolves_to',
  'sequence_next',
  'sequence_prev',
  'description_of',
  'example_of',
  'contradicts',
] as const;

export const ConceptLinkTool = {
  name: 'concept_link',
  description:
    'Create a typed directed edge between two concepts in the substrate concept graph. Edge types: related_to (general), derived_from (parent→child derivation), resolves_to (resolution pointer), sequence_next/prev (chain), description_of (explains another concept), example_of (concrete instance), contradicts (mutually exclusive). The substrate\'s upkeep activities will adjust or prune low-weight edges over time, so this is advisory.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      from_concept_id: {
        type: 'string',
        description: 'Source concept id (without the "concept:" prefix).',
      },
      to_concept_id: {
        type: 'string',
        description: 'Target concept id (without the "concept:" prefix).',
      },
      edge_type: {
        type: 'string',
        enum: EDGE_TYPES as unknown as string[],
        description: 'Typed relationship between source and target.',
      },
      description: {
        type: 'string',
        description: 'Optional rationale for the edge — surfaces in concept-db reads.',
      },
      weight: {
        type: 'number',
        description:
          'Initial edge weight 0.0–1.0 (default: 0.5). Upkeep activities will adjust based on traversal evidence.',
      },
    },
    required: ['from_concept_id', 'to_concept_id', 'edge_type'],
  },
};

export const InputSchema = z.object({
  from_concept_id: z.string().min(1),
  to_concept_id: z.string().min(1),
  edge_type: z.enum(EDGE_TYPES),
  description: z.string().optional(),
  weight: z.number().min(0).max(1).optional(),
});

export type ConceptLinkInput = z.infer<typeof InputSchema>;

interface EdgeResponse {
  id?: string;
  from_concept?: string;
  to_concept?: string;
  edge_type?: string;
  weight?: number;
  description?: string;
  created_at?: string;
  error?: string;
}

export async function handle(
  input: ConceptLinkInput,
  apiClient: AnalysisAPIClient,
): Promise<string> {
  if (!apiClient.isVesselMode()) {
    return 'concept_link is only available in vessel mode.';
  }

  const start = Date.now();
  const apiKey = process.env.METABOB_API_KEY;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;

  const body = {
    to_concept_id: input.to_concept_id,
    edge_type: input.edge_type,
    ...(input.description ? { description: input.description } : {}),
    ...(input.weight !== undefined ? { weight: input.weight } : {}),
  };

  const url = `${DEFAULT_CONCEPT_DB_URL}/concepts/${encodeURIComponent(input.from_concept_id)}/link`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `concept_link failed to reach ${DEFAULT_CONCEPT_DB_URL}: ${msg}`;
  }
  if (!res.ok) {
    return `concept_link: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`;
  }

  const edge = (await res.json()) as EdgeResponse;
  const duration = Date.now() - start;
  const edgeId = (edge.id ?? '').replace(/^concept_edge:/, '');
  const w = typeof edge.weight === 'number' ? edge.weight.toFixed(2) : '–';

  let text = `Edge created in ${duration}ms\n\n`;
  text += `  id:          ${edgeId}\n`;
  text += `  from:        ${input.from_concept_id}\n`;
  text += `  to:          ${input.to_concept_id}\n`;
  text += `  edge_type:   ${edge.edge_type ?? input.edge_type}\n`;
  text += `  weight:      ${w}\n`;
  if (edge.description) text += `  description: ${edge.description}\n`;
  if (edge.created_at) text += `  created_at:  ${edge.created_at}\n`;
  return text;
}
