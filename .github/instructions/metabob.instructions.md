---
applyTo: "**/*.{ts,tsx,js,jsx,mjs,cjs,md}"
---

# Metabob MCP workflow

- When a task involves understanding the codebase, reviewing detected issues, scoping related files, or assessing change impact, prefer the attached Metabob MCP server before doing broad manual search.
- Start by calling `init_workspace` with the repo root as `workspace_path`. Include the files already changed or under discussion in `recently_changed_files` so sync prioritization and co-change ranking are relevant.
- Immediately follow with `get_analysis_context` to capture index status, open problems, and recent co-change hints.
- Use `get_problems` for severity-ranked findings. Focus first on `CRITICAL` and `HIGH` problems when deciding what to fix.
- Use `predict_cochanges` before editing to identify likely companion files, and `analyze_impact` when you need dependency or dependent reach from a proposed change.
- If `init_workspace` reports unsynced files remaining, treat the result as incremental progress rather than failure. Repeat it as needed while you work.
- If analysis is still `pending` or `running`, continue with local-tier Metabob tools and ordinary code inspection instead of waiting idly.
- Use `annotate_component` with `mode="recommend"` when you want a concrete fix direction for a problem ID.
- After implementing and validating a fix for a Metabob finding, use `mark_complete` to endorse it. Use `discard` only for confirmed false positives.
- Keep Metabob guidance additive: use it to narrow search, select files, and prioritize fixes, then make changes using the repository's normal TypeScript and test workflows.
