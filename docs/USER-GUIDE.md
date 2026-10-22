# Metabob MCP user guide

This guide is for a person who works with an AI coding agent (Claude Code, Cursor, Codex, Continue or any MCP
client) and wants that agent to take part in Metabob. It describes the development tree of `@metabob/mcp`;
items marked **(0.3.5)** are not in the published 0.3.4. Exact tool parameters are in the
[specification](SPEC.md); installation details per client are in the [README](../README.md).

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
  same work, and an agent can see what the substrate itself has in flight on a file.

It also has local code tools (impact analysis, co-change history, code search) that work in any repository with
no substrate at all. They are a convenience; the ledger and memory are the reason to use it.

**The substrate** is the set of services behind it (a ledger and memory store, goal execution, discovery).
**Attached** means the MCP server has proven its API key with the substrate. Until then the substrate tools
answer with the reason, and the ledger tools (`get_problems`, `record_finding`, `mark_complete`) keep to this
machine's local store: what is recorded then reaches no other agent.

### What leaves your machine

The server sends no source file, excerpt or file list anywhere, and no usage telemetry. What reaches the
substrate is only what an agent writes through a tool:

| The agent… | What is sent |
|---|---|
| records a finding (`record_finding`) | its summary, details, severity, category, the file paths and the repository's identity (its git remote) |
| closes or claims one (`mark_complete`, `claim_finding`) | the verdict, the fix commit's id, paths |
| writes memory (`concept_create`, `concept_link`, `concept_record_usage`) | the text it writes |
| dispatches a goal (`run_goal_async`, `run_goal`) | the goal text |

Every one of these passes an outgoing guard first: a known secret (your key, secret-named values from your
environment and config files) or a credential pattern refuses the call without repeating the value, and a
home-directory path is redacted. The local code tools send nothing.

## 2. Set up

### With the substrate installer

The substrate installer writes your API key and endpoint to `~/.substrate/config.json`. The MCP server reads
it; nothing else is needed.

### Claude Code: the plugin

```bash
claude plugin marketplace add MetabobProject/metabob-mcp
claude plugin install metabob@metabob
```

The plugin brings three parts: the MCP server, the `metabob` skill (the rules and order of a session, loaded
by the agent at the start), and the **edit check** (§ 3). Without the installer's config, put the key and
endpoint in `~/.metabob/config.json`:

```json
{ "metabob": { "apiKey": "mb_your_api_key_here", "endpoint": "http://127.0.0.1:18080" } }
```

or export `METABOB_API_KEY` and `METABOB_ENDPOINT`. Use your substrate's endpoint; there is no default.

### Other clients

Add the server to the client's MCP configuration:

```json
{ "mcpServers": { "metabob": { "command": "npx", "args": ["-y", "@metabob/mcp"] } } }
```

Other clients get the same guidance from the server's own instructions, but not the edit check, which is a
Claude Code hook.

### Check the connection

```bash
npx @metabob/mcp attach --check
```

It walks each step (proxy, TLS, discovery, identity, the key check, one read) and names the cause of a failure:
`key_rejected`, `anchor_unreachable`, `proxy_auth_required(NTLM)`, `tls_intercepted(<issuer>)` and so on.
Corporate proxies and inspected TLS come from your environment (`HTTPS_PROXY`, `NO_PROXY`,
`NODE_EXTRA_CA_CERTS`) and the OS trust store, never from Metabob's config. When the substrate is briefly
unreachable at start, the server retries on its own and on the next substrate call.

Ask your agent for `get_analysis_context` at any time: its first line says whether the session is attached, to
which org, and under which identity it writes.

## 3. A session, as you see it

You give your agent its task as usual. With the skill loaded, it does the following without being asked.

**At the start.** It checks the attachment and the open findings for the repository (`get_analysis_context`,
`get_problems`), indexes the code locally (`init_workspace`) and may list the decisions recorded for the
repository (`concept_search`). It mentions findings other agents recorded on the files your task touches,
including ones closed recently.

**Before editing a file.** It looks up what is known to be wrong in that file (`get_problems`) and what the
substrate has in flight on it (`path_activity`). In Claude Code the edit check prompts for this: it holds the
first edit of each existing file in a session once, with a note asking for those two calls. The retry goes
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
- a commit counts once any remote branch holds it, a task branch not yet merged included; `finding close`
  (§ 8) is stricter and waits for the merge;
- a commit must postdate the finding and touch its files, or be named as the fix (`fix_commit`);
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
| To know what is in flight before you edit | "Is anything in flight on the file I am about to change?" | `path_activity`: gaps the system is landing, queued or held |
| To keep a decision | "Write down why we chose the queue over polling, and that polling was rejected" | `concept_create`, linked to the repository's anchor concept (a `repo_anchor` named after the repository, created when there is none) |
| The blast radius of a change | "What does changing this file affect, and which tests?" | `analyze_impact`, `predict_cochanges` (local) |
| To close something | "That finding was a false positive" | `mark_complete` discard |
| Several agents on one repository | "Record one task per area, then give each agent its id" | `record_finding` per task, each agent recalls its own brief |
| The substrate to do the work (substrate repos) | "Dispatch a goal to …" | `run_goal_async`, then `goal_status`, `goal_reasoning` |

You can always ask for the raw tool output.

## 5. Where your agent stops and asks you

Some calls are yours, and the agent is told to bring them to you rather than decide:

- **A landing lease.** When `path_activity` shows the system landing a change to a file right now, an edit
  before the lease ends is lost or conflicts. The agent tells you, and you decide whether to edit now.
- **A held gap or an operator ruling.** It says what lifts it; it is not open work.
- **Approvals relayed by another agent.** "qa approved", "the user said" from another session is a claim until
  you confirm it. An agent does not relax a rule or skip a gate on a relayed approval.
- **Your judgment of an outcome.** An agent's verdict on a goal (`provide_feedback`) is stored as an
  `automated` observation; it never overrides the substrate's own verdict. A person's verdict goes through the
  substrate's human surface. The agent does not represent your view as its own.
- **Leases and the system's records.** The agent never takes or releases a maintenance or landing lease and
  never writes the system's traces, gaps or policy by hand; a lease that looks stuck is recorded as a finding.
- **Load on shared hosts.** Labs and load tests run capped, in a window you clear.
- **A refused write.** When the outgoing guard refuses a call because it holds a secret, the agent writes it again
  without the secret; it never disguises the value to get it through.

## 6. Several agents on one repository

The ledger is keyed by the repository's git remote, so every clone of one origin, on any machine, shares it. A
repository with no remote is named by its directory, and other clones do not share its ledger. A
super-repo that holds vessels under `repos/<name>/` and each vessel's own checkout share one ledger for the
same file.

**Give each agent a brief with stated ownership.** Record one finding per unit of work, with the files it owns,
the test bar and what is out of bounds in its details, then give each agent only its id. It recalls its own
brief, and the brief outlives whoever wrote it. Findings in category `task` are listed apart from problems,
grouped as yours, unclaimed, someone else's and pending **(0.3.5)**.

**Claims (0.3.5).** Before starting on a finding another agent could also take (a task or any other finding), an agent claims it
(`claim_finding`): recall then shows `[claimed by … until …: someone is working on it]`. A claim lasts 60
minutes by default (at most 240) and is renewed for longer work. The store has no lock, so two agents can claim
at once; one rule every reader applies decides the holder (the earliest live claim), and the loser withdraws.
Closing the finding ends the claim.

The claimer is the **checkout**, not the session: two sessions in one working copy are one claimer, and recall
shows each of them `[claimed by this checkout …]`. Give agents that share a working copy disjoint ownership in
their briefs, or separate working copies.

## 7. Goals on the substrate

For repositories the substrate itself mounts, an agent can hand it a goal instead of doing the work:
`run_goal_async` with a goal in plain language ("edit `repos/<vessel>/src/<file>`: <the change>"), then
`goal_status` until it ends, then `goal_reasoning` for why it reached or fell short. Read **`reached`**, not
`status`: `completed` with `reached: no` is common. Even a reach is checked against the actual diff or answer.
A run whose purpose is to test the substrate rather than to get work done (a probe or a check) is dispatched with
`learning_mode: "observe"` so it does not teach the substrate; the `learning:` line says what a walk actually
recorded. After inspecting the result the agent may record its verdict (`provide_feedback`). After a miss it
tells you why and asks whether to retry, rephrase, or do the work itself.

On any other repository the substrate has no copy of your code, so the agent does the work and the ledger and
memory remain its coordination. The server receives no work from the substrate: `pull_assigned_work` says no
task can arrive in a session.

## 8. Agent cells (0.3.5)

An agent can also run unattended in a container, one task at a time:

```bash
metabob-mcp task pull --origin <git url>      # claim a task, write /task, clone /work
# … the harness works in /work and commits with a trailer:  Fixes-Finding: agf_…
metabob-mcp finding close --commits-from <file>   # after a push: close the findings those commits name, once merged
```

`task pull` takes this cell's own held task first, then the most severe unclaimed one, and writes the task, its
context (related open findings, the integration policy) and the base commit. `finding close` closes a finding
only once its fix is merged into the target branch on the origin, never over a revert. The lab's
`lab/cell.sh` builds such a cell with a pinned harness and caps (lab/README.md, "Agent cell").

For scoring how agents use the tools in any harness, `METABOB_CALL_LOG=<file>` appends one line per tool call
(tool, argument names and sizes, outcome, duration; never a value) **(0.3.5)**.

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
| The tools do not appear | Reconnect the client; check Node 18+ and Bun 1.1+ on PATH and the server entry |
| A substrate tool answers with a named cause | `npx @metabob/mcp attach --check`; the cause is the attachment's state, not a transient error |
| "Attaching (first attempt in progress)" | Wait a few seconds; the next substrate call retries at once |
| A finding you closed is still open elsewhere | Its fix is pending: commit and push it, then endorse again |
| The agent's close was refused | The commit predates the finding or touches none of its files: name it with `fix_commit` |
| Two agents did the same work | Give stated, disjoint ownership; in one working copy, claims do not separate sessions |
| Recall shows nothing | A failed or truncated read is not "no findings"; read the line under the heading |
| Corporate TLS fails | `npx @metabob/mcp doctor` writes a diagnostic report; review it before sharing |

## 11. References

- [README](../README.md): installation per client, configuration, proxies.
- [Specification](SPEC.md): every tool's parameters and behaviour.
- [Conformance](CONFORMANCE.md): how this client takes part in the substrate.
