/**
 * Shared helpers for the agent-side findings plane.
 *
 * Design shift: LLM processing lives on the agent side. The MCP server
 * (1) organizes code structure data, (2) attributes agent-noticed details to
 * code via `record_finding`, and (3) surfaces those attributions to other
 * agents working on the same region of the same codebase via `get_problems`
 * and `get_analysis_context`.
 *
 * Findings are persisted in two tiers:
 *  - LocalStore seeds (`agf_*` ids) — immediate in-session surfacing.
 *  - concept-db concepts (shape `code_finding`) — org-wide cross-agent recall.
 *
 * concept-db is always best-effort: unreachable is non-fatal, and callers
 * report its status instead of failing.
 */

import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AnalysisAPIClient } from '../api-client.js';
import { activeWorkspacePath } from '../local-index.js';
import { resolveServiceEndpointByShape } from '../discovery.js';

/** The concept shape used for agent-recorded findings. */
export const FINDING_SHAPE = 'code_finding';
/** The concept shape used for verdicts on findings (mark_complete). */
export const VERDICT_SHAPE = 'finding_verdict';

/** Prefix under which a finding's minted concept id is stashed in a seed's
 *  `refs_json` so mark_complete can attribute a usage/relevance signal to it. */
export const CONCEPT_REF_PREFIX = 'concept:';

/** Extract the concept id a finding seed points at, or null. */
export function conceptIdFromRefs(refsJson: string | undefined): string | null {
  if (!refsJson) return null;
  try {
    const refs = JSON.parse(refsJson) as unknown;
    if (!Array.isArray(refs)) return null;
    for (const ref of refs) {
      if (typeof ref === 'string' && ref.startsWith(CONCEPT_REF_PREFIX)) {
        const id = ref.slice(CONCEPT_REF_PREFIX.length).trim();
        if (id) return id;
      }
    }
  } catch {
    // malformed refs_json — treat as no concept
  }
  return null;
}

/**
 * Basename of the active workspace root.
 *
 * Falls back to WORKSPACE_PATH/cwd rather than returning null when the index
 * is cold: this is the only term the cross-agent recall filters on, so a null
 * here meant `get_problems` silently returned NO "recorded by agents" section
 * at all before `init_workspace` — indistinguishable, to an agent, from "no
 * one has recorded anything here".
 */
export function workspaceRepoName(): string | null {
  return basename(activeWorkspacePath()) || null;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = process.env.METABOB_API_KEY;
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;
  return headers;
}

/**
 * Resolve the concept-db base URL (explicit CONCEPT_DB_URL, else discovery via
 * the `conceptGraph` shape). Returns null when neither is configured or
 * discovery fails — callers treat null as "concept-db not configured".
 */
export async function resolveConceptDbUrl(apiClient: AnalysisAPIClient): Promise<string | null> {
  try {
    const client = apiClient as unknown as {
      hasDiscovery?: () => boolean;
      getDiscoveryEndpoint?: () => string | undefined;
    };
    const hasDiscovery = typeof client.hasDiscovery === 'function' && client.hasDiscovery();
    if (!hasDiscovery && !process.env.CONCEPT_DB_URL) return null;
    const url = await resolveServiceEndpointByShape({
      explicitUrl: process.env.CONCEPT_DB_URL,
      discoveryEndpoint:
        typeof client.getDiscoveryEndpoint === 'function' ? client.getDiscoveryEndpoint() : undefined,
      shape: 'conceptGraph',
      apiKey: process.env.METABOB_API_KEY,
    });
    return url ?? null;
  } catch {
    return null;
  }
}

export interface PostConceptResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Best-effort POST {conceptDbUrl}/concepts — mirrors the body contract used
 * by concept_create (content/shape/source_type/pointer [+ summary]).
 * Never throws.
 */
export async function postConcept(
  conceptDbUrl: string,
  body: Record<string, unknown>,
): Promise<PostConceptResult> {
  try {
    const res = await fetch(`${conceptDbUrl}/concepts`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `${res.status} ${text.slice(0, 200)}` };
    }
    const concept = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: (concept.id ?? '').replace(/^concept:/, '') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Outcome vocabulary accepted by concept-db's usage/relevance chokepoint. */
export type UsageOutcome = 'success' | 'failure' | 'neutral';

export interface RecordUsageResult {
  ok: boolean;
  error?: string;
}

/**
 * Mint a real (non-template) trace id. concept-db refuses `{{...}}` unbound
 * placeholders at its usage chokepoint, so MCP-originated relevance signals
 * carry a concrete, attributable id.
 */
export function makeUsageTraceId(prefix = 'mcp'): string {
  return `${prefix}:${randomUUID()}`;
}

/**
 * Best-effort POST {conceptDbUrl}/concepts/:id/usage — the direct relevance
 * signal. concept-db folds the outcome into the Beta-Binomial posterior mean
 * `(times_succeeded + 1) / (times_loaded + 2)`: `success` raises relevance,
 * `failure`/`neutral` grow the load denominator. Never throws.
 */
export async function recordConceptUsage(
  conceptDbUrl: string,
  conceptId: string,
  outcome: UsageOutcome,
  opts: { traceId?: string; activityId?: string; taskId?: string } = {},
): Promise<RecordUsageResult> {
  try {
    const body: Record<string, unknown> = {
      trace_id: opts.traceId ?? makeUsageTraceId(),
      outcome,
    };
    if (opts.activityId) body.activity_id = opts.activityId;
    if (opts.taskId) body.task_id = opts.taskId;
    const res = await fetch(
      `${conceptDbUrl}/concepts/${encodeURIComponent(conceptId)}/usage`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `${res.status} ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface AgentFinding {
  id: string;
  summary: string;
  content: string;
  updated_at?: string;
}

export type AgentFindingsStatus = 'ok' | 'skipped' | 'unreachable';

export interface AgentFindingsResult {
  status: AgentFindingsStatus;
  findings: AgentFinding[];
  detail?: string;
  /** True when the scan hit MAX_SCAN before exhausting the shape — older
   *  concepts (below the scanned window) were not examined by the term filter. */
  truncated?: boolean;
  /** Concept rows scanned (across all pages) before the client-side filter. */
  scanned?: number;
}

/** Page size for the paginated `code_finding` scan. */
const FINDINGS_PAGE_SIZE = 50;
/** Hard cap on concept rows scanned per recall — 6 pages. Bounds the number of
 *  round-trips while letting the client-side term filter see a fuller set than
 *  the top-50-by-relevance window. */
const FINDINGS_MAX_SCAN = 300;

/**
 * Fetch `code_finding` concepts from concept-db (list mode — deliberately no
 * `query=` param: semantic search is unstable on the local vessel) and filter
 * client-side to concepts whose summary/content mention any of `matchTerms`
 * (repo name, requested file paths). Pages through the relevance-DESC list via
 * the `offset` query param (FINDINGS_PAGE_SIZE rows/page, up to FINDINGS_MAX_SCAN)
 * so a real finding below the top-50 window is still recallable; sets
 * `truncated` when the cap is reached with more pages likely pending. Never throws.
 */
/**
 * Fetch one concept by id, for the fields a verdict needs.
 *
 * A finding recalled from concept-db already carries its own summary, files and
 * repo — the same three fields the local seed supplied. Reading them back is
 * what lets an agent endorse a finding another agent recorded, which is the
 * normal case in a fleet where a manager assigns work someone else found.
 */
export async function fetchConceptById(
  apiClient: AnalysisAPIClient,
  conceptId: string,
): Promise<{ summary: string; files: string; repo: string; findingId: string } | null> {
  const conceptDbUrl = await resolveConceptDbUrl(apiClient);
  if (!conceptDbUrl) return null;
  const plain = conceptId.replace(/^concept:/, '').replace(/^⟨/, '').replace(/⟩$/, '');
  try {
    const res = await fetch(`${conceptDbUrl}/concepts/${encodeURIComponent(plain)}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const row = (await res.json()) as { summary?: string | null; content?: string | null };
    const content = String(row.content ?? '');
    const pick = (key: string): string => {
      const m = new RegExp(`^${key}: (.*)$`, 'm').exec(content);
      return m?.[1]?.trim() ?? '';
    };
    // The agf_* id the finding was minted with. The dashboard's verdict join
    // keys on THIS, not on the concept id — a verdict recorded against the
    // concept id is written but invisible to every reader.
    const findingId = (pick('finding_ids').split(',')[0] ?? '').trim();
    return {
      summary: String(row.summary ?? '').trim(),
      files: pick('files'),
      repo: pick('repo'),
      findingId,
    };
  } catch {
    return null;
  }
}

export async function fetchAgentFindings(
  apiClient: AnalysisAPIClient,
  matchTerms: Array<string | null | undefined>,
): Promise<AgentFindingsResult> {
  const terms = matchTerms
    .map(t => (t ?? '').trim().toLowerCase())
    .filter(t => t.length > 0);
  if (terms.length === 0) return { status: 'skipped', findings: [] };

  const conceptDbUrl = await resolveConceptDbUrl(apiClient);
  if (!conceptDbUrl) return { status: 'skipped', findings: [] };

  interface ConceptRow {
    id?: string;
    summary?: string | null;
    content?: string | null;
    updated_at?: string;
  }

  // Paginate the relevance-DESC list (offset query param) so the client-side
  // term filter sees more than the top-50 window. Stop on a short page (shape
  // exhausted) or at FINDINGS_MAX_SCAN (more pages likely exist -> truncated).
  const rows: ConceptRow[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let truncated = false;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(
        `${conceptDbUrl}/concepts/search?shape=${encodeURIComponent(FINDING_SHAPE)}&limit=${FINDINGS_PAGE_SIZE}&offset=${offset}`,
        { headers: authHeaders(), signal: AbortSignal.timeout(5_000) },
      );
    } catch (err) {
      // First page unreachable is fatal to the recall; a later-page failure is
      // best-effort — keep the pages already accumulated.
      if (offset === 0) {
        return {
          status: 'unreachable',
          findings: [],
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      truncated = true; // later-page error — recall cut short, disclose it
      break;
    }
    if (!res.ok) {
      if (offset === 0) {
        return { status: 'unreachable', findings: [], detail: `HTTP ${res.status}` };
      }
      truncated = true; // later-page error — recall cut short, disclose it
      break;
    }
    const payload = (await res.json().catch(() => ({}))) as { concepts?: ConceptRow[] };
    const page = payload.concepts ?? [];
    // Dedup by concept id: a relevance/ordering write between offset-paged calls
    // can shift a row across the page boundary and re-surface it. Skip repeats so
    // the rendered recall and its "top N of M" count stay honest.
    for (const row of page) {
      const key = (row.id ?? '').replace(/^concept:/, '');
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      rows.push(row);
    }
    offset += page.length;
    if (page.length < FINDINGS_PAGE_SIZE) break; // shape exhausted
    if (offset >= FINDINGS_MAX_SCAN) {
      truncated = true; // hit the cap with a full page — older rows unscanned
      break;
    }
  }

  const findings: AgentFinding[] = [];
  for (const row of rows) {
    const summary = row.summary ?? '';
    const content = row.content ?? '';
    const hay = `${summary}\n${content}`.toLowerCase();
    if (!terms.some(t => hay.includes(t))) continue;
    findings.push({
      id: (row.id ?? '').replace(/^concept:/, ''),
      summary,
      content,
      updated_at: row.updated_at,
    });
  }
  return { status: 'ok', findings, truncated, scanned: rows.length };
}

/**
 * Render the cross-agent findings section. Returns '' when there is nothing
 * useful to show (skipped, or reachable but no matches).
 */
export function renderFindingsSection(
  result: AgentFindingsResult,
  opts: { max: number; compact?: boolean } = { max: 10 },
): string {
  if (result.status === 'unreachable') {
    return `Findings recorded by agents on this codebase: (concept-db unreachable — ${result.detail ?? 'no detail'})`;
  }
  if (result.status === 'skipped' || result.findings.length === 0) return '';

  const shown = result.findings.slice(0, opts.max);
  let text = `Findings recorded by agents on this codebase`;
  if (result.findings.length > shown.length) {
    text += ` (top ${shown.length} of ${result.findings.length})`;
  }
  text += ':\n';
  if (result.truncated) {
    text += `  (scanned first ${result.scanned ?? shown.length} recorded findings; older ones may be omitted)\n`;
  }
  for (const f of shown) {
    const line = f.summary || f.content.split('\n')[0] || f.id;
    text += `  • ${line}\n`;
    if (!opts.compact) {
      const fileLine = f.content.split('\n').find(l => l.startsWith('files:'));
      if (fileLine) text += `    ${fileLine}\n`;
      text += `    concept: ${f.id}${f.updated_at ? `  (${f.updated_at})` : ''}\n`;
    }
  }
  return text.trimEnd();
}
