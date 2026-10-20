/**
 * The MCP `instructions` this server returns from `initialize`. MCP clients
 * place them in the agent's context at connect time, so they carry what an
 * agent needs before its first call and nothing that changes per session.
 * Every tool named here exists in the registry — tests/workflows/w4-skill-contract.test.ts
 * holds that. SPEC §agent-instructions
 */
export const SERVER_INSTRUCTIONS = `metabob: a shared work ledger and code-structure tools for agents working on the same repository, attached to a substrate.

Start of session: load the \`metabob\` skill before your first metabob call. It sequences the session and holds its rules: run probes as observers, never grade your own work, close every finding you resolved.

First calls, only when the skill is not available: \`get_analysis_context\`, \`get_problems\`, \`record_finding\` and \`mark_complete\`; when your client defers tool schemas, load these four in one tool search.

Ledger:
- \`record_finding\` attributes an issue you noticed to code, so it outlives this session and other agents recall it.
- \`mark_complete\` closes a finding: \`endorse\` when fixed, \`discard\` when it is a false positive.

Goals on the substrate: \`run_goal_async\` → \`goal_status\` (read \`reached\`, not \`status\`) → \`goal_reasoning\` → \`provide_feedback\` with your verdict. \`execution_trace\` with no id lists the substrate's recent runs.

Local tools work in any repository with no substrate: \`init_workspace\`, \`analyze_impact\`, \`predict_cochanges\`, \`search_codebase\`.

Substrate tools need an attachment (an API key and a substrate endpoint). When one answers with a named cause such as \`key_rejected\`, \`anchor_unreachable\` or \`proxy_auth_required\`, that is the attachment's state, not a transient error; \`metabob-mcp attach --check\` diagnoses it.`;
