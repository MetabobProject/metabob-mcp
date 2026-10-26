# Quick Start

## 1. Have an API key and a substrate endpoint

The server attaches to a substrate with two inputs: an API key and the substrate's endpoint (for a
local substrate, `http://127.0.0.1:18080`). Neither has a default. The substrate installer writes both into
`~/.substrate/config.json`; on such a machine, drop the `-e` flags below — the installer's config is all
the setup there is. Proxy and trust come from the environment (`HTTPS_PROXY`, `NO_PROXY`) and the OS
trust store, never from a config file.

Check the attachment before adding the server to a client:

```bash
npx @metabob/mcp@latest attach --check
```

`ok result attached (orgId=…)` and exit 0 mean it works. Otherwise the last line names the cause.

## 2. Add to your AI tool

### Claude Code

From npm:

```bash
claude mcp add metabob -e METABOB_API_KEY=mb_... -e METABOB_ENDPOINT=http://127.0.0.1:18080 -- npx @metabob/mcp@latest
```

From a local checkout (development):

```bash
git submodule update --init --recursive
bun install
bun run build
npm link
claude mcp add metabob -e METABOB_API_KEY=mb_... -e METABOB_ENDPOINT=http://127.0.0.1:18080 -- metabob-mcp
```

Restart Claude Code. Tools appear as `mcp__metabob__init_workspace`, etc. The server lists eleven tools by default,
the shared ledger and memory; add `-e METABOB_TOOLS=all` for every tool, which the flow below and the operator's
cockpit use ([SHARED-MEMORY.md](SHARED-MEMORY.md) is the guide to the default set).

For Claude Desktop, Cursor, and VS Code (Continue), see the Integrations section of [../README.md](../README.md).

## 3. Try it

Ask your agent:

> "Initialise metabob for this workspace and show me the highest-severity problems."

The agent will call `init_workspace` (builds the local CPG; no file content leaves the machine), then `get_problems`.

## Typical flow

With `METABOB_TOOLS=all` (`predict_cochanges`, `annotate_component`, the goal and queue tools are outside the default
set):

```
init_workspace        # index workspace locally
get_analysis_context  # snapshot: index stats + open problems + other agents' findings
get_problems          # full problem list
predict_cochanges     # what else should change? (local, no API)
record_finding        # write back an issue you noticed — shared with other agents
annotate_component    # add why/how notes for a problem
mark_complete         # endorse the fix, or discard a false positive
init_workspace        # parse files added since the last call
```

Every read has a write half: `record_finding` + `mark_complete` for findings, `concept_create` / `concept_link` / `concept_record_usage` for design memory and relevance, `provide_feedback` for goal verdicts, and `submit_resolution` for a task queued on this machine (the substrate dispatches nothing to a client-only session). See [SPEC.md](SPEC.md).

## Common issues

**First step for any of these: `npx @metabob/mcp attach --check`.** It runs the attachment once and
names what failed: the proxy (`proxy_auth_required(NTLM)` — use a local px- or cntlm-style relay;
`proxy_port_blocked(8443)`), TLS inspection (`tls_intercepted(<issuer>)` — trust that CA or set
`NODE_EXTRA_CA_CERTS`), the network (`connect_timeout`, `dns_failed`, `connect_refused` — with a PAC
setup, set `HTTPS_PROXY`), a block page (`blocked_by_portal`), or the key (`key_rejected`).

**"Not attached to a substrate: missing …"** — the API key or the endpoint is not configured. The message names which one, and where config files are read from.

**"Circuit breaker open"** — Substrate calls failed repeatedly. Resets automatically after 60 seconds.

**"Rate limit exceeded"** — Default is 60 requests/min per session. Set `MAX_REQUESTS_PER_MINUTE=120` to raise it.

**"no_producer(conceptSearch)"** (or any shape) — discovery is reachable, but no vessel producing that shape is registered with it — or, when the endpoint is a spoke that forwards the shape to a peer, the peer's producer refused the request or has no such item: the forward relays both as the same answer. Check with `registry_query` (`mode: "vessels"`, `shape: "conceptSearch"`; it needs `METABOB_TOOLS=all`), or discovery's `/health` (local substrate: `http://localhost:18100`).

**"producer_timeout(shape, ms)"** — discovery reached the producer but cut the request at the producer's advertised timeout. Reads are retried twice before this is reported; retry later, or narrow the query.
