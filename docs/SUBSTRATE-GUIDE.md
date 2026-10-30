# The substrate and every tool

This guide is for a person whose AI coding agent (Claude Code, Codex, Cursor, Continue or another MCP client)
runs the Metabob MCP server with **`METABOB_TOOLS=all`**: every tool, with the `metabob-substrate` skill. It
assumes the default tool set already works for you. [USER-GUIDE.md](USER-GUIDE.md) is the guide for that set
and covers setup (the key, the address, each client, the skill, `attach --check`), the shared task ledger and
memory, handing a task to another agent, and several agents on one repository. This guide covers what `all` adds: checking
what the substrate has in flight on a file, the local code tools, goals on the substrate, and inspecting its
runs.

**Which guide is yours.** Look at the tools the server lists (in Claude Code, `/mcp` → `metabob`). Eleven
(`get_analysis_context`, `get_problems`, `claim_finding`, `record_finding`, `mark_complete`, `concept_search`,
`concept_neighbors`, `concept_create`, `concept_link`, `concept_record_usage` and `init_workspace`): that is the
default set, and [USER-GUIDE.md](USER-GUIDE.md) is your guide. More, with `path_activity` and `run_goal_async`
among them: read on. None: `METABOB_TOOLS=all` is set on a server before 0.4.0 (§ 2).

Exact tool parameters are in the [specification](SPEC.md); installation details per client are in the
[README](../README.md).

## 1. What `all` adds

**The substrate** is the set of services behind the server: the ledger and memory store, goal execution,
discovery, and the gap store, where the substrate keeps the work it has identified in the repositories it
mounts. **Attached** means the server has proven its API key with the substrate; until then the substrate tools
answer with the reason.

Beyond the eleven tools of the default set, `METABOB_TOOLS=all` lists the tools below. A comma-separated
`METABOB_TOOLS` lists exactly the tools it names, so any of them is also listed by a list that names it.

| Tools | What the agent uses them for | Section |
|---|---|---|
| `path_activity` | What the substrate has in flight on a file before an edit: gaps queued, held, or being landed | § 3 |
| `analyze_impact`, `predict_cochanges`, `search_codebase`, `assign_git_changes` | The local code tools: blast radius, files that change together, code search, which components a change touches | § 4 |
| `get_metrics`, `annotate_component` | The local store's open findings by severity and category; notes on a local finding | § 4 |
| `run_goal_async`, `run_goal`, `goal_status`, `goal_reasoning`, `provide_feedback` | Handing a goal to the substrate, following it, reading why it reached or fell short, and recording a verdict | § 7 |
| `execution_trace`, `registry_query`, `resolve_impulse` | Inspecting the substrate's runs, its advertised shapes, and its plain reads | § 8 |
| `concept_sequence`, `concept_usage_stats` | Concepts observed to follow one another in successful work; a concept's usage history | § 9 |
| `pull_assigned_work`, `submit_resolution` | Questions queued on this machine for the agent, and its answers | § 9 |

The skill for this set, `metabob-substrate`, brings the default set's routine (check before editing, record what
you do not fix, close what you fixed) plus the substrate's roles: operator of goals, verifier of their outcome,
and participant alongside the system on code it also changes.

## 2. Set up

Setup is the same as for the default set apart from `METABOB_TOOLS`: the key, the address, the config file, each
client and `attach --check` are in [USER-GUIDE.md](USER-GUIDE.md), § Install. What is specific to `all`:

### Version

`all` needs server 0.4.0 or later: an earlier server reads `all` as the name of one tool and lists none. Wherever
you set `METABOB_TOOLS=all`:

- With a plugin, the server's version is the plugin's own (its `.mcp.json` pins it), so a plugin before 0.4.0
  lists no tools under `all`.
- With a server you add yourself, name the version in the command: `@metabob/mcp@0.4.1`.
  `npx -y @metabob/mcp@0.4.1 --version` prints the version a command starts.

### Turning it on

`METABOB_TOOLS` is read when the server starts, so restart or reconnect the client after setting it.

- **Claude Code with the plugin** (installed as USER-GUIDE.md, § Install, describes; it ships both skills and the
  edit check, § 3). Set `{ "env": { "METABOB_TOOLS": "all" } }` in `~/.claude/settings.json`, or export
  `METABOB_TOOLS=all` in the shell that starts `claude`.
- **Claude Code with a server you add yourself.**
  `claude mcp add metabob -s user -e METABOB_TOOLS=all -- npx -y @metabob/mcp@0.4.1`, adding `-e` for the key and
  address when no config file supplies them.
- **Codex.** The plugin's server takes no extra environment, so remove the plugin
  (`codex plugin remove metabob@metabob`), add the server yourself
  (`codex mcp add metabob --env METABOB_TOOLS=all -- npx -y @metabob/mcp@0.4.1`, adding `--env` for the key and
  address when no config file supplies them), and install the skill by
  hand (below).
- **Cursor, Continue and other clients.** In the server's `env` in the client's MCP configuration:

  ```json
  { "mcpServers": { "metabob": {
      "command": "npx", "args": ["-y", "@metabob/mcp@0.4.1"],
      "env": { "METABOB_TOOLS": "all" } } } }
  ```

  with the key and address in `env` too when no config file supplies them (USER-GUIDE.md, § Install).
- **Headless runs and agent cells.** In the environment the harness starts the server with.

### Install the skill without a plugin

Copy `skills/metabob-substrate/` (in this repository, and in the npm package) into the client's skills
directory: `~/.claude/skills/` for Claude Code, `~/.codex/skills/` for Codex. A client with no skills directory
takes it through its rules file: point `AGENTS.md` (or `.cursor/rules`, Copilot instructions; see the README) at
the skill's `SKILL.md`. Under `all` the server's own instructions tell the agent to load `metabob-substrate` and
to check `get_problems` and `path_activity` before editing; not every client shows a server's instructions to
the agent, and in those the rules file carries that rule too.

### Check that `all` took effect

`/mcp` → `metabob` (or the client's tool list) shows more than eleven tools, `path_activity`, `run_goal_async`
and `execution_trace` among them. A call that answers `is not in this server's default tool set` means the
server started without `METABOB_TOOLS=all`. For the attachment itself, `attach --check` and
`get_analysis_context` work as USER-GUIDE.md, § Install (Check it), describes.

## 3. A session under `all`

A session runs as in USER-GUIDE.md, § What it does: the agent orients on the ledger and memory,
claims its task, records what it notices and does not fix, closes what it fixed with the commit, and writes down
its decisions. Under `all` the `metabob-substrate` skill adds a check before every edit of a shared file, and
the local code tools (§ 4) before and after the edit.

### Before editing a file: what is in flight

The agent looks up what is known to be wrong in the file (`get_problems`) and what the substrate has in flight on
it (`path_activity`). `path_activity` lists the open **gaps** naming each path, the work the substrate has
identified there, each one:

- **queued** for the system: prefer letting the system land it, or dispatching it as a goal (§ 7);
- **held** by an operator ruling, with its review date and what lifts it when they are recorded: it is not open
  work;
- **being landed** under a **landing lease**: the system is applying a change to the file, with a holder and an
  expiry. An edit before the lease ends is lost or conflicts when the change lands, so the agent leaves the file
  until the lease ends, and records a finding naming the lease when its task needs the file sooner (§ 6). A lease
  past its expiry is shown as lapsed, and its gap counts as queued. A lease that writes only a check file (a
  test-writing compose) is shown as being landed on that check file; on the file the check tests, its gap counts as
  queued, and the line says the check it lands tests this file, since an edit now can fail that landing's checks.

With nothing in flight, the agent makes the change and records it. The paths are matched on your machine and
never sent. In a repository the substrate does not mount, `path_activity` says the repository may not be one the
substrate mounts, and nothing can be in flight there; a substrate that keeps no gap store says there is nothing in
flight to check. `analyze_impact` and `assign_git_changes` add each changed file's open gaps and landing leases
from `path_activity`'s cached read, when there is one.

### The edit check

In Claude Code the plugin's edit check prompts for this step: it holds the first edit of each existing file in a
session once, with a note asking for `get_problems` and `path_activity` on the file. The retry goes through, so
it is a reminder, not a lock. It asks for `get_problems` alone when the server does not list `path_activity` (as
under the default set) and in a repository `path_activity` reported the substrate does not mount. It holds
nothing while the server is not attached, nor for a new file, a second edit of the same file, a file already
checked with either tool, or a file outside the workspace. If the check itself fails, the edit goes through.
`METABOB_EDIT_CHECK=off` turns it off. It is a Claude Code hook and exists only there; other clients carry the
same rule in the server's instructions and the skill.

## 4. The local code tools

These run on this machine, in any repository, with no substrate. `init_workspace` builds the code index in
memory (it is rebuilt each time the server starts); nothing leaves the machine.

| Tool | What it gives | Needs |
|---|---|---|
| `analyze_impact { changed_files }` | The components affected by changing those files, by depth, test files included | `init_workspace` |
| `predict_cochanges { changed_files }` | Files that changed in the same commits as those files, each with its confidence and commit count: the sibling file you would otherwise forget | a git checkout |
| `search_codebase { query }` | Components and local findings matching a keyword | `init_workspace` for components |
| `assign_git_changes { changed_files }` | Which components each changed file touches, its co-changes and its local findings; before a commit, a file it names that you did not touch is worth a look | `init_workspace` |
| `get_metrics` | The local store's open findings by severity, source and category, and the index's size | nothing |
| `annotate_component { problem_id }` | Why and how-to-fix notes for a finding in the local store | a local `agf_*` finding |

The skill has the agent run `analyze_impact` before editing anything shared, `predict_cochanges` alongside it,
and `assign_git_changes` before committing. You can ask for them directly too: "What does changing this file
affect, and which tests?"

## 5. What to ask your agent

Everything in USER-GUIDE.md, § What to ask for, holds. Under `all`, also:

| You want | Ask, for example | What the agent does |
|---|---|---|
| To know what is in flight before you edit | "Is anything in flight on the file I am about to change?" | `path_activity`: gaps the system is landing, queued or held |
| The blast radius of a change | "What does changing this file affect, and which tests?" | `analyze_impact`, `predict_cochanges` |
| The substrate to do the work | "Dispatch a goal to …" | `run_goal_async`, then `goal_status`, `goal_reasoning` (§ 7) |
| To know why a run went the way it did | "Why did that dispatch fall short?" | `goal_reasoning`; `execution_trace` for a trace |
| To see what ran recently | "What has the substrate run lately?" | `execution_trace` with no id |
| To know who serves a shape | "Which vessels serve `conceptSearch`?" | `registry_query { mode: "vessels", shape }` |

## 6. What needs a decision

With either skill, what needs a decision (a push it may not make, work outside its task's files, a recorded decision
that contradicts its instructions) goes on the ledger. The `metabob-substrate` skill also brings these to you:

- **A landing lease.** When `path_activity` shows the system landing a change to a file, an edit before the
  lease ends is lost or conflicts. The agent leaves the file until the lease ends; when its task needs the file
  sooner, it records a finding naming the lease, and whether to edit is your decision.
- **A held gap.** It names the operator ruling and its review date and says what lifts it; it is not open work.
- **Your judgment of an outcome.** An agent's verdict on a goal (`provide_feedback`) is stored as an
  `automated` observation; it never overrides the substrate's own verdict. A person's verdict goes through the
  substrate's human surface. The agent does not represent your view as its own.
- **Leases and the system's records.** The agent never takes or releases a maintenance or landing lease and
  never writes the system's traces, gaps or policy by hand; a lease that looks stuck is recorded as a finding.
  `resolve_impulse` refuses those writes.
- **Restarts and deployments.** The agent does not restart or deploy the substrate's nodes. Maintenance runs as
  a dispatched activity, when you ask for it.
- **Load tests.** A load test runs capped, in a window you clear, and stops when you ask.

## 7. Goals on the substrate

For repositories the substrate itself mounts, an agent can hand it a goal instead of doing the work:

1. `run_goal_async` with the goal in plain language ("edit `repos/<vessel>/src/<file>`: <the change>") returns
   a `dispatchId`. A goal that names a file in a mounted repository is drafted, typechecked and landed by the
   substrate as a traced commit. `run_goal` dispatches the same way and waits, for short goals.
2. `goal_status` until the dispatch is no longer running. Read **`reached`**, not `status`: `completed` with
   `reached: no` is common, and so is `failed` with `reached: yes`.
3. `goal_reasoning` for the walk's decision log: what it tried, and why it reached or fell short.
4. The actual result (the landed diff, the answer, the tests) is checked against what was asked: a change can
   pass the reach check and still not do what was meant.
5. The agent may record its verdict (`provide_feedback`: `reached`, `not_reached` or `partial`, with the
   evidence it checked as the rationale). It is stored as an `automated` label beside the substrate's own
   verdict, for audit; it does not change `reached`.

A dispatch in the default learn mode teaches the substrate: the `learning:` line of `goal_status` says what the
walk recorded (a goal path, changed template scores, gaps filed, a label), or `none recorded`. A dispatch with
`learning_mode: "observe"` asks the substrate to trace the walk without learning from it. After a miss, the agent's
instructions decide whether it retries, rephrases or does the work itself. Before dispatching it checks that an
open gap or a recent dispatch does not already cover the goal; a 429 from goal-host is its spend-rate cap, not
something to retry.

On any other repository the substrate has no copy of your code, so the agent does the work, and the ledger and
memory remain its coordination.

## 8. Inspecting runs

These replace host access (`docker exec`, `journalctl`, a raw `curl`) for reading the running substrate:

- **`execution_trace`.** With no id, the most recent runs of your organization: execution id, status, duration,
  template and time. With an `execution_id`, that run's trace: status, template, tags (`reached:`,
  `state_signature:`, `operator:`), failure mode and each task in order. A run reached by a satisfier keeps no
  task trace; its walk is in the dispatch record, which `goal_reasoning` reads.
- **`registry_query`.** `mode: "shapes"` lists the shapes the substrate advertises (filtered by a `shape`
  substring); `mode: "vessels"` with a `shape` lists the vessels that serve it. The vocabulary is that of the node
  the server attaches to; a shape a peer node serves is asked for by name in `vessels` mode.
- **`resolve_impulse`.** The advanced escape hatch for the substrate's plain reads (records, reports, statistics,
  summaries, policies) and one memory write, `memoryNote_write`, when no dedicated tool shows what you need. Every
  other shape is refused before any request, with what to do instead: anything that runs or changes something is
  dispatched as a goal or made through its dedicated tool.

## 9. The ledger and memory under `all`

The ledger, claims, briefs and memory work as USER-GUIDE.md describes in § What it does and § Hand a task to
another agent, by the rules SPEC gives under § mark_complete and § claim_finding; unattended workers and agent cells are in
[DEPLOYING-AGENTS.md](DEPLOYING-AGENTS.md). An agent given a task reads
its brief with `concept_search { concept_id: <the task's concept id> }`: `get_problems` shows a task's summary
and id, never its details. For a task recalled from the ledger, the id `get_problems` shows is that concept id
(`concept_…`), and it is the id to hand over and claim with: `claim_finding` and `mark_complete` take an `agf_…`
id only on the machine whose local store holds the task. A `Fixes-Finding:` trailer names one of the `agf_…` ids on
the brief's `finding_ids:` line.

`all` adds to these:

- **Two memory reads.** `concept_sequence` lists the concepts observed to follow (or precede) a concept in
  successful work; `concept_usage_stats` shows a concept's uses, its success and failure rates, and its recent
  usage.
- **The agent-task queue.** A question a local program puts to the server's loopback resolver is queued on this
  machine, and the agent answers it with `pull_assigned_work` and `submit_resolution`. The substrate itself
  dispatches no work to a session: with the queue empty, `pull_assigned_work` says that no task can arrive.

## 10. What else leaves your machine

What the default tools send is listed per call in DEPLOYING-AGENTS.md, § 7.5, with the outgoing guard every string
passes and the `client_claim` every write carries. Beyond your key, the tools `all` adds send:

| The agent… | What is sent |
|---|---|
| dispatches a goal (`run_goal_async`, `run_goal`) | the goal text, the learning mode, and its tags (`operator:`, `session:`, and any the agent adds) |
| gives a verdict on a goal (`provide_feedback`) | the verdict, rationale and confidence, with the operator and session in the notes |
| answers a queued task (`submit_resolution`) | the answer text |
| writes a memory note (`resolve_impulse`'s `memoryNote_write`) | the note's content |
| reads the substrate (`goal_status`, `goal_reasoning`, `execution_trace`, `registry_query`, `resolve_impulse`, `concept_sequence`, `concept_usage_stats`) | the ids or shape names it reads |

`concept_usage_stats`' recent usage rows are the one read that goes straight to concept-db's advertised address
rather than through discovery. `path_activity` matches paths on this machine: the paths are not sent. The local
code tools send nothing.

## 11. Troubleshooting

The rows that apply to every tool set are in USER-GUIDE.md, § Troubleshooting. Under `all`:

| Symptom | Next step |
|---|---|
| No tools appear with `METABOB_TOOLS=all` | The server is before 0.4.0: name `@metabob/mcp@0.4.1`, or update the plugin (§ 2) |
| Only eleven tools appear | `METABOB_TOOLS=all` did not reach the server's environment: check where it is set (§ 2) and reconnect |
| `path_activity` says the repository may not be one the substrate mounts | Nothing is in flight there; check `get_problems` and edit |
| `path_activity` says the substrate keeps no gap store | Nothing is in flight to check; edit |
| `goal_status` says the dispatch was not found | Dispatch records are kept in memory, about the last 100; with its `executionId`, read the trace with `execution_trace` |
| A dispatch answers 429 | goal-host's spend-rate cap: wait, do not retry in a loop |
| `goal_status` shows `completed` and `reached: no` | The goal was not reached; read `goal_reasoning` |
| `execution_trace` finds no trace for a reach | A satisfier reach keeps no task trace; `goal_reasoning` shows its walk |
| `provide_feedback` writes nothing | The dispatch has no execution or activity to label; the reply says where the assessment goes instead (`record_finding`) |
| `resolve_impulse` refuses a shape | Only plain reads and `memoryNote_write` resolve: dispatch the work as a goal, or use the tool the refusal names |

## 12. References

- [USER-GUIDE.md](USER-GUIDE.md): setup, configuration, the default tool set, the shared ledger and memory.
- [README](../README.md): installation per client, configuration, proxies.
- [Specification](SPEC.md): every tool's parameters and behaviour.
- [Conformance](CONFORMANCE.md): how this client takes part in the substrate.
- `skills/metabob-substrate/SKILL.md`: the routine your agent follows under `all`.
