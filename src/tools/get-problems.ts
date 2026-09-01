import { z } from 'zod';
import type { AnalysisAPIClient, AnalysisResult } from '../api-client.js';
import type { LocalStore, SeedRecord } from '../local-store.js';
import { getLocalIndex } from '../local-index.js';
import { fetchAgentFindings, renderFindingsSection, workspaceRepoName } from './_findings.js';

export const GetProblemsTool = {
  name: 'get_problems',
  description:
    'Fetch known problems for this codebase, ranked by severity: backend detections for this session plus findings recorded by agents (record_finding) working on the same region of this codebase. Submit files first via init_workspace.',
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
  localStore?: LocalStore | null,
): Promise<string> {
  // Core detection sources (local seed cache / vessel fan-out / legacy API)
  // run first; then the cross-agent findings recall (concept-db, best-effort,
  // non-fatal) is appended as a distinct section.
  let core: string;
  try {
    core = await handleCore(input, apiClient, sessionId, localStore);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core = `Backend detection unavailable (${msg.slice(0, 200)}) — server-side detection is deprecated; agent-recorded findings (record_finding) are the primary source.`;
  }
  const recall = await fetchAgentFindings(apiClient, {
    repo: workspaceRepoName(),
    filePath: input.file_path,
  });
  const section = renderFindingsSection(recall, { max: 10 });
  return section ? `${core}\n\n${section}` : core;
}

/**
 * Age the cache header. Per file the store knows when that file was last
 * analyzed; workspace-wide it does not, so date the block from its oldest
 * seed. A file carrying an agent finding the backend never analyzed has no
 * file record at all — `age_ms` is Infinity there, which used to render as
 * "Infinitys old, stale"; fall back to the seeds' own timestamps instead.
 */
function renderCacheTag(
  localStore: LocalStore,
  filePath: string | undefined,
  seeds: SeedRecord[],
): string {
  if (filePath) {
    const freshness = localStore.getFreshness(filePath);
    if (Number.isFinite(freshness.age_ms)) {
      return `[cache: ${Math.round(freshness.age_ms / 1000)}s old${freshness.stale ? ', stale' : ''}]`;
    }
  }
  const oldest = Math.min(...seeds.map(s => s.produced_at));
  return `[cache: ${Math.round((Date.now() - oldest) / 1000)}s old]`;
}

async function handleCore(
  input: GetProblemsInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  const startTime = Date.now();

  // ── Sidecar mode: the local cache.
  //
  // For a NAMED file the cache is served in place of the live fetch. That is
  // the documented sidecar bargain — a specific file, answered without a round
  // trip — and an empty cache enqueues the path and falls through.
  //
  // For the argument-less triage call it is NOT served in place of anything.
  // Reading the whole workspace cache here is what makes agent-recorded
  // findings (this tool's primary source) visible without knowing the exact
  // stored path, but returning early on a cache hit would mean one stale seed
  // anywhere in the workspace suppressed backend detection for the whole
  // codebase — a gate, on the one call that previously could not reach the
  // cache at all. So the workspace-wide block is APPENDED to the core result,
  // the same treatment analyze_impact gives its seeds.
  const seeds = localStore
    ? (input.file_path ? localStore.getCachedSeeds(input.file_path) : localStore.getAllCachedSeeds())
    : [];
  if (localStore && input.file_path && seeds.length === 0) {
    localStore.enqueue(input.file_path, 0, 'default');
  }
  if (localStore && !input.file_path && seeds.length > 0) {
    const block = renderSeedBlock(localStore, input, seeds, startTime);
    const core = await handleRemote(input, apiClient, sessionId, startTime);
    return `${core}\n\n${block}`;
  }
  if (localStore && seeds.length > 0) {
    return renderSeedBlock(localStore, input, seeds, startTime);
  }

  return handleRemote(input, apiClient, sessionId, startTime);
}

/** The cached-seed listing. One implementation, so the served and the appended
 *  forms cannot drift apart. */
function renderSeedBlock(
  localStore: LocalStore,
  input: GetProblemsInput,
  seeds: SeedRecord[],
  startTime: number,
): string {
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

  const cacheTag = renderCacheTag(localStore, input.file_path, seeds);

  if (filtered.length === 0) {
    return `No problems found (filters: severity=${input.severity?.join(',') ?? 'any'} category=${input.category?.join(',') ?? 'any'}).\n\n${cacheTag}`;
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

  text += `Query completed in ${Date.now() - startTime}ms\n\n${cacheTag}`;
  return text;
}

/** Backend detection: the vessel fan-out, else the legacy analysis fetch. */
async function handleRemote(
  input: GetProblemsInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
  startTime: number,
): Promise<string> {
  // ── Vessel mode: fan out problem_detection across the local CPG file list ─
  if (apiClient.isVesselMode()) {
    const index = getLocalIndex();
    let filePaths = index.getIndexedFilePaths();
    if (input.file_path) {
      filePaths = filePaths.filter(p => p.includes(input.file_path!));
    }
    if (filePaths.length === 0) {
      return input.file_path
        ? `No indexed files match "${input.file_path}". Run init_workspace first.`
        : 'No indexed files yet — run init_workspace first.';
    }

    // Deprecated as the primary source of problems: server-side LLM detection
    // has moved to the agent side (record_finding). Keep the fan-out as a
    // best-effort fallback, but never let its failure mask agent findings.
    let raw: unknown;
    try {
      raw = await apiClient.resolveShape('problem_detection', { filePaths }, sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Backend detection unavailable (${msg.slice(0, 200)}) — server-side detection is deprecated; agent-recorded findings (record_finding) are the primary source.`;
    }
    // Support both legacy { problems, files_analyzed } and analysis-api { resolved: [{ content, metadata }] } formats
    type LegacyPayload = { problems?: Array<Record<string, unknown>>; files_analyzed?: number; error?: string };
    type NewPayload = { resolved?: Array<{ content?: Array<Record<string, unknown>>; metadata?: { files_analyzed?: number } }> };
    const asNew = raw as NewPayload;
    const asLegacy = raw as LegacyPayload;
    const firstResolved = asNew.resolved?.[0];
    const payload: LegacyPayload = firstResolved
      ? { problems: firstResolved.content ?? [], files_analyzed: firstResolved.metadata?.files_analyzed }
      : asLegacy;
    if (payload.error) {
      return `analysis-vessel error: ${payload.error}`;
    }
    let problems = payload.problems ?? [];
    // read_error means the vessel cannot see this filesystem (arbitrary
    // codebase outside its mounts) — that is an availability fact, not a
    // code problem. Drop them rather than reporting 19 ENOENTs as HIGHs.
    const readErrors = problems.filter(p => String(p.category ?? '') === 'read_error').length;
    if (readErrors > 0) {
      problems = problems.filter(p => String(p.category ?? '') !== 'read_error');
    }
    if (input.severity?.length) {
      const sevSet = new Set(input.severity.map(s => s.toLowerCase()));
      problems = problems.filter(p => sevSet.has(String(p.severity ?? '').toLowerCase()));
    }
    if (input.category?.length) {
      const catSet = new Set(input.category.map(c => c.toLowerCase()));
      problems = problems.filter(p => catSet.has(String(p.category ?? '').toLowerCase()));
    }
    problems.sort((a, b) => {
      const sa = SEVERITY_ORDER[String(a.severity ?? '').toUpperCase()] ?? 99;
      const sb = SEVERITY_ORDER[String(b.severity ?? '').toUpperCase()] ?? 99;
      return sa !== sb ? sa - sb : String(a.file ?? '').localeCompare(String(b.file ?? ''));
    });

    const total = problems.length;
    const shown = problems.slice(0, input.limit);
    const duration = Date.now() - startTime;

    if (shown.length === 0) {
      const vesselNote = readErrors > 0
        ? `\n(Backend detection could not read ${readErrors} file${readErrors === 1 ? '' : 's'} — this codebase is outside the analysis vessel's filesystem; agent-recorded findings are the primary source here.)`
        : '';
      return `No backend detections across ${filePaths.length} indexed file${filePaths.length === 1 ? '' : 's'} (filters: severity=${input.severity?.join(',') ?? 'any'} category=${input.category?.join(',') ?? 'any'}).${vesselNote}\n\nQuery completed in ${duration}ms`;
    }

    let text = `${shown.length} problem${shown.length === 1 ? '' : 's'}`;
    if (total > shown.length) text += ` (${total} total after filters)`;
    text += ` across ${payload.files_analyzed ?? filePaths.length} file${filePaths.length === 1 ? '' : 's'}\n\n`;
    for (let i = 0; i < shown.length; i++) {
      const p = shown[i]!;
      text += `${i + 1}. [${String(p.severity ?? 'LOW').toUpperCase()}] ${p.category}\n`;
      text += `   File:    ${p.file}:${p.line ?? 0}\n`;
      text += `   Summary: ${p.message}\n\n`;
    }
    text += `Query completed in ${duration}ms`;
    return text;
  }

  // ── Legacy / stateless: fetch from analysis API ─────────────────────────────
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
