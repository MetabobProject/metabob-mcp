// Contract (behaviour): SPEC §call-log
/**
 * The opt-in call log: with METABOB_CALL_LOG=<path>, one JSON line per tool call is appended to that file on this
 * machine, so the order of an agent's metabob calls can be scored for any harness, with or without hooks or a
 * transcript (the cell lab's scorer reads it). A line holds when, the session, the tool, each argument's name and
 * size, never its value (the same description as the tool-call log line, src/outgoing-guard.ts@describeArgsForLog),
 * the outcome and the duration. Nothing is sent anywhere. The file is created mode 0600. Writing it never fails a
 * call. CLAUDE §environment-variables
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync } from 'node:fs';
import { describeArgsForLog } from './outgoing-guard.js';

export type CallOutcome = 'ok' | 'refused' | 'not_attached' | 'error';

/**
 * What a tool's own answer was, beyond the call returning: a claim that `lost`, a verdict left `pending`, a write
 * `not_applied` or `not_shared`. `outcome` says whether the call ran; `result` says what it did. A tool that reports
 * nothing logs no `result`.
 */
const results = new AsyncLocalStorage<{ result?: string }>();

/** Run a tool call so that what it reports (reportResult) can be read back for its log line. */
export async function withResult<T>(fn: () => Promise<T>): Promise<{ value: T; result?: string }> {
  const box: { result?: string } = {};
  const value = await results.run(box, fn);
  return { value, result: box.result };
}

/** A tool's own result kind, for the call log; a no-op outside withResult. */
export function reportResult(kind: string): void {
  const box = results.getStore();
  if (box) box.result = kind;
}

export function logCall(
  entry: { session: string; tool: string; args: unknown; outcome: CallOutcome; ms: number; via?: 'stdio' | 'loopback'; result?: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = env.METABOB_CALL_LOG?.trim();
  if (!path) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), session: entry.session, via: entry.via ?? 'stdio', tool: entry.tool, args: describeArgsForLog(entry.args), outcome: entry.outcome, ...(entry.result ? { result: entry.result } : {}), ms: entry.ms });
    appendFileSync(path, line + '\n', { mode: 0o600 });
  } catch {
    // A log the agent's process cannot write is the lab's problem, never the call's.
  }
}
