# @metabob/mcp

MCP server exposing Metabob code analysis to AI agents (Claude Code, Cursor, Continue, and other MCP clients).

## Quick Start

```bash
npx @metabob/mcp@latest --api-key=mb_your_api_key_here
```

Get an API key from [app.metabob.com/settings/api-keys](https://app.metabob.com/settings/api-keys).

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
| `ACTIVITY_API_URL` | `https://activity.metabob.com` | Activity API base URL; falls back to `metabob.endpoint` in `~/.metabob/config.json` |
| `WORKSPACE_PATH` | `$PWD` | Default workspace root for `init_workspace` |
| `SESSION_ID` | `default-session` | Session identifier |
| `HEALTH_PORT` | `8080` | Vessel HTTP server port |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error` |
| `MAX_REQUESTS_PER_MINUTE` | `60` | MCP rate limit per session |
| `SUBMIT_TIMEOUT_MS` | `120000` | Timeout for `init_workspace` file submission before treating it as a slow async response |

CLI flags override environment variables, and environment variables override `~/.metabob/config.json`. Run `metabob-mcp --help` for the full flag reference.

## Integrations

### Claude Code

```bash
claude mcp add metabob -e METABOB_API_KEY=mb_... -- npx @metabob/mcp@latest
```

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
