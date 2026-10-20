// Contract (behaviour): SPEC §outgoing-text-guard
/**
 * The outgoing-text guard: every agent-authored text a tool sends to the substrate
 * passes here first, at the dispatcher (stdio and the loopback resolver alike), before
 * any handler runs.
 *
 * - A secret refuses the whole call: the attachment's key, the value of any secret-named
 *   environment variable long and random enough to be a secret, a private-key block, or a
 *   known credential pattern. The refusal names the field and the kind, never the match.
 * - A home path is redacted in prose fields (the reply says so) and refused in fields
 *   whose text is acted on (a goal, a raw pointer), where rewriting it would change what
 *   the request means.
 * - Each field has a size cap.
 *
 * It is a rail, not a guarantee: paraphrase, summaries, re-typed code and personal data in
 * prose pass. What leaves the machine is still the agent's choice.
 */

import { homedir, userInfo } from 'node:os';

/** How a field's text is used by the substrate. */
export type FieldKind = 'prose' | 'acted';

interface FieldRule {
  kind: FieldKind;
  maxBytes: number;
}

/**
 * The text fields each tool sends, by tool name. Ids, enums, numbers and booleans are
 * not listed: they carry no agent prose.
 */
// @anchor guarded-fields
export const GUARDED_FIELDS: Readonly<Record<string, Readonly<Record<string, FieldRule>>>> = {
  record_finding: {
    summary: { kind: 'prose', maxBytes: 2_048 },
    details: { kind: 'prose', maxBytes: 8_192 },
    files: { kind: 'prose', maxBytes: 8_192 },
    category: { kind: 'prose', maxBytes: 256 },
  },
  concept_create: {
    content: { kind: 'prose', maxBytes: 16_384 },
    summary: { kind: 'prose', maxBytes: 2_048 },
    pointer: { kind: 'acted', maxBytes: 16_384 },
  },
  concept_link: { description: { kind: 'prose', maxBytes: 2_048 } },
  provide_feedback: {
    rationale: { kind: 'prose', maxBytes: 8_192 },
    goal: { kind: 'prose', maxBytes: 4_096 },
  },
  run_goal: {
    goal: { kind: 'acted', maxBytes: 4_096 },
    variables: { kind: 'acted', maxBytes: 16_384 },
    tags: { kind: 'acted', maxBytes: 2_048 },
  },
  run_goal_async: {
    goal: { kind: 'acted', maxBytes: 4_096 },
    variables: { kind: 'acted', maxBytes: 16_384 },
    tags: { kind: 'acted', maxBytes: 2_048 },
  },
  submit_resolution: { answer: { kind: 'prose', maxBytes: 16_384 } },
  resolve_impulse: { pointer: { kind: 'acted', maxBytes: 16_384 } },
};

/** Credential patterns, by kind. Each is specific enough that a match is a secret, not prose. */
const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['private_key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ['gitlab_token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['npm_token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['slack_token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['auth_header', /\b(?:authorization|x-api-key)\s*[:=]\s*(?:bearer|apikey|basic)?\s*[A-Za-z0-9._~+/=-]{16,}/i],
  ['url_credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
];

const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;
/** Always secrets when set, however they look: the attachment's key. */
const ATTACHMENT_KEY_VARS = ['METABOB_API_KEY', 'SUBSTRATE_API_KEY'];
const MIN_SECRET_LENGTH = 16;
const MIN_SECRET_ENTROPY_BITS = 3.0;

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * The environment's secret values: the attachment key always; any other secret-named
 * variable only when its value is long and random enough to be a secret, so a variable
 * holding `1`, `true`, `dev` or a port never blocks a call.
 */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  for (const name of ATTACHMENT_KEY_VARS) {
    const v = env[name]?.trim();
    if (v) out.add(v);
  }
  for (const [name, raw] of Object.entries(env)) {
    const v = raw?.trim();
    if (!v || !SECRET_ENV_NAME.test(name)) continue;
    if (v.length >= MIN_SECRET_LENGTH && entropy(v) >= MIN_SECRET_ENTROPY_BITS) out.add(v);
  }
  return [...out];
}

/** The kind of secret in `text`, or null. Never returns the match. */
export function findSecret(text: string, secrets: readonly string[]): string | null {
  for (const s of secrets) if (text.includes(s)) return 'environment_secret';
  for (const [kind, re] of SECRET_PATTERNS) if (re.test(text)) return kind;
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Patterns for this user's home directory, in POSIX and Windows spellings. */
function homePatterns(): RegExp[] {
  const pats: RegExp[] = [];
  let home = '';
  let user = '';
  try { home = homedir(); } catch { /* no home: nothing to redact */ }
  try { user = userInfo().username; } catch { /* no user: nothing to redact */ }
  if (home && home.length > 1) pats.push(new RegExp(escapeRegExp(home).replace(/\\\\/g, '[\\\\/]'), 'g'));
  if (user) {
    const u = escapeRegExp(user);
    pats.push(new RegExp(`/(?:home|Users)/${u}(?=[/\\s"'\`]|$)`, 'g'));
    pats.push(new RegExp(`[A-Za-z]:[\\\\/]Users[\\\\/]${u}(?=[\\\\/\\s"'\`]|$)`, 'gi'));
  }
  return pats;
}

function hasHomePath(text: string, pats: RegExp[]): boolean {
  return pats.some((re) => { re.lastIndex = 0; return re.test(text); });
}

function redactHome(text: string, pats: RegExp[]): string {
  let out = text;
  for (const re of pats) { re.lastIndex = 0; out = out.replace(re, '~'); }
  return out;
}

export type GuardResult =
  | { ok: true; input: Record<string, unknown>; notes: string[] }
  | { ok: false; refusal: string };

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function mapStrings(value: unknown, f: (s: string) => string): unknown {
  if (typeof value === 'string') return f(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, f));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mapStrings(v, f)]));
  }
  return value;
}

/**
 * Guard a tool's validated input before it runs. A tool with no guarded fields passes
 * unchanged. SPEC §outgoing-text-guard
 */
// @anchor guard-tool-input
export function guardToolInput(tool: string, input: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): GuardResult {
  const rules = GUARDED_FIELDS[tool];
  if (!rules) return { ok: true, input, notes: [] };
  const secrets = secretValues(env);
  const homes = homePatterns();
  const out: Record<string, unknown> = { ...input };
  const notes: string[] = [];
  for (const [field, rule] of Object.entries(rules)) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    const text = textOf(value);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > rule.maxBytes) {
      return { ok: false, refusal: `${tool}: refused: outgoing_too_large(${field}, ${bytes} bytes; the limit is ${rule.maxBytes}). Shorten it; the substrate keeps a summary, not a dump.` };
    }
    const kind = findSecret(text, secrets);
    if (kind) {
      return { ok: false, refusal: `${tool}: refused: outgoing_secret(${kind}, ${field}). Nothing was sent. Remove the credential from ${field} and call again; the value is not repeated here.` };
    }
    if (hasHomePath(text, homes)) {
      if (rule.kind === 'acted') {
        return { ok: false, refusal: `${tool}: refused: outgoing_local_path(${field}). ${field} names a path in this machine's home directory, which means nothing on the substrate; rewriting it would change what the request asks. Use a repository-relative path.` };
      }
      out[field] = mapStrings(value, (s) => redactHome(s, homes));
      notes.push(`${field}: the home directory was replaced with ~ before sending.`);
    }
  }
  return { ok: true, input: out, notes };
}

/** The tool call's arguments as a log may show them: field names and sizes, never values. */
export function describeArgsForLog(args: unknown): Record<string, string> {
  if (!args || typeof args !== 'object') return {};
  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).map(([k, v]) => [k, `${typeof v}${typeof v === 'string' ? `(${v.length})` : ''}`]),
  );
}
