// Contract (input schema, behaviour): SPEC §annotate_component
import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import type { LocalStore, SeedRecord } from '../local-store.js';

export const AnnotateComponentTool = {
  name: 'annotate_component',
  description:
    'Add structured notes for a problem in the local store. Use "explain" for why-focused notes, or "recommend" for how-to-fix notes. Takes an id from get_problems (agf_* ids from record_finding). Notes are built locally; there is no server-side analysis to annotate.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      problem_id: {
        type: 'string',
        description: 'Problem ID from get_problems',
      },
      mode: {
        type: 'string',
        description: '"explain" — notes about why the issue matters. "recommend" — notes about how to fix it.',
        enum: ['explain', 'recommend'],
        default: 'explain',
      },
      context: {
        type: 'string',
        description: 'Additional context to fold into the notes (optional)',
      },
    },
    required: ['problem_id'],
  },
};

export const InputSchema = z.object({
  problem_id: z.string().min(1),
  mode: z.enum(['explain', 'recommend']).default('explain'),
  context: z.string().optional(),
});

export type AnnotateComponentInput = z.infer<typeof InputSchema>;

/** The parts of a finding the note builders read. */
interface NoteSubject {
  path: string;
  startLine: number;
  endLine: number;
  category: string;
  severity: string;
  summary: string;
  description: string;
}

function normaliseSeverity(severity?: string): string {
  return severity?.toUpperCase() || 'LOW';
}

function buildWhyNote(problem: NoteSubject): string {
  const detail = problem.description && problem.description !== problem.summary
    ? problem.description
    : problem.summary;

  return [
    `${problem.summary} This is reported as a ${normaliseSeverity(problem.severity)} severity ${problem.category.toLowerCase()} issue in ${problem.path}.`,
    `The core concern is ${detail.charAt(0).toLowerCase()}${detail.slice(1)}`,
    `If left as-is, this can affect correctness, maintainability, or runtime behavior around lines ${problem.startLine}-${problem.endLine}.`,
  ].join(' ');
}

function buildHowNote(problem: NoteSubject): string[] {
  const detail = problem.description && problem.description !== problem.summary
    ? problem.description
    : problem.summary;

  return [
    `Inspect the code in ${problem.path}:${problem.startLine}-${problem.endLine} and identify the concrete branch, type, or API usage behind: ${detail}`,
    `Change the implementation so the risky behavior in the summary is removed without weakening existing error handling or type guarantees.`,
    `Re-run the relevant local tests after the edit to confirm the issue no longer appears, then close it with mark_complete.`,
  ];
}

function formatContext(context?: string): string {
  if (!context?.trim()) {
    return '';
  }

  return `\nAdditional context\n${'─'.repeat(40)}\n${context.trim()}\n`;
}

function subjectFromSeed(seed: SeedRecord, refs: string[]): NoteSubject {
  return {
    path: seed.file_path,
    startLine: seed.line_start,
    endLine: seed.line_end,
    category: seed.category,
    severity: seed.severity,
    summary: seed.brief,
    description: refs.length ? `${seed.brief} (refs: ${refs.join(', ')})` : seed.brief,
  };
}

export async function handle(
  input: AnnotateComponentInput,
  _apiClient: AnalysisAPIClient,
  _sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  const startTime = Date.now();

  // Every annotatable problem is a seed in the local store — agent-recorded
  // findings (agf_*) first among them. There is no server-side analysis to
  // look an id up in.
  if (!localStore) {
    return `Problem "${input.problem_id}" cannot be annotated — the local store failed to open in this session (see the startup log), and there is no server-side analysis.`;
  }
  const seed = localStore.getSeedById(input.problem_id);
  if (!seed) {
    return `Problem "${input.problem_id}" not found in the local store. Use get_problems to list valid IDs; there is no server-side analysis, so only local findings can be annotated.`;
  }

  let refs: string[] = [];
  try {
    refs = JSON.parse(seed.refs_json) as string[];
  } catch {
    // tolerate malformed refs — annotation still renders from the seed core
  }
  const subject = subjectFromSeed(seed, refs);
  const kind = seed.id.startsWith('agf_') ? 'agent-recorded finding' : 'local finding';

  const duration = Date.now() - startTime;
  let text = `Notes for ${input.problem_id} (${kind})\n${'═'.repeat(40)}\n\n`;
  text += `Finding\n${'─'.repeat(40)}\n`;
  text += `Severity: ${normaliseSeverity(seed.severity)}\n`;
  text += `Category: ${seed.category}\n`;
  text += `File: ${seed.file_path}:${seed.line_start}-${seed.line_end}\n`;
  text += `Summary: ${seed.brief}\n`;
  if (refs.length) {
    text += `Refs: ${refs.join(', ')}\n`;
  }
  text += `Status: ${seed.stale ? 'resolved (stale)' : 'open'}\n\n`;

  if (input.mode === 'explain') {
    text += `Why this matters\n${'─'.repeat(40)}\n`;
    text += `${buildWhyNote(subject)}\n`;
  } else {
    text += `How to address it\n${'─'.repeat(40)}\n`;
    for (const [index, step] of buildHowNote(subject).entries()) {
      text += `${index + 1}. ${step}\n`;
    }
  }

  text += formatContext(input.context);
  text += `\nGenerated locally in ${duration}ms`;
  return text;
}
