# @metabob/mcp

A shared work ledger, code-structure tools and the substrate cockpit for AI agents (Claude Code, Cursor, Continue, and other MCP clients). Your workspace stays on your machine: the code index is local, and agents share only the findings and knowledge they record.

Start with the [user guide](docs/USER-GUIDE.md) for setup, shared memory, agent coordination, reusable procedures, and human controls.

## Quick Start

On a machine the substrate installer has set up, there is nothing to configure: the installer writes
the API key and the substrate endpoint into `~/.substrate/config.json`, and an MCP client entry needs
only the command:

```json
{ "mcpServers": { "metabob": { "command": "npx", "args": ["@metabob/mcp@latest"] } } }
```

Check that it attaches — and, when it does not, see what the network did — with:

```bash
npx @metabob/mcp@latest attach --check
```

It prints each hop (proxy, TLS, `/bootstrap`, identity, org check, one read through discovery) and
names the cause of a failure in one line: `proxy_auth_required(NTLM)`, `proxy_port_blocked(8443)`,
`tls_intercepted(<issuer>)`, `connect_timeout(host:port)`, `blocked_by_portal`, `key_rejected`, …
Exit 0 means attached. Without the installer, pass the two inputs:

```bash
npx @metabob/mcp@latest --api-key=mb_your_api_key_here --endpoint=http://127.0.0.1:18080
```

**Runtime**: Node 22.13 or later (or 23.4 or later) runs everything, the server included: its local store uses
Node's built-in `node:sqlite`. On an older Node, the server re-execs into [Bun](https://bun.sh) (≥1.1) when it is
on PATH, and names both fixes when it is not. `--help`, `--version`, and the `doctor`, `attach --check`, `task`
and `finding` subcommands run on any Node 18 or later, so you can always inspect the install and diagnose
connectivity.

On a host that has Bun but *no* Node at all, use `bunx @metabob/mcp` (the
node-shebanged bin cannot be exec'd without a `node` on PATH).

Supported platforms: Linux, macOS, and Windows x64. Windows ARM64 is unsupported.

No workspace content leaves the machine. `init_workspace` reads files into an in-process code property graph and sends nothing; there is no server-side analysis. Problems are what agents record with `record_finding`, shared with other agents on the same codebase through concept-db.

## Tools

**The default tool set.** With `METABOB_TOOLS` unset the server lists eleven tools, the shared task ledger and the
shared memory, and refuses a call to any other tool, saying how to list them. The `metabob` skill is written for
them, and [the user guide](docs/USER-GUIDE.md) covers them.

| Tool | Tier | Description |
|------|------|-------------|
| `get_analysis_context` | Local + Substrate | Where the agent is: the attachment, the repository the ledger is keyed to, open findings and recent recall |
| `get_problems` | Local + Substrate | The work queue: tasks with their claims, then problems ranked by severity, then what closed; the local store's findings plus those other agents recorded on this codebase |
| `claim_finding` | Substrate | Take a task before starting, renew it, release it; a key named in `METABOB_CLAIM_RELEASERS` may release a stalled claim, with a reason |
| `record_finding` | Local + Substrate | Record a problem or a task on its files, or, for work that changes no file, on a `subject`; shared with other agents on this codebase |
| `mark_complete` | Local + Substrate | Close a finding: endorse with the fix's commit, or, for one that names no file, with its `outcome` and `evidence`; discard a false positive. Accepts an `agf_*` id or the `concept_*` id recall shows |
| `concept_search` | Substrate | Find what earlier agents recorded, by topic or shape, or read one concept in full; each row shows the key that wrote it |
| `concept_neighbors` | Substrate | Follow a concept's links: a task's handoffs, a repository's decisions, the next step |
| `concept_create` | Substrate | Write a decision, a rejected approach, a handoff, a policy or a step; the author is stamped, and the ledger's own shapes are refused |
| `concept_link` | Substrate | Attach a concept to what it is about |
| `concept_record_usage` | Substrate | Credit what helped (`success`) and mark what misled (`failure`) |
| `init_workspace` | **Local** | Name the project and build the local code index; sends nothing off the machine |

**Every tool.** `METABOB_TOOLS=all` in the server's environment lists the rest as well: the local code tools
(`search_codebase`, `predict_cochanges`, `analyze_impact`, `annotate_component`, `get_metrics`,
`assign_git_changes`), the operator's cockpit (`path_activity`, `run_goal`, `run_goal_async`, `goal_status`,
`goal_reasoning`, `provide_feedback`, `registry_query`, `execution_trace`, `resolve_impulse`), two memory reads
(`concept_sequence`, `concept_usage_stats`) and the agent-task queue (`pull_assigned_work`, `submit_resolution`).
A comma-separated list lists exactly those tools. The `metabob-substrate` skill is written for `all`, and
[docs/SUBSTRATE-GUIDE.md](docs/SUBSTRATE-GUIDE.md) covers it; [docs/SPEC.md](docs/SPEC.md) gives every tool's
parameters.

**Local-tier** tools run entirely in-process via the vendored CPG implementation in `vendor/cpg-inference` (Tree-sitter parse → code property graph), git history and the local store, and make no network calls (`analyze_impact` and `assign_git_changes` also show `path_activity`'s cached gaps when attached). The CPG-backed ones require `init_workspace` to have run first; `predict_cochanges` reads git history and needs no index.

**Substrate-tier** tools (`record_finding`, `claim_finding`, `concept_*` (incl. `concept_record_usage`), `path_activity`, `run_goal` / `run_goal_async`, `goal_status`, `goal_reasoning`, `provide_feedback`, `registry_query`, `execution_trace`, `resolve_impulse`, `pull_assigned_work`, `submit_resolution`) need the attachment — an API key and an endpoint, from the environment or a config file (§ Configuration) — and reach the substrate through one ingress: each operation is a shape resolved through discovery's `POST /resolve`, which forwards it to the shape's producer. The server is a client of the substrate: it makes no discovery registration, runs no overlay node, and serves its HTTP resolver on `127.0.0.1` only. See [docs/SPEC.md](docs/SPEC.md).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `METABOB_API_KEY` | — | API key, sent as `Authorization: ApiKey` on every substrate request (`SUBSTRATE_API_KEY` is accepted too) |
| `METABOB_ENDPOINT` | — | Substrate endpoint. Env mirror of `metabob.endpoint` in the config file (`SUBSTRATE_ENDPOINT` is accepted too) |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | — | Corporate proxy, chosen per request; loopback always goes direct (§ Corporate proxies) |
| `DISCOVERY_ENDPOINT` | _(derived)_ | Discovery-vessel base URL; required with an endpoint that derives none (https, or a port not ending in 80) |
| `IDENTITY_ENDPOINT` | _(from discovery's `/bootstrap`)_ | Identity vessel for the key check, overriding the one discovery advertises |
| `SUBSTRATE_CONFIG_PATH`, `METABOB_CONFIG_PATH` | — | A config file to read, in that order, instead of the lookup below |
| `WORKSPACE_PATH` | _(the client's first root, else `$PWD`)_ | The workspace. The ledger is keyed by its repository: the `origin` URL, else its first commit (`root:<sha>`), else this directory (`local:<hash>`). An `init_workspace` path wins over it, and it wins over the client's roots (docs/SPEC.md § Workspace) |
| `VESSEL_ID` | `metabob-mcp-<hash(key + workspace)>` | The agent's identity: the claimer, and the author it declares on what it records |
| `METABOB_CLAIM_RELEASERS` | — | Comma-separated key ids (or names) whose release of someone else's claim this server takes; the same list on every server of a fleet |
| `METABOB_TASK_TRUST` | _(the task's own writing key)_ | `task pull`: comma-separated key ids (or names) whose conventions, endorsements and rulings set a task's integration policy |
| `METABOB_TASK_KINDS` | _(every kind)_ | `task pull`: comma-separated kinds of task to take, by the brief's `Kind:` line (a brief with none is `change`); same as `--kinds` |
| `NODE_EXTRA_CA_CERTS` | — | Extra trusted root certificates (PEM), on top of the bundled roots and the OS store |
| `METABOB_NO_SYSTEM_CA` | — | `1` skips the OS trust store |
| `METABOB_CONNECT_TIMEOUT_MS` | `5000` | Connect budget: TCP connect, proxy `CONNECT`, TLS handshake |
| `METABOB_TOOLS` | _(the default set)_ | Which tools the server lists: unset, the eleven of the shared ledger and memory; `all`, every tool; a list, exactly those (§ Tools) |
| `SESSION_ID` | random UUID | Session identifier |
| `HEALTH_PORT` | _(ephemeral)_ | Port of the loopback HTTP resolver |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error`: writes the lines at or above it |
| `MAX_REQUESTS_PER_MINUTE` | `60` | MCP rate limit per session |

The key and endpoint are read from the environment, else from a config file resolved directory-aware
like git: `SUBSTRATE_CONFIG_PATH` → `METABOB_CONFIG_PATH` → `./.substrate/config.json` →
`./.metabob/config.json` in the launch directory → `~/.substrate/config.json` (what the installer
writes) → `~/.metabob/config.json`. When both a `SUBSTRATE_*` and a `METABOB_*` name are set and
differ, the `METABOB_*` value wins, with one warning. CLI flags override environment variables, which override the config file.
With either input missing the server still starts with its local tools, and logs one message naming
what is missing. Run `metabob-mcp --help` for the full flag reference.

An `http://` endpoint on a port ending in 80, such as a local substrate's `http://127.0.0.1:18080`, derives
discovery at the same block's …100 (`:18100`); any other endpoint (https, or no explicit port) derives nothing, so
set `DISCOVERY_ENDPOINT` with it. An explicit `DISCOVERY_ENDPOINT`
still wins. No other service URL is configuration.

## Corporate proxies & SSL inspection

**First step: `npx @metabob/mcp attach --check`.** It names what the network did.

Proxy and trust come from the environment and the OS, never from a config file. Every request takes
one path (docs/SPEC.md § Network), identical under Bun and Node:

- **Explicit proxy** — `HTTPS_PROXY` / `HTTP_PROXY` (an HTTP CONNECT proxy), chosen per request and
  honouring `NO_PROXY`; `localhost`, `127.0.0.1` and `::1` always go direct. The anchor's host name is
  resolved by the proxy, so a network whose DNS reaches out only through the proxy works.
- **Basic auth** — put the credentials in the proxy URL (`http://user:password@proxy:3128`); they are
  redacted in every log line, `/health`, `doctor` and `attach --check`.
- **NTLM / Negotiate (Kerberos)** — not spoken directly: the failure is
  `proxy_auth_required(NTLM)` (or `Negotiate`), and the workaround is a local authenticating relay
  (a px- or cntlm-style proxy) with `HTTPS_PROXY` pointing at it.
- **PAC / WPAD** — not evaluated. When a direct connection fails, the OS proxy settings are read and
  named ("the OS proxy settings use a PAC script …; set HTTPS_PROXY").
- **Ports** — a proxy that tunnels only to 443 fails fast as `proxy_port_blocked(<port>)`; a plain-http
  anchor goes through the proxy without a tunnel.
- **Blackholed or slow** — a 5 s connect budget (`METABOB_CONNECT_TIMEOUT_MS`), separate from each
  call's response budget: a dropped connection fails as `connect_timeout` in seconds, and a connected
  but silent server as `response_timeout`. No call is held past 60 s.

Many enterprise networks (Zscaler, Netskope, Cisco Umbrella, Forcepoint, Palo Alto Prisma, Sophos, etc.) intercept TLS and re-sign it with an MDM-installed corporate root CA. Node.js ignores the OS trust store by default, so without mitigation every https call to the substrate would fail with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.

`@metabob/mcp` ships three mitigations out of the box:

1. **OS trust store auto-load** — the OS root CAs are read (via [`system-ca`](https://www.npmjs.com/package/system-ca)) and every substrate certificate is checked against them, the bundled roots and `NODE_EXTRA_CA_CERTS` (read by the server itself, so it applies under Bun too). No env vars required. Pass `--no-system-ca` (or set `METABOB_NO_SYSTEM_CA=1`) to opt out.
2. **Diagnostic TLS errors** — an untrusted chain fails as `tls_intercepted(<issuer>)` (`TLS_INTERCEPTED`), naming the intercepting CA, in the attachment's refusal, every substrate tool's error text, `/health`, `doctor` and `attach --check`, with what to do: trust the corporate root, set `NODE_EXTRA_CA_CERTS`, or exempt the substrate host from inspection.
3. **Fingerprint self-probe** — first successful TLS connect to each configured https substrate host records the leaf SPKI SHA-256 in `~/.metabob/known-hosts.json`. If a future connect serves a different fingerprint whose root is in your OS trust but not in the bundled Mozilla bundle, a one-time stderr warning identifies the likely MITM. Never blocks.

If you've installed the corporate root in your OS trust store, metabob-mcp will Just Work. If you haven't, you'll see a diagnostic TLS error telling you exactly what to do.

### Diagnosing corporate-proxy issues

If `attach --check` is not enough, run the bundled doctor to produce evidence you can hand to your IT team or attach to a support ticket:

```bash
npx @metabob/mcp doctor
# or, as a standalone bin (identical report):
npx -p @metabob/mcp metabob-mcp-doctor
```

The doctor probes the configured substrate's hosts, read the same way the server reads them — DNS resolution, OS trust store inspection (with vendor-CA matching for Zscaler / Netskope / Forcepoint / Palo Alto / etc.), TLS handshake capture (full chain, fingerprints, ALPN), and HTTPS request comparison (default vs OS-trust) — reports a missing key or endpoint, and writes a JSON artifact (`metabob-mcp-doctor-<timestamp>.json` in the current directory) alongside a human-readable report. No API key required.

## Integrations

### Local substrate

Point `metabob.endpoint` at a local substrate (`http://localhost:18080`) in a config file; no extra env vars are needed:

```bash
bun install
bun run build
npm link
claude mcp add metabob -- metabob-mcp
```

`metabob-mcp` reads the API key and endpoint from that config, derives the discovery-vessel URL, and resolves every substrate operation as a shape through discovery's `POST /resolve`. The substrate installer writes this config (`~/.substrate/config.json`, linked from `~/.metabob/config.json`).

### Claude Code

```bash
claude mcp add metabob -e METABOB_API_KEY=mb_... -e METABOB_ENDPOINT=http://127.0.0.1:18080 -- npx @metabob/mcp@latest
```

### Claude Code plugin (MCP server + skill + edit check)

This repo doubles as a plugin marketplace. The plugin bundles the MCP server, two skills (`metabob`, for the
default tool set: taking part in the shared ledger and memory; `metabob-substrate`, for `METABOB_TOOLS=all`: the
same plus the operator's cockpit, as coordinator, operator, verifier and client of shared memory), and an edit
check:

```bash
claude plugin marketplace add https://github.com/MetabobProject/metabob-mcp.git
claude plugin install metabob@metabob
```

It needs `git` and Node 22.13 or later (or 23.4 or later) on PATH (an older Node works with [Bun](https://bun.sh) 1.1+ on PATH):
Claude Code clones the marketplace with git, and the plugin starts the server with `npx`. Use the https URL: the `MetabobProject/metabob-mcp` shorthand makes
Claude Code clone over ssh, which fails on a machine with no GitHub ssh key, although the repository is
public. Check it with `claude mcp list`, which shows `plugin:metabob:metabob … ✔ Connected`. The first start
downloads the package with `npx`; where that takes longer than Claude Code's 30 s connect timeout (a slow link,
or Windows), `/mcp` shows the server failed, and reconnecting there starts it from the cache.

The plugin ships no credentials. The substrate installer writes them, and the plugin uses them as they
are. Otherwise give them as the plugin's settings, with `/plugin configure` in Claude Code or at install
(`claude plugin install metabob@metabob --config api_key=… --config discovery_endpoint=https://…`): the API key,
kept as a secret, and either the discovery endpoint of a remote substrate or a local substrate's endpoint. A blank
setting falls back to the installer's config file. Or put the key and endpoint in `~/.metabob/config.json`:

```json
{
  "metabob": {
    "apiKey": "mb_your_api_key_here",
    "endpoint": "http://127.0.0.1:18080"
  }
}
```

Alternatively, export `METABOB_API_KEY` and `METABOB_ENDPOINT` in your shell profile — the plugin's
MCP server inherits your environment. With either missing the server still starts with its local
tools, and says once which input is missing.

**The edit check** (`scripts/claude-plugin/edit-check.mjs`, shipped as `plugin/scripts/edit-check.mjs` and wired by `plugin/hooks/hooks.json`). Before an agent's first edit of an
existing file in a session, the plugin holds that edit once and asks the agent to run `get_problems`
for the file, and `path_activity` on it when the server lists that tool, then retry: other agents may
have recorded problems on the file, and the substrate may have work in flight there. A server with the
default tool set does not list `path_activity` (it names its tools in its marker), so its holds ask for
`get_problems` only. Holding the first edit once is what makes agents run the check; an instruction alone
does not. It holds only where the metabob server is
attached: while attached, the server keeps a marker for its workspace in the temp directory
(`src/attached-marker.ts`), and the check holds an edit only when a live, recent marker of the current user's covers the
session's directory (the marker is written 0600), so a plugin installed before a key is set, or with a rejected key, holds nothing.
A file the agent already checked with either tool is not held, nor is a new file, nor a second edit
of the same file, nor a file outside the attached workspace (a cache, a temp file, another checkout). In a repository the substrate does not mount, nothing is in flight: once
`path_activity` answers that the repository is not one the substrate mounts, holds in the session's
directory ask for `get_problems` only. `METABOB_EDIT_CHECK=off` turns it
off. If the check itself fails, the edit goes through. It is Claude Code's hook mechanism; other clients get the
before-edit rule from the server instructions and the `metabob-substrate` skill under `METABOB_TOOLS=all`, and not
at all under the default tool set, whose skill and instructions carry no before-edit step.

### Codex plugin (MCP server + skill)

```bash
codex plugin marketplace add https://github.com/MetabobProject/metabob-mcp.git
codex plugin add metabob@metabob
```

Codex reads `.agents/plugins/marketplace.json`, which lists the Agent Plugins bundle at the repository root
(§ Agent plugins): the server and the skills. Agent Plugins has no hooks and no settings, so there is no edit
check, and the key and endpoint come from the substrate installer's `~/.substrate/config.json` or from
`~/.metabob/config.json`. `codex mcp list` shows `metabob … enabled`.

Codex starts the server in the plugin's own folder and does not say which project the session is in, so every
tool answers `workspace_undetermined` until the agent calls `init_workspace { workspace_path: "<the project's
absolute path>" }`. The skill tells it to; a relative path such as `.` would name the plugin's folder and is
refused.

### Agent plugins

The plugins are generated, with `node scripts/build-plugins.mjs`, from one source: `package.json` (name,
version, description), `scripts/plugins/source.json` (metadata, the server entry and the settings),
the skills (`skills/metabob/SKILL.md`, for the default tool set, and `skills/metabob-substrate/SKILL.md`, for
`METABOB_TOOLS=all`) and `scripts/claude-plugin/edit-check.mjs`. The generated files are committed;
`tests/unit/plugin-bundles.test.ts` fails when one differs from what the generator writes, and CI validates
the Claude manifests with `claude plugin validate` and the Agent Plugins ones against the published 1.0
schemas (copies in `tests/fixtures/agent-plugins/`). Edit the source and regenerate, never a generated file.

The Claude Code plugin is `plugin/`, which the marketplace (`.claude-plugin/marketplace.json`) lists:
- `.claude-plugin/plugin.json`: the name, the version and the settings (`api_key`, sensitive;
  `discovery_endpoint`; `endpoint`; each blank by default);
- `.mcp.json`: the server, pinned to this exact version (`npx -y --package=metabob-mcp-server@npm:@metabob/mcp@<version> metabob-mcp`:
  the alias makes npx fetch the published package even in a checkout of this repository, whose own `package.json`
  npx would otherwise take for it), with each setting
  passed as the variable the server reads; a setting left blank reaches the server empty, so the config file
  applies, and a value still holding its placeholder text is ignored;
- `hooks/hooks.json`: the edit check, in exec form (`node` with its arguments, no shell), so a plugin path
  with spaces, or Windows, needs no quoting;
- `plugin/scripts/edit-check.mjs` and `plugin/skills/{metabob,metabob-substrate}/SKILL.md`, copies of the
  repository's own.

`plugin/` holds no `package.json`, so Claude Code runs no dependency install when it installs the plugin.

The [Agent Plugins 1.0](https://agent-plugins.org) bundle is the repository root, for harnesses that read the
portable format (Codex among them, through `.agents/plugins/marketplace.json`, which lists the root):
- `plugin.json`: the name, the version and the metadata;
- `mcp.json`: the same pinned server, with no environment. 1.0 carries no secrets, so the key and the endpoint
  come from the config file (`~/.substrate/config.json`, which the substrate installer writes, or
  `~/.metabob/config.json`; § Configuration);
- `skills/metabob/SKILL.md` and `skills/metabob-substrate/SKILL.md`, the skills.

1.0 has no hooks, so the edit check is Claude Code's alone; AGENTS.md carries the same rule for other harnesses.
The server takes its workspace from `WORKSPACE_PATH` when it is set, else from the client's MCP roots when the
client offers them, else from the directory it is started in; an `init_workspace` path wins over all three. A client that starts it in the plugin's own folder with no roots (Codex does) leaves the workspace
undetermined: every tool answers `workspace_undetermined` until the agent calls `init_workspace { workspace_path }`
with the project's root, which the skill does at the start of a session (docs/SPEC.md § Workspace).

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "metabob": {
      "command": "npx",
      "args": ["@metabob/mcp@latest"],
      "env": {
        "METABOB_API_KEY": "mb_your_api_key_here",
        "METABOB_ENDPOINT": "http://127.0.0.1:18080"
      }
    }
  }
}
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "metabob": {
      "command": "npx",
      "args": ["@metabob/mcp@latest", "--api-key=mb_your_api_key_here", "--endpoint=http://127.0.0.1:18080"]
    }
  }
}
```

### VS Code (Continue)

`.continue/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "metabob",
      "command": "npx",
      "args": ["@metabob/mcp@latest"],
      "env": {
        "METABOB_API_KEY": "mb_your_api_key_here",
        "METABOB_ENDPOINT": "http://127.0.0.1:18080"
      }
    }
  ]
}
```

## Development

```bash
git submodule update --init --recursive
bun install
bun run dev                         # start with watch mode
bun run typecheck                   # tsc --noEmit
bun run test                        # the full suite, as CI runs it
bash scripts/git-hooks/install.sh   # install the pre-commit and pre-push hooks
```

The local CPG implementation lives in `vendor/cpg-inference`, so a recursive submodule checkout is required before build, test, or dev commands.

To test the MCP server locally via the installed bin (mirrors the npm install flow):

```bash
bun run build   # compile src/ → dist/cli.js
npm link        # register metabob-mcp bin globally

# add to Claude Code pointing at the local build
claude mcp add metabob -e METABOB_API_KEY=mb_... -e METABOB_ENDPOINT=http://127.0.0.1:18080 -- metabob-mcp
```

`npm link` makes the local build available as `metabob-mcp` on your PATH without publishing to npm. Re-run `bun run build` after source changes.

## Agent instructions

One file holds the instructions for every AI coding agent working in this repository: [`AGENTS.md`](AGENTS.md)
(how to take part in the Metabob ledger while working here, and the development flow). Codex, GitHub Copilot
(coding agent, VS Code chat and code review on GitHub.com), Kiro, Cursor, Junie, Windsurf, Cline, Augment, Amp,
opencode and Zed read it as it is. Two harnesses get a pointer:

- `GEMINI.md` imports `@AGENTS.md`, since Gemini CLI reads `GEMINI.md` by default;
- `.continue/rules/metabob.md` (always applied) points Continue at `AGENTS.md`.

Claude Code reads [CLAUDE.md](CLAUDE.md), with the full architecture and the same development rules, and the
`metabob-substrate` skill (this repository's sessions run the server with `METABOB_TOOLS=all`). No `.github/copilot-instructions.md`, `.cursorrules` or `.windsurfrules` is kept: every harness
that reads one also reads `AGENTS.md`, and Zed takes the first of those files it finds, so a stale one would
hide `AGENTS.md`. See [docs/](docs/) for detailed references.
