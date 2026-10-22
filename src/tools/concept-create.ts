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
 *
 * Written as the `concept_create_write` shape through discovery `POST /resolve`
 * (src/tools/_concept-db.ts), once — a write is never retried.
 * CONFORMANCE §c11-attachment-model
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { createConcept } from './_concept-db.js';
import { plainConceptId } from './_concept-content.js';
import { attributionLines, resolveAuthorVesselId } from './_findings.js';

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

// @anchor concept-author-stamp
/**
 * The author of a concept, stamped as record_finding stamps a finding's: `recorded_by: <vesselId>` and
 * `session: <id>` as the content's first lines, so every reader's first match is the stamp (task pull's convention
 * trust reads the first `recorded_by:`). A `recorded_by:` or `session:` line the agent wrote is replaced, and the
 * reply says so. With no vessel identity nothing is stamped and the content is sent as written: an author is
 * omitted, never faked. Declared, not verified, like every author line until principals are stamped from the
 * credential. SPEC §concept_create
 */
export function stampAuthor(content: string, vesselId: string | undefined, sessionId: string | undefined): { content: string; replaced: string[] } {
  if (!vesselId) return { content, replaced: [] };
  const replaced: string[] = [];
  const kept = content.split('\n').filter((line) => {
    const m = /^(recorded_by|session):\s*(.*)$/.exec(line);
    if (!m) return true;
    replaced.push(`${m[1]}: ${m[2]}`);
    return false;
  });
  return { content: [...attributionLines('recorded_by', vesselId, sessionId), ...kept].join('\n'), replaced };
}

export async function handle(
  input: ConceptCreateInput,
  _apiClient: AnalysisAPIClient,
  sessionId?: string,
): Promise<string> {
  const start = Date.now();
  const vesselId = await resolveAuthorVesselId();
  const stamped = stampAuthor(input.content, vesselId, sessionId);

  // Pointer defaults: use the shape as pointer.type if caller didn't pass one.
  // concept-db's CreateConceptRequestSchema takes the pointer verbatim.
  const pointer = input.pointer ?? { type: input.shape };

  const conceptData: Record<string, unknown> = {
    content: stamped.content,
    shape: input.shape,
    source_type: input.source_type,
    pointer,
  };
  if (input.summary) conceptData.summary = input.summary;
  if (input.budget !== undefined) conceptData.budget = input.budget;
  if (input.priority !== undefined) conceptData.priority = input.priority;

  const created = await createConcept(conceptData);
  if (!created.ok) {
    return `concept_create: ${created.error}`;
  }

  const concept = created.value as ConceptResponse;
  const duration = Date.now() - start;
  const id = plainConceptId(concept.id);

  let text = `Concept created in ${duration}ms\n\n`;
  text += `  id:          ${id}\n`;
  text += `  shape:       ${concept.shape ?? input.shape}\n`;
  text += `  source_type: ${concept.source_type ?? input.source_type}\n`;
  if (concept.summary) text += `  summary:     ${concept.summary}\n`;
  text += `  budget:      ${concept.budget ?? '?'}\n`;
  text += `  priority:    ${typeof concept.priority === 'number' ? concept.priority.toFixed(2) : '?'}\n`;
  if (concept.created_at) text += `  created_at:  ${concept.created_at}\n`;
  text += vesselId
    ? `  recorded_by: ${vesselId} (stamped first in the content)\n`
    : '  recorded_by: not stamped: no vessel identity resolves for this session\n';
  if (stamped.replaced.length) text += `  replaced:    ${stamped.replaced.join('; ')} (an author line is the tool's to write)\n`;
  text += '\nUse concept_link to wire this concept into the existing graph.';
  return text;
}
