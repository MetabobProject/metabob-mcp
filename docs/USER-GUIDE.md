# User guide: shared tasks and memory for your agents

This guide is for a developer who installed the Metabob plugin (Claude Code or Codex), or added the Metabob MCP
server to another client (Cursor, Continue, Claude Desktop or any MCP client), with `METABOB_TOOLS` unset: the
eleven tools of the default set and the `metabob` skill. To tell which you have, look at the tools the server
lists (in Claude Code, `/mcp` → `metabob`): eleven, read on; more, `METABOB_TOOLS` is set and
[SUBSTRATE-GUIDE.md](SUBSTRATE-GUIDE.md) covers every tool. Exact tool parameters are in the
[specification](SPEC.md); the full configuration table is in the [README](../README.md#configuration).

## 1. What it gives your agents

Your AI coding agents work on the same repository, at the same time or one after another, on different machines
and in different clients. Without help, each starts from nothing. Metabob gives them two things they share, held by
Metabob's service (the substrate) for your whole organization:

- **A task ledger.** Tasks you or an agent record, who is working on each, problems noticed and not yet fixed, and
  what closed with which commit.
- **A memory.** The decisions behind the code and the approaches that were tried and rejected, handoffs from one
  session to the next, and the steps of work that runs in an order. Each item is ranked by how often it helped the
  agents that relied on it.

Both hold only what agents put into them. Nothing reads your files into them and nothing is inferred from your
history: every task, claim, decision, handoff and credit is a call an agent made. An agent that only reads leaves the
next one where it started; an agent that writes down the one decision it had to work out saves the next one from
working it out again.

### What changes in how your agent works

You do not call these tools. You give your agent its task as usual; with the `metabob` skill loaded, it does the
following without being asked.

**At the start.** It checks which repository the ledger is keyed to (`get_analysis_context`) and names the project
when the client didn't (`init_workspace`). It reads the open tasks, who holds them and what recently closed
(`get_problems`), then the repository's memory: the decisions linked to the repository, anything on the area it is
about to touch, and the handoffs earlier sessions left on its task. It mentions what bears on your request: an open
task that already covers it, a decision that rules out the obvious approach, a handoff that says where the last agent
stopped.

**Taking a task.** It claims the task before starting (`claim_finding`), so no other agent starts the same work, and
reads the task's brief in full with `concept_search { concept_id: "<the task's concept id>" }`: `get_problems` shows a
task's summary, files, holder and id, never its details. It stays inside the files the brief says the task owns. A
task someone else holds is theirs: the agent tells you and picks another, or waits.

**Before editing (Claude Code).** The plugin's **edit check** holds an agent's first edit of each existing file in a
session once, with a note asking it to call `get_problems` for that file, since other agents may have recorded
problems or tasks on it. The retry goes through either way, so it is a reminder, not a lock. It holds nothing while
the server is not attached, nor for a new file, a second edit of the same file, a file the agent already checked, or
a file outside the workspace. Other clients have no edit check.

**While working.** A problem it notices and isn't fixing goes onto the ledger (`record_finding`), not only into its
reply. A choice that could reasonably have gone another way goes into memory as a decision record, with the approach
it rejected and why that one fails. When something another agent wrote helps it, it credits it
(`concept_record_usage`); when something misleads it, it marks that too and writes the correction. A concept's
relevance is `(times_succeeded + 1) / (times_loaded + 2)`, so memory that keeps helping ranks first. Agents don't
credit what they wrote themselves, and corrections are added beside the old item, never written over it.

**Finishing.** It commits, pushes where you allow it to, and closes what it finished (`mark_complete`, endorse). The
close records the commit and is not taken on the agent's word:

- a fix still uncommitted, or committed but on no remote branch, leaves the task open for every other agent as
  `fix pending` until the agent endorses again. If you don't let it push, it tells you the task stays pending;
- a commit only on task branches (`task/…`, which a review merges) leaves it pending until the merge;
- a commit counts when it postdates the task and touches its files, or when the agent names it as the fix
  (`fix_commit`) and it touches the task's files or was made after the task;
- something that turned out not to be real is closed with discard instead.

If the work isn't done, it leaves a handoff on the task (what's done, what's left, what to watch, what it tried and
dropped) and releases its claim, so the next agent can start at once. What it tells you about all this is short: what
it found already recorded, what it recorded, what it closed, and what needs your decision (§ 11).

### The tools

With `METABOB_TOOLS` unset, the server lists these eleven tools and refuses a call to any other:

| Tool | What the agent uses it for |
|---|---|
| `get_analysis_context` | Where it is: the repository the ledger is keyed to, whether it is attached, the open count, recent recall |
| `get_problems` | The work queue: tasks with who holds them, problems, and what closed |
| `claim_finding` | Taking a task so no other agent starts it; renewing; releasing |
| `record_finding` | Recording a problem it won't fix now, or a task for another agent |
| `mark_complete` | Closing what it finished, with the commit, or what turned out not to be real |
| `concept_search` | Finding what earlier agents learned, or reading one item (a task's brief) in full |
| `concept_neighbors` | Following links: a task's handoffs, a repository's decisions, the next step |
| `concept_create` | Writing a decision, a rejected approach, a handoff or a step |
| `concept_link` | Attaching what it wrote to the repository, task or step it concerns |
| `concept_record_usage` | Crediting what helped and marking what misled |
| `init_workspace` | Naming the project, where the client starts the server outside it |

## 2. What you can ask for

Ask in your own words. These are examples, with what the agent does.

| You want | Ask, for example | What the agent does |
|---|---|---|
| To know what is already recorded about some code | "What have other agents recorded about `src/payments/`?" | Reads the tasks and problems on those files and the decisions on that area |
| To keep a problem for later | "Record that, don't fix it now" | Records it on the ledger with files, severity and details, and gives you its id |
| To keep a decision and the rejected approach | "Write down why we chose the queue over polling, and why polling fails" | Writes a decision record with the rejected approach and links it to the repository |
| To continue where the last agent stopped | "Pick up the payments task where it was left" | Finds the task, reads its brief and the handoffs on it, claims it, continues |
| To hand work over | "Stop here and hand this off" | Pushes what works, writes a handoff on the task, releases the claim |
| To split work between agents | "Make one task per area, each owning its files" | Records one task per unit with its goal, files and done check; you give each agent an id (§ 5, § 6) |
| To set up work that runs in steps | "Write down the release process as steps" | Writes one step per item, linked in order |
| To correct the memory | "That decision is out of date: we moved to webhooks" | Marks the old decision as misleading and writes the corrected one, linked to it |
| To close something | "That finding was a false positive" | Closes it with discard |

You can always ask for the raw tool output.

## 3. Set up

### What you need

Two values, neither with a default:

- **An API key.** Your organization's Metabob admin issues it, or you find it in your Metabob account. Every agent
  that shares the work uses a key from the same organization, on a checkout of the same repository.
- **An address.** For a Metabob service running on your own machine, its endpoint (`http://127.0.0.1:18080`); for a
  remote one, its discovery endpoint (`https://…`), which you get with the key.

The plugins also need `git` and Node on PATH; § Claude Code below has the versions.

### Local or remote address

The server finds discovery, the service's front door, from the address. An `http://` endpoint with an explicit port
whose last two digits are 80 (`:18080`) gives it (`:18100`); any other endpoint (https, or http with no port or
another port) gives none (`src/config.ts@deriveLocalDiscoveryEndpoint`). So:

- **local:** set the endpoint (`endpoint`, `METABOB_ENDPOINT`);
- **remote:** set the discovery endpoint (`discoveryEndpoint`, `DISCOVERY_ENDPOINT`).

### The config file

The server reads the key and address from the environment first, else from the first of these files that exists
and has a `metabob` section:

1. the file `SUBSTRATE_CONFIG_PATH` names, then the one `METABOB_CONFIG_PATH` names;
2. `./.substrate/config.json`, then `./.metabob/config.json`, in the directory the server starts in (an MCP client
   usually starts it in the project), for that project alone;
3. `~/.substrate/config.json`, which the installer of a local Metabob service writes, so nothing else is needed;
4. `~/.metabob/config.json`.

For a local service:

```json
{ "metabob": { "apiKey": "mb_your_api_key_here", "endpoint": "http://127.0.0.1:18080" } }
```

For a remote one:

```json
{ "metabob": { "apiKey": "mb_your_api_key_here", "discoveryEndpoint": "https://discovery.example.com" } }
```

A file without a `metabob` section (another tool's) is skipped. Or export the values: `METABOB_API_KEY` with
`METABOB_ENDPOINT` (local) or `DISCOVERY_ENDPOINT` (remote). An exported `METABOB_ENDPOINT` takes only the key from a
config file, never its addresses, so a remote `METABOB_ENDPOINT` needs `DISCOVERY_ENDPOINT` beside it.

### Claude Code: the plugin

```bash
claude plugin marketplace add https://github.com/MetabobProject/metabob-mcp.git
claude plugin install metabob@metabob
```

It needs `git` and Node 22.13 or later (or 23.4 or later) on PATH; an older Node works with [Bun](https://bun.sh)
1.1 or later on PATH, and with neither `/mcp` shows the server failed. Use the https URL as written: the
`owner/repo` shorthand clones over ssh, which fails on a machine with no GitHub ssh key. `claude mcp list` shows
`plugin:metabob:metabob … ✔ Connected` when it works. The first start downloads the package; if that outlasts
Claude Code's 30 s connect timeout (a slow link, or Windows), reconnect from `/mcp`.

The plugin ships no credentials. It uses the config file above, or takes them as its settings, at install or later
with `/plugin configure`:

```bash
claude plugin install metabob@metabob --config api_key=mb_your_api_key_here --config discovery_endpoint=https://discovery.example.com
```

For a local service, `--config endpoint=http://127.0.0.1:18080` takes the place of `discovery_endpoint`. The key is
kept as a secret setting, and a blank setting falls back to the config file. The plugin brings the MCP server, the
`metabob` skill (and the skill for every tool, which SUBSTRATE-GUIDE covers) and the edit check (§ 1). Its server is
pinned to the plugin's own version.

### Codex: the plugin

```bash
codex plugin marketplace add https://github.com/MetabobProject/metabob-mcp.git
codex plugin add metabob@metabob
```

It brings the MCP server and the skills; there is no edit check outside Claude Code, and no plugin settings, so the
key and address come from a config file (§ The config file). `codex mcp list` shows `metabob … enabled`.

Codex starts the server in the plugin's own folder without saying which project you are in, so until the agent
names it, every tool answers `workspace_undetermined`. The skill tells the agent what to do: call
`init_workspace { workspace_path: "<your project's absolute path>" }` at the start of the session, before anything
else. A relative path such as `.` names the plugin's folder and is refused.

### Claude Code without the plugin, and other clients

Add the server yourself. Pin a version you have run, 0.4.0 or later (the eleven-tool default set needs it: an
earlier server lists every tool); `npx -y @metabob/mcp@latest --version` prints the latest. In Claude Code:

```bash
claude mcp add metabob -s user -e METABOB_API_KEY=mb_your_api_key_here -e DISCOVERY_ENDPOINT=https://discovery.example.com -- npx -y @metabob/mcp@<version>
```

In Cursor (`.cursor/mcp.json`), Continue (`.continue/config.json`, where `mcpServers` is a list of entries with a
`name`), Claude Desktop and other clients, the entry is:

```json
{ "mcpServers": { "metabob": {
    "command": "npx", "args": ["-y", "@metabob/mcp@<version>"],
    "env": {
      "METABOB_API_KEY": "mb_your_api_key_here",
      "DISCOVERY_ENDPOINT": "https://discovery.example.com"
    } } } }
```

For a local service, `METABOB_ENDPOINT` takes the place of `DISCOVERY_ENDPOINT`. Leave the key and address out of
`env` when a config file supplies them. The README's § Integrations shows each client's file.

### Install the skill without a plugin

The plugins install the `metabob` skill. Otherwise copy `skills/metabob/` (in this repository, and in the npm
package) into the client's skills directory:

```bash
git clone https://github.com/MetabobProject/metabob-mcp.git
cp -R metabob-mcp/skills/metabob ~/.claude/skills/     # Claude Code
cp -R metabob-mcp/skills/metabob ~/.codex/skills/      # Codex
```

A client with no skills directory takes it through its rules file: point `AGENTS.md` (or `.cursor/rules`, Copilot
instructions) at the skill's `SKILL.md`. The server also sends the client short instructions (load the skill, record
what you don't fix), but not every client shows them to the agent, so the rules file is the reliable route there.

### Check the connection

```bash
npx @metabob/mcp attach --check
```

It walks each step (proxy, TLS, discovery, identity, the key check, one read) and names the cause of a failure
(§ 9); exit 0 means attached. Ask your agent for `get_analysis_context` at any time: its first line says whether the
session is attached, to which organization, and under which identity it writes. Until it attaches, the ledger tools
keep to this machine's local store, and what is recorded then reaches no other agent.

## 4. Configuration

The full table of variables is in the README, § Configuration. These are the ones users change.

**Which tools are listed.** `METABOB_TOOLS` unset lists the eleven tools of § 1; `all` lists every tool (code
analysis and an operator's cockpit, covered by [SUBSTRATE-GUIDE.md](SUBSTRATE-GUIDE.md)); a comma-separated list
lists exactly those. It is read when the server starts, so restart or reconnect the client after changing it. `all`
needs 0.4.0 or later: an earlier server reads it as one tool's name and lists none, so name a version where you set
it. Where to set it:

- **Claude Code with the plugin:** in `~/.claude/settings.json` as `{ "env": { "METABOB_TOOLS": "all" } }`, or
  exported in the shell that starts `claude`. The plugin's server is pinned to the plugin's version.
- **Claude Code with a server you add:** `claude mcp add metabob -s user -e METABOB_TOOLS=all -- npx -y
  @metabob/mcp@<version>`, with a version 0.4.0 or later.
- **Codex:** the plugin's server takes no extra settings, so remove the plugin (`codex plugin remove
  metabob@metabob`), add the server yourself (`codex mcp add metabob --env METABOB_TOOLS=all -- npx -y
  @metabob/mcp@<version>`, 0.4.0 or later), and copy `skills/metabob-substrate/` into `~/.codex/skills/`.
- **Cursor, Continue and others:** in the server's `env` in the client's MCP configuration.

**The edit check** (Claude Code plugin, § 1). `METABOB_EDIT_CHECK=off` in the environment that starts `claude` turns
it off.

**The workspace.** The ledger is keyed by the repository the server takes as its workspace: an `init_workspace` path
first, then `WORKSPACE_PATH`, then the client's first workspace root, then the directory the server starts in. Set
`WORKSPACE_PATH` when your client starts the server outside the project and offers no roots.

**A project's own settings.** A `./.metabob/config.json` in the project's directory (§ 3) pins that project to its
own key or service, ahead of your per-user file.

**Proxies and certificates.** These come from your environment and your OS, never from Metabob's config:
`HTTPS_PROXY` / `HTTP_PROXY` and `NO_PROXY` for a corporate proxy (Basic credentials in the URL), and
`NODE_EXTRA_CA_CERTS` for a corporate root certificate that is not in your OS trust store. The README's § Corporate
proxies & SSL inspection covers NTLM, PAC files and inspected TLS.

## 5. Hand a task to another agent

A worked example. In one session, ask for the task:

> Record a task for another agent: the CSV export drops rows whose date is empty. Goal: every row is exported,
> an empty date as an empty field. Owns: the CSV writer under `src/export/` and its tests. Out of bounds: every
> other file. Done when: the export tests pass, with one for an empty date.

The agent records it (`record_finding`, category `task`) with a brief of four parts: **Goal**, **Owns** (the files
it may change), **Out of bounds** and **Done when** (the check that proves it). Its reply gives the task's
`agf_…` id and the id of the concept that holds the brief, `concept_…`.

From any session on the repository, "List the open tasks" shows it (`get_problems`): its summary, files, who holds
it, and its id. That id is the concept id (`concept_…`); only a task held in this session's local store alone (when
the shared service could not be reached at recording) shows its `agf_…` id. Hand that id to the second agent, in
another session, another client or another machine:

> Take task concept_…: claim it, do what its brief says, commit and push the fix, and close it.

The second agent:

1. claims it (`claim_finding`; either id works, as for `mark_complete`);
2. reads the brief in full with `concept_search { concept_id: "concept_…" }`, since `get_problems` shows a task's
   summary and id, never its details, and the handoffs earlier agents left on it with `concept_neighbors`;
3. works only in the files the brief says it owns;
4. commits with the task's id as a `Fixes-Finding: agf_…` trailer (the brief's `finding_ids:` line names the `agf_`
   id), so tooling that closes by commit can find it, and pushes;
5. closes it (`mark_complete`, endorse), which records the commit.

Without a push the task stays `fix pending` (§ 1), and the agent says so. If it stops before finishing, it leaves a
handoff and releases its claim, and the next agent you give the id to continues from there.

**Running the second agent.** Nothing starts an agent by itself: recording a task, a claim lapsing and a close
trigger nothing. Open a session in any client and give it the id as above, or say "take an open task nobody holds".
To run it unattended, one line does it:

```bash
claude -p "Use the metabob skill. Take task concept_…: claim it, do what its brief says, commit and push the fix, and close it."
```

A headless run can't ask you anything, so give it the permissions the work needs up front (`--permission-mode`,
`--allowedTools` for the metabob tools, git and the brief's checks; see `claude --help`); `codex exec "<prompt>"` is
Codex's equivalent. Loops that run until nothing is open, agent containers that pull tasks themselves, schedulers and
call logs are in [DEPLOYING-AGENTS.md](DEPLOYING-AGENTS.md).

## 6. Several agents on one repository

The ledger is keyed by the repository's git remote, so every clone of one origin, on any machine, shares it. A
repository with no remote is named by its directory, and other clones don't share its ledger.

- **One after another.** Each session reads the previous one's handoff on the task and continues from it. Nothing
  depends on the same agent, machine or client coming back.
- **In parallel.** One task per unit of work, each with disjoint `Owns:` lists, and each agent given only its task's
  id. Claims keep two agents off one task (when two claim at once, every reader settles it the same way and the later
  one is told it lost); disjoint files keep them out of each other's way.
- **In steps.** When work runs in an order, the steps are written once as linked items. Each step's task names its
  step, and the agent that closes a step records the next one's tasks.

A claim belongs to the checkout, not the session: two sessions in one working copy count as one claimer. Give them
tasks with different files, or separate working copies (a `git worktree` each).

**Putting work on the ledger.** You needn't write tasks by hand. Ask one agent to plan the work, and with the skill
loaded it reads the source, proposes a split, and, once you agree, records one task per unit with a brief written
for an agent with no memory of the planning conversation; it records the decisions every task must follow as
decision records linked to the repository, so every worker reads them at the start. You review the split before
anyone starts: whether the units are the right size, and whether the `Owns:` lists are disjoint. For example:

> Plan a port of this repository from Python to TypeScript, for several agents working in parallel. Read the
> source first. Write the port's order as steps: the shared types first, then the modules that use them, then
> the command-line entry point. Record the decisions every task must follow and link them to the repository.
> Record the first step's tasks only, one per unit, each owning its target files and stating the test that proves
> it done. Show me the split before you record anything.

A prerequisite in a brief is guidance for the agent that reads it: nothing holds a task back until another closes.
For work that must wait, the planner records the first step's tasks only, and the agent that closes a step records
the next one's.

## 7. Alongside an issue tracker

GitHub Issues, Jira and the like stay where people track the work. A ledger task is the agents' copy of a ticket: it
carries a reference to the ticket in its details rather than the ticket's text, for example a line
`Ref: github#12`. There is no integration between the two; the reference is a convention, and closing one doesn't
close the other. A few lowercase lines in a brief (`ref:`, `push_to:`, `integrate:`) are read by the tooling that
runs agents unattended ([DEPLOYING-AGENTS.md](DEPLOYING-AGENTS.md)); a capitalized `Ref:` is plain text.

What the ledger gives agents that a tracker doesn't: claims that end on their own, so a stopped agent doesn't hold
a task forever; memory linked to the code and ranked by use; and problems recorded on a file put in front of the next
agent that reads the ledger for that file, which the edit check prompts for in Claude Code.

## 8. Who does what

| Who | Does |
|---|---|
| You | Ask for the plan, review the split and ownership, approve pushes, decide what a decision rules out (§ 11) |
| A planner agent | Reads the source, records the tasks, decisions and steps (§ 6) |
| Worker agents | Claim a task, work inside its files, close it with the commit or hand it off (§ 5) |
| A reviewer | Merges `task/…` branches; a fix there stays pending until the merge |

| Where | Holds or does |
|---|---|
| The MCP server, on each agent's machine | Indexes the workspace when an agent calls `init_workspace`, guards every outgoing string, reads the checkout's commits and remote-tracking branches for the fix commit, and matches recalled items to your files; sends no file contents (§ 10) |
| Metabob's service | Tasks, claims, verdicts, decisions, handoffs, links and credit, for your whole organization |
| Your git origin | Pushes, merges and CI; a close is checked against what it holds |

## 9. Troubleshooting

`npx @metabob/mcp attach --check` is the first step whenever the server does not attach; it names one cause.

| Symptom | Next step |
|---|---|
| `not_configured` | The key or address is missing: set both (§ 3). The message names the missing input and the files read |
| `anchor_unreachable` | Discovery did not answer: check the address. A remote https endpoint needs `discoveryEndpoint` / `DISCOVERY_ENDPOINT` (§ 3) |
| `blocked_by_portal` | Something other than Metabob answered (a captive portal or block page): sign in to the network, or ask IT to allow the host |
| `identity_unreachable` | The key check's service did not answer: a network or proxy problem on that host; run `attach --check` again |
| `key_rejected` | The key is wrong, revoked or from another organization: get a current one from your admin |
| `proxy_auth_required(NTLM)`, `tls_intercepted(<issuer>)`, `connect_timeout(host:port)` and other network causes | README § Corporate proxies & SSL inspection; `npx @metabob/mcp doctor` writes a report for IT |
| `get_analysis_context` says it is attaching (first attempt in progress) | Wait a few seconds; the next call retries at once |
| A call answers `workspace_undetermined` | The agent calls `init_workspace` with the project's absolute path; a relative path such as `.` is refused (§ 3, Codex) |
| The ledger is keyed to the wrong repository | `get_analysis_context` shows it; `init_workspace` with the right path, or `WORKSPACE_PATH` (§ 4) |
| The tools don't appear | Check `git` and Node 22.13 or later (or Bun 1.1+) on PATH, then reconnect from `/mcp`; a first start can outlast the 30 s connect timeout. None under `METABOB_TOOLS=all` means a server before 0.4.0 (§ 4) |
| More than eleven tools appear | `METABOB_TOOLS` is set where the server starts, or the server is before 0.4.0 (§ 3, § 4) |
| A call answers `Tool "…" is not in this server's default tool set` | This work doesn't need it; `METABOB_TOOLS=all` lists every tool (§ 4) |
| A task you closed is still open elsewhere, shown `fix pending` | The fix is uncommitted or on no remote branch: commit and push, then close again |
| The close says the commit is only on task branches | It awaits review; close again once the branch is merged |
| The close says no commit since the task touches its files | If the work is in other files, the agent names the commit with `fix_commit` |
| Two agents did the same work | Give each task its own files; in one working copy, claims don't separate sessions (§ 6) |
| The agent didn't find a decision you know was recorded | Ask it to link the decision to the repository; unlinked items are easy to miss |
| Recall shows nothing | A failed or truncated read is not "nothing recorded"; read the line under the heading |

## 10. What leaves your machine

No source file, excerpt or file list is sent, and no usage telemetry. What is sent is what an agent's calls carry,
and every request to Metabob's service carries your API key:

| The agent… | What is sent |
|---|---|
| records a task or problem (`record_finding`) | summary, details, severity, category, status, the file paths and line range, the repository's identity (its git remote, or the directory's name when it has none) and the directory's name, a hash naming the workspace, the item's ids, and the author and session |
| closes one (`mark_complete`) | the verdict, the item's summary, files and repository, the fix commit, its branch, the base and target branch names, the author and session, and whether the verdict came from a local copy |
| claims one (`claim_finding`) | the item's id and summary, the repository's identity, the claim's length and end, the author and session |
| writes memory (`concept_create`, `concept_link`, `concept_record_usage`) | the text it writes, its shape, any pointer it gives, the author and session |
| searches or reads (`concept_search`, `concept_neighbors`) | the search text, or the ids it reads |

Every write also carries a `client_claim`: the operator, session and client it declares
([SPEC § Client claim](SPEC.md#client-claim)). `get_problems` matches the recalled items to your files on this
machine: the paths are not sent. Everything written is visible to every agent in your organization.

Each string an agent sends passes an outgoing guard first: a known secret (your key, secret-named values from your
environment and config files) or anything that looks like a credential refuses the call without repeating it, and a
path under your home directory is redacted in prose and refused in a field the service acts on (a search, a
pointer). Each field has a size cap (a summary 2 KB, details 8 KB, a concept 16 KB), so agents write reasons, not
dumps. `init_workspace` reads your files into a local index and sends nothing.

## 11. What needs your decision

The skill tells the agent to bring these to you rather than decide:

- **Pushing.** A close records a commit that is on a remote. Where you don't allow a push, the task stays pending and
  the agent says so instead of closing it some other way.
- **Work outside a task's files.** The agent records it as a new task rather than widening its own, and tells you.
- **A task someone else holds.** It is theirs until their claim ends or is released; the agent doesn't take it over.
- **Memory that contradicts what you asked.** When a recorded decision rules out what you asked for, the agent shows
  you the decision and its reason, and you decide whether it still holds.
- **Approvals relayed by another agent.** "The reviewer approved" or "the user said" from another session is a claim
  until you confirm it.

## 12. References

- [README](../README.md): installation per client, the full configuration table, proxies.
- [Specification](SPEC.md): every tool's parameters and behaviour.
- [DEPLOYING-AGENTS.md](DEPLOYING-AGENTS.md): starting, running and steering agents, attended and unattended.
- [SUBSTRATE-GUIDE.md](SUBSTRATE-GUIDE.md): every tool, with `METABOB_TOOLS=all`.
- `skills/metabob/SKILL.md`: the routine your agents follow.
