// Contract (input schema, behaviour): SPEC §get_problems
import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { seedCacheTag, type LocalStore } from '../local-store.js';
import { NO_SERVER_ANALYSIS, fetchAgentFindings, renderFindingsSection, workspaceRepoName } from './_findings.js';

export const GetProblemsTool = {
  name: 'get_problems',
  description:
    'List known problems in this codebase, ranked by severity: findings in the local store (record_finding) plus findings other agents recorded on this codebase (concept-db). There is no server-side detection: no workspace content leaves the machine.',
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
        description: 'Accepted; a discarded finding is deleted from the local store, so there is nothing extra to include',
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

export async function handle(
  input: GetProblemsInput,
  apiClient: AnalysisAPIClient,
  _sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  // Local findings first; then the cross-agent recall (concept-db,
  // best-effort, non-fatal) as a distinct section.
  const core = `${localFindings(input, localStore)}\n\n${NO_SERVER_ANALYSIS}`;
  const recall = await fetchAgentFindings(apiClient, {
    repo: workspaceRepoName(),
    filePath: input.file_path,
  });
  const section = renderFindingsSection(recall, { max: 10 });
  return section ? `${core}\n\n${section}` : core;
}

/** The local store's open seeds for this workspace (or matching files), filtered. */
function localFindings(input: GetProblemsInput, localStore?: LocalStore | null): string {
  if (!localStore) {
    return 'Local findings: unavailable. There is no local store in this session (METABOB_STATELESS=true).';
  }
  const startTime = Date.now();
  // Both reads return seeds ordered by severity, then location.
  const seeds = input.file_path ? localStore.getCachedSeeds(input.file_path) : localStore.getAllCachedSeeds();

  let filtered = seeds;
  if (input.severity?.length) {
    const sevSet = new Set<string>(input.severity);
    filtered = filtered.filter(s => sevSet.has(s.severity.toUpperCase()));
  }
  if (input.category?.length) {
    const catSet = new Set(input.category.map(c => c.toLowerCase()));
    filtered = filtered.filter(s => catSet.has(s.category.toLowerCase()));
  }

  const total = filtered.length;
  filtered = filtered.slice(0, input.limit);

  if (filtered.length === 0) {
    const where = input.file_path ? ` for "${input.file_path}"` : '';
    return `No problems found${where} in the local store (filters: severity=${input.severity?.join(',') ?? 'any'} category=${input.category?.join(',') ?? 'any'}).`;
  }

  let text = `${filtered.length} problem${filtered.length === 1 ? '' : 's'}`;
  if (total > filtered.length) text += ` (${total} total after filters)`;
  text += '\n\n';

  for (let i = 0; i < filtered.length; i++) {
    const s = filtered[i]!;
    localStore.markSeedRead(s.id);
    text += `${i + 1}. [${s.severity}] ${s.category}\n`;
    text += `   File:    ${s.file_path}:${s.line_start}–${s.line_end}\n`;
    text += `   Summary: ${s.brief}\n`;
    if (s.confidence < 0.8) {
      text += `   Confidence: ${(s.confidence * 100).toFixed(0)}%\n`;
    }
    text += `   ID:      ${s.id}\n\n`;
  }

  text += `Query completed in ${Date.now() - startTime}ms\n\n${seedCacheTag(seeds)}`;
  return text;
}
