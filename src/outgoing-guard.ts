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
 * Every string a substrate tool sends is guarded (LOCAL_TOOLS send nothing and are
 * exempt); GUARDED_FIELDS sets a field's kind and cap, and any other field is treated as
 * acted on, with a 4 KB cap. Known secrets come from this process's environment and from
 * the workspace's own config files (.env*, .npmrc, .pypirc) and the user's credential files
 * (~/.netrc, ~/.aws/credentials), read locally and never sent.
 *
 * It catches accidents, not adversaries: paraphrase, summaries, re-typed code, an encoded
 * or split key and personal data in prose pass. What leaves the machine is still the
 * agent's choice.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

/** How a field's text is used by the substrate. */
export type FieldKind = 'prose' | 'acted';

interface FieldRule {
  kind: FieldKind;
  maxBytes: number;
}

/**
 * The kind and size cap of the text fields each tool sends, by tool name. A field a
 * sending tool has but this table does not list is still guarded, as acted on with a
 * 4 KB cap (DEFAULT_RULE), so a new field is guarded by default.
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

/** Tools that send nothing to the substrate: their inputs stay on this machine. */
export const LOCAL_TOOLS: ReadonlySet<string> = new Set([
  'init_workspace', 'analyze_impact', 'predict_cochanges', 'search_codebase', 'annotate_component',
  'get_metrics', 'assign_git_changes', 'get_problems', 'get_analysis_context', 'pull_assigned_work',
]);

/** A field of a sending tool that GUARDED_FIELDS does not list: treated as acted on. */
const DEFAULT_RULE: FieldRule = { kind: 'acted', maxBytes: 4_096 };

/** Credential patterns, by kind. Each is specific enough that a match is a secret, not prose. */
const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['private_key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  // AWS's documented example keys end in EXAMPLE and are exempt.
  ['aws_access_key', /\b(?:AKIA|ASIA)(?![0-9A-Z]{9}EXAMPLE\b)[0-9A-Z]{16}\b/],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ['gitlab_token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['npm_token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['slack_token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];

/**
 * Patterns whose captured value is screened before it counts. A placeholder (`YOUR_TOKEN`,
 * `<key>`, `***`, `${VAR}`) is prose about a credential, never a credential. Tokens must
 * also look random (`Bearer xxxxxxxx` is an example); a password does not, because weak
 * passwords (`admin`, `hunter2hunter2`) are the commonest real leak.
 */
const SCREENED_PATTERNS: ReadonlyArray<readonly [kind: string, re: RegExp, screen: 'token' | 'password']> = [
  ['auth_header', /\b(?:authorization|x-api-key|proxy-authorization)\s*[:=]\s*(?:bearer|apikey|basic|token)?\s*([A-Za-z0-9._~+/=-]{12,})/gi, 'token'],
  ['cookie', /\b(?:set-)?cookie\s*:\s*[^\s=;]+=([^\s;]{12,})/gi, 'token'],
  ['url_credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi, 'password'],
  ['config_assignment', /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*)\s*[:=]\s*['"]?([^\s'"]{4,})/gi, 'password'],
];

/** Config names where TOKEN/KEY/SECRET qualifies a number or a setting: MAX_TOKENS, TOKEN_TTL, KEY_ROTATION_DAYS. */
const QUALIFIED_NAME = /^(?:MAX|MIN)_|_(?:TTL|LENGTH|LEN|COUNT|LIMIT|TIMEOUT|SIZE|EXPIRY|EXPIRES\w*|ROTATION\w*|DAYS|HOURS|SECONDS|MS|BITS|BYTES|ALGORITHM|ALG|TYPE|HEADER|FORMAT|VERSION)$/i;

const PLACEHOLDER = /YOUR|EXAMPLE|PLACEHOLDER|REDACTED|CHANGE_?ME|SAMPLE|DUMMY|FAKE|<[^>]*>|\*{3,}|\.\.\./i;
/** A shell or template variable reference: `${NAME}`, `$NAME`. Case-sensitive, so `$w` in a random value is not one. */
const VARIABLE_REFERENCE = /\$\{|\$[A-Z_][A-Z0-9_]*/;

/** Whether a captured value is a placeholder rather than a value. */
function placeholder(v: string): boolean {
  if (/^\d+(?:\.\d+)?(?:ms|s|m|h|d|kb|mb|gb|k|m)?$/i.test(v)) return true; // a number or a duration: a setting, not a secret
  return PLACEHOLDER.test(v) || VARIABLE_REFERENCE.test(v) || /^(.)\1+$/.test(v)
    || /^[A-Z][A-Z0-9_]*$/.test(v) // an ALL_CAPS name, e.g. a variable reference
    || /^(?:pass(?:word)?|secret|token|key|value|xxx+|true|false|null|none|empty|yes|no|on|off)$/i.test(v);
}

/** Whether a captured value is a real-looking secret: not a placeholder, and random enough. */
function secretLike(value: string): boolean {
  const v = value.replace(/^['"]|['"]$/g, '');
  if (v.length < 8 || placeholder(v)) return false;
  return entropy(v) >= MIN_SECRET_ENTROPY_BITS;
}

/** Whether a captured password is real: any non-placeholder value, however weak. */
function passwordLike(value: string): boolean {
  const v = value.replace(/^['"]|['"]$/g, '');
  return v.length >= 4 && !placeholder(v);
}

const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;
/** Secret-named variables that hold a location or an identifier, not a secret. */
const NOT_SECRET_ENV_NAME = /_(?:PATH|FILE|DIR|ID|URL|HOST|PORT|NAME|USER|REGION)$/i;
/** Always secrets when set and at least MIN_ATTACHMENT_KEY_LENGTH long: the attachment's key. */
const ATTACHMENT_KEY_VARS = ['METABOB_API_KEY', 'SUBSTRATE_API_KEY'];
const MIN_ATTACHMENT_KEY_LENGTH = 12;
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
    if (v && v.length >= MIN_ATTACHMENT_KEY_LENGTH) out.add(v);
  }
  for (const [name, raw] of Object.entries(env)) addIfSecret(out, name, raw);
  return [...out];
}

/** A value that names a place rather than holding a secret: a path, or a URL with no credentials. */
function looksLikeLocation(v: string): boolean {
  return /^(?:\/|~|[A-Za-z]:[\\/]|\.\.?[\\/])/.test(v) || /^[a-z][a-z0-9+.-]*:\/\/[^\s@]*$/i.test(v);
}

function addIfSecret(out: Set<string>, name: string, raw: string | undefined): void {
  const v = raw?.trim().replace(/^['"]|['"]$/g, '');
  if (!v || !SECRET_ENV_NAME.test(name) || NOT_SECRET_ENV_NAME.test(name)) return;
  if (v.length < MIN_SECRET_LENGTH || looksLikeLocation(v) || !secretLike(v)) return;
  out.add(v);
}

/** Config files whose secret-named values an agent may paste: the workspace's and the user's. */
function secretFiles(workspace: string): string[] {
  const files = ['.env', '.env.local', '.env.development', '.env.production', '.env.test', '.npmrc', '.pypirc'].map((f) => join(workspace, f));
  let home = '';
  try { home = homedir(); } catch { /* no home */ }
  if (home) files.push(join(home, '.netrc'), join(home, '.aws', 'credentials'), join(home, '.npmrc'), join(home, '.pypirc'));
  return files;
}

const fileSecretCache = new Map<string, { mtimeMs: number; values: string[] }>();

/** The secret-named values in one config file (KEY=value, key = value, `machine … password x`), cached by mtime. */
function secretsInFile(path: string): string[] {
  let mtimeMs: number;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return []; }
  const cached = fileSecretCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.values;
  const out = new Set<string>();
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z0-9_.:\/-]+)\s*[=:]\s*(.+?)\s*$/.exec(line);
      if (m) addIfSecret(out, m[1]!, m[2]);
      const netrc = /\bpassword\s+(\S+)/.exec(line);
      if (netrc) addIfSecret(out, 'password', netrc[1]);
    }
  } catch { /* unreadable: nothing known from it */ }
  const values = [...out];
  fileSecretCache.set(path, { mtimeMs, values });
  return values;
}

/** Known secrets: the environment's and the config files'. Read locally; never sent. */
export function knownSecrets(env: NodeJS.ProcessEnv = process.env, workspace = env.WORKSPACE_PATH || process.cwd()): string[] {
  const out = new Set(secretValues(env));
  for (const f of secretFiles(workspace)) for (const v of secretsInFile(f)) out.add(v);
  return [...out];
}

/** The kind of secret in `text`, or null. Never returns the match. */
export function findSecret(text: string, secrets: readonly string[]): string | null {
  for (const s of secrets) if (text.includes(s)) return 'known_secret';
  for (const [kind, re] of SECRET_PATTERNS) if (re.test(text)) return kind;
  for (const [kind, re, screen] of SCREENED_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const value = m[m.length - 1];
      if (kind === 'config_assignment' && QUALIFIED_NAME.test(m[1]!)) continue;
      if (value && (screen === 'token' ? secretLike(value) : passwordLike(value))) return kind;
    }
  }
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
  if (LOCAL_TOOLS.has(tool)) return { ok: true, input, notes: [] };
  const rules = GUARDED_FIELDS[tool] ?? {};
  const secrets = knownSecrets(env);
  const homes = homePatterns();
  const out: Record<string, unknown> = { ...input };
  const notes: string[] = [];
  for (const [field, value] of Object.entries(input)) {
    if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') continue;
    const rule = Object.hasOwn(rules, field) ? rules[field]! : DEFAULT_RULE;
    const text = textOf(value);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > rule.maxBytes) {
      return { ok: false, refusal: `${tool}: refused: outgoing_too_large(${field}, ${bytes} bytes; the limit is ${rule.maxBytes}). Shorten it; the substrate keeps a summary, not a dump.` };
    }
    const kind = findSecret(text, secrets);
    if (kind) {
      return { ok: false, refusal: `${tool}: refused: outgoing_secret(${kind}, ${field}). Nothing was sent, and the value is not repeated here. Remove the credential from ${field}, or describe it with the value masked (e.g. postgres://admin:***@host, Authorization: Bearer ***), and call again.` };
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
