# @metabob/mcp

MCP server exposing Metabob code analysis to AI agents (Claude Code, Cursor, Continue, and other MCP clients).

## Quick Start

```bash
npx @metabob/mcp@latest --api-key=mb_your_api_key_here
```

Get an API key from [app.metabob.com/settings/api-keys](https://app.metabob.com/settings/api-keys).

**Runtime**: the MCP server runs on [Bun](https://bun.sh) (≥1.1) — the installed
bin shim invokes `bun` automatically, so it just needs to be on PATH. Node.js is
only sufficient for `--help`, `--version`, and the `doctor` subcommand.
Supported platforms: Linux, macOS, and Windows x64. Windows ARM64 is
unsupported (no Bun ARM64 build, no tree-sitter win32-arm64 prebuilds).

Metabob analysis is asynchronous: `init_workspace` uploads a batch and the backend may take a while to finish processing it. Agents should prefer async follow-up with Metabob tools and treat `pending` or `running` analysis states as normal.

## Tools

| Tool | Tier | Description |
|------|------|-------------|
| `init_workspace` | Local + API | Build local CPG index; incrementally sync relevant files to the analysis server |
| `get_problems` | API | Fetch detected code problems, ranked by severity |
| `search_codebase` | Local + API | Search components (CPG) and problems by keyword |
| `predict_cochanges` | **Local** | GCN-based co-change prediction — no API call |
| `analyze_impact` | **Local** | CPG traversal showing what a change affects |
| `annotate_component` | API | Add structured why/how notes for a problem using the current analysis result |
| `mark_complete` | API | Endorse a fix or discard a false positive |
| `get_metrics` | API | Session and project analysis health overview |
| `assign_git_changes` | Local + API | Map changed files to CPG components + co-change predictions |
| `get_analysis_context` | Local + API | Current analysis state snapshot for agent decision-making |

**Local-tier** tools run entirely in-process via `@metabob/cpg-inference` (Tree-sitter parse → GCN embeddings → vector search). They require `init_workspace` to have run first but make no network calls.

**API-tier** tools require `METABOB_API_KEY` and a session against `ide.metabob.com`. If `METABOB_API_KEY` is unset, the CLI also falls back to `~/.metabob/config.json` and reads `metabob.apiKey` (or `instance.apiKey`).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `METABOB_API_KEY` | — | API key — exchanged for a session token on startup |
| `SESSION_TOKEN` | — | Pre-obtained session token (skips key exchange) |
| `ANALYSIS_API_URL` | `https://ide.metabob.com` | Analysis API base URL |
| `ACTIVITY_API_URL` | `https://ide.metabob.com` | Activity API base URL; falls back to `metabob.endpoint` in `~/.metabob/config.json` |
| `DISCOVERY_ENDPOINT` | — | Discovery-vessel base URL for substrate routing; auto-derived from local `metabob.endpoint` when it points at `http://localhost:18080` |
| `WORKSPACE_PATH` | `$PWD` | Default workspace root for `init_workspace` |
| `SESSION_ID` | `default-session` | Session identifier |
| `HEALTH_PORT` | `8080` | Vessel HTTP server port |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error` |
| `MAX_REQUESTS_PER_MINUTE` | `60` | MCP rate limit per session |
| `SUBMIT_TIMEOUT_MS` | `120000` | Timeout for `init_workspace` file submission before treating it as a slow async response |

CLI flags override environment variables, and environment variables override `~/.metabob/config.json`. Run `metabob-mcp --help` for the full flag reference.

When `~/.metabob/config.json` points `metabob.endpoint` at the local substrate (`http://localhost:18080`), metabob-mcp auto-derives `DISCOVERY_ENDPOINT=http://localhost:18100`. Substrate-specific tools such as `concept_*` and `run_goal` then discover their target vessels from discovery instead of assuming fixed sibling ports. Explicit `CONCEPT_DB_URL`, `GOAL_HOST_VESSEL_URL`, or `DISCOVERY_ENDPOINT` values still win.

## Corporate proxies & SSL inspection

Many enterprise networks (Zscaler, Netskope, Cisco Umbrella, Forcepoint, Palo Alto Prisma, Sophos, etc.) intercept TLS and re-sign it with an MDM-installed corporate root CA. Node.js ignores the OS trust store by default, so without mitigation every call to `*.metabob.com` would fail with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.

`@metabob/mcp` ships four mitigations out of the box:

1. **OS trust store auto-load** — at startup, the OS root CAs are read (via [`system-ca`](https://www.npmjs.com/package/system-ca)) and merged into `tls.rootCertificates`, `https.globalAgent`, and the global `fetch` dispatcher. No env vars required. Pass `--no-system-ca` (or set `METABOB_NO_SYSTEM_CA=1`) to opt out.
2. **Diagnostic TLS errors** — chain-validation failures are translated into a structured `TLS_INTERCEPTED` error that names the intercepting CA (extracted from the served cert) and tells the user to either trust the corporate root or add `*.metabob.com` to the proxy's SSL inspection bypass list. The original error code is preserved as `.cause`.
3. **Bearer auth by default** — `Authorization: Bearer <key>` is sent first; on a 401 the client transparently retries once with the legacy `Authorization: ApiKey <key>` and remembers per host so subsequent requests skip the retry.
4. **Fingerprint self-probe** — first successful TLS connect to each Metabob host records the leaf SPKI SHA-256 in `~/.metabob/known-hosts.json`. If a future connect serves a different fingerprint whose root is in your OS trust but not in the bundled Mozilla bundle, a one-time stderr warning identifies the likely MITM. Never blocks.

If you've installed the corporate root in your OS trust store, metabob-mcp will Just Work. If you haven't, you'll see a diagnostic TLS error telling you exactly what to do.

### Diagnosing corporate-proxy issues

If you're behind a proxy and the mitigations above don't fully restore connectivity, run the bundled doctor to produce evidence you can hand to your IT team or attach to a support ticket:

```bash
npx @metabob/mcp doctor
# or, if the main binary can't load (e.g. bun not available):
npx -p @metabob/mcp metabob-mcp-doctor
```

The doctor runs a battery of probes — DNS resolution, OS trust store inspection (with vendor-CA matching for Zscaler / Netskope / Forcepoint / Palo Alto / etc.), TLS handshake capture (full chain, fingerprints, ALPN), HTTPS request comparison (default vs OS-trust), and a WebSocket Upgrade probe — and writes a JSON artifact (`metabob-mcp-doctor-<timestamp>.json` in the current directory) alongside a human-readable report. No API key required.

## Integrations

### Local substrate

After `scripts/substrate/configure-local.sh`, the standard `~/.metabob/config.json` is enough for discovery-backed substrate tools:

```bash
cd repos/metabob-mcp
bun install
bun run build
npm link
claude mcp add metabob -- metabob-mcp
```

`metabob-mcp` reads the local substrate API key and activity endpoint from `~/.metabob/config.json`, derives the discovery-vessel URL, and resolves registered substrate vessels from discovery.

### Claude Code

```bash
claude mcp add metabob -e METABOB_API_KEY=mb_... -- npx @metabob/mcp@latest
```

### Claude Code plugin (MCP server + skill)

This repo doubles as a plugin marketplace. The plugin bundles the MCP server
and the `metabob` sequencing skill:

```bash
claude plugin marketplace add MetabobProject/metabob-mcp
claude plugin install metabob@metabob
```

The plugin ships no credentials. After installing, put your API key in
`~/.metabob/config.json`:

```json
{
  "metabob": {
    "apiKey": "mb_your_api_key_here"
  }
}
```

The endpoint defaults to `https://ide.metabob.com`; set `metabob.endpoint`
only for self-hosted or local substrate deployments.

Alternatively, export `METABOB_API_KEY` in your shell profile — the plugin's
MCP server inherits your environment. Without a key the server still starts,
but API-tier tools fail on first call.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "metabob": {
      "command": "npx",
      "args": ["@metabob/mcp@latest"],
      "env": {
        "METABOB_API_KEY": "mb_your_api_key_here"
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
      "args": ["@metabob/mcp@latest", "--api-key=mb_your_api_key_here"]
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
        "METABOB_API_KEY": "mb_your_api_key_here"
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
claude mcp add metabob -e METABOB_API_KEY=mb_... -- metabob-mcp
```

`npm link` makes the local build available as `metabob-mcp` on your PATH without publishing to npm. Re-run `bun run build` after source changes.

## Copilot instructions

This repository includes repo-local Copilot instruction files under `.github/` that teach agents to use the attached Metabob MCP workflow for initialization, problem triage, co-change prediction, and impact analysis.

See [CLAUDE.md](CLAUDE.md) for development guidance and [docs/](docs/) for detailed references.
