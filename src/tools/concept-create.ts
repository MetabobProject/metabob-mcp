// Contract (input schema, behaviour): SPEC §concept_create
/**
 * concept_create — mint a typed concept into the substrate concept graph.
 *
 * Pairs with concept_link to give the agent loop full write access. Use to
 * preserve knowledge surfaced during a session (idioms discovered, design
 * constraints inferred, anti-patterns observed) so future sessions inherit it.
 *
 * Source-type taxonomy (mapped to the substrate's concept categories):
 *  - vessel_construction_pattern  → constitutional (how vessels are built;
 *                                   from CLAUDE.md, foundation docs, specs)
 *  - impulse_activity_pattern     → constitutional (the impulse/activity model;
 *                                   from IMPULSE_ACTIVITY_FOUNDATION.md)
 *  - extracted                    → empirical (idioms / patterns extracted
 *                                   from observed traces or repeated work)
 *  - memo                         → procedural (operator-authored notes,
 *                                   findings, percolations)
 *  - human_input                  → ephemeral (user instructions that
 *                                   shaped a decision worth remembering)
 *  - goal                         → goal-shaped concepts (rare; usually
 *                                   minted by goal-host-vessel)
 *  - llm                          → LLM-generated rationales worth preserving
 *  - read / write                 → file-content concepts (large; sparingly)
 *  - cpg_embedding                → code structure concepts (minted by
 *                                   bridge / per-symbol fan-out, not by hand)
 *  - search                       → search-hit concepts
 *  - metabob_annotation           → analysis-vessel results (bridge-managed)
 *  - impulse_signature            → shape-level signatures (bridge-managed)
 *
 * Concepts are embedded server-side; embedding model is shared across the
 * substrate so cross-concept similarity search works out of the box.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { resolveServiceEndpointByShape } from '../discovery.js';

const SOURCE_TYPES = [
  'goal',
  'memo',
  'human_input',
  'search',
  'llm',
  'metabob_annotation',
  'write',
  'read',
  'cpg_embedding',
  'extracted',
  'impulse_signature',
  'vessel_construction_pattern',
  'impulse_activity_pattern',
] as const;

export const ConceptCreateTool = {
  name: 'concept_create',
  description:
    'Mint a typed concept into the substrate concept graph. Use to preserve knowledge surfaced during a session — design constraints, idioms, anti-patterns, decisions, findings — so future sessions inherit it. Pairs with concept_link to wire the new concept into the existing graph.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      content: {
        type: 'string',
        description: 'The concept body. Will be embedded for similarity search.',
      },
      summary: {
        type: 'string',
        description: 'One-line gist (rendered in concept_search results).',
      },
      shape: {
        type: 'string',
        description:
          'The impulse shape this concept represents. Use existing shape names where possible (e.g. "vessel_construction_pattern", "failure_mode_taxonomy"). Free-form.',
      },
      source_type: {
        type: 'string',
        enum: SOURCE_TYPES as unknown as string[],
        description:
          'Which substrate category. vessel_construction_pattern / impulse_activity_pattern for constitutional knowledge; memo for findings/percolations; extracted for trace-derived patterns; human_input for session-shaped decisions.',
      },
      pointer: {
        type: 'object',
        description:
          'Optional pointer envelope. For document concepts pass {type: "memo", path: "<file>", section: "<heading>"} or similar.',
      },
      budget: {
        type: 'number',
        description: 'Token budget for resolution snapshots (default: 2000).',
      },
      priority: {
        type: 'number',
        description: 'Initial priority 0.0–1.0 (default: 0.5).',
      },
    },
    required: ['content', 'source_type', 'shape'],
  },
};

export const InputSchema = z.object({
  content: z.string().min(1),
  summary: z.string().optional(),
  shape: z.string().min(1),
  source_type: z.enum(SOURCE_TYPES),
  pointer: z.record(z.unknown()).optional(),
  budget: z.number().int().positive().optional(),
  priority: z.number().min(0).max(1).optional(),
});

export type ConceptCreateInput = z.infer<typeof InputSchema>;

interface ConceptResponse {
  id?: string;
  shape?: string;
  source_type?: string;
  summary?: string | null;
  budget?: number;
  priority?: number;
  created_at?: string;
  error?: string;
}

export async function handle(
  input: ConceptCreateInput,
  apiClient: AnalysisAPIClient,
): Promise<string> {
  if (!apiClient.hasDiscovery() && !process.env.CONCEPT_DB_URL) {
    return 'concept_create requires discovery or an explicit CONCEPT_DB_URL.';
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
    return 'concept_create could not find concept-db via discovery. Set CONCEPT_DB_URL explicitly or register concept-db with discovery.';
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;

  // Pointer defaults: use source_type as pointer.type if caller didn't pass one.
  // concept-db's CreateConceptRequestSchema requires pointer.
  const pointer = input.pointer ?? { type: input.shape };

  const body: Record<string, unknown> = {
    content: input.content,
    shape: input.shape,
    source_type: input.source_type,
    pointer,
  };
  if (input.summary) body.summary = input.summary;
  if (input.budget !== undefined) body.budget = input.budget;
  if (input.priority !== undefined) body.priority = input.priority;

  const url = `${conceptDbUrl}/concepts`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `concept_create failed to reach ${conceptDbUrl}: ${msg}`;
  }
  if (!res.ok) {
    return `concept_create: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`;
  }

  const concept = (await res.json()) as ConceptResponse;
  const duration = Date.now() - start;
  const id = (concept.id ?? '').replace(/^concept:/, '');

  let text = `Concept created in ${duration}ms\n\n`;
  text += `  id:          ${id}\n`;
  text += `  shape:       ${concept.shape ?? input.shape}\n`;
  text += `  source_type: ${concept.source_type ?? input.source_type}\n`;
  if (concept.summary) text += `  summary:     ${concept.summary}\n`;
  text += `  budget:      ${concept.budget ?? '?'}\n`;
  text += `  priority:    ${typeof concept.priority === 'number' ? concept.priority.toFixed(2) : '?'}\n`;
  if (concept.created_at) text += `  created_at:  ${concept.created_at}\n`;
  text += '\nUse concept_link to wire this concept into the existing graph.';
  return text;
}
