# Quick Start

## 1. Get an API key

[app.metabob.com/settings/api-keys](https://app.metabob.com/settings/api-keys)

## 2. Add to your AI tool

### Claude Code

From npm:

```bash
claude mcp add metabob -e METABOB_API_KEY=mb_... -- npx @metabob/mcp@latest
```

From a local checkout (development):

```bash
git submodule update --init --recursive
bun install
bun run build
npm link
claude mcp add metabob -e METABOB_API_KEY=mb_... -- metabob-mcp
```

Restart Claude Code. Tools appear as `mcp__metabob__init_workspace`, etc.

For Claude Desktop, Cursor, and VS Code (Continue), see the Integrations section of [../README.md](../README.md).

## 3. Try it

Ask your agent:

> "Initialise metabob for this workspace and show me the highest-severity problems."

The agent will call `init_workspace` (builds the local CPG and submits files to the analysis server), then `get_problems`.

## Typical flow

```
init_workspace        # index workspace, sync first batch
get_analysis_context  # snapshot: index stats + open problems + other agents' findings
get_problems          # full problem list
predict_cochanges     # what else should change? (local, no API)
record_finding        # write back an issue you noticed — shared with other agents
annotate_component    # add why/how notes for a problem
mark_complete         # endorse the fix, or discard a false positive
init_workspace        # sync next batch as files change
```

Every read has a write half: `record_finding` + `mark_complete` for findings, `concept_create` / `concept_link` / `concept_record_usage` for design memory and relevance, `provide_feedback` for goal verdicts, and `pull_assigned_work` / `submit_resolution` for work the substrate dispatched to this agent. See [SPEC.md](SPEC.md).

## Common issues

**"Authentication failed"** — API key is invalid or expired. Generate a new one at [app.metabob.com](https://app.metabob.com/settings/api-keys).

**"Circuit breaker open"** — The analysis API had repeated failures. Resets automatically after 60 seconds.

**"Rate limit exceeded"** — Default is 60 requests/min per session. Set `MAX_REQUESTS_PER_MINUTE=120` to raise it.

**"concept_* could not find concept-db via discovery"** — discovery-vessel is reachable, but concept-db is not registered there yet. Check discovery's `/health` (local substrate: `http://localhost:18100`) and verify concept-db is registered, or set `CONCEPT_DB_URL` explicitly to bypass discovery.
