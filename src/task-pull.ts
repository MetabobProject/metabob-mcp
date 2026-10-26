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
import { searchConcepts } from './tools/_concept-db.js';
import { headerBlock, plainConceptId } from './tools/_concept-content.js';
import { fetchAgentFindings, findingSummaryText, isTaskFinding, parseFindingIds, type AgentFinding } from './tools/_findings.js';
import { claim, InputSchema as ClaimInput } from './tools/claim-finding.js';
import { CLAIM_DEFAULT_MINUTES } from './tools/_claims.js';

export const PROJECT_CONVENTION_SHAPE = 'project_convention';

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
 * The task's integration policy (SPEC §task-pull): per value, the task's declaration, else a trusted convention's,
 * else the default. A value outside the allowed set is refused, whatever its source.
 */
export function integrationPolicy(
  taskKey: string,
  details: string,
  conventions: Array<{ id: string; author: string; content: string }>,
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
    if (trusted.has(c.author)) return true;
    policy.rejected.push(`convention ${c.id} by ${c.author || 'an unattributed author'}: not a trusted author`);
    return false;
  });
  for (const key of ['push_to', 'integrate', 'conflicts'] as const) {
    const candidates: Array<[string, string | null]> = [['task', declared(details, key)], ...usable.map(c => [`convention ${c.id} by ${c.author}`, declared(c.content, key)] as [string, string | null])];
    for (const [source, value] of candidates) {
      if (value === null) continue;
      const ok = allowed[key](value);
      if (!ok) {
        policy.rejected.push(`${key}: ${value} (${source}): not an allowed value`);
        continue;
      }
      (policy as any)[key] = ok;
      policy.source[key] = source;
      break;
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

/** Open tasks this cell can take, in the order it tries them: its own claims first, then unclaimed by severity. */
export function candidateTasks(findings: AgentFinding[]): AgentFinding[] {
  const open = findings.filter(f => isTaskFinding(f) && !f.verdict && !f.pending);
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
  json: boolean;
}

function parseArgs(args: string[]): PullArgs | string {
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const origin = value('--origin');
  if (!origin) return 'usage: metabob-mcp task pull --origin <git url> [--task-dir /task] [--work-dir /work] [--minutes 60] [--trust <vesselId,…>] [--json]';
  const minutes = Number(value('--minutes') ?? CLAIM_DEFAULT_MINUTES);
  return {
    origin,
    taskDir: resolve(value('--task-dir') ?? '/task'),
    workDir: resolve(value('--work-dir') ?? '/work'),
    minutes: Number.isFinite(minutes) ? minutes : CLAIM_DEFAULT_MINUTES,
    trust: (value('--trust') ?? process.env.METABOB_TASK_TRUST ?? '').split(',').map(s => s.trim()).filter(Boolean),
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
  const candidates = candidateTasks(recall.findings);
  const tried: string[] = [];
  const heldUntil: number[] = recall.findings.filter(f => isTaskFinding(f) && !f.verdict && f.claim && !f.claim.here).map(f => f.claim!.until);
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
    const recorder = header(task.content, 'recorded_by');
    // Without a configured trust list, the task's recorder vouches for the conventions that shape it: recorded as defaulted.
    const trustDefaulted = a.trust.length === 0;
    const trusted = new Set(trustDefaulted ? (recorder ? [recorder] : []) : a.trust);
    const conventions = await readConventions(repo);
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
    // The base the entrypoint passes to finding close (<base>..HEAD): later rebases never widen the range to other cells' commits.
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

/** The repository's project_convention concepts, newest first, as integrationPolicy reads them. */
async function readConventions(repo: RepoIdentity): Promise<Array<{ id: string; author: string; content: string }>> {
  const found = await searchConcepts({ shape: PROJECT_CONVENTION_SHAPE, limit: 50 });
  if (!found.ok) return [];
  return found.value
    .filter(r => header(String(r.content ?? ''), 'repo').toLowerCase() === repo.id)
    .sort((x, y) => Date.parse(String(y.created_at ?? '')) - Date.parse(String(x.created_at ?? '')))
    .map(r => ({ id: plainConceptId(r.id), author: header(String(r.content ?? ''), 'recorded_by'), content: String(r.content ?? '') }));
}

function contextFile(record: { task_id: string; summary: string; files: string[]; details: string; policy: unknown }, task: AgentFinding, related: AgentFinding[]): string {
  return [
    `# Task ${record.task_id}: ${record.summary}`,
    '',
    `Files: ${record.files.join(', ') || '(none named)'}`,
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
    '## Open findings on these files',
    '',
    ...(related.length ? related.map(f => `- ${f.summary} (${plainConceptId(f.id)})`) : ['(none)']),
    '',
    '## The task as recorded',
    '',
    '```',
    task.content,
    '```',
    '',
  ].join('\n');
}
