// Contract (input schema, behaviour): SPEC §concept_neighbors
/**
 * concept_neighbors — graph traversal from a known concept to its neighbors.
 *
 * Pairs with concept_search: search to find the seed concept, neighbors to
 * walk the substrate's learned graph. Edges are typed (related_to,
 * derived_from, resolves_to, sequence_next/prev, description_of, example_of,
 * contradicts) so traversal can be intent-scoped.
 *
 * Read as the `conceptGraph` shape through discovery `POST /resolve`
 * (src/tools/_concept-db.ts): its edges carry the full edge and neighbour rows.
 * CONFORMANCE §c11-attachment-model
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { conceptGraph } from './_concept-db.js';
import { renderConceptContent, plainConceptId, PREVIEW_CHAR_BUDGET } from './_concept-content.js';

export const ConceptNeighborsTool = {
  name: 'concept_neighbors',
  description:
    'Get the graph neighbors of a concept by id. Returns one entry per edge, with the neighbor concept (shape, summary, relevance, and its content body) and the edge (type, weight). Bodies are previewed (verbatim first ~700 chars, truncation disclosed) so you can read what a neighbouring concept actually records; pass content:"full" for whole bodies, or read one neighbour in full with concept_search concept_id=<id>. Use this to walk the substrate concept graph from a seed concept found via concept_search.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      content: {
        type: 'string',
        enum: ['preview', 'full', 'none'],
        description:
          'How much of each neighbour concept body to render. preview (default) = verbatim first ~700 chars with truncation disclosed; full = whole body; none = omit bodies.',
        default: 'preview',
      },
      concept_id: {
        type: 'string',
        description: 'Concept id (without the "concept:" prefix). From concept_search results.',
      },
      direction: {
        type: 'string',
        enum: ['outgoing', 'incoming', 'both'],
        description: 'Edge direction to follow. Default: both.',
        default: 'both',
      },
      edge_types: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Filter by edge type. Examples: related_to, derived_from, resolves_to, sequence_next, sequence_prev, description_of, example_of, contradicts.',
      },
      limit: {
        type: 'number',
        description: 'Max neighbors (default: 10, max: 50)',
        default: 10,
      },
    },
    required: ['concept_id'],
  },
};

export const InputSchema = z.object({
  concept_id: z.string().min(1),
  content: z.enum(['preview', 'full', 'none']).default('preview'),
  direction: z.enum(['outgoing', 'incoming', 'both']).default('both'),
  edge_types: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(50).default(10),
});

export type ConceptNeighborsInput = z.infer<typeof InputSchema>;

interface NeighborEntry {
  concept?: {
    id?: string;
    shape?: string;
    source_type?: string;
    summary?: string | null;
    content?: string | null;
    relevance?: number;
  };
  edge?: {
    edge_type?: string;
    weight?: number;
    times_traversed?: number;
    description?: string;
  };
}

export async function handle(
  input: ConceptNeighborsInput,
  _apiClient: AnalysisAPIClient,
): Promise<string> {
  const start = Date.now();

  const conceptId = plainConceptId(input.concept_id);
  const graph = await conceptGraph(conceptId, {
    direction: input.direction,
    edge_types: input.edge_types,
    limit: input.limit,
  });
  if (!graph.ok) {
    return `concept_neighbors: ${graph.error}`;
  }
  // concept-db answers 404 for an unknown root: no concept, so no neighbours.
  const neighbors: NeighborEntry[] = (graph.value?.edges ?? []).map((e) => ({ concept: e.neighbor, edge: e.edge }));
  const duration = Date.now() - start;

  if (neighbors.length === 0) {
    return `No neighbors for concept ${conceptId} (direction=${input.direction}${input.edge_types ? `, edge_types=${input.edge_types.join(',')}` : ''}).\n\nQuery completed in ${duration}ms.`;
  }

  let text = `${neighbors.length} neighbor${neighbors.length === 1 ? '' : 's'} of ${conceptId}\n\n`;
  for (let i = 0; i < neighbors.length; i++) {
    const n = neighbors[i]!;
    const cid = plainConceptId(n.concept?.id);
    const edge = n.edge ?? {};
    const w = typeof edge.weight === 'number' ? edge.weight.toFixed(2) : '–';
    text += `${i + 1}. [${edge.edge_type ?? '?'}] ${n.concept?.shape ?? '∅'}\n`;
    text += `   neighbor: ${cid}\n`;
    if (n.concept?.summary) text += `   summary:  ${n.concept.summary}\n`;
    text += `   edge:     weight=${w}  traversed=${edge.times_traversed ?? 0}\n`;
    if (typeof n.concept?.relevance === 'number') {
      text += `   relevance:${n.concept.relevance.toFixed(2)}\n`;
    }
    // The neighbour's body. Without it, traversal shows an agent that a related
    // decision exists but never what it says — the defect this tool shared with
    // concept_search.
    text += renderConceptContent(n.concept?.content, input.content, {
      conceptId: cid,
      budget: PREVIEW_CHAR_BUDGET,
      fullBodyHint: id =>
        id
          ? `re-run with content="full", or read it directly with concept_search concept_id="${id}"`
          : 're-run with content="full"',
    });
    text += '\n';
  }
  text += `Query completed in ${duration}ms.`;
  return text;
}
