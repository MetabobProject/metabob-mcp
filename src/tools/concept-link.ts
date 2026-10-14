// Contract (input schema, behaviour): SPEC §concept_link
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
 *
 * Written as the `conceptLink_write` shape through discovery `POST /resolve`
 * (src/tools/_concept-db.ts), once — a write is never retried. concept-db
 * upserts the edge. CONFORMANCE §c11-attachment-model
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { linkConcepts } from './_concept-db.js';

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

/** What `conceptLink_write` returns: the edge id, whether it is new, and its weight after the write. */
interface LinkResult {
  id?: string;
  created?: boolean;
  new_weight?: number;
  previous_weight?: number;
}

export async function handle(
  input: ConceptLinkInput,
  _apiClient: AnalysisAPIClient,
): Promise<string> {
  const start = Date.now();

  const linkData: Record<string, unknown> = {
    from_concept_id: input.from_concept_id,
    to_concept_id: input.to_concept_id,
    edge_type: input.edge_type,
    ...(input.description ? { description: input.description } : {}),
    ...(input.weight !== undefined ? { weight: input.weight } : {}),
  };

  const linked = await linkConcepts(linkData);
  if (!linked.ok) {
    return `concept_link: ${linked.error}`;
  }

  const edge = linked.value as LinkResult;
  const duration = Date.now() - start;
  const edgeId = String(edge.id ?? '').replace(/^concept_edge:/, '');
  const w = typeof edge.new_weight === 'number' ? edge.new_weight.toFixed(2) : '–';

  // conceptLink_write upserts: a repeated (from, to, edge_type) moves the
  // existing edge's weight by EMA instead of adding a second edge.
  let text = edge.created === false
    ? `Edge exists; weight updated in ${duration}ms\n\n`
    : `Edge created in ${duration}ms\n\n`;
  text += `  id:          ${edgeId}\n`;
  text += `  from:        ${input.from_concept_id}\n`;
  text += `  to:          ${input.to_concept_id}\n`;
  text += `  edge_type:   ${input.edge_type}\n`;
  text += `  weight:      ${w}\n`;
  if (typeof edge.previous_weight === 'number') text += `  previous:    ${edge.previous_weight.toFixed(2)}\n`;
  if (input.description) text += `  description: ${input.description}\n`;
  return text;
}
