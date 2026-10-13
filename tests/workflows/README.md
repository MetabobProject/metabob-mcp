# Workflow tests

These tests drive the server the way an agent does — over stdio, as a separate process — through the
workflows the docs tell agents to follow, against an in-process fake of the substrate. They check that
the workflows work end to end, not that each function is correct in isolation.

| file | workflow | source |
|---|---|---|
| `w1-operator-loop.test.ts` | dispatch, poll, read `reached` (not `status`), read the reasoning, label — for a reached, a hollow (`completed` + `reached:false`) and a satisfier (`failed` + `reached:true`) goal | `docs/SPEC.md` § Substrate goal tools |
| `w2-ledger.test.ts` | session A records a finding; session B (another process, another home directory) recalls it and closes it by concept id; A then sees it closed and not offered as open work | `skills/metabob/SKILL.md` |
| `w3-attachment.test.ts` | starting and using the server never registers with discovery (under any configuration), offers `human_input` or sends workspace content; the HTTP server answers on loopback only and reports its attachment state | `docs/CONFORMANCE.md` |
| `w4-skill-contract.test.ts` | every tool the skill names exists, and every step it prescribes works under the default configuration | `skills/metabob/SKILL.md` |

A `test.todo` marks a requirement the code does not meet yet; its comment names the requirement or the
pending change. `bun test --todo tests/workflows/` runs them.

## Running

```bash
bun test tests/workflows/                           # the server from source (bun src/cli.ts)
bun run build && MCP_UNDER_TEST=dist bun test tests/workflows/   # the built dist/cli.js, as CI does
```

Each server runs with its own temporary `HOME` (the sidecar store lives in `~/.metabob`), its own
temporary workspace as `WORKSPACE_PATH` and working directory, and an environment pointing the
attachment at the fake (`METABOB_ENDPOINT`, `DISCOVERY_ENDPOINT`). Routing variables from the calling environment are removed, so nothing leaves the
machine. The suite needs no network and no containers.

## The fake substrate

`harness/fake-substrate.ts` serves discovery, goal-host, activity-api and concept-db, each on
`127.0.0.1` at an OS-assigned port. It is split in two:

- **Operations** (`OPERATIONS`) — one handler per substrate operation, keyed by name
  (`vesselCapability`, `register`, `goalDispatchAsync`, `goalWalkState`, `executionTrace`,
  `goalVerificationLabelWrite`, `conceptCreate`, `conceptSearch`, `conceptGet`, `conceptUsage`,
  `conceptLink`, …). Handlers read and write one shared state object, which scenarios script and
  inspect directly.
- **Routes** (`ROUTES`) — how the server under test reaches each operation: a service, a method and a
  path, or for an impulse resolver the envelope's `pointer.type`.

When the server reaches an operation another way — every tool resolving a shape through discovery
`POST /resolve`, for instance — only `ROUTES` changes; the operations and the scenarios stay as they are.
Every request is recorded with the operation it reached (`null` when none matched), so a scenario can
assert on what was called and on what never was.

`harness/mcp-client.ts` spawns the server, sends `initialize` and then `tools/call` requests, times each
request out, and records any non-JSON-RPC line on stdout.
