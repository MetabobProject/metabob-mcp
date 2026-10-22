/**
 * Shared rendering of a concept's BODY for concept_search / concept_neighbors.
 *
 * Why this exists: both tools used to render only id/shape/summary/metrics, so a
 * recalling agent could see that a decision had been recorded but could never
 * read what it said. A concept's content carries both structured `key: value`
 * lines (repo:, files:, recorded_by:, finding_ids: …) and free prose; the whole
 * point of the shared record is that a later agent reads that text.
 *
 * The body was omitted for a real reason — 50 concepts × a full body floods the
 * caller's context. So the default is a verbatim PREFIX with an explicit
 * disclosure of what was cut, plus a guaranteed path to the whole body
 * (`content: 'full'`, or `concept_id` on concept_search for a direct read).
 *
 * Rendering rules, deliberately conservative:
 *  - The preview is a VERBATIM prefix. Nothing is reordered, extracted or
 *    summarised, so a `key: value` line can never be lifted out of the prose or
 *    code block it belonged to and read as an attribution it isn't.
 *  - The cut backs off to the last newline inside the budget, so a half-copied
 *    `files: a.ts, b.ts` never renders as a shorter, different list.
 *  - Truncation is always disclosed, with the FULL character length and how to
 *    get the rest. An untruncated body gets no disclosure noise at all.
 */

export type ContentMode = 'preview' | 'full' | 'none';

/**
 * Strip concept-db's id decorations down to the bare canonical form.
 *
 * Measured on dashboard-film: the same store returns some ids bare
 * (`concept_BwUOtHpndHtA`) and others wrapped (`⟨concept_AmOKMgWJ-UJM⟩`) in the
 * SAME search response. The wrapped form must not be what a tool tells an agent
 * to paste back as `concept_id` — this is the form every concept-db route
 * accepts, and the form `fetchConceptById` already normalises to.
 */
export function plainConceptId(id: string | null | undefined): string {
  // Order matters, and all three nestings occur: `concept:⟨X⟩`, `⟨concept:X⟩`
  // and `⟨X⟩`. Stripping the prefix first leaves `concept:X` for the second
  // form, which then reaches concept-db as a literal id and 404s — so peel the
  // prefix, then the brackets, then the prefix again.
  return String(id ?? '')
    .trim()
    .replace(/^concept:/, '')
    .replace(/^⟨/, '')
    .replace(/⟩$/, '')
    .replace(/^concept:/, '');
}

/** Per-concept verbatim prefix budget in the default 'preview' mode. */
export const PREVIEW_CHAR_BUDGET = 700;

export interface RenderContentOptions {
  /** Indent applied to every emitted line (matches the caller's field block). */
  indent?: string;
  /** Concept id quoted in the truncation disclosure's escape hatch. */
  conceptId?: string;
  /** Override the preview budget (tests, and callers with tighter budgets). */
  budget?: number;
  /**
   * Escape hatch phrasing. concept_search can offer `concept_id`; neighbors
   * has no such parameter, so it points at concept_search instead.
   */
  fullBodyHint?: (conceptId: string) => string;
}

/**
 * Cut `body` to at most `budget` characters, preferring the last newline in the
 * kept region so a structured line is never shown half-copied. Returns the
 * verbatim prefix — never a re-assembly.
 */
export function truncateBody(body: string, budget: number): string {
  if (body.length <= budget) return body;
  const hardCut = body.slice(0, budget);
  const lastNewline = hardCut.lastIndexOf('\n');
  // Always back off to a line boundary when there is one, even if that costs a
  // lot of the budget: a half-copied `files: a.ts, b` reads as a shorter,
  // different list, and a preview that misleads is worse than a short one. Only
  // a body with no newline inside the budget takes the hard cut.
  if (lastNewline > 0) return hardCut.slice(0, lastNewline);
  return hardCut;
}

function defaultFullBodyHint(conceptId: string): string {
  return conceptId
    ? `re-run with content="full", or concept_id="${conceptId}" for a direct full read`
    : 're-run with content="full"';
}

/**
 * Render the `content:` block for one concept.
 *
 * Returns '' when there is nothing to show (mode 'none', or an empty body) so
 * callers can concatenate unconditionally.
 */
export function renderConceptContent(
  body: string | null | undefined,
  mode: ContentMode,
  opts: RenderContentOptions = {},
): string {
  if (mode === 'none') return '';
  const content = String(body ?? '');
  if (content.trim().length === 0) return '';

  const indent = opts.indent ?? '   ';
  const budget = opts.budget ?? PREVIEW_CHAR_BUDGET;
  const hint = opts.fullBodyHint ?? defaultFullBodyHint;

  const shown = mode === 'full' ? content : truncateBody(content, budget);
  const truncated = shown.length < content.length;

  let out = `${indent}content:\n`;
  for (const line of shown.split('\n')) {
    out += `${indent}  ${line}\n`;
  }
  if (truncated) {
    out += `${indent}  [content truncated: showing ${shown.length} of ${content.length} chars — ${hint(opts.conceptId ?? '')}]\n`;
  }
  return out;
}

// @anchor header-block
/**
 * A concept's header block: its leading `key: value` lines, up to the first blank line. Readers take keys (author,
 * session, repo, files, verdict) only from here, the same block concept_create stamps the author into, so free text
 * after the blank line can never supply an author, a session or a verdict. SPEC §concept_create
 */
export function headerBlock(content: string): string {
  const i = content.search(/\n[ \t]*\n/);
  return i < 0 ? content : content.slice(0, i);
}
