# @metabob/mcp — Tool Specification

Code cites this document by section — `SPEC §get_problems`, `SPEC §impulse-shapes` — and each
section names the code it describes as `` `file@anchor` ``. Section ids are heading slugs; the rule
and the checks live in [DOCLINKS.md](DOCLINKS.md).

## Architecture

```
Agent (Claude Code / Cursor / custom)
        │  MCP over stdio (JSON-RPC 2.0)
        ▼
┌─────────────────────────────────────────┐
│             @metabob/mcp                │
│                                         │
│  Tool Registry (src/tools/index.ts)     │
│                                         │
│  Local tier           Substrate tier    │
│  ────────────────     ──────────────    │
│  cpg-inference-ts     concept-db,       │
│  LocalStore           goal-host,        │
│  (in-process)         discovery         │
└─────────────────────────────────────────┘
```

stdout carries only JSON-RPC: the server routes `console.log`, `console.info` and `console.debug` to stderr (`src/index.ts@stdout-is-transport`), so library logging cannot corrupt the transport.

The registry is `src/tools/index.ts@TOOL_REGISTRY`: every tool below is one entry, validated by its
module's zod `InputSchema` and served by its module's `handle`.

**Local tier** — runs in-process via the vendored CPG library (`vendor/cpg-inference`, a git submodule re-exported by `src/cpg-inference.ts`; a fork, absent from `package.json` dependencies):
- Tree-sitter parsing → `CodePropertyGraph`
- GCN embeddings (a ~109 KB bundled ONNX model, fed node-name char-codes — a name-similarity ranker, not learned structure) → an in-process brute-force vector index (`src/vector-index.ts@FAISSIndex`)
- BFS graph traversal

**No workspace content leaves the machine.** File content is read only by `init_workspace`, into the
in-process CPG. Nothing submits files, excerpts or file lists for analysis, and nothing watches the
workspace in the background, so there is no server-side analysis and no backend detections: problems
are what agents record (`record_finding`), held in the local store and recalled from concept-db.

**Substrate tier** — requires the attachment: `METABOB_API_KEY` and a discovery endpoint, given or
derived from the endpoint (§ Configuration). The key is proven against the substrate's identity before
any other keyed call (§ Attachment), and every substrate request carries `Authorization: ApiKey <key>`. The process is a client of the
substrate only: it makes no discovery registration, runs no libp2p node, and serves its HTTP resolver
(§ Impulse shapes) on `127.0.0.1` for local callers (`src/vessel-server.ts@loopback-bind`). It sends
no usage telemetry.

The substrate tools (goal dispatch, concept-db, the registry and trace readers) are described in their
own sections below.

---

## Agent instructions

The `initialize` result carries MCP `instructions` (`src/server-instructions.ts@SERVER_INSTRUCTIONS`),
which MCP clients place in the agent's context at connect time. They state what the server is for,
lead with what to do before editing files other agents or the substrate also work on (`get_problems`
for those files, then `path_activity` on them; `record_finding` for a problem noticed and not fixed,
since a bug mentioned only in a reply is lost; `mark_complete` for what was fixed), tell the agent to
load the `metabob` skill before its first call (it holds the sequencing and the
rules), name the first-call set in one sentence (`get_analysis_context`, `get_problems`,
`record_finding`, `mark_complete`) as the fallback when the skill is not available, so a client that
defers tool schemas loads all four with one tool search, name the ledger and goal loops and the
recent-trace listing, separate the
local tools from the substrate tools, and say that a named cause from a substrate tool is the
attachment's state, diagnosed with `metabob-mcp attach --check`. They change only with the tool
set: every tool they name exists in the registry, which the W4 skill-contract workflow test holds.

## Configuration

**The attachment is two values: an API key and an endpoint.** Neither has a default. The substrate
installer writes both into `~/.substrate/config.json` (`~/.metabob/config.json` is a symlink to it),
so a machine it has set up needs no environment and no flags: an MCP client entry of
`{ "command": "metabob-mcp" }` attaches. The installer writes `endpoint`, `apiKey` and
`gapStoreEndpoint` (which this server does not use) and never a proxy or a CA: those come from the
environment and the OS (§ Network).

Two equivalent ways to supply them:

```bash
# Environment (typical .mcp.json / MCP-client setup); SUBSTRATE_API_KEY / SUBSTRATE_ENDPOINT are accepted too
METABOB_API_KEY=mb_live_...
METABOB_ENDPOINT=http://127.0.0.1:18080
```

```jsonc
// ~/.substrate/config.json (what the installer writes), or another file in the lookup order below
{
  "metabob": {
    "apiKey": "mb_live_...",
    "endpoint": "http://127.0.0.1:18080"
  }
}
```

With the key or the endpoint missing, the server still starts — the local tools work — and logs one
message naming the missing input and this lookup order (`src/config.ts@unattachedMessage`); `/health`
and `doctor` report the same.

`metabob.discoveryEndpoint` (or `DISCOVERY_ENDPOINT`) is the preferred, explicit form of the anchor.
`metabob.endpoint` stays: the installer writes it, and a local one derives discovery (below).

When the server does not attach, `metabob-mcp attach --check` is the first step (§ attach --check).

### Configuration lookup

Config resolution is **directory-aware, like git**: a project can pin its own backend with
`.substrate/config.json` or `.metabob/config.json` in the directory the server is launched from (MCP
clients spawn stdio servers with cwd = project root). The first file that exists **and is this
server's config** wins (`src/config.ts@config-lookup`, `src/config.ts@lookupConfig`,
`src/config.ts@resolveConfigPath`):

1. `SUBSTRATE_CONFIG_PATH`, then `METABOB_CONFIG_PATH` — an explicit file;
2. `./.substrate/config.json`, then `./.metabob/config.json`;
3. `~/.substrate/config.json` — what the substrate installer writes;
4. `~/.metabob/config.json`.

A file is this server's config when it is a JSON object with a top-level `metabob` (or legacy
`instance`) section. Other tools keep their own `.metabob/config.json` — metabob-cli's holds `base_url`
and `state_directory` — so a file without that section, or one that is not valid JSON, is skipped with a
one-line warning naming it and the reason, and the lookup continues. A file named explicitly by
`SUBSTRATE_CONFIG_PATH` or `METABOB_CONFIG_PATH` is read as named and never skipped. When no file
qualifies, `~/.substrate/config.json` is the path named as the one to create.

The installer's environment names are accepted alongside this server's: `SUBSTRATE_API_KEY` and
`SUBSTRATE_ENDPOINT` fill `METABOB_API_KEY` and `METABOB_ENDPOINT` when those are unset
(`src/config.ts@substrate-env-aliases`). When both names of a pair are set and differ, the `METABOB_*`
value wins and one warning says so. Every entry point — the server, `doctor` and `attach --check` —
reads the configuration the same way (`src/config.ts@apply-configuration`).

### Endpoint derivation

`endpoint` / `METABOB_ENDPOINT` is the substrate endpoint. The only address
derived from it is discovery, the anchor (`src/config.ts@deriveLocalDiscoveryEndpoint`);
every substrate call then resolves a shape through discovery (§ Attachment), so no
other service has a URL to configure or derive.

- **Local substrate** — an `http:` URL whose explicit port ends in `80` (`8080`,
  `18080`, `28080`, …) derives discovery at the same block's `…100` (so
  `http://127.0.0.1:18080` gives `:18100`). Deriving discovery
  this way is census class H1, which CONFORMANCE §c4-anchoring forbids; it is
  kept as interim debt until the substrate installer writes the discovery
  endpoint, and the server logs one WARN saying so whenever discovery was
  derived rather than given (`src/config.ts@derivedDiscoveryWarning`). The
  identity endpoint is never derived from the endpoint: it comes from
  `/bootstrap` (§ Attachment).
- **Remote gateway** — any other endpoint derives nothing: no path-prefixed
  siblings are assumed, so a remote substrate is anchored by an explicit
  `discoveryEndpoint` / `DISCOVERY_ENDPOINT`.

### Config-file schema

All keys are optional.

| Key | Purpose |
|-----|---------|
| `metabob.apiKey` | API key (also accepted at `instance.apiKey`) |
| `metabob.endpoint` | Substrate endpoint — a local one derives discovery (above) |
| `metabob.vesselId` | Pins `VESSEL_ID` (the agent-task queue key and finding author) |
| `metabob.discoveryEndpoint` | The anchor, explicitly: discovery-vessel's URL. Preferred over deriving it from `endpoint` |
| `metabob.identityEndpoint` | Advanced: pin the identity endpoint, overriding the one `/bootstrap` advertises |

Unknown keys are ignored (passthrough). `metabob.discoveryEndpoint` / `DISCOVERY_ENDPOINT`
wins over the discovery derived from the same source's endpoint, and
`metabob.identityEndpoint` / `IDENTITY_ENDPOINT` over the identity `/bootstrap` advertises.

### Precedence

Each loader fills only variables that are still unset (`src/config.ts@applyConfigDefaults`), applied in this order (`src/cli.ts@main`) — so earlier wins:

1. CLI flags — `--api-key` and `--endpoint` are written into the environment before the loaders run
2. Environment — explicit variables (`METABOB_*`, then the `SUBSTRATE_*` names for whichever is unset), then the discovery derived from `METABOB_ENDPOINT`
3. The config file (lookup order above) — its explicit keys, then the discovery derived from its `endpoint`. When `METABOB_ENDPOINT` is set, only the file's credentials (`apiKey`, `vesselId`) apply, never its endpoints (`src/config.ts@withoutEndpoints`)

There is no built-in default after these. Consequences worth knowing:

- An MCP client that injects only `METABOB_API_KEY` keeps the config file's endpoint.
- An explicit `METABOB_ENDPOINT` chooses the substrate: the config file's
  endpoints never fill a discovery it left underived, so the attachment cannot
  split across two substrates.

### Attachment

`src/attachment.ts@attach` runs at startup, in the background (and again after a transient failure, below): startup and the local tools never
wait on it. It takes the anchor `{discovery, key}` and, in one pass that contacts each address at most
once:

1. `GET {discovery}/bootstrap` — public and keyless — reads `identity_endpoint` (an empty string means
   absent).
2. Chooses the identity endpoint, in this order:
   1. an explicit `IDENTITY_ENDPOINT` / `metabob.identityEndpoint`, used as given;
   2. the `/bootstrap` `identity_endpoint`, when a quick `GET /health` (2 s) answers;
   3. when that address is loopback or a single-label container name on an 8xxx port and does not
      answer, the same port on the discovery URL's host at discovery's published-port offset:
      `port + (discoveryPort − 8100)` (node1 `http://127.0.0.1:8101` → `:18101`; a compose fleet's
      `http://substrate-live:8101` with discovery on `:26100` → `:26101`). This rehost is census class
      H1 interim debt (`src/attachment.ts@rehost-h1`): it logs a WARN naming the advertised value and
      records `identity.source: "rehosted-h1"`;
   4. otherwise none: `identity_unreachable(advertised=…, tried=[…])`.
3. Proves the key: `POST {identity}/v1/auth/resolve` carrying the key in both of identity's forms,
   the nested body `{ impulse: { type: "authentication", pointer: { type: "apiKey", apiKey } } }` and
   the flat `Authorization: ApiKey <key>` header (`src/auth-service.ts@org-check`). An identity that
   serves the nested form answers the tenant with the key's validated scopes (`orgId`, `userId`,
   `keyId`, `accountId` when the user has a membership, `scopes`); one that serves only the flat form
   reads the header and answers `org_id`, `key_id` without scopes, which are then "not reported". The
   nested body goes only on a direct hop: an inspecting proxy's data-loss scanning logs request bodies
   where it masks the `Authorization` header, so through a proxy the check sends the header alone and
   scopes are not reported. Each check writes a key-session row on identity, so it runs once per attach
   and on the heartbeat, never per tool call. The scopes are what identity reports for the key;
   producers enforce only named scopes (`verdict:human`, `operator:direct`, `admin`, …), not `read` or
   `write`, so nothing in the cockpit relies on them as a permission. Whichever
   address step 2 chose, this check against it is what makes it trusted; for a rehosted address it is
   also the dial. A 401/403 is `key_rejected` — the key belongs to another namespace.

Once authenticated, the same identity is re-resolved every 5 minutes (the key-issuance heartbeat,
`src/auth-service.ts@AuthService`); a key revoked meanwhile turns the attachment to `key_rejected`.

**A failure that can pass by itself is retried** (`src/attachment.ts@reattach`). A server started before its
substrate answers (alongside the fleet, after a reboot or a power loss) would otherwise stay unattached until it
restarts. After `anchor_unreachable`, `identity_unreachable` or `blocked_by_portal` (a captive portal clears once
the user signs in):
- the attachment attempts again in the background, after 5 s, 15 s, 30 s, 1 min, 2 min, then every 5 min, until it
  attaches;
- a substrate tool called after the failure attempts again at once, at most every 10 s, so the first call after
  the substrate comes up succeeds;
- each attempt starts from a fresh state, and the recovery is logged once ("Attached on attempt N, after: <cause>");
- while an attempt runs, readers (`/health`, the refusal line, the gate) see the last settled attempt, and calls
  that arrive meanwhile wait for it, so none reports a half-reset state as its cause.

A rejected key, missing configuration, a proxy's refusal and a non-substrate answer are final. Only the long-running server retries, since it is the one with
the heartbeat; `attach --check`, `doctor`, `task pull` and `finding close` report what they found once.

**State** — one typed object (`src/attachment.ts@AttachmentState`), reported by `doctor` and in the
loopback `GET /health` as its `attachment` field (`src/vessel-server.ts@health-attachment`), together
with `attached` (true only once the key is proven) and, when not attached, `reason` (the cause line,
the missing input, or `attaching` while pending). Neither carries the key. Before an attachment exists,
`/health` still reports `network.proxy` (credentials redacted).

| field | values |
|---|---|
| `anchor` | `{ discovery, source }` — `explicit`, `derived-h1`, or `none` |
| `bootstrap` | `{ status, identityEndpoint?, detail? }` — `ok`, `unreachable`, `not_substrate` (non-JSON or HTML; when the request went through a proxy and was refused, the detail names the proxy as what may have refused it), or `skipped` (no anchor) |
| `identity` | `{ endpoint, source, advertised, tried }` — source `explicit`, `bootstrap`, `rehosted-h1`, or `none`; `tried` lists every address contacted, in order |
| `auth` | `{ status, orgId?, keyId?, accountId?, scopes?, detail? }` (never the identity's jwt) — `pending`, `authenticated`, `key_rejected`, `identity_unreachable`, or `not_configured` |
| `cause` | the named cause keyed calls are refused with, or `null` |
| `message` | that cause as the one line a substrate tool returns |
| `advertised` | `none (client-only)` |
| `network` | the network diagnosis (`src/attachment.ts@network-diagnosis`): `proxy` (`HTTPS_PROXY` / `HTTP_PROXY` with credentials redacted, `NO_PROXY` and the entries in force), `anchorRoute` (`{ via, bypass }`: the proxy a request to the anchor takes, or why it goes direct), `cause` and `causeLine` (the network cause of a failed attachment, § Network), `tls` (`{ host, authorized, issuer }` for an https anchor), `osProxy` (OS proxy settings the process does not see, named after a direct connection failed), and `lastByFamily` (the last outcome of the attachment and of each producer family — `discovery`, `trace`, `concept`, `goal`, `other` — with its cause) |
| `startedAt`, `settledAt`, `lastCheckedAt` | timestamps; `lastCheckedAt` moves with each org check, the heartbeat's included |

**Named causes** — `not_configured` (no key, or neither a discovery endpoint nor an explicit identity),
`anchor_unreachable` (discovery does not answer `/bootstrap`), `blocked_by_portal` (`/bootstrap` or
the org check answers non-JSON or HTML, or a proxy answers with its own page — a captive portal or
block page), `identity_unreachable`, and `key_rejected`. When the network produced no answer, the line
carries the network cause (§ Network) — `anchor_unreachable: discovery https://hub.example did not
answer GET /bootstrap — proxy_auth_required(NTLM): …` — and `network.cause` names it. A refusal is
logged once at WARN when the attachment settles, naming the requirement it serves
(CONFORMANCE §c9-fail-visibly, or CONFORMANCE §c3-identity for `key_rejected`); each refused call after
it is logged at debug.

**The gate.** Every substrate tool passes one check before it runs, on both dispatch planes — MCP
stdio (`src/index.ts`) and the loopback resolver (`src/vessel-server.ts@resolveImpulseContent`):
`src/tools/index.ts@substrateToolRefusal`. It waits for a pending attachment to settle, then lets the
tool run when authenticated and otherwise returns the cause as one line (`isError: true`), for example
`key_rejected: the substrate's identity (http://127.0.0.1:18101) rejected the API key (HTTP 401);
substrate tools are unavailable; local tools still work.` The substrate half of the mixed tools
(`get_problems`, `get_analysis_context`, `record_finding`, `mark_complete`) and answer delivery
(`submit_resolution`) check the same attachment and report the cause in place of their concept-db or
goal-host output; their local half runs regardless.

**The one ingress.** `resolve(pointer)` on the attachment (`src/attachment.ts@attachment-resolve`) is
the path substrate tools take to the substrate: it posts `{ pointer }` to discovery `POST /resolve` with
`Authorization: ApiKey <key>`, and discovery answers its own shapes (`vesselCapability`,
`vesselRegistry`, …) or forwards the pointer to the shape's producer and returns the producer's status
and body (CONFORMANCE §c11-attachment-model). Tools reach it through `src/attachment.ts@resolveShape`.
It refuses with the named cause (`AttachmentRefusedError`) when the attachment is not authenticated, and
names discovery's own failures in one line (`src/attachment.ts@classifyDiscoveryAnswer`):

| failure | when |
|---|---|
| `no_producer(shape)` | discovery answers `404 { error: "Not found", shape }`. Discovery sends it when nothing produces the shape, and its peer forward sends the same answer for every non-2xx from a peer's producer — a refusal (a 400 naming missing fields), a missing item (an unknown trace or dispatch) — so through a spoke the answer does not say which. The line keeps the `no_producer(shape)` token and says that (`src/attachment.ts@no-producer-line`); a tool that knows what a missing item means for its request names it instead (§ execution_trace, § goal_status, § provide_feedback). A producer's own 404 that reaches this hop with its own body passes through to the tool |
| `producer_timeout(shape, ms)` | discovery answers `502 forward_failed` because it cut the forward at the producer's `resolve_timeout_ms`, or the request outlives its client cap |
| `producer_unreachable(shape)` | any other `502 forward_failed` |
| `anchor_unreachable` | discovery itself does not answer; the line carries the network cause (§ Network) |

Each request carries a client cap just above discovery's cut for the producer family
(`src/attachment.ts@resolve-timeouts`: discovery's own shapes 10 s, traces 15 s, concept-db 35 s,
goal-host 60 s), so no request is held open past 60 s. A read cut at its producer's timeout is retried
twice, after 0.5 s and 1.5 s; a write is never retried.

---

## Network

Every request this process makes to a substrate takes one path, `src/net.ts@net-request`: the
attachment's `/bootstrap`, identity dial and org check, discovery `POST /resolve`, the key-issuance
heartbeat, `concept_usage_stats`'s history read, doctor's HTTPS and TLS probes, and the
certificate-fingerprint self-probe (`src/net.ts@open-tls-socket`). It is a small HTTP/1.1 client on
`node:net` and `node:tls`, not `fetch`: it behaves the same under Bun and Node, it sees a proxy's own
answer to `CONNECT` (which `fetch` hides), and it never follows a redirect, so a captive portal's 302
is seen rather than followed. Proxy selection, trust, the connect budget, retries and error
classification live there and nowhere else (CONFORMANCE §c8-proxy-and-tls-in-the-vessel-role).

### Runtime

The npm bin (`dist/cli.js`) starts under Node (`#!/usr/bin/env node`). Which runtime makes the network
calls depends on the command:

| launch | the MCP server's calls | `doctor`, `attach --check`, `task pull` |
|---|---|---|
| `bun src/cli.ts` (development) | Bun | Bun |
| `node dist/cli.js` / `npx @metabob/mcp`, Bun on PATH | Bun: the server re-execs into Bun (`src/cli.ts`) | Node: they are Node-safe and stay in-process |
| `node dist/cli.js`, no Bun on PATH | none: the server exits 1 with the "requires the Bun runtime" message | Node |

So both runtimes make real calls, and the network matrix runs under both
(`tests/workflows/networks/matrix.test.ts`: Bun in process, Node by spawning `attach --check --json`
from `dist/cli.js`, or from a Node bundle of the source). Because `src/net.ts` uses only `node:net` and `node:tls`, a row behaves the same in
either; neither runtime's own `HTTP(S)_PROXY` handling is involved. `attach --check` prints the runtime
it ran under.

Under Node, a system resolver that drops queries delays the process's exit: `attach --check` prints its
report within the connect budget, but Node's exit waits for the pending `getaddrinfo` to give up. The
server, under Bun and long-lived, is unaffected.

### Proxy selection

Chosen per request from the environment (`src/net.ts@select-proxy`); never from a config file:

- an `https:` URL uses `HTTPS_PROXY`, falling back to `HTTP_PROXY`; an `http:` URL uses `HTTP_PROXY`
  only (so a plain-http anchor with only `HTTPS_PROXY` set goes direct, and `attach --check` says why).
  Lowercase names win over uppercase. A proxy URL without a scheme is `http://`.
- `NO_PROXY` entries: `*`; a host, which matches its subdomains too (`hub.corp`, `.hub.corp`); a
  `host:port`; an IPv4 CIDR (`10.0.0.0/8`).
- Whenever a proxy is set, `localhost`, `127.0.0.1` and `::1` are added to `NO_PROXY`, and every
  loopback host (`127.0.0.0/8`, `::1`, `*.localhost`) goes direct: local substrate traffic never goes
  through a corporate proxy.
- An `https:` target is reached with `CONNECT host:port` **by hostname**, so the proxy resolves it and
  the client needs no DNS for it; an `http:` target is sent to the proxy in absolute form
  (`GET http://host:port/path`), so a proxy that tunnels only to 443 still carries a plain-http anchor.
- Basic credentials go in the proxy URL (`http://user:password@proxy:3128`) and are sent as
  `Proxy-Authorization: Basic`. They are never logged: every proxy URL in a log line, `/health`,
  `doctor`'s report and artifact, and `attach --check` is redacted to `http://***@proxy:3128`
  (`src/net.ts@redact-credentials`).
- Only `http://` and `https://` proxies are supported; another scheme (`socks5://`) is
  `proxy_unsupported(socks5)`.

### Trust

A certificate is checked against the bundled roots, the OS trust store (read once by
`src/tls-trust.ts@systemCaAdditions`; `METABOB_NO_SYSTEM_CA=1` skips it) and `NODE_EXTRA_CA_CERTS`,
which `src/net.ts@trusted-cas` reads itself because Bun does not. The chain and the host name are both
verified before any byte of the request is sent; an untrusted chain is `tls_intercepted(<issuer>)`,
naming the issuer at the top of the chain served. The process-wide undici dispatcher
(`src/tls-trust.ts@installSystemTrustStoreSync`) covers third-party `fetch` only: with an undici that
has no `EnvHttpProxyAgent` it installs a plain Agent and warns, since it cannot choose a proxy per
request.

### Budgets and retries

- **Connect budget** (`src/net.ts@connect-budget`): 5 s (`METABOB_CONNECT_TIMEOUT_MS` overrides) for
  the TCP connect to the first hop, the proxy's `CONNECT` answer and the TLS handshake. A blackholed
  anchor or proxy fails as `connect_timeout` within it, apart from the response budget.
- **Response budget**: the caller's, covering the whole request — `/bootstrap` and the org check 5 s,
  the identity dial 2 s, `resolve()` its family's cap (§ Attachment, never above 60 s), the history
  read 3 s. A connected target that does not answer in time is `response_timeout` — slow, not blocked.
- **Retries**: on idempotent requests only (reads, and the org check), within the response budget, at
  most twice (after 0.25 s and 0.75 s), for transient failures: a reset connection, a proxy's 5xx to
  `CONNECT`, and — for `/bootstrap` — a 502/503/504. Never on a write, a 4xx, an auth failure or a
  classification (`blocked_by_portal`, `tls_intercepted`, …).

### Named network causes

`src/net.ts@net-causes`. Each failure is one line that starts with its cause; the attachment's refusal
(§ Attachment), every substrate tool's error text, `/health`, `doctor` and `attach --check` all carry
it.

| cause | what the network did |
|---|---|
| `proxy_auth_required(<schemes>)` | the proxy answered 407. For `Basic` without credentials, the line says to put them in the proxy URL; with credentials, that it rejected them. For `NTLM` / `Negotiate`, which this process does not speak, the line names the workaround: a local authenticating relay (a px- or cntlm-style proxy) with `HTTPS_PROXY` pointing at it |
| `proxy_port_blocked(<port>)` | the proxy refused `CONNECT` to a port other than 443 (403 / 405) — Squid's `SSL_ports` default |
| `proxy_refused` | discovery's `/bootstrap`, reached through a proxy, answered a non-JSON 4xx: the proxy itself may have refused the request (one that allows only HTTPS, say), so the line names the proxy rather than a portal |
| `proxy_unsupported(<scheme>)` | the proxy URL is not `http://` / `https://`, or does not parse |
| `tls_intercepted(<issuer>)` | the chain is signed by an issuer this process does not trust — TLS inspection (`TLS_INTERCEPTED`), or an untrusted substrate CA |
| `tls_name_mismatch(<host>)` | a trusted chain for another name |
| `tls_failed(<host:port>)` | the TLS handshake failed for another reason |
| `dns_failed(<host>)` | the first hop's name does not resolve — with no proxy, the anchor's |
| `connect_timeout(<host:port>)` | no connection (or no tunnel) within the connect budget: packets dropped |
| `connect_refused(<host:port>)` | nothing accepts connections there |
| `connection_reset(<host>)` | the connection closed before a complete answer — a proxy cutting idle or long requests |
| `response_timeout(<host>, <ms>)` | connected, but no complete answer within the response budget |
| `blocked_by_portal` | a proxy or portal answered with its own page: HTML or a body instead of a tunnel, or a non-HTTP answer. `/bootstrap` and the org check also name a non-JSON or HTML answer this way, and only the org check — which needs the key — makes the anchor trusted |
| `anchor_unreachable(<host:port>)` | the proxy could not reach the target (a 5xx to `CONNECT`), or any other failure |

`src/net.ts@classify-error` names an error from any other source (a scripted fetch in tests, a runtime
error) by its code or message.

### attach --check

`metabob-mcp attach --check [--json]` (also `metabob-mcp doctor --attach`) runs the attachment once,
as the server runs it — the same configuration lookup, request path and sequence — then one read,
`vesselRegistry`, through discovery `POST /resolve`, and prints each hop (`src/attach-check.ts@attachCheck`):

- `config` — the file read, the key (last four characters), the anchor and its source;
- `proxy` — direct (and why: loopback, `NO_PROXY`, none configured, `HTTP_PROXY` unset) or through
  which proxy, redacted, with the `NO_PROXY` entries in force;
- `tls` — verified (and the issuer), intercepted (and by whom), or plain http;
- `bootstrap`, `identity` (endpoint, source, advertised, tried), `org check` (`orgId`, the account, and the key's scopes or "not reported by identity"), `resolve`;
- `result` — `attached`, or the one line with the named cause.

Exit 0 when attached and the read resolved, 1 otherwise; with nothing configured it prints the one
instruction naming the missing input. It writes nothing: no file, and the read is one discovery answers
itself. It is Node-safe and runs in the runtime that launched it (§ Runtime).

### PAC and OS proxy settings

PAC and WPAD scripts are not evaluated. When a direct connection fails as `connect_timeout`,
`dns_failed` or `connect_refused` and no `HTTP(S)_PROXY` is set, the OS proxy settings are read
(`src/os-proxy.ts@detect-os-proxy`: macOS `scutil --proxy`, the Windows Internet Settings registry key,
GNOME `gsettings`; best-effort, 1.5 s) and named in the failure — "the OS proxy settings use a PAC
script (…), which this process does not see; set HTTPS_PROXY". With none found, a `connect_timeout`
still says that a network reachable only through a proxy needs `HTTPS_PROXY`. `doctor` reports the same
settings. Nothing here runs at startup or blocks it.

## Read-only key

A write is never sent with a key whose validated scopes lack `write` (or `admin`)
(`src/attachment.ts@read-only-key`): every non-read resolve answers `key_read_only: this key has scopes
[read]; the <shape> write was not sent`, and reads are untouched. Producers do not all enforce scopes
yet, and a refusal that came back through a peer forward would read as `no_producer`, so the cockpit
does not rely on them. `record_finding` and `mark_complete` keep their local half and say the shared half
was not sent and other agents will not see it. With no scopes reported (the flat org check, used
through a proxy) nothing is known about the key, and nothing is gated.

### task pull

`metabob-mcp task pull --origin <git url> [--task-dir /task] [--work-dir /work] [--minutes 60] [--trust <vesselId,…>] [--json]` (`src/task-pull.ts@runTaskPull`) is a cell's entrypoint step, run before any harness starts. It takes a task from the ledger, claims it, writes the task and its context into the task directory, and clones the work directory, so every harness gets its work the same way: already mounted and fresh. Both directories must be empty or missing; a task never reuses them.

It is Node-safe and runs in the runtime that launched it (§ Runtime), so a cell that runs `npx @metabob/mcp` needs no Bun for it; W7 runs the built CLI under Node.

**Getting attached.** It loads the configuration and attaches as the server does (§ Attachment). Its vessel identity is `VESSEL_ID`, else derived from the key and the work directory, and its session is `SESSION_ID`, else a new one. The repository is the origin URL's identity (§ Repository identity), so every clone of one origin shares one ledger.

**Choosing a task.** Tasks are open findings in category `task` (§ get_problems) on that repository (`src/task-pull.ts@candidateTasks`). It tries them in this order:
- a task this cell already holds, so a restarted cell resumes it;
- then unclaimed tasks, most severe first.

A task someone else holds, a closed one and one with a fix pending are skipped. Each candidate is claimed with `claim_finding`'s rule (§ claim_finding). A held, lost, unsettled or refused claim moves on to the next candidate.

**What it writes.** On a claim it writes `task.json` into the task directory:
- the task id, its concept id and finding ids, summary, severity, files and details;
- the origin, repository and ref;
- the integration policy with each value's source;
- the claim (holder, end), the recorder, the time and the session;
- the trust list for conventions and whether it was defaulted;
- `base`, the commit the clone checked out, which the entrypoint passes to `finding close` as `<base>..HEAD`.

It also writes `context.md`: the details, the policy, the open non-task findings on the task's files, and the task as recorded. Then it clones the origin into the work directory, at the task's `ref:` when it declares one.

A `ref:` must be a branch name `git check-ref-format --branch` accepts, must not start with `-`, and is at most 100 characters (`src/task-pull.ts@validRef`): task details are written by agents. **Anything that fails after the claim withdraws it**: a refused ref, writing the task directory, or the clone. Left to lapse, one bad ref or origin would block the task for every cell for the claim's length.

**The integration policy** (`src/task-pull.ts@integration-policy`) says where the fix goes. Each value comes from the task's `details` (`push_to:`, `integrate:`, `conflicts:` lines), else from a `project_convention` concept for the repository by a trusted author, newest first, else the default:
- `push_to`: `main`, or `task` (meaning `task/<task id>`); default `main`;
- `integrate`: `push` or `review`; default `push`;
- `conflicts`: `rebase`.

A convention steers pushes, so it is untrusted input. It counts only from an author named by `--trust` or `METABOB_TASK_TRUST`, and by default only from the task's own recorder, in which case `task.json` records `trust.defaulted: true`. A value outside the allowed set is refused whatever its source. Every refusal is logged as a warning and never applied. Authors are declared, not verified (§ Client claim), so the trust list is a convention among cells, not a security boundary.

**Exit codes:**
- 0: a task was pulled.
- 3: no open task, so the cell is done.
- 4: open tasks exist, but others hold them, or a claim was not settled yet. `--json` gives `retry_after`, the earliest claim end, for the entrypoint loop to wait until.
- 2: not attached.
- 1: any other failure.

The reply lists what each candidate's claim did.

### finding close

`metabob-mcp finding close (--commits-from <file> | --commits <range>) [--target <branch>] [--work-dir <dir>] [--task <task.json>] [--json]` (`src/finding-close.ts@runFindingClose`) is close by commit. It is Node-safe, like `task pull`.

**Which commits.** A cell closes only its own commits. After it fetches and rebases (the `rebase` conflict rule), and before it pushes, the entrypoint lists them with `git rev-list origin/<target>..HEAD` into a file, pushes and verifies, then runs `finding close --commits-from <file>`. A `<base>..HEAD` range would be wrong after a rebase: it also holds the commits other cells merged since `base`, and their trailers would be closed under this cell's name. `task.json`'s `base` records where the clone started, not the range. A person can pass `--commits <range>` after their own push.

**The claim.** A commit in the range claims a fix with a `Fixes-Finding: agf_…` trailer, one per finding (`src/finding-close.ts@trailerIds`, git's own trailer parse). Only the finding id and the commit sha are sent, never commit text.

**The target.** The branch the fix must be merged into is `--target`, else the task's policy (`main` under `review`, otherwise its `push_to`), else `main`. It is fetched first (`git fetch origin <target>`). If the fetch fails nothing is written, since a stale view of the origin could misjudge what is merged.

**Each finding the range names:**
- **Must be an open finding of this repository.** An unknown id, another repository's, or a closed finding is reported and never written, so a typo can't close someone else's finding.
- **Merged** means the commit is in `origin/<target>`'s history, or a commit there carries the same `Fixes-Finding: <id>` line anywhere in its message. Merged is judged on the target, so leftover edits in the work tree don't hold the close back: the uncommitted-changes rule of § mark_complete applies to a claim checked against the checkout's own `HEAD`, not one checked against a target ref. A squash merge concatenates the source messages into its body, where git's trailer parse doesn't look. The finding is then endorsed through `mark_complete`'s checks (§ mark_complete), with that commit as `fix_commit` checked against `origin/<target>`, plus `fix_via: trailer`, so the verdict reads `fix_claimed: yes`.
- **Reverted:** a merged fix that a later commit on the target reverts (git revert's "This reverts commit <sha>") is reported as reverted and not written.
- **Pushed but not merged** (on some remote branch, as under `review`): the verdict is `fix pending (awaiting merge)` with `fix_target:`. Recall tags it `[fix pending: pushed by <vesselId>, awaiting merge into <target>]`. A later `finding close` after the merge closes it.
- **On no remote branch:** nothing is written; it is reported as unpushed.

**Plain endorse vs close by commit.** `mark_complete endorse` closes a finding once its fix commit is on a remote branch (§ mark_complete). `finding close` closes it only once the fix is merged into the target. Under the `review` policy the cell uses `finding close`, so a fix pushed for review stays pending until merged.

**Exit codes:** 0 done, with each finding's outcome reported; 2 not attached; 1 any other failure, including a failed fetch.

**Known limits:**
- A fix that reaches the target without its `Fixes-Finding:` line (a cherry-pick that drops it) is not recognised; patch-id matching is not done.
- A fix that was reverted and then re-applied still reports as reverted.

## Client claim

Every write the server makes declares who sends it (`src/operator-id.ts@clientClaim`): the attachment adds
`client_claim: { operator, session, client }` to the pointer of every resolve that is not a read
(`src/attachment.ts@attachment-resolve`), unless `METABOB_CLIENT_CLAIM=off`. Some substrate tables are
schemafull, so a live write smoke checked that every implemented write shape accepts the field. A goal
dispatch also carries `operator` and a
`session:<session>` tag, which goal-host stamps into the trace's tags; `provide_feedback` folds
`[operator: …] [session: …]` into its label notes, and findings and verdicts already carry
`recorded_by` / `reviewed_by` and `session` in their content.

| Field | Value |
|---|---|
| `operator` | `MB_OPERATOR_ID` when set; otherwise this workspace's stable vesselId (`metabob-mcp-<hash(apiKey + workspace)>`), so distinct workspaces and keys are told apart; `metabob-mcp-unidentified` with no key |
| `session` | `SESSION_ID` when set; otherwise one UUID per launch |
| `client` | `metabob-mcp/<version>` |

These are **claims**, not attribution: the client asserts them, and only a producer that stamps a write
from the credential attributes it; the claim is there so such a stamp can be joined to a session and an
operator. Reads carry no claim. A pointer that already has a `client_claim` is sent as it is.

## Outgoing text guard

Every string a substrate tool sends passes one guard before the tool runs, on stdio and on the
loopback resolver alike (`src/outgoing-guard.ts@guard-tool-input`). The tools that send nothing
(`init_workspace`, `analyze_impact`, `predict_cochanges`, `search_codebase`, `annotate_component`,
`get_metrics`, `assign_git_changes`, `get_problems`, `get_analysis_context`, `pull_assigned_work`, and
`path_activity`, whose paths are matched locally) are exempt; every other tool's string fields are guarded, nested strings included. A field's kind and size
cap come from `src/outgoing-guard.ts@guarded-fields` (for example a finding's summary is prose with a
2 KB cap, a goal is acted on with 4 KB); a field the table does not list is treated as acted on with a
4 KB cap, so a new field is guarded by default.

- **A secret refuses the call**, and nothing is sent. Known secrets are the attachment's key
  (`METABOB_API_KEY`, `SUBSTRATE_API_KEY`, at least 12 characters) and the values of secret-named
  variables (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`) in this process's environment, in the
  workspace's `.env`, `.env.local`, `.env.development`, `.env.production`, `.env.test`, `.npmrc` and
  `.pypirc`, and in the user's `~/.netrc`, `~/.aws/credentials`, `~/.npmrc` and `~/.pypirc`. These
  files are read locally, cached by modification time, and never sent. A value counts only when it is at
  least 16 characters, not a path or a credential-free URL, not a placeholder, and random enough
  (≥ 3 bits per character), and a variable named for a location or an identifier (`…_PATH`, `_FILE`,
  `_DIR`, `_ID`, `_URL`, `_HOST`, `_PORT`, `_NAME`, `_USER`, `_REGION`) never does. Patterns catch
  private-key blocks, cloud and service API keys, GitHub, GitLab, npm and Slack tokens, and JWTs; AWS's
  documented example keys are exempt. Authorization headers, cookies, URLs with credentials and
  pasted config assignments (`DB_PASSWORD=…`) count unless the value is a placeholder (`YOUR_…`,
  `EXAMPLE`, `<…>`, `***`, a repeated character, an ALL_CAPS name, `${VAR}`, a literal such as `true`
  or `password`, a number or a duration) or the name uses the word as a qualifier (`MAX_TOKENS`, `TOKEN_TTL`,
  `KEY_ROTATION_DAYS`); a header or cookie token must also be random enough, while a password counts however
  weak it is, since weak passwords are the commonest real leak. The
  refusal is `<tool>: refused: outgoing_secret(<kind>, <field>)`, naming the field and the kind, never
  the value, and suggests describing it masked (`postgres://admin:***@host`).
- **A home path** (this user's home directory, or `/home/<user>`, `/Users/<user>`,
  `C:\Users\<user>`) is replaced with `~` in prose fields, and the reply ends with a line saying so.
  In fields the substrate acts on it refuses the call with `outgoing_local_path(<field>)`: rewriting a
  path there would change what the request asks.
- **Each field has a size cap**; a larger field refuses the call with `outgoing_too_large(<field>, <bytes>)`.

The tool-call log line names each argument and its size, never its value
(`src/outgoing-guard.ts@describeArgsForLog`). The guard catches accidents, not adversaries: paraphrase,
summaries, re-typed code, an encoded or split key and personal data in prose pass it.

---

## Call log

With `METABOB_CALL_LOG=<path>`, the server appends one JSON line per MCP tool call to that file on this machine (`src/call-log.ts@logCall`). It is opt-in and off by default. It lets the order of an agent's metabob calls be scored for any harness, with or without hooks or a transcript; the cell lab's scorer reads it.

It covers both entry points: MCP stdio, and the loopback resolver's `POST /v2/impulses/resolve` (a local caller is a harness the lab may score).

Each line holds:
- `ts`, `session` and `tool`;
- `via`: `stdio` or `loopback`;
- `args`: each argument's name and size, never its value, the same description as the tool-call log line (`src/outgoing-guard.ts@describeArgsForLog`): `string(<length>)`, `array(<length>)`, or the type;
- `outcome`: `ok`, `refused` (the outgoing guard), `not_attached` (the attachment gate) or `error`;
- `result`, when the tool reports one (`src/call-log.ts@reportResult`): what its answer did, beyond the call running. `claim_finding` reports its claim outcome (`claimed`, `renewed`, `released`, `held`, `lost`, `unsettled`, `closed`, `refused`, `error`); `mark_complete` reports `ok`, `pending`, `not_applied` or `not_shared` (`src/tools/mark-complete.ts@markCompleteResult`).
- `ms`.

Nothing in it is sent anywhere. The file is created mode 0600, and a write that fails never fails the call. It records only what the server sees, so it can't show whether a call came before an edit; the cell lab gets that from the first-modify times in `/work`.

## Tools

The analysis tools. Every handler returns a single text block.

### init_workspace

Handler: `src/tools/init-workspace.ts@handle`

Index the workspace into the local CPG. Indexing is local: no file content leaves the machine, and there is no server-side analysis to wait for.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `workspace_path` | string | `$WORKSPACE_PATH` or cwd | Absolute path to workspace root |
| `recently_changed_files` | string[] | `[]` | Changed files — the output reports how many co-change neighbours they have |
| `batch_size` | number | `20` | Accepted (1–20) and ignored |
| `include` | string[] | `[ts,tsx,js,jsx,mjs,cjs,py]` | Extensions to index (with or without the leading dot) |
| `exclude` | string[] | `[node_modules,.git,dist,build,.next,.nuxt,coverage,.turbo,.cache,__pycache__,.venv,venv,vendor]` | Directory names to skip; dot-directories are always skipped |
| `sync_api` | boolean | `true` | Accepted and ignored |

**Behaviour**
1. Scans the workspace (at most 2000 files, each at most 200 KB) and parses it into the local CPG within a 20 s budget; a parse that runs out of budget resumes on the next call and says so.
2. Binds the local store to the indexed root, so findings recorded afterwards land in this workspace.
3. For `recently_changed_files`, counts their GCN name-similarity neighbours.
4. Makes no request: `batch_size` and `sync_api` stay in the schema so existing callers validate, and change nothing. The output states that no file content was sent off the machine.

---

### get_problems

Handler: `src/tools/get-problems.ts@handle`

Problems for this codebase, ranked by severity: the findings in the local store (agent-recorded `agf_*` seeds from `record_finding`, and any other seeds already on disk), plus findings other agents recorded on this codebase. There is no server-side detection.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | `10` | Max results (max 100) |
| `severity` | `CRITICAL\|HIGH\|MEDIUM\|LOW\|INFO`[] | all | Filter by severity |
| `category` | string[] | all | Filter by category slug |
| `file_path` | string | — | Substring match on the seed file path |
| `include_discarded` | boolean | `false` | Accepted; a discarded finding is deleted from the local store, so it changes nothing |

**Behaviour**
- Leads with one count of open findings across both sources (`src/tools/_findings.ts@openFindingsHeadline`), e.g. `Open findings: 2 (0 in the local store, 2 recorded by agents on this codebase)`. A finding in both — this session's seed of a finding it shared — counts once and is reported as `; N in both`: local seeds group by their linked concept id, so a multi-file finding is one finding, and a recalled finding overlaps a group when it is that concept or carries one of its `agf_*` ids. Only recalled findings with no verdict count. A recall that did not run (no attachment, or concept-db refused or unreachable) is named rather than counted as zero, and so is an unavailable local store. The local count is after the `severity`/`category`/`file_path` filters; the recall count is the open list the section below shows before its cap of 10.
- Lists the open seeds in the local store for this workspace (or, with `file_path`, for the matching files), filtered and capped, each with the id `annotate_component` and `mark_complete` take, and an age tag dated from the seeds. If the local store failed to open, the output says so.
- States plainly that there is no server-side analysis (`src/tools/_findings.ts@NO_SERVER_ANALYSIS`): this server sends no workspace content off the machine, so no backend detections exist. It makes no analysis request.
- It then appends a **"Findings recorded by agents on this codebase"** section recalled from concept-db (`src/tools/_findings.ts@fetchAgentFindings`): one `conceptSearch { shape: "code_finding", limit: 300 }` read in list mode (no `query`; the shape takes no offset), kept when the concept belongs to the current repository (its `repo:` header equals the repository identity or the workspace basename, § repository-identity; else its `workspace:` basename) and, when `file_path` is given, names that file. Returning the full 300 rows is reported as truncated; at most 10 open findings are shown. `finding_verdict` concepts, read the same way, close findings, which move to a separate "Closed findings" list; a retraction outranks a fix, a fix with a commit one without, and any fix a pending one. A fixed finding with a fix commit shows `[FIXED in <sha>]`, and when the commit is not in this checkout's HEAD (`src/repo-identity.ts@commitInHead`) it adds `— the fix is not in this checkout's HEAD (fixed on <branch>, not pushed when endorsed)`. A live claim (§ claim_finding) tags an open finding `[claimed by <vesselId> until <time>: someone is working on it]`. A pending fix keeps the finding in the open list, tagged `[fix pending: uncommitted in another checkout (<reviewed_by>) on <branch>; not in this one]`, or `in this checkout …; commit it, then mark_complete endorse again` when this vessel wrote it. No resolvable repo name skips the recall; concept-db unreachable is non-fatal.
- The recall runs before the local cache is read, and retires this session's seeds of every finding it shows closed (`src/tools/_findings.ts@retireClosedSeeds`), matched by the seed's linked concept id or by the `agf_*` ids the concept carries: a fixed finding's seeds go stale, a retracted finding's are deleted — the same retirement `mark_complete` applies. A verdict another session recorded therefore removes the finding from this session's open list too.

---

**Tasks, listed apart.** A finding in category `task` (its `category:` line, else the summary's `[SEV][task]`) is work assigned on the ledger, for example a coordinator's task board, not a problem in the code (`src/tools/_findings.ts@task-findings`). So an agent checking a file before an edit doesn't take another agent's task for a problem to fix:
- the headline counts findings without tasks, then adds `; N open tasks, listed apart`;
- the findings sections leave tasks out;
- closed tasks are listed after the open ones as `Closed tasks (N):` with `[FIXED in <sha>]` or `[RETRACTED]`, at most 5, and the header counts them (`; N closed`), so a coordinator sees completion without filtering for it;
- a final **Tasks** section lists the open tasks from both sources, once each, with any live claim (§ claim_finding) or pending fix, and says to claim one before starting. Claimed tasks are never hidden, since who is on what is the coordination signal. They are ordered so the next move comes first: claimed by this checkout ("yours"), unclaimed, claimed by others, then those with a fix pending. The header counts each group, e.g. `(3 open: 1 yours, 1 unclaimed, 1 claimed by others)`.

With `category` including `task`, tasks are the list itself and there is no separate section. A `category` filter applies to the recalled findings as it does to the local ones. `get_analysis_context` counts and lists problems only, and its headline names the open tasks the same way.

### record_finding

Handler: `src/tools/record-finding.ts@handle`

The write half of agent-side analysis: LLM processing lives on the agent; the server attributes agent-noticed details to code and surfaces them to other agents on the same codebase.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `files` | string[] | **required** | Files the finding is attributed to (workspace-relative or absolute) |
| `summary` | string | **required** | One-line description |
| `details` | string | — | Longer explanation / suggested fix |
| `severity` | `CRITICAL\|HIGH\|MEDIUM\|LOW\|INFO` | **required** | Severity |
| `category` | string | **required** | Free-form slug (security, correctness, design-constraint, …) |
| `line_start` | number | — | Start line, in the first of `files`; the other files of a multi-file finding get no line range, and the concept's `lines:` header names the file it belongs to |
| `line_end` | number | — | End line |
| `status` | string | `open` | Finding status; anything but `open` stores the seed already stale |
| `force` | boolean | `false` | Record even when the same finding is already open (below) |

**Already recorded.** Before writing an `open` finding without `force`, it looks for an open finding on one of the same files with the same summary (`src/tools/_findings.ts@findOpenDuplicate`): a non-stale seed in the local store, then a recalled finding with no verdict (the `get_problems` recall, repo-scoped; its `files:` header and the summary after `[severity][category] <repo>: `). Summaries match when their normalized text is equal — lowercased, every run of characters other than letters and numbers one space — or when their word sets have a Jaccard index |A ∩ B| / |A ∪ B| of at least 0.8 (`src/tools/_findings.ts@duplicate-finding`). On a match it writes nothing and answers `Already recorded (open): <id> — use mark_complete or add details there.`, with the existing summary, its files, and where it was found; the id is the local `agf_*` id when this machine holds a seed, else the concept id. An unreachable recall does not block the write.

**Behaviour** — (1) upserts one LocalStore seed per file (id `agf_<random>`, confidence 1) so `get_problems` surfaces it immediately in-session — repo/workspace attribution resolves via `activeWorkspacePath()` (index → `WORKSPACE_PATH` → cwd), so it does not require `init_workspace` in the same process; (2) a best-effort concept mint — the `concept_create_write` shape (`src/tools/_findings.ts@postConcept`), written once — with shape `code_finding`, source_type `metabob_annotation`, summary `[severity][category] <basename>: <summary>`, and content carrying `repo` (the repository identity, § repository-identity), `repo_name` (the workspace basename), `workspace`, workspace-relative `files`, `lines`, `severity`, `category`, `status`, `finding_ids` and the details — so other agents' sessions recall it org-wide. The minted concept id is stored back on the seeds (`refs_json`), which is what lets `mark_complete` fold a verdict into that concept's relevance. The concept content also carries the author: `recorded_by: <vesselId>` (the stable `metabob-mcp-<12 hex>` identity, `src/vessel-identity.ts@resolveVesselId`) and `session: <sessionId>`. When no vessel identity resolves — no `VESSEL_ID`, no `METABOB_API_KEY` — the `recorded_by` line is **omitted entirely** rather than filled with a placeholder, so an unattributed finding reads as unattributed instead of as someone's (`src/tools/_findings.ts@attributionLines`). concept-db unreachable is non-fatal and reported in the output. Close the loop with `mark_complete` on the returned `agf_*` id.

#### Repository identity

The ledger is keyed by repository (`src/repo-identity.ts@repoIdentity`), read once per workspace path:

- **With an `origin` remote**, the identity is its URL from `git remote get-url origin`, normalized (`src/repo-identity.ts@normalizeRemoteUrl`): scheme, credentials, port, query, a trailing `.git` and trailing slashes are dropped, the scp form `git@host:org/repo` reads as `host/org/repo`, and the result is lowercased — so `git@github.com:Org/Repo.git` and `https://github.com/org/repo` are both `github.com/org/repo`. Every clone of one repository shares the identity wherever it sits on disk. A workspace below the repository root appends its lowercased subpath (`github.com/org/mono/packages/api`), so two packages of one monorepo, whose workspace-relative file paths can coincide, keep separate ledgers.
- **With no `origin`** (git absent, not a repository, no such remote) the identity is the workspace basename.

A finding carries `repo: <identity>` and `repo_name: <basename>`; a verdict carries the same two lines. Recall matches the `repo:` header against the identity or the basename, case-insensitively, and never against `repo_name:`. A finding whose `repo:` header is a basename is therefore recalled by every repository of that basename; one whose header is an origin identity, only by clones of that repository (and the subdirectory workspace it names).

---

**The system's own gaps.** `get_problems` shows findings, not the gap store's gaps, so a finding can describe what an open gap already does. When `path_activity`'s cache is warm (it never reads the store itself), the reply lists, per file, up to three open gaps whose edit site is that file, and says to `mark_complete` discard the finding if one is the same issue (`src/tools/_gap-activity.ts@openGapsOnFilesLines`). It does not refuse: a busy file has hundreds of gaps, and one on the same file need not be the same issue.

### search_codebase

Handler: `src/tools/search-codebase.ts@handle`

Search components (local CPG) and problems by keyword.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | **required** | Tokenised (camelCase, snake_case and kebab-case split) and matched by partial token containment |
| `limit` | number | `10` | Max results (max 50) |
| `target` | `components\|problems\|both` | `both` | What to search |
| `file_filter` | string[] | — | Narrow to these file paths (substring) |

Components match on name, file path and node type; problems match on the local store's seeds — brief, category and file path. Both are local, and no request is made; when problems are searched, the output says there is no server-side analysis. Requires `init_workspace` for component results.

---

### predict_cochanges

Handler: `src/tools/predict-cochanges.ts@handle`

Predict which files and components change together with the given files. Runs locally — no API call. **Git-history co-change mining carries all of the signal.** The bundled GCN contributes a second list that should be treated as noise: its only input feature is the node name's char-codes (`src/cochange-predictor.ts@generateSimpleFeatures`), and the model is called one node at a time (`src/cochange-predictor.ts@addFile`, `src/cochange-predictor.ts@predictCochanges`), so the vendored model's edge index for a single node is empty and no graph structure reaches it. Rank on the git-history section; do not act on a GCN-only suggestion.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `changed_files` | string[] | **required** | Files being changed |
| `limit` | number | `10` | Max suggestions (max 50) |
| `confidence_threshold` | number | `0.3` | Min score (0.0–1.0), applied to both the git-history confidence and the GCN similarity |

Findings in the local store for the changed files are appended. Requires `init_workspace`.

---

### analyze_impact

Handler: `src/tools/analyze-impact.ts@handle`

Components affected by changing the given files, by traversing the local Code Property Graph and the file import graph.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `changed_files` | string[] | **required** | Files being changed |
| `diff` | string | — | Accepted for compatibility; the handler does not read it |
| `direction` | `forward\|backward\|both` | `backward` | forward=dependencies, backward=dependents |
| `max_depth` | number | `5` | Max traversal depth (max 10) |
| `include_tests` | boolean | `true` | Include test files |

Appends up to 20 findings from the local store for the changed files. When attached, and the workspace maps to the gap store, appends one line per changed file with its open gaps, how many the system is landing now and how many are held (`src/tools/_gap-activity.ts@gapSummaryLines`) from `path_activity`'s cached read only: it never starts the store read, and without a cached read it adds one line saying the open gaps are not loaded and `path_activity` shows them; detached, it makes no request. Requires `init_workspace`.

---

### annotate_component

Handler: `src/tools/annotate-component.ts@handle`

Structured notes for a problem in the local store.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `problem_id` | string | **required** | Problem ID from `get_problems` |
| `mode` | `explain\|recommend` | `explain` | `explain` adds why-focused notes, `recommend` adds how-to-fix notes |
| `context` | string | — | Additional context to include in the notes |

The id is looked up in the local store, and the notes are built locally from templates — no request is made. The output renders severity/category/file/refs/status plus the why/how notes, so record → annotate → mark_complete works on agent findings. An id the local store does not hold is reported as not found, with the reason: there is no server-side analysis, so only local findings can be annotated.

---

### mark_complete

Handler: `src/tools/mark-complete.ts@handle`

Mark a detected problem as resolved or dismiss it as a false positive.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `problem_id` | string | **required** | Problem ID from `get_problems` — a backend id, an `agf_*` finding id, or a `concept_*` id |
| `action` | `endorse\|discard` | `endorse` | endorse=fixed, discard=false positive |
| `fix_commit` | string | — | Endorse only: the commit (7–40 hex digits) that fixes the finding, for a fix that touches none of its files |

Ids are `agf_*` findings or `concept_*` ids; any other id is refused with a message saying nothing was recorded, since there are no backend detections for it to name. A `concept_*` id — the form cross-agent recall hands an agent — is resolved to its local `agf_*` seed via `LocalStore.getSeedByConceptRef`. When no local seed exists, the verdict is written from the recalled concept itself (the fleet case: one agent records, another fixes) — keyed on the `agf_*` id the finding carries, never the concept id — and the output states that nothing local was retired. For agent-recorded findings, endorse marks the LocalStore seed stale (resolved, stops surfacing), discard deletes the local seed only — the org-wide `code_finding` concept is never retracted — and every seed sharing the finding's concept is retired with it, since a multi-file finding is one finding. A `finding_verdict` concept referencing the finding id is best-effort recorded to concept-db (non-fatal). Every verdict carries its reviewer and its provenance as two separate content lines: `reviewed_by: <vesselId>` + `session: <sessionId>` (the author — omitted when no identity resolves), and `origin: local` (written against a local seed) or `origin: remote` (written from a recalled concept). `recorded_by` never appears on a verdict; it means author-of-finding and nothing else. When the finding carries a linked `code_finding` concept, the verdict is also folded into that concept's **relevance** through the same channel as `concept_record_usage` — endorse → `success`, discard → `failure` (`conceptUsage_write`, `src/tools/_findings.ts@recordConceptUsage`). A recalled concept is read as the `conceptGraph` root (`src/tools/_findings.ts@fetchConceptById`).

**Where the fix is.** An endorse records where the fix lives, from the checkout's git state (`src/repo-identity.ts@fix-location`), as verdict lines (`src/tools/_findings.ts@fixLines`). A fix commit postdates the finding — its earliest seed's time, or the recalled concept's `created_at`, less two minutes for clocks — since a commit older than the finding cannot be its fix:
- uncommitted changes (modified, staged, untracked or deleted) in the finding's files come first, even with `fix_commit` — `fix: uncommitted`, with the branch and `fix_base:` HEAD: a claim does not close a finding whose fix is not committed yet (the reply says the claim was not applied);
- with `fix_commit`: that commit, when it resolves in this checkout, is in HEAD's history and postdates the finding — `fix: commit <sha>` with `fix_claimed: yes`, and `fix_touches_finding_files: no` when it touches none of them (the symptom in one file, the fix in another); a commit failing any check writes no verdict and the output names the check;
- else the newest commit since the finding touching its files: `fix: commit <sha>`, with `fix_branch:` and, when no remote branch holds it, `fix_pushed: no`;
- else, when other tracked files have uncommitted changes: `fix: uncommitted` with `fix_files: outside the finding's files` (the fix may be among them);
- else no commit since the finding touches its files, and the newest commit since it, if any, is not taken as the fix — a pull of unrelated work would close every finding — but named with the files it touches, with `fix_commit: "<sha>"` offered for when it is the fix; no verdict is written;
- else nothing in the checkout postdates the finding — or the finding has no recorded time, so no commit can be shown to postdate it — and no verdict is written: nothing is retired, and the output says nothing here can be its fix (endorse where the fix is, or discard it);
- a git checkout where none of the finding's files is known (neither tracked nor on disk) is not where the fix is: no verdict is written, the same way;
- outside git: `fix: unknown (not a git checkout)`, and the finding closes without a commit.
- "Outside git" means git answered that this is not a repository, or git is not installed. A git call that times out (20 s) or fails otherwise is never read as "not a git checkout": no verdict is written, and the reply says git did not answer and to try again.

**An unpushed fix doesn't close the finding.** In a checkout that has a remote, a fix commit no remote branch holds (`fix_pushed: no`) leaves the finding open: other checkouts can't get the commit, and in a cell it is gone with the work directory. The verdict is `verdict: fix pending (unpushed)`; nothing is retired, no relevance is recorded, and the reply says to push and endorse again. Recall tags the finding `[fix pending: committed in another checkout (<reviewed_by>) on <branch> but not pushed; not available here]`. A checkout with no remote at all still closes, since no other checkout could have its commits.

No path is written: the checkout is named by `reviewed_by`.

**Claims.** An endorse of a finding that another vessel holds a live claim on (§ claim_finding) goes ahead, since the claimer may be gone and the fix is what counts. The reply adds `claim: claimed by <vesselId> until <time>; this endorse closes it anyway, which ends their claim` (`src/tools/claim-finding.ts@claimWarning`). Closing the finding ends every claim on it, since recall shows no holder on a closed finding. An uncommitted fix does **not** close the finding, since every other checkout still has the bug: the verdict is `verdict: fix pending (uncommitted)` with summary `[verdict:pending]`, which a reader knowing only endorsed and discarded parses as no verdict; no local seed is retired, no relevance is recorded, and the output says to commit the fix and endorse again. The endorse that names a commit closes it. Discard records no fix location.

---

### claim_finding

Handler: `src/tools/claim-finding.ts@handle`

Say an agent is starting work on a finding, so another agent does not start the same work.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `problem_id` | string | **required** | An `agf_*` finding id, or the `concept_*` id recall shows |
| `action` | `claim\|renew\|release` | `claim` | Claim before starting, renew while working, release on stopping without closing |
| `minutes` | integer | `60` | How long the claim lasts from now, at most 240 |

**What a claim is.** A claim is a `finding_verdict`, keyed on the finding's `agf_*` id like every verdict (`src/tools/_claims.ts@claimLines`):
- `verdict: claimed`, with `claim_minutes:`, `claim_until:` and the claimer as `reviewed_by:`, plus `session:`;
- `verdict: claim withdrawn` for a release;
- the summary is `[verdict:claimed]` or `[verdict:withdrawn]`.

A reader that knows only endorsed and discarded parses neither as a verdict, so to it the finding reads open, which it is.

**One clock.** A claim ends at concept-db's `created_at` plus `claim_minutes`. `claim_until`, from the claimer's clock, is only for people reading the row, and is used only for a row with no `claim_minutes`. Only "now" comes from the reader's clock: a claim counts as live until two minutes past its end (`src/tools/_claims.ts@CLAIM_SKEW_MS`), so a reader whose clock runs fast never frees a claim early.

**Who holds it.** concept-db has no compare-and-set, so two agents can both write a claim. Every reader applies one rule to the same rows (`src/tools/_claims.ts@claim-holder`):
- A claimer's current claim begins with the first claim it wrote while none of its earlier claims was live. A later claim while one is live renews it, and a withdrawal ends it.
- Of the claimers whose claim is live now, the one whose claim began earliest holds it; on a tie, the lower concept id.

**What the tool does:**
1. It resolves the finding (its local seed and siblings, or the recalled concept and every `agf_*` id it carries) and reads the verdicts.
2. A closed finding is refused. A finding held by someone else is reported with its holder and is not claimed.
3. Otherwise it writes the claim, reads the verdicts back and applies the rule. A claim write concept-db gives up on (`no_producer` or `producer_timeout`, seen under concurrent writes) is retried once after a short random pause; repeating it is safe, since a second claim of one's own renews it. When another claimer holds it, it writes a withdrawal and says who won.
   A read can miss a concept written moments before, so the read-back counts only once it shows this claim. It is retried after 150 ms, 500 ms and 1.5 s (`src/tools/claim-finding.ts@READ_BACK_PAUSES_MS`). If it never shows the claim, the reply says the claim is written but not settled and to run the tool again before starting; nothing is reported as held.
4. Renewing a claim it does not hold, and releasing one it does not hold, are refused.

**The read window.** Claims are found in the same `finding_verdict` list read the recall uses: up to 300 rows, ordered by relevance and then newest first. A verdict whose relevance falls below its peers can drop out of the window while it is still live. A read of one finding's verdicts would close that gap, and concept-db's search offers no such filter yet.

**Refusals.** A claim must name its holder, so with no vessel identity nothing is written. A read-only key writes nothing and says `key_read_only`. When the verdict scan reached its limit, the reply says an older claim may have been missed.

**Recall.** Recall shows a live claim on an open finding as `[claimed by <vesselId> until <time>: someone is working on it]`, or `[claimed by this checkout until <time>]` (§ get_problems). A closed finding shows no claim: `mark_complete` ends it.

---

### get_metrics

Handler: `src/tools/get-metrics.ts@handle`

This workspace's local analysis state.

**Input** — none

Computed locally; makes no request. **Output** — open findings in the local store for this workspace by severity, agent-recorded (`agf_*`) versus other, the top five categories, the local CPG size, and the statement that there is no server-side analysis.

---

### assign_git_changes

Handler: `src/tools/assign-git-changes.ts@handle`

Assign changed files to the CPG components they affect, with co-change predictions.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `changed_files` | string[] | **required** | Changed file paths |
| `diff` | string | — | Accepted for compatibility; the handler does not read it |
| `include_cochange_predictions` | boolean | `true` | Include co-change predictions |
| `prediction_limit` | number | `5` | Prediction budget per changed file (max 20) |

Returns a file → component map. Predictions are pooled across the changed files: a GCN list (`prediction_limit` × files requested, up to `prediction_limit` × 3 shown) and a git-history list (`prediction_limit` × 2). Files with findings in the local store show them, and, when attached and the workspace maps to the gap store, each changed file's open gaps and landing leases (as in `analyze_impact`). Requires `init_workspace`.

---

### get_analysis_context

Handler: `src/tools/get-analysis-context.ts@handle`

It opens with **where this session writes and as whom** (`src/tools/get-analysis-context.ts@attachment-line`): `Attachment: attached to org <orgId> via discovery <url>` (credentials redacted, never the key), or `not attached: <named cause>`, then `as: <vesselId> (session <id>)`. Agents writing to the shared ledger have no other read that shows it.

The current analysis state in one snapshot, designed to feed an LLM deciding what to do next: CPG index stats, open problems from the local store (with the statement that there is no server-side analysis), GCN co-change predictions for recently changed files (threshold 0.3, top 8), and a compact top-5 recall of findings recorded by agents on this repo (concept-db `code_finding` concepts, non-fatal when unreachable). The recall runs first and retires the local seeds of findings it shows closed, as `get_problems` does. The problems block leads with the same combined count as `get_problems` (`Open findings: …`), then the local store's line (`local store: N open (c critical, h high)`); the suggested next actions name open shared findings alongside local critical and high ones.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `recently_changed_files` | string[] | `[]` | Used to generate co-change predictions |
| `problem_limit` | number | `10` | Max open problems to include (max 50) |
| `scope` | `session\|project\|org` | `session` | Accepted for compatibility; the handler does not read it |

---

## Substrate goal tools

The MCP surface drives the running substrate end-to-end — **dispatch work, understand it, verify it, inspect it** — through tools rather than host access (`docker exec`, `journalctl`, raw `curl`). Targets resolve as follows:

- **goal-host-vessel** — its shapes `goalDispatchAsync` (dispatch), `goalWalkState` (the dispatch record) and `solicitationResponse_write` (an answer), resolved through the attachment (§ Attachment; `src/tools/_goal-host.ts@readWalkState`, `src/tools/_goal-host.ts@dispatchGoal`). goal-host keeps dispatch records in memory, about the last 100, and `goalWalkState` carries the last 60 `walkLog` lines. A `goalWalkState` read is capped at 15 s, since the record is in memory; a dispatch at goal-host's 60 s.
- **activity-api** — traces are read through the attachment as `activityExecutionTrace` (§ execution_trace), and oracle labels written as `goal_verification_label_write` (§ provide_feedback).
- **discovery** — `registry_query` resolves discovery's own shapes through the attachment (§ Attachment).

Every request goes to discovery `POST /resolve` with `Authorization: ApiKey <METABOB_API_KEY>`, which discovery forwards to the producer; none is held open past 60 s. Planes:

| Tool | Plane |
|------|-------|
| `run_goal`, `run_goal_async` | ACT |
| `goal_status` | TRACK |
| `goal_reasoning` | REASON |
| `provide_feedback` | FEEDBACK |
| `registry_query`, `execution_trace`, `resolve_impulse` | INSPECT |

**`reached`, not `status`.** `status` (`running|completed|failed`) is only the template *exit status*. **`reached`** (`yes|no`) is the goal-reach verdict and the load-bearing signal — printed first by `goal_status` and `goal_reasoning`. `completed`+`reached:false` (hollow) and `failed`+`reached:true` (e.g. a satisfier reach) are both normal; trusting `status` mis-judges the outcome. For high-stakes work also read the actual diff/output: a change can typecheck and pass the reach-gate yet not do what was asked.

**Canonical loop:** `run_goal_async` → `goal_status` → `goal_reasoning` → `provide_feedback`.

### run_goal

Handler: `src/tools/run-goal.ts@handle`

Goal dispatch that waits for the outcome, for short, one-shot goals.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `goal` | string | — | Natural-language goal. `goal` or `target_template_id` is required |
| `target_template_id` | string | — | Activity template to execute, bypassing Thompson selection |
| `variables` | object | — | Seed variables for the execution pool (`{{var}}` placeholders) |
| `parent_execution_id` | string | — | Parent execution id for cross-vessel provenance |
| `composition_chain` | string[] | — | Ancestor execution ids, root-first |
| `learning_mode` | `observe` \| `learn` | goal-host's (learn) | `observe` runs the walk traced for audit, changing no posterior, goal path or credit |
| `tags` | string[] | — | Tags carried onto the dispatch and its trace |

Dispatches as `run_goal_async` does (`goalDispatchAsync`), then polls `goalWalkState` (`src/tools/run-goal.ts@runGoalPollDelayMs`) — three polls `RUN_GOAL_POLL_MS` apart (default 2 s), then pauses doubling to `RUN_GOAL_POLL_MAX_MS` (default 15 s), because every read makes goal-host re-read the execution's oracle labels from the trace store; each poll is a short request — until the dispatch leaves `running` or the polling deadline `RUN_GOAL_TIMEOUT_MS` (default 290 s) passes (`src/tools/run-goal.ts@run-goal-poll`). No request is held open for the goal. `operator` is the declared operator (§ Client claim): `MB_OPERATOR_ID`, else this workspace's stable vesselId; goal-host turns it into the trace's `operator:` tag, and the dispatch's tags also carry `session:<SESSION_ID>`. Returns `dispatchId`, `executionId`, `reached`, `status`, `selectedTemplateId`, any `error` and the duration. Past the deadline the goal keeps running on goal-host, and the reply carries its `dispatchId` and a `goal_status` hint. A refused dispatch (a 429 from goal-host's spend-rate breaker, a 503 while it drains) returns its status and error.

### run_goal_async

Handler: `src/tools/run-goal-async.ts@handle`

Asynchronous goal dispatch — the default for non-trivial goals. Same parameters as `run_goal`.

Resolves `goalDispatchAsync { operator, goal?, targetTemplateId?, variables?, parent_execution_id?, composition_chain?, learning_mode?, tags? }` — goal-host enqueues it as `POST /run-goal` does and answers `202 { dispatchId, status }` at once — and returns the `dispatchId` with a `goal_status` hint. A dispatch is a write and is never retried; a 429 or 503 from goal-host returns its status and error. `learning_mode: "observe"` asks goal-host to run the walk without teaching the substrate, for probes and checks: the walk is still traced, for audit — activity-api stores a trace tagged `learning_mode:observe` / `reach_observe:true` and its learning writers skip it — but it changes no posterior, goal path or credit, so a trace's existence is not contamination; goal-host's default is a learning run. The effective mode is in `goal_reasoning`'s walk log (`recordGoalPath PRECONDITIONS … learningMode=`); goal-host reads a top-level `learning_mode` on `/run-goal`, and its `goalDispatchAsync` path forwards it (goal-host `e07f883` and later); an older goal-host drops it on that path and runs the walk as a learning run. The reply states a passed `learning_mode` as requested, never as applied. What a walk actually taught is reported, not inferred: `run_goal`, and `goal_status` / `goal_reasoning` for a finished dispatch, print a `learning:` line from the dispatch record's `learning` consequences (`src/tools/_goal-host.ts@learningLines`) — goal path recorded, posterior (α/β) changes (a template goal-host lists with Δ0 is not a change), gaps filed, oracle label written — or `none recorded`, or `not reported by goal-host` when the record carries none. When `observe` was requested and the walk recorded a posterior change, a gap or a label anyway, `run_goal` adds a warning line. A reported goal path alone does not trigger it: goal-host sets `goalPathRecorded` on its trace branch whether or not it wrote the path, so under observe the flag is not evidence of a write, and `run_goal` says so. The goal text is forwarded unchanged; goal-host decides the route — a goal naming a real `repos/<vessel>/src/…` file routes to `feature_compose`, which drafts, typecheck-verifies and lands a traced commit.

### goal_status

Handler: `src/tools/goal-status.ts@handle`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dispatch_id` | string | **required** | The `dispatchId` from `run_goal_async` |

Resolves `goalWalkState { dispatchId }` and reads the dispatch record goal-host wraps in it. Prints `reached` (`yes`/`no`/`(running)`/`unknown`) first, then `status`, `executionId`, `operator`, `selectedTemplateId` and `error`. While the dispatch runs it shows the last 6 entries of the live goal-host `walkLog`. Once it has finished with an `executionId`, it hydrates the durable trace through `activityExecutionTrace` (as `execution_trace` reads it), except for a satisfier reach, which persists none: then it says so and points at `goal_reasoning` without a trace read. The trace gives: state-space signature, produced shapes, `completion_shapes:`/`reached:` tags, failure mode, Thompson α/β. goal-host keeps dispatch records in memory (about the last 100), so goal-host's 404 means the record was pruned or never existed; through a spoke that 404 arrives as `no_producer(goalWalkState)`, whose line says that either no producer answered or goal-host has no such dispatch. Any other failure is one named line (§ Attachment).


**Who dispatched** (`src/tools/_goal-host.ts@principalLines`, shared by `goal_status`, `goal_reasoning` and `run_goal`). goal-host validates the caller and reports it as `principal: { kind, operator, tag }`: `kind` is `key` or `node_self`, `operator` is true only for a credential carrying `operator:direct` or `admin`, and `tag` is a non-reversible tag (a key id's hash prefix, or a literal for node-self). The tools print `principal: <kind> (<tag>)`, `operator authority: yes (validated)` when it holds, the request's claimed `operator_label` as `(claimed, unverified)`, and, when `principal.operator` is false, one line: *ran without operator authority: an ordinary keyed caller; directed edits and operator priority do not apply* for a key, or *ran without operator authority (node self-call)* for `node_self`, whose own key never carries operator authority. A record without a principal (an older goal-host, or a record from before goal-host validated callers) prints `principal: not reported` and is never read as non-operator; its `operator` is the old claimed value and is marked so. A raw key id is never displayed: a pre-amendment `principal.label` of the form `key:<id>` prints as `key id withheld`.
### goal_reasoning

Handler: `src/tools/goal-reasoning.ts@handle`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dispatch_id` | string | **required** | The `dispatchId` from `run_goal_async` |

The walk's decision-log for a finished dispatch: the same header as `goal_status`, then the dispatch record's `walkLog` whenever it has one (numbered, verbatim; `goalWalkState` carries its last 60 lines), then — when an `executionId` exists — the per-task trace sequence (`#N ✓/✗ resolver/tier inShapes → outShapes`, failure mode) and a reach-verdict block (state-space, produced shapes, reach tags, α/β). With neither a `walkLog` nor trace tasks it says the decision-log is unavailable (typically a direct vessel resolve). While the dispatch runs it returns "still running" and nothing else.

### provide_feedback

Handler: `src/tools/provide-feedback.ts@handle`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dispatch_id` | string | **required** | The `dispatchId` from `run_goal_async` |
| `verdict` | `reached\|not_reached\|partial` | **required** | Operator verdict on whether the goal was achieved |
| `rationale` | string | **required** | The evidence behind the verdict; stored as the label notes |
| `confidence` | number | `0.9` | Operator confidence, 0..1 |
| `goal` | string | — | Goal text, when the dispatch record does not carry it |

Reads the dispatch record as `goalWalkState`, refusing a 404 and a dispatch still running. Takes the goal (or the `goal` input), `executionId` and `selectedTemplateId` from that record. A misrouted or failed walk records no selected template, but its row in the trace listing names the activity that closed it (`satisfier:goal-host-walk-failed`), so with no template the activity is taken from `executionTraceList` (the newest 50), and the reply says so; with no activity either way, or no execution, it writes nothing and says where the assessment goes instead (`record_finding`, category `goal-routing`). With all three it and resolves `goal_verification_label_write` (activity-api's resolver) through the attachment, once — a write is never retried: verdict `achieved`/`not_achieved`/`partial`, `labeler: "automated"`, notes `<rationale> [operator: <operator>] [session: <session>]` (§ Client claim). The tool is driven by an agent's key, so its verdict is never labelled `human`: goal-host treats a `human` label as ground truth (it overwrites `reached` and files a human-reported gap), and a person's verdict comes through the human surface. Until labels carry provenance derived from the writing credential, the principal travels only in notes. The label lands in the oracle corpus (`goal_verification_labels`), consumed by offline audit rather than by an automated reach-gate. Through a spoke a producer's refusal of the label (a 400 naming missing fields) arrives as `no_producer(goal_verification_label_write)`; the line says that either no producer answered or the producer refused the label, and that no label was written.

### path_activity

Handler: `src/tools/path-activity.ts@handle`

Before editing shared files, what the substrate has in flight on them.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `paths` | string[] (1–50) | **required** | Files or directories, workspace-relative or in the gap store's `repos/<vessel>/<path>` form |
| `limit` | integer (1–100) | `10` | Most gaps listed per path besides those being landed, which are always listed |
| `include_closed` | boolean | `false` | Also list closed gaps that named the paths |

**Path mapping** (`src/tools/_gap-activity.ts@pathMapper`). The gap store names files super-repo-relative, `repos/<vessel>/<path>`, in a gap's `classification_metadata.edit_site` and in its goal and summary text. In the super-repo (a `repos/` directory at the top of the tree) a path maps relative to the root; in a vessel's own checkout it maps to `repos/<name>/<path>`, where `<name>` is the basename of the `origin` remote's path (every super-repo submodule is `repos/X → ../X.git`); a directory under `repos/` that is not a submodule maps by its name. In any other repository the tool says so and checks only paths given in `repos/…` form. The vessel rule maps any repository with an `origin`, so a vessel checkout whose `repos/<name>/` no open gap names is reported as one this substrate may not mount (no lookup of mounted repositories exists yet), and its paths are not checked: "no open gaps" there would read as "nothing in flight".

**Read** (`src/tools/_gap-activity.ts@readGaps`). The store has no path filter and answers the newest `limit` rows by `updated_at`, with `total` counting the page; a file's gaps are mostly old rows, which a recency page drops. So the read is the whole store: `substrateGap { status: "open", limit: 1000000, include_held: true }` (and `status: "closed"` with `include_closed`), a read with the read retries and a 30 s cap. On a busy node the whole open store is about 13 MB, so the read is cached per attachment: fresh for 5 minutes, then served stale for up to 30 minutes while one background read refreshes it, with concurrent callers sharing one read, so agents checking on every edit do not each load the store's holder. When the answer is as large as the limit the output gives no count and says the read may be truncated.

**Output**, one block per path. It leads with the count of open gaps and how many are being landed by the system now, held and queued (a busy file has hundreds). Every gap being landed is listed; then up to `limit` more, held ones first and then queued ones, edit site first, then those with an edit site in a given directory, then those that mention it, each newest first, and a line counting the rest. Each gap shows its id, category and route, and one of:
- **held** — `classification_metadata.operator_hold`, a parking disposition (`needs_information`, `needs_info`, `awaiting_operator_review`) or a landing awaiting its verdict: `held by operator ruling: <reason>`, with `review by <date>` and `lift: <condition>` from the hold record that carries them, or `no review date recorded`;
- **being landed** — a live landing lease: its holder, attempt and expiry exactly as stored, marked as the holder's own claim (holders are caller-supplied), and, as facts rather than orders, what an edit now does (an edit before the lease ends is lost or conflicts when the change lands) and whose decision it is (the agent's user). The store keeps a lease after its `until` passes, so a lapsed one is shown as lapsed (when, and who held it) and the gap counts as queued, not being landed; a lease is lapsed only 2 minutes past its `until`, so a slightly fast local clock never frees a landing early; a lease with no `until` is shown as possibly stale and not counted as being landed. Times print with their date and how long ago or ahead they are;
- **queued** — neither: queued for the system.

The output ends with what to do, one line for each state present: wait and look again for a gap being landed, prefer letting the system land or dispatching a queued one, a held gap is not open work, and with nothing in flight make the change and record it. A substrate that serves no gap store (`no_producer(substrateGap)`) is not an error to stop on: the tool says there is nothing in flight to check and to go ahead. Any other failed read is one named line. The paths are matched locally and never sent, so the outgoing guard does not check them.

### registry_query

Handler: `src/tools/registry-query.ts@handle`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode` | `shapes\|vessels` | **required** | `shapes` lists the advertised vocabulary; `vessels` lists who serves `shape` |
| `shape` | string | — | Required in `vessels` mode; in `shapes` mode, a case-insensitive substring filter |

Resolves discovery's own shapes through the attachment (§ Attachment), which discovery answers itself. `shapes` mode: `vesselRegistry`, whose vessels' shapes, unioned, are the advertised vocabulary (the set discovery's `GET /registry/shapes` lists), filtered client-side and sorted (`src/tools/registry-query.ts@fetchShapeVocabulary`). `vessels` mode: `vesselCapability { shape }`, listing each vessel's id, endpoint (`public_endpoint` when present), protocol and resolve endpoint, plus a warning line when the vocabulary and the `vesselCapability` rows disagree about the shape. A discovery failure is one named line.


The vocabulary is the **anchor node's**: discovery answers `vesselRegistry` itself, so on a spoke it lists that node's shapes, while resolves reach peer nodes too. `shapes` mode ends with a line saying so, and that a peer-served shape is asked for by name in `vessels` mode. In `vessels` mode, producers that `vesselCapability` returns for a shape the anchor's vocabulary does not list get a note naming both readings: the producers are on a peer node, or one view is stale.
### execution_trace

Handler: `src/tools/execution-trace.ts@handle`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `execution_id` | string | — | The durable trace's execution id. Omitted: list recent traces |
| `limit` | number | `10` | With no `execution_id`: how many recent traces to list (1–50) |

With no `execution_id`, resolves `executionTraceList { limit }` (`src/tools/_traces.ts@listExecutionTraces`) and lists the most recent traces of the caller's org, newest first — execution id, status, duration, template and time, with the page's success and failure counts — ending with how to read one, so an agent holding no id can find a trace. It is a read, retried like the trace read; an empty list says that no trace is recorded. activity-api scopes the listing to the key's account and org; every key on one substrate sees the same set. activity-api's rows carry the stored record id (`v_paradigm_execution_traces:⟨exec_…⟩`); the listing shows the bare `exec_…` id, which is the form `activityExecutionTrace` answers, and a record id passed as `execution_id` is read by its bare id (`src/tools/_traces.ts@bareExecutionId`).

With an `execution_id`, resolves `activityExecutionTrace { executionId, format: "json" }` through the attachment (§ Attachment) — activity-api's resolver, which answers the stored execution row (`src/tools/_traces.ts@readExecutionTrace`; its per-task sequence is lifted from `execution_trace.tasks`). It is a read: cut at activity-api's 10 s, it is retried with backoff before a `producer_timeout` line. A satisfier reach (`walk-satisfier-…`, or a `satisfier:` template) persists no task trace — activity-api answers 404 for it, a successful one included — so the listing marks such rows, and reading one answers at once that its walk is in the dispatch record (`goal_reasoning`), with no request (`src/tools/_traces.ts@isSatisfierExecution`). Otherwise it renders status, `activity_template_id`, `vessel_id`, `composition_chain`, the first `state_signature:` / `reached:` / `completion_shapes:` / `operator:` tags, failure mode, and the per-task sequence. A 404 is reported as expected for a satisfier-only reach, pointing at `goal_reasoning`. Through a spoke a missing trace arrives as `no_producer(activityExecutionTrace)`, and the line says that either no producer answered or the trace does not exist (a satisfier-only reach persists no trace); `goal_status` and `goal_reasoning` use the same line for their trace read. `goal_reasoning` renders the same trace for a dispatch.

### resolve_impulse

Handler: `src/tools/resolve-impulse.ts@handle`

The advanced escape hatch: resolve one of the substrate's plain reads (`memoryNote`, `traceAggregateReport`, `llmSpendSummary`, …) or the memory write `memoryNote_write`. Prefer a dedicated tool when one fits.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `shape` | string | **required** | `pointer.type` to resolve |
| `pointer` | object | — | Extra pointer fields, merged after `type` (so `pointer.type` overrides `shape`) |

For an allowed shape, the attachment's `resolve()` (§ Attachment): `{ pointer }` to discovery `POST /resolve`, which forwards it to the shape's producer. It is sent once and never retried (cap `RESOLVE_IMPULSE_TIMEOUT_MS`, default 30 s, never above 60 s). Returns the HTTP status and the producer's response body (pretty-printed JSON, truncated at 2048 characters) for any status; a discovery failure is one named line. It adds no `operator` field.

**It is an allowlist.** A shape, named by `shape` or by `pointer.type`, resolves only when it is one of the plain reads in `src/tools/resolve-impulse.ts@escape-hatch-reads` (records, reports, statistics, summaries and policies) or the memory write with no dedicated tool, `memoryNote_write` (`src/tools/resolve-impulse.ts@escape-hatch-writes`). A shape's name does not tell a read from an action (`bash`, `code_replace_lines`, `surrealdb_import` and `llm_completion` read like reads), so everything else is refused before any request, unlisted reads included: a shell, file edits, git and GitHub, restarts, cutovers, composes, dispatch, credit, trace deletion. The refusal says to dispatch the work as a goal, so goal-host routes it and its judge grades it, or to use a dedicated tool. The known writes carry their own reason and alternative (`src/tools/resolve-impulse.ts@coordination-writes`):

| Writes | Why an agent does not make them | Instead |
|---|---|---|
| `maintenanceLease_write`, `substrateGapLease_write` | the system's own coordination: maintenance windows, the auto-pick lane, a gap's landing | dispatch the work as a goal, or let the system land the gap; record a finding for a lease that looks stuck or foreign |
| `activityExecutionTrace_write`, `execution_write` | the graded record: a trace's tags set its reach | dispatch the work as a goal, so goal-host traces it and its judge grades it |
| activity templates, variants, compositions and feedback; impulse relevance, shape scores, execution and concept sequences, attributions, tool usage, and the system's other learned state | the system learns these from its own graded work; an agent writing them hand-feeds it | dispatch a goal, or record a finding with what was observed |
| `test_report_write`, `test_audit_report_write`, `test_registration_write` | gate evidence, which the gates write themselves | run the check, or dispatch it |
| `interactor*_write`, `ui*_write` | the human surface's own records | the person uses that surface as themselves |
| `fs_write` | writes files on a vessel | a dispatched goal or a reviewed commit |
| `pushPolicy_write`, `llmModelPolicy_write`, `docFixPolicy_write`, `renderPolicy_write` | system policy is an operator's decision; this key carries no operator authority | ask the person, or record a finding proposing the change |
| `goal_verification_label_write`, `poolImpulse_write`, `substrateGap_write` | the oracle corpus; walk input with no stamped principal; gaps, which the system's detectors file | `provide_feedback`; dispatch a goal; `record_finding` |
| `concept_create_write`, `conceptLink_write`, `conceptUsage_write`, `solicitationResponse_write` | each has a dedicated tool that checks its input and records provenance | `concept_create`, `concept_link`, `concept_record_usage`, `submit_resolution` |
| `concept_write`, `concept_delete_write`, `concept_retire_write` | overwriting, deleting or retiring the system's memory | `concept_create` the corrected concept and `concept_link` it `derived_from` the wrong one, which keeps the history |
| `concept_supersede_write` | advertised by concept-db but not implemented there (it throws) | as above |

`tests/fixtures/registry-vocabulary.json` decides every shape of a live vocabulary, allowed or refused, and a unit test holds the code's allowlist to it, so a refreshed snapshot with a new shape fails the build until someone decides it; at run time an undecided shape is refused. There is no override: sanctioned maintenance runs as a dispatched activity that takes the lease as its own steps. The refusals keep this cockpit from being the convenient route to these writes; they are not a security boundary, which belongs to each producer.

---

## Concept graph tools

concept-db's graph of concepts, edges and usage, reached through the attachment (§ Attachment) as concept-db's own shapes (`src/tools/_concept-db.ts`) — never `concept`, which development-vessel also advertises, so the vessel answering it depends on registry order. Each request is capped at 35 s (discovery cuts concept-db at 30 s); a read cut there is retried with backoff, a write is sent once. A discovery failure, or concept-db's refusal, is returned as one line, never thrown. Reads through these shapes record no load event on the concepts they return; `concept_record_usage` is the relevance signal. concept-db answers some ids bare and others `⟨⟩`-wrapped (or `concept:`-prefixed); every tool here, and the findings tools, print a concept id in its plain form (`concept_…`, `src/tools/_concept-content.ts@plainConceptId`) and accept any of the three forms as input. Bodies render through `src/tools/_concept-content.ts@renderConceptContent`: `preview` is the first ~700 characters, cut back to a line boundary with the truncation disclosed; `full` is the whole body; `none` omits it.

### concept_search

Handler: `src/tools/concept-search.ts@handle`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `concept_id` | string | — | Read exactly this concept (with or without the `concept:` prefix) with its full body; other filters are ignored |
| `content` | `preview\|full\|none` | `preview` | Body rendering per result |
| `query` | string | — | Natural-language or shape-name query; omitted = list mode |
| `source_type` | string | — | Filter by source type |
| `shape` | string | — | Filter by shape |
| `min_relevance` | number | — | Relevance threshold, 0..1 |
| `limit` | number | `10` | Max results (max 50) |

For `concept_id`, the root of `conceptGraph { concept_id, limit: 1 }` — the row `GET /concepts/:id` returns; otherwise `conceptSearch` with the filters set (relevance first). Each result shows source type, shape, id, summary, relevance / loaded / succeeded / failed counts, last update and the body.

### concept_neighbors

Handler: `src/tools/concept-neighbors.ts@handle`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `concept_id` | string | **required** | Concept id (no `concept:` prefix) |
| `content` | `preview\|full\|none` | `preview` | Body rendering per neighbour |
| `direction` | `outgoing\|incoming\|both` | `both` | Edge direction to follow |
| `edge_types` | string[] | — | Edge-type filter |
| `limit` | number | `10` | Max neighbours (max 50) |

`conceptGraph { concept_id, direction, edge_types?, limit }`, whose edges carry the full edge and neighbour rows; concept-db's 404 for an unknown concept reads as no neighbours. One entry per edge: edge type, shape, neighbour id, summary, edge weight and traversal count, relevance and the body.

### concept_usage_stats

Handler: `src/tools/concept-usage-stats.ts@handle`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `concept_id` | string | **required** | Concept id (no `concept:` prefix) |
| `include_history` | boolean | `true` | Include recent usage rows |
| `history_limit` | number | `10` | Max usage rows (max 50) |

`conceptUsageStats { concept_id }` (total uses, success and failure rates) and, with history, the recent usage rows (outcome, time, trace and activity per row). No concept-db shape serves usage history, so the rows are the one direct REST read the substrate tools make (`src/tools/concept-usage-stats.ts@usage-history-direct-edge`): concept-db is located through discovery's `vesselCapability`, through the attachment, and read at `GET /concepts/:id/usage?limit=N` (3 s) on the attachment's request path (§ Network). An advertised private address (RFC 1918, CGNAT, link-local) on another host than discovery is not dialled, since it is almost always out of reach from the client. A failed or skipped history read still returns the stats, with `Recent usage: unavailable — recent rows come from concept-db directly at <address>, …; the aggregate above is complete`.

### concept_sequence

Handler: `src/tools/concept-sequence.ts@handle`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `concept_id` | string | **required** | Concept id (no `concept:` prefix) |
| `direction` | `next\|prev\|both` | `next` | Direction along the sequence chain |
| `limit` | number | `10` | Max neighbours (max 50) |

`conceptSequence { concept_id, direction, limit }`: the concepts observed to follow (or precede) this one, with weight and traversal count.

### concept_link

Handler: `src/tools/concept-link.ts@handle`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `from_concept_id` | string | **required** | Source concept id |
| `to_concept_id` | string | **required** | Target concept id |
| `edge_type` | `related_to\|derived_from\|resolves_to\|sequence_next\|sequence_prev\|description_of\|example_of\|contradicts` | **required** | The typed relationship |
| `description` | string | — | Rationale |
| `weight` | number | concept-db's default | Initial edge weight, 0..1 |

Writes `conceptLink_write { linkData: { from_concept_id, to_concept_id, edge_type, description?, weight? } }` once. concept-db upserts: a new edge is created, and a repeated `(from, to, edge_type)` moves the existing edge's weight by EMA (the reply then says the edge exists, with its previous weight). Renders the edge id, endpoints, type, weight and description.

### concept_create

Handler: `src/tools/concept-create.ts@handle`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `content` | string | **required** | The concept body (embedded for similarity search) |
| `summary` | string | — | One-line gist |
| `shape` | string | **required** | The impulse shape this concept represents |
| `source_type` | `goal\|memo\|human_input\|search\|llm\|metabob_annotation\|write\|read\|cpg_embedding\|extracted\|impulse_signature\|vessel_construction_pattern\|impulse_activity_pattern` | **required** | Substrate category |
| `pointer` | object | `{ type: <shape> }` | Pointer envelope |
| `budget` | number | concept-db's default | Token budget for resolution snapshots |
| `priority` | number | concept-db's default | Initial priority, 0..1 |

**The author is stamped** (`src/tools/concept-create.ts@concept-author-stamp`), as `record_finding` stamps a finding's:
`recorded_by: <vesselId>` and `session: <id>` become the content's first lines, so every reader's first match is the
stamp (`task pull`'s convention trust reads the first `recorded_by:`). `recorded_by:` and `session:` lines the agent
wrote in the leading header block (up to the first blank line) are removed, at any indentation and in any case, and
the reply names what it removed; the body after the header block is untouched. They are removed whether or not an
identity resolves. With no vessel identity nothing is stamped: an author is omitted, never faked, and never taken
from what the agent wrote. Readers follow the same rule (`src/tools/_concept-content.ts@header-block`): the author,
session, repository, files, a verdict and finding ids are read only from the header block, so free text after the
blank line never supplies them. That covers recall, claims, verdicts and `task pull`'s convention trust. Like every author line it is declared, not verified (§ Client claim).

Writes `concept_create_write { conceptData }` once — the body `POST /concepts` takes; renders the created concept's id, shape, source type, summary, budget and priority.

### concept_record_usage

Handler: `src/tools/concept-record-usage.ts@handle`

The direct write into concept-db's relevance model.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `concept_id` | string | **required** | The concept the outcome applies to (with or without `concept:`) |
| `outcome` | `success\|failure\|neutral` | **required** | `success` = it helped; `failure` = it misled; `neutral` = loaded only |
| `trace_id` | string | `mcp:<uuid>` | Execution or trace id |
| `activity_id` | string | — | Activity id |
| `task_id` | string | — | Task id within the activity |

Writes `conceptUsage_write { usageData: { concept_id, trace_id, outcome, activity_id?, task_id? } }` once, with the concept id in its plain form. The client computes no relevance: concept-db folds the outcome into its Bayesian posterior mean `(times_succeeded+1)/(times_loaded+2)` — `success` credits the concept, `failure` and `neutral` grow the load count without credit. `mark_complete` on a finding writes through this same shape.

---

## Agent-resolver tools

A `human_input` impulse that reaches the loopback resolver (§ Impulse shapes) is durably enqueued
for the agent, and these two tools drain and answer that queue. The session is a client of the
substrate and advertises no shape, so the substrate has no inbound offer to dispatch a task to it
(CONFORMANCE §c11-attachment-model): the queue fills only from a local caller of the resolver.
`goal_reasoning` reads the substrate's walk; these two tools answer a solicitation.

Tasks and answers persist in `~/.metabob/sidecar.db`,
keyed by the vesselId — `VESSEL_ID`, else `metabob-mcp-<hash(apiKey+workspace)>`
(`src/resolver-identity.ts@getResolverVesselId`). A later session in the same
workspace with the same key derives the same id and resumes: it sees
still-pending tasks and, at startup, re-delivers answers a prior session
recorded but could not send (`src/agent-delivery.ts@reconcileUndelivered`).
Loop: a solicitation is queued → `pull_assigned_work` → reason → `submit_resolution`.

### pull_assigned_work

Handler: `src/tools/pull-assigned-work.ts@handle`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | `10` | Max tasks (max 100) |

Expires tasks past their deadline, then lists pending and claimed tasks (oldest first) and marks each claimed by this session. Returns each `task_id`, its `dispatch_id`, the time left to respond, and the question. A claim records the session; it is not exclusive — a claimed task still lists on later pulls until it is resolved or expires. With nothing queued, it says that no task can arrive — the session advertises nothing, so the substrate has no inbound offer to dispatch to (`src/tools/pull-assigned-work.ts@NO_INBOUND_OFFER`) — rather than reporting an empty queue an agent would keep polling.

### submit_resolution

Handler: `src/tools/submit-resolution.ts@handle`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task_id` | string | **required** | A task from `pull_assigned_work` |
| `outcome` | `answered\|declined\|insufficient_context` | **required** | The resolution |
| `answer` | string | — | Required (non-blank) when `outcome` is `answered` |

An unknown `task_id` is reported as such, adding that the substrate dispatches no task to this session. For a known task it records the answer durably first and marks the task resolved, then delivers it to goal-host as the `solicitationResponse_write` shape through the attachment (20 s cap; `src/agent-delivery.ts@deliverResolution`). goal-host's 404 means the solicitation timed out: the answer is marked delivered and never retried. Discovery having no producer for the shape (`no_producer`) is not terminal; through a spoke a peer goal-host's 404 also arrives as `no_producer`, so that answer stays queued and is re-sent each session. Any other failure leaves it queued for the next session's startup reconcile; nothing retries within a session.

---

## Typical agent workflow

```
1. init_workspace(workspace_path, recently_changed_files)
   → builds the local CPG; nothing leaves the machine

2. get_analysis_context(recently_changed_files)
   → snapshot: index stats + open problems + co-change hints

3. get_problems(severity=["HIGH","CRITICAL"])
   → full problem list for triage

4. predict_cochanges(changed_files) / analyze_impact(changed_files)
   → local CPG queries

5. record_finding(files, summary, severity, category)
   → the write half: attribute what you found to the code; returns agf_* ids
     and mints a code_finding concept other agents recall org-wide

6. annotate_component(agf_* | concept_*, mode="recommend")
   → structured why/how notes

7. mark_complete(agf_* | concept_*, action="endorse")
   → verdict; on findings it also folds relevance into concept-db

8. run_goal_async(goal, learning_mode?) → goal_status(dispatch_id) → goal_reasoning(dispatch_id)
   → provide_feedback(dispatch_id, verdict, rationale)
   → delegate to the substrate when it mounts the repo; read `reached` and `learning:`,
     check the walk, then record your verdict (an `automated` label)

9. pull_assigned_work() / submit_resolution(task_id, outcome, answer)
   → answer a decision queued on this machine; the substrate dispatches
     nothing to a client-only session, so the queue is usually empty

10. init_workspace(recently_changed_files=[...files changed since...])
   → parses files added since the last call; files already parsed are not re-read
```

The MCP client runs the compiled `dist/cli.js`: after editing `src/`, run `bun run build` and reconnect the server for tool changes to take effect.

## Impulse shapes (HTTP resolver)

The vessel accepts `POST /v2/impulses/resolve` from local callers: the server binds `127.0.0.1` and advertises the resolver nowhere. The body is `{ impulses: [{ id?, pointer }] }` or a single `{ pointer }`; the shape is `pointer.type`. Mapped shapes run the named tool, subject to the `METABOB_TOOLS` allowlist (`src/vessel-server.ts@resolvePointerToTool`):

| Shape | Maps to | Pointer fields forwarded |
|-------|---------|--------------------------|
| `mcp:tool_call` | any tool by name | `tool`, `input` or its alias `arguments` (what MCP clients call it; default `{}`; both at once is refused) |
| `code:cochange_prediction` | `predict_cochanges` | `changed_files`, `limit`, `confidence_threshold` |
| `code:impact_analysis` | `analyze_impact` | `changed_files`, `diff`, `direction`, `max_depth`, `include_tests` |
| `code:git_change_assignment` | `assign_git_changes` | `changed_files`, `diff`, `include_cochange_predictions`, `prediction_limit` |
| `code:analysis_context` | `get_analysis_context` | `recently_changed_files`, `problem_limit`, `scope` |
| `human_input` | queued, not resolved inline (`src/vessel-server.ts@QUEUED_SHAPES`) | `question_markdown` (required), `solicitation_id` or `id`, `timeout_ms` (default 300 000) — durably enqueued for `pull_assigned_work` / `submit_resolution`; the POST ACKs `{ accepted, solicitation_id, will_respond_via }` |

Auth: `Authorization: ApiKey <key>` (a `Bearer <key>` or bare key is also accepted), matched against `METABOB_API_KEY` or the identity API key; with no key configured the endpoint fails closed with 401. Per-impulse errors return `loaded: false` inside an HTTP 200.
