// Contract (behaviour): SPEC §finding-close
/**
 * `metabob-mcp finding close --commits <base>..<head>`: close by commit. Run after a push — by a cell's entrypoint
 * once it has pushed and verified, or by a person — it closes the findings that commits name in a
 * `Fixes-Finding: agf_…` trailer, once the fix is merged into the integration target on the origin. The commit is
 * the evidence, so no agent's say-so closes anything, and no commit text is sent: only the finding id and the sha.
 *
 * For each finding a commit in the range names:
 *   - the id must resolve to an open finding of this repository, so a typo never closes someone else's finding;
 *   - the target is fetched first (`git fetch origin <target>`); if the fetch fails nothing is written;
 *   - merged: the commit is in `origin/<target>`, or a commit there carries the same `Fixes-Finding:` line anywhere
 *     in its message (a squash merge concatenates messages into the body). Unless the merged commit was reverted
 *     there, the finding is endorsed with that commit as an explicit claim (`fix_claimed: yes`, `fix_via: trailer`),
 *     through mark_complete's own checks;
 *   - pushed but not merged (on some remote branch): a pending verdict, "fix pending (awaiting merge)";
 *   - on no remote: nothing is written; it is reported as unpushed.
 *
 * Exit codes: 0 done (each finding's outcome reported); 2 not attached; 1 any other failure, including a failed fetch.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { attachForCli } from './cli-attach.js';
import { repoIdentity } from './repo-identity.js';
import { plainConceptId } from './tools/_concept-content.js';
import {
  VERDICT_SHAPE,
  attributionLines,
  fetchAgentFindings,
  parseFindingIds,
  postConcept,
  repoLines,
  resolveAuthorVesselId,
  type AgentFinding,
} from './tools/_findings.js';
import * as MarkComplete from './tools/mark-complete.js';

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
  } catch {
    return null;
  }
}

const AGF_ID = /^agf_[A-Za-z0-9_-]+$/;
const TASK_JSON = join('/task', 'task.json');

/** The finding ids a commit names in its trailer block (`git interpret-trailers --parse`). */
export function trailerIds(cwd: string, sha: string): string[] {
  const message = git(cwd, ['log', '-1', '--format=%B', sha]) ?? '';
  let parsed = '';
  try {
    parsed = execFileSync('git', ['-C', cwd, 'interpret-trailers', '--parse'], { input: message, encoding: 'utf8' });
  } catch {
    return [];
  }
  return [...new Set(parsed.split('\n').map(l => /^Fixes-Finding:\s*(\S+)\s*$/i.exec(l)?.[1] ?? '').filter(id => AGF_ID.test(id)))];
}

export type CloseOutcome = 'closed' | 'awaiting_merge' | 'unpushed' | 'reverted' | 'unknown' | 'already_closed' | 'refused';

export interface CloseReport {
  id: string;
  outcome: CloseOutcome;
  commit?: string;
  detail: string;
}

export interface CloseArgs {
  commits: string;
  target: string;
  workDir: string;
  json: boolean;
}

/** The commit on `origin/<target>` that holds the fix for `id` from source commit `sha`, or null. */
function mergedCommit(cwd: string, remoteTarget: string, sha: string, id: string): string | null {
  if (git(cwd, ['merge-base', '--is-ancestor', sha, remoteTarget]) !== null) return sha;
  // A squash or rebase merge has a new sha; it carries the line, in its body if not its trailer block.
  const found = git(cwd, ['log', remoteTarget, '-E', `--grep=^Fixes-Finding:[[:space:]]*${id}[[:space:]]*$`, '--format=%H', '-1']);
  return found || null;
}

/** Whether a later commit on the target reverts `sha` (git revert's own message). */
function reverted(cwd: string, remoteTarget: string, sha: string): boolean {
  return !!git(cwd, ['log', remoteTarget, '-F', `--grep=This reverts commit ${sha}`, '--format=%H', '-1']);
}

/** The pull itself, with the attachment and identity set: SPEC §finding-close. */
export async function closeFromCommits(a: CloseArgs, sessionId: string): Promise<{ code: number; message: string; reports: CloseReport[] }> {
  const cwd = resolve(a.workDir);
  const remoteTarget = `origin/${a.target}`;
  if (git(cwd, ['fetch', '--quiet', 'origin', a.target]) === null) {
    return { code: 1, message: `git fetch origin ${a.target} failed, so nothing was written: a stale ${remoteTarget} could misjudge what is merged`, reports: [] };
  }
  const shas = (git(cwd, ['rev-list', '--reverse', a.commits]) ?? '').split('\n').filter(Boolean);
  const named = new Map<string, string>();
  for (const sha of shas) for (const id of trailerIds(cwd, sha)) named.set(id, sha);
  if (!named.size) return { code: 0, message: `no commit in ${a.commits} names a finding (Fixes-Finding: agf_…)`, reports: [] };

  const repo = repoIdentity(cwd);
  const recall = await fetchAgentFindings({} as never, { repo, workspace: cwd });
  if (recall.status !== 'ok') return { code: 1, message: `the ledger could not be read (${recall.status}${recall.detail ? `: ${recall.detail}` : ''}), so nothing was written`, reports: [] };
  const byId = new Map<string, AgentFinding>();
  for (const f of recall.findings) for (const id of parseFindingIds(f.content)) byId.set(id, f);

  const reports: CloseReport[] = [];
  for (const [id, sha] of named) {
    const finding = byId.get(id);
    if (!finding) {
      reports.push({ id, outcome: 'unknown', commit: sha, detail: `no finding ${id} on this repository (${repo.id}); nothing was written` });
      continue;
    }
    if (finding.verdict) {
      reports.push({ id, outcome: 'already_closed', commit: sha, detail: `${id} is already closed (${finding.verdict})` });
      continue;
    }
    const merged = mergedCommit(cwd, remoteTarget, sha, id);
    if (merged) {
      if (reverted(cwd, remoteTarget, merged) || reverted(cwd, remoteTarget, sha)) {
        reports.push({ id, outcome: 'reverted', commit: merged, detail: `the fix ${merged.slice(0, 10)} was reverted on ${remoteTarget}; nothing was written` });
        continue;
      }
      const out = await MarkComplete.handle(
        MarkComplete.InputSchema.parse({ problem_id: plainConceptId(finding.id), action: 'endorse', fix_commit: merged }),
        {} as never, sessionId, null, cwd, { head: remoteTarget, via: 'trailer' },
      );
      const closed = /endorsed/.test(out.split('\n')[0] ?? '') && !/left open/.test(out);
      reports.push({ id, outcome: closed ? 'closed' : 'refused', commit: merged, detail: out.split('\n').join(' | ') });
      continue;
    }
    if (git(cwd, ['branch', '-r', '--contains', sha])) {
      const me = await resolveAuthorVesselId();
      const posted = await postConcept({
        content: [
          `finding: ${id}`,
          'verdict: fix pending (awaiting merge)',
          `fix: commit ${sha}`,
          `fix_target: ${a.target}`,
          'fix_via: trailer',
          ...repoLines(repo),
          `files: ${/^files:\s*(.*)$/m.exec(finding.content)?.[1] ?? ''}`,
          ...attributionLines('reviewed_by', me, sessionId),
          'origin: remote',
        ].join('\n'),
        summary: `[verdict:pending] ${repo.name}: ${finding.summary}`,
        shape: VERDICT_SHAPE,
        source_type: 'metabob_annotation',
        pointer: { type: VERDICT_SHAPE },
      });
      reports.push({ id, outcome: posted.ok ? 'awaiting_merge' : 'refused', commit: sha, detail: posted.ok ? `pushed but not yet merged into ${a.target}: recorded as fix pending (awaiting merge)` : `the pending verdict could not be written (${posted.error})` });
      continue;
    }
    reports.push({ id, outcome: 'unpushed', commit: sha, detail: `${sha.slice(0, 10)} is on no remote branch; push it, then run finding close again` });
  }
  const line = reports.map(r => `${r.id}: ${r.outcome}`).join('; ');
  return { code: 0, message: line, reports };
}

function parseArgs(args: string[]): CloseArgs | string {
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const commits = value('--commits');
  if (!commits) return 'usage: metabob-mcp finding close --commits <base>..<head> [--target <branch>] [--work-dir <dir>] [--task <task.json>] [--json]';
  const workDir = resolve(value('--work-dir') ?? process.cwd());
  // The target: the flag, else the task's integration policy (review merges into main; a push is the integration
  // itself, so its branch is the target), else main.
  let target = value('--target');
  const taskFile = value('--task') ?? (existsSync(TASK_JSON) ? TASK_JSON : undefined);
  if (!target && taskFile && existsSync(taskFile)) {
    try {
      const policy = JSON.parse(readFileSync(taskFile, 'utf8')).policy;
      if (policy) target = policy.integrate === 'review' ? 'main' : String(policy.push_to ?? 'main');
    } catch { /* an unreadable task file leaves the default */ }
  }
  target ??= 'main';
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(target) || target.startsWith('-')) return `--target ${target} is not a branch name`;
  return { commits, target, workDir, json: args.includes('--json') };
}

export async function runFindingClose(args: string[]): Promise<number> {
  const a = parseArgs(args);
  if (typeof a === 'string') {
    process.stderr.write(a + '\n');
    return 1;
  }
  const say = (code: number, message: string, reports: CloseReport[] = []) => {
    const out = a.json ? JSON.stringify({ code, message, reports }) : [message, ...reports.map(r => `  ${r.id}: ${r.outcome} — ${r.detail}`)].join('\n');
    (code === 0 ? process.stdout : process.stderr).write(out + '\n');
    return code;
  };
  const attached = await attachForCli(a.workDir);
  if (!attached.ok) return say(2, attached.cause);
  const result = await closeFromCommits(a, attached.sessionId);
  return say(result.code, result.message, result.reports);
}

