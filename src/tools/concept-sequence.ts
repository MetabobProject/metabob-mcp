// Contract (input schema, behaviour): SPEC §concept_sequence
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
 *
 * Read as the `conceptSequence` shape through discovery `POST /resolve`
 * (src/tools/_concept-db.ts). CONFORMANCE §c11-attachment-model
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { conceptSequence } from './_concept-db.js';

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

export async function handle(
  input: ConceptSequenceInput,
  _apiClient: AnalysisAPIClient,
): Promise<string> {
  const start = Date.now();
  const found = await conceptSequence(input.concept_id, input.direction, input.limit);
  if (!found.ok) {
    return `concept_sequence: ${found.error}`;
  }
  const seq = found.value as SequenceEntry[];
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
