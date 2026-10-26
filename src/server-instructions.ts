/**
 * The MCP `instructions` this server returns from `initialize`. MCP clients
 * place them in the agent's context at connect time, so they carry what an
 * agent needs before its first call and nothing that changes per session.
 * They name only tools this server lists (SPEC §tool-sets): the default set gets
 * its own text, about the shared ledger and memory, pointing at the `metabob`
 * skill; `METABOB_TOOLS=all` or a list gets the full text, pointing at
 * `metabob-substrate`, less any paragraph that names a tool the list leaves out.
 * tests/unit/tool-sets.test.ts and tests/workflows/w4-skill-contract.test.ts hold
 * that every tool named is listed. SPEC §agent-instructions
 */
import { parseToolAllowlist, toolSetKind } from './vessel-server.js';
import { TOOL_REGISTRY } from './tools/index.js';

/** For the default tool set: the shared task ledger and memory, and nothing else. */
export const DEFAULT_INSTRUCTIONS = `metabob: a shared task ledger and a shared memory for agents working on the same repository, across sessions, machines and clients.

Start of session: load the \`metabob\` skill before your first metabob call. It sequences the session: see where you are, take a task, record what you learn while you work, close what you finish, and leave a handoff for the next agent.

First calls, only when the skill is not available: \`get_analysis_context\` and \`get_problems\`; when your client defers tool schemas, load all eleven metabob tools in one tool search.

Ledger:
- \`get_problems\` lists the tasks with who holds them, the open problems, and what closed.
- \`claim_finding\` takes a task before you start, so no other agent starts it; renew it during long work, release it if you stop.
- \`record_finding\` records a problem you are not fixing, or a task for another agent: a problem mentioned only in your reply is lost to the next agent.
- \`mark_complete\` closes what you finished (\`endorse\`, after you commit) or what turned out not to be real (\`discard\`).

Memory:
- \`concept_search\` and \`concept_neighbors\` read the decisions, rejected approaches and handoffs earlier agents recorded.
- \`concept_create\` writes yours, and \`concept_link\` attaches it to what it is about, so the next agent can reach it.
- \`concept_record_usage\` credits a concept that helped (\`success\`) or marks one that misled you (\`failure\`).

When a call answers \`workspace_undetermined\`, call \`init_workspace { workspace_path: "<the project's absolute path>" }\` first.

When a call answers with a named cause such as \`key_rejected\` or \`anchor_unreachable\`, that is the connection's state, not a transient error; \`metabob-mcp attach --check\` diagnoses it.`;

/** For \`METABOB_TOOLS=all\` (and a list): every tool. */
export const FULL_INSTRUCTIONS = `metabob: a shared work ledger and code-structure tools for agents working on the same repository, attached to a substrate.

Before you edit files in a repository other agents or the substrate also work on: \`get_problems\` for those files, then \`path_activity\` on them, so you don't redo, race or undo work in flight. When you notice a problem you are not fixing, \`record_finding\` it: a bug mentioned only in your reply is lost to the next agent. After the edit, \`mark_complete\` for what you fixed.

Start of session: load the \`metabob-substrate\` skill before your first metabob call. It sequences the session and holds its rules: never grade your own work, close every finding you resolved.

First calls, only when the skill is not available: \`get_analysis_context\`, \`get_problems\`, \`record_finding\` and \`mark_complete\`; when your client defers tool schemas, load these four in one tool search.

Ledger:
- \`record_finding\` attributes an issue you noticed to code, so it outlives this session and other agents recall it.
- \`mark_complete\` closes a finding: \`endorse\` when fixed, \`discard\` when it is a false positive.

Goals on the substrate: \`run_goal_async\` → \`goal_status\` (read \`reached\`, not \`status\`) → \`goal_reasoning\` → \`provide_feedback\` with your verdict. \`execution_trace\` with no id lists your org's recent runs.

Before editing a file other agents or the substrate may be working on, \`path_activity\` shows what is in flight on it.

Local tools work in any repository with no substrate: \`init_workspace\`, \`analyze_impact\`, \`predict_cochanges\`, \`search_codebase\`.

Substrate tools need an attachment (an API key and a substrate endpoint). When one answers with a named cause such as \`key_rejected\`, \`anchor_unreachable\` or \`proxy_auth_required\`, that is the attachment's state, not a transient error; \`metabob-mcp attach --check\` diagnoses it.`;

/** Tool names a paragraph names in backticks. */
function toolsNamed(paragraph: string): string[] {
  return [...paragraph.matchAll(/`([a-z][a-z0-9_]*)/g)].map((m) => m[1]!).filter((n) => n in TOOL_REGISTRY);
}

/**
 * The instructions for the tool set `raw` (METABOB_TOOLS) names: only paragraphs (and list items) whose tools are all
 * listed.
 */
export function serverInstructions(raw: string | undefined = process.env['METABOB_TOOLS']): string {
  if (toolSetKind(raw) === 'default') return DEFAULT_INSTRUCTIONS;
  const listed = parseToolAllowlist(raw);
  const permitted = (name: string) => listed === null || listed.has(name);
  return FULL_INSTRUCTIONS.split('\n\n')
    .map((block) => block.split('\n').filter((line) => toolsNamed(line).every(permitted)).join('\n'))
    .filter((block) => block.trim() && !/^[^\n]*:\s*$/.test(block.trim()))
    .join('\n\n');
}
