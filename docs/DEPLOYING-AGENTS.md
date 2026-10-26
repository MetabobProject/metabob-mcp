# Deploying agents

This guide is for whoever sets up, runs and steers AI coding agents that share a repository through Metabob: which
pieces are involved, how to start an agent for each kind of task, how to manage a group of them, and how to shape
what they do. It is the technical companion of [Shared memory and coordination](SHARED-MEMORY.md), which explains
the ledger and the memory from the user's side; read that first. Tool parameters are in the
[specification](SPEC.md), and installation per client is in the [README](../README.md#integrations).

## 1. The pieces

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

**Attaching to the hosted service** needs two values, the key and the discovery address. For a one-off check
from a shell:

```bash
export METABOB_API_KEY=<the worker's key>
export DISCOVERY_ENDPOINT=https://ide.metabob.com
npx @metabob/mcp@latest attach --check     # exit 0 means attached
```

For a worker, put them in a 0600 config file rather than the harness's environment (§ 5). The server reads the
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

## 2. Deploying agents for different kinds of task

Every deployment below uses the same server and its default tool set (§ 4 covers others); what differs is how the harness is started, what
the agent is told, and how it ends. In each case give the worker its own named key (§ 3).

### An interactive session

- **Start:** install the plugin or add the server to the client (README § Integrations); start the client in the
  project.
- **Key and configuration:** the person's own worker key, in the plugin's settings (Claude Code), the config file
  or the client's MCP `env`. The default tool set suits most sessions (§ 4).
- **Reads and writes:** with the `metabob` skill loaded, it reads the queue and the repository's memory at the start,
  claims what it takes, records what it notices, and closes what it commits; SHARED-MEMORY § 3 walks through it.
- **Stops:** when the person ends it. Unfinished work should get a handoff and a released claim first ("stop here
  and hand this off").

### A planner

A planner is a session whose output is ledger entries rather than code.

- **Start:** an interactive or headless session with the default tool set, told to split the work.
- **Key:** its own, for example `planner`, so its tasks are attributed to it.
- **Writes:** one `record_finding` per unit of work in category `task`, with `files` set to what the task owns and a
  brief in `details` (Goal, Owns, Out of bounds, Done when, Read first), as the `metabob` skill's "Handing work to
  other agents" section lays out. A task meant for a cell can carry its integration policy as lines in `details`
  (`push_to: main|task`, `integrate: push|review`) and a `ref: <branch>` to clone (§ Agent cells below). Decisions
  and rejected approaches go into `concept_create` as `decision_record` concepts, linked to the repository's
  `repo_anchor`; ordered work goes in as `workflow_step` concepts linked with `sequence_next`.
- **Reads:** `get_problems` first, so it does not record a task that is already open.
- **Stops:** when the tasks are recorded. Nothing the planner writes starts a worker: something else has to (§ 3).

A person can do the planner's job from the dashboard: "Add here" on a Ledger node records a task at that location.
Its first line is the summary, the whole text is the brief, severity defaults to MEDIUM, and it carries no
`push_to` / `integrate` lines, so a cell applies its defaults.

### Parallel workers

- **Start:** one session per task, each in **its own working copy** (a separate clone or a `git worktree`), each
  told only its task id ("work task agf_…").
- **Key:** one per worker.
- **Reads and writes:** each reads its brief with `get_problems`, claims it with `claim_finding`, stays inside the
  task's `Owns:` files, and closes it with `mark_complete` after committing and pushing.
- **Stops:** when its task is closed or handed off.

Who counts as one claimer is the server's identity: `metabob-mcp-<hash(key + workspace)>`, or `VESSEL_ID` when set
(`src/vessel-identity.ts@resolveVesselId`). Two sessions with one key in one working copy are one claimer, so a
claim does not keep them apart; separate keys or separate working copies do, and separate working copies also keep
their edits apart.

### Unattended headless runs

A headless run is a single prompt that runs to the end with no one to answer a permission prompt, so it has to be
told everything and allowed exactly what it needs.

**Claude Code** (`claude -p`):

```bash
cd /path/to/checkout
timeout 1800 claude -p "Work task agf_…: read it with get_problems, claim it, do it, commit with the
trailer 'Fixes-Finding: agf_…', push, then mark_complete it." \
  --mcp-config ./metabob-mcp.json --strict-mcp-config \
  --permission-mode acceptEdits --allowedTools "mcp__metabob" "Bash(git:*)" \
  --max-budget-usd 5 --output-format stream-json --verbose > transcript.jsonl
```

with `metabob-mcp.json`:

```json
{ "mcpServers": { "metabob": { "command": "npx", "args": ["-y", "@metabob/mcp@latest"],
  "env": { "METABOB_CONFIG_PATH": "/path/to/worker-config.json", "METABOB_CALL_LOG": "/path/to/calls.jsonl" } } } }
```

- `--mcp-config` with `--strict-mcp-config` starts only this server, with the worker's own config. `--plugin-dir
  <dir>` loads a plugin from a directory; the lab cell gives it a copy of the plugin without its `.mcp.json`, so the
  run gets the skills and the edit check and keeps its own server entry (§ Agent cells).
- `--permission-mode` takes `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk` or `plan`;
  `--allowedTools` and `--disallowedTools` list what is allowed or refused without asking. Keep
  `bypassPermissions` for a container that holds nothing else.
- Claude Code's `--help` lists no turn limit. The limits are `--max-budget-usd` (with `--print` only) and a wall
  time from outside (`timeout`).

**Codex** (`codex exec`):

```bash
codex exec --sandbox workspace-write --json -o last-message.txt \
  -c 'mcp_servers.metabob.env.WORKSPACE_PATH="/path/to/checkout"' \
  "Work task agf_…: …"
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
claim to lapse (§ 3).

### Agent cells

A cell is one task, one container, one fresh clone. `metabob-mcp task pull` and `metabob-mcp finding close` are its
entry and exit steps; both run under Node and need no Bun.

```bash
metabob-mcp task pull --origin <git url> [--task-dir /task] [--work-dir /work] [--minutes 60] [--trust <id,…>] [--json]
# the harness works in /work and commits with the trailer  Fixes-Finding: agf_…
cd /work      # git and finding close run in the clone (finding close's --work-dir defaults to the current directory)
git fetch origin <target> && git rebase origin/<target>
git rev-list origin/<target>..HEAD > /tmp/commits      # this cell's own commits only
git push origin HEAD:<branch>
metabob-mcp finding close --commits-from /tmp/commits [--target <branch>] [--task /task/task.json] [--json]
```

**What `task pull` takes** (`src/task-pull.ts@runTaskPull`, `src/task-pull.ts@candidateTasks`): open findings in
category `task` on the origin's repository, in this order:

1. a task this cell already holds, so a restarted cell resumes it;
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
repository and only once the fix is merged into the target (`--target`, else the task's policy, else `main`):

| State of the fix | Result |
|---|---|
| In `origin/<target>`, or a commit there carries the same trailer line | Endorsed, with that commit |
| Merged, then reverted on the target | Reported as reverted; nothing written |
| Pushed to some branch, not merged (as under `review`) | `fix pending (awaiting merge)`; run `finding close` again after the merge |
| On no remote branch | Reported as unpushed; nothing written |

Its exit codes are 0 (done, each finding's outcome reported), 2 (not attached) and 1 (any other failure, including a
failed fetch). List the commits with `git rev-list origin/<target>..HEAD` after the rebase, never `<base>..HEAD`,
which after a rebase also holds other cells' merged commits.

**Identity in a cell.** Set `VESSEL_ID` to one value per cell and pass it to `task pull`, the harness's server and
`finding close`. Without it each derives its identity from the key and the work directory, and `task pull` does so
before the clone exists while the server does so after it, so they differ: the agent reads the claim `task pull`
took as someone else's and takes another task. The lab cell's entrypoint sets it from `CELL_VESSEL_ID`, else
`metabob-cell-<container hostname>`, kept across a restart of the same container. The task and work directories
must be empty or missing, or `task pull` exits 1: a restarted cell starts from a fresh clone and resumes its claim.

**The reference recipe** is the lab cell (`lab/cell/Containerfile`, `lab/cell/entrypoint.sh`, lab/README.md
§ Agent cell): `task pull` with a 45-minute claim, `claude -p` with a model, budget and wall time from `CELL_*`
variables, web tools refused, the key only in a private 0600 config file the harness's environment does not carry,
and `METABOB_CALL_LOG` into the result bundle. It is built for judging work, so it **never pushes and never runs
`finding close`**: its push URL is disabled and its work is judged outside the cell. A cell meant to land work adds
the fetch, rebase, push and `finding close` steps above, and a git credential for the push.

### Scheduled runs

Nothing in Metabob schedules or starts an agent. A scheduler you run (cron, a systemd timer, a CI schedule) starts a
headless run or a cell, and uses `task pull`'s exit code to pace itself: 3 means there is nothing to do, and 4's
`retry_after` is when to try again. Each scheduled run is a worker like any other: its own key, its own working copy
or container, a wall time and a budget.

### A reviewer

A reviewer reads work other agents did and records its judgment; it does not grade its own work.

- **Start:** an interactive or headless session on the branch or commits under review.
- **Key:** its own (`reviewer`), with `write`: verdicts and findings are writes. A key with only `read` writes
  nothing shared: every write answers `key_read_only`, and `record_finding` and `mark_complete` keep only their
  local half (SPEC § Read-only key).
- **Reads:** the review criteria recorded for the repository. Nothing in the server reads them specially: the agent
  finds them with `concept_search { shape: "review_criterion" }` or by following the links into the repository's
  anchor with `concept_neighbors`.
- **Writes:** `record_finding` for each problem the change leaves; `mark_complete discard` for a finding that is
  not real; a `decision_record` for a judgment the next reviewer would otherwise have to reach again.
- **Under `push_to: task` with `integrate: review`:** a cell's fix sits on `task/<task id>` as `fix pending (awaiting merge)`. Merging it
  is the reviewer's or a person's act in git; `finding close` (or an endorse after a fetch) then closes the finding.

## 3. Managing agents

**Nothing triggers or notifies a worker.** Recording a task wakes no one, the dashboard sends no alerts, and an
agent learns of a task only when it reads the ledger. Launchers (a person, a script, a scheduler) check the ledger
and start workers; people check *Needs you*.

### One named key per worker

Issue each worker its own key in the dashboard's Access screen (`/keys`): a name of at most 100 characters, the
scopes (`read`, `write`, and `admin` only for people who manage keys), and an expiry of 1 to 3650 days if you want
one. The key is shown once. The key's name is the worker's name on the ledger: the dashboard shows authorship as the
writing key's name, so name keys for what the worker is (`planner`, `cell-payments-1`, `reviewer`).

Revoking a key in Access cuts that worker off. A running server re-checks its key every five minutes
(`src/attachment.ts@DEFAULT_HEARTBEAT_MS`); once the key is rejected, shared tools answer `key_rejected` and the
Claude Code edit check stops holding edits. Access has no regenerate endpoint upstream: "regenerate" issues a key
with the same name and scopes, then revokes the old one.

The server also stamps its own declared identity on what it writes (`recorded_by`, `reviewed_by`, `session`, and a
`client_claim` on every write: `src/operator-id.ts@clientClaim`; SPEC § Client claim). These are claims the client
makes, not attribution; the key's name is what identifies the writer.

### Claims

A claim is how a worker says it has a task (`claim_finding`; SPEC § claim_finding):

| | |
|---|---|
| Length | 60 minutes by default, at most 240 (`minutes`); `task pull --minutes` sets it for a cell |
| Renew | `action: "renew"` before it ends, for long work; renewing a claim it does not hold is refused |
| Release | `action: "release"` when stopping without finishing, after leaving a handoff |
| End | The claim's start plus its minutes, by the shared clock; readers treat it as live until two minutes past that |
| Contest | Two workers can both write a claim; every reader picks the same holder, the earliest live claim, the lower id on a tie (`src/tools/_claims.ts@claim-holder`), and the later claimer withdraws |
| Close | A verdict that closes the finding, by anyone, ends every claim on it (a pending endorse does not); an endorse of a finding someone else holds goes ahead, and the reply names their claim |
| Stop | A server shutting down normally releases the claims its session took through `claim_finding`; a kill or crash leaves them to lapse; `task pull`'s claim outlives its own process |

A claim is advisory: it keeps honest workers off one task, it does not lock files. The Ledger screen marks two live
claims on one file as an overlap.

### Disjoint ownership

Parallel workers stay out of each other's way because their tasks own different files. Record each task's `files`
and an `Owns:` / `Out of bounds:` pair in its brief, and keep the `Owns:` lists of concurrent tasks disjoint. A
worker that needs to change a file outside its task records that as its own task instead of widening its own.

### Following progress

| Where | What it shows |
|---|---|
| `get_problems` (any worker's session, or yours) | Open tasks with their holders and claim ends, fixes pending, problems, and what recently closed |
| Dashboard **Ledger** | Each path's tasks, findings, claims and guidance; hotspots, overlaps, blind spots and conflicts on the tree |
| Dashboard **Activity** | One line per act: recorded finding, created task, claimed, released, endorsed, discarded, fix pending, proposed, added, rejected, ruled, flagged conflict |
| `METABOB_CALL_LOG=<file>` | On the worker's machine: one JSON line per tool call, with the tool, argument names and sizes, the outcome, the claim or close result, and the duration, never a value (`src/call-log.ts@logCall`; SPEC § Call log) |

The dashboard caches its reads for 60 seconds; "Read again" behind its Source toggle drops the cache, and needs no `write` or `admin` scope.

### Pending fixes and merges

A close records where the fix is, and is not taken on the worker's word (SPEC § mark_complete):

| The fix is | The finding |
|---|---|
| Uncommitted | Stays open, `fix pending (uncommitted)` |
| Committed, on no remote branch (in a checkout with a remote) | Stays open, `fix pending (unpushed)` |
| Pushed only to `task/…` branches | Stays open, `fix pending (awaiting merge)` until merged |
| On any other remote branch (`mark_complete`) or merged into the target (`finding close`) | Closed, with the commit |

A worker not allowed to push leaves its findings pending; that is the right state, and the person who pushes or
merges closes them afterwards (`mark_complete endorse` after a fetch, or `finding close`).

### Stopping work

- **Ask for a handoff.** A worker told to stop writes a `task_handoff` linked to its task and releases its claim,
  so the next worker can start at once.
- **Kill it.** A worker stopped without a release leaves its claim live until its end (plus the two-minute skew),
  then the task is free again. Nobody else can take it before then, short of closing the finding. A cell's
  `task pull` resumes a task the same identity still holds.
- **Cut it off.** Revoke its key in Access.
- **Take the task off the queue.** Triage it in the dashboard's Ledger (resolved or retracted), or close it with
  `mark_complete`; a closed task shows no claim and `task pull` skips it.

## 4. Configuring behaviour

### Tool sets

`METABOB_TOOLS`, read once when the server starts (`src/tool-allowlist.ts@parseToolAllowlist`; SPEC § Tool sets):

| Value | Lists |
|---|---|
| unset or empty | The default eleven: the ledger and memory tools plus `init_workspace` |
| `all` | Every tool: the full tool set, with code analysis and goal tools |
| `a,b,c` | Exactly those tools; a name that is no tool lists nothing and is reported at start |

A tool outside the set is refused by name before it runs, on stdio and on the local resolver. Change it in the
server's environment, then restart or reconnect the client. Where to set it in each client (the Claude Code plugin,
a server added with `claude mcp add`, Codex, Cursor and Continue, headless runs) is in SHARED-MEMORY § 2. A list
is the way to give a worker less: a read-mostly reviewer, for example, without `claim_finding`.

### Skills

| Tool set | Skill |
|---|---|
| Default | `metabob` (`skills/metabob/SKILL.md`): the ledger and memory routine |
| `all` | `metabob-substrate` (`skills/metabob-substrate/SKILL.md`): the full tool set's routine, with the checks before an edit and the code tools |
| A list | `metabob-substrate` when the list includes `path_activity`, `run_goal_async` or `run_goal`; otherwise `metabob` |

The Claude Code and Codex plugins ship both. Without a plugin, copy the skill's folder into the harness's skills
directory, or point the agent's instruction file (`AGENTS.md`) at it.

### Start-up instructions

The server sends MCP `instructions` at connect, which clients put in the agent's context before its first call
(`src/server-instructions.ts@serverInstructions`; SPEC § Agent instructions). For the default set they say what the
ledger and memory are for, to load the `metabob` skill, which calls to make first without it, and what
`workspace_undetermined` and a named attachment cause mean. With a cockpit tool listed
(`src/server-instructions.ts@COCKPIT_TOOLS`) they point at `metabob-substrate` instead. For a list, every line naming
a tool the list leaves out is dropped, so the instructions never name a tool the agent cannot call. They are fixed
text; there is no setting to change them.

### Harness permissions and limits for headless runs

- Allow the metabob tools and the git commands the task needs; refuse what it must not do (the lab cell refuses
  `WebFetch` and `WebSearch`).
- Cap the spend (`--max-budget-usd` in Claude Code) and the wall time (`timeout`); neither CLI lists a turn limit.
- Give the agent nothing it should not use: the lab cell keeps the key in a 0600 config file the server reads
  (`METABOB_CONFIG_PATH`) and out of the harness's environment, and holds no git credential.
- Tell it in the prompt how to end: the commit trailer, whether to push, and to close or hand off.

### The edit check (Claude Code)

The Claude Code plugin holds an agent's first edit of an existing file in a session, once, and asks it to check
the file first: `get_problems`, plus `path_activity` when the server lists it and the repository is not one that
tool reports as unmounted (`scripts/claude-plugin/edit-check.mjs`; README § Claude Code plugin). It holds only where
an attached server's marker covers the session's directory, and never a file already checked through either tool, a
file being created, a second edit of a file, or a file outside the attached workspace. If the check itself fails,
the edit goes through. `METABOB_EDIT_CHECK=off` turns it off. Other harnesses have no hooks for it; under
`METABOB_TOOLS=all` they get the same rule from the `metabob-substrate` skill and the instructions, and under the
default tool set the skill and instructions carry no before-edit step.

### Ledger content: how people steer agents

The way to change what agents do across a repository is to put it on the ledger, at the location it applies to.
In the dashboard's Ledger, select a path and add:

| Item | Use it for |
|---|---|
| Policy | A rule agents follow at that location |
| Constraint | Something the code there is under |
| Review criterion | What a change there must meet |
| Instruction (a task) | Work to do, with its brief |

Agents are meant to recall the guidance in effect for the files they touch before editing, and credit what helped
or misled them. Two rules decide what is in effect:

- **R2.** A policy an agent proposes (`status: proposed`) is meant to stay pending until a different key endorses
  it in *Needs you*; an item authored directly is meant to take effect when written.
- **R1.** When two items conflict, a person rules (refine, A stands, B stands); until then both are meant to stay
  in recall, each flagged as awaiting a ruling.

**What the server does.** It has no recall of guidance by location and does not apply R1 or R2: an agent
finds guidance through `concept_search` by shape (`project_convention`, `constraint`, `review_criterion`) or by
following links into the repository's anchor, and nothing filters out a proposed or rejected item or flags a
conflict. The one place the server reads conventions is `task pull`'s integration policy, which takes a
`project_convention` from a trusted author and does not check its proposal state: a convention marked proposed
still sets a cell's policy when a trusted author wrote it. Tell agents in their prompt or brief to read the guidance
for their files, and trust only authors whose conventions are in effect.
Recall that applies R1 and R2 is how the system is meant to work. Compiling ledger guidance into skills is planned,
not built.

## 5. Security and what is shared

- **Keys.** Each worker has its own key; nobody shares one. The server sends the key to the shared service only:
  as the `Authorization` header of its requests, and in the body of the org check it makes when it attaches. Keep it in the plugin's sensitive setting, a 0600 config file or the server's `env`, not
  in prompts, briefs or the harness's environment where the model can read it.
- **What leaves the machine.** No source file, excerpt or file list, and no usage telemetry; only what the agent's
  calls carry (summaries, details, file paths, commit ids, concept text, the author and session lines). SHARED-MEMORY
  § 12 lists it per call. `get_problems` matches recalled items to your files locally. `METABOB_CALL_LOG` stays on
  the machine.
- **The outgoing guard.** Every string a sending tool passes is checked before the call runs
  (`src/outgoing-guard.ts@guard-tool-input`; SPEC § Outgoing text guard): the key, secret-named values from the
  environment and from the workspace's and user's config files, or anything shaped like a credential refuses the
  call without repeating the value; a home-directory path is redacted to `~` in prose; each field has a size cap. It
  catches accidents, not paraphrase or a key split in two.
- **Everything written is shared across the organization.** Every task, finding, claim, verdict, decision and
  handoff is readable by every key in the organization, on every repository; write it for a colleague on another
  team.
- **Ledger text is untrusted input.** Any key with `write` can record a brief, a policy or a convention, and an
  agent acts on what it reads. Give `write` only to workers you run, keep cells' trust lists short, and review
  what cells push before it is merged (`integrate: review`).
