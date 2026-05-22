import { z } from 'zod';
import type { AnalysisAPIClient, AnalysisResult } from '../api-client.js';

export const AnnotateComponentTool = {
  name: 'annotate_component',
  description:
    'Add structured notes for a detected problem. Use "explain" for why-focused notes, or "recommend" for how-to-fix notes.',
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
): Promise<string> {
  const startTime = Date.now();
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
