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
import { resolveVesselId } from '../vessel-identity.js';
import { getResolverVesselId } from '../resolver-identity.js';
import { plainConceptId } from './_concept-content.js';

/**
 * What the analysis tools say where backend detections would otherwise be.
 * This server sends no workspace content off the machine, so no backend ever
 * analyses it; findings are what agents record.
 */
export const NO_SERVER_ANALYSIS =
  'Server-side analysis: none. This server sends no workspace content off the machine, so there are no backend detections; problems come from agents (record_finding).';

/** The concept shape used for agent-recorded findings. */
export const FINDING_SHAPE = 'code_finding';
/** The concept shape used for verdicts on findings (mark_complete). */
export const VERDICT_SHAPE = 'finding_verdict';

/**
 * The author identity stamped onto findings and verdicts.
 *
 * Prefers the vesselId resolved once at boot (index.ts → setResolverIdentity),
 * and otherwise re-derives it exactly as boot does. Both routes produce the
 * same `metabob-mcp-<12 hex>` value by construction, so a finding recorded in a
 * process that never registered with discovery still carries the id a later
 * session in the same workspace+key will re-derive.
 *
 * Returns undefined — never a placeholder, never an empty string — when there
 * is nothing to resolve from. Callers must then OMIT the author line entirely:
 * an unattributed finding is honest, a fabricated author is not, and the
 * dashboard renders the absence explicitly.
 */
export async function resolveAuthorVesselId(): Promise<string | undefined> {
  const booted = getResolverVesselId();
  if (booted) return booted;
  try {
    return await resolveVesselId({
      explicit: process.env.VESSEL_ID,
      apiKey: process.env.METABOB_API_KEY,
      workspaceRoot: process.env.WORKSPACE_PATH ?? process.cwd(),
    });
  } catch {
    // Identity resolution must never fail a finding write.
    return undefined;
  }
}

/**
 * The attribution lines carried in concept CONTENT (the dashboard parses
 * newline-separated `key: value` lines; concept-db has no field for this and
 * discards `pointer`).
 *
 * `authorKey` is `recorded_by` on a finding and `reviewed_by` on a verdict —
 * both mean exactly one thing: WHO wrote this. Locality/provenance is a
 * separate `origin:` line the caller adds, never folded into the author.
 */
export function attributionLines(
  authorKey: 'recorded_by' | 'reviewed_by',
  vesselId: string | undefined,
  sessionId: string | undefined,
): string[] {
  const lines: string[] = [];
  if (vesselId) lines.push(`${authorKey}: ${vesselId}`);
  if (sessionId && sessionId.trim()) lines.push(`session: ${sessionId.trim()}`);
  return lines;
}

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

/** Verdict a `finding_verdict` concept records against a finding:
 *  `fixed` (endorsed/resolved) or `retracted` (discarded/false positive). */
export type FindingVerdict = 'fixed' | 'retracted';

export interface AgentFinding {
  id: string;
  summary: string;
  content: string;
  updated_at?: string;
  /** Set when a `finding_verdict` concept joined on a shared `agf_*` id closed
   *  this finding. Absent means open — no verdict was recorded, not "unknown". */
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
    // The agf_* id the finding was minted with. The dashboard's verdict join
    // keys on THIS, not on the concept id — a verdict recorded against the
    // concept id is written but invisible to every reader.
    const findingId = (headerLine(content, 'finding_ids').split(',')[0] ?? '').trim();
    return {
      summary: String(row.summary ?? '').trim(),
      files: headerLine(content, 'files'),
      repo: headerLine(content, 'repo'),
      findingId,
    };
  } catch {
    return null;
  }
}

interface ConceptRow {
  id?: string;
  summary?: string | null;
  content?: string | null;
  updated_at?: string;
}

type ConceptScan =
  | { ok: true; rows: ConceptRow[]; truncated: boolean }
  | { ok: false; detail: string };

/**
 * Page one concept shape out of concept-db in list mode.
 *
 * Paginates the relevance-DESC list via `offset` so a client-side filter sees
 * more than the top-50 window; stops on a short page (shape exhausted) or at
 * FINDINGS_MAX_SCAN, which sets `truncated`. A first-page failure is fatal to
 * the caller; a later-page failure keeps what was already read and discloses it.
 *
 * Shared by the finding scan and the verdict scan so the two cannot disagree
 * about paging, deduplication or how far back they look — a verdict the finding
 * scan can see but the verdict scan cannot would silently render a closed
 * finding as open.
 */
async function scanConceptShape(conceptDbUrl: string, shape: string): Promise<ConceptScan> {
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
      if (offset === 0) return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      truncated = true;
      break;
    }
    if (!res.ok) {
      if (offset === 0) return { ok: false, detail: `HTTP ${res.status}` };
      truncated = true;
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
    if (page.length < FINDINGS_PAGE_SIZE) break;
    if (offset >= FINDINGS_MAX_SCAN) {
      truncated = true;
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

/** Read one `key: value` header line out of a concept body. */
function headerLine(content: string, key: string): string {
  const m = new RegExp(`^${key}: (.*)$`, 'm').exec(content);
  return m?.[1]?.trim() ?? '';
}

/**
 * Attribution keys carry a vessel id (`metabob-mcp-<hash>`) and a session uuid.
 * They say WHO recorded a finding, never WHAT it is about, so they must not be
 * visible to the scope match: the vessel id embeds this package's own name, so
 * matching against it makes every finding any metabob-mcp instance ever recorded
 * — for any repository — look like a finding about the caller's repository.
 */
const ATTRIBUTION_KEYS = ['recorded_by', 'reviewed_by', 'session', 'operator'];

function withoutAttribution(text: string): string {
  return text
    .split('\n')
    .filter(l => !ATTRIBUTION_KEYS.some(k => l.startsWith(`${k}: `)))
    .join('\n');
}

/**
 * Does this concept describe the given repository?
 *
 * The `repo:` header is authoritative when present — an exact match, not a
 * substring, so `metabob-mcp` never claims `metabob-mcp-sandbox`. Concepts
 * minted before that header existed have no declared repo; those fall back to a
 * substring scan of the body with attribution stripped, which keeps them
 * recallable without reintroducing the vessel-id match.
 */
function conceptIsAboutRepo(summary: string, content: string, repo: string): boolean {
  const declared = headerLine(content, 'repo').toLowerCase();
  if (declared) return declared === repo;
  const workspace = headerLine(content, 'workspace').toLowerCase();
  if (workspace) return basename(workspace) === repo;
  return withoutAttribution(`${summary}\n${content}`).toLowerCase().includes(repo);
}

/** Does this concept touch the requested path? Prefers the `files:` header. */
function conceptTouchesFile(summary: string, content: string, filePath: string): boolean {
  const files = headerLine(content, 'files').toLowerCase();
  if (files) return files.includes(filePath);
  return withoutAttribution(`${summary}\n${content}`).toLowerCase().includes(filePath);
}

export interface FindingsScope {
  /** Repository the caller is working in — the required scope gate. */
  repo: string | null | undefined;
  /** Optional narrowing to findings touching this path. */
  filePath?: string | null | undefined;
}

export async function fetchAgentFindings(
  apiClient: AnalysisAPIClient,
  scope: FindingsScope,
): Promise<AgentFindingsResult> {
  const repo = (scope.repo ?? '').trim().toLowerCase();
  const filePath = (scope.filePath ?? '').trim().toLowerCase();
  // No resolvable repo means no scope; a global recall over every repository's
  // findings is worse than none, so decline rather than return the whole corpus.
  if (!repo) return { status: 'skipped', findings: [] };

  const conceptDbUrl = await resolveConceptDbUrl(apiClient);
  if (!conceptDbUrl) return { status: 'skipped', findings: [] };

  const scan = await scanConceptShape(conceptDbUrl, FINDING_SHAPE);
  if (!scan.ok) return { status: 'unreachable', findings: [], detail: scan.detail };

  const findings: AgentFinding[] = [];
  for (const row of scan.rows) {
    const summary = row.summary ?? '';
    const content = row.content ?? '';
    if (!conceptIsAboutRepo(summary, content, repo)) continue;
    if (filePath && !conceptTouchesFile(summary, content, filePath)) continue;
    findings.push({
      // Plain form only. This id is what an agent pastes back into
      // mark_complete and concept_record_usage, and concept-db returns the same
      // id bare in one response and ⟨⟩-wrapped in the next — handing the
      // wrapped form to an agent makes it the agent's problem.
      id: plainConceptId(row.id),
      summary,
      content,
      updated_at: row.updated_at,
    });
  }

  // ── Verdict join (best-effort) ────────────────────────────────────────────
  // A finding whose verdict was recorded is closed, but concept-db never
  // retracts the `code_finding` concept — mark_complete retires the LOCAL seed
  // and writes a separate `finding_verdict`. Without this join every finding
  // ever recorded renders as open forever, so an agent is handed work that was
  // finished, sometimes by itself, minutes earlier.
  //
  // Only worth a round-trip when something matched, and a failed verdict scan
  // degrades to unverdicted rendering rather than failing the whole recall.
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

  // A verdicted finding is closed work. Ranking it alongside open problems is
  // how an agent gets handed a task it already finished — so closed findings
  // leave the open list entirely and are summarised after it, still visible
  // (the verdict is itself information) but never mistakable for work to do.
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
