# Copilot instructions for @metabob/mcp

- This repository builds an MCP server that exposes Metabob analysis to AI agents over stdio and an HTTP resolver.
- Prefer Metabob MCP tools for code analysis tasks in this repository when the server is available, especially for workspace initialization, problem triage, co-change prediction, impact analysis, and analysis context snapshots.
- Metabob analysis is asynchronous. After `init_workspace`, treat `pending` and `running` analysis states as normal and continue with follow-up Metabob calls instead of blocking.
- Use `init_workspace` early when investigating code changes. Pass the repository root as `workspace_path` and include the currently changed files in `recently_changed_files` when possible.
- For triage, prefer this sequence: `init_workspace` -> `get_analysis_context` -> `get_problems` -> `predict_cochanges` or `analyze_impact`.
- Use local-tier Metabob tools (`predict_cochanges`, `analyze_impact`) after initialization even if remote analysis is still in progress.
- Use `annotate_component` when you need fix guidance for a specific problem ID and `mark_complete` after a verified fix or confirmed false positive.
- Follow the repository build and validation flow from `CLAUDE.md`: `bun run typecheck`, `bun test`, and `bun run build`.
