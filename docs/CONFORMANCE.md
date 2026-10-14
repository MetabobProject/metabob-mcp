# Substrate participation conformance

This vessel joins a substrate it does not own. Where the vessel's own design and the substrate's
expectations disagree, **the substrate's expectations take priority** (user ruling 2026-10-13:
substrate expectations over vessel design), and that settles every conflict below. The requirements
originate in the substrate's deployment: the super-repo `CLAUDE.md` laws (cited as `CLAUDE.md law N`),
user rulings held in the substrate's memory store (cited as `user ruling YYYY-MM-DD: <topic>`; only
the user makes rulings), `docs/FEDERATION.md`, and the discovery-vessel contract it describes.

Each section states one requirement, then the status of this code against it: **met** (with the code
that meets it), **partially met**, or **not yet met** (with the gap stated plainly). Code that
implements a requirement cites it as `CONFORMANCE §<section>`; the rules for those citations are in
[DOCLINKS.md](DOCLINKS.md).

The vessel has one configuration: an API key and an endpoint, from which the substrate URLs derive
(user ruling 2026-10-13: one configuration, not two), and it proves the key against the substrate's
identity before any other keyed call (C3). It is a client of the substrate: it makes no
discovery registration, runs no libp2p node, and serves its HTTP resolver on loopback for local
callers only.

## C1 — Transport

**Requirement.**
- Cross-node reach happens only over the substrate's overlay, never through a published port.
- A vessel has no overlay identity of its own: there is one overlay peer per substrate.
- Inside a substrate, a vessel registers with its **local** discovery; the substrate mirrors the row
  to other nodes as `<vessel>@<substrate>`.
- A host-run vessel reaches the overlay through the ingress-sidecar pattern.
- A vessel never runs a second libp2p peer.

**Status: met.** The vessel runs no libp2p node and has no overlay identity of its own:
`src/index.ts@main` starts the MCP stdio transport and the loopback HTTP resolver
(`src/vessel-server.ts@loopback-bind`) and nothing else, and the package depends on no libp2p
transport. It reaches other vessels only as a client of the endpoints it is configured with
(see C11).

## C2 — Endpoint

**Requirement.**
- A row advertises only an endpoint its reader can dial. Loopback is dialable only within the same
  network namespace — the host's `127.0.0.1` is not a container's.
- Host-address overrides are not the mechanism for reachability.
- A vessel advertises an endpoint only after reachability has been observed.
- A vessel never registers when its server is not bound.

**Status: met.** The vessel writes no registry row, so it advertises no endpoint, uses no
host-address override, and has nothing to advertise before reachability is observed:
`src/index.ts@main` makes no discovery registration under any configuration, and
`tests/workflows/w3-attachment.test.ts` asserts that no `/register` reaches discovery. The HTTP
resolver binds `127.0.0.1` only (`src/vessel-server.ts@loopback-bind`), so it is reachable only from
the vessel's own network namespace.

## C3 — Identity

**Requirement.**
- The key a vessel registers with comes from the identity of the namespace it joins. Discovery
  refuses a key from a foreign namespace (`reason=invalid`).
- A cross-node call carries `Authorization: ApiKey <key>` to the local egress, which carries it as
  `_fedAuth`; the remote ingress strips it before delivery.
- Under enforcement, only public shapes (`substrateBootstrap`, the federation probes) are served
  without a valid key.

**Status: partially met.**
- Met — the vessel's own resolver (`POST /v2/impulses/resolve`, `src/vessel-server.ts@VesselServer`)
  fails closed with 401 when no key matches, and the substrate tools send
  `Authorization: ApiKey <key>` on their requests.
- Met — the org check. Before any other keyed call, `src/attachment.ts@attach` proves the key
  against the identity endpoint the anchor names: `POST {identity}/v1/auth/resolve` with
  `Authorization: ApiKey <key>` (`src/auth-service.ts@org-check`) must return the tenant's
  `org_id`. A captive portal cannot forge that answer without the key, and a key from a foreign
  namespace is refused there (401 → `key_rejected`). Whichever address identity selection chose —
  explicit, advertised, or rehosted (C4) — the check runs against that address; selection only picks
  it. Until the check passes, every substrate tool passes one gate on both dispatch planes
  (`src/tools/index.ts@substrateToolRefusal`) and answers with the named cause in one line, the
  substrate half of the mixed tools and answer delivery check the same attachment
  (`src/tools/_findings.ts@conceptDbReachable`, `src/agent-delivery.ts@deliverResolution`), and the
  local tools work. Evidence: `tests/unit/attachment.test.ts` (a rehosted address that rejects the key
  → `key_rejected`, with the org check the only keyed call); `tests/workflows/w3-attachment.test.ts`
  (a foreign key: discovery sees only `GET /bootstrap`, identity only `/health` and the org check, and
  every substrate tool answers `key_rejected: …` in one line).
- Partially met — the substrate tools send the key only to discovery `POST /resolve` (C11), apart from
  one read of concept-db's usage history (C11); they never send it to a vessel discovery names. Discovery
  forwards it to the producer, or to a peer discovery, as a plain `Authorization` header rather than
  through the transport egress as `_fedAuth` — the substrate's side of the path (the accepted risk
  below).

**Accepted risk, not conformance: cleartext key on plain-http anchors.** The vessel sends its key to
whatever anchor it is configured with, including non-loopback plain-http anchors such as a hub's
published `http://<host>:18100` (user ruling 2026-10-13: send the key wherever the anchor is).
Through discovery `POST /resolve` the key is forwarded as a plain `Authorization` header to the local
owner or a peer discovery, readable by any proxy or network on the path. The remedy is on the
substrate side (the overlay, or a TLS anchor on 443); until it lands, this exposure is known and
accepted, and does not count as meeting C3.

## C4 — Anchoring

**Requirement.**
- A vessel's inputs are exactly two: the discovery endpoint and the key.
- Relay, identity and discovery addresses are learned from `GET /bootstrap`, whose fields are
  `relay_multiaddrs`, `identity_endpoint`, `discovery_endpoint` and `prefer_transport`. There is no
  namespace field: the namespace is a property of the key.
- No address is derived by path prefix from another.
- Inside a substrate, discovery is `127.0.0.1:8100`.

**Status: partially met.**
- Met — nothing defaults to a public host. With the key or the endpoint missing, the vessel reports
  the missing input once, naming the config lookup order (`src/config.ts@unattachedMessage`), and
  runs with local tools only.
- Met — no path-prefix derivation: `src/config.ts@deriveLocalDiscoveryEndpoint` derives discovery
  only for a port-published endpoint and nothing for a remote one, and
  `src/config.ts@withoutEndpoints` keeps a config file's endpoints from mixing with an explicit
  `METABOB_ENDPOINT`.
- Met — identity is learned from `/bootstrap`: `src/attachment.ts@attach` reads `identity_endpoint`
  from `GET {discovery}/bootstrap` and uses it when it answers; an explicit `IDENTITY_ENDPOINT` /
  `metabob.identityEndpoint` overrides it. Each candidate address is contacted at most once, and the
  attachment state records what was advertised and what was tried.
- Interim debt (census class H1) — a live substrate's `/bootstrap` advertises its identity at a
  container-internal address the host cannot dial (node1 `http://127.0.0.1:8101`, compose2
  `http://substrate-live:8101`). When that address is loopback or a single-label host on an 8xxx port
  and does not answer, `src/attachment.ts@rehost-h1` maps it onto the discovery host at discovery's
  published-port offset, logs a WARN naming the advertised value, and records
  `identity.source: "rehosted-h1"`; the org check (C3) still decides whether it is trusted. It goes
  when the substrate installer writes a host-visible identity endpoint, or `/bootstrap` answers per
  vantage.
- Interim debt (census class H1) — discovery itself may still be derived from `metabob.endpoint` at
  the published-port offset (…080 → …100). The server logs a WARN once when it is
  (`src/config.ts@derivedDiscoveryWarning`) and the attachment state records `anchor.source:
  "derived-h1"`; `metabob.discoveryEndpoint` / `DISCOVERY_ENDPOINT` is the explicit form. It goes
  when the installer writes the discovery endpoint into the client config.
- Met, apart from the H1 interim debts above — the inputs are two: the key and the discovery
  endpoint. Every substrate call resolves a shape through discovery (C11), so no other service has a
  URL to configure, derive or discover (`src/config.ts@applyConfigDefaults` sets only the key, the
  vessel id, the endpoint, discovery and an explicit identity). `METABOB_ENDPOINT` /
  `metabob.endpoint` routes nothing: it is the source of the H1 discovery derivation and a host for
  the TLS probe and doctor to name. `IDENTITY_ENDPOINT` / `metabob.identityEndpoint` remains an
  optional override of the identity `/bootstrap` advertises, for a substrate whose advertised identity
  the host cannot dial (the H1 rehost's explicit form).

## C5 — What breaks under enforcement

Under the substrate's enforce mode these fail, whatever the vessel intends:
- a cross-node call that does not forward the key;
- a key from a foreign namespace;
- reachability that exists only through rows nobody can dial;
- reliance on unauthenticated ingress for a non-public shape, such as `mcp:tool_call`.

**Status.** The vessel writes no row and offers nothing inbound, so no substrate caller depends on
it; its loopback resolver still requires a key for every shape, `mcp:tool_call` included. Its own
cross-node exposure is the key it sends: a foreign key is refused once, at the org check, before any
other keyed call (C3).

## C6 — Collisions

**Requirement.**
- No default `HEALTH_PORT` in 8000–8999: 8080 is activity-api inside every substrate container, and
  discovery rewrites `127.0.0.1` endpoints on ports 8000–8999 to port + 10000.
- Never a port in a published fleet range: `<prefix>080`–`<prefix>333` for prefixes 18–32.

**Status: partially met.**
- Met — `src/index.ts@HEALTH_PORT` defaults to 0 (ephemeral), and an explicit value in 8000–8999 is
  warned about (`src/index.ts@health-port-range-warning`).
- Not yet met — an explicit `HEALTH_PORT` inside a fleet range (for example 18080) is accepted
  without a warning.

## C7 — Shapes

**Requirement.**
- Reuse an existing shape before minting one.
- Produce `human_input` only where data locality justifies it — a human at that terminal — and never
  by default.
- Advertise concrete shape names, not `code:*`-style namespaced families.

**Status: met.** The vessel advertises no shape to the substrate (C11), so it produces neither
`human_input` nor a namespaced family there. The loopback capabilities document lists
`src/vessel-identity.ts@SERVED_SHAPES` for local callers only; that list excludes `human_input` and
names the `code:*` family, which would have to become concrete shape names before any inbound offer.

## C8 — Proxy and TLS in the vessel role

**Requirement.**
- Trust the OS trust store.
- Honour `HTTP_PROXY` / `HTTPS_PROXY` and `NO_PROXY`, with `127.0.0.1` and `localhost` added to
  `NO_PROXY` automatically so local substrate traffic never goes through a corporate proxy.
- Report an intercepted TLS connection as `TLS_INTERCEPTED`, with the diagnostics to act on it.

**Status: met.** Every request the vessel makes takes one path, `src/net.ts@net-request` (SPEC
§ Network), the same under Bun (the server) and Node (`doctor`, `attach --check`):
- Met — trust: a certificate is checked against the bundled roots, the OS trust store
  (`src/tls-trust.ts@systemCaAdditions`) and `NODE_EXTRA_CA_CERTS`, which the vessel reads itself so it
  applies under Bun too (`src/net.ts@trusted-cas`). The chain and the host name are verified before any
  byte of a request is sent.
- Met — proxy: `HTTP_PROXY` / `HTTPS_PROXY` and `NO_PROXY` are honoured per request
  (`src/net.ts@select-proxy`). Whenever a proxy is set, `localhost`, `127.0.0.1` and `::1` are added to
  `NO_PROXY`, and every loopback host goes direct, so local substrate traffic never goes through a
  corporate proxy. An https anchor is tunnelled with `CONNECT` by hostname; a plain-http anchor is sent
  in absolute form. Basic credentials in the proxy URL are redacted wherever a proxy is reported
  (`src/net.ts@redact-credentials`). The undici dispatcher installed for third-party `fetch`
  (`src/tls-trust.ts@installSystemTrustStoreSync`) never sends every host through one proxy: with an
  undici that cannot choose per request, it installs a plain Agent and warns.
- Met — `TLS_INTERCEPTED`: an untrusted chain is the named cause `tls_intercepted(<issuer>)`, whose line
  carries `TLS_INTERCEPTED`, the issuer and what to do (`src/net.ts@net-causes`). It reaches the
  attachment's refusal and `network` state, every substrate tool's error text — including tools that turn
  their own errors into text, since they all report the attachment's resolve failure
  (`src/attachment.ts@describeResolveFailure`) — `/health`, `doctor` and `attach --check`; an error a
  tool throws is reported with the code `TLS_INTERCEPTED` (`src/index.ts@tls-intercepted-report`).
- Met — the rest of the network is named too, in one line and within seconds: `proxy_auth_required(<scheme>)`
  (for NTLM / Negotiate, naming a local px- or cntlm-style relay), `proxy_port_blocked(<port>)`,
  `dns_failed`, `connect_timeout` (a 5 s connect budget apart from each call's response budget,
  `src/net.ts@connect-budget`), `connect_refused`, `connection_reset`, `response_timeout`,
  `blocked_by_portal`. PAC / WPAD is not evaluated; when a direct connection fails, the OS proxy settings
  are read and named (`src/os-proxy.ts@detect-os-proxy`).

Evidence: `tests/workflows/networks/matrix.test.ts` — 22 network conditions, each attaching (and
resolving one read through discovery) or failing within a bound with the named cause, under Bun in
process and under Node (`attach --check --json`), including the loopback bypass with `HTTPS_PROXY` set
(the proxy sees no request), `NO_PROXY`, Basic credentials never appearing in state, logs, output or
`/health`, and interception with the CA untrusted (`tls_intercepted(Corp Inspection CA)`) and trusted
(attaches); `tests/unit/net.test.ts` (proxy selection, `NO_PROXY`, redaction, classification, the OS
proxy readers); `tests/unit/substrate-tools-name-cause.test.ts` (every substrate tool's error text
carries `tls_intercepted(<issuer>)` and `TLS_INTERCEPTED`).

## C9 — Fail visibly

**Requirement.**
- "Advertised endpoint not reachable" and states like it are reported in `/health` and in `doctor`,
  never dropped silently.
- A vessel stops heartbeating a row it cannot show to be reachable. Discovery removes a row only when
  its 5-minute TTL lapses or on an explicit `DELETE /vessels/:vesselId`, never for being undialable,
  so an unreachable row the vessel keeps refreshing stays in the registry.

**Status: met.** The vessel writes no row, so it has no endpoint that can be unreachable and nothing
to heartbeat or leave behind in the registry (`src/index.ts@main`). The attachment state it does have
is reported, never dropped. It is one typed object (`src/attachment.ts@AttachmentState`):
- the anchor and how it was obtained (`explicit` or `derived-h1`);
- the `/bootstrap` result (`ok`, `unreachable`, `not_substrate`);
- the identity endpoint and its source, with the advertised value and every address tried;
- the org check (`authenticated` with its `orgId`, `key_rejected`, `identity_unreachable`,
  `not_configured`);
- the named cause, and timestamps;
- the network diagnosis (`src/attachment.ts@network-diagnosis`): the proxy in use (credentials
  redacted), how the anchor is reached, the named network cause, the TLS issuer seen, OS proxy settings
  the process does not see, and the last outcome per producer family.

`/health` carries it (`src/vessel-server.ts@health-attachment`), with `attached` and the reason, and
reports the proxy configuration even before an attachment exists; `doctor` runs the same sequence once
and prints it with the network diagnosis (`src/doctor.ts@probeAttachment`); `metabob-mcp attach --check`
prints it hop by hop and exits 1 unless attached (`src/attach-check.ts@attachCheck`). Each refusal is
logged once at WARN when the attachment settles, naming the requirement it serves (this one, or C3 for
`key_rejected`), and each refused call after it only at debug; each H1 fallback is logged once at WARN
naming C4; and the startup log states a missing key or endpoint once, naming C4
(`src/config.ts@unattachedMessage`). Evidence: `tests/unit/attachment.test.ts` (`/health` for the
authenticated, `key_rejected`, `identity_unreachable` and pending states),
`tests/workflows/w3-attachment.test.ts`, and `tests/workflows/networks/matrix.test.ts` (the named cause
and `/health` for each network condition).

## C10 — One registrant per key and workspace

**Requirement.** For one key and one workspace there is one registrant: the instance that holds the
bind registers, and the others run client-only. Rows are never per session.

**Status: met.** No instance registers, so there is never more than one registrant, and no row is
per session. `src/vessel-identity.ts@resolveVesselId` still derives one stable id from the key and
the workspace; it keys the local agent-task queue and the authorship of recorded findings, and is
never written to discovery.

## C11 — Attachment model

**Requirement.**
- One anchor: `{discovery, key}`.
- Every outbound operation is a shape resolved through discovery's `POST /resolve`, the single
  ingress. activity-api is not an ingress: for a shape it does not store it answers 404
  `use_vessel_discovery`.
- Every call ends within 60 s: long work is dispatched asynchronously, never held open.
- Inbound resolves are offered only after a reachability probe from an outside vantage — another
  node's transport egress — never through the local ingress. Until such a vantage exists, the vessel
  is client-only.

**Status: partially met.**
- Met — inbound: the vessel is client-only. It offers no shape and makes no registration under any
  configuration (`src/index.ts@main`; `tests/workflows/w3-attachment.test.ts`), and
  `pull_assigned_work` / `submit_resolution` say that the substrate dispatches nothing to it
  (`src/tools/pull-assigned-work.ts@NO_INBOUND_OFFER`).
- Met — the attachment resolves a pointer through discovery `POST /resolve` and nothing else
  (`src/attachment.ts@attachment-resolve`), naming discovery's own failures and capping every request
  below 60 s ([SPEC.md](SPEC.md) § Attachment); `registry_query` reads the registry through it, and
  `execution_trace`, `goal_status` and `goal_reasoning` read traces through it
  (`src/tools/_traces.ts@readExecutionTrace`). The goal tools and answer delivery reach goal-host
  through it as `goalDispatchAsync`, `goalWalkState` and `solicitationResponse_write`
  (`src/tools/_goal-host.ts@readWalkState`, `src/agent-delivery.ts@deliverResolution`), and
  `provide_feedback` writes its label as `goal_verification_label_write`.
- Met — every call ends within 60 s: `run_goal` dispatches asynchronously and polls with short
  `goalWalkState` reads until its deadline (`src/tools/run-goal.ts@run-goal-poll`); no request is held
  open for a goal.
- Met — the concept tools and the concept-db half of the mixed tools (`record_finding`,
  `get_problems` / `get_analysis_context` recall, `mark_complete` verdicts and relevance signals) reach
  concept-db through it as `conceptSearch`, `conceptGraph`, `conceptSequence`, `conceptUsageStats`,
  `concept_create_write`, `conceptLink_write` and `conceptUsage_write` (`src/tools/_concept-db.ts`).
- Not yet met, one read — concept-db serves usage history (`GET /concepts/:id/usage`) under no shape,
  so `concept_usage_stats` reads its recent rows from concept-db itself, at the endpoint discovery's
  `vesselCapability` names, on the attachment's request path — the same proxy, trust and named causes
  as every other request (`src/tools/concept-usage-stats.ts@usage-history-direct-edge`); the aggregate
  is the `conceptUsageStats` shape. It goes when concept-db serves history as a shape.
