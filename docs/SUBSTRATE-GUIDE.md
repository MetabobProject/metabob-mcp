# Metabob MCP user guide

This guide is for a person whose AI coding agent (Claude Code, Codex, Cursor, Continue or another MCP client)
runs the Metabob MCP server with **`METABOB_TOOLS=all`**: every tool, with the `metabob-substrate` skill. That is
the shared ledger and memory, the local code tools and an operator's cockpit for the substrate.

**Which guide is yours.** With `METABOB_TOOLS` unset, the server lists eleven tools, the shared task ledger and
memory (`get_analysis_context`, `get_problems`, `claim_finding`, `record_finding`, `mark_complete`,
`concept_search`, `concept_neighbors`, `concept_create`, `concept_link`, `concept_record_usage` and
`init_workspace`), for which the `metabob` skill is written; that reader's guide is
[USER-GUIDE.md](USER-GUIDE.md). To tell which you have, look at the tools the server lists (in Claude Code,
`/mcp` → `metabob`): eleven, read USER-GUIDE.md; more, read on; none, `METABOB_TOOLS=all` is set on a server
before 0.4.0 (§ 2). To list every tool, set `METABOB_TOOLS=all` in the server's environment (§ 2).

Exact tool parameters are in the [specification](SPEC.md); installation details per client are in the
[README](../README.md).

## 1. What it is for

You do not call Metabob's tools. Your agent does, and you see the effect in what it tells you and in what
other agents know afterwards. Metabob gives agents three things they lack on their own:

- **A shared ledger.** A problem one agent notices and does not fix is recorded against the files it concerns,
  and every later agent on the same repository, on any machine, is shown it before it edits those files. A
  fix closes it, with the commit that holds the fix.
- **Shared memory.** Decisions, the reasons behind them, and approaches that were tried and rejected are kept as
  concepts that later agents find by searching, so the reasoning outlives the session that had it. Whether a
  concept helped is recorded, so memory that keeps helping ranks higher.
- **Coordination.** An agent can say it is starting on a finding (a claim), so another agent does not start the
  same work, and an agent can see what the substrate itself has in flight on a file: its **gaps**, the work the
  substrate has identified in a repository it mounts, each queued, held, or being landed under a **landing
  lease** (the system applying a change to the file, with a holder and an expiry).

It also has local code tools (impact analysis `analyze_impact`, co-change history `predict_cochanges`, code
search `search_codebase`) that work in any repository with no substrate at all. They are listed under
`METABOB_TOOLS=all` only: the default set has `init_workspace` alone, which indexes the code. They are a
convenience; the ledger and memory are the reason to use it.

**The substrate** is the set of services behind it (a ledger and memory store, goal execution, discovery).
**Attached** means the MCP server has proven its API key with the substrate. Until then the substrate tools
answer with the reason, and the ledger tools (`get_problems`, `record_finding`, `mark_complete`) keep to this
machine's local store: what is recorded then reaches no other agent.

### What leaves your machine

The server sends no source file, excerpt or file list anywhere, and no usage telemetry. What reaches the
substrate is what an agent's tool calls carry. Every request carries your API key (to discovery, which forwards
it to the producing service; to the identity service for the key check; and, for `concept_usage_stats`' recent
rows only, straight to concept-db's advertised address). Writes name their author by the **vessel id**, the
identity this server writes as: `VESSEL_ID` when set, else a stable `metabob-mcp-<hash>` derived from the key and
the workspace, registered nowhere. Beyond the key:

| The agent… | What is sent |
|---|---|
| records a finding (`record_finding`) | summary, details, severity, category, status, the file paths and line range, the repository's identity (its git remote, or the directory's name when it has none) and the directory's name, a hash naming the workspace, the finding's ids, and the author (`recorded_by`, the vessel id) and session |
| closes a finding (`mark_complete`, `finding close`) | the verdict, the finding's summary again, its files and repository, the fix commit, its branch, the base and target branch names, the author (`reviewed_by`) and session, and whether the verdict came from a local copy |
| claims one (`claim_finding`) | the finding's id and summary, the repository's identity, the claim's length and end, the author and session |
| writes memory (`concept_create`, `concept_link`, `concept_record_usage`, `resolve_impulse`'s memory note) | the text it writes, its shape and source type, any pointer it gives (which can name a document path), the author and session |
| dispatches a goal (`run_goal_async`, `run_goal`) | the goal text, the learning mode, and its tags (`operator:`, `session:`, and any the agent adds) |
| gives a verdict on a goal (`provide_feedback`) | the verdict, rationale and confidence, with the operator and session in the notes |
| answers a queued task (`submit_resolution`) | the answer text |
| searches or reads (`concept_search`, `goal_status`, `goal_reasoning`, `execution_trace`, …) | the search text, or the ids it reads |

Every write also carries a `client_claim` (the operator, which is `MB_OPERATOR_ID` or the vessel id, the
session and the client version); `METABOB_CLIENT_CLAIM=off` drops it. `path_activity` and the recall behind
`get_problems` match paths on this machine: the paths are not sent.

Each string an agent sends passes an outgoing guard first. A known secret (your key, secret-named values from
your environment and from the workspace's and your config files) or a credential pattern refuses the call
without repeating the value, and the refusal tells the agent to remove the credential or mask it
(`postgres://admin:***@host`) and call again. A secret is matched as written: an encoded or split one is not caught. A path under your
home directory is redacted in prose and refused in a field the substrate acts on. Every write is checked once more
as the server composes it, so a line the server adds itself never carries your key or a home path. The local code
tools send nothing.

## 2. Set up

### What you need

Two values, neither with a default: an **API key** and the **substrate's address**.

- The key comes from your organization's Metabob admin, or from your Metabob account. Every agent that shares
  the work uses a key from the same organization.
- The address is, for a substrate on your own machine, its endpoint (`http://127.0.0.1:18080`); for a remote
  substrate, its discovery endpoint (`https://…`), which you get with the key.

### With the substrate installer

The substrate installer is the program that sets up a substrate on your machine. It writes your API key and the
local endpoint to `~/.substrate/config.json`, which the server reads; nothing else is needed. That file wins over
`~/.metabob/config.json` when both exist.

### Without the installer

Put the key and the address in `~/.metabob/config.json`, or in `./.metabob/config.json` in the directory the
server starts in (an MCP client usually starts it in the project) for that project alone; the full lookup order
is in the README, § Configuration. For a local substrate:

```json
{ "metabob": { "apiKey": "mb_your_api_key_here", "endpoint": "http://127.0.0.1:18080" } }
```

For a remote one:

```json
{ "metabob": { "apiKey": "mb_your_api_key_here", "discoveryEndpoint": "https://discovery.example.com" } }
```

The server finds discovery, the substrate's front door, from the address. An `http://` endpoint with an explicit
port whose last two digits are 80 (`:18080`) gives it (`:18100`); any other endpoint (https, or http with no port
or another port) gives none (`src/config.ts@deriveLocalDiscoveryEndpoint`), so a remote substrate takes
`discoveryEndpoint`.

Or export them: `METABOB_API_KEY` with `METABOB_ENDPOINT` (local) or `DISCOVERY_ENDPOINT` (remote). An exported
`METABOB_ENDPOINT` takes only the key from a config file, never its addresses, so a remote `METABOB_ENDPOINT`
needs `DISCOVERY_ENDPOINT` beside it.

### Listing every tool

`METABOB_TOOLS=all` in the server's environment lists every tool; it is read when the server starts, so restart or
reconnect the client after setting it. It needs server 0.4.0 or later: an earlier one lists no tools for it. With
a plugin, the server's version is the plugin's own (its `.mcp.json` pins it), so a plugin before 0.4.0 lists none
under `all`. With a server you add yourself, if `npx -y @metabob/mcp --version` prints an earlier version, name a
0.4.0 or later version where you start the server. Where to set it in each client:
[USER-GUIDE.md](USER-GUIDE.md) § 2, and below.

### Claude Code: the plugin

```bash
claude plugin marketplace add https://github.com/MetabobProject/metabob-mcp.git
claude plugin install metabob@metabob
```

It needs `git` and Node 22.13 or later (or 23.4 or later) on PATH; an older Node works with [Bun](https://bun.sh) 1.1 or later on
PATH, and with neither `/mcp` shows the server failed. Use the https URL as written: the `owner/repo` shorthand
clones over ssh, which fails on a machine with no GitHub ssh key. `claude mcp list` shows
`plugin:metabob:metabob … ✔ Connected` when it works. The first start downloads the package; if that outlasts
Claude Code's 30 s connect timeout (a slow link, or Windows), reconnect from `/mcp`.

The plugin ships no credentials. It uses the installer's config or the config file above, or takes them as its
settings, at install or later with `/plugin configure`:

```bash
claude plugin install metabob@metabob --config api_key=mb_your_api_key_here --config discovery_endpoint=https://discovery.example.com
```

(`--config endpoint=http://127.0.0.1:18080` for a local substrate). A blank setting falls back to the config file.

The plugin brings three parts: the MCP server, the skills (`metabob` for the default tool set, `metabob-substrate`
for `METABOB_TOOLS=all`, loaded by the agent at the start of a session), and the **edit check** (§ 3). For every
tool, set `METABOB_TOOLS` in `~/.claude/settings.json` as `{ "env": { "METABOB_TOOLS": "all" } }`, or export it
in the shell that starts `claude`.

### Codex: the plugin

```bash
codex plugin marketplace add https://github.com/MetabobProject/metabob-mcp.git
codex plugin add metabob@metabob
```

It brings the MCP server and the skills; there is no edit check outside Claude Code, and no plugin settings, so
the key and address come from the installer's config or `~/.metabob/config.json`. Codex starts the server in the
plugin's own folder without saying which project you are in, so the agent's first call is
`init_workspace { workspace_path: "<your project's absolute path>" }`; until then every tool answers
`workspace_undetermined`, and the skill tells the agent what to do.

The plugin's server takes no extra environment, so for every tool remove the plugin
(`codex plugin remove metabob@metabob`), add the server yourself
(`codex mcp add metabob --env METABOB_TOOLS=all -- npx -y @metabob/mcp@latest`) and install the skill as for
other clients (below).

### Other clients

Add the server to the client's MCP configuration (the README shows each client's format):

```json
{ "mcpServers": { "metabob": {
    "command": "npx", "args": ["-y", "@metabob/mcp@latest"],
    "env": {
      "METABOB_TOOLS": "all",
      "METABOB_API_KEY": "mb_your_api_key_here",
      "DISCOVERY_ENDPOINT": "https://discovery.example.com"
    } } } }
```

For a local substrate, `METABOB_ENDPOINT` takes the place of `DISCOVERY_ENDPOINT`. Leave the key and address out
of `env` when the installer's config or a config file supplies them.

Then install the skill: copy `skills/metabob-substrate/` (in this repository, and in the npm package) into the
client's skills directory, `~/.claude/skills/` for Claude Code or `~/.codex/skills/` for Codex. A client with no
skills directory takes it through its rules file: point `AGENTS.md` (or `.cursor/rules`, Copilot instructions;
see the README) at the skill's `SKILL.md`.

The server sends its own instructions to the client (load the skill, check before editing, record what you do not
fix), but not every client shows them to the agent: Codex and Gemini CLI document doing so, others may not. In
those, the rules file carries the session rules too. The edit check is a Claude Code hook and exists only there.

### Check the connection

```bash
npx @metabob/mcp attach --check
```

It walks each step (proxy, TLS, discovery, identity, the key check, one read) and names the cause of a failure:
`key_rejected`, `anchor_unreachable` (discovery does not answer), `proxy_auth_required(NTLM)`, `tls_intercepted(<issuer>)` and so on.
Corporate proxies and inspected TLS come from your environment (`HTTPS_PROXY`, `NO_PROXY`,
`NODE_EXTRA_CA_CERTS`) and the OS trust store, never from Metabob's config. When the substrate is briefly
unreachable at start, the server retries on its own and on the next substrate call.

Ask your agent for `get_analysis_context` at any time: its first line says whether the session is attached, to
which org, and under which identity it writes.

## 3. A session, as you see it

You give your agent its task as usual. With the `metabob-substrate` skill loaded, it does the following without
being asked.

**At the start.** It checks the attachment and the open findings for the repository (`get_analysis_context`,
`get_problems`), indexes the code locally (`init_workspace`) and may list the decisions recorded for the
repository (`concept_search`). It mentions findings other agents recorded on the files your task touches;
`get_problems` also lists recently closed ones, in a trailing section.

**Before editing a file.** It looks up what is known to be wrong in that file (`get_problems`) and what the
substrate has in flight on it (`path_activity`). In Claude Code the edit check prompts for this: it holds the
first edit of each existing file in a session once, with a note asking for those two calls (`get_problems` alone
when the server does not list `path_activity`, as with the default tool set). The retry goes
through either way, so it is a reminder, not a lock. It holds nothing while the server is not attached, nor for
a new file, a second edit of the same file, or a file outside the workspace. Once `path_activity` reports that
the substrate does not mount the repository, nothing can be in flight there, and the check asks for
`get_problems` only. `METABOB_EDIT_CHECK=off` turns it off.

**While working.** A problem it notices and is not fixing goes into the ledger (`record_finding`) rather than
only into its reply. If the same open finding exists it is shown that one instead of making a duplicate. A
decision worth keeping, and especially a rejected approach, goes into memory (`concept_create`).

**After the fix.** It commits, pushes where you allow it to, and closes the finding (`mark_complete`, endorse).
The close records the commit. It is not taken on the agent's word:
- a fix still uncommitted leaves the finding open for everyone else, shown `[fix pending: …]`;
- a commit no remote branch has yet does the same in a checkout with a remote: "push it, then mark_complete
  endorse again". If you do not let the agent push, the finding stays pending and it tells you so;
- a commit only on task branches (`task/…`, which a review merges) leaves it open too, shown `[fix pending:
  pushed …, awaiting merge into <target>]`, the origin's default branch, until an endorse finds it merged or `finding close` (§ 8) sees the merge;
  a commit on any other remote branch counts;
- a commit must postdate the finding and touch its files, or be named as the fix (`fix_commit`): a named commit
  in other files must postdate the finding, and one made before the finding was recorded must touch its files;
- a fix that deleted the finding's files counts (git history still knows them); a finding whose files are all
  ignored (`.gitignore`) closes as local to this checkout;
- when none of the finding's files is known to this checkout (on disk or in its history), or the finding has no
  recorded time, nothing here can be shown to be its fix, and it stays open;
- a false positive is closed with discard instead.

**At the end.** It records what it noticed and did not fix, closes every finding it resolved, and writes down
the session's decisions. Skip that, and the next agent is offered finished work as open.

What the agent tells you about all this is short: which findings bear on your task, what it recorded, what it
closed, and anything that needs your decision (§ 5).

## 4. What to ask your agent

| You want | Ask, for example | What the agent does |
|---|---|---|
| To know what is already known about some code | "What do other agents know about `src/payments/`?" | `get_problems` for those files, `concept_search` for decisions |
| To keep a problem for later | "Record that as a finding, don't fix it now" | `record_finding` with files, severity, details |
| To know what is in flight before you edit | "Is anything in flight on the file I am about to change?" | `path_activity` (`METABOB_TOOLS=all` only): gaps the system is landing, queued or held |
| To keep a decision | "Write down why we chose the queue over polling, and that polling was rejected" | `concept_create`, linked to the repository's anchor concept: a `repo_anchor` concept named after the repository, which its decisions link to so later agents find them (the agent creates it when there is none) |
| The blast radius of a change | "What does changing this file affect, and which tests?" | `analyze_impact` (the local code index), `predict_cochanges` (git history); both `METABOB_TOOLS=all` only |
| To close something | "That finding was a false positive" | `mark_complete` discard |
| Several agents on one repository | "Record one task per area, then give each agent its id" | `record_finding` per task; each agent reads its own brief (§ 6) |
| The substrate to do the work (substrate repos) | "Dispatch a goal to …" | `run_goal_async`, then `goal_status`, `goal_reasoning`; all `METABOB_TOOLS=all` only |

You can always ask for the raw tool output.

## 5. Where your agent stops and asks you

Some calls are yours. The skill tells the agent to bring these to you rather than decide:

- **A landing lease.** When `path_activity` shows the system landing a change to a file right now, an edit
  before the lease ends is lost or conflicts. The agent tells you, and you decide whether to edit now.
- **A held gap or an operator ruling.** It says what lifts it; it is not open work.
- **Approvals relayed by another agent.** "the reviewer approved", "the user said" from another session is a claim until
  you confirm it. An agent does not relax a rule or skip a gate on a relayed approval.
- **Your judgment of an outcome.** An agent's verdict on a goal (`provide_feedback`) is stored as an
  `automated` observation; it never overrides the substrate's own verdict. A person's verdict goes through the
  substrate's human surface. The agent does not represent your view as its own.
- **Leases and the system's records.** The agent never takes or releases a maintenance or landing lease and
  never writes the system's traces, gaps or policy by hand; a lease that looks stuck is recorded as a finding.
- **Lab and load work on shared hosts.** A lab or a load test runs capped, in a window you clear. Running them
  is operator work: [DEPLOYING-AGENTS.md](DEPLOYING-AGENTS.md) for agents, [lab/README.md](../lab/README.md) for
  the lab.

## 6. Several agents on one repository

The ledger is keyed by the repository's git remote, so every clone of one origin, on any machine, shares it. A
repository with no remote is named by its directory, and other clones do not share its ledger. A
super-repo that holds vessels under `repos/<name>/` and each vessel's own checkout share one ledger for the
same file.

**Give each agent a brief with stated ownership.** Record one finding per unit of work, with the files it owns,
the test bar and what is out of bounds in its details, then give each agent only its id. It reads its own brief
from the ledger, and the brief outlives whoever wrote it. Findings in category `task` are listed apart from
problems, grouped as yours, unclaimed, someone else's and pending.

**An example.** In one session, ask for the task:

> Record a task for another agent: the CSV export drops rows whose date is empty. Goal: every row is exported,
> an empty date as an empty field. Owns: the CSV writer under `src/export/` and its tests. Out of bounds:
> every other file. Done when: the export tests pass, with one for an empty date.

The agent records it (`record_finding`, category `task`) and replies with its id, `agf_…`. From any session on
the repository, "List the open tasks" shows it (`get_problems`): its summary, its id, and who holds it. Then, in
another session or another client:

> Take task agf_…: claim it, do what its brief says, commit and push the fix, and close it.

That agent claims the task (`claim_finding`), reads the brief in full (`get_problems` shows the summary and the
id of the task's concept; `concept_search { concept_id }` reads the details), works only in the files it owns,
commits and pushes, and closes the task with the commit (`mark_complete`, endorse). Without a push the task stays
`[fix pending]` (§ 3), and the agent says so. To plan a larger piece of work into tasks, and to start workers on
them, see [USER-GUIDE.md](USER-GUIDE.md) § 7 (putting work on the ledger) and § 8 (starting workers).

**Claims.** Before starting on a finding another agent could also take (a task or any other finding), an agent claims it
(`claim_finding`): recall then shows `[claimed by … until …: someone is working on it]`. A claim lasts 60
minutes by default (at most 240) and is renewed for longer work. The store has no lock, so two agents can claim
at once; one rule every reader applies decides the holder (the earliest live claim, the lower concept id on a
tie), and the loser writes a withdrawal. Closing the finding ends the claim. The holder sees its own claim as
`[yours: claimed by this checkout until …]` among the tasks.

The claimer is the **checkout**, not the session: two sessions in one working copy are one claimer. Recall
shows each of them `[claimed by this checkout …]`, and a second session's claim reads to it as "Renewed your
claim". Give agents that share a working copy disjoint ownership in
their briefs, or separate working copies.

## 7. Goals on the substrate

For repositories the substrate itself mounts, an agent can hand it a goal instead of doing the work:
`run_goal_async` with a goal in plain language ("edit `repos/<vessel>/src/<file>`: <the change>"), then
`goal_status` until it ends, then `goal_reasoning` for why it reached or fell short. Read **`reached`**, not
`status`: `completed` with `reached: no` is common. Even a reach is checked against the actual diff or answer.
Every dispatch teaches the substrate: the `learning:` line says what a walk recorded. After inspecting the result the agent may record its verdict (`provide_feedback`). After a miss it
tells you why and asks whether to retry, rephrase, or do the work itself.

On any other repository the substrate has no copy of your code, so the agent does the work and the ledger and
memory remain its coordination. The server receives no work from the substrate: `pull_assigned_work` says no
task can arrive in a session.

## 8. Agent cells

An agent can also run unattended in a container, one task at a time: `npx @metabob/mcp task pull` claims a task
and clones the repository, and `npx @metabob/mcp finding close` closes it once its fix is merged. Setting up
cells, headless runs and call logs (`METABOB_CALL_LOG`) is operator work, in
[DEPLOYING-AGENTS.md](DEPLOYING-AGENTS.md).

## 9. Memory that improves with use

A concept records content; the substrate tracks whether it helped. When an agent relies on a concept and it
helps or misleads, it says so (`concept_record_usage`: success, failure or neutral), and the concept's relevance
is `(times_succeeded + 1) / (times_loaded + 2)`. Closing a finding does the same for the finding: endorse
credits it, discard counts against it. Relevance is a ranking signal, not an approval or a permission.

Corrections are appended, never overwritten: a wrong concept is answered by a new one linked with `contradicts`
or `derived_from`, and a contradiction preserves the disagreement without deciding it. Put scope, evidence and
the conditions that would invalidate the advice in the content; they are conventions, not enforced fields.

## 10. Troubleshooting

| Symptom | Next step |
|---|---|
| The tools do not appear | Reconnect the client; check Node 22.13+ or 23.4+ (or an older Node with Bun 1.1+) on PATH and the server entry. A server before 0.4.0 lists none under `METABOB_TOOLS=all` (§ 2) |
| A substrate tool answers with a named cause | `npx @metabob/mcp attach --check`; the cause is the attachment's state, not a transient error |
| "Attaching (first attempt in progress)" | Wait a few seconds; the next substrate call retries at once |
| A finding you closed is still open elsewhere | Its fix is pending: commit and push it, then endorse again |
| The close says the commit predates the finding and touches none of its files | That commit is not the fix; name the commit that changed the finding's files |
| The close says no commit since the finding touches its files | If the fix is in other files, name its commit with `fix_commit` |
| The close says the commit is on no remote branch | Push it, then endorse again |
| The close says the commit is only on task branches | It awaits review: once merged, fetch and endorse again, or run `npx @metabob/mcp finding close` |
| The close says none of the finding's files is here | Endorse from the checkout that has the fix |
| The close says git did not answer in time | Try again |
| Two agents did the same work | Give stated, disjoint ownership; in one working copy, claims do not separate sessions |
| Recall shows nothing | A failed or truncated read is not "no findings"; read the line under the heading |
| Corporate TLS fails | `npx @metabob/mcp doctor` writes a diagnostic report; review it before sharing |

## 11. References

- [README](../README.md): installation per client, configuration, proxies.
- [Specification](SPEC.md): every tool's parameters and behaviour.
- [Conformance](CONFORMANCE.md): how this client takes part in the substrate.
