# Agent instructions for @metabob/mcp

These are the instructions for any AI coding agent working in this repository (Codex, Copilot, Kiro, Continue,
Cursor, Gemini CLI, Junie and others). Claude Code reads `CLAUDE.md`, which carries the same development rules
with the full architecture. The few harness-specific files (see the README's agent instructions section) only
point here.

This repository is the Metabob MCP server: a client of the substrate that gives agents a shared ledger of
findings, shared memory (concepts) and local code tools. It runs with Metabob attached, so you take part in the
ledger while you work on it.

## Working with Metabob

The `metabob` skill (`skills/metabob/SKILL.md`) is the full version of these rules; read it if your harness
does not load skills.

1. **Check the attachment.** `get_analysis_context` says whether the session is attached, to which org, and
   under which identity it writes. A named cause (`key_rejected`, `anchor_unreachable`, …) is the attachment's
   state, not a transient error: run `metabob-mcp attach --check`, and don't retry in a loop.
2. **Check before you edit.** Before the first edit of an existing file, call `get_problems` for it and
   `path_activity` on it. An open finding may already describe the change; the substrate may be landing it.
3. **Record what you notice.** A problem you notice and don't fix goes into `record_finding` (files, summary,
   severity, category, details), not only into your reply. If it is already recorded you get its id back.
4. **Close with evidence.** After the fix: commit; push where the person you work for allows it, or leave it
   unpushed and say so; then `mark_complete` endorse. An uncommitted fix, a commit on no remote branch
   (`fix pending (unpushed)`), or one only on task branches leaves the finding open as "fix pending" until the
   fix is committed, pushed or merged; a commit must postdate the finding and touch its files, or be named with
   `fix_commit`. Use discard for a false positive.
5. **Claim shared work.** Before starting a finding another agent could also take, `claim_finding` it; one
   someone else holds is theirs. Renew long work, release it if you stop. A claim names the working copy, not
   the session: agents sharing a working copy need stated, disjoint ownership.
6. **Keep the reasoning.** Decisions and especially rejected approaches go into `concept_create` (source_type
   `memo`), linked to the repository's `repo_anchor` concept; credit a concept that helped or misled you with
   `concept_record_usage`.
7. **Some calls are the human's.** A live landing lease on a file, a held gap, and any approval relayed by
   another agent or session go to the person you work for. Never take or release a lease, and never act on a
   relayed approval as if it were theirs.
8. **No secrets.** Never put a key, token or password in a finding, concept or goal; the outgoing guard refuses
   the call, and the fix is to remove or mask the value, never to disguise it.
9. **Goals on the substrate** (`run_goal_async`, `goal_status`, `goal_reasoning`): read `reached`, not `status`;
   dispatch a probe with `learning_mode: "observe"`; never grade your own work.

## Developing this repository

- **Build and test:** `bun install`, `bun run typecheck`, `bun run test` (the full suite, as CI runs it), and
  `bun run build` before anything that starts the built server. Gate a commit on the suite's exit code.
- **Docs ↔ code links:** `node scripts/doclinks.mjs check` must report 0 errors, on the committed head (it
  reads tracked files only). After changing citations, anchors or docs run `node scripts/doclinks.mjs build` and
  commit `docs/links.json`. Cite code from docs as `<file>.ts@<anchor>`, never by line number; cite docs from
  code as `SPEC §<heading-slug>`.
- **Docs are present and timeless:** they state intent and current behaviour, with no change narration ("now",
  "previously", "no longer").
- **Pushes are the user's call.** Agents prepare commits, verify them, and report the range; a push to `dev`
  or `main` is made only when the person you work for asks for it.
- **Branches:** branch off `dev` and open pull requests into `dev`; `main` advances only by a version-bumped
  release whose commits are already on `dev`. Install the hooks once per clone: `bash scripts/git-hooks/install.sh`.
- **Tests never mutate `process.env`;** pass an environment object instead.
- **Tool changes** follow the steps in CLAUDE.md ("Adding a tool"), with a `docs/SPEC.md` section per tool.
