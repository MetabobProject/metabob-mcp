---
name: metabob
description: Coordinate work across agents and sessions using the Metabob MCP server as a shared work ledger — what is known-wrong here, who owns which files, what is already done. Use when more than one agent or more than one session touches a repository: record findings so they outlive you, recall briefs instead of copying them into every prompt, and close work so nobody is handed it twice. Also provides local structural analysis (impact, co-change) over any TS/JS/Python repo. Load at the START of a session where Metabob is connected.
---

# Metabob: a work ledger for a fleet of agents

**Use this when more than one agent, or more than one session, touches the
repository.** It keeps concurrent agents off each other's files, makes work
survive the process that did it, and stops an agent being handed something
already finished.

For questions about what the code *does*, read the code. `grep`, `git` and a file
reader are faster.

## Phase 0 — Orient (session start)

1. `get_analysis_context` — CPG stats, open problems, and a compact recall of
   what other agents recorded here.
2. `get_problems` — the work queue. Findings carrying a verdict appear in a
   trailing **closed** section tagged `[FIXED]`/`[RETRACTED]`; the open list is
   work that is genuinely still open.
3. Only when this session runs with `METABOB_AGENT_RESOLVER=1` (the
   agent-resolver role, off by default and set only where a human is at the
   terminal): `pull_assigned_work` — tasks the substrate dispatched to this
   vessel, including while you were away. Answer each with
   `submit_resolution { task_id, outcome, answer }`. Without the opt-in the
   substrate dispatches nothing here, so skip this step.

For the org's design memory, use `concept_search` with a **`shape` filter and no
`query`** — list-mode returns the full set for a shape.

## Phase 1 — Adopt the codebase

`init_workspace { workspace_path }`. **One call indexes the whole workspace** —
roughly 120 files in a second or two. Local tools work immediately after it.

```
Local index: 118/118 files parsed      <- the local CPG; impact and co-change use this
```

Indexing is local: no file content leaves the machine, and there is no
server-side analysis to wait for. Call again only if local parsing reports
`parse budget reached, call again to continue` on a very large repo.

## Phase 2 — Working cadence

**Before editing anything shared:** `analyze_impact { changed_files }`. It gives
transitive reach with depth and names the tests your change touches — the check
worth making before you edit a file other agents depend on.

`predict_cochanges { changed_files }` mines git history for files that move
together with yours. Read the **git-history** section; it catches the sibling
file you would otherwise forget.

**After adding files:** `init_workspace { recently_changed_files }` parses files
added since the last call (files already parsed are not re-read).

**When you notice something:** `record_finding { files, summary, severity,
category, details }` — immediately, not at close-out. Put the *scope* in
`details`: which files this work owns, what the test bar is, what is out of
bounds. That detail is what has value to the next agent; a bare summary is not
enough to act on.

## Phase 3 — The fleet pattern

The reason to use this surface. **Put the brief in the ledger; give agents only
an ID.**

1. Record one finding per unit of work. In `details`, state the files that unit
   **owns** and what is out of bounds.
2. Dispatch each agent with the finding id and a one-line title — not the scope,
   not the file list.
3. Each agent calls `get_problems`, recalls its own brief, and edits only what it
   owns.

Ownership stated in the brief is what keeps concurrent agents apart, so state it
explicitly and make it disjoint. The alternative — pasting every brief into every
prompt — couples all agents to an orchestrator that must stay alive, and the
boundary dies with the run.

## Phase 4 — Close out

1. `init_workspace { recently_changed_files: <final edits> }`.
2. `assign_git_changes { changed_files }` — if it names a file you did not touch,
   check it before committing.
3. `record_finding` for anything you noticed and did not fix.
4. `mark_complete` for **every** problem you resolved (endorse) or disproved
   (discard), including the `agf_*` findings you recorded. This is the only thing
   keeping the ledger true: skip it and work you finished is offered to the next
   agent as open. Pass the `concept_*` id when that is all you hold — with no
   local seed the verdict is written from the recalled concept itself, and the
   output says plainly that nothing local was retired. That is the fleet case the
   call exists for: one agent records, a second fixes. A verdict also retires
   every sibling seed of a multi-file finding, so one call closes the whole
   finding rather than one file of it.
5. `concept_create` for a decision worth keeping — why an approach was chosen,
   and what was rejected and why. Then `concept_link` it to the repo's anchor
   concept so a later session reaches it from the anchor.
   **A rejected approach is the highest-value thing you can record**: it leaves
   no trace in the code that survived, so nobody can find it by reading.

## Arbitrary (non-substrate) codebases

Everything above works on any TS/JS/Python repository. The inversion to remember:
**you are the actuator.** On an arbitrary repo you make the edits yourself and
Metabob is your memory and your coordination. The learning still synchronises
org-wide.

On first adoption, `concept_search` for an anchor concept named after the repo;
if absent, `concept_create { content: "<repo name>: <one-line purpose, root path,
primary language>", shape: "repo_anchor" }`, then link session learnings to it.

## Budget

- Phase 0 and the pre-edit `analyze_impact` are cheap and prevent expensive
  mistakes.
- `init_workspace` is one call, not a loop. Do not drain it serially.
- Recording a finding costs one call and is the only thing that survives you.
  Recording nothing is how a session's work is lost at the boundary.
