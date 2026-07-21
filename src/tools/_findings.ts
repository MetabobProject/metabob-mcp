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
import { getLocalIndex } from '../local-index.js';
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

/** Basename of the active workspace root, or null if not indexed yet. */
export function workspaceRepoName(): string | null {
  const wp = getLocalIndex().workspacePath();
  return wp ? basename(wp) : null;
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

/** Verdict a `finding_verdict` concept records against a finding:
 *  `fixed` (endorsed/resolved) or `retracted` (discarded/false positive). */
export type FindingVerdict = 'fixed' | 'retracted';

export interface AgentFinding {
  id: string;
  summary: string;
  content: string;
  updated_at?: string;
  /** Set when a `finding_verdict` concept joined on a shared `agf_*` id closed
   *  this finding — closed findings are moved out of the open presentation. */
  verdict?: FindingVerdict;
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

interface ConceptRow {
  id?: string;
  summary?: string | null;
  content?: string | null;
  updated_at?: string;
}

interface ShapeScan {
  ok: boolean;
  rows: ConceptRow[];
  truncated: boolean;
  detail?: string;
}

/** Normalize a concept id: strip the `concept:` prefix and any decorative
 *  angle-bracket wrapping (`⟨…⟩`) some renderings apply — always emit plain ids. */
function normalizeConceptId(raw: string | undefined): string {
  return (raw ?? '').replace(/[⟨⟩]/g, '').replace(/^concept:/, '').trim();
}

/**
 * Page through a concept shape's relevance-DESC list (offset query param) so
 * callers see more than the top-50 window. Stops on a short page (shape
 * exhausted) or at FINDINGS_MAX_SCAN (more pages likely exist -> truncated).
 * `ok:false` only when the FIRST page is unreachable; a later-page failure is
 * best-effort — keeps the pages already accumulated and sets `truncated`.
 * Never throws.
 */
async function scanConceptShape(conceptDbUrl: string, shape: string): Promise<ShapeScan> {
  const rows: ConceptRow[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let truncated = false;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(
        `${conceptDbUrl}/concepts/search?shape=${encodeURIComponent(shape)}&limit=${FINDINGS_PAGE_SIZE}&offset=${offset}`,
        { headers: authHeaders(), signal: AbortSignal.timeout(5_000) },
      );
    } catch (err) {
      if (offset === 0) {
        return { ok: false, rows: [], truncated: false, detail: err instanceof Error ? err.message : String(err) };
      }
      truncated = true; // later-page error — scan cut short, disclose it
      break;
    }
    if (!res.ok) {
      if (offset === 0) {
        return { ok: false, rows: [], truncated: false, detail: `HTTP ${res.status}` };
      }
      truncated = true; // later-page error — scan cut short, disclose it
      break;
    }
    const payload = (await res.json().catch(() => ({}))) as { concepts?: ConceptRow[] };
    const page = payload.concepts ?? [];
    // Dedup by concept id: a relevance/ordering write between offset-paged calls
    // can shift a row across the page boundary and re-surface it. Skip repeats so
    // the rendered recall and its "top N of M" count stay honest.
    for (const row of page) {
      const key = normalizeConceptId(row.id);
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
  return { ok: true, rows, truncated };
}

/**
 * Extract the `agf_*` ids a `code_finding` concept carries on its
 * `finding_ids:` content line (record_finding's write format).
 */
export function parseFindingIds(content: string): string[] {
  const m = /^finding_ids:\s*(.+)$/m.exec(content);
  if (!m) return [];
  return m[1]!
    .split(',')
    .map(s => s.trim())
    .filter(s => s.startsWith('agf_'));
}

/**
 * Parse a `finding_verdict` concept (mark_complete's write format: content
 * lines `finding: agf_*` + `verdict: endorsed (resolved) | discarded
 * (retracted)`, summary `[verdict:endorse|discard] …`). Returns the joined
 * `agf_*` id and the verdict, or null when either half is missing.
 */
export function parseVerdictConcept(
  content: string,
  summary: string,
): { findingId: string; verdict: FindingVerdict } | null {
  const idMatch = /^finding:\s*(agf_\S+)/m.exec(content);
  if (!idMatch) return null;
  let verdict: FindingVerdict | null = null;
  const v = /^verdict:\s*(endorsed|discarded)/m.exec(content);
  if (v) verdict = v[1] === 'endorsed' ? 'fixed' : 'retracted';
  else if (summary.includes('[verdict:endorse]')) verdict = 'fixed';
  else if (summary.includes('[verdict:discard]')) verdict = 'retracted';
  if (!verdict) return null;
  return { findingId: idMatch[1]!, verdict };
}

/**
 * Fetch `code_finding` concepts from concept-db (list mode — deliberately no
 * `query=` param: semantic search is unstable on the local vessel) and filter
 * client-side to concepts whose summary/content mention any of `matchTerms`
 * (repo name, requested file paths). Pages through the relevance-DESC list
 * (see scanConceptShape) so a real finding below the top-50 window is still
 * recallable. Then joins `finding_verdict` concepts on the shared `agf_*` id
 * (verdicts carry `finding: agf_*`; finding concepts carry `finding_ids:`) and
 * tags joined findings with their verdict so closed problems stop rendering as
 * open. The verdict scan is best-effort: if it fails, findings render
 * unverdicted (previous behavior). Never throws.
 */
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

  const scan = await scanConceptShape(conceptDbUrl, FINDING_SHAPE);
  if (!scan.ok) {
    return { status: 'unreachable', findings: [], detail: scan.detail };
  }

  const findings: AgentFinding[] = [];
  for (const row of scan.rows) {
    const summary = row.summary ?? '';
    const content = row.content ?? '';
    const hay = `${summary}\n${content}`.toLowerCase();
    if (!terms.some(t => hay.includes(t))) continue;
    findings.push({
      id: normalizeConceptId(row.id),
      summary,
      content,
      updated_at: row.updated_at,
    });
  }

  // ── Verdict join (best-effort) ────────────────────────────────────────────
  // Only worth a round-trip when something matched; a failed verdict scan
  // degrades to unverdicted rendering rather than failing the recall.
  if (findings.length > 0) {
    const verdictScan = await scanConceptShape(conceptDbUrl, VERDICT_SHAPE);
    if (verdictScan.ok) {
      const verdictById = new Map<string, FindingVerdict>();
      for (const row of verdictScan.rows) {
        const parsed = parseVerdictConcept(row.content ?? '', row.summary ?? '');
        if (!parsed) continue;
        // A retraction wins over an endorse when both were recorded for the
        // same id — a known false positive must never re-render as open/fixed.
        if (verdictById.get(parsed.findingId) !== 'retracted') {
          verdictById.set(parsed.findingId, parsed.verdict);
        }
      }
      for (const f of findings) {
        const verdicts = parseFindingIds(f.content)
          .map(id => verdictById.get(id))
          .filter((v): v is FindingVerdict => v !== undefined);
        if (verdicts.length === 0) continue;
        f.verdict = verdicts.includes('retracted') ? 'retracted' : 'fixed';
      }
    }
  }

  return { status: 'ok', findings, truncated: scan.truncated, scanned: scan.rows.length };
}

/**
 * Render the cross-agent findings section. Returns '' when there is nothing
 * useful to show (skipped, or reachable but no matches). Findings carrying a
 * verdict ([FIXED]/[RETRACTED]) are moved out of the open presentation: a
 * separate closed section at the end (compact mode: a one-line count).
 */
export function renderFindingsSection(
  result: AgentFindingsResult,
  opts: { max: number; compact?: boolean } = { max: 10 },
): string {
  if (result.status === 'unreachable') {
    return `Findings recorded by agents on this codebase: (concept-db unreachable — ${result.detail ?? 'no detail'})`;
  }
  if (result.status === 'skipped' || result.findings.length === 0) return '';

  const open = result.findings.filter(f => !f.verdict);
  const closed = result.findings.filter(f => f.verdict);

  let text = `Findings recorded by agents on this codebase`;
  if (open.length === 0) {
    text += ': none open\n';
  } else {
    const shown = open.slice(0, opts.max);
    if (open.length > shown.length) {
      text += ` (top ${shown.length} of ${open.length} open)`;
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
  }

  if (closed.length > 0) {
    const fixed = closed.filter(f => f.verdict === 'fixed').length;
    const retracted = closed.length - fixed;
    if (opts.compact) {
      text += `  (${closed.length} closed finding${closed.length === 1 ? '' : 's'} suppressed: ${fixed} [FIXED], ${retracted} [RETRACTED])\n`;
    } else {
      text += `Closed findings (verdict recorded — not open issues):\n`;
      for (const f of closed.slice(0, opts.max)) {
        const tag = f.verdict === 'fixed' ? '[FIXED]' : '[RETRACTED]';
        const line = f.summary || f.content.split('\n')[0] || f.id;
        text += `  • ${tag} ${line} (concept: ${f.id})\n`;
      }
      if (closed.length > opts.max) {
        text += `  … and ${closed.length - opts.max} more closed\n`;
      }
    }
  }
  return text.trimEnd();
}
