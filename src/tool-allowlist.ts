// Contract (behaviour): SPEC §tool-sets
/**
 * Which tools this server lists (METABOB_TOOLS), as a module that imports no tool, so a tool's own output can ask
 * whether another tool is listed without an import cycle. src/vessel-server.ts re-exports it with the refusal text.
 */

// @anchor default-tool-set
/**
 * The tools a server lists when METABOB_TOOLS is unset: the shared task ledger and the shared memory, for agents
 * whose work spans executions (SPEC §tool-sets). `METABOB_TOOLS=all` lists every tool; a comma list, exactly those.
 * skills/metabob/SKILL.md's tool table and the user guide's list are held equal to this by
 * tests/unit/tool-sets.test.ts.
 */
export const DEFAULT_TOOL_SET: readonly string[] = [
  'get_analysis_context',
  'get_problems',
  'claim_finding',
  'record_finding',
  'mark_complete',
  'concept_search',
  'concept_neighbors',
  'concept_create',
  'concept_link',
  'concept_record_usage',
  'init_workspace',
];

/**
 * Parse METABOB_TOOLS (SPEC §tool-sets): unset or empty → the default set (DEFAULT_TOOL_SET); `all` → every tool
 * (`null`); a comma list → exactly those names.
 */
export function parseToolAllowlist(raw: string | undefined): ReadonlySet<string> | null {
  const trimmed = raw?.trim();
  if (trimmed?.toLowerCase() === 'all') return null;
  const names = (trimmed ?? '').split(',').map(n => n.trim()).filter(n => n.length > 0);
  return new Set(names.length > 0 ? names : DEFAULT_TOOL_SET);
}

/** Which grammar METABOB_TOOLS took: the default set, every tool, or a list the operator gave. */
export type ToolSetKind = 'default' | 'all' | 'list';
export function toolSetKind(raw: string | undefined = process.env['METABOB_TOOLS']): ToolSetKind {
  const trimmed = raw?.trim();
  if (trimmed?.toLowerCase() === 'all') return 'all';
  return (trimmed ?? '').split(',').some(n => n.trim().length > 0) ? 'list' : 'default';
}

let allowlistMemo: { value: ReadonlySet<string> | null } | null = null;

/**
 * The METABOB_TOOLS allowlist applies to EVERY plane this process serves, not
 * just stdio MCP: the loopback HTTP resolver dispatches through
 * resolveImpulseContent, so an allowlist enforced only in the MCP handlers is a
 * control on one of two doors. Memoised on first call — the env is frozen at
 * process start in production, but a memo (unlike a module const) is resettable,
 * and unassertable enforcement is exactly how this drifted for two releases.
 */
export function isToolPermitted(name: string): boolean {
  if (!allowlistMemo) allowlistMemo = { value: parseToolAllowlist(process.env['METABOB_TOOLS']) };
  return allowlistMemo.value === null || allowlistMemo.value.has(name);
}

/** True when not every tool is listed (the default set or a list) — for reporting, not enforcement. */
export function toolAllowlistActive(): boolean {
  if (!allowlistMemo) allowlistMemo = { value: parseToolAllowlist(process.env['METABOB_TOOLS']) };
  return allowlistMemo.value !== null;
}

export function __resetToolAllowlistForTests(): void {
  allowlistMemo = null;
}
