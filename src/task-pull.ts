// Contract (behaviour): SPEC §task-pull
/**
 * `metabob-mcp task pull`: a cell's entrypoint step that runs before any harness starts. It takes a task from the
 * ledger, claims it, writes the task and its context into the task directory and clones the work directory, so
 * every harness gets its work the same way: already mounted and fresh.
 *
 * Tasks are open findings in category `task` on the origin's repository, recorded by a coordinator. A task the
 * cell already holds comes first (a restarted cell resumes it), then unclaimed tasks by severity; a task someone
 * else holds is skipped. Each candidate is claimed through claim_finding's rule; a lost race or an unsettled claim
 * moves on to the next candidate.
 *
 * The integration policy (where the fix goes) comes from the task's own `details`, else from a
 * `project_convention` concept for the repository written by a trusted author, else `main` / `push` / `rebase`.
 * A convention is untrusted input that steers pushes, so only strict values are accepted and only from the trusted
 * authors (the task's recorder by default); the policy's source is recorded with it.
 *
 * Exit codes: 0 a task was pulled; 3 no open task (the cell is done); 4 open tasks exist but others hold them (retry
 * after the earliest claim end, which --json reports); 2 not attached; 1 any other failure. A failure after the claim
 * withdraws it, so one bad ref or origin never blocks a task for the claim's length.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { attachForCli } from './cli-attach.js';
import { GIT_ENV, normalizeRemoteUrl, vesselAliases, type RepoIdentity } from './repo-identity.js';
import { stampedWriter, type ConceptRow } from './tools/_concept-db.js';
import { headerBlock, plainConceptId } from './tools/_concept-content.js';
import { fetchAgentFindings, findingSummaryText, isTaskFinding, parseFindingIds, scanConceptShape, scanVerdicts, type AgentFinding } from './tools/_findings.js';
import { claim, InputSchema as ClaimInput } from './tools/claim-finding.js';
import { CLAIM_DEFAULT_MINUTES } from './tools/_claims.js';

export const PROJECT_CONVENTION_SHAPE = 'project_convention';
/** The dashboard's ruling on a conflict or a retirement (kind: ruling, with resolves: or supersedes: and outcome:). */
export const RULING_SHAPE = 'ruling';

export interface IntegrationPolicy {
  push_to: string;
  integrate: 'push' | 'review';
  conflicts: 'rebase';
  /** Where each value came from: `task`, `convention <concept id> by <author>`, or `default`. */
  source: Record<'push_to' | 'integrate' | 'conflicts', string>;
  /** Values seen and refused, with why: logged, never applied. */
  rejected: string[];
}

function header(content: string, key: string): string {
  return new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(headerBlock(content))?.[1]?.trim() ?? '';
}

/** A task's free text: what follows the blank line after its header block. */
export function taskDetails(content: string): string {
  const i = content.indexOf('\n\n');
  return i < 0 ? '' : content.slice(i + 2).trim();
}

/** `key: value` lines at the start of a line in free text. */
function declared(text: string, key: string): string | null {
  const m = new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'm').exec(text);
  return m ? m[1]! : null;
}

// @anchor integration-policy
/**
 * The task's integration policy (SPEC §task-pull): per value, a trusted convention's in effect, else the default; the
 * task's own declaration may only tighten it (`main` → `task`, `push` → `review`), since a brief carries text anyone
 * with write scope, or an issue copied into it, wrote. A loosening declaration and a value outside the allowed set
 * are refused, whatever their source.
 */
export function integrationPolicy(
  taskKey: string,
  details: string,
  conventions: Convention[],
  trusted: ReadonlySet<string>,
): IntegrationPolicy {
  const allowed: Record<'push_to' | 'integrate' | 'conflicts', (v: string) => string | null> = {
    push_to: v => (v === 'main' ? 'main' : v === 'task' || v === `task/${taskKey}` ? `task/${taskKey}` : null),
    integrate: v => (v === 'push' || v === 'review' ? v : null),
    conflicts: v => (v === 'rebase' ? v : null),
  };
  const defaults = { push_to: 'main', integrate: 'push', conflicts: 'rebase' } as const;
  const policy: IntegrationPolicy = { ...defaults, source: { push_to: 'default', integrate: 'default', conflicts: 'default' }, rejected: [] };
  const usable = conventions.filter(c => {
    const why = conventionNotInEffect(c, trusted);
    if (!why) return true;
    policy.rejected.push(`convention ${c.id} by ${c.author || 'an unattributed author'}: ${why}`);
    return false;
  });
  // How strict a value is: a task may move a value up this order, never down.
  const strictness = (v: string) => (v === 'main' || v === 'push' ? 0 : 1);
  for (const key of ['push_to', 'integrate', 'conflicts'] as const) {
    for (const c of usable) {
      const value = declared(c.content, key);
      if (value === null) continue;
      const ok = allowed[key](value);
      if (!ok) {
        policy.rejected.push(`${key}: ${value} (convention ${c.id} by ${c.author}): not an allowed value`);
        continue;
      }
      (policy as any)[key] = ok;
      policy.source[key] = `convention ${c.id} by ${c.author}`;
      break;
    }
    const value = declared(details, key);
    if (value === null) continue;
    const ok = allowed[key](value);
    if (!ok) {
      policy.rejected.push(`${key}: ${value} (task): not an allowed value`);
    } else if (strictness(ok) < strictness(policy[key])) {
      policy.rejected.push(`${key}: ${value} (task): loosens ${policy[key]} (${policy.source[key]}); a task may only tighten it`);
    } else {
      (policy as any)[key] = ok;
      policy.source[key] = 'task';
    }
  }
  return policy;
}

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
const severityOf = (f: AgentFinding) => SEVERITY_RANK[(/^\[([A-Z]+)\]/.exec(f.summary)?.[1] ?? '')] ?? 5;

/** Whether `ref` is a branch name git accepts, never an option: `git check-ref-format --branch`, no leading `-`, at most 100 characters. */
export function validRef(ref: string): boolean {
  if (!ref || ref.length > 100 || ref.startsWith('-')) return false;
  try {
    execFileSync('git', ['check-ref-format', '--branch', ref], { stdio: 'ignore', env: GIT_ENV() });
    return true;
  } catch {
    return false;
  }
}

// @anchor task-kind
/**
 * A task's kind: the first `Kind:` line among the brief's leading key lines (the header block, then the details' first
 * block, before a blank line: Goal:, Kind:, Owns:, …), its first word, lower case; a brief with none is a `change`. An
 * issue body or a log pasted further down cannot set it. SPEC §task-pull
 */
export function taskKind(f: AgentFinding): string {
  const [header = '', lead = ''] = f.content.split(/\n\s*\n/);
  const m = /^\s*kind:\s*([^\s,.;]+)/im.exec(`${header}\n${lead}`);
  return m ? m[1]!.toLowerCase() : 'change';
}

/**
 * Open tasks this cell can take, in the order it tries them: its own claims first, then unclaimed by severity; with
 * `kinds`, only tasks of those kinds.
 */
export function candidateTasks(findings: AgentFinding[], kinds: string[] = []): AgentFinding[] {
  const open = findings.filter(f => isTaskFinding(f) && !f.verdict && !f.pending && (!kinds.length || kinds.includes(taskKind(f))));
  const mine = open.filter(f => f.claim?.here);
  const free = open.filter(f => !f.claim).sort((a, b) => severityOf(a) - severityOf(b));
  return [...mine, ...free];
}

export interface PullArgs {
  origin: string;
  taskDir: string;
  workDir: string;
  minutes: number;
  trust: string[];
  /** The kinds of task this cell takes; empty, every kind. */
  kinds: string[];
  json: boolean;
}

function parseArgs(args: string[]): PullArgs | string {
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const origin = value('--origin');
  if (!origin) return 'usage: metabob-mcp task pull --origin <git url> [--task-dir /task] [--work-dir /work] [--minutes 60] [--trust <key,…>] [--kinds <kind,…>] [--json]';
  const minutes = Number(value('--minutes') ?? CLAIM_DEFAULT_MINUTES);
  return {
    origin,
    taskDir: resolve(value('--task-dir') ?? '/task'),
    workDir: resolve(value('--work-dir') ?? '/work'),
    minutes: Number.isFinite(minutes) ? minutes : CLAIM_DEFAULT_MINUTES,
    trust: (value('--trust') ?? process.env.METABOB_TASK_TRUST ?? '').split(',').map(s => s.trim()).filter(Boolean),
    kinds: (value('--kinds') ?? process.env.METABOB_TASK_KINDS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    json: args.includes('--json'),
  };
}

const emptyOrMissing = (dir: string) => !existsSync(dir) || readdirSync(dir).length === 0;

export async function runTaskPull(args: string[]): Promise<number> {
  const a = parseArgs(args);
  const say = (code: number, message: string, extra: Record<string, unknown> = {}) => {
    const out = a && typeof a !== 'string' && a.json ? JSON.stringify({ code, message, ...extra }) : message;
    (code === 0 ? process.stdout : process.stderr).write(out + '\n');
    return code;
  };
  if (typeof a === 'string') {
    process.stderr.write(a + '\n');
    return 1;
  }
  const repoId = normalizeRemoteUrl(a.origin);
  if (!repoId) return say(1, `--origin ${a.origin} is not a git URL this can name a repository by`);
  if (!emptyOrMissing(a.taskDir) || !emptyOrMissing(a.workDir)) {
    return say(1, `${a.taskDir} and ${a.workDir} must be empty or missing: a task gets fresh directories, never reused ones`);
  }

  const attached = await attachForCli(a.workDir);
  if (!attached.ok) return say(2, attached.cause);
  const vesselId = attached.vesselId;
  const result = await pullTask(a, attached.sessionId, vesselId);
  return say(result.code, result.message, result.extra);
}

export interface PullResult { code: number; message: string; extra?: Record<string, unknown> }

/**
 * The pull itself, with the attachment and the vessel identity already set: candidates, claim, task directory,
 * clone. runTaskPull wraps it with the configuration and the attachment.
 */
export async function pullTask(a: PullArgs, sessionId: string, vesselId?: string, pauses?: readonly number[]): Promise<PullResult> {
  const say = (code: number, message: string, extra?: Record<string, unknown>): PullResult => ({ code, message, extra });
  const repoId = normalizeRemoteUrl(a.origin)!;
  const repo: RepoIdentity = { id: repoId, name: repoId.split('/').pop() || repoId, source: 'origin' };

  // No checkout exists yet, so the aliases come from the origin: a task recorded in the super-repo on this vessel's
  // files is found, with its paths mapped (SPEC §repository-identity).
  const recall = await fetchAgentFindings({} as never, { repo, workspace: tmpdir(), aliases: vesselAliases(repoId) });
  if (recall.status !== 'ok') return say(1, `the ledger could not be read (${recall.status}${recall.detail ? `: ${recall.detail}` : ''})`);
  const candidates = candidateTasks(recall.findings, a.kinds ?? []);
  const tried: string[] = [];
  // Held by others among the tasks of this cell's kinds only: open tasks of other kinds are nothing for it (exit 3).
  const heldUntil: number[] = recall.findings
    .filter(f => isTaskFinding(f) && !f.verdict && f.claim && !f.claim.here && (!a.kinds?.length || a.kinds.includes(taskKind(f))))
    .map(f => f.claim!.until);
  for (const task of candidates) {
    const result = await claim(ClaimInput.parse({ problem_id: task.id, action: 'claim', minutes: a.minutes }), sessionId, null, { repo, withdrawUnsettled: true, ...(pauses ? { pauses } : {}) });
    tried.push(`${task.id}: ${result.outcome}`);
    if (result.outcome === 'held' || result.outcome === 'lost') {
      if (result.holder) heldUntil.push(result.holder.until);
      continue;
    }
    // An unsettled claim was withdrawn by claim() (withdrawUnsettled), so it cannot hold the task while this cell
    // moves on; it is worth retrying soon: the read path had not caught up with the write.
    if (result.outcome === 'unsettled') {
      heldUntil.push(Date.now() + 30_000);
      continue;
    }
    if (result.outcome !== 'claimed' && result.outcome !== 'renewed') continue;
    const key = result.key!;
    // Anything that fails from here withdraws the claim: left to lapse, it would block the task for every cell.
    const release = async (why: string): Promise<PullResult> => {
      const released = await claim(ClaimInput.parse({ problem_id: task.id, action: 'release' }), sessionId, null, { repo });
      return say(1, `${why}. ${released.outcome === 'released' ? `The claim on ${key} was withdrawn.` : `The claim on ${key} could not be withdrawn (${released.message}); it lapses on its own.`}`);
    };
    const details = taskDetails(task.content);
    const recorder = task.writtenBy || header(task.content, 'recorded_by');
    // Without a configured trust list, the task's recorder (its writing key, by name and id) vouches for the
    // conventions that shape it: recorded as defaulted.
    const trustDefaulted = a.trust.length === 0;
    const trusted = new Set(trustDefaulted ? [recorder, task.writtenByKey ?? ''].filter(Boolean) : a.trust);
    const conventions = await readConventions(repo);
    if ('error' in conventions) return release(`task ${key} was not set up: ${conventions.error}, so its integration policy is unknown`);
    const policy = integrationPolicy(key, details, conventions, trusted);
    for (const r of policy.rejected) process.stderr.write(`warn: integration policy: ${r}\n`);
    const ref = declared(details, 'ref');
    if (ref && !validRef(ref)) return release(`task ${key} declares ref ${ref}, which is not a branch name git accepts`);

    const files = task.files ?? header(task.content, 'files').split(',').map(s => s.trim()).filter(Boolean);
    const related = recall.findings.filter(f => f.id !== task.id && !isTaskFinding(f) && !f.verdict
      && (f.files ?? header(f.content, 'files').split(',').map(s => s.trim())).some(x => files.includes(x)));
    const record = {
      task_id: key,
      concept_id: plainConceptId(task.id),
      finding_ids: parseFindingIds(task.content),
      summary: findingSummaryText(task.summary),
      severity: /^\[([A-Z]+)\]/.exec(task.summary)?.[1] ?? null,
      files,
      subject: header(task.content, 'subject') || null,
      details,
      origin: a.origin,
      repo: repo.id,
      ref: ref ?? null,
      policy: { push_to: policy.push_to, integrate: policy.integrate, conflicts: policy.conflicts, source: policy.source },
      claim: { by: result.holder?.by ?? vesselId, until: new Date(result.holder?.until ?? Date.now()).toISOString() },
      trust: { authors: [...trusted], defaulted: trustDefaulted },
      recorded_by: recorder || null,
      pulled_at: new Date().toISOString(),
      session: sessionId,
    };
    try {
      mkdirSync(a.taskDir, { recursive: true });
      writeFileSync(join(a.taskDir, 'task.json'), JSON.stringify(record, null, 2) + '\n');
      writeFileSync(join(a.taskDir, 'context.md'), contextFile(record, task, related));
    } catch (err) {
      return release(`claimed ${key}, but writing ${a.taskDir} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      execFileSync('git', ['clone', '--quiet', ...(ref ? ['--branch', ref] : []), '--', a.origin, a.workDir], { stdio: ['ignore', 'ignore', 'pipe'], env: GIT_ENV() });
    } catch (err) {
      return release(`claimed ${key}, but cloning ${a.origin} failed: ${(err as { stderr?: Buffer }).stderr?.toString().trim() || String(err)}`);
    }
    // Where the clone started, recorded in task.json. Not the range finding close takes: after a rebase <base>..HEAD
    // would also hold other cells' merged commits, so the entrypoint lists its own (origin/<target>..HEAD).
    const base = execFileSync('git', ['-C', a.workDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: GIT_ENV() }).trim();
    (record as Record<string, unknown>).base = base;
    writeFileSync(join(a.taskDir, 'task.json'), JSON.stringify(record, null, 2) + '\n');
    return say(0, `pulled ${key}: ${record.summary} (claimed until ${record.claim.until}; push to ${policy.push_to}, integrate by ${policy.integrate})`, { task: record });
  }
  if (heldUntil.length) {
    const next = new Date(Math.min(...heldUntil)).toISOString();
    return say(4, `every open task is held by someone else; the earliest claim ends at ${next}${tried.length ? ` (${tried.join('; ')})` : ''}`, { tried, retry_after: next });
  }
  return say(3, tried.length ? `no open task could be claimed (${tried.join('; ')})` : 'no open task', { tried });
}

/** A writer as trust lists name it: the stamped key's name and id, or, on a row from before the stamp, its declared author. */
type Writer = string[];

function writerOf(row: ConceptRow, declaredKey: 'recorded_by' | 'reviewed_by'): Writer {
  const declared = header(String(row.content ?? ''), declaredKey);
  return row.written_by ? [stampedWriter(row, declared), String(row.written_by_key ?? '')].filter(Boolean) : [declared].filter(Boolean);
}

/** A project_convention as integrationPolicy weighs it, with what the ledger says about it. */
export interface Convention {
  id: string;
  /** Its writer, shown in a refusal: the stamped key's name, else the declared author. */
  author: string;
  /** Every name its writer goes by: the stamped key's name and id, or the declared author. */
  writer?: Writer;
  /** Its `status:` line (`proposed`), or empty when it has none. */
  status?: string;
  /** The writers of the verdicts that endorse it, and of those that reject it. */
  endorsedBy?: Writer[];
  rejectedBy?: Writer[];
  /** The writers of the rulings that retire or overrule it (a ruling's supersedes: or resolves: with its outcome). */
  retiredBy?: Writer[];
  content: string;
}

// @anchor convention-in-effect
/**
 * Why a convention does not set a policy, or null when it does: the base prompt's rule. It is in effect when a
 * trusted key wrote it with no `status:` line, or a trusted key's verdict endorses it and none rejects it; and no
 * trusted key's ruling retires it, refines it, or lets the other side stand. SPEC §task-pull
 */
export function conventionNotInEffect(c: Convention, trusted: ReadonlySet<string>): string | null {
  const isTrusted = (w: Writer | undefined) => !!w && w.some(n => trusted.has(n));
  const writer = c.writer ?? [c.author];
  if ((c.retiredBy ?? []).some(isTrusted)) return 'retired or overruled by a ruling';
  if ((c.rejectedBy ?? []).some(isTrusted)) return 'rejected';
  if (c.status) return (c.endorsedBy ?? []).some(isTrusted) ? null : `${c.status}, not endorsed by a trusted key`;
  return isTrusted(writer) ? null : 'not a trusted author';
}

/**
 * The repository's project_convention concepts, newest first, with their endorsements, rejections and rulings. Each
 * shape is read the way recall reads findings: pages of 300 by offset, up to four (src/tools/_findings.ts@scanConceptShape).
 */
async function readConventions(repo: RepoIdentity): Promise<Convention[] | { error: string }> {
  // Fail closed: with the conventions, their verdicts or the rulings unread (any page of them), the defaults (push to
  // main) could override a review policy, a rejected convention count, or a retired one bind again.
  const unread = (what: string, scan: Awaited<ReturnType<typeof scanConceptShape>>) =>
    !scan.ok ? `${what} could not be read (${scan.detail})` : scan.failed ? `${what} could not all be read (${scan.failed})` : null;
  const found = await scanConceptShape(PROJECT_CONVENTION_SHAPE);
  const conventionsUnread = unread('the conventions', found);
  if (conventionsUnread || !found.ok) return { error: conventionsUnread ?? 'the conventions could not be read' };
  const rows = found.rows
    .filter(r => header(String(r.content ?? ''), 'repo').toLowerCase() === repo.id)
    .sort((x, y) => Date.parse(String(y.created_at ?? '')) - Date.parse(String(x.created_at ?? '')));
  if (!rows.length) return [];
  const ids = new Set(rows.map(r => plainConceptId(r.id)));
  const endorsed = new Map<string, Writer[]>();
  const rejected = new Map<string, Writer[]>();
  const retired = new Map<string, Writer[]>();
  const add = (m: Map<string, Writer[]>, id: string, w: Writer) => m.set(id, [...(m.get(id) ?? []), w]);
  const verdicts = await scanVerdicts();
  const verdictsUnread = unread('the verdicts on them', verdicts);
  if (verdictsUnread || !verdicts.ok) return { error: verdictsUnread ?? 'the verdicts could not be read' };
  for (const v of verdicts.rows) {
    const target = plainConceptId(header(String(v.content ?? ''), 'concept'));
    if (!ids.has(target)) continue;
    const verdict = header(String(v.content ?? ''), 'verdict');
    if (verdict === 'endorsed') add(endorsed, target, writerOf(v, 'reviewed_by'));
    else if (verdict === 'rejected') add(rejected, target, writerOf(v, 'reviewed_by'));
  }
  const rulings = await scanConceptShape(RULING_SHAPE);
  const rulingsUnread = unread('the rulings', rulings);
  if (rulingsUnread || !rulings.ok) return { error: rulingsUnread ?? 'the rulings could not be read' };
  for (const r of rulings.rows) {
    const content = String(r.content ?? '');
    const outcome = header(content, 'outcome');
    const list = (key: string) => header(content, key).split(',').map(x => plainConceptId(x.trim())).filter(Boolean);
    const out: string[] = outcome === 'retired' ? list('supersedes')
      : outcome === 'refined' ? list('resolves')
      : outcome === 'a' ? list('resolves').slice(1, 2)
      : outcome === 'b' ? list('resolves').slice(0, 1) : [];
    for (const id of out) if (ids.has(id)) add(retired, id, writerOf(r, 'recorded_by'));
  }
  return rows.map(r => {
    const id = plainConceptId(r.id);
    const content = String(r.content ?? '');
    return {
      id, author: stampedWriter(r, header(content, 'recorded_by')), writer: writerOf(r, 'recorded_by'),
      status: header(content, 'status'), endorsedBy: endorsed.get(id), rejectedBy: rejected.get(id), retiredBy: retired.get(id), content,
    };
  });
}

function contextFile(record: { task_id: string; summary: string; files: string[]; subject: string | null; details: string; policy: unknown }, task: AgentFinding, related: AgentFinding[]): string {
  // A task that names no file changes nothing in the tree: it is closed by mark_complete with its outcome, not by a commit.
  const fileless = record.files.length === 0;
  return [
    `# Task ${record.task_id}: ${record.summary}`,
    '',
    ...(fileless ? [] : [`Files: ${record.files.join(', ')}`]),
    ...(record.subject ? [`Subject: ${record.subject}`] : []),
    ...(fileless ? ['', 'This task names no file: when it is done, close it with mark_complete endorse and its outcome (what was done or found) and evidence; there is no commit to push.'] : []),
    '',
    '## Details',
    '',
    record.details || '(none)',
    '',
    '## Integration',
    '',
    '```json',
    JSON.stringify(record.policy, null, 2),
    '```',
    '',
    ...(fileless ? [] : [
      '## Open findings on these files',
      '',
      ...(related.length ? related.map(f => `- ${f.summary} (${plainConceptId(f.id)})`) : ['(none)']),
      '',
    ]),
    '## The task as recorded',
    '',
    '```',
    task.content,
    '```',
    '',
  ].join('\n');
}
