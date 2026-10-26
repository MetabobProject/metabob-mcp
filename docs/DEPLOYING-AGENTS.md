# Deploying agents

This guide is for whoever sets up, runs and steers AI coding agents that share a repository through Metabob: which
pieces are involved, how to start an agent for each kind of task, how to manage a group of them, and how to shape
what they do. It is the technical companion of the [user guide](USER-GUIDE.md), which explains
the ledger and the memory from the user's side; read that first. Tool parameters are in the
[specification](SPEC.md), and installation per client is in the [README](../README.md#integrations).

**Before any agent pushes, read § 5.** Three behaviours there decide what reaches your branches unreviewed: a
cell's integration policy defaults to pushing straight to `main`; `mark_complete endorse` closes a finding once its
fix is on any remote branch not named `task/…`; and a `project_convention` from a trusted author sets a cell's
policy even while it is only proposed.

## Terms used here

| Term | Meaning |
|---|---|
| Task | An open finding in category `task`: work recorded on the ledger for an agent to take |
| Cell | One task, one container, one fresh clone (§ 2 Agent cells) |
| R1, R2 | The two rules meant to decide which guidance is in effect. R1: when two ledger items conflict, a person rules, and until then both stay flagged. R2: a policy an agent proposes stays pending until a different key endorses it. The dashboard is where people apply them; the server applies neither (§ 4 Ledger content) |
| `repo_anchor` | The concept that stands for one repository in the shared memory. Decisions, conventions and review criteria are linked to it, so an agent reads a repository's memory by following the links into it (`concept_neighbors`). The `metabob` skill finds it with `concept_search { shape: "repo_anchor" }` and creates it when there is none |
| Cockpit tool | One of the operator tools beyond the default set (goals, traces, the registry, `path_activity`), listed only under `METABOB_TOOLS=all` or a list that names it. Listing `path_activity`, `run_goal_async` or `run_goal` (`src/server-instructions.ts@COCKPIT_TOOLS`) switches the instructions and the skill to `metabob-substrate` (§ 4) |
| Unmounted | A repository `path_activity` reports as one the shared service may not mount: none of the system's own open gaps names it, so the tool checks none of its paths, and the edit check asks for `get_problems` only |
| The local installer | The setup for a substrate on your own machine, which writes the API key and endpoint into `~/.substrate/config.json`; on a machine it set up, the server needs no other configuration (README § Quick Start). A worker of the hosted service does without it: its key and discovery address go in a config file (§ 1) |

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

**Prerequisites** on each machine or image that runs an agent:

- `git` on PATH: Claude Code clones the plugin's marketplace with it, the ledger is keyed by the repository's
  origin, and a close reads the commits.
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

**Claude Code with the plugin** (the server, both skills and the edit check):

```bash
claude plugin marketplace add https://github.com/MetabobProject/metabob-mcp.git
claude plugin install metabob@metabob \
  --config api_key=<the person's key> --config discovery_endpoint=https://ide.metabob.com
claude mcp list       # shows plugin:metabob:metabob … ✔ Connected
```

Use the https URL: the `MetabobProject/metabob-mcp` shorthand makes Claude Code clone over ssh, which fails on a
machine with no GitHub ssh key. `api_key` is kept as a sensitive setting; `/plugin configure` changes the settings
later, and a blank one falls back to the config file (§ 1). If the first start takes longer than Claude Code's
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

The Codex plugin takes no settings: the key and discovery address come from the config file (§ 1). Codex starts the
server in the plugin's folder, so every tool answers `workspace_undetermined` until the agent calls `init_workspace
{ workspace_path: "<the project's absolute path>" }`, which the skill does (README § Codex plugin). For
`METABOB_TOOLS=all`, which the plugin's server cannot take, replace the plugin with a server you add, and install
the skill by hand from a checkout of this repository (USER-GUIDE § 4):

```bash
codex plugin remove metabob@metabob
codex mcp add metabob --env METABOB_TOOLS=all -- npx -y @metabob/mcp@<version>
cp -R skills/metabob-substrate ~/.codex/skills/
```

**Other clients** (Cursor, Continue, Claude Desktop, `claude mcp add`): README § Integrations.

- **Start:** start the client in the project.
- **Key and configuration:** the person's own worker key, in the plugin's settings (Claude Code), the config file
  or the client's MCP `env`. The default tool set suits most sessions (§ 4).
- **Reads and writes:** with the `metabob` skill loaded, it reads the queue and the repository's memory at the start,
  claims what it takes, records what it notices, and closes what it commits; USER-GUIDE § 1 walks through it.
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
- **Reads and writes:** each finds its task with `get_problems` (summary, files, holder and concept id) and reads
  the brief with `concept_search { concept_id }`, claims it with `claim_finding`, stays inside the
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
timeout 1800 claude -p "Work task agf_…: find it with get_problems, read its brief with concept_search
{ concept_id: <its concept id> }, claim it, do it, commit with the
trailer 'Fixes-Finding: agf_…', push, then mark_complete it." \
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

### A headless loop

Two ways to work tasks one after another with no one watching. Both need permission to push, or every fix stays
pending (§ 3 Pending fixes and merges).

**A `claude -p` loop in one checkout.** Each round is one session. Neither CLI tells the script whether a task was
open, so the prompt asks for a reply the script stops on:

```bash
cd /path/to/checkout      # this loop's own working copy (a clone or a git worktree)
prompt="Use the metabob skill. Take one open task nobody holds and finish it or hand it off: run its done \
checks, commit with the trailer 'Fixes-Finding: <its id>', push, then mark_complete it. A task marked fix \
pending is not open. If none is open and unheld, reply only NO_OPEN_TASKS."
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
- `metabob-mcp.json` is the one in § Unattended headless runs. With `--strict-mcp-config` the run's server is that
  one; give the run the skill as a copy in `~/.claude/skills/` (USER-GUIDE § 3) or with `--plugin-dir`.
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
- The landing steps follow the task's policy (§ Agent cells, Where the fix goes). A rebase that stops on a conflict
  ends the round unpushed. The round's directory keeps the work; the next round, under the same identity, takes the
  task again from a fresh clone while the claim is live, and after the claim ends any worker may take it.

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

- **Restarting a container whose pull succeeded exits 1.** The lab entrypoint never clears `/task` or `/work`, and both survive
  a restart in the container's filesystem.
- **A new container without `CELL_VESSEL_ID` cannot resume.** It has a new hostname, so a new
  `metabob-cell-<hostname>` identity, which reads the old claim as someone else's.
- **To resume, give each cell a stable `CELL_VESSEL_ID`** (or `VESSEL_ID` in your own entrypoint) **and start a
  new container with it.** Its fresh `/task` and `/work` let `task pull` run, and the same identity takes its own
  claim first. It resumes only while that claim is live: `--minutes` (the lab's `CELL_CLAIM_MINUTES`, 45) plus
  the two minutes readers allow (§ 3 Claims); after that any cell may take the task. Work the old container had not
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
fails at the push instead of landing unreviewed (§ 5).

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
| Stop | A server shutting down normally releases the claims its session took through `claim_finding`; a kill or crash leaves them to lapse; `task pull`'s claim outlives its own process and the harness, even when the agent claims or renews it again under the same identity |

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
- **Kill it.** A worker whose server shuts down normally (the client exits, or `timeout` sends SIGTERM) releases
  the claims it took through `claim_finding`. A worker killed outright (SIGKILL) or crashed, and a cell's claim from
  `task pull`, stay live until their end (plus the two-minute skew), then the task is free again. Nobody else can take it before then, short of closing the finding. A new cell
  container under the same identity resumes a task that identity still holds (§ 2 Agent cells).
- **Cut it off.** Revoke its key in Access.
- **Take the task off the queue.** Triage it in the dashboard's Ledger (resolved or retracted), or close it with
  `mark_complete`; a closed task shows no claim and `task pull` skips it.

## 4. Configuring behaviour

### Tool sets

`METABOB_TOOLS`, read once when the server starts (`src/tool-allowlist.ts@parseToolAllowlist`; SPEC § Tool sets):

| Value | Lists |
|---|---|
| unset or empty | The default eleven: the ledger and memory tools plus `init_workspace` |
| `all` | Every tool: the full tool set, with code analysis and goal tools. A server before 0.4.0 reads `all` as one tool's name and lists none, so pin 0.4.0 or later where it is set |
| `a,b,c` | Exactly those tools; a name that is no tool lists nothing and is reported at start |

A tool outside the set is refused by name before it runs, on stdio and on the local resolver. Change it in the
server's environment, then restart or reconnect the client. Where to set it in each client (the Claude Code plugin,
a server added with `claude mcp add`, Codex, Cursor and Continue, headless runs) is in USER-GUIDE § 4. A list
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
conflict. The one place the server reads conventions is `task pull`'s integration policy, which does not check a
convention's proposal state (§ 5). Tell agents in their prompt or brief to read the guidance for their files.
Recall that applies R1 and R2 is how the system is meant to work. Compiling ledger guidance into skills is planned,
not built.

## 5. Security and what is shared

- **A cell lands on `main`, unreviewed, by default.** The integration policy defaults to `push_to: main` and
  `integrate: push` (`src/task-pull.ts@integration-policy`), so an entrypoint that lands work as § 2 Agent cells
  lays out pushes the fix straight to `main`, and `finding close` closes it. A task recorded from the dashboard
  carries no policy lines, so it gets these defaults. To require review, the task's `details` (or a trusted
  author's `project_convention` for the repository) declare both `push_to: task` and `integrate: review`: the fix
  goes to `task/<task id>` and stays `fix pending (awaiting merge)` until someone merges it. `integrate: review`
  alone still pushes to `main`. Back the policy with a git credential that cannot push `main` (§ 2 Agent cells).
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
  as the `Authorization` header of its requests, and in the body of the org check it makes when it attaches. Keep it in the plugin's sensitive setting, a 0600 config file or the server's `env`, not
  in prompts, briefs or the harness's environment where the model can read it.
- **What leaves the machine.** No source file, excerpt or file list, and no usage telemetry; only what the agent's
  calls carry (summaries, details, file paths, commit ids, concept text, the author and session lines). USER-GUIDE
  § 10 lists it per call. `get_problems` matches recalled items to your files locally. `METABOB_CALL_LOG` stays on
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

## 6. Troubleshooting

Run `metabob-mcp attach --check` first (`npx @metabob/mcp@<version> attach --check` where the bin is not
installed). It runs the attachment as the server does, prints each hop and ends with `attached` or the one line
with the named cause; exit 0 means attached. Its `config` line names the file it read and the key's last four
characters, which shows a key shadowed by another config file (§ 1). Every shared tool answers with the same named
cause while the server is not attached.

| Cause | What it means | Next step |
|---|---|---|
| `not_configured` | No key, or no discovery address | Set both (§ 1); the server's start-up message names the missing one and the lookup order |
| `key_rejected` | The identity service refused the key: revoked, expired, mistyped, or another config file's key | Check `attach --check`'s `config` line; issue a key in Access (§ 3). A running server re-checks every five minutes, so a revoked key shows here within that |
| `key_read_only` | The key has only the `read` scope: no write is sent, and `record_finding` and `mark_complete` keep only their local half | Give the worker a key with `write` |
| `anchor_unreachable(<host:port>)` | Discovery cannot be reached | Check `DISCOVERY_ENDPOINT`; on a network that needs a proxy, set `HTTPS_PROXY` |
| `identity_unreachable(…)` | The identity address discovery's `/bootstrap` names does not answer | The `identity` line shows what was advertised and tried; set `IDENTITY_ENDPOINT` to an address this machine can reach |
| `blocked_by_portal` | A proxy or captive portal answered with its own page | Sign in to the portal, or set the proxy it requires |
| `proxy_auth_required(<schemes>)` | The proxy asks for authentication | `Basic`: put the credentials in the proxy URL. `NTLM` or `Negotiate`: run a local authenticating relay and point `HTTPS_PROXY` at it |
| `tls_intercepted(<issuer>)` | The certificate chain is signed by an issuer the server does not trust, usually TLS inspection | Add that issuer's root certificate (PEM) with `NODE_EXTRA_CA_CERTS`, or to the OS trust store |
| `connect_timeout`, `dns_failed`, `connect_refused`, … | Another network cause | SPEC § Named network causes gives each one |
| `workspace_undetermined` | The server started outside the project (Codex starts it in the plugin's folder) and no client root or `WORKSPACE_PATH` names it | The agent calls `init_workspace { workspace_path: "<the project's absolute path>" }`, or set `WORKSPACE_PATH` |
| `local_index_unavailable(<module>: …)` | A native module of the local code index cannot load on this platform (`src/local-index.ts@lazy-native`) | The ledger, memory and shared tools are unaffected, and `init_workspace` still names the workspace; the local code tools need a supported platform (§ 1) |
| `runtime_unsupported` | The Node on PATH has no `node:sqlite` and no Bun is on PATH, so the server exits 1 | Install Node 22.13 or later (or 23.4 or later), or Bun 1.1 or later (§ 1) |
| `task pull` exits 1: the directories "must be empty or missing" | The task or work directory holds an earlier run | Start a new container, or give each round new directories (§ 2 Resuming a cell's task) |

**Where the logs go.** The server logs to standard error, one line per event with its time and level, and the
harness decides where that lands (its MCP log, or a script's redirect); `LOG_LEVEL=debug` adds the debug lines, and
the default is `info`. `task pull` and `finding close` print their result on standard output for exit 0 and on
standard error otherwise (one JSON line with `--json`), with warnings on standard error. `METABOB_CALL_LOG` records
each tool call on the worker's machine (§ 3 Following progress).
