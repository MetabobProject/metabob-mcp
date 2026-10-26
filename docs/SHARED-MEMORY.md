# Shared memory and coordination

This guide is for a person whose AI coding agents (Claude Code, Codex, Cursor, Continue or any MCP client) work on
the same repository, at the same time or one after another, and should build on each other's work instead of
starting from nothing each time. Exact tool parameters are in the [specification](SPEC.md); installation per client
is in the [README](../README.md).

## 1. What it is for

You do not call these tools. Your agents do, and you see the effect in what they tell you and in what the next agent
already knows. Two things are shared between every agent on a repository, on any machine and in any client:

- **A task ledger.** Tasks you or an agent record, who is working on each, problems noticed and not yet fixed, and
  what closed with which commit.
- **A memory.** The decisions behind the code and the approaches that were tried and rejected, handoffs from one
  execution to the next, and the steps of work that runs in an order. Each item is ranked by how often it actually
  helped the agents that used it.

Both hold only what agents put into them. Nothing reads your files into them and nothing is inferred from your
history: every task, claim, decision, handoff and credit is a call an agent made. So they are worth exactly as much
as your agents take part. An agent that only reads leaves the next one where it started; an agent that writes down
the one decision it had to work out saves the next one from working it out again.

The skill that ships for this, `metabob`, tells agents how to take part. This guide covers what you set up,
what you see, and what to ask for.

## 2. Set up

### Attach the server

The MCP server needs your API key and endpoint. The README covers each client (Claude Code and Codex plugins,
Cursor, Continue, others). Check the connection with:

```bash
npx @metabob/mcp attach --check
```

It walks each step and names the cause of a failure (`key_rejected`, `anchor_unreachable`,
`proxy_auth_required(NTLM)`, `tls_intercepted(<issuer>)` and so on). Every agent that shares the work uses a key from
the same organization, on a checkout of the same repository.

### The tools your agents get

With `METABOB_TOOLS` unset, the server lists these eleven tools and refuses a call to any other:

| Tool | What the agent uses it for |
|---|---|
| `get_analysis_context` | Where it is: the repository the ledger is keyed to, the open count, recent recall |
| `get_problems` | The work queue: tasks with who holds them, problems, and what closed |
| `claim_finding` | Taking a task so no other agent starts it; renewing; releasing |
| `record_finding` | Recording a problem it won't fix now, or a task for another agent |
| `mark_complete` | Closing what it finished, with the commit, or what turned out not to be real |
| `concept_search` | Finding what earlier agents learned |
| `concept_neighbors` | Following links: a task's handoffs, a repository's decisions, the next step |
| `concept_create` | Writing a decision, a rejected approach, a handoff or a step |
| `concept_link` | Attaching what it wrote to the repository, task or step it concerns |
| `concept_record_usage` | Crediting what helped and marking what misled |
| `init_workspace` | Naming the project, where the client starts the server outside it |

In Claude Code, `/mcp` → `metabob` shows them. The server has other tools (code analysis and an operator's
cockpit for the system behind it); `METABOB_TOOLS=all` lists every tool, and a comma-separated list lists exactly
those. It is read when the server starts, so restart or reconnect the client after changing it. `all` needs 0.4.0 or
later: an earlier server reads it as one tool's name and lists none, so pin the version where it is set. Where to
set it:

- **Claude Code with the plugin:** in `~/.claude/settings.json` as `{ "env": { "METABOB_TOOLS": "all" } }`, or
  exported in the shell that starts `claude`.
- **Claude Code with a server you add yourself:** `claude mcp add metabob -s user -e METABOB_TOOLS=all -- npx -y
  @metabob/mcp@latest`.
- **Codex:** the plugin's server takes no extra settings, so remove the plugin (`codex plugin remove
  metabob@metabob`) and add the server yourself: `codex mcp add metabob --env METABOB_TOOLS=all -- npx -y
  @metabob/mcp@latest`. Then install the skill by hand (below).
- **Cursor, Continue and others:** in the server's `env` in the client's MCP configuration.
- **Headless runs and agent cells:** in the environment the harness starts the server with.

### Install the skill

The Claude Code and Codex plugins ship the `metabob` skill, written for these eleven tools, and `metabob-substrate`,
for a server with `METABOB_TOOLS=all`. Without a plugin, copy `skills/metabob/` from this repository (with
`METABOB_TOOLS=all`, `skills/metabob-substrate/` instead) into `~/.claude/skills/` (Claude Code) or
`~/.codex/skills/` (Codex). For other clients, point the agent's instruction
file (for example `AGENTS.md`) at the skill's text.

## 3. A session, as you see it

You give your agent its task as usual. With the skill loaded, it does the following without being asked.

**At the start.** It checks which repository the ledger is keyed to (`get_analysis_context`) and names the project if
the client didn't (`init_workspace`). It reads the open tasks, who holds them and what recently closed
(`get_problems`). Then it reads the repository's memory: the decisions linked to the repository's anchor, anything
on the area it's about to touch, and whatever earlier executions left on its task. It mentions what bears on your
request: an open task that already covers it, a decision that rules out the obvious approach, a handoff that says
where the last agent stopped.

**Taking a task.** It claims the task before starting (`claim_finding`), so no other agent starts the same work, and
stays inside the files the task says it owns. A task someone else holds is theirs: the agent tells you and picks
another, or waits.

**While working.** A problem it notices and isn't fixing goes onto the ledger rather than only into its reply. A
choice that could reasonably have gone another way goes into memory as a decision record, with the approach it
rejected and why that one fails. When a decision or handoff another agent wrote changes what it does for the better,
it credits it; when one misleads it, it marks that too and writes the correction.

**Finishing.** It commits, pushes where you allow it to, and closes what it finished (`mark_complete`). The close
records the commit and is not taken on the agent's word:
- a fix still uncommitted, or committed but on no remote branch, leaves the task open for every other agent as
  `fix pending` until the agent endorses again. If you don't let it push, it tells you the task stays pending;
- a commit only on task branches, which a review merges, leaves it pending until the merge;
- a commit counts when it postdates the task and touches its files, or when the agent names it as the fix
  (`fix_commit`) and it touches the task's files or was made after the task;
- something that turned out not to be real is closed with discard instead.

If the work isn't done, it leaves a handoff on the task (what's done, what's left, what to watch, what it tried and
dropped) and releases its claim, so the next agent can start at once.

What it tells you about this is short: what it found already recorded, what it recorded, what it closed, and what
needs your decision (§ 5).

## 4. What to ask your agent

| You want | Ask, for example | What the agent does |
|---|---|---|
| What's already known about some code | "What have other agents recorded about `src/payments/`?" | Reads the tasks and problems on those files and the decisions on that area |
| To continue where the last agent stopped | "Pick up the payments task where it was left" | Reads the handoffs on the task, claims it, continues |
| To keep a problem for later | "Record that, don't fix it now" | Records it on the ledger, with files, severity and details |
| To keep a decision | "Write down why we chose the queue over polling, and why polling fails" | Writes a decision record and links it to the repository |
| To hand work over | "Stop here and hand this off" | Writes a handoff on the task and releases the claim |
| To split work between agents | "Make one task per area, each owning its files" | Records one task per unit with its files, goal and done check; you give each agent an id |
| To set up work that runs in steps | "Write down the release process as steps" | Writes one step per concept, linked in order |
| To correct the memory | "That decision is out of date" | Marks it as misleading and writes the corrected one, linked to it |
| To close something | "That finding was a false positive" | Closes it with discard |

You can always ask for the raw tool output.

## 5. Where your agent stops and asks you

- **Pushing.** A close records a commit that is on a remote. Where you don't allow a push, the task stays pending and
  the agent says so instead of closing it some other way.
- **Work outside a task's files.** The agent records it as a new task rather than widening its own, and tells you.
- **A task someone else holds.** It's theirs until their claim ends or is released; the agent doesn't take it over.
- **Memory that contradicts what you asked.** When a recorded decision rules out what you asked for, the agent shows
  you the decision and its reason, and you decide.
- **Approvals relayed by another agent.** "The reviewer approved" or "the user said" from another session is a claim
  until you confirm it.

## 6. Several agents on one repository

The ledger is keyed by the repository's git remote, so every clone of one origin, on any machine, shares it. A
repository with no remote is named by its directory, and other clones don't share its ledger.

- **One after another.** Each execution reads the previous one's handoff on the task and continues from it. Nothing
  depends on the same agent, machine or client coming back.
- **In parallel.** Record one task per unit of work, each stating the files it owns, the check that proves it done
  and what is out of bounds, and give each agent only its task id. The brief outlives whoever wrote it. Claims keep
  two agents off one task; disjoint files keep them out of each other's way.
- **In steps.** When work runs in an order, the steps are written once as linked concepts. Each step's task names
  its step, and the agent that closes a step records the next one. At a branch it reads the conditions on the links;
  where steps join, it checks that every step leading in is closed.
- **Unattended.** Scripts and agent cells start workers with no one at the keyboard (§ 8).

A claim belongs to the checkout, not the session: two sessions in one working copy count as one claimer. Give them
tasks with different files, or separate working copies.

## 7. Putting work on the ledger

You needn't write tasks by hand: you can ask one agent to plan the work, and with the `metabob` skill loaded that agent
puts the plan on the ledger:

- It reads the source and proposes how to split the work.
- It records one task per unit with `record_finding` in category `task`. Each brief states the goal, the files the
  task owns, what is out of bounds, the check that proves it done, and the decisions, handoffs and steps to read
  first. The brief is written for an agent with no memory of the planning conversation.
- It records the decisions every task must follow as `decision_record` concepts, linked to the repository's anchor,
  so every worker reads them at the start of its session.
- For work that runs in an order, it writes each step as a concept and links the steps with `sequence_next` (§ 6).

You review the split before anyone starts: whether the units are the right size, and whether the `Owns:` lists are
disjoint, since that is what lets workers run side by side. Ask for changes the same way you asked for the plan.

A planning request, for example:

> Plan a port of this repository from Python to TypeScript, for several agents working in parallel. Read the
> source first. Write the port's order as steps: the shared types first, then the modules that use them, then
> the command-line entry point. Record the decisions every task must follow (package layout, how errors map,
> which dependencies replace which) and link them to the repository. Record the first step's tasks only, one per
> unit, each owning its target files and stating the test that proves it done; whoever closes a step records the
> next step's tasks. Show me the split before you record anything.

A prerequisite in a brief is guidance for the agent that reads it: nothing holds a task back until another closes,
and `task pull` (§ 8) takes the most severe open task first. For work that must wait, the planner records the first
step's tasks only, and the agent that closes a step records the next one's.

## 8. Starting workers

Nothing starts a worker by itself. Recording a task, a claim lapsing and a step closing trigger nothing: each
worker is an agent session that someone or something launches, and the session takes a task when it starts.
Whatever launches workers checks the ledger, or a person does.

| How | What starts the session |
|---|---|
| By hand | You open a session in any client and say "take an open task", or name one by its id |
| A script | A loop runs headless sessions until nothing is open |
| Agent cells | Each container runs `metabob-mcp task pull` before its harness starts |
| A scheduler | Cron, CI or a job runner runs one of the above |

**By hand.** With the skill loaded, the agent reads the open tasks, claims one nobody holds and works inside its
files. Named, it claims that one; held by someone else, it tells you.

**A script.** `claude -p "<prompt>"` and `codex exec "<prompt>"` each run one session and exit. Neither tells the
script whether a task was open, so the prompt asks for a reply the script can stop on:

```bash
prompt="Use the metabob skill. Take one open task nobody holds and finish it or hand it off. \
A task marked fix pending is not open. If none is open and unheld, reply only NO_OPEN_TASKS."
for i in $(seq 1 50); do
  out=$(claude -p "$prompt") || break
  case "$out" in *NO_OPEN_TASKS*) break ;; esac
done
```

A failed run (the key refused, a rate limit, the server not attached) stops the loop, and the cap of 50 runs
bounds it. It also stops when every remaining task is held by someone else; a claim that lapses later doesn't
restart it, so run the loop again, or from a scheduler.

A headless session can't ask you anything, so give it what the work needs up front, with the server and skill as
in § 2:

- **Claude Code:** `--permission-mode` and `--allowedTools` (see `claude --help`). Allow the metabob tools by the
  names `/mcp` shows, git, and the commands the done checks run.
- **Codex:** `-s workspace-write` (`--sandbox`) lets it edit the checkout; a push also needs network access in the
  sandbox. Check `codex exec --help` for your version's default.

The loop needs permission to push. Without it, each fix stays pending (§ 3), and a session that doesn't read the
pending mark as taken may start the same task again. A claim belongs to the checkout, so loops that run side by
side each need their own working copy (for example a `git worktree`).

**Agent cells.** `metabob-mcp task pull --origin <git url>` claims the next task and writes it, with its context,
into the task directory (`/task` by default), then clones the origin into the work directory (`/work`). It takes
a task the cell already holds first, so a restarted cell resumes it, then unclaimed tasks, most severe first,
skipping held, closed and fix-pending ones. Its exit code tells the entrypoint what to do next:

| Exit | Meaning | The entrypoint |
|---|---|---|
| 0 | A task was pulled | Starts the harness on it |
| 3 | No open task, or none could be claimed and none is held by others | Stops: the cell is done |
| 4 | Open tasks exist, but others hold them or a claim isn't settled (`task pull` withdraws that claim) | Waits until `retry_after`, when to pull again, and pulls (an entrypoint you write; the lab's cell exits instead) |
| 2 | Not attached | Stops, and `attach --check` names the cause |
| 1 | Any other failure | Stops |

With `--json`, the reply is one JSON line, on standard output for exit 0 and on standard error for every other
exit, so an entrypoint reads `retry_after` for exit 4 from standard error. The task and work directories must be
empty or missing, or it exits 1: a restarted cell starts from a fresh clone and resumes the claim, not any work
it hadn't pushed ([SPEC § task pull](SPEC.md#task-pull)).

Closing by commit has three parts:

- **The commits name the task.** `finding close` acts only on a `Fixes-Finding: <id>` trailer, with the `task_id`
  from `/task/task.json`. The `metabob` skill asks for one; a harness prompt or the task's brief can repeat it.
- **The list comes before the push.** After rebasing, the entrypoint lists the cell's own commits
  (`git rev-list origin/<target>..HEAD`) into a file, then pushes.
- **The close comes after it.** `metabob-mcp finding close --commits-from <file>` closes the findings whose fix
  is merged into the target and marks those only pushed as pending ([SPEC § finding close](SPEC.md#finding-close)).

Fixes go to `main` unless the task says otherwise. A task that should be reviewed declares `push_to: task`, which
pushes to `task/<task id>`, as well as `integrate: review`; `integrate: review` alone still pushes to `main`. Once
a reviewer merges the branch, nothing closes the task by itself: run `finding close` again after the merge, by
hand, from CI or from a scheduler.

Set `VESSEL_ID` in every cell, the same value for `task pull`, the harness's MCP server and `finding close`, each
cell its own, kept across restarts. Without it, each derives an identity from the key and the work directory:
`task pull` before the clone exists and the server inside it, so they differ, and the cell's agent reads its own
claim as someone else's and, following the skill, takes another task. The lab's cell entrypoint
(`lab/cell/entrypoint.sh`) sets it from `CELL_VESSEL_ID`, else `metabob-cell-<container hostname>`.

**Keeping parallel workers apart.** Two things do it, whatever starts the workers: a claim keeps a second agent off
a task (when two claim at once, every reader settles it the same way and the later one is told it lost), and
disjoint `Owns:` lists keep agents out of each other's files.

## 9. Alongside an issue tracker

GitHub Issues, Jira and the like stay where people track the work. A ledger task is the agents' copy of a ticket:
it carries a reference to the ticket in its details rather than the ticket's text, for example a line
`Ref: github#12`. Track each piece of work in one place: the ticket for people, the ledger task for agents, and
the reference between them. There is no integration between the two; the reference is a convention, and
closing one doesn't close the other.

A capitalized `Ref:` is plain text. Lowercase `ref:`, `push_to:`, `integrate:` and `conflicts:` lines are read by
`task pull`: `ref:` names the branch a cell clones, and the others its integration policy.

What the ledger gives agents that a tracker doesn't:

- **Claims that end.** A claim lasts a set time unless renewed, so a stopped agent doesn't hold a task forever, and
  a race between two agents settles the same way for every reader.
- **Memory linked to the code.** Decisions, rejected approaches and handoffs are linked to the repository and its
  tasks, and ranked by how often they helped (§ 11).
- **Findings in front of the next editor.** A problem recorded on a file comes back to the next agent that reads
  the ledger for that file, and while the server is attached the Claude Code plugin asks for that read before an
  agent's first edit of an existing file.

## 10. Who does what, and where

| Who | Does |
|---|---|
| You | Ask for the plan, review the split and ownership, approve pushes, decide what a decision rules out (§ 5) |
| A planner agent | Reads the source, records the tasks, decisions and steps (§ 7) |
| Worker agents | Claim a task, work inside its files, close it with the commit or hand it off |
| Agent cells | Run workers unattended: `task pull`, the harness, and, where the cell may push, `finding close` (§ 8) |
| A reviewer | Merges the `task/<id>` branches of tasks that declare `push_to: task`; a fix there stays pending until the merge and a later `finding close` |

| Where | Holds or does |
|---|---|
| The MCP server, on each agent's machine | Indexes the workspace when an agent calls `init_workspace`, guards every outgoing string, reads the checkout's commits and remote-tracking branches for the fix commit (only `finding close` fetches), and matches recalled items to your files; sends no file contents (§ 12) |
| The shared service (metabob) | Tasks, claims, verdicts, decisions, handoffs, links and credit, for your whole organization |
| Your git origin | Pushes, merges and CI; a close is checked against what it holds |

## 11. Memory that improves with use

Reading memory changes nothing. What moves it is credit: when an agent relies on a concept another agent wrote and
it helps, the agent records a success; when it misleads, a failure. A concept's relevance is
`(times_succeeded + 1) / (times_loaded + 2)`, and search shows the more relevant first. Closing a task or finding
counts the same way: endorse credits it, discard counts against it. Agents don't credit what they wrote themselves:
credit is the next agent's judgment of the work.

Corrections are added, never overwritten. A wrong decision is answered by a new one linked to it as contradicting
it, so the history of why the answer changed stays readable.

## 12. What leaves your machine

No source file, excerpt or file list is sent, and no usage telemetry. What is sent is what an agent's calls carry,
and every request to the shared service carries your API key:

| The agent… | What is sent |
|---|---|
| records a task or problem (`record_finding`) | summary, details, severity, category, status, the file paths and line range, the repository's identity (its git remote, or the directory's name when it has none) and the directory's name, a hash naming the workspace, the item's ids, and the author and session |
| closes one (`mark_complete`, `finding close`) | the verdict, the item's summary, files and repository, the fix commit, its branch, the base and target branch names, the author and session, and whether the verdict came from a local copy |
| claims one (`claim_finding`) | the item's id and summary, the repository's identity, the claim's length and end, the author and session |
| writes memory (`concept_create`, `concept_link`, `concept_record_usage`) | the text it writes, its shape, any pointer it gives, the author and session |
| searches or reads (`concept_search`, `concept_neighbors`) | the search text, or the ids it reads |

Every write also carries a `client_claim`: the operator, session and client it declares (SPEC § Client claim).
`get_problems` matches the recalled items to your files on this machine: the paths are not sent. Everything
written is visible to every agent in your organization. Each string an agent sends passes an outgoing
guard first: a known secret (your key, secret-named values from your environment and config files) or anything that
looks like a credential refuses the call without repeating it, and a path under your home directory is redacted in
prose and refused in a field the service acts on (a search, a pointer).
Each field has a size cap (a summary 2 KB, details 8 KB, a concept 16 KB), so agents write reasons, not dumps.
`init_workspace` reads your files into a local index and sends nothing.

## 13. Troubleshooting

| Symptom | Next step |
|---|---|
| A call answers `Tool "…" is not in this server's default tool set` | This work doesn't need it; `METABOB_TOOLS=all` lists every tool (§ 2) |
| More than eleven tools appear | `METABOB_TOOLS` is set (to `all` or a list) where the server starts: check § 2 and reconnect |
| A call answers `workspace_undetermined` | The agent calls `init_workspace` with the project's absolute path; a relative path such as `.` may not name it |
| The ledger is keyed to the wrong repository | `get_analysis_context` shows it; `init_workspace` with the right path fixes it |
| A call answers with a named cause (`key_rejected`, …) | `npx @metabob/mcp attach --check` |
| A task you closed is still open elsewhere | Its fix is pending: commit and push, then close again |
| The close says no commit since the task touches its files | If the work is in other files, the agent names the commit with `fix_commit` |
| The close says the commit is only on task branches | It awaits review; close again once merged |
| Two agents did the same work | Give each task its own files; in one working copy, claims don't separate sessions |
| The agent didn't find a decision you know was recorded | Ask it to link the decision to the repository's anchor; unlinked concepts are easy to miss |
| Recall shows nothing | A failed or truncated read is not "nothing recorded"; read the line under the heading |

## 14. References

- [README](../README.md): installation per client, configuration, proxies.
- [Specification](SPEC.md): every tool's parameters and behaviour.
- `skills/metabob/SKILL.md`: the routine your agents follow.
