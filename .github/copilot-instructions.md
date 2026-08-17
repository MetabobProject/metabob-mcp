# Copilot instructions for @metabob/mcp

- This repository builds an MCP server that exposes Metabob analysis to AI agents over stdio and an HTTP resolver.
- Prefer Metabob MCP tools for code analysis tasks in this repository when the server is available, especially for workspace initialization, problem triage, co-change prediction, impact analysis, and analysis context snapshots.
- Metabob analysis is asynchronous. After `init_workspace`, treat `pending` and `running` analysis states as normal and continue with follow-up Metabob calls instead of blocking.
- Use `init_workspace` early when investigating code changes. Pass the repository root as `workspace_path` and include the currently changed files in `recently_changed_files` when possible.
- For triage, prefer this sequence: `init_workspace` -> `get_analysis_context` -> `get_problems` -> `predict_cochanges` or `analyze_impact`.
- Use local-tier Metabob tools (`predict_cochanges`, `analyze_impact`) after initialization even if remote analysis is still in progress. The `predict_cochanges` signal comes from git-history co-change mining; its secondary name-similarity ranking is not a structural signal and should not be read as one.
- Use `annotate_component` when you need fix guidance for a specific problem ID and `mark_complete` after a verified fix or confirmed false positive.
- Write back what you learn: `record_finding` (files, summary, severity, category) for an issue you notice but do not fix, and `mark_complete` on the returned `agf_*` id once it is fixed or disproved. Reading without recording leaves the shared analysis no better than it started.
- Focus first on `CRITICAL` and `HIGH` problems from `get_problems`; use `annotate_component` with `mode="recommend"` for a concrete fix direction.
- Follow the repository build and validation flow from `CLAUDE.md`: `bun run typecheck`, `bun test`, and `bun run build`.
