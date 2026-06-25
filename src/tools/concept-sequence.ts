/**
 * concept_sequence — predict-the-next-step neighbor lookup.
 *
 * Concept-db builds sequence_next / sequence_prev edges between concepts
 * that co-occur in successful traces. This tool exposes them so an MCP-side
 * agent can ask: "given I just resolved <concept_id>, what concept usually
 * comes next?" The result is weighted by joint-observation count.
 *
 * Pairs with concept_neighbors (typed traversal) and concept_search
 * (find the seed). Empty results today because sequence edges accumulate
 * over many successful traces; mostly useful once concept_sequence_record
 * has been called repeatedly by ribosome-style observers.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { resolveServiceEndpointByShape } from '../discovery.js';

export const ConceptSequenceTool = {
  name: 'concept_sequence',
  description:
    'Get the substrate\'s learned sequence neighbors for a concept (concepts that have co-occurred with this one in successful traces, weighted by joint observation count). Returns the most-likely next (or prev) concepts. Empty for fresh concepts; populates as concept_sequence_record is called by observers.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      concept_id: {
        type: 'string',
        description: 'Concept id (without the "concept:" prefix).',
      },
      direction: {
        type: 'string',
        enum: ['next', 'prev', 'both'],
        description: 'Direction along the sequence chain. Default: next.',
        default: 'next',
      },
      limit: {
        type: 'number',
        description: 'Max sequence neighbors (default: 10, max: 50)',
        default: 10,
      },
    },
    required: ['concept_id'],
  },
};

export const InputSchema = z.object({
  concept_id: z.string().min(1),
  direction: z.enum(['next', 'prev', 'both']).default('next'),
  limit: z.number().int().positive().max(50).default(10),
});

export type ConceptSequenceInput = z.infer<typeof InputSchema>;

interface SequenceEntry {
  concept_id?: string;
  weight?: number;
  times_traversed?: number;
}

interface SequenceResponse {
  sequence?: SequenceEntry[];
  error?: string;
}

export async function handle(
  input: ConceptSequenceInput,
  apiClient: AnalysisAPIClient,
): Promise<string> {
  if (!apiClient.hasDiscovery() && !process.env.CONCEPT_DB_URL) {
    return 'concept_sequence requires discovery or an explicit CONCEPT_DB_URL.';
  }

  const start = Date.now();
  const apiKey = process.env.METABOB_API_KEY;
  const conceptDbUrl = await resolveServiceEndpointByShape({
    explicitUrl: process.env.CONCEPT_DB_URL,
    discoveryEndpoint: apiClient.getDiscoveryEndpoint(),
    shape: 'concept',
    apiKey,
  });
  if (!conceptDbUrl) {
    return 'concept_sequence could not find concept-db via discovery. Set CONCEPT_DB_URL explicitly or register concept-db with discovery.';
  }
  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;

  const params = new URLSearchParams();
  params.set('direction', input.direction);
  params.set('limit', String(input.limit));

  const url = `${conceptDbUrl}/concepts/${encodeURIComponent(input.concept_id)}/sequence?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `concept_sequence failed to reach ${conceptDbUrl}: ${msg}`;
  }
  if (!res.ok) {
    return `concept_sequence: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`;
  }

  const payload = (await res.json()) as SequenceResponse;
  const seq = payload.sequence ?? [];
  const duration = Date.now() - start;

  if (seq.length === 0) {
    return `No sequence neighbors for concept ${input.concept_id} (direction=${input.direction}).\n\nThe substrate hasn't yet observed enough co-occurrences to predict a sequence step from this concept. Query completed in ${duration}ms.`;
  }

  let text = `${seq.length} sequence ${input.direction === 'prev' ? 'predecessor' : 'successor'}${seq.length === 1 ? '' : 's'} of ${input.concept_id}\n\n`;
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i]!;
    const cid = (s.concept_id ?? '').replace(/^concept:/, '');
    const w = typeof s.weight === 'number' ? s.weight.toFixed(2) : '–';
    text += `${i + 1}. ${cid}\n`;
    text += `   weight=${w}  traversed=${s.times_traversed ?? 0}\n\n`;
  }
  text += `Query completed in ${duration}ms.`;
  return text;
}
