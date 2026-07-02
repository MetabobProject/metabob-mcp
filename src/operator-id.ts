/**
 * operatorId — the identity of the operator agent driving the substrate through
 * this MCP surface. Threaded onto goal dispatches (run_goal / run_goal_async) and
 * folded into feedback labels so the substrate can attribute goals and verdicts to
 * a specific operator (the S1→S2→S3 arc treats Claude Code as an interposable
 * vessel/verifier — attribution is how that becomes legible).
 *
 * Override with MB_OPERATOR_ID; defaults to 'claude-code-operator'.
 */
export function operatorId(): string {
  return process.env.MB_OPERATOR_ID || 'claude-code-operator';
}
