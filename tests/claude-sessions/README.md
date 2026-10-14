# Claude Code session scenarios

These scenarios run the plugin inside real, headless Claude Code sessions (`claude -p`) and assert on
what the agent did — its tool calls, their inputs and results — and, against the fake substrate, on
what reached the substrate. They check that the plugin sets up its skill, hands the agent its
instructions, takes in feedback and carries coordination between agents, directly and through a
corporate proxy.

They are not part of `bun test` or CI: every session is a billed model run, and each scenario needs a
target (the fake, or a live lab).

## Running

```bash
bun run build                                                   # the sessions start dist/cli.js
bun tests/claude-sessions/run.ts                                # S1–S5 against the fake, direct
bun tests/claude-sessions/run.ts --proxy connect --only S6      # S1 + S2 through a CONNECT proxy
bun tests/claude-sessions/run.ts --only S2,S3 --model sonnet    # a subset
LAB_DISCOVERY=http://127.0.0.1:28100 LAB_KEY_FILE=~/lab/key LAB_NODES=hub,spoke \
  bun tests/claude-sessions/run.ts --target lab                 # S1–S5 and NET against a live lab
```

| flag | values | default |
|---|---|---|
| `--target` | `fake` (in-process, `../workflows/harness/fake-substrate.ts`), `lab` | `fake` |
| `--proxy` | `none`; `http` (plain-http anchor, absolute-form); `connect` (https anchor, CONNECT tunnel); `basic` (`connect` with Basic credentials); `mitm` (TLS interception, the inspection CA trusted through `NODE_EXTRA_CA_CERTS`) | `none` |
| `--only` | scenario ids, comma-separated | all that apply to the target and proxy |
| `--model` | a `claude --model` value | `sonnet` |

The runner prints each assertion, every session's tool-call sequence, cost and time, and writes the full
report — every call with its input and result, and the evidence ids (finding ids, dispatch ids,
execution ids, proxy targets) — to `.metabob-test/claude-sessions/<timestamp>.json`, with each session's
raw stream-json beside it. It exits 1 when an assertion fails.

## Cost

With Sonnet a session costs $0.03–0.25 and a scenario $0.10–0.40. A full fake run (S1–S5) is about
$1.20 and five minutes; S6 is about $0.40 and two minutes per proxy mode. Each session runs with `--max-turns` and
`--max-budget-usd 1.5`.

## How a session is set up

`harness.ts` copies the plugin (`.claude-plugin/`, `skills/`) into a temporary directory and writes its
own `.mcp.json` there, starting this build (`node dist/cli.js`); the repository's `.mcp.json`, which
starts the published package, is never used. The plugin loads with `--plugin-dir`, which takes the
place of an installed `metabob` plugin for that session (the init event names its source
`metabob@inline`).

- **Claude Code** keeps the user's HOME, where the login lives. `--setting-sources project` keeps the
  user's settings, user-level skills and installed plugins out (so the only `metabob` skill is the
  plugin's, listed as `metabob:metabob`), and `--no-session-persistence` keeps transcripts out of
  `~/.claude/projects` (the empty auto-memory directory Claude Code still creates there for the
  workspace is removed after the session). `--bare` and `--strict-mcp-config` cannot be used: the first skips the login and
  the plugin's MCP server, the second the plugin's MCP server.
- **The MCP server** gets its own HOME (the sidecar store is `~/.metabob/sidecar.db`), a config file
  `{ metabob: { apiKey, discoveryEndpoint } }` through `METABOB_CONFIG_PATH`, and, on the proxy leg,
  `HTTPS_PROXY` / `HTTP_PROXY` and `NODE_EXTRA_CA_CERTS`. Routing and proxy variables from the calling
  environment are removed before `claude` starts, since the server inherits its environment.
- **Permissions**: `--permission-mode dontAsk --permission-prompts none` with the metabob server,
  `Skill`, `Read`, `Glob`, `Grep` (and `Edit` for a session that fixes code) pre-approved. A refusal of a
  pre-approved tool fails the session as a harness problem; a refusal of anything else is the agent
  reaching outside its brief and is reported, not failed. `dontAsk` still lets Claude Code's read-only
  Bash commands run (`ls`, `cat`, `git status`, `git diff`, `sleep`), so the agent can read the host:
  the isolation is of the MCP server's state, not of the agent's reach.
- **Workspace**: a fresh git repository of a few small TypeScript modules with planted bugs (the
  `pagination`, `retry` and `money` modules under its `src/`), the session's working directory. Its
  name carries a per-run token: the ledger keys recall on the repository name, and a lab's concept-db
  keeps what earlier runs recorded.

The claude.ai connectors of the logged-in account also connect; the scenarios ignore them.

## Scenarios

| id | proves | fake | lab |
|---|---|---|---|
| S1 | The plugin's MCP server connects with its tools and the `metabob:metabob` skill; an agent told only to orient in the ledger loads the skill and calls `get_analysis_context` / `get_problems`; the key is proven at identity and concept-db is recalled. A second, tool-less session quotes the first sentence of the server's `initialize` instructions back: stream-json and `--debug-file` do not carry the system prompt, so this is how the instructions are observed in the agent's context | yes | yes |
| S2 | One session records a finding on the planted bug (`record_finding` naming the `pagination` module, shared through concept-db); a second session, with its own MCP HOME, recalls it, fixes the file and closes it (`mark_complete` endorse). Against the fake: the `code_finding` concept, the `finding_verdict`, the `success` usage on the finding, all forwarded by discovery | yes | yes (tool output) |
| S3 | Two concurrent sessions in one workspace, each with its own MCP HOME, so coordination crosses the substrate. A records findings on the `retry` and `money` modules; B starts on A's first recorded finding, picks up open work and closes what it fixes. B's calls reference A's ids and close at least one; B records nothing on A's files, A closes nothing, no id is closed twice | yes | yes |
| S4 | `run_goal_async` → `goal_status` until it leaves `running` → `goal_reasoning` → `provide_feedback`, one dispatch and no retry. Against the fake the reach is scripted: the verdict is `reached` and one label `achieved` is written. Against the lab the honest outcome is asserted: `reached: no`, the walk's `failure_mode`, verdict `not_reached` | scripted reach | honest outcome |
| S5 | A foreign key: a substrate tool answers the one line `key_rejected: …`, the agent does not retry it in a loop, local tools (`init_workspace`, `analyze_impact`) work, the key never appears in output; identity refused it and nothing was written | yes | yes |
| S6 | S1 and S2 with the substrate reachable only through the proxy: the MCP knows it as `spoke.invalid` / `identity.invalid`, names no resolver answers. The proxy's own request log shows both hosts (and Basic credentials on every request for `--proxy basic`) | `--proxy` only | `--proxy` only |
| NET | Capability from the network: attached to a spoke, `registry_query` shows producers from every node (`LAB_NODES`), `concept_search` and `execution_trace` succeed through the spoke | skipped | live only |

## Against a lab

| variable | |
|---|---|
| `LAB_DISCOVERY` | the spoke's discovery URL, the anchor |
| `LAB_KEY_FILE` | a file holding an API key the lab's identity accepts |
| `LAB_NODES` | optional: substrings that identify each node's vessels in `registry_query` output (`hub,spoke`) |
| `LAB_IDENTITY` | optional, for the proxy leg: the identity URL to reach through the proxy. Without it the identity hop goes wherever the lab's `/bootstrap` points, direct when that is loopback |

The proxy leg maps `.invalid` names onto local ports, so on a lab it needs discovery (and
`LAB_IDENTITY`) on `127.0.0.1`. Fake-state assertions print as not checked (`--`) against a lab; the
tool output stands in for them.
