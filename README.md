# @metabob/mcp

MCP server exposing Metabob code analysis to AI agents (Claude Code, Cursor, Continue, and other MCP clients).

## Quick Start

```bash
npx @metabob/mcp@latest --api-key=mb_your_api_key_here --endpoint=http://127.0.0.1:18080
```

The server attaches to a substrate with two inputs, an API key and the substrate's endpoint, and
neither has a default. On a machine the substrate installer has set up, both are already in
`~/.metabob/config.json` and `npx @metabob/mcp@latest` needs no flags.

**Runtime**: the bin starts under Node like any npm package, and the MCP server
itself runs on [Bun](https://bun.sh) (≥1.1) — it uses `bun:sqlite` for the local
analysis cache. A server invocation re-execs into `bun` automatically when it is on
PATH, and prints an install instruction when it is not. `--help`, `--version`, and
the `doctor` subcommand run under Node alone, so you can always inspect the install
and diagnose connectivity without Bun.

On a host that has Bun but *no* Node at all, use `bunx @metabob/mcp` (the
node-shebanged bin cannot be exec'd without a `node` on PATH).

Supported platforms: Linux, macOS, and Windows x64. Windows ARM64 is
unsupported (no Bun ARM64 build, no tree-sitter win32-arm64 prebuilds).

No workspace content leaves the machine. `init_workspace` reads files into an in-process code property graph and sends nothing; there is no server-side analysis. Problems are what agents record with `record_finding`, shared with other agents on the same codebase through concept-db.

## Tools

| Tool | Tier | Description |
|------|------|-------------|
| `init_workspace` | **Local** | Build the local CPG index; sends nothing off the machine |
| `get_problems` | Local + Substrate | Problems ranked by severity: the local store's findings (incl. agent-recorded `agf_*` findings) plus findings other agents recorded on this codebase, recalled from concept-db |
| `search_codebase` | **Local** | Search components (CPG) and the local store's findings by keyword |
| `predict_cochanges` | **Local** | Git-history co-change mining (primary) plus a GCN ranker that sees only node-name char-codes, so it ranks by name similarity, not learned structure — no API call |
| `analyze_impact` | **Local** | CPG traversal showing what a change affects |
| `annotate_component` | **Local** | Add structured why/how notes for a finding in the local store |
| `mark_complete` | Local + Substrate | Endorse a fix or discard a false positive. Accepts an `agf_*` finding id or the `concept_*` id it was recalled by (any other id is refused): endorse retires the local seed, discard removes it locally (the shared `code_finding` concept is not retracted); a verdict is best-effort written to concept-db |
| `get_metrics` | **Local** | Open findings by severity and source, plus the local CPG size |
| `assign_git_changes` | **Local** | Map changed files to CPG components + co-change predictions |
| `get_analysis_context` | Local + Substrate | Current analysis state snapshot for agent decision-making |
| `record_finding` | Local + Substrate | Attribute an issue you noticed to code — surfaces immediately in `get_problems` and is shared with other agents on this codebase via concept-db |

**Local-tier** tools run entirely in-process via the vendored CPG implementation in `vendor/cpg-inference` (Tree-sitter parse → embeddings → vector search) and the local store, and make no network calls. The CPG-backed ones require `init_workspace` to have run first.

**Substrate-tier** tools need the attachment — an API key and an endpoint, from the environment or a config file (§ Configuration) — and — `record_finding`, `concept_*` (incl. `concept_record_usage`), `run_goal` / `run_goal_async`, `goal_status`, `goal_reasoning`, `provide_feedback`, `registry_query`, `execution_trace`, `resolve_impulse`, `pull_assigned_work`, `submit_resolution` reach the substrate through one ingress: each operation is a shape resolved through discovery's `POST /resolve`, which forwards it to the shape's producer. The server is a client of the substrate: it makes no discovery registration, runs no overlay node, and serves its HTTP resolver on `127.0.0.1` only. See [docs/SPEC.md](docs/SPEC.md).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `METABOB_API_KEY` | — | API key, sent as `Authorization: ApiKey` on every substrate request |
| `METABOB_ENDPOINT` | — | Substrate endpoint. Env mirror of `metabob.endpoint` in the config file |
| `DISCOVERY_ENDPOINT` | _(derived)_ | Discovery-vessel base URL; set it with a remote endpoint |
| `WORKSPACE_PATH` | `$PWD` | Default workspace root for `init_workspace` |
| `SESSION_ID` | random UUID | Session identifier |
| `HEALTH_PORT` | _(ephemeral)_ | Port of the loopback HTTP resolver |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error` |
| `MAX_REQUESTS_PER_MINUTE` | `60` | MCP rate limit per session |

The key and endpoint are read from the environment, else from a config file resolved directory-aware
like git: `METABOB_CONFIG_PATH` → `./.metabob/config.json` in the launch directory →
`~/.metabob/config.json`. CLI flags override environment variables, which override the config file.
With either input missing the server still starts with its local tools, and logs one message naming
what is missing. Run `metabob-mcp --help` for the full flag reference.

A local substrate endpoint (`http://127.0.0.1:18080`) derives discovery (`:18100`) by port offset; a
remote endpoint derives nothing, so set `DISCOVERY_ENDPOINT` with it. An explicit `DISCOVERY_ENDPOINT`
still wins. No other service URL is configuration.

## Corporate proxies & SSL inspection

Many enterprise networks (Zscaler, Netskope, Cisco Umbrella, Forcepoint, Palo Alto Prisma, Sophos, etc.) intercept TLS and re-sign it with an MDM-installed corporate root CA. Node.js ignores the OS trust store by default, so without mitigation every https call to the substrate would fail with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.

`@metabob/mcp` ships three mitigations out of the box:

1. **OS trust store auto-load** — at startup, the OS root CAs are read (via [`system-ca`](https://www.npmjs.com/package/system-ca)) and merged into `tls.rootCertificates`, `https.globalAgent`, and the global `fetch` dispatcher. No env vars required. Pass `--no-system-ca` (or set `METABOB_NO_SYSTEM_CA=1`) to opt out. Bun's own TLS stack is covered separately by re-execing with `--use-system-ca`, which Bun added in **1.2.23** — on an older Bun the flag is accepted and silently inert, so upgrade Bun if you are behind an intercepting proxy.
2. **Diagnostic TLS errors** — chain-validation failures are translated into a structured `TLS_INTERCEPTED` error that names the intercepting CA (extracted from the served cert) and tells the user to either trust the corporate root or add the substrate host to the proxy's SSL inspection bypass list. The original error code is preserved as `.cause`.
3. **Fingerprint self-probe** — first successful TLS connect to each configured https substrate host records the leaf SPKI SHA-256 in `~/.metabob/known-hosts.json`. If a future connect serves a different fingerprint whose root is in your OS trust but not in the bundled Mozilla bundle, a one-time stderr warning identifies the likely MITM. Never blocks.

If you've installed the corporate root in your OS trust store, metabob-mcp will Just Work. If you haven't, you'll see a diagnostic TLS error telling you exactly what to do.

### Diagnosing corporate-proxy issues

If you're behind a proxy and the mitigations above don't fully restore connectivity, run the bundled doctor to produce evidence you can hand to your IT team or attach to a support ticket:

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

`metabob-mcp` reads the API key and endpoint from that config, derives the discovery-vessel URL, and resolves registered substrate vessels from discovery. The substrate installer writes this config (`~/.substrate/config.json`, linked from `~/.metabob/config.json`).

### Claude Code

```bash
claude mcp add metabob -e METABOB_API_KEY=mb_... -e METABOB_ENDPOINT=http://127.0.0.1:18080 -- npx @metabob/mcp@latest
```

### Claude Code plugin (MCP server + skill)

This repo doubles as a plugin marketplace. The plugin bundles the MCP server
and the `metabob` sequencing skill:

```bash
claude plugin marketplace add MetabobProject/metabob-mcp
claude plugin install metabob@metabob
```

The plugin ships no credentials. The substrate installer writes them; otherwise put your API key
and the substrate endpoint in `~/.metabob/config.json`:

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
bun test                            # run all tests
bash scripts/git-hooks/install.sh   # install pre-commit hook
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

## Copilot instructions

This repository includes repo-local Copilot instruction files under `.github/` that teach agents to use the attached Metabob MCP workflow for initialization, problem triage, co-change prediction, and impact analysis.

See [CLAUDE.md](CLAUDE.md) for development guidance and [docs/](docs/) for detailed references.
