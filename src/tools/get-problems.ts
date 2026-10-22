// Contract (input schema, behaviour): SPEC §get_problems
import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { seedCacheTag, type LocalStore } from '../local-store.js';
import {
  NO_SERVER_ANALYSIS,
  fetchAgentFindings,
  openFindingsHeadline,
  renderFindingsSection,
  renderTasksSection,
  retireClosedSeeds,
  TASK_CATEGORY,
  findingCategory,
  withoutTasks,
  workspaceRepo,
} from './_findings.js';
import type { SeedRecord } from '../local-store.js';

export const GetProblemsTool = {
  name: 'get_problems',
  description:
    'List open findings in this codebase, led by one count across both sources and ranked by severity: findings in the local store (record_finding) plus findings other agents recorded on this codebase (concept-db). Tasks (category "task": work assigned on the ledger, not problems) are listed apart, with who has claimed them. Recall may close the local copy of a finding another session closed. There is no server-side detection: no workspace content leaves the machine.',
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
  // The cross-agent recall (concept-db, best-effort, non-fatal) runs first so a
  // verdict another session recorded retires this session's seeds of that
  // finding before the local store is read; it is appended as its own section.
  const recall = await fetchAgentFindings(apiClient, {
    repo: workspaceRepo(),
    filePath: input.file_path,
  });
  retireClosedSeeds(recall, localStore);
  const startTime = Date.now();
  const all = localStore ? filteredSeeds(input, localStore) : null;
  // Tasks are listed apart from problems unless they were asked for by category (SPEC §get_problems).
  const askedForTasks = input.category?.some(c => c.toLowerCase() === TASK_CATEGORY) ?? false;
  const isTask = (s: SeedRecord) => s.category.toLowerCase() === TASK_CATEGORY;
  const local = all && !askedForTasks ? { seeds: all.seeds, filtered: all.filtered.filter(s => !isTask(s)) } : all;
  const localTasks = all && !askedForTasks ? all.filtered.filter(isTask) : [];
  // Lead with one count across both sources: a reader of the first line must
  // not take "none in the local store" for "no open findings".
  const headline = openFindingsHeadline(all?.filtered ?? null, recall);
  const core = `${headline}\n\n${localFindings(input, localStore, local, startTime)}\n\n${NO_SERVER_ANALYSIS}`;
  // The category filter applies to the recalled findings as it does to the local ones.
  const cats = input.category?.length ? new Set(input.category.map(c => c.toLowerCase())) : null;
  const recalled = cats && recall.status === 'ok' ? { ...recall, findings: recall.findings.filter(f => cats.has(findingCategory(f))) } : recall;
  const section = renderFindingsSection(askedForTasks ? recalled : withoutTasks(recalled), { max: 10 });
  const tasks = askedForTasks ? '' : renderTasksSection(localTasks, recall);
  return [core, section, tasks].filter(Boolean).join('\n\n');
}

/** The local store's open seeds for this workspace (or matching files), then the input's filters. */
function filteredSeeds(input: GetProblemsInput, localStore: LocalStore): { seeds: SeedRecord[]; filtered: SeedRecord[] } {
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
  return { seeds, filtered };
}

/** The local store's section: the filtered seeds, capped at the limit. */
function localFindings(
  input: GetProblemsInput,
  localStore: LocalStore | null | undefined,
  local: { seeds: SeedRecord[]; filtered: SeedRecord[] } | null,
  startTime: number,
): string {
  if (!localStore || !local) {
    return 'Local findings: unavailable. The local store failed to open in this session (see the startup log).';
  }
  const { seeds } = local;
  let filtered = local.filtered;
  const total = filtered.length;
  filtered = filtered.slice(0, input.limit);

  if (filtered.length === 0) {
    const where = input.file_path ? ` for "${input.file_path}"` : '';
    return `No agent-recorded findings${where} in the local store (filters: severity=${input.severity?.join(',') ?? 'any'} category=${input.category?.join(',') ?? 'any'}).`
      + (input.file_path ? ` For the system's own open gaps on it, path_activity { paths: ["${input.file_path}"] }.` : '');
  }

  let text = `${filtered.length} problem${filtered.length === 1 ? '' : 's'}`;
  if (total > filtered.length) text += ` (${total} total after filters)`;
  text += '\n\n';

  for (let i = 0; i < filtered.length; i++) {
    const s = filtered[i]!;
    localStore.markSeedRead(s.id);
    text += `${i + 1}. [${s.severity}] ${s.category}\n`;
    text += `   File:    ${s.file_path}${s.line_start > 0 ? `:${s.line_start}–${s.line_end}` : ''}\n`;
    text += `   Summary: ${s.brief}\n`;
    if (s.confidence < 0.8) {
      text += `   Confidence: ${(s.confidence * 100).toFixed(0)}%\n`;
    }
    text += `   ID:      ${s.id}\n\n`;
  }

  text += `Query completed in ${Date.now() - startTime}ms\n\n${seedCacheTag(seeds)}`;
  return text;
}
