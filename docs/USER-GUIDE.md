# User guide

Metabob gives your AI coding agents a shared task ledger and a shared memory, so each agent on a repository builds
on what the others did. This guide covers the default setup: the plugin, eleven tools and the `metabob` skill. For
every tool (`METABOB_TOOLS=all`), see [SUBSTRATE-GUIDE.md](SUBSTRATE-GUIDE.md).

## 1. Install

You need an API key from your organization's Metabob admin (or your Metabob account) and an address: for a remote
service, its discovery endpoint (`https://…`); for one on your machine, `http://127.0.0.1:18080`. Every client
needs `git` and Node 22.13 or later (or 23.4 or later) on PATH, or an older Node with [Bun](https://bun.sh) 1.1 or
later.

### Claude Code

```bash
claude plugin marketplace add https://github.com/MetabobProject/metabob-mcp.git
claude plugin install metabob@metabob --config "api_key=<your key>" --config "discovery_endpoint=<https://…>"
```

For a service on your machine, use `--config endpoint=http://127.0.0.1:18080` instead of `discovery_endpoint`.
Change the settings later with `/plugin configure`. `claude mcp list` shows `plugin:metabob:metabob … ✔ Connected`;
if the first start times out, reconnect from `/mcp`.

### Codex

```bash
codex plugin marketplace add https://github.com/MetabobProject/metabob-mcp.git
codex plugin add metabob@metabob
```

Put the key and address in `~/.metabob/config.json`:

```json
{ "metabob": { "apiKey": "<your key>", "discoveryEndpoint": "<https://…>" } }
```

(for a service on your machine, `"endpoint": "http://127.0.0.1:18080"` instead of `discoveryEndpoint`).
`codex mcp list` shows `metabob … enabled`.

### Other clients

Add this to the client's MCP configuration (Cursor `.cursor/mcp.json`, Claude Desktop, Continue and others; the
[README](../README.md#integrations) shows each file):

```json
{ "mcpServers": { "metabob": {
    "command": "npx", "args": ["-y", "@metabob/mcp@0.4.1"],
    "env": { "METABOB_API_KEY": "<your key>", "DISCOVERY_ENDPOINT": "<https://…>" } } } }
```

Then install the skill: copy `skills/metabob/` from [this repository](https://github.com/MetabobProject/metabob-mcp)
into `~/.claude/skills/` or `~/.codex/skills/`, or point your rules file (`AGENTS.md`, `.cursor/rules`) at its
`SKILL.md`.

### Check it

```bash
npx @metabob/mcp attach --check
```

It ends with `attached`, or names what is wrong (§ 6).

## 2. What it does

You don't call the tools; your agent does, guided by the skill. In each session it:

- **starts** by reading the open tasks and problems for the repository, and the decisions and handoffs other
  agents recorded, and tells you what bears on your request;
- **claims** a task before working on it, so no other agent starts the same work;
- **records** problems it notices and doesn't fix, and decisions worth keeping, with the approach it rejected;
- **closes** what it finished, with the commit, once the fix is pushed;
- **hands off** unfinished work with a note, so the next agent continues from there.

When something needs your decision (a push it isn't allowed to make, work outside its task's files, a recorded
decision that contradicts your request), it records it on the ledger and carries on with the rest. In Claude Code, the plugin also reminds the agent to check the ledger before its
first edit of each file.

The tools it uses:

| Tool | What the agent uses it for |
|---|---|
| `get_analysis_context` | Which repository it is on, and whether it is connected |
| `get_problems` | The open tasks, who holds them, problems, and what closed |
| `claim_finding` | Taking a task, renewing it, releasing it |
| `record_finding` | Recording a problem, or a task for another agent |
| `mark_complete` | Closing what it finished, or what turned out not to be real |
| `concept_search` | Finding what earlier agents learned, or reading a task's brief |
| `concept_neighbors` | Following links: a task's handoffs, a repository's decisions |
| `concept_create` | Writing a decision, a handoff or a step |
| `concept_link` | Attaching what it wrote to the repository or task |
| `concept_record_usage` | Crediting what helped, marking what misled |
| `init_workspace` | Naming the project, when the client didn't |

## 3. What to ask for

| You want | Ask, for example |
|---|---|
| What's known about some code | "What have other agents recorded about `src/payments/`?" |
| To keep a problem for later | "Record that, don't fix it now" |
| To keep a decision | "Write down why we chose the queue over polling, and why polling fails" |
| To continue earlier work | "Pick up the payments task where it was left" |
| To stop and hand over | "Stop here and hand this off" |
| To split work | "Make one task per area, each owning its files" |
| Work that changes no code | "Record a task: triage issue #12 and say whether it fails on main" |
| To plan larger work | "Plan the port to TypeScript as tasks for several agents; show me the split first" |
| To record a process | "Write down the release process as steps" |
| To fix the memory | "That decision is out of date: we moved to webhooks" |
| To close something | "That finding was a false positive" |

## 4. Hand a task to another agent

1. In one session, ask for the task, with what it owns and how to tell it's done:

   > Record a task for another agent: the CSV export drops rows whose date is empty. Owns: the CSV writer under
   > `src/export/` and its tests. Done when: the export tests pass, with one for an empty date.

2. Note the task's `concept_…` id from the reply, or ask any session to "list the open tasks".
3. In another session (any client, any machine with a checkout of the repository), give it the id:

   > Take task concept_…: claim it, do what its brief says, commit and push the fix, and close it.

4. The agent claims it, reads the brief, works in the files it owns, commits, pushes and closes it. If it can't
   push, the task stays `fix pending`.

A task doesn't have to change code: "triage issue #12", "review the release checklist" or "check the staging
deploy" names what it is about instead of files, and the agent closes it with what it found and a link to it.

For parallel agents, give each task its own files and run each agent in its own clone or `git worktree`. To run
agents unattended, see [DEPLOYING-AGENTS.md](DEPLOYING-AGENTS.md).

## 5. Settings

Set these in the server's environment: for the Claude Code plugin, in `~/.claude/settings.json` as
`{ "env": { "NAME": "value" } }`; for other clients, in the server's `env`. Restart or reconnect after a change.

| Setting | Effect |
|---|---|
| `METABOB_TOOLS=all` | Lists every tool ([SUBSTRATE-GUIDE.md](SUBSTRATE-GUIDE.md)); a comma-separated list lists those tools only |
| `METABOB_EDIT_CHECK=off` | Turns off the Claude Code edit reminder |
| `WORKSPACE_PATH=<path>` | Names the project when the client starts the server elsewhere |
| `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS` | A corporate proxy or root certificate |

A `.metabob/config.json` in a project gives that project its own key or address (not with the Codex plugin).
Every setting is in the README's [Configuration](../README.md#configuration) section.

## 6. Troubleshooting

Start with `npx @metabob/mcp attach --check`.

| You see | Do |
|---|---|
| `not_configured` | Set the key and the address (§ 1); a remote service needs `discovery_endpoint` / `discoveryEndpoint` |
| `key_rejected` | Get a current key from your admin |
| `anchor_unreachable` | Discovery didn't answer at the address set: check it and the network |
| `identity_unreachable`, `blocked_by_portal` | A network problem: sign in to the network or ask IT to allow the host |
| `proxy_auth_required(…)`, `tls_intercepted(…)` | Set the proxy or certificate (§ 5); `npx @metabob/mcp doctor` writes a report for IT |
| `get_analysis_context` says "attaching (first attempt in progress)" | Wait a few seconds; the next call tries again |
| `workspace_undetermined` | Ask the agent to call `init_workspace` with the project's absolute path |
| The tools don't appear | Check `git` and Node on PATH, then reconnect from `/mcp` |
| More than eleven tools appear | Remove `METABOB_TOOLS` from the server's environment and reconnect; with a server you added yourself, name `@metabob/mcp@0.4.1` |
| A task you closed shows `fix pending` | Commit and push the fix, then ask the agent to close it again |
| Two agents did the same work | Give each task its own files, and each agent its own clone |

## 7. What leaves your machine

No source code, excerpts or file lists, and no telemetry. Only what your agents record (tasks, problems, decisions,
handoffs, claims and closes, with file paths and commit ids) is sent, and everyone in your organization can read it.
Your key and anything that looks like a secret are never included in what is recorded.

## 8. More

- [README](../README.md): every client and setting.
- [DEPLOYING-AGENTS.md](DEPLOYING-AGENTS.md): running agents unattended, and controlling them.
- [SUBSTRATE-GUIDE.md](SUBSTRATE-GUIDE.md): every tool.
- [Specification](SPEC.md): each tool's parameters.
