import { z } from 'zod';
import type { AnalysisAPIClient, AnalysisResult } from '../api-client.js';

export const GetProblemsTool = {
  name: 'get_problems',
  description:
    'Fetch code problems detected by the analysis server for this session. Results are ranked by severity. Submit files first via init_workspace.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: {
        type: 'number',
        description: 'Max results (default: 10, max: 100)',
        default: 10,
      },
      severity: {
        type: 'array',
        description: 'Filter by severity (default: all)',
        items: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] },
      },
      category: {
        type: 'array',
        description: 'Filter by category slug (default: all)',
        items: { type: 'string' },
      },
      file_path: {
        type: 'string',
        description: 'Narrow results to a specific file path (substring match)',
      },
      include_discarded: {
        type: 'boolean',
        description: 'Include discarded (false positive) detections (default: false)',
        default: false,
      },
    },
  },
};

export const InputSchema = z.object({
  limit: z.number().int().positive().max(100).default(10),
  severity: z.array(z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'])).optional(),
  category: z.array(z.string()).optional(),
  file_path: z.string().optional(),
  include_discarded: z.boolean().default(false),
});

export type GetProblemsInput = z.infer<typeof InputSchema>;

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4,
};

export async function handle(
  input: GetProblemsInput,
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

  let results: AnalysisResult[] = analysis.results ?? [];

  // Client-side filtering
  if (!input.include_discarded) {
    results = results.filter(r => !r.discarded);
  }
  if (input.severity?.length) {
    const sevSet = new Set<string>(input.severity);
    results = results.filter(r => sevSet.has(r.severity?.toUpperCase() ?? ''));
  }
  if (input.category?.length) {
    const catSet = new Set(input.category.map(c => c.toLowerCase()));
    results = results.filter(r => catSet.has(r.category?.toLowerCase() ?? ''));
  }
  if (input.file_path) {
    results = results.filter(r => r.path.includes(input.file_path!));
  }

  // Sort by severity then by file
  results.sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity?.toUpperCase() ?? ''] ?? 99;
    const sb = SEVERITY_ORDER[b.severity?.toUpperCase() ?? ''] ?? 99;
    return sa !== sb ? sa - sb : a.path.localeCompare(b.path);
  });

  const total = results.length;
  results = results.slice(0, input.limit);

  const duration = Date.now() - startTime;

  if (results.length === 0) {
    return `No problems found (filters: severity=${input.severity?.join(',') ?? 'any'} category=${input.category?.join(',') ?? 'any'}).`;
  }

  let text = `${results.length} problem${results.length === 1 ? '' : 's'}`;
  if (total > results.length) text += ` (${total} total after filters)`;
  text += '\n\n';

  for (let i = 0; i < results.length; i++) {
    const p = results[i]!;
    text += `${i + 1}. [${p.severity ?? 'LOW'}] ${p.category}\n`;
    text += `   File:    ${p.path}:${p.startLine}–${p.endLine}\n`;
    text += `   Summary: ${p.summary}\n`;
    if (p.description && p.description !== p.summary) {
      text += `   Detail:  ${p.description.slice(0, 200)}\n`;
    }
    if (p.endorsed) text += `   ✓ Endorsed\n`;
    text += `   ID:      ${p.id}\n\n`;
  }

  text += `Query completed in ${duration}ms`;
  return text;
}
