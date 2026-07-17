import { z } from 'zod';
import type { AnalysisAPIClient, AnalysisResult } from '../api-client.js';
import type { LocalStore } from '../local-store.js';

export const AnnotateComponentTool = {
  name: 'annotate_component',
  description:
    'Add structured notes for a detected problem. Use "explain" for why-focused notes, or "recommend" for how-to-fix notes. Works for agent-recorded findings too (agf_* ids from record_finding).',
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

function normaliseSeverity(severity?: string): string {
  return severity?.toUpperCase() || 'LOW';
}

function buildWhyNote(problem: AnalysisResult): string {
  const detail = problem.description && problem.description !== problem.summary
    ? problem.description
    : problem.summary;

  return [
    `${problem.summary} This is reported as a ${normaliseSeverity(problem.severity)} severity ${problem.category.toLowerCase()} issue in ${problem.path}.`,
    `The core concern is ${detail.charAt(0).toLowerCase()}${detail.slice(1)}`,
    `If left as-is, this can affect correctness, maintainability, or runtime behavior around lines ${problem.startLine}-${problem.endLine}.`,
  ].join(' ');
}

function buildHowNote(problem: AnalysisResult): string[] {
  const detail = problem.description && problem.description !== problem.summary
    ? problem.description
    : problem.summary;

  return [
    `Inspect the code in ${problem.path}:${problem.startLine}-${problem.endLine} and identify the concrete branch, type, or API usage behind: ${detail}`,
    `Change the implementation so the risky behavior in the summary is removed without weakening existing error handling or type guarantees.`,
    `Re-run the relevant Metabob analysis or local tests after the edit to confirm the issue no longer appears.`,
  ];
}

function formatContext(context?: string): string {
  if (!context?.trim()) {
    return '';
  }

  return `\nAdditional context\n${'─'.repeat(40)}\n${context.trim()}\n`;
}

export async function handle(
  input: AnnotateComponentInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  const startTime = Date.now();

  // ── Agent-recorded findings (record_finding → agf_* ids) ───────────────────
  // These live in the LocalStore, not the analysis API — mirror mark_complete's
  // branch so the full finding lifecycle (record → annotate → mark_complete)
  // works on agf ids.
  if (input.problem_id.startsWith('agf_')) {
    if (!localStore) {
      return `Finding "${input.problem_id}" cannot be annotated — local store unavailable in this session.`;
    }
    const seed = localStore.getSeedById(input.problem_id);
    if (!seed) {
      return `Finding "${input.problem_id}" not found in the local store. Use get_problems to list valid IDs.`;
    }

    let refs: string[] = [];
    try {
      refs = JSON.parse(seed.refs_json) as string[];
    } catch {
      // tolerate malformed refs — annotation still renders from the seed core
    }

    // Adapt the seed into the shape the note builders consume.
    const asProblem: AnalysisResult = {
      id: seed.id,
      path: seed.file_path,
      startLine: seed.line_start,
      endLine: seed.line_end,
      category: seed.category,
      severity: seed.severity,
      summary: seed.brief,
      description: refs.length ? `${seed.brief} (refs: ${refs.join(', ')})` : seed.brief,
    } as AnalysisResult;

    const duration = Date.now() - startTime;
    let text = `Notes for ${input.problem_id} (agent-recorded finding)\n${'═'.repeat(40)}\n\n`;
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
      text += `${buildWhyNote(asProblem)}\n`;
    } else {
      text += `How to address it\n${'─'.repeat(40)}\n`;
      for (const [index, step] of buildHowNote(asProblem).entries()) {
        text += `${index + 1}. ${step}\n`;
      }
    }

    text += formatContext(input.context);
    text += `\nGenerated locally in ${duration}ms`;
    return text;
  }

  const analysis = await apiClient.getAnalysis(sessionId);

  if (analysis.status === 'pending' || analysis.status === 'running') {
    return `Analysis is still ${analysis.status}${analysis.jobId ? ` (job: ${analysis.jobId})` : ''}. Try again in a moment.`;
  }

  if (analysis.status === 'failed') {
    return `Analysis job failed${analysis.jobId ? ` (job: ${analysis.jobId})` : ''}. Re-submit files via init_workspace.`;
  }

  const problem = (analysis.results ?? []).find(result => result.id === input.problem_id);
  if (!problem) {
    return `Problem ID "${input.problem_id}" not found. Use get_problems to list valid IDs.`;
  }

  const duration = Date.now() - startTime;
  let text = `Notes for ${input.problem_id}\n${'═'.repeat(40)}\n\n`;
  text += `Problem\n${'─'.repeat(40)}\n`;
  text += `Severity: ${normaliseSeverity(problem.severity)}\n`;
  text += `Category: ${problem.category}\n`;
  text += `File: ${problem.path}:${problem.startLine}-${problem.endLine}\n`;
  text += `Summary: ${problem.summary}\n`;

  if (problem.description && problem.description !== problem.summary) {
    text += `Detail: ${problem.description}\n`;
  }

  text += '\n';

  if (input.mode === 'explain') {
    text += `Why this matters\n${'─'.repeat(40)}\n`;
    text += `${buildWhyNote(problem)}\n`;
  } else {
    text += `How to address it\n${'─'.repeat(40)}\n`;
    for (const [index, step] of buildHowNote(problem).entries()) {
      text += `${index + 1}. ${step}\n`;
    }
  }

  text += formatContext(input.context);
  text += `\nGenerated locally in ${duration}ms`;
  return text;
}
