# Deploying agents

This guide is for whoever sets up, runs and steers AI agents that share a repository through Metabob. It is
organised around three uses:

1. **Setting up agents and refining their policies, skills and instructions** based on what happens as they go
   about their tasks (§ 3): producers that turn events into tasks, consumers that do them, and the policies a person
   edits in the dashboard that both read at run time.
2. **Setting up agents to share information about a project and organize work amongst themselves** (§ 4).
3. **Creating workflows that run in many sandboxed cells** (§ 5).

All three run the same thing, a **loop** of iterations that consume and generate tasks; § 1 takes one apart and
says what Metabob records in each part, and § 2 lists the pieces every setup uses. Each use then says what you set
up, the loop it runs, what is recorded and where, how you read it and change behaviour, and what exists today and
what does not, with worked examples. § 6 collects the limits, § 7 the security rules and § 8 troubleshooting.

It is the technical companion of the [user guide](USER-GUIDE.md), which explains the ledger and the memory from
the user's side; read that first. Tool parameters are in the [specification](SPEC.md), and installation per client
is in the [README](../README.md#integrations).

**Before any agent pushes, read § 7.** Three behaviours there decide what reaches your branches unreviewed: a
cell's integration policy defaults to pushing straight to `main`; `mark_complete endorse` closes a finding once its
fix is on any remote branch not named `task/…`; and a `project_convention` from a trusted author sets a cell's
policy even while it is only proposed.

## Terms used here

| Term | Meaning |
|---|---|
| Loop | The cycle by which an observation becomes a record, the record becomes another agent's input, and an outcome changes what the next iteration does |
| Iteration | One pass of a loop: usually one session or one cell, taking one task |
| Driver | Whatever starts the next iteration: a person, a script, a cell launcher or a scheduler. Metabob starts nothing |
| Task | An open finding in category `task`: work recorded on the ledger for an agent to take |
| Cell | One task, one container, one fresh clone (§ 5 Agent cells) |
| R1, R2 | The two rules meant to decide which guidance is in effect. R1: when two ledger items conflict, a person rules, and until then both stay flagged. R2: a policy an agent proposes stays pending until a different key endorses it. The dashboard is where people apply them; the server applies neither (§ 3 Policies on the ledger) |
| `repo_anchor` | The concept that stands for one repository in the shared memory. Decisions, conventions and review criteria are linked to it, so an agent reads a repository's memory by following the links into it (`concept_neighbors`). The `metabob` skill finds it with `concept_search { shape: "repo_anchor" }` and creates it when there is none |
| Cockpit tool | One of the operator tools beyond the default set (goals, traces, the registry, `path_activity`), listed only under `METABOB_TOOLS=all` or a list that names it. Listing `path_activity`, `run_goal_async` or `run_goal` (`src/server-instructions.ts@COCKPIT_TOOLS`) switches the instructions and the skill to `metabob-substrate` (§ 3) |
| Unmounted | A repository `path_activity` reports as one the shared service may not mount: none of the system's own open gaps names it, so the tool checks none of its paths, and the edit check asks for `get_problems` only |
| The local installer | The setup that runs the shared service on your own machine and writes the API key and endpoint into `~/.substrate/config.json`; on a machine it set up, the server needs no other configuration (README § Quick Start). A worker of the hosted service does without it: its key and discovery address go in a config file (§ 2) |

## 1. Loops, and what metabob instruments in one

A loop is the cycle by which an observation becomes a record, the record becomes another agent's input, and an
outcome changes what the next iteration does. In practice it is a workflow: **producers scatter tasks**, **consumers
take the instructions and carry them out**, and what happened is **fed back** as results, findings, decisions,
handoffs and credit, which the next producer and consumer read.

A loop is worked out of a repository, but its tasks need not edit it. A task may change the repository, or use,
investigate, test, review or operate it:

| Objective | An example task | What the consumer feeds back |
|---|---|---|
| Change | Port one module of a library; fix the bug an issue reports | The commit, each mismatch as a new task, the decisions it made |
| Use | Run the repository's CLI to answer a question someone asked | The answer, and a finding when the CLI cannot answer it |
| Investigate | Find why a behaviour happens | What was found, the approaches ruled out, follow-up tasks |
| Test | Run a suite against a build and report | The results, and a finding per failure |
| Review | Check a change, a report or a configuration against the recorded policies | Each breach as a finding, and credit on the policy it applied |
| Operate | Run a deploy or a migration, and record the result | The outcome, and a handoff when it stops part way |

Producers are as varied: a new GitHub issue, an email to a support address, a CI alert for a vulnerable
dependency, a schedule, or a person asking. Each iteration is short and forgets everything; the loop remembers
because each iteration writes down its state and its outcome. A task whose objective is not a change records its
outcome in a file it commits (§ 6).

What Metabob gives a loop:

- **Tasks and findings attached to files**, so the next iteration finds the work where it applies.
- **Claims**, so two iterations running at once do not take the same task.
- **Closes that record evidence**: the commit that holds the outcome, and `fix pending` until it is pushed or
  merged.
- **Decisions with rejected approaches, handoffs, and steps linked in order**, so what an iteration learned outlives
  it.
- **Credit**, which ranks what helped above what misled.
- **People's rulings and policies**, through the dashboard.

**Consuming and generating.** A loop consumes tasks: it finds one, claims it, works it and closes it. It also
generates them: it records follow-up tasks and findings as it learns, and when a step closes it records the task
for the next step. A loop that only consumes runs dry; one that only generates fills a queue nobody drains. Both
halves are calls the agent makes, so the prompt, the brief and the skill have to ask for both.

### The anatomy of a loop

| Part | What happens | The calls | Where it is recorded |
|---|---|---|---|
| **Seed** | The first work and the rules it follows go onto the ledger | `record_finding { category: "task", files or subject, details }` per unit of work; `concept_create` for `decision_record`, `project_convention` and `workflow_step` concepts, linked to the `repo_anchor` with `concept_link`; or "Add here" in the dashboard's Ledger | Tasks as `code_finding` concepts keyed by repository, naming their files or subject; guidance and steps as concepts linked to the anchor |
| **Consume** | An iteration takes one task and finishes it or hands it off | `get_problems`; `concept_search { concept_id }` for the brief; `concept_neighbors` on the task for earlier handoffs; `claim_finding`; `mark_complete endorse` after the commit, or with its `outcome` for a task that names no file; or `task pull` and `finding close` in a cell | Claims and closes as `finding_verdict` concepts: claimed, released, fixed with its commit, done with its outcome, `fix pending` |
| **Generate** | The iteration records what it found and what comes next | `record_finding` for problems and follow-up tasks; `concept_neighbors { direction: "outgoing", edge_types: ["sequence_next"] }` on a closed step, then `record_finding` for the next step's task | New tasks and findings on the ledger |
| **Remember** | What the next iteration would otherwise rediscover | `concept_create` for a `decision_record` (with `Rejected:`) or a `task_handoff`; `concept_link` with `description_of`, `derived_from`, `resolves_to` or `contradicts` | Concepts in the organization's memory, reachable from the anchor and the task |
| **Credit** | The memory learns what was worth reading | `concept_record_usage { outcome: "success" \| "failure" }` on concepts another agent wrote; `mark_complete` folds its verdict into the finding's own relevance | Each concept's load and success counts, and its relevance |
| **Rule** | People decide what agents may not | The dashboard's *Needs you* and *Ledger*: rule on conflicts, endorse or reject proposals, author policies, triage findings | Ledger rows written by the person's key |
| **Stop** | The loop knows when it is done | The brief's `Done when:` check; `task pull` exit 3, or a reply the script stops on, when the queue is empty; a cap on rounds | The closed tasks; the last iteration's handoff |
| **Drive** | Something starts the next iteration | A person, a script loop, a cell launcher or a scheduler | Outside Metabob |

**Nothing starts the next iteration.** Recording a task wakes no one, and the dashboard sends no alerts. An
iteration learns of work only when it reads the ledger, so every loop has a driver: a person who starts a session
(§ 4), a script that runs `claude -p` until the queue is empty, a launcher that starts cells while `task pull` has
work, or a scheduler (§ 5).

### Instrumenting a loop

A loop is instrumented when each iteration's state and outcome are on the ledger and in the memory: the loop can
then be watched from outside, and the next iteration reads what the last one left rather than starting over. In
practice every iteration claims what it takes, closes what it finishes with the commit, records what it noticed,
and leaves a handoff when it stops short. Then these show the loop's state (§ 3 Measuring a loop says how to read
each):

- **The queue**: `get_problems` counts the open tasks (yours, unclaimed, claimed by others, with a fix pending) and
  the closed ones. Tasks generated against tasks closed says whether the loop converges.
- **Pending fixes and handoffs**: work done but not yet integrated, and work stopped short with its next steps.
- **Credits**: how often agents recorded using the memory a loop builds (`concept_record_usage`), and whether it
  helped; reads are not counted.
- **The dashboard's Ledger and Activity**: the tree of tasks, claims and guidance, and one line per act.
- **`METABOB_CALL_LOG`**: on each worker's machine, the order of its calls and what each claim and close did.

## 2. The pieces every setup uses

| Piece | Where it runs | What it does |
|---|---|---|
| The MCP server (`@metabob/mcp`) | On each agent's machine, started by the harness over stdio | Gives the agent the ledger and memory tools; holds a local index of the code; sends only what the agent's calls carry |
| The shared service | Hosted; agents reach it at `https://ide.metabob.com` | Holds the organization's ledger (tasks, findings, claims, verdicts) and memory (decisions, handoffs, policies), and checks every key |
| The dashboard | `https://app.metabob.com` | The people's seat at the ledger: rule on conflicts, endorse or reject proposals, author guidance, see activity, manage keys |
| Git | The repository's origin | Keys the ledger (every clone of one origin shares one), holds the commits a close records, and is where cells push |
| The harness | Claude Code, Codex, Cursor, Continue or any MCP client | Runs the model, starts the server, loads the skill, and decides what the agent may do |

**The server.** It is a client: it binds its local HTTP resolver to `127.0.0.1`, registers nowhere, and is reached
only from this machine. On start it proves its key against the identity service that the shared service's `/bootstrap` names, and
until that succeeds every shared tool answers with one line naming the cause (`key_rejected`,
`anchor_unreachable`, …) while the local tools keep working. `metabob-mcp attach --check` walks each step and names
the failing one. The local index is rebuilt in memory at each launch; nothing about the code is persisted or sent.

**Prerequisites** on each machine or image that runs an agent:

- `git` on PATH: Claude Code clones the plugin's marketplace with it, the ledger is keyed by the repository's
  origin (or its first commit), and a close reads the commits.
- Node 22.13 or later (or 23.4 or later). It runs everything, the server included, whose local store uses
  `node:sqlite`. On an older Node the server re-execs into Bun 1.1 or later when Bun is on PATH, and exits with
  `runtime_unsupported` when it is not; `attach --check`, `task pull` and `finding close` run on any Node 18 or
  later (SPEC § Runtime).
- Linux, macOS or Windows x64.

Where a script, a scheduler or an image calls the server's commands, install the bin, which puts `metabob-mcp` on
PATH:

```bash
npm i -g @metabob/mcp@<version>
metabob-mcp --version
```

Pin a version you have run, here and in every `npx` entry, rather than `@latest`: `@latest` changes what a worker
runs at its next start, and `METABOB_TOOLS=all` needs 0.4.0 or later. The Claude Code and Codex plugins pin their
own version.

**Attaching to the hosted service** needs two values, the key and the discovery address. For a one-off check
from a shell:

```bash
export METABOB_API_KEY=<the worker's key>
export DISCOVERY_ENDPOINT=https://ide.metabob.com
npx @metabob/mcp@<version> attach --check     # exit 0 means attached
```

For a worker, put them in a 0600 config file rather than the harness's environment (§ 7). The server reads the
first that exists of: the file `SUBSTRATE_CONFIG_PATH` or `METABOB_CONFIG_PATH` names, `./.substrate/config.json`
and `./.metabob/config.json` in the directory it starts in, then `~/.substrate/config.json` (the installer's) and
`~/.metabob/config.json`. So a worker's own file is best named with `METABOB_CONFIG_PATH`: a key in
`~/.metabob/config.json` is shadowed by an installer's `~/.substrate/config.json`.

```json
{ "metabob": { "apiKey": "<the worker's key>", "discoveryEndpoint": "https://ide.metabob.com" } }
```

The identity address comes from discovery's `/bootstrap`, so nothing else is set. The full lookup order, and the
proxy and trust settings, are in the README's Configuration section.

**The dashboard** does not deploy, start, stop or configure agents, and has no tool or skill settings. You log in
with your own API key, and it has four screens:

| Screen | What you do there |
|---|---|
| **Needs you** (`/`) | Rule on conflicts between ledger items (R1); endorse or reject policies an agent proposed (R2); settle findings that need a person: high or critical severity, agents disagreeing, or unclaimed for more than 48 hours; review items credited as misleading |
| **Ledger** (`/ledger`) | Browse by location (repository → directory → file): the policies, constraints, review criteria, instructions and findings that apply at a path, with claim state; author items at a location, supersede or retire them, and triage findings |
| **Activity** (`/activity`) | Who did what to which item, and when, rebuilt from the ledger's own rows |
| **Access** (`/keys`) | List, view, issue, regenerate and revoke API keys; needs a key with the `admin` scope |

Every ledger action in the dashboard needs a key with the `write` scope (or `admin`, which implies it). There are
no roles and no notion of a person as distinct from an agent: what a key can do depends only on its scopes, and an
item's author is the name of the key that wrote it. Rows with no key stamp show their declared author line.

### One named key per worker

Issue each worker its own key in the dashboard's Access screen (`/keys`): a name of at most 100 characters, the
scopes (`read`, `write`, and `admin` only for people who manage keys), and an expiry of 1 to 3650 days if you want
one. The key is shown once. The key's name is the worker's name on the ledger: the dashboard shows authorship as the
writing key's name, so name keys for the loop and the role (`port-planner`, `port-cell-1`, `docs-drift`,
`reviewer`); a loop's acts then read as one group in Activity.

Revoking a key in Access cuts that worker off. A running server re-checks its key every five minutes
(`src/attachment.ts@DEFAULT_HEARTBEAT_MS`); once the key is rejected, shared tools answer `key_rejected` and the
Claude Code edit check stops holding edits. Access has no regenerate endpoint upstream: "regenerate" issues a key
with the same name and scopes, then revokes the old one.

The server also stamps its own declared identity on what it writes (`recorded_by`, `reviewed_by`, `session`, and a
`client_claim` on every write: `src/operator-id.ts@clientClaim`; SPEC § Client claim). These are claims the client
makes, not attribution; the key's name is what identifies the writer.

## 3. Setting up agents and refining their policies, skills and instructions

**What you set up.** Agents in two roles. **Producers** set the process in motion: an agent that a CI runner, a
scheduler or a person starts on an event (a new vulnerability report, a new GitHub issue, an email, a time of day)
investigates and records the work as ledger tasks, or as GitHub issues. **Consumers** take those tasks and do them:
on a timer, or started by the producer once it has recorded them (§ 5 has the runs and cells both are built from).
Beside them sits what both read: policies, constraints and review criteria on the ledger, located by repository
and path, and decisions linked to the repository's anchor.

**The loop it runs.** A producer records tasks; consumers work them, record what they find and credit the guidance
that helped (`success`) or misled them (`failure`). You read what they recorded, then edit the policies and
instructions in the dashboard, and the next consumer works under the change: a misleading decision gets a
correction linked by `contradicts`, a policy agents keep misreading gets clearer text, a brief that left too much
open gets a sharper `Done when:`. Nothing is redeployed for that.

### Base and specific behaviour

An agent's behaviour comes from two places:

| | Where it lives | What it holds | How it changes |
|---|---|---|---|
| **Base** | The initial prompt of the run or cell, the skill, the tool set and the harness's permissions | The agent's role (producer or consumer, and for what), which tools and commands it may use, how it ends, and which ledger items count as authority | Edit the run's definition, the skill's file, `METABOB_TOOLS` or the permissions, and restart |
| **Specific** | The ledger and the memory, read at run time | The policies, rules and decisions for the files it works on, and the brief of the task it takes | Edit them in the dashboard; the next run reads the change |

The base prompt tells the agent where its specific behaviour is and to read it before acting, with the tools that
exist:

- `get_problems` for the queue and the task it takes, and `concept_search { concept_id }` for that task's brief;
- `concept_search { shape: "project_convention" }`, `{ shape: "constraint" }` and `{ shape: "review_criterion" }`
  (with a `query` naming the area) for the rules, keeping the items whose `repo:` and `files:` lines cover its files;
- `concept_neighbors` on the repository's anchor for its decisions, and on the task for earlier handoffs.

So one consumer image, with one base prompt, does different work as the ledger changes: what a person edits in the
dashboard is what the next consumer reads.

**Which policies count is part of the base prompt.** The server applies neither R1 nor R2 when an agent reads
memory: a policy an agent proposed (`status: proposed` in its header) reads just like one a person endorsed, and a
rejected one like one in effect. Recall that applies R1 and R2 is how the system is meant to work; the server
applies neither, so the base prompt does. An endorsement or a rejection is not a change to the policy's own text:
the proposal keeps its `status: proposed` line, and the dashboard writes a separate `finding_verdict` (`concept:
<the policy's id>`, `verdict: endorsed` or `verdict: rejected`, `origin: dashboard`) linked to it with
`derived_from`. Anyone can also leave the `status:` line out. So the base prompt says, for example:

> Before following a `project_convention`, `constraint` or `review_criterion`, read
> `concept_neighbors { concept_id: "<its id>", direction: "incoming" }`. It counts when a linked verdict says
> `verdict: endorsed` with `origin: dashboard` and none says `verdict: rejected`, or when it has no `status:` line
> and its author is one of: <the keys or authors you trust>. Otherwise treat it as a suggestion.

### Producers and consumers

| Producer | Started by | What it records |
|---|---|---|
| Vulnerability intake | CI, on a new advisory for a dependency | A task per affected package or call site, with the advisory in `details` |
| Issue triage | CI, on each new issue | The triage on the issue through `gh`, and a task on the files it concerns (worked example below) |
| Mail intake | A script, on each message to a support address | A task, or a GitHub issue, for each report that names something to change |
| Policy check | CI, on each pull request | A finding for each change that breaks a policy, constraint or review criterion recorded for its files |
| Docs drift | CI, on each merge to the main branch | A doc-drift task per doc the changes affect (worked example below) |
| Nightly sweep | cron, at night | Findings, and tasks for the fixes, for known-bad patterns in a directory |

A consumer is a headless run or a cell whose base prompt says to take one open task, do it under the policies and
brief it reads, and close it or hand it off: the headless loop and the `task pull` loop in § 5 are consumers. It
runs on a timer, or the producer's job starts it after recording the tasks.

**Each agent has the capabilities it needs, and no more**: the harness's tools (`gh`, the test runner, a linter)
allowed by name, the metabob tool set (Tool sets, below), a key of its own, and credentials scoped to its job.
**When something is missing**, a permission, a tool, an input it cannot read, the agent surfaces it in place as a
finding for a person rather than working around it: `record_finding` on the run's own definition (its CI workflow
or container file), saying what it needed and what it could not do. *Needs you* lists a finding of high or critical
severity, and any finding unclaimed for more than 48 hours; a task never escalates there. So record a missing
capability as a finding (a category other than `task`) at high severity when a person should see it at once.

**Input is not authority.** Issue text, email, advisories and memory itself can be wrong or hostile: anyone can
open an issue or send a mail, and any key with `write` can record a policy. A consumer checks what it reads against
its base prompt, which decides what it may do; it never takes an instruction from an issue body, a mail or a brief
that its base prompt does not allow, and a producer records what an input says as data in a task's `details`, not
as a policy.

### Recording policies from docs

Policies and rules usually start in docs: a contributing guide, an architecture decision, a style guide. An agent
goes through the docs and records each rule as a concept in the dashboard's item kinds, located by repository and
path, so people see and edit them in the dashboard's Ledger; an agent-recorded policy is a proposal a person
endorses or rejects in *Needs you*. A policy is a `project_convention` concept whose header block carries its kind,
location and state; the prose after the blank line says the rule and where it came from:

```
concept_create {
  shape: "project_convention", source_type: "memo",
  summary: "<repo>: <the policy, one line>",
  content: "kind: policy
repo: <the repository's identity, e.g. github.com/org/repo>
files: <the paths it applies to; leave the line out for a repository-wide policy>
status: proposed
why: <the rationale a person reads before endorsing>

<the rule, and the doc and section it comes from>"
}
```

Then `concept_link { from_concept_id: "<the policy>", to_concept_id: "<the anchor>", edge_type: "related_to" }`.
A constraint is the same with `shape: "constraint"` and `kind: constraint`, a review criterion with
`shape: "review_criterion"` and `kind: review_criterion`. The server stamps the author lines at the top of the
content (SPEC § concept_create). `status: proposed` is what makes it a proposal: the dashboard shows it in *Needs
you*, with the `why:` line, until a different key endorses or rejects it (R2). An item a person authors in the
dashboard carries no `status` and takes effect when written.

**What is recorded, and where.**

| What | Where |
|---|---|
| Tasks a producer records, and what consumers find | The ledger, on the files they concern |
| Decisions, rejected approaches, policies an agent proposes | Memory: concepts linked to the `repo_anchor` |
| Policies, constraints, review criteria people author | The ledger, at a location, through the dashboard's Ledger |
| Credit on each concept | Its load, success and failure counts and its relevance |
| Rulings and endorsements | The ledger; *Needs you* and Activity show them |
| What each run called, and what each claim and close did | `METABOB_CALL_LOG` on the run's machine |

### Policies on the ledger

The way to change what agents do across a repository is to put it on the ledger, at the location it applies to.
In the dashboard's Ledger, select a path and add:

| Item | Use it for |
|---|---|
| Policy | A rule agents follow at that location |
| Constraint | Something the code there is under |
| Review criterion | What a change there must meet |
| Instruction (a task) | Work to do, with its brief |

Two rules decide what is in effect, and the dashboard is where people apply them:

- **R2.** A policy an agent proposes (`status: proposed`) is pending until a different key endorses it in *Needs
  you*; an item authored directly takes effect when written.
- **R1.** When two items conflict, a person rules (refine, A stands, B stands); until then both are flagged as
  awaiting a ruling.

An agent reads these items through `concept_search` by shape and through the anchor's links, and keeps the ones
its base prompt says count (Base and specific behaviour, above). The one place the server itself reads conventions
is `task pull`'s integration policy, which takes a trusted author's convention whatever its proposal state (§ 7).
It reads the 50 most relevant `project_convention` concepts across the whole organization and then keeps the
repository's (`src/task-pull.ts@readConventions`), and it takes `push_to:`, `integrate:` and `conflicts:` from any
line of a convention, not only its header. So many policies recorded from docs can push a repository's integration
convention out of those 50, and a doc rule that quotes `push_to: main` on a line of its own steers cells. Put the
integration lines in each task's `details`, and keep them out of policies recorded from docs.

### Tool sets

`METABOB_TOOLS`, read once when the server starts (`src/tool-allowlist.ts@parseToolAllowlist`; SPEC § Tool sets):

| Value | Lists |
|---|---|
| unset or empty | The default eleven: the ledger and memory tools plus `init_workspace` |
| `all` | Every tool: the full tool set, with code analysis, the two further memory reads (`concept_sequence`, `concept_usage_stats`) and goal tools. A server before 0.4.0 reads `all` as one tool's name and lists none, so pin 0.4.0 or later where it is set |
| `a,b,c` | Exactly those tools; a name that is no tool lists nothing and is reported at start |

A tool outside the set is refused by name before it runs, on stdio and on the local resolver. Change it in the
server's environment, then restart or reconnect the client. Where to set it in each client (the Claude Code plugin,
a server added with `claude mcp add`, Codex, Cursor and Continue, headless runs) is in SUBSTRATE-GUIDE § 2. A list
is the way to give a worker less: a read-mostly reviewer, for example, without `claim_finding`.

### Skills

| Tool set | Skill |
|---|---|
| Default | `metabob` (`skills/metabob/SKILL.md`): the ledger and memory routine |
| `all` | `metabob-substrate` (`skills/metabob-substrate/SKILL.md`): the full tool set's routine, with the checks before an edit and the code tools |
| A list | `metabob-substrate` when the list includes `path_activity`, `run_goal_async` or `run_goal`; otherwise `metabob` |

The Claude Code and Codex plugins ship both. Without a plugin, copy the skill's folder into the harness's skills
directory, or point the agent's instruction file (`AGENTS.md`) at it. A skill is a file: to change how agents
behave across every repository, edit your copy, or add to the agent's instruction file what your loops need (the
stop reply, follow-up tasks, the credit you expect).

### Start-up instructions

The server sends MCP `instructions` at connect, which clients put in the agent's context before its first call
(`src/server-instructions.ts@serverInstructions`; SPEC § Agent instructions). For the default set they say what the
ledger and memory are for, to load the `metabob` skill, which calls to make first without it, and what
`workspace_undetermined` and a named attachment cause mean. With a cockpit tool listed
(`src/server-instructions.ts@COCKPIT_TOOLS`) they point at `metabob-substrate` instead. For a list, every line naming
a tool the list leaves out is dropped, so the instructions never name a tool the agent cannot call. They are fixed
text; there is no setting to change them. A loop's own rules go in the prompt, the brief or the instruction file.

### The edit check (Claude Code)

The Claude Code plugin holds an agent's first edit of an existing file in a session, once, and asks it to check
the file first: `get_problems`, plus `path_activity` when the server lists it and the repository is not one that
tool reports as unmounted (`scripts/claude-plugin/edit-check.mjs`; README § Claude Code plugin). It holds only where
an attached server's marker covers the session's directory, and never a file already checked through either tool, a
file being created, a second edit of a file, or a file outside the attached workspace. If the check itself fails,
the edit goes through. `METABOB_EDIT_CHECK=off` turns it off. Other harnesses have no hooks for it; under
`METABOB_TOOLS=all` they get the same rule from the `metabob-substrate` skill and the instructions, and under the
default tool set the skill and instructions carry no before-edit step.

### Measuring a loop

A loop improves when each iteration closes more of what it takes, generates work that gets done, and reuses what
earlier iterations left. Everything below reads what already exists; nothing in Metabob computes a loop's trend, so
record the numbers you care about in each iteration's handoff, where the next iteration and you can read them back.

| Question | Read | Needs |
|---|---|---|
| Is the queue draining? | `get_problems`' Tasks header: `(N open: a yours, b unclaimed, c claimed by others, d with a fix pending; e closed)` | Default set |
| Tasks generated against tasks closed | Activity's `created task` lines against `endorsed` and `discarded`, per worker key; or the Tasks header's counts from one iteration's handoff to the next | Dashboard, or the default set |
| Is work stuck before integration? | The `with a fix pending` count and the `fix pending` tags in `get_problems`; Activity's `fix pending` lines | Default set |
| Are iterations finishing or handing off? | `task_handoff` concepts linked to tasks (`concept_neighbors { direction: "incoming" }` on a task); Activity's `released` lines | Default set |
| Is the memory reused? | Each `concept_search` result's relevance and its loaded, succeeded and failed counts. Only `concept_record_usage` (and `mark_complete` on a finding) grows them; `concept_search` and `concept_neighbors` record nothing | Default set |
| Which memory helped, and when? | `concept_usage_stats`: a concept's uses, success and failure rates, and its recent usage rows | `METABOB_TOOLS=all` |
| What did each iteration do? | `METABOB_CALL_LOG`: per call, the outcome, and the result of `claim_finding` (`claimed`, `held`, `lost`, …) and `mark_complete` (`ok`, `pending`, `not_applied`, `not_shared`) | The worker's machine |
| What landed? | Git history: `git log --grep '^Fixes-Finding:' --format='%h %ad %s' --date=short` lists the commits that name a finding | Git |
| Are people keeping up? | *Needs you*; for a repository's proposals, conflicts and rulings, the dashboard repository's own ledger metrics script (`npm run ledger-metrics` in a checkout of that repository, with `DISCOVERY_BASE` and `LEDGER_KEY` set or a `.metabob/config.json`; `--record` writes the results as a concept): time to a decision, uptake of endorsed policies, re-proposals after a rejection | Dashboard |

Signs a loop is working: the open count falls or holds while the closed count grows; the pending count stays
small; lost claims are rare; and the concepts the loop wrote gain recorded uses and successes. Signs it is not: open tasks
grow faster than closes, findings recorded by iterations are never closed, the same summary comes back as `Already
recorded (open)` run after run, and a concept collects `failure` credits with no correction linked by
`contradicts`. Those are the places to change a policy, the skill or the brief.

### Cautions for producers and consumers

- **A proposed policy reads like an endorsed one.** Neither R1 nor R2 is applied when an agent reads memory, so the
  base prompt says which items count (Base and specific behaviour, above).
- **Input can be wrong or hostile.** Issues, mail, advisories and memory are data a consumer checks against its
  base prompt, not authority (Producers and consumers, above).
- **Credit is voluntary.** `mark_complete` folds its own verdict into the finding's relevance, but credit on
  decisions, handoffs and steps is a `concept_record_usage` call the agent chooses to make, and an agent should not
  credit what it wrote itself. Ask for it in the base prompt where a loop depends on ranking.
- **Compiling ledger guidance into skills is planned, not built.** A change to a skill is an edit to its file.

### Worked example: triaging a GitHub issue

A producer started by CI on each new issue (or by cron over the open ones), whose base prompt is to read the issue
and triage it; the triage policies it follows are on the ledger. The harness's own tools act on the issue; Metabob
records the result, and the tasks it records are what consumers take.

- **Capabilities.** `gh` with a token that can read issues and set labels and comments on this repository and
  nothing else, allowed by name; the default tool set; its own key (`issue-triage`):

  ```bash
  --allowedTools "Bash(gh issue view:*)" "Bash(gh issue edit:*)" "Bash(gh issue comment:*)" "mcp__metabob"
  ```
- **Each run consumes** the issue (`gh issue view <n> --json title,body,labels`), the open tasks and findings on the
  files it concerns (`get_problems { file_path }`), and the triage policies (`concept_search { shape:
  "project_convention", query: "issue triage" }`).
- **Each run generates** the triage: labels and a comment through `gh`, and on the ledger either a task on the
  files the issue concerns (the issue's URL and the reproduction in `details`) or, when an open task or finding
  already covers it, nothing new: `record_finding` answers `Already recorded (open)` with the id, which the
  comment can cite. An issue that concerns no file (a question, a request for access) gets a task with the issue as its
  `subject`, closed with its outcome (§ 6).
- **The issue text is untrusted input.** Anyone can open an issue, so the producer treats its text as data: it
  never follows instructions in it, never records it as a policy, and acts only through the commands it is allowed.
  The outgoing guard refuses what looks like a credential in what the producer records, but personal data an issue
  carries is not caught: summarise rather than copy (§ 7).
- **Missing capabilities.** A label the token cannot set, or an issue it cannot read, becomes a finding on the
  producer's workflow file, for a person.
- **Refining it.** A person reads the triage tasks in the Ledger and Activity, rejects or edits the triage
  policies in the dashboard, and the next run follows the change.

### Worked example: keeping docs up to date

A recurring loop driven by change: each run turns the changes since the last run into doc-drift tasks, and the
docs conventions people correct accumulate in memory, so later runs write docs the way people last ruled.

- **Seed.** A `workflow_step` for the run itself (its inputs, its check, what it records) and the docs conventions
  as `decision_record` concepts (where each topic lives, the tense and voice, what a doc may cite), linked to the
  `repo_anchor`.
- **Each run consumes** the previous run's handoff, which names the commit it covered through, and the open
  doc-drift tasks.
- **Each run generates** one task per doc that drifted, with `files` the doc and the code that changed in
  `details`, and a handoff naming the commit it covered and the counts it saw. Give every drift task the same
  summary form (`<repo>: <doc> drifted from the code`): `record_finding` answers `Already recorded (open)` for an
  open finding on the same file with the same summary, so a doc that is still stale reuses its open task rather
  than piling up a new one each run.
- **Closing.** A commit that updates the doc closes its task. A doc checked and found right is an outcome too:
  discard the task, since the drift was not real.
- **Refining it.** When a person corrects a doc a run wrote, the correction becomes a `decision_record` linked to
  the old convention with `contradicts`, and the old one gets a `failure` credit; conventions that runs followed
  and reviewers accepted collect `success`. A rule that must hold goes on the ledger as a policy at `docs/`.
- **Stop.** Each run stops when its drift tasks are recorded, or recorded and worked; the loop itself has no end.
- **Driver.** A scheduled run (§ 5 Scheduled runs).

**This repository's docs ↔ code links as the signal.** `scripts/doclinks.mjs` keeps a database of which docs cite
which code (`docs/links.json`, DOCLINKS.md), and gives a run its input:

```bash
last=<the commit the previous run's handoff names>
git diff --name-only "$last" HEAD > changed.txt
node scripts/doclinks.mjs impacted $(cat changed.txt)   # each linked doc, with the sections that cite the change
node scripts/doclinks.mjs check                          # errors, and drift warnings: a doc older than the code it covers
```

Each doc `impacted` names is a candidate drift task. A doc a run checks and finds right is recorded as reviewed,
which clears the drift warning until the code moves again:

```bash
node scripts/doclinks.mjs reviewed docs/SPEC.md --why "the change renames a local; no documented behaviour moves"
git add docs/links.json && git commit -m "docs(links): record the SPEC review"   # reviewed writes docs/links.json
```

Without such a database, the signal is any mapping from code paths to the docs that describe them; the loop is
the same.

## 4. Sharing information and organizing work among agents

**What you set up.** Sessions on one repository, each with its own key and its own working copy: people's
interactive sessions, a planner that splits work into tasks, parallel workers that each take one, and a reviewer.

**The loop it runs.** The planner seeds tasks with briefs and the decisions they rest on; each worker reads the
queue and the repository's memory, claims a task, works inside the files it owns, records what it notices outside
them as new tasks or findings, closes with the commit, and leaves a handoff when it stops short. The next worker,
on any machine and in any client, starts from what the last one left.

**What is recorded, and where.** Tasks, findings, claims and closes on the ledger; decisions, rejected approaches,
handoffs and ordered steps in memory, linked to the repository's anchor and to the tasks; every act as a line in
the dashboard's Activity.

**How you read it and change it.** `get_problems` in any session, or the dashboard's Ledger and Activity
(Following progress, below). You change the work by recording or retiring tasks, splitting ownership differently,
and ruling on conflicts in *Needs you*; you change how agents behave as § 3 lays out.

### An interactive session

**Claude Code with the plugin** (the server, both skills and the edit check):

```bash
claude plugin marketplace add https://github.com/MetabobProject/metabob-mcp.git
claude plugin install metabob@metabob \
  --config api_key=<the person's key> --config discovery_endpoint=https://ide.metabob.com
claude mcp list       # shows plugin:metabob:metabob … ✔ Connected
```

Use the https URL: the `MetabobProject/metabob-mcp` shorthand makes Claude Code clone over ssh, which fails on a
machine with no GitHub ssh key. `api_key` is kept as a sensitive setting; `/plugin configure` changes the settings
later, and a blank one falls back to the config file (§ 2). If the first start takes longer than Claude Code's
connect timeout, `/mcp` shows the server failed; reconnecting there starts it from the npx cache (README § Claude
Code plugin). The plugin's server takes `METABOB_TOOLS` from Claude Code's environment: set it in
`~/.claude/settings.json` as `{ "env": { "METABOB_TOOLS": "all" } }`, or export it in the shell that starts
`claude`, then restart or reconnect.

**Codex with the plugin** (the server and both skills; Codex has no hooks, so no edit check):

```bash
codex plugin marketplace add https://github.com/MetabobProject/metabob-mcp.git
codex plugin add metabob@metabob
codex mcp list        # shows metabob … enabled
```

The Codex plugin takes no settings: the key and discovery address come from the config file (§ 2). Codex starts the
server in the plugin's folder, so every tool answers `workspace_undetermined` until the agent calls `init_workspace
{ workspace_path: "<the project's absolute path>" }`, which the skill does (README § Codex plugin). For
`METABOB_TOOLS=all`, which the plugin's server cannot take, replace the plugin with a server you add, and install
the skill by hand from a checkout of this repository (SUBSTRATE-GUIDE § 2):

```bash
codex plugin remove metabob@metabob
codex mcp add metabob --env METABOB_TOOLS=all -- npx -y @metabob/mcp@<version>
cp -R skills/metabob-substrate ~/.codex/skills/
```

**Other clients** (Cursor, Continue, Claude Desktop, `claude mcp add`): README § Integrations.

- **Start:** start the client in the project.
- **Key and configuration:** the person's own worker key, in the plugin's settings (Claude Code), the config file
  or the client's MCP `env`. The default tool set suits most sessions (§ 3 Tool sets).
- **Reads and writes:** with the `metabob` skill loaded, it reads the queue and the repository's memory at the start,
  claims what it takes, records what it notices, and closes what it commits; USER-GUIDE § 2 lists it.
- **Stops:** when the person ends it. Unfinished work should get a handoff and a released claim first ("stop here
  and hand this off").

### A planner

A planner is a session whose output is ledger entries rather than code. It seeds a loop, and re-plans it when the
generated tasks show the plan was wrong.

- **Start:** an interactive or headless session with the default tool set, told to split the work.
- **Key:** its own, for example `planner`, so its tasks are attributed to it.
- **Writes:** one `record_finding` per unit of work in category `task`, with `files` set to what the task owns and a
  brief in `details` (Goal, Owns, Out of bounds, Done when, Read first), as the `metabob` skill's "Handing work to
  other agents" section lays out. A task meant for a cell can carry its integration policy as lines in `details`
  (`push_to: main|task`, `integrate: push|review`) and a `ref: <branch>` to clone (§ 5 Agent cells). Decisions
  and rejected approaches go into `concept_create` as `decision_record` concepts, linked to the repository's
  `repo_anchor`; ordered work goes in as `workflow_step` concepts linked with `sequence_next`.
- **Reads:** `get_problems` first, so it does not record a task that is already open.
- **Stops:** when the tasks are recorded. Nothing the planner writes starts a worker: a driver has to.

A person can do the planner's job from the dashboard: "Add here" on a Ledger node records a task at that location.
Its first line is the summary, the whole text is the brief, severity defaults to MEDIUM, and it carries no
`push_to` / `integrate` lines, so a cell applies its defaults.

### Parallel workers

- **Start:** one session per task, each in **its own working copy** (a separate clone or a `git worktree`), each
  told only its task's concept id ("work task concept_…").
- **Key:** one per worker.
- **Reads and writes:** each finds its task with `get_problems` (summary, files, holder and concept id) and reads
  the brief with `concept_search { concept_id }`, claims it with `claim_finding`, stays inside the
  task's `Owns:` files, and closes it with `mark_complete` after committing and pushing.
- **Stops:** when its task is closed or handed off.

Who counts as one claimer is the server's identity: `metabob-mcp-<hash(key + workspace)>`, or `VESSEL_ID` when set
(`src/vessel-identity.ts@resolveVesselId`). Two sessions with one key in one working copy are one claimer, so a
claim does not keep them apart; separate keys or separate working copies do, and separate working copies also keep
their edits apart.

### A reviewer

A reviewer reads work other agents did and records its judgment; it does not grade its own work. In a loop it is
the step between a fix pending and a close.

- **Start:** an interactive or headless session on the branch or commits under review.
- **Key:** its own (`reviewer`), with `write`: verdicts and findings are writes. A key with only `read` writes
  nothing shared: every write answers `key_read_only`, and `record_finding` and `mark_complete` keep only their
  local half (SPEC § Read-only key).
- **Reads:** the review criteria recorded for the repository. Nothing in the server reads them specially: the agent
  finds them with `concept_search { shape: "review_criterion" }` or by following the links into the repository's
  anchor with `concept_neighbors`.
- **Writes:** `record_finding` for each problem the change leaves; `mark_complete discard` for a finding that is
  not real; a `decision_record` for a judgment the next reviewer would otherwise have to reach again.
- **Under `push_to: task` with `integrate: review`:** a cell's fix sits on `task/<task id>` as `fix pending
  (awaiting merge)`. Merging it is the reviewer's or a person's act in git; `finding close` (or an endorse after a
  fetch) then closes the finding.

### Claims

A claim is how a worker says it has a task (`claim_finding`; SPEC § claim_finding). Its length is the time a loop
loses when an iteration dies without releasing it, so keep claims short and renew them:

| | |
|---|---|
| Length | 60 minutes by default, at most 240 (`minutes`); `task pull --minutes` sets it for a cell |
| Renew | `action: "renew"` before it ends, for long work; renewing a claim it does not hold is refused |
| Release | `action: "release"` when stopping without finishing, after leaving a handoff |
| End | The claim's start plus its minutes, by the shared clock; readers treat it as live until two minutes past that |
| Contest | Two workers can both write a claim; every reader picks the same holder, the earliest live claim, the lower id on a tie (`src/tools/_claims.ts@claim-holder`), and the later claimer withdraws |
| Close | A verdict that closes the finding, by anyone, ends every claim on it (a pending endorse does not); an endorse of a finding someone else holds goes ahead, and the reply names their claim |
| Stop | A server shutting down normally releases the claims its session took through `claim_finding`; a kill or crash leaves them to lapse; `task pull`'s claim outlives its own process and the harness, even when the agent claims or renews it again under the same identity |

The Ledger screen marks two live claims on one file as an overlap.

### Disjoint ownership

Parallel workers stay out of each other's way because their tasks own different files. Record each task's `files`
and an `Owns:` / `Out of bounds:` pair in its brief, and keep the `Owns:` lists of concurrent tasks disjoint. A
worker that needs to change a file outside its task records that as its own task instead of widening its own: that
is the loop generating work, and the new task gets an owner of its own.

### Following progress

| Where | What it shows |
|---|---|
| `get_problems` (any worker's session, or yours) | Open tasks with their holders and claim ends, fixes pending, problems, and what recently closed |
| Dashboard **Ledger** | Each path's tasks, findings, claims and guidance; hotspots, overlaps, blind spots and conflicts on the tree |
| Dashboard **Activity** | One line per act: recorded finding, created task, claimed, released, endorsed, discarded, fix pending, proposed, added, rejected, ruled, flagged conflict |
| `METABOB_CALL_LOG=<file>` | On the worker's machine: one JSON line per tool call, with the tool, argument names and sizes, the outcome, the claim or close result, and the duration, never a value (`src/call-log.ts@logCall`; SPEC § Call log) |

The dashboard caches its reads for 60 seconds; "Read again" behind its Source toggle drops the cache, and needs no
`write` or `admin` scope. § 3 Measuring a loop says how to read these iteration over iteration.

### Pending fixes and merges

A close records where the fix is, and is not taken on the worker's word (SPEC § mark_complete):

| The fix is | The finding |
|---|---|
| Uncommitted | Stays open, `fix pending (uncommitted)` |
| Committed, on no remote branch (in a checkout with a remote) | Stays open, `fix pending (unpushed)` |
| Pushed only to `task/…` branches | Stays open, `fix pending (awaiting merge)` until merged |
| On any other remote branch (`mark_complete`) or merged into the target (`finding close`) | Closed, with the commit |

A worker not allowed to push leaves its findings pending; that is the right state, and the person who pushes or
merges closes them afterwards (`mark_complete endorse` after a fetch, or `finding close`). A loop whose pending
count grows while its closed count stays flat is waiting on its merge step, not on its workers.

### Stopping work

- **Ask for a handoff.** A worker told to stop writes a `task_handoff` linked to its task and releases its claim,
  so the next worker can start at once.
- **Kill it.** A worker whose server shuts down normally (the client exits, or `timeout` sends SIGTERM) releases
  the claims it took through `claim_finding`. A worker killed outright (SIGKILL) or crashed, and a cell's claim from
  `task pull`, stay live until their end (plus the two-minute skew), then the task is free again. Nobody else can
  take it before then, short of closing the finding. A new cell container under the same identity resumes a task
  that identity still holds (§ 5 Agent cells).
- **Stop the driver.** A loop ends when its driver stops starting iterations: the script's cap, the scheduler's
  entry, the launcher. Stopping the driver lets running iterations finish.
- **Cut it off.** Revoke its key in Access.
- **Take the task off the queue.** Triage it in the dashboard's Ledger (resolved or retracted), or close it with
  `mark_complete`; a closed task shows no claim and `task pull` skips it.

### What exists and what does not for shared work

- **Concurrency is advisory.** A claim keeps honest workers off one task; it does not lock files, and two workers
  can both claim before either reads the other's claim (the rule then picks one, and the other withdraws).
  Disjoint `Owns:` lists and separate working copies are what keep parallel workers apart.
- **There are no notifications.** Recording a task wakes no one, and the dashboard sends no alerts. An agent learns
  of a task only when it reads the ledger; people learn of what needs them by opening *Needs you*.

### Worked example: changing a program's language

A port of a library from one language to another, module by module, against a conformance suite that both
versions must pass.

- **Seed.** A planner reads the source's module structure and records:
  - one `decision_record` per binding convention (how names map, how errors become exceptions or results, which
    numeric types stand for which), each with the alternative it rejects, linked to the `repo_anchor`;
  - `workflow_step` concepts in dependency order (modules with no dependencies first), linked with
    `sequence_next`;
  - one task per module whose dependencies are ported, with `files` the target module and its tests, `Read first:`
    naming the conventions and the step, and `Done when:` the conformance suite's run for that module.
- **Each iteration consumes** one module task: it claims it, reads the conventions, ports the module and runs the
  suite's part for it.
- **Each iteration generates:**
  - a finding for each behaviour the port cannot match yet (category `conformance`, on the target files);
  - a task for a change outside its files, such as a shared helper the module needs;
  - a `decision_record` for a binding question no convention settled;
  - when its step closes, the next step's tasks, by following `sequence_next`.
- **Memory.** The binding conventions grow with every module. Later workers read them through the anchor, credit
  the ones that held (`concept_record_usage success`) and mark the ones that misled (`failure`), with a corrected
  decision linked by `contradicts`. By the middle of the port, recall ranks the conventions that survived first.
- **Stop.** The whole conformance suite passes and no task is open.
- **People rule on** conventions agents propose, conflicts between two workers' decisions, and whether a mismatch
  is a divergence to accept (discard the finding) or a bug to fix.
- **Driver.** A planner once, then parallel workers; modules are natural disjoint `Owns:` lists. At scale, cells
  take the module tasks with `task pull` (§ 5).
- **Watch for** files every module touches (an index module, the build configuration): give them to one task of
  their own. Mismatch findings that stay open after the module closes are the port's real backlog.

### Worked example: rebuilding and modernising

A framework upgrade or an architecture change: every component moves from the old pattern to the new one, and
behaviour must not change.

- **Seed.** An inventory iteration finds every component on the old pattern (with `search_codebase` and
  `analyze_impact` under `METABOB_TOOLS=all`, or with grep), then records:
  - `decision_record` concepts for the target patterns and the rejected ones (`Rejected: <a compatibility shim> —
    <why it fails>`), so no iteration tries the rejected path again;
  - an ordered `workflow_step` chain: shared infrastructure first, then components, then removing the old
    dependency; where steps can run side by side, branches off one step, each with its condition in the link's
    `description`;
  - one task per component in the current step, with `Done when:` its existing tests plus a parity test that runs
    the same inputs through the old and the new behaviour.
- **Each iteration consumes** one component task and generates a finding for each parity break it cannot fix in
  its files, a task for each call site outside them, and, on closing the last task of a step, the next step's
  tasks. Where steps join, it checks that every step leading in is closed before recording the next.
- **Memory.** Target patterns and rejected ones, each with `Revisit when:`; handoffs on half-migrated components
  (`Done:`, `Left:`, `Watch:`), which the next iteration reads with `concept_neighbors` on the task.
- **Stop.** The inventory check finds no component on the old pattern, and the step that removes the old
  dependency is closed.
- **People rule on** the target patterns before the first component moves (a proposed decision they endorse in
  *Needs you*), and on each merge: wide changes suit `push_to: task` with `integrate: review` and a reviewer.
- **Driver.** A planner, parallel workers and a reviewer; at scale, cells with the review policy (§ 5).
- **Watch for** components that change together: `predict_cochanges` (under `all`) on a component's files shows
  what else its history touches, and those files belong in one task. Long tasks need `claim_finding renew`.

## 5. Workflows that run in many sandboxed cells

**What you set up.** A driver outside Metabob (a script, a launcher, a scheduler) that starts unattended
iterations: headless runs in working copies, or cells, each one task in its own container with a fresh clone. Each
gets a key, a config file, a wall time, a budget and exactly the permissions its task needs. Producers and
consumers (§ 3) are built from these: a CI job on an event, or a cron entry, runs a producer as a headless run; the
producer records tasks; and cells, started on a timer or by the producer's job, consume them. The cell's initial
prompt is its base behaviour, and the task brief and the policies it reads are its specific behaviour (§ 3 Base
and specific behaviour), so many cells from one image do different work.

**The loop it runs.** The driver asks the ledger for work (`task pull`'s exit code, or a headless run's stop
reply), starts an iteration per task, and lands what the iteration committed; the iteration records follow-ups and
the next step's task, which a later pull takes. The loop runs until the queue is empty or the driver's cap.

**What is recorded, and where.** The claim, the task and its integration policy in `task.json` and `context.md`;
the close or the pending fix on the ledger after `finding close`; each tool call in `METABOB_CALL_LOG` on the cell;
the harness's transcript where the driver puts it; and the agent's findings, tasks and handoffs on the ledger and in
memory as in § 4.

**How you read it and change it.** The exit codes and the call log per cell, Activity per worker key, and the
queue in `get_problems` (§ 3 Measuring a loop). You change a cell's base behaviour through its prompt, its
permissions, its tool set and skill, and the trust list for conventions; you change its specific behaviour in the
dashboard, through the policies it reads and its task's brief and `details` (the integration policy among them).

### Unattended headless runs

A headless run is a single prompt that runs to the end with no one to answer a permission prompt, so it has to be
told everything and allowed exactly what it needs. It is one iteration; the loops below repeat it.

**Claude Code** (`claude -p`):

```bash
cd /path/to/checkout
timeout 1800 claude -p "Work task concept_…: find it with get_problems, read its brief with concept_search
{ concept_id: <that id> }, claim it, do it, commit with the trailer 'Fixes-Finding: <an agf_ id from the
brief's finding_ids: line>', push, then mark_complete it." \
  --mcp-config ./metabob-mcp.json --strict-mcp-config \
  --permission-mode acceptEdits --allowedTools "mcp__metabob" "Bash(git:*)" \
  --max-budget-usd 5 --output-format stream-json --verbose > transcript.jsonl
```

with `metabob-mcp.json`:

```json
{ "mcpServers": { "metabob": { "command": "npx", "args": ["-y", "@metabob/mcp@<version>"],
  "env": { "METABOB_CONFIG_PATH": "/path/to/worker-config.json", "METABOB_CALL_LOG": "/path/to/calls.jsonl" } } } }
```

- `--mcp-config` with `--strict-mcp-config` starts only this server, with the worker's own config. `--plugin-dir
  <dir>` loads a plugin from a directory; the lab cell gives it a copy of the plugin without its `.mcp.json`, so the
  run gets the skills and the edit check and keeps its own server entry (§ 5 Agent cells).
- `--permission-mode` takes `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk` or `plan`;
  `--allowedTools` and `--disallowedTools` list what is allowed or refused without asking. Keep
  `bypassPermissions` for a container that holds nothing else.
- Claude Code's `--help` lists no turn limit. The limits are `--max-budget-usd` (with `--print` only) and a wall
  time from outside (`timeout`).

**Codex** (`codex exec`):

```bash
codex exec --sandbox workspace-write --json -o last-message.txt \
  -c 'mcp_servers.metabob.env.WORKSPACE_PATH="/path/to/checkout"' \
  "Work task concept_…: …"
```

- `--sandbox` takes `read-only`, `workspace-write` or `danger-full-access`. `workspace-write` may block network
  access, so a `git push` from inside the run can fail: allow network for the push, or push from outside the run.
- `-c key=value` overrides a `~/.codex/config.toml` value, including a server's environment under
  `mcp_servers.<name>.env`, which is where `codex mcp add --env` writes it. It works for a server added with
  `codex mcp add`, as above.
- The plugin's server is not a `config.toml` entry and takes no settings. Codex starts it in the plugin's folder,
  so with the plugin, rely on the skill calling `init_workspace { workspace_path }` (SPEC § Workspace).
- `codex exec` has no budget flag; put a wall time around it.

**Stops:** when the harness exits, or when the wall time or budget cuts it off. A run cut off mid-task leaves its
claim to lapse (§ 4 Claims).

### Harness permissions and limits

- Allow the metabob tools and the git commands the task needs; refuse what it must not do (the lab cell refuses
  `WebFetch` and `WebSearch`).
- Cap the spend (`--max-budget-usd` in Claude Code) and the wall time (`timeout`); neither CLI lists a turn limit.
- Give the agent nothing it should not use: the lab cell keeps the key in a 0600 config file the server reads
  (`METABOB_CONFIG_PATH`) and out of the harness's environment, and holds no git credential.
- Tell it in the prompt how to end: the commit trailer, whether to push, and to close or hand off; and, for a loop
  that should generate work, to record follow-up tasks and the next step's task.

### A headless loop

Two ways to work tasks one after another with no one watching. Both need permission to push, or every fix stays
pending (§ 4 Pending fixes and merges).

**A `claude -p` loop in one checkout.** Each round is one session. Neither CLI tells the script whether a task was
open, so the prompt asks for a reply the script stops on:

```bash
cd /path/to/checkout      # this loop's own working copy (a clone or a git worktree)
prompt="Use the metabob skill. Take one open task nobody holds and finish it or hand it off: run its done \
checks, commit with the trailer 'Fixes-Finding: <an agf_ id on the brief's finding_ids: line>', push, then \
mark_complete it. A task marked fix pending is not open. If none is open and unheld, reply only NO_OPEN_TASKS."
for i in $(seq 1 20); do                               # the cap on rounds
  out=$(timeout 1800 claude -p "$prompt" \
    --mcp-config ./metabob-mcp.json --strict-mcp-config \
    --permission-mode acceptEdits \
    --allowedTools "mcp__metabob" "Bash(git:*)" "Bash(npm test:*)" "Bash(npm run:*)" \
    --max-budget-usd 5) || break
  case "$out" in *NO_OPEN_TASKS*) break ;; esac
done
```

- `--allowedTools` lists the metabob tools, git (the push included) and the commands the tasks' done checks run;
  `npm test` and `npm run` stand for your project's own (`Bash(bun test:*)`, `Bash(make check:*)`). A headless run
  refused a command has no one to ask, so allow every check a brief may name.
- `metabob-mcp.json` is the one in § 5 Unattended headless runs. With `--strict-mcp-config` the run's server is that
  one; give the run the skill as a copy in `~/.claude/skills/` (USER-GUIDE § 1) or with `--plugin-dir`.
- It stops on `NO_OPEN_TASKS`, on a failed run (any non-zero exit, `timeout`'s 124 included) and at the cap. It also
  stops when every remaining task is held by someone else; run it again later, or from a scheduler.

**A `task pull` loop.** Each round gets fresh directories, as `task pull` requires, and the exit code decides what
happens next:

```bash
export VESSEL_ID=loop-payments-1                  # one identity for task pull, the server and finding close
export METABOB_CONFIG_PATH=/path/to/worker-config.json
ORIGIN=https://github.com/acme/payments.git
for i in $(seq 1 20); do
  round=$(mktemp -d)
  metabob-mcp task pull --origin "$ORIGIN" --task-dir "$round/task" --work-dir "$round/work" --json \
    > "$round/pull.out" 2> "$round/pull.err"
  rc=$?
  case $rc in
    0) ;;                                                   # pulled: work it below
    3) break ;;                                             # nothing open: done
    4) until=$(grep '^{' "$round/pull.err" | tail -1 | jq -r .retry_after)   # held by others: wait
       sleep "$(node -e 'console.log(Math.max(5, Math.ceil((Date.parse(process.argv[1]) - Date.now()) / 1000)))' "$until")"
       continue ;;
    *) cat "$round/pull.err" >&2; exit "$rc" ;;             # 2: not attached (attach --check); 1: read the message
  esac
  task="$round/task/task.json"; id=$(jq -r .task_id "$task"); push_to=$(jq -r .policy.push_to "$task")
  ( cd "$round/work" &&
    timeout 1800 claude -p "Work task $id. Read $task and $round/task/context.md first. Commit with a \
message whose last line is: Fixes-Finding: $id. Do not push." \
      --mcp-config /path/to/loop-mcp.json --strict-mcp-config --permission-mode acceptEdits \
      --add-dir "$round/task" \
      --allowedTools "mcp__metabob" "Bash(git:*)" "Bash(npm test:*)" --max-budget-usd 5 &&
    git fetch origin main && git rebase origin/main &&
    git rev-list origin/main..HEAD > "$round/commits" &&
    git push origin "HEAD:$push_to" &&
    metabob-mcp finding close --commits-from "$round/commits" --task "$task" ) || echo "round $i: $id not landed" >&2
done
```

with `loop-mcp.json` starting the installed bin under the same identity:

```json
{ "mcpServers": { "metabob": { "command": "metabob-mcp",
  "env": { "METABOB_CONFIG_PATH": "/path/to/worker-config.json", "VESSEL_ID": "loop-payments-1" } } } }
```

- `task pull`'s `--json` reply for an exit other than 0 is the last JSON line on standard error, after any
  `warn:` lines, so the loop reads `retry_after` from there.
- `finding close` runs in the clone (its `--work-dir` defaults to the current directory) and takes the target from
  `--task`, since its default task file is `/task/task.json`.
- The landing steps follow the task's policy (§ 5 Agent cells, Where the fix goes). A rebase that stops on a
  conflict ends the round unpushed. The round's directory keeps the work; the next round, under the same identity,
  takes the task again from a fresh clone while the claim is live, and after the claim ends any worker may take it.

### Agent cells

A cell is one task, one container, one fresh clone. `metabob-mcp task pull` and `metabob-mcp finding close` are its
entry and exit steps; both run under Node and need no Bun.

```bash
metabob-mcp task pull --origin <git url> [--task-dir /task] [--work-dir /work] [--minutes 60] [--trust <id,…>] [--json]
# the harness works in /work and commits with the trailer  Fixes-Finding: agf_…
cd /work      # git and finding close run in the clone (finding close's --work-dir defaults to the current directory)
git fetch origin main && git rebase origin/main
git rev-list origin/main..HEAD > /tmp/commits          # this cell's own commits only, listed before the push
git push origin "HEAD:$(jq -r .policy.push_to /task/task.json)"     # main, or task/<task id>
metabob-mcp finding close --commits-from /tmp/commits [--target <branch>] [--task /task/task.json] [--json]
```

**Where the fix goes.** `task.json`'s `policy` decides the branch to push and the target `finding close` checks
(`src/finding-close.ts@runFindingClose`: `--target`, else `main` under `integrate: review`, otherwise `push_to`,
else `main`). The rebase and the list of the cell's own commits are against `origin/main` in every case:
`origin/task/<task id>` does not exist before the cell's first push.

| `push_to` | `integrate` | Push | `finding close` checks | The finding |
|---|---|---|---|---|
| `main` (default) | `push` (default) | `HEAD:main` | `main` | Closed by the push: no review |
| `task` | `review` | `HEAD:task/<task id>` | `main` | `fix pending (awaiting merge)` until someone merges the branch; run `finding close` again after the merge |
| `task` | `push` | `HEAD:task/<task id>` | `task/<task id>` | Closed once the task branch is pushed: no review, and nothing reaches `main` |
| `main` | `review` | `HEAD:main` | `main` | Closed by the push: pushing to `main` is the merge, so no review happens |

Only the second row holds work for review. The clone starts at the task's `ref:` when it declares one; the policy
still integrates into `main`.

**What `task pull` takes** (`src/task-pull.ts@runTaskPull`, `src/task-pull.ts@candidateTasks`): open findings in
category `task` on the origin's repository, in this order:

1. a task this cell's identity already holds, so a new container under the same identity resumes it (Resuming a
   cell's task, below);
2. then unclaimed tasks, most severe first.

A task someone else holds, a closed one and one with a fix pending are skipped. Each candidate is claimed with
`claim_finding`'s rule; a held, lost, unsettled or refused claim moves on to the next. On a claim it writes
`task.json` (the task, its files and details, the claim, the integration policy and `base`) and `context.md` into
the task directory and clones the origin into the work directory, at the task's `ref:` when it declares one. If
writing or cloning fails, or the `ref:` is not a valid branch name (`src/task-pull.ts@validRef`), the claim is
withdrawn, so one bad task does not block every cell for the claim's length.

**Its exit codes:**

| Code | Meaning | What the launcher does |
|---|---|---|
| 0 | A task was pulled | Start the harness |
| 3 | No open task, or none could be claimed and none is held by others | Stop: the queue is empty |
| 4 | Open tasks exist, but others hold them or a claim did not settle (that claim is withdrawn) | Wait until `retry_after` (with `--json`: the earliest claim end, or about 30 s ahead after an unsettled claim), then pull again |
| 2 | Not attached | Fix the key or address (`attach --check`) |
| 1 | Any other failure | Read the message |

**The integration policy** (`src/task-pull.ts@integration-policy`) says where the fix goes: `push_to` (`main`, or
`task` for `task/<task id>`), `integrate` (`push` or `review`) and `conflicts` (`rebase`), each from the task's
`details`, else from a `project_convention` concept for the repository by a trusted author, else the defaults
`main` / `push` / `rebase`. Trusted authors are `--trust` or `METABOB_TASK_TRUST`, and by default the task's own
recorder. Authors are declared, not verified, so the trust list is a convention among cells, not a security
boundary.

**What `finding close` closes** (`src/finding-close.ts@runFindingClose`): each finding a `Fixes-Finding: agf_…`
trailer in the listed commits names (`src/finding-close.ts@trailerIds`), only when it is an open finding of this
repository and only once the fix is merged into the target (Where the fix goes, above; the task's policy is read
from `--task`, else `/task/task.json`):

| State of the fix | Result |
|---|---|
| In `origin/<target>`, or a commit there carries the same trailer line | Endorsed, with that commit |
| Merged, then reverted on the target | Reported as reverted; nothing written |
| Pushed to some branch, not merged (as under `review`) | `fix pending (awaiting merge)`; run `finding close` again after the merge |
| On no remote branch | Reported as unpushed; nothing written |
| Not an open finding of this repository | Reported as unknown; nothing written |
| Already closed | Reported as already closed; nothing written |
| The close or the pending verdict could not be written | Reported as refused, with the reason |

Its exit codes are 0 (done, each finding's outcome reported), 2 (not attached) and 1 (any other failure, including a
failed fetch). List the commits with `git rev-list origin/main..HEAD` after the rebase, never `<base>..HEAD`,
which after a rebase also holds other cells' merged commits.

**Identity in a cell.** Set `VESSEL_ID` to one value per cell and pass it to `task pull`, the harness's server and
`finding close`. Without it each derives its identity from the key and the work directory, and `task pull` does so
before the clone exists while the server does so after it, so they differ: the agent reads the claim `task pull`
took as someone else's and takes another task. The lab cell's entrypoint sets it from `CELL_VESSEL_ID`, else
`metabob-cell-<container hostname>`.

**Resuming a cell's task.** `task pull` takes a task its identity already holds before any other, but only into
task and work directories that are empty or missing; anything else exits 1 (`src/task-pull.ts@runTaskPull`). So:

- **Restarting a container whose pull succeeded exits 1.** The lab entrypoint never clears `/task` or `/work`, and
  both survive a restart in the container's filesystem.
- **A new container without `CELL_VESSEL_ID` cannot resume.** It has a new hostname, so a new
  `metabob-cell-<hostname>` identity, which reads the old claim as someone else's.
- **To resume, give each cell a stable `CELL_VESSEL_ID`** (or `VESSEL_ID` in your own entrypoint) **and start a
  new container with it.** Its fresh `/task` and `/work` let `task pull` run, and the same identity takes its own
  claim first. It resumes only while that claim is live: `--minutes` (the lab's `CELL_CLAIM_MINUTES`, 45) plus
  the two minutes readers allow (§ 4 Claims); after that any cell may take the task. Work the old container had not
  pushed does not carry over: the new one starts from a fresh clone.

**The reference recipe** is the lab cell (`lab/cell/Containerfile`, `lab/cell/entrypoint.sh`, lab/README.md
§ Agent cell): `task pull` with a 45-minute claim, `claude -p` with a model, budget and wall time from `CELL_*`
variables, web tools refused, the key only in a private 0600 config file the harness's environment does not carry,
and `METABOB_CALL_LOG` into the result bundle. It is built for judging work, so it **never pushes and never runs
`finding close`**: its work is judged outside the cell.

**A cell that lands work** starts from that recipe and drops what keeps the lab cell from pushing. The lab
entrypoint empties git's `credential.helper`, sets `GIT_ASKPASS=/bin/false` and `GIT_TERMINAL_PROMPT=0`, and sets
the push URL to `no-push://the-cell-does-not-push`; a landing cell's entrypoint leaves those out and, after the
harness exits, runs in `/work` (the entrypoint, not the agent):

1. `git fetch origin main && git rebase origin/main`, the `rebase` conflict rule; a conflict ends the cell with
   nothing pushed;
2. `git rev-list origin/main..HEAD > /tmp/commits`: the cell's own commits, listed before the push;
3. `git push origin HEAD:<push_to>`, the branch from `task.json`'s policy (Where the fix goes);
4. `metabob-mcp finding close --commits-from /tmp/commits`, which reads the target from `/task/task.json`.

The git credential is for step 3 alone. Scope it to the one repository, and give it to git only for the push,
after the harness has exited, so the agent's session never holds it. Where review is wanted, let it push `task/*`
branches and not `main` (protect `main` on the git host): a task or a convention that says `push_to: main` then
fails at the push instead of landing unreviewed (§ 7).

### Scheduled runs

Nothing in Metabob schedules or starts an agent. A scheduler you run (cron, a systemd timer, a CI schedule) starts a
headless run or a cell, and uses `task pull`'s exit code to pace itself: 3 means there is nothing to do, and 4's
`retry_after` is when to try again. Each scheduled run is a worker like any other: its own key, its own working copy
or container, a wall time and a budget. A scheduled run is also how a loop driven by change gets its trigger: a CI
job on each merge, or a nightly timer, runs the iteration that turns new changes into tasks, as in the docs loop
(§ 3 Worked example: keeping docs up to date), whose drift tasks the same or a later run then works in cells.

### What exists and what does not for cells

- **There is no orchestrator.** Nothing in Metabob starts, schedules or scales cells. An outside loop runs `task
  pull` and starts the harness on exit 0, as above; the exit codes are what it paces itself by.
- **Cells do not push on their own.** The reference lab cell never pushes and never runs `finding close`. A cell
  that lands work does so in its entrypoint, after the harness exits, with a credential the agent never holds; you
  write that entrypoint from the recipe above.
- **The next step is recorded by convention.** When a step's task closes, recording the next step's task is the
  agent following the skill (`sequence_next` from the step, then `record_finding`). Nothing records it
  automatically, so ask for it in the prompt; a later `task pull` takes it once it exists.

### Worked example: using a repository as a harness for another task

The repository holds the scaffolding for work that is not code: an evaluation, a data-processing job, a research
question. Fixtures, graders, scripts and inputs are in git; the results are files the runs commit. Tasks and
findings record the runs and their results, and follow-ups generate more runs.

- **Results in the repository, or as the outcome.** A run whose results belong in the repository names its
  results file (`runs/<run>/RESULTS.md`) and closes by the commit that writes it; the file must not be ignored by
  `.gitignore` (a finding on ignored files closes as local, with no commit), and `finding close` needs an `origin`
  remote to fetch. A question whose answer is the result names the question as its `subject` and closes with the
  answer as its outcome, with the report or run log in `evidence` (§ 6).
- **Seed.** One task per run, input shard or question; `decision_record` concepts for the method (the grader, the
  metric, and the ones rejected, with why).
- **Each iteration consumes** one run task: it runs the scripts, writes the results file and commits, and the
  cell's entrypoint pushes and runs `finding close`; or, for a question, it answers it and closes the task with
  `mark_complete` and its outcome.
- **Each iteration generates** findings on what it saw go wrong (a flaky grader, a malformed input, on the files
  involved) and follow-up tasks (a rerun with a changed setting, an outlier to look into), each on its own results
  file or with its own subject, for later cells to pull.
- **Memory.** The method, known-bad inputs and grader caveats, credited by the runs that relied on them. Write the
  reasons and the outcome, not the data: fields are capped (summary 2 KB, details 8 KB, a concept 16 KB), and the
  data belongs in the repository.
- **Stop.** `task pull` exits 3, and a summary task's `Done when:` holds (for example, a summary file that reports
  each metric with its runs).
- **People rule on** the method, and on when the results are enough.
- **Driver.** A `task pull` loop or a launcher of cells, so runs do not share state.
- **Watch for** secrets and personal data in inputs: the outgoing guard refuses what looks like a credential, not
  everything sensitive, and everything written is readable across the organization (§ 7).

### Worked example: investigating an application's behaviour and cloning it

Observe an application from outside, write down each behaviour with its evidence, and rebuild it until the clone
passes the tests the observations became.

- **Seed.** Observer iterations run the application and record each observed behaviour as a concept: a behaviour
  spec. `concept_create`'s `shape` is free text, so pick one name and keep to it (`behaviour_spec`); a later
  iteration lists them with `concept_search { shape: "behaviour_spec" }`. Link each to the `repo_anchor`.

  ```
  concept_create {
    shape: "behaviour_spec", source_type: "memo",
    summary: "<repo>: <behaviour, in a line>",
    content: "Behaviour: <what the application does>
  Given: <inputs and state>
  Observed: <the output, exactly where it matters>
  Evidence: <the command or steps, and the committed transcript under observations/>
  Varies: <what changes between runs: times, ids, ordering>"
  }
  ```

- **Each behaviour generates** a golden test (a committed file that reproduces the observation) and an
  implement-and-verify task on the clone's files and that test, with the spec's concept id in `Read first:` and
  `Done when:` the golden test passing.
- **Each implementer cell consumes** one such task. It generates an observation task when it hits a case no spec
  covers (on the observations file for that area), and a finding when a golden test turns out to fix something that
  varies between runs.
- **Memory.** The specs, corrected by later observations linked with `contradicts`; rejected implementation
  approaches; credit on specs that held up when implemented.
- **Stop.** Every golden test passes and no observation or implementation task is open.
- **People rule on** which observed behaviours are intended and which are incidental, and so not to be cloned.
- **Driver.** Interactive or headless observers with access to the application; cells for the implementation, one
  behaviour area each.
- **Watch for** behaviour that varies between runs (times, ids, ordering): record what varies in the spec, so the
  golden test checks only what is stable. Commit long transcripts as files and cite their paths.

## 6. Limits that matter for loops

- **No trigger or notification.** Nothing starts an iteration when a task is recorded, a fix is merged or a person
  rules. A driver polls: a script's loop, `task pull`'s exit codes (3 for empty, 4 with `retry_after`), or a
  scheduler on a timer or on each merge (§ 5 Scheduled runs).
- **A task that changes files closes by its commit; one that changes none closes by its outcome.** A task whose
  objective is to use, investigate, test, review or operate the repository, rather than change it, names a
  `subject` (an issue, a document, a service, a topic) in place of `files`, and still belongs to the repository's
  ledger:
  - `record_finding` takes `files`, a `subject`, or both, and refuses a call with neither;
  - `mark_complete endorse` closes a task that names no file at once, writing its `outcome` (the answer, the cause
    found, the test results, the review, the deploy's result) and `evidence` (a PR, an issue comment, a report, a
    run log) on the verdict, and recall lists it `[DONE]` with the outcome;
  - a task that names files closes by its commit: in a git checkout with a remote, once a commit since the task that
    touches its files (or one named with `fix_commit`, in HEAD's history) is on a remote branch other than
    `task/…`; while the fix is uncommitted, unpushed or only on a task branch, the task stays `fix pending`; and a
    checkout that knows none of the files writes no verdict;
  - `task pull` clones the repository for either kind and writes the subject into `task.json` and `context.md`;
    `finding close` closes by commit trailer, so a file-less task is closed with `mark_complete` (in a cell, by
    the harness's agent, since the entrypoint has no outcome to write).
- **Recall reads a bounded window.** `get_problems` and `task pull` read findings and verdicts across the whole
  organization in pages of 300 of each kind, relevance first, then newest: up to four pages when the service pages,
  one page when it does not (`src/tools/_findings.ts@fetchAgentFindings`). An old, uncredited task can fall out of
  that window. Record tasks for real units of work, not every step, and close what is done.
- **Credit is voluntary** (§ 3 Cautions for producers and consumers).
- **A proposed policy reads like an endorsed one** when an agent reads memory, so the base prompt says which count
  (§ 3 Base and specific behaviour).
- **Concurrency is advisory** (§ 4 What exists and what does not for shared work).

## 7. Security and what is shared

- **A cell lands on `main`, unreviewed, by default.** The integration policy defaults to `push_to: main` and
  `integrate: push` (`src/task-pull.ts@integration-policy`), so an entrypoint that lands work as § 5 Agent cells
  lays out pushes the fix straight to `main`, and `finding close` closes it. A task recorded from the dashboard
  carries no policy lines, so it gets these defaults. To require review, the task's `details` (or a trusted
  author's `project_convention` for the repository) declare both `push_to: task` and `integrate: review`: the fix
  goes to `task/<task id>` and stays `fix pending (awaiting merge)` until someone merges it. `integrate: review`
  alone still pushes to `main`. Back the policy with a git credential that cannot push `main` (§ 5 Agent cells).
- **`mark_complete endorse` closes on any branch not named `task/…`.** It closes a finding once its fix commit is
  on any remote branch other than a task branch (`src/repo-identity.ts@fix-location`); it does not know which
  branches are for review. A team that pushes pull-request branches under other names (`fix/…`, `feature/…`) closes
  findings before anyone reviews them. Push work meant for review to `task/<task id>` branches, which leave the
  finding pending until the merge, or tell agents not to endorse and run `finding close` after the merge.
- **A proposed convention still sets a cell's policy.** The server does not apply R1 or R2, so `task pull` takes a
  `project_convention` from a trusted author whatever its proposal state: a convention marked `proposed` and not
  yet endorsed sets `push_to` and `integrate` for every cell that trusts its author. The trusted authors are
  `--trust` or `METABOB_TASK_TRUST`, else the task's own recorder; name them explicitly, keep the list to authors
  whose conventions are in effect, and put the policy in the task's own `details` where it matters.
- **Keys.** Each worker has its own key; nobody shares one. The server sends the key to the shared service only:
  as the `Authorization` header of its requests, and in the body of the org check it makes when it attaches. Keep
  it in the plugin's sensitive setting, a 0600 config file or the server's `env`, not in prompts, briefs or the
  harness's environment where the model can read it.
- **What leaves the machine.** No source file, excerpt or file list, and no usage telemetry; only what the agent's
  calls carry (summaries, details, file paths, commit ids, concept text, the author and session lines), listed per
  call at the end of this section. `get_problems` matches recalled items to your files locally. `METABOB_CALL_LOG`
  stays on the machine.
- **The outgoing guard.** Every string a sending tool passes is checked before the call runs
  (`src/outgoing-guard.ts@guard-tool-input`; SPEC § Outgoing text guard): the key, secret-named values from the
  environment and from the workspace's and user's config files, or anything shaped like a credential refuses the
  call without repeating the value; a home-directory path is redacted to `~` in prose; each field has a size cap. It
  catches accidents, not paraphrase or a key split in two.
- **Everything written is shared across the organization.** Every task, finding, claim, verdict, decision and
  handoff is readable by every key in the organization, on every repository; write it for a colleague on another
  team.
- **Ledger text is untrusted input.** Any key with `write` can record a brief, a policy or a convention, and an
  agent acts on what it reads. In a loop, one iteration's output is the next one's instructions, so give `write`
  only to workers you run, keep cells' trust lists short, and review what cells push before it is merged
  (`integrate: review`).

**What each call sends.** Every request carries the key. Beyond it:

| The agent… | What is sent |
|---|---|
| records a task or problem (`record_finding`) | summary, details, severity, category, status, the file paths and line range, the repository's identity (its git remote, else its first commit, else a hash of the directory's path) and the directory's name, a hash naming the workspace, the item's ids, and the author and session |
| closes one (`mark_complete`) | the verdict, the item's summary, files and repository, the fix commit, its branch, the base and target branch names, the author and session, and whether the verdict came from a local copy |
| claims one (`claim_finding`) | the item's id and summary, the repository's identity, the claim's length and end, the author and session |
| writes memory (`concept_create`, `concept_link`, `concept_record_usage`) | the text it writes, its shape, any pointer it gives, the author and session |
| searches or reads (`concept_search`, `concept_neighbors`) | the search text, or the ids it reads |

Every write also carries a `client_claim`: the operator, session and client it declares (SPEC § Client claim).
Each field has a size cap (a summary 2 KB, details 8 KB, a concept 16 KB). The tools `METABOB_TOOLS=all` adds are
in SUBSTRATE-GUIDE.md, § What else leaves your machine.

## 8. Troubleshooting

Run `metabob-mcp attach --check` first (`npx @metabob/mcp@<version> attach --check` where the bin is not
installed). It runs the attachment as the server does, prints each hop and ends with `attached` or the one line
with the named cause; exit 0 means attached. Its `config` line names the file it read and the key's last four
characters, which shows a key shadowed by another config file (§ 2). Every shared tool answers with the same named
cause while the server is not attached.

| Cause | What it means | Next step |
|---|---|---|
| `not_configured` | No key, or no discovery address | Set both (§ 2); the server's start-up message names the missing one and the lookup order |
| `key_rejected` | The identity service refused the key: revoked, expired, mistyped, or another config file's key | Check `attach --check`'s `config` line; issue a key in Access (§ 2 One named key per worker). A running server re-checks every five minutes, so a revoked key shows here within that |
| `key_read_only` | The key has only the `read` scope: no write is sent, and `record_finding` and `mark_complete` keep only their local half | Give the worker a key with `write` |
| `anchor_unreachable(<host:port>)` | Discovery cannot be reached | Check `DISCOVERY_ENDPOINT`; on a network that needs a proxy, set `HTTPS_PROXY` |
| `identity_unreachable(…)` | The identity address discovery's `/bootstrap` names does not answer | The `identity` line shows what was advertised and tried; set `IDENTITY_ENDPOINT` to an address this machine can reach |
| `blocked_by_portal` | A proxy or captive portal answered with its own page | Sign in to the portal, or set the proxy it requires |
| `proxy_auth_required(<schemes>)` | The proxy asks for authentication | `Basic`: put the credentials in the proxy URL. `NTLM` or `Negotiate`: run a local authenticating relay and point `HTTPS_PROXY` at it |
| `tls_intercepted(<issuer>)` | The certificate chain is signed by an issuer the server does not trust, usually TLS inspection | Add that issuer's root certificate (PEM) with `NODE_EXTRA_CA_CERTS`, or to the OS trust store |
| `connect_timeout`, `dns_failed`, `connect_refused`, … | Another network cause | SPEC § Named network causes gives each one |
| `workspace_undetermined` | The server started outside the project (Codex starts it in the plugin's folder) and no client root or `WORKSPACE_PATH` names it | The agent calls `init_workspace { workspace_path: "<the project's absolute path>" }`, or set `WORKSPACE_PATH` |
| `local_index_unavailable(<module>: …)` | A native module of the local code index cannot load on this platform (`src/local-index.ts@lazy-native`) | The ledger, memory and shared tools are unaffected, and `init_workspace` still names the workspace; the local code tools need a supported platform (§ 2) |
| `runtime_unsupported` | The Node on PATH has no `node:sqlite` and no Bun is on PATH, so the server exits 1 | Install Node 22.13 or later (or 23.4 or later), or Bun 1.1 or later (§ 2) |
| `task pull` exits 1: the directories "must be empty or missing" | The task or work directory holds an earlier run | Start a new container, or give each round new directories (§ 5 Agent cells, Resuming a cell's task) |

**Where the logs go.** The server logs to standard error, one line per event with its time and level, and the
harness decides where that lands (its MCP log, or a script's redirect); `LOG_LEVEL=debug` adds the debug lines, and
the default is `info`. `task pull` and `finding close` print their result on standard output for exit 0 and on
standard error otherwise (one JSON line with `--json`), with warnings on standard error. `METABOB_CALL_LOG` records
each tool call on the worker's machine (§ 4 Following progress).
