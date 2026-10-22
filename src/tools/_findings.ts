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
import type { LocalStore, SeedRecord } from '../local-store.js';
import { activeWorkspacePath } from '../local-index.js';
import { substrateRefusal } from '../attachment.js';
import {
  conceptDbAvailable,
  createConcept,
  getConcept,
  recordUsage,
  searchConcepts,
  type ConceptRow,
} from './_concept-db.js';
import { resolveVesselId } from '../vessel-identity.js';
import { getResolverVesselId } from '../resolver-identity.js';
import { headerBlock, plainConceptId } from './_concept-content.js';
import { commitInHead, repoAliases, repoIdentity, type FixLocation, type RepoAliases, type RepoIdentity } from '../repo-identity.js';
import { claimHolder, parseClaim, type ClaimRecord } from './_claims.js';

/**
 * What the analysis tools say where backend detections would otherwise be.
 * This server sends no workspace content off the machine, so no backend ever
 * analyses it; findings are what agents record.
 */
export const NO_SERVER_ANALYSIS =
  'Server-side analysis: none. This server sends no workspace content off the machine, so there are no backend detections; problems come from agents (record_finding). '
  + 'These are agent-recorded findings only: the system\'s own open gaps on a file are path_activity\'s, and "none here" does not mean none there.';

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
 * Basename of the active workspace root: the legacy ledger key, and the name a
 * finding's summary line shows.
 *
 * Falls back to WORKSPACE_PATH/cwd rather than returning null when the index
 * is cold: the recall filters on the repository, so a null here meant
 * `get_problems` silently returned NO "recorded by agents" section at all
 * before `init_workspace` — indistinguishable, to an agent, from "no one has
 * recorded anything here".
 */
export function workspaceRepoName(): string | null {
  return basename(activeWorkspacePath()) || null;
}

/**
 * The repository identity of the active workspace (src/repo-identity.ts): the
 * normalized `origin` URL, else the basename. Same workspace fallback as
 * workspaceRepoName. SPEC §repository-identity
 */
export function workspaceRepo(): RepoIdentity | null {
  const path = activeWorkspacePath();
  return basename(path) ? repoIdentity(path) : null;
}

/**
 * The `key: value` lines a finding or verdict carries for its repository:
 * `repo:` is the identity recall matches, `repo_name:` the basename, for
 * readers. Recall never matches on `repo_name:` — that would rejoin every
 * same-named repository's ledger.
 */
export function repoLines(repo: RepoIdentity | null): string[] {
  if (!repo) return ['repo: unknown'];
  return [`repo: ${repo.id}`, `repo_name: ${repo.name}`];
}

/**
 * Whether the concept-db half of a mixed tool may run: concept-db is reached
 * through the attachment (src/tools/_concept-db.ts), so it is available exactly
 * when the attachment may make keyed calls. The substrate half makes no keyed
 * call until the key is proven (CONFORMANCE §c3-identity); conceptDbUnavailable
 * names why.
 */
export async function conceptDbReachable(): Promise<boolean> {
  return conceptDbAvailable();
}

/**
 * Why concept-db is unavailable, for a mixed tool's output: the attachment's
 * named cause when it refuses keyed calls, else "concept-db not configured".
 */
export async function conceptDbUnavailable(): Promise<string> {
  return (await substrateRefusal()) ?? 'concept-db not configured';
}

export interface PostConceptResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Best-effort concept mint — the `concept_create_write` shape, with the body
 * concept_create sends (content/shape/source_type/pointer [+ summary]).
 * Never throws.
 */
export async function postConcept(body: Record<string, unknown>): Promise<PostConceptResult> {
  const created = await createConcept(body);
  if (!created.ok) return { ok: false, error: created.error };
  // Plain form: concept-db answers some ids ⟨⟩-wrapped, and this id is printed
  // for an agent to paste back (src/tools/_concept-content.ts@plainConceptId).
  return { ok: true, id: plainConceptId(String(created.value.id ?? '')) };
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
 * Best-effort relevance signal — the `conceptUsage_write` shape, concept-db's
 * usage chokepoint. concept-db folds the outcome into the Beta-Binomial
 * posterior mean `(times_succeeded + 1) / (times_loaded + 2)`: `success` raises
 * relevance, `failure`/`neutral` grow the load denominator. Never throws.
 */
export async function recordConceptUsage(
  conceptId: string,
  outcome: UsageOutcome,
  opts: { traceId?: string; activityId?: string; taskId?: string } = {},
): Promise<RecordUsageResult> {
  const usageData: Record<string, unknown> = {
    concept_id: conceptId,
    trace_id: opts.traceId ?? makeUsageTraceId(),
    outcome,
  };
  if (opts.activityId) usageData.activity_id = opts.activityId;
  if (opts.taskId) usageData.task_id = opts.taskId;
  const recorded = await recordUsage(usageData);
  return recorded.ok ? { ok: true } : { ok: false, error: recorded.error };
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
  /** A fixed finding's fix commit, and whether this checkout's HEAD has it (null: not a git checkout). */
  fix?: { sha: string; branch?: string; pushed: boolean; inHead: boolean | null };
  /** Set on an OPEN finding whose fix an agent endorsed while it was still uncommitted. */
  pending?: { by?: string; branch?: string; here: boolean; unpushed?: boolean; awaitingMerge?: string };
  /** The finding's files in this workspace's form (mapped from the other ledger of a super-repo/vessel pair). */
  files?: string[];
  /** Set on an OPEN finding someone holds a live claim on (src/tools/_claims.ts@claim-holder). */
  claim?: { by: string; until: number; here: boolean };
}

export type AgentFindingsStatus = 'ok' | 'skipped' | 'unreachable' | 'refused';

export interface AgentFindingsResult {
  status: AgentFindingsStatus;
  findings: AgentFinding[];
  detail?: string;
  /** True when the scan hit MAX_SCAN before exhausting the shape — older
   *  concepts (below the scanned window) were not examined by the term filter. */
  truncated?: boolean;
  /** Concept rows scanned before the client-side filter. */
  scanned?: number;
}

/** Hard cap on concept rows scanned per shape per recall, in one `conceptSearch`
 *  read. Lets the client-side term filter see a fuller set than a top-50 window
 *  while bounding the answer (concept-db's rows carry their embeddings). */
const FINDINGS_MAX_SCAN = 300;

/**
 * Fetch one concept by id, for the fields a verdict needs.
 *
 * A finding recalled from concept-db already carries its own summary, files and
 * repo — the same three fields the local seed supplied. Reading them back is
 * what lets an agent endorse a finding another agent recorded, which is the
 * normal case in a fleet where a manager assigns work someone else found.
 * Read as the `conceptGraph` root (src/tools/_concept-db.ts@getConcept).
 */
export interface RecalledConcept { summary: string; files: string; repo: string; repoName: string; findingId: string; findingIds: string[]; recordedAt?: Date }

export async function fetchConceptById(_apiClient: AnalysisAPIClient, conceptId: string): Promise<RecalledConcept | null> {
  const read = await readConceptById(conceptId);
  return 'error' in read ? null : read;
}

/** fetchConceptById, with the reason when it could not be read: the attachment's or the network's named cause, or concept-db's answer. */
export async function readConceptById(conceptId: string): Promise<RecalledConcept | { error: string }> {
  if (!(await conceptDbAvailable())) return { error: await conceptDbUnavailable() };
  const plain = plainConceptId(conceptId);
  const read = await getConcept(plain);
  if (!read.ok) return { error: read.error };
  if (!read.value) return { error: `concept-db has no concept ${plain}` };
  const row = read.value;
  const content = String(row.content ?? '');
  // The agf_* id the finding was minted with. The dashboard's verdict join
  // keys on THIS, not on the concept id — a verdict recorded against the
  // concept id is written but invisible to every reader.
  const findingId = (headerLine(content, 'finding_ids').split(',')[0] ?? '').trim();
  return {
    summary: String(row.summary ?? '').trim(),
    files: headerLine(content, 'files'),
    repo: headerLine(content, 'repo'),
    repoName: headerLine(content, 'repo_name'),
    findingId,
    findingIds: parseFindingIds(content),
    ...(row.created_at && Number.isFinite(Date.parse(row.created_at)) ? { recordedAt: new Date(row.created_at) } : {}),
  };
}

type ConceptScan =
  | { ok: true; rows: ConceptRow[]; truncated: boolean }
  | { ok: false; detail: string };

/**
 * Read one concept shape out of concept-db in list mode: `conceptSearch` by
 * shape, relevance DESC, up to FINDINGS_MAX_SCAN rows in one read (the shape
 * takes no offset), so a client-side filter sees more than the top window;
 * `truncated` is set when the cap is reached.
 *
 * Shared by the finding scan and the verdict scan so the two cannot disagree
 * about how far back they look — a verdict the finding scan can see but the
 * verdict scan cannot would silently render a closed finding as open.
 */
/** Every `finding_verdict` row, as the recall's verdict join reads them (claims included). */
export async function scanVerdicts(): Promise<ConceptScan> {
  return scanConceptShape(VERDICT_SHAPE);
}

async function scanConceptShape(shape: string): Promise<ConceptScan> {
  const found = await searchConcepts({ shape, limit: FINDINGS_MAX_SCAN });
  if (!found.ok) return { ok: false, detail: found.error };
  const rows: ConceptRow[] = [];
  const seen = new Set<string>();
  // Dedup by concept id: one answer can carry a row twice (bare and ⟨⟩-wrapped
  // ids name the same concept). Skip repeats so the rendered recall and its
  // "top N of M" count stay honest.
  for (const row of found.value) {
    const key = plainConceptId(row.id);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    rows.push(row);
  }
  return { ok: true, rows, truncated: found.value.length >= FINDINGS_MAX_SCAN };
}

/**
 * Extract the `agf_*` ids a `code_finding` concept carries on its
 * `finding_ids:` content line (record_finding's write format).
 */
export function parseFindingIds(content: string): string[] {
  const m = /^finding_ids:\s*(.+)$/m.exec(headerBlock(content));
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
): ParsedVerdict | null {
  content = headerBlock(content);
  const idMatch = /^finding:\s*(agf_\S+)/m.exec(content);
  if (!idMatch) return null;
  let verdict: FindingVerdict | 'pending' | null = null;
  const v = /^verdict:\s*(endorsed|discarded|fix pending)/m.exec(content);
  if (v) verdict = v[1] === 'endorsed' ? 'fixed' : v[1] === 'discarded' ? 'retracted' : 'pending';
  else if (summary.includes('[verdict:endorse]')) verdict = 'fixed';
  else if (summary.includes('[verdict:discard]')) verdict = 'retracted';
  else if (summary.includes('[verdict:pending]')) verdict = 'pending';
  if (!verdict) return null;
  const parsed: ParsedVerdict = { findingId: idMatch[1]!, verdict };
  const branch = headerLine(content, 'fix_branch') || undefined;
  const commit = /^fix: commit ([0-9a-f]{7,40})\b/m.exec(content);
  if (verdict === 'fixed' && commit) parsed.fix = { sha: commit[1]!, branch, pushed: headerLine(content, 'fix_pushed') !== 'no' };
  if (verdict === 'pending') {
    parsed.pendingBy = headerLine(content, 'reviewed_by') || undefined;
    parsed.pendingBranch = branch;
    parsed.pendingUnpushed = /^verdict:\s*fix pending \(unpushed\)/m.test(content);
    if (/^verdict:\s*fix pending \(awaiting merge\)/m.test(content)) parsed.pendingAwaitingMerge = headerLine(content, 'fix_target') || 'main';
  }
  return parsed;
}

/**
 * A parsed `finding_verdict`. `pending` is an endorse of a fix that was still uncommitted: the finding stays open.
 * It is written as `verdict: fix pending (uncommitted)` / `[verdict:pending]`, which a reader that knows only
 * endorsed and discarded parses as no verdict, so the finding reads open there too.
 */
export interface ParsedVerdict {
  findingId: string;
  verdict: FindingVerdict | 'pending';
  fix?: { sha: string; branch?: string; pushed: boolean };
  pendingBy?: string;
  pendingBranch?: string;
  /** A pending fix that is committed but on no remote branch, rather than uncommitted. */
  pendingUnpushed?: boolean;
  /** A pending fix pushed for review: the branch it is to be merged into. */
  pendingAwaitingMerge?: string;
}

/**
 * The verdict's lines for where the fix is (SPEC §mark_complete): `fix: commit <sha>` with `fix_branch:` and
 * `fix_pushed: no` when no remote branch held it, `fix: uncommitted` with the branch and `fix_base:` HEAD, or
 * `fix: unknown (not a git checkout)`. No path: the checkout is named by the verdict's `reviewed_by`.
 */
export function fixLines(loc: FixLocation): string[] {
  const branch = 'branch' in loc && loc.branch ? [`fix_branch: ${loc.branch}`] : [];
  if (loc.kind === 'commit') return [`fix: commit ${loc.sha}`, ...branch, ...(loc.pushed ? [] : ['fix_pushed: no']), ...(loc.claimed ? ['fix_claimed: yes'] : []), ...(loc.elsewhere ? ['fix_touches_finding_files: no'] : [])];
  if (loc.kind === 'uncommitted') return ['fix: uncommitted', ...branch, ...(loc.base ? [`fix_base: ${loc.base}`] : []), ...(loc.outside ? ['fix_files: outside the finding\'s files'] : [])];
  if (loc.kind === 'none' || loc.kind === 'absent' || loc.kind === 'rejected') return [];
  return ['fix: unknown (not a git checkout)'];
}

/** Read one `key: value` header line out of a concept body. */
function headerLine(content: string, key: string): string {
  const m = new RegExp(`^${key}: (.*)$`, 'm').exec(headerBlock(content));
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

/** A recall scope's repository: the keys a `repo:` header may equal, and the basename. */
interface RepoMatch {
  keys: Set<string>;
  name: string;
}

function repoMatch(repo: string | RepoIdentity | null | undefined): RepoMatch | null {
  if (!repo) return null;
  const id = (typeof repo === 'string' ? repo : repo.id).trim().toLowerCase();
  const name = (typeof repo === 'string' ? repo : repo.name).trim().toLowerCase();
  if (!id && !name) return null;
  return { keys: new Set([id, name].filter(Boolean)), name: name || id };
}

/**
 * Does this concept describe the given repository?
 *
 * The `repo:` header is authoritative when present — an exact match, not a
 * substring, so `metabob-mcp` never claims `metabob-mcp-sandbox`. It matches the
 * repository's identity (`github.com/org/repo`) or its basename: findings
 * recorded under the basename stay in the ledger, at the cost that a
 * basename-keyed finding is shared by every same-named repository (SPEC
 * §repository-identity). Concepts with no declared repo fall back to the
 * `workspace:` basename, then to a substring scan of the body with attribution
 * stripped, which keeps them recallable without reintroducing the vessel-id match.
 */
function conceptIsAboutRepo(summary: string, content: string, repo: RepoMatch, aliases: RepoAliases | null = null): boolean {
  const declared = headerLine(content, 'repo').toLowerCase();
  if (declared) return repo.keys.has(declared) || aliasOf(declared, content, aliases) !== null;
  const workspace = headerLine(content, 'workspace').toLowerCase();
  if (workspace) return basename(workspace) === repo.name;
  return withoutAttribution(`${summary}\n${content}`).toLowerCase().includes(repo.name);
}

/**
 * How a finding recorded in the other ledger of a super-repo/vessel pair maps here (src/repo-identity.ts@repo-aliases):
 * the path prefix to remove (a vessel checkout reading the super-repo's) or to add (the super-repo reading a vessel's),
 * or null when the finding is not from that other ledger. SPEC §repository-identity
 */
function aliasOf(declared: string, content: string, aliases: RepoAliases | null): { strip?: string; add?: string } | null {
  if (!aliases || !declared) return null;
  if (aliases.kind === 'vessel') {
    const files = headerLine(content, 'files').toLowerCase().split(',').map(f => f.trim());
    return files.some(f => f.startsWith(`${aliases.prefix}/`)) ? { strip: `${aliases.prefix}/` } : null;
  }
  const name = declared.split('/').pop() ?? '';
  return aliases.vessels.has(name) ? { add: `repos/${name}/` } : null;
}

/** A finding's files in this workspace's form: as recorded, or mapped from the other ledger of a super-repo/vessel pair. */
export function localFiles(content: string, repo: RepoMatch | null, aliases: RepoAliases | null): string[] {
  const files = headerLine(content, 'files').split(',').map(f => f.trim()).filter(Boolean);
  const declared = headerLine(content, 'repo').toLowerCase();
  if (!declared || repo?.keys.has(declared)) return files;
  const alias = aliasOf(declared, content, aliases);
  if (alias?.strip) return files.filter(f => f.toLowerCase().startsWith(alias.strip!)).map(f => f.slice(alias.strip!.length));
  if (alias?.add) return files.map(f => `${alias.add}${f}`);
  return files;
}

/** Does this concept touch the requested path? Prefers the `files:` header, in this workspace's form. */
function conceptTouchesFile(summary: string, content: string, filePath: string, repo?: RepoMatch | null, aliases: RepoAliases | null = null): boolean {
  const files = localFiles(content, repo ?? null, aliases).join(', ').toLowerCase();
  if (files) return files.includes(filePath);
  return withoutAttribution(`${summary}\n${content}`).toLowerCase().includes(filePath);
}

export interface FindingsScope {
  /** Repository the caller is working in — the required scope gate. A string
   *  is a single key (identity or basename); a RepoIdentity matches either. */
  repo: string | RepoIdentity | null | undefined;
  /** Optional narrowing to findings touching this path. */
  filePath?: string | null | undefined;
  /** The checkout a fix commit is looked up in; the active workspace by default. */
  workspace?: string;
}

/**
 * Recall `code_finding` concepts from concept-db (list mode — deliberately no
 * query: semantic search is unstable on the local vessel) and keep those whose
 * summary/content name the repo (and, when given, the file), then join the
 * `finding_verdict` concepts so a closed finding renders closed. One
 * `conceptSearch` read per shape, up to FINDINGS_MAX_SCAN rows (scanConceptShape).
 * Never throws.
 */
export async function fetchAgentFindings(
  _apiClient: AnalysisAPIClient,
  scope: FindingsScope,
): Promise<AgentFindingsResult> {
  const repo = repoMatch(scope.repo);
  const filePath = (scope.filePath ?? '').trim().toLowerCase();
  // No resolvable repo means no scope; a global recall over every repository's
  // findings is worse than none, so decline rather than return the whole corpus.
  if (!repo) return { status: 'skipped', findings: [] };

  if (!(await conceptDbAvailable())) {
    const refusal = await substrateRefusal();
    return refusal ? { status: 'refused', findings: [], detail: refusal } : { status: 'skipped', findings: [] };
  }

  const scan = await scanConceptShape(FINDING_SHAPE);
  if (!scan.ok) return { status: 'unreachable', findings: [], detail: scan.detail };

  // A super-repo and a vessel checkout name one file under two repositories: recall reads both ledgers.
  const aliases = repoAliases(scope.workspace ?? activeWorkspacePath());
  const findings: AgentFinding[] = [];
  for (const row of scan.rows) {
    const summary = row.summary ?? '';
    const content = row.content ?? '';
    if (!conceptIsAboutRepo(summary, content, repo, aliases)) continue;
    if (filePath && !conceptTouchesFile(summary, content, filePath, repo, aliases)) continue;
    findings.push({
      // Plain form only. This id is what an agent pastes back into
      // mark_complete and concept_record_usage, and concept-db returns the same
      // id bare in one response and ⟨⟩-wrapped in the next — handing the
      // wrapped form to an agent makes it the agent's problem.
      id: plainConceptId(row.id),
      summary,
      content,
      files: localFiles(content, repo, aliases),
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
    const verdictScan = await scanConceptShape(VERDICT_SHAPE);
    if (verdictScan.ok) {
      // A retraction wins over an endorse when both were recorded for the same
      // id — a known false positive must never re-render as open/fixed — and a
      // committed fix wins over a pending one. A fix with a commit wins over one without.
      const rank = (v: ParsedVerdict) => (v.verdict === 'retracted' ? 3 : v.verdict === 'fixed' ? (v.fix ? 2 : 1.5) : 1);
      const verdictById = new Map<string, ParsedVerdict>();
      const claimsById = new Map<string, ClaimRecord[]>();
      for (const row of verdictScan.rows) {
        const claim = parseClaim(row);
        if (claim) claimsById.set(claim.findingId, [...(claimsById.get(claim.findingId) ?? []), claim]);
        const parsed = parseVerdictConcept(row.content ?? '', row.summary ?? '');
        if (!parsed) continue;
        const held = verdictById.get(parsed.findingId);
        if (!held || rank(parsed) > rank(held)) verdictById.set(parsed.findingId, parsed);
      }
      const workspace = scope.workspace ?? activeWorkspacePath();
      const me = findings.length ? await resolveAuthorVesselId() : undefined;
      const inHead = new Map<string, boolean | null>();
      const now = Date.now();
      for (const f of findings) {
        const ids = parseFindingIds(f.content);
        const holder = claimHolder(ids.flatMap(id => claimsById.get(id) ?? []), now);
        if (holder) f.claim = { by: holder.by, until: holder.until, here: !!me && holder.by === me };
        const verdicts = ids
          .map(id => verdictById.get(id))
          .filter((v): v is ParsedVerdict => v !== undefined);
        if (verdicts.length === 0) continue;
        const best = verdicts.reduce((a, b) => (rank(b) > rank(a) ? b : a));
        if (best.verdict === 'pending') {
          f.pending = { by: best.pendingBy, branch: best.pendingBranch, here: !!me && best.pendingBy === me, ...(best.pendingUnpushed ? { unpushed: true } : {}), ...(best.pendingAwaitingMerge ? { awaitingMerge: best.pendingAwaitingMerge } : {}) };
          continue;
        }
        f.verdict = best.verdict;
        // A closed finding has no holder: the claim ended with the work.
        delete f.claim;
        if (best.fix) {
          if (!inHead.has(best.fix.sha)) inHead.set(best.fix.sha, commitInHead(workspace, best.fix.sha));
          f.fix = { ...best.fix, inHead: inHead.get(best.fix.sha)! };
        }
      }
    }
  }

  return { status: 'ok', findings, truncated: scan.truncated, scanned: scan.rows.length };
}

/**
 * Retire the local seeds of findings the recall shows closed.
 *
 * A verdict recorded by another session reaches this one only as a
 * `finding_verdict` concept; the seeds this session wrote when it recorded the
 * finding stay live until something retires them. Left alone, the local cache
 * lists the finding as open directly above the recall that shows it closed, and
 * the agent is handed finished work. A seed is matched by its linked concept id
 * or by the `agf_*` ids the concept carries, and retired the way mark_complete
 * retires it: a fixed finding's seeds go stale, a retracted finding's are deleted.
 * SPEC §get_problems
 */
export function retireClosedSeeds(
  result: AgentFindingsResult,
  localStore: LocalStore | null | undefined,
): number {
  if (!localStore || result.status !== 'ok') return 0;
  let retired = 0;
  for (const f of result.findings) {
    if (!f.verdict) continue;
    const seeds = new Map<string, SeedRecord>();
    for (const s of localStore.getSeedsByConceptRef(f.id)) seeds.set(s.id, s);
    for (const id of parseFindingIds(f.content)) {
      const s = localStore.getSeedById(id);
      if (s) seeds.set(s.id, s);
    }
    for (const s of seeds.values()) {
      if (s.stale) continue;
      if (f.verdict === 'fixed') localStore.markSeedStaleById(s.id);
      else localStore.deleteSeed(s.id);
      retired++;
    }
  }
  return retired;
}

// @anchor task-findings
/**
 * Findings in category `task` are work assigned on the ledger (a coordinator's task board), not problems in the
 * code. get_problems lists them apart, so an agent checking a file before an edit does not take another agent's
 * task for a problem it should fix. SPEC §get_problems
 */
export const TASK_CATEGORY = 'task';

/** The category a recalled finding was recorded with: its `category:` line, else the summary's `[SEV][category]`. */
export function findingCategory(f: Pick<AgentFinding, 'summary' | 'content'>): string {
  return (headerLine(f.content, 'category') || /^\[[^\]]*\]\[([^\]]*)\]/.exec(f.summary)?.[1] || '').trim().toLowerCase();
}

export function isTaskFinding(f: Pick<AgentFinding, 'summary' | 'content'>): boolean {
  return findingCategory(f) === TASK_CATEGORY;
}

/** The recall without its tasks: what renderFindingsSection and the headline count as findings. */
export function withoutTasks(result: AgentFindingsResult): AgentFindingsResult {
  return result.status === 'ok' ? { ...result, findings: result.findings.filter(f => !isTaskFinding(f)) } : result;
}

/**
 * The tasks section: open `task` findings from the local store and the recall, one entry per task. Claimed tasks
 * are never hidden, since who is on what is the coordination signal. They are ordered so the next move comes
 * first: claimed by this checkout, unclaimed, claimed by others, then those with a fix pending. '' when there are
 * none.
 */
export function renderTasksSection(localTasks: SeedRecord[], recall: AgentFindingsResult, max = 10): string {
  type Entry = { group: 0 | 1 | 2 | 3; text: string };
  const entries: Entry[] = [];
  const seen = new Set<string>();
  const recalled = recall.status === 'ok' ? recall.findings.filter(f => isTaskFinding(f) && !f.verdict) : [];
  for (const f of recalled) {
    seen.add(f.id);
    for (const id of parseFindingIds(f.content)) seen.add(id);
    const files = headerLine(f.content, 'files');
    const group = f.pending ? 3 : f.claim?.here ? 0 : f.claim ? 2 : 1;
    const note = f.pending ? `  ${pendingNote(f.pending)}` : f.claim ? `  ${f.claim.here ? `[yours: ${claimNote(f.claim).slice(1)}` : claimNote(f.claim)}` : '';
    entries.push({ group, text: `  • ${findingSummaryText(f.summary) || f.id}${note}\n` + (files ? `    files: ${files}\n` : '') + `    id: ${f.id}\n` });
  }
  for (const s of localTasks) {
    const ref = conceptIdFromRefs(s.refs_json);
    if (seen.has(s.id) || (ref && seen.has(plainConceptId(ref)))) continue;
    seen.add(s.id);
    entries.push({ group: 1, text: `  • ${s.brief}\n    files: ${s.file_path}\n    id: ${s.id}\n` });
  }
  // Closed tasks stay visible, so a coordinator sees completion without filtering for it.
  const closed = recall.status === 'ok' ? recall.findings.filter(f => isTaskFinding(f) && f.verdict) : [];
  const closedLines = closed.slice(0, 5).map(f => {
    const tag = f.verdict === 'fixed' ? (f.fix ? `[FIXED in ${f.fix.sha.slice(0, 10)}]` : '[FIXED]') : '[RETRACTED]';
    return `  • ${tag} ${findingSummaryText(f.summary) || f.id} (id: ${f.id})\n`;
  });
  const closedPart = closed.length
    ? `Closed tasks (${closed.length}${closed.length > closedLines.length ? `, ${closedLines.length} shown` : ''}):\n${closedLines.join('')}`
    : '';
  if (!entries.length) return closedPart ? `Tasks: none open.\n${closedPart}`.trimEnd() : '';
  entries.sort((a, b) => a.group - b.group);
  const count = (g: number) => entries.filter(e => e.group === g).length;
  const parts = [
    count(0) ? `${count(0)} yours` : '',
    count(1) ? `${count(1)} unclaimed` : '',
    count(2) ? `${count(2)} claimed by others` : '',
    count(3) ? `${count(3)} with a fix pending` : '',
  ].filter(Boolean).join(', ');
  const shown = entries.slice(0, max);
  return (`Tasks: work assigned on the ledger, not problems in the code (${entries.length} open: ${parts}${entries.length > shown.length ? `; ${shown.length} shown` : ''}${closed.length ? `; ${closed.length} closed` : ''}). `
    + 'Before you start one, claim it with claim_finding; one claimed by someone else is theirs.\n' + shown.map(e => e.text).join('') + closedPart).trimEnd();
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
  if (result.status === 'refused') {
    return `Findings recorded by agents on this codebase: (not recalled — ${result.detail})`;
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
      text += `  • ${line}${f.pending ? `  ${pendingNote(f.pending)}` : ''}${f.claim ? `  ${claimNote(f.claim)}` : ''}\n`;
      if (!opts.compact) {
        const fileLine = f.files?.length ? `files: ${f.files.join(', ')}` : f.content.split('\n').find(l => l.startsWith('files:'));
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
        const tag = f.verdict === 'fixed' ? (f.fix ? `[FIXED in ${f.fix.sha.slice(0, 10)}]` : '[FIXED]') : '[RETRACTED]';
        const line = f.summary || f.content.split('\n')[0] || f.id;
        text += `  • ${tag} ${line} (concept: ${f.id})${f.fix ? fixNote(f.fix) : ''}\n`;
      }
      if (closed.length > opts.max) {
        text += `  … and ${closed.length - opts.max} more closed\n`;
      }
    }
  }
  return text.trimEnd();
}

/** An open finding's note while someone holds a live claim on it. */
function claimNote(c: NonNullable<AgentFinding['claim']>): string {
  const until = new Date(c.until).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  return c.here
    ? `[claimed by this checkout until ${until}]`
    : `[claimed by ${c.by} until ${until}: someone is working on it]`;
}

/** An open finding's note when its fix was endorsed uncommitted. */
function pendingNote(p: NonNullable<AgentFinding['pending']>): string {
  const branch = p.branch ? ` on ${p.branch}` : '';
  if (p.awaitingMerge) return `[fix pending: pushed${p.by ? ` by ${p.by}` : ''}, awaiting merge into ${p.awaitingMerge}]`;
  if (p.unpushed) {
    return p.here
      ? `[fix pending: committed in this checkout${branch} but not pushed; push it, then mark_complete endorse again]`
      : `[fix pending: committed in another checkout${p.by ? ` (${p.by})` : ''}${branch} but not pushed; not available here]`;
  }
  return p.here
    ? `[fix pending: uncommitted in this checkout${branch}; commit it, then mark_complete endorse again]`
    : `[fix pending: uncommitted in another checkout${p.by ? ` (${p.by})` : ''}${branch}; not in this one]`;
}

/** A fixed finding's note when this checkout does not have the fix commit. */
function fixNote(fix: NonNullable<AgentFinding['fix']>): string {
  if (fix.inHead !== false) return '';
  const where = [fix.branch ? `fixed on ${fix.branch}` : '', fix.pushed ? '' : 'not pushed when endorsed'].filter(Boolean).join(', ');
  return ` — the fix is not in this checkout's HEAD${where ? ` (${where})` : ''}`;
}

/**
 * The line get_problems and get_analysis_context lead with: one count of open
 * findings across the local store and the cross-agent recall, so an agent that
 * reads only the first line does not take "none in the local store" for "none".
 *
 * A finding this session recorded is in both places, so it is counted once:
 * local seeds group by their linked concept id (a multi-file finding is one
 * finding) and a recalled finding overlaps a group when it is that concept or
 * carries one of the group's `agf_*` ids. Only unverdicted recall counts as open.
 * `localSeeds` null means the local store is unavailable. SPEC §get_problems
 */
export function openFindingsHeadline(
  allLocalSeeds: SeedRecord[] | null,
  allRecall: AgentFindingsResult,
): string {
  // Tasks are counted apart from findings: they are work assigned, not problems.
  const localSeeds = allLocalSeeds && allLocalSeeds.filter(s => s.category.toLowerCase() !== TASK_CATEGORY);
  const recall = withoutTasks(allRecall);
  const taskIds = new Set<string>();
  for (const s of allLocalSeeds ?? []) if (s.category.toLowerCase() === TASK_CATEGORY) taskIds.add(conceptIdFromRefs(s.refs_json) ? plainConceptId(conceptIdFromRefs(s.refs_json)!) : s.id);
  if (allRecall.status === 'ok') for (const f of allRecall.findings) if (isTaskFinding(f) && !f.verdict) taskIds.add(f.id);
  const tasks = taskIds.size ? `; ${taskIds.size} open task${taskIds.size === 1 ? '' : 's'}, listed apart` : '';
  return openFindingsCount(localSeeds, recall) + tasks;
}

function openFindingsCount(
  localSeeds: SeedRecord[] | null,
  recall: AgentFindingsResult,
): string {
  const groups = new Map<string, { conceptId: string | null; seedIds: Set<string> }>();
  for (const s of localSeeds ?? []) {
    const ref = conceptIdFromRefs(s.refs_json);
    const conceptId = ref ? plainConceptId(ref) : null;
    const key = conceptId ? `concept:${conceptId}` : `seed:${s.id}`;
    const g = groups.get(key) ?? { conceptId, seedIds: new Set<string>() };
    g.seedIds.add(s.id);
    groups.set(key, g);
  }
  const local = groups.size;
  const localPart = localSeeds ? `${local} in the local store` : 'local store unavailable';

  if (recall.status !== 'ok') {
    const why = recall.status === 'skipped'
      ? 'not attached to a substrate, so findings recorded by other agents are not recalled'
      : 'findings recorded by other agents could not be recalled (see below)';
    return localSeeds ? `Open findings: ${local} in the local store; ${why}` : `Open findings: unknown (${localPart}; ${why})`;
  }

  const open = recall.findings.filter(f => !f.verdict);
  let both = 0;
  for (const f of open) {
    const ids = new Set(parseFindingIds(f.content));
    for (const g of groups.values()) {
      if (g.conceptId === f.id || [...g.seedIds].some(id => ids.has(id))) {
        both++;
        break;
      }
    }
  }
  const total = local + open.length - both;
  const shared = `${open.length} recorded by agents on this codebase`;
  const overlap = both > 0 ? `; ${both} in both` : '';
  return `Open findings: ${total} (${localPart}, ${shared}${overlap})`;
}

// @anchor duplicate-finding
/**
 * Two finding summaries are the same finding when their normalized text is
 * equal (lowercased, every run of characters other than letters and numbers one
 * space), or when their word sets overlap with a Jaccard index of at least
 * DUPLICATE_JACCARD — |A ∩ B| / |A ∪ B| over the normalized words. 0.8 lets a
 * re-worded article or a reordered clause through as the same finding, while
 * two findings about one area that share most of their vocabulary
 * ("token refresh races the session sweep" / "session sweep logs the raw
 * token": 4 of 8 words, 0.5) stay distinct. SPEC §record_finding
 */
export const DUPLICATE_JACCARD = 0.8;

export function normalizeSummary(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function sameFindingSummary(a: string, b: string): boolean {
  const na = normalizeSummary(a);
  const nb = normalizeSummary(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared) >= DUPLICATE_JACCARD;
}

/** The agent's own summary out of a `code_finding` concept's `[SEV][cat] <repo>: <summary>` line. */
export function findingSummaryText(conceptSummary: string): string {
  return conceptSummary.replace(/^\[[^\]]*\]\[[^\]]*\]\s*[^:]*:\s*/, '');
}

function samePath(a: string, b: string): boolean {
  const clean = (p: string) => p.trim().replace(/^\.\//, '');
  return clean(a) === clean(b);
}

export interface OpenDuplicate {
  /** The id to act on: the local `agf_*` id when this machine holds a seed, else the concept id. */
  id: string;
  conceptId: string | null;
  summary: string;
  files: string[];
  where: 'local store' | 'recorded by agents on this codebase';
}

/**
 * An open finding already recorded on one of `files` with the same summary
 * (sameFindingSummary): from the local store first (non-stale seeds), then from
 * the recall (findings with no verdict). Null when there is none.
 */
export function findOpenDuplicate(
  files: string[],
  summary: string,
  localStore: LocalStore | null | undefined,
  recall: AgentFindingsResult,
): OpenDuplicate | null {
  if (localStore) {
    for (const file of files) {
      for (const s of localStore.getCachedSeeds(file)) {
        if (!samePath(s.file_path, file) || !sameFindingSummary(s.brief, summary)) continue;
        const ref = conceptIdFromRefs(s.refs_json);
        return { id: s.id, conceptId: ref ? plainConceptId(ref) : null, summary: s.brief, files: [s.file_path], where: 'local store' };
      }
    }
  }
  if (recall.status === 'ok') {
    for (const f of recall.findings) {
      if (f.verdict) continue;
      const recorded = f.files ?? headerLine(f.content, 'files').split(',').map(x => x.trim()).filter(Boolean);
      if (!recorded.some(r => files.some(file => samePath(r, file)))) continue;
      const text = findingSummaryText(f.summary);
      if (!sameFindingSummary(text, summary)) continue;
      return { id: f.id, conceptId: f.id, summary: text, files: recorded, where: 'recorded by agents on this codebase' };
    }
  }
  return null;
}
