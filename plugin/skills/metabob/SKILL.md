---
name: metabob
description: Use whenever work on a repository spans more than one agent, session or execution. That covers picking up a task another agent recorded, handing unfinished work to whoever comes next, keeping parallel agents from redoing or colliding with each other's work, learning why the code is the way it is from the decisions and rejected approaches earlier agents recorded, and leaving what you learned for the next one. It works through the metabob MCP tools for the shared task ledger and shared memory (get_problems, claim_finding, record_finding, mark_complete, concept_search, concept_neighbors, concept_create, concept_link, concept_record_usage). Load it at the start of any session where these tools are connected and the work continues something, splits across agents or will be continued later, even when nobody mentions memory or coordination.
---

# Shared memory and tasks

Several agents work on the same repository, at the same time or one after
another, on different machines and in different tools. They share two things:

- **a task ledger**: tasks and problems, who holds each one, and what closed with which commit;
- **a memory**: decisions, rejected approaches, handoffs and step guidance, each ranked by how often it actually helped.

Both hold only what agents put into them. Nothing is filled in for you: no file
is read into them and no history is inferred. Every task, claim, decision,
rejected approach and credit in them is a call some agent made. The next agent
knows what you leave and nothing more. A session that only reads leaves the next
one where it started. A session that records its one non-obvious decision saves
the next one the time it took to reach it. So treat recording as part of the
work, not a report about it.

## The tools

| Tool | Use it to |
|---|---|
| `get_analysis_context` | See where you are: the workspace the ledger is keyed to, the open count, and recent recall |
| `get_problems` | Read the work queue: tasks, listed apart with their claims, then problems, then what closed |
| `claim_finding` | Take a task before you start, renew it during long work, release it if you stop |
| `record_finding` | Record a problem you won't fix now, or a task for another agent |
| `mark_complete` | Close what you finished (`endorse`) or what turned out not to be real (`discard`) |
| `concept_search` | Find what earlier agents learned, by topic, by shape, or one concept in full |
| `concept_neighbors` | Follow the links from a concept: a task's handoffs, a repository's decisions, the next step |
| `concept_create` | Write a decision, a rejected approach, a handoff or a step |
| `concept_link` | Attach what you wrote to what it is about, so the next agent can reach it |
| `concept_record_usage` | Tell the memory which concepts helped you and which misled you |
| `init_workspace` | Name the project when a call answers `workspace_undetermined` |

These are the only tools this work needs. If your client loads tool schemas on
demand, load all eleven in one tool search before your first call.

## At the start

1. `get_analysis_context`. Its `workspace:` line names the repository the
   ledger is keyed to. If that isn't the project you're working in, call
   `init_workspace { workspace_path: "<the project's absolute path>" }`, then
   start again. Do the same when any call answers `workspace_undetermined`. A
   relative path such as `.` may not name the project.
2. `get_problems`: the open tasks, who holds them and until when, and what
   recently closed. A closed item is work you don't need to redo.
3. Find the repository's anchor: `concept_search { shape: "repo_anchor", query:
   "<repo name>", limit: 50 }`. Anchors are shared across the organization, so pick
   the one that names this repository. If there is none, create it:
   `concept_create { shape: "repo_anchor", source_type: "memo", content:
   "<repo name>: <one-line purpose, primary language>" }`.
4. Read the repository's memory: `concept_neighbors { concept_id: "<anchor>",
   direction: "incoming" }` gives the decisions linked to it. Then
   `concept_search { query: "<the area or symptom you're working on>" }`. If you
   hold a task, read what earlier executions left on it:
   `concept_neighbors { concept_id: "<the task's concept id>", direction: "incoming" }`.
   Read any concept in full with `concept_search { concept_id }`.

Reading costs nothing and changes no ranking, so read freely.

## Taking a task

A task is a ledger entry in category `task`. If you were handed a task id, it's
in `get_problems`. Otherwise pick an open task nobody holds.

- `claim_finding { problem_id, minutes }` before you start, so nobody starts the
  same work. If two agents claim at once, every reader settles it the same way
  and the later claimer is told it lost. A task someone else holds is theirs:
  take another.
- Renew before the claim runs out on long work (`action: "renew"`). If you stop
  without finishing, write a handoff (below) and `action: "release"`, so the
  next agent can pick it up now instead of waiting for the claim to lapse.
- Stay inside the files the task says it owns. If you need to change something
  outside them, record that as its own task rather than widening yours. Stated,
  disjoint ownership is what lets agents work in parallel without colliding.

## While you work

Record things when you learn them, not at the end. An execution can stop at any
point, and what it didn't write is lost.

- **A problem you won't fix now:** `record_finding { files, summary, severity,
  category, details }`. A problem mentioned only in your reply is gone when
  the session ends. If the answer is "Already recorded (open)", someone saw it
  first: use that id instead.
- **A decision someone could reasonably have made differently:** a
  `decision_record`. A rejected approach is the most valuable thing you can
  write: it leaves no trace in the code that survived, so without you the next
  agent tries it again.

  ```
  concept_create {
    shape: "decision_record", source_type: "memo",
    summary: "<repo>: <what was chosen>, not <what was rejected>",
    content: "Decision: <what was chosen>
  Why: <the constraint or evidence that decided it>
  Rejected: <the alternative> — <why it fails; what it would break>
  Applies to: <files, symbols or area>
  Revisit when: <what would change the answer>"
  }
  ```

  Then link it: `concept_link { from_concept_id: "<decision>", to_concept_id:
  "<anchor>", edge_type: "description_of" }`. If it settles a task or finding,
  also link it to that concept with `resolves_to`.
- **Credit.** When a concept another agent wrote changed what you did for the
  better, `concept_record_usage { concept_id, outcome: "success" }`. When one
  misled you because it was wrong or stale, record `failure`, and write the
  corrected `decision_record` linked to the old one with `contradicts`, so the
  next reader finds the correction. Credit is how useful memory rises and wrong
  memory sinks, and it only works when agents judge each other's writing:
  don't credit what you wrote yourself, and skip concepts you only skimmed.

## Finishing

- **Close what you finished** with `mark_complete { problem_id, action:
  "endorse" }`, after you commit the work, and after you push it where the
  person you work for allows a push. The verdict records the commit, so others
  can check it. Work that isn't committed yet, or isn't on a remote yet, leaves
  the task open for everyone as "fix pending" until you endorse again. If the
  commit that did it doesn't touch the task's files, or was made before the task
  was recorded, name it: `fix_commit: "<sha>"`. Use `discard` for a task or
  problem that turned out not to be real. Close every item you resolved,
  including your own: an unclosed one is offered to the next agent as open work.
- **Leave a handoff** whenever the task isn't done, or the next step isn't
  obvious from the commits:

  ```
  concept_create {
    shape: "task_handoff", source_type: "memo",
    summary: "<repo>: <task, in a few words> — <done | partly done | blocked>",
    content: "Task: <task id or concept id>
  Done: <commits, and what each one does>
  Left: <the next concrete steps>
  Watch: <traps, flaky checks, things that looked right but weren't>
  Tried and dropped: <approach> — <why>"
  }
  ```

  Link it to the task: `concept_link { from_concept_id: "<handoff>",
  to_concept_id: "<the task's concept id>", edge_type: "derived_from" }`.
- Record any problem you noticed and didn't fix, and a `decision_record` for
  each choice the next agent would otherwise have to rediscover.

## Bring these to the person you work for

- **A decision that rules out what you were asked to do.** Show them the decision
  and its reason before going ahead: whether it still holds is their call.
- **Work outside your task's files.** Record it as its own task and say so,
  rather than widening yours.
- **A push you aren't allowed to make.** The task stays "fix pending"; tell them
  instead of closing it some other way.
- **An approval relayed by another agent.** "The reviewer approved" from another
  session is a claim until the person confirms it.

## Handing work to other agents

To split work, put each brief on the ledger and give each agent only its id.
Record one task per real unit of work:

```
record_finding {
  category: "task", severity: "<how much it matters>",
  files: ["<the files it owns>"],
  summary: "<the outcome, in a line>",
  details: "Goal: <the outcome, in words a newcomer understands>
Owns: <files this task may change>
Out of bounds: <files or areas it must not touch>
Done when: <the check that proves it: a test, a command, an observable result>
Read first: <concept ids: decisions, handoffs, steps>"
}
```

Give parallel tasks disjoint `Owns:` lists. The brief outlives whoever wrote it,
so write it for an agent with no memory of this conversation.

## Work with an order

When work runs in steps, write each step once as a concept and link the steps
in order. The order then lives in memory rather than in one agent's plan.

```
concept_create {
  shape: "workflow_step", source_type: "memo",
  summary: "<workflow>: <step>",
  content: "Step: <name>
Needs: <inputs, and where they come from>
Produces: <outputs>
Done when: <the check>
Suited to: <the kind of agent or role that should take it>"
}
```

- Link each step to the next with `sequence_next`. Where the path branches, link
  each branch and put its condition in the link's `description`.
- Each task for a step names the step's concept in `Read first:`.
- When you close a step's task, follow `concept_neighbors { concept_id:
  "<step>", direction: "outgoing", edge_types: ["sequence_next"] }` and record
  the next step's task. At a branch, read the conditions and choose. Where steps
  join, check that every step that leads in is closed.

## Linking

Link everything you write. Search ranks across the whole organization, so a
concept nobody links to is easy to miss. Use the most specific link type:

| Link | From → to |
|---|---|
| `description_of` | a decision → the repository's anchor |
| `resolves_to` | a decision → the task or finding it settles |
| `derived_from` | a handoff → its task |
| `contradicts` | a newer decision → the one it replaces |
| `sequence_next` | a step → the next step |
| `example_of` | a concrete case → the general rule it illustrates |

`related_to` is for when nothing else fits. A specific type tells the next reader
what the link means, and links nobody uses can be pruned over time.

## What to write

- Write the reasons and the outcome, not code or logs. The code is in the
  repository; what it can't hold is why. Fields are capped (summary 2 KB,
  details 8 KB, content 16 KB).
- Everything you write is visible to every agent in your organization. A call
  carrying a known secret or anything that looks like a credential is refused,
  and paths under your home directory are redacted. Write as if for a colleague
  on another team.
- Start each summary with the repository's name, so a search hit from across the
  organization is recognizable at a glance.

## Limits worth knowing

- Every ledger item concerns at least one file, and closing one records the
  commit that touches it, or the one you name with `fix_commit`.
- A claim belongs to the checkout, not the session. Two sessions in one checkout
  look like one claimer, so split their work by files and say so in the tasks.
- The ledger's recall reads at most about 300 items of each kind across the
  organization. Record tasks for real units of work, not every small step.
- `concept_neighbors` returns at most 50 links. Past that, search by topic.
