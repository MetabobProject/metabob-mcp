# Workflow tests

These tests drive the server the way an agent does — over stdio, as a separate process — through the
workflows the docs tell agents to follow, against an in-process fake of the substrate. They check that
the workflows work end to end, not that each function is correct in isolation.

| file | workflow | source |
|---|---|---|
| `w1-operator-loop.test.ts` | dispatch, poll, read `reached` (not `status`), read the reasoning, label — for a reached, a hollow (`completed` + `reached:false`) and a satisfier (`failed` + `reached:true`) goal | `docs/SPEC.md` § Substrate goal tools |
| `w2-ledger.test.ts` | session A records a finding; session B (another process, another home directory) recalls it and closes it by concept id; A then sees it closed and not offered as open work | `skills/metabob/SKILL.md` |
| `w3-attachment.test.ts` | starting and using the server never registers with discovery (under any configuration), offers `human_input` or sends workspace content; the HTTP server answers on loopback only and reports its attachment state; a foreign key is refused at the org check, after which substrate tools answer `key_rejected` in one line and local tools still work; an undialable `/bootstrap` identity is rehosted (H1), warned about, and proven | `docs/CONFORMANCE.md` |
| `w4-skill-contract.test.ts` | every tool the skill names exists, and every step it prescribes works under the default configuration | `skills/metabob/SKILL.md` |
| `networks/matrix.test.ts` | the network matrix: for each corporate-network condition (direct; CONNECT proxy; `NO_PROXY`; loopback bypass; Basic, NTLM and Negotiate auth; CONNECT only to 443; plain-http anchor through a proxy; idle cuts; HTML block page; captive portal; TLS interception with the CA untrusted and trusted; blackholed proxy; refused and silent anchors) the attachment attaches and resolves one read, or fails within a bound with the named cause — under Bun in process and under Node (`attach --check --json`) | `docs/SPEC.md` § Network |

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

`harness/fake-substrate.ts` serves discovery, identity, goal-host, activity-api and concept-db, each on
`127.0.0.1` at an OS-assigned port, or at a pinned one for a scenario whose port arithmetic matters. Its
`/bootstrap` advertises the fake identity (or `bootstrapIdentity`, or an HTML page with `bootstrapHtml`),
and identity accepts only the keys in `validKeys`. It is split in two:

- **Operations** (`OPERATIONS`) — one handler per substrate operation, keyed by name
  (`vesselCapability`, `bootstrap`, `authResolve`, `register`, `goalDispatchAsync`, `goalWalkState`, `executionTrace`,
  `goalVerificationLabelWrite`, `conceptCreate`, `conceptSearch`, `conceptGet`, `conceptUsage`,
  `conceptLink`, …). Handlers read and write one shared state object, which scenarios script and
  inspect directly.
- **Routes** (`ROUTES`) — how the server under test reaches each operation: a service, a method and a
  path, or for an impulse resolver the envelope's `pointer.type`, with the adapter that builds the
  operation's input from the pointer and the producer's envelope from its result.

Discovery `POST /resolve` behaves as discovery-vessel's: it answers its own shapes (`vesselCapability`,
`vesselRegistry`) and forwards any other shape as `{ impulse: { pointer } }`, with the caller's
`Authorization`, to the service `shapeOwners` names, returning that producer's status and body; a shape
nobody owns is `404 { error: "Not found", shape }`. When the server reaches an operation another way,
only `ROUTES` changes; the operations and the scenarios stay as they are. Every request is recorded with
the operation it reached (`null` when none matched; `discoveryResolve` for discovery's forwarding hop),
and a request discovery forwarded is recorded on the producer with `forwarded: true`, so a scenario can
assert on what was called, on what never was, and that nothing reached a producer directly. For a shape
route the recorded `body` is the operation's input; `rawBody` is what was sent.

`networks/corp-proxy.ts` is a configurable corporate proxy on `node:net` (CONNECT and absolute-form;
port allow-list, Basic / NTLM / Negotiate challenges, idle cuts, a block page, TLS interception,
blackhole), with a TLS terminator and silent and closed ports; `networks/test-ca.ts` mints the test CAs
and leaves with `node:crypto`. The proxied host names end in `.invalid`, so only a proxy reaches them.
The proxy holds a client's bytes from the end of the request head until it pipes them upstream, so a
body sent in its own segment (as Node sends it) is never dropped. Every row runs with the client's
default budgets, and its "fails within" bound comes from them; rows run four at a time, about 10 s for
the whole matrix, and the outcome does not depend on order or CPU load.

`harness/mcp-client.ts` spawns the server, sends `initialize` and then `tools/call` requests, times each
request out, and records any non-JSON-RPC line on stdout.
