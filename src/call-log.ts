// Contract (behaviour): SPEC §call-log
/**
 * The opt-in call log: with METABOB_CALL_LOG=<path>, one JSON line per tool call is appended to that file on this
 * machine, so the order of an agent's metabob calls can be scored for any harness, with or without hooks or a
 * transcript (the cell lab's scorer reads it). A line holds when, the session, the tool, each argument's name and
 * size, never its value (the same description as the tool-call log line, src/outgoing-guard.ts@describeArgsForLog),
 * the outcome and the duration. Nothing is sent anywhere. The file is created mode 0600. Writing it never fails a
 * call. CLAUDE §environment-variables
 */
import { appendFileSync } from 'node:fs';
import { describeArgsForLog } from './outgoing-guard.js';

export type CallOutcome = 'ok' | 'refused' | 'not_attached' | 'error';

export function logCall(
  entry: { session: string; tool: string; args: unknown; outcome: CallOutcome; ms: number; via?: 'stdio' | 'loopback' },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = env.METABOB_CALL_LOG?.trim();
  if (!path) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), session: entry.session, via: entry.via ?? 'stdio', tool: entry.tool, args: describeArgsForLog(entry.args), outcome: entry.outcome, ms: entry.ms });
    appendFileSync(path, line + '\n', { mode: 0o600 });
  } catch {
    // A log the agent's process cannot write is the lab's problem, never the call's.
  }
}
