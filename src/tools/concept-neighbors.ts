/**
 * concept_neighbors — graph traversal from a known concept to its neighbors.
 *
 * Pairs with concept_search: search to find the seed concept, neighbors to
 * walk the substrate's learned graph. Edges are typed (related_to,
 * derived_from, resolves_to, sequence_next/prev, description_of, example_of,
 * contradicts) so traversal can be intent-scoped.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { resolveServiceEndpointByShape } from '../discovery.js';

export const ConceptNeighborsTool = {
  name: 'concept_neighbors',
  description:
    'Get the graph neighbors of a concept by id. Returns one entry per edge, with the neighbor concept (shape, summary, relevance) and the edge (type, weight). Use this to walk the substrate concept graph from a seed concept found via concept_search.',
  inputSchema: {
    type: 'object' as const,
    properties: {
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
    relevance?: number;
  };
  edge?: {
    edge_type?: string;
    weight?: number;
    times_traversed?: number;
    description?: string;
  };
}

interface NeighborsResponse {
  neighbors?: NeighborEntry[];
  error?: string;
}

export async function handle(
  input: ConceptNeighborsInput,
  apiClient: AnalysisAPIClient,
): Promise<string> {
  if (!apiClient.hasDiscovery() && !process.env.CONCEPT_DB_URL) {
    return 'concept_neighbors requires discovery or an explicit CONCEPT_DB_URL.';
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
    return 'concept_neighbors could not find concept-db via discovery. Set CONCEPT_DB_URL explicitly or register concept-db with discovery.';
  }
  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;

  const params = new URLSearchParams();
  params.set('direction', input.direction);
  params.set('limit', String(input.limit));
  if (input.edge_types) for (const t of input.edge_types) params.append('edge_types', t);

  const url = `${conceptDbUrl}/concepts/${encodeURIComponent(input.concept_id)}/neighbors?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `concept_neighbors failed to reach ${conceptDbUrl}: ${msg}`;
  }
  if (!res.ok) {
    return `concept_neighbors: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`;
  }

  const payload = (await res.json()) as NeighborsResponse;
  const neighbors = payload.neighbors ?? [];
  const duration = Date.now() - start;

  if (neighbors.length === 0) {
    return `No neighbors for concept ${input.concept_id} (direction=${input.direction}${input.edge_types ? `, edge_types=${input.edge_types.join(',')}` : ''}).\n\nQuery completed in ${duration}ms.`;
  }

  let text = `${neighbors.length} neighbor${neighbors.length === 1 ? '' : 's'} of ${input.concept_id}\n\n`;
  for (let i = 0; i < neighbors.length; i++) {
    const n = neighbors[i]!;
    const cid = (n.concept?.id ?? '').replace(/^concept:/, '');
    const edge = n.edge ?? {};
    const w = typeof edge.weight === 'number' ? edge.weight.toFixed(2) : '–';
    text += `${i + 1}. [${edge.edge_type ?? '?'}] ${n.concept?.shape ?? '∅'}\n`;
    text += `   neighbor: ${cid}\n`;
    if (n.concept?.summary) text += `   summary:  ${n.concept.summary}\n`;
    text += `   edge:     weight=${w}  traversed=${edge.times_traversed ?? 0}\n`;
    if (typeof n.concept?.relevance === 'number') {
      text += `   relevance:${n.concept.relevance.toFixed(2)}\n`;
    }
    text += '\n';
  }
  text += `Query completed in ${duration}ms.`;
  return text;
}
