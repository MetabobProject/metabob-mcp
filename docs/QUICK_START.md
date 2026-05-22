# Quick Start

## 1. Get an API key

[app.metabob.com/settings/api-keys](https://app.metabob.com/settings/api-keys)

## 2. Add to your AI tool

### Claude Code

From npm (after package is published):

```bash
claude mcp add metabob -e METABOB_API_KEY=mb_... -- npx @metabob/mcp@latest
```

From a local checkout (development):

```bash
cd repos/metabob-mcp
git submodule update --init --recursive
bun install
bun run build
npm link
claude mcp add metabob -e METABOB_API_KEY=mb_... -- metabob-mcp
```

Restart Claude Code. Tools appear as `mcp__metabob__init_workspace`, etc.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

On Windows, use `%APPDATA%\Claude\claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "metabob": {
      "command": "npx",
      "args": ["@metabob/mcp@latest"],
      "env": { "METABOB_API_KEY": "mb_your_key" }
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
      "args": ["@metabob/mcp@latest", "--api-key=mb_your_key"]
    }
  }
}
```

## 3. Try it

Ask your agent:

> "Initialise metabob for this workspace and show me the highest-severity problems."

The agent will call `init_workspace` (builds the local CPG and submits files to the analysis server), then `get_problems`.

Metabob analysis is asynchronous. After `init_workspace`, the server may report `pending` or `running` before results are ready, so agents should prefer async follow-up instead of assuming analysis will finish immediately.

## Typical flow

```
init_workspace        # index workspace, sync first batch
get_analysis_context  # snapshot: index stats + open problems
get_problems          # full problem list
predict_cochanges     # what else should change? (local, no API)
annotate_component    # add why/how notes for a problem
mark_complete         # record the fix
init_workspace        # sync next batch as files change
```

## Common issues

**"Authentication failed"** — API key is invalid or expired. Generate a new one at [app.metabob.com](https://app.metabob.com/settings/api-keys).

**"Circuit breaker open"** — The analysis API had repeated failures. Resets automatically after 60 seconds.

**"Rate limit exceeded"** — Default is 60 requests/min per session. Set `MAX_REQUESTS_PER_MINUTE=120` to raise it.
