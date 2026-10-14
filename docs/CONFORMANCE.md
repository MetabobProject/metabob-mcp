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
  (`src/tools/_findings.ts@resolveConceptDbUrl`, `src/agent-delivery.ts@deliverResolution`), and the
  local tools work. Evidence: `tests/unit/attachment.test.ts` (a rehosted address that rejects the key
  → `key_rejected`, with the org check the only keyed call); `tests/workflows/w3-attachment.test.ts`
  (a foreign key: discovery sees only `GET /bootstrap`, identity only `/health` and the org check, and
  every substrate tool answers `key_rejected: …` in one line).
- Not yet met — cross-node calls do not go through the local egress: the substrate tools send the key
  directly to the vessels discovery names (concept-db, goal-host-vessel) and to activity-api, rather
  than resolving through discovery so the key travels as `_fedAuth` (C11).

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
- Met — no path-prefix derivation: `src/config.ts@deriveSubstrateDefaults` derives port-offset
  siblings only for a port-published endpoint and nothing for a remote one, and
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
- Not yet met — the inputs are more than two. `METABOB_ENDPOINT` still feeds activity-api and the
  concept-db derivation, and `ACTIVITY_API_URL`, `CONCEPT_DB_URL`, `GOAL_HOST_VESSEL_URL` and
  `IDENTITY_ENDPOINT` each still feed routing when set.

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

**Status: partially met.**
- Met — `src/tls-trust.ts@installSystemTrustStoreSync` merges the OS trust store into Node's roots
  and the global fetch dispatcher, after the configuration is read, so the proxy is chosen for the
  configured substrate host. A certificate chain error a tool throws is reported as
  `TLS_INTERCEPTED` with the intercepting issuer (`src/index.ts@tls-intercepted-report`,
  `src/tls-error.ts@translateTlsError`).
- Not yet met — `127.0.0.1` and `localhost` are not added to `NO_PROXY`. With an undici that has
  `EnvHttpProxyAgent`, `NO_PROXY` is honoured as the operator set it; with an older undici the
  fallback resolves one proxy for the configured anchor and sends every host through it, ignoring
  `NO_PROXY`.
- Not yet met — tools that catch their own request errors and report them as text (the substrate
  tools do) report the raw error rather than `TLS_INTERCEPTED`.

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
- the named cause, and timestamps.

`/health` carries it (`src/vessel-server.ts@health-attachment`), with `attached` and the reason;
`doctor` runs the same sequence once and prints it (`src/doctor.ts@probeAttachment`); a refusal and
each H1 fallback are logged once at WARN; and the startup log states a missing key or endpoint once
(`src/config.ts@unattachedMessage`). Evidence: `tests/unit/attachment.test.ts` (`/health` for the
authenticated, `key_rejected`, `identity_unreachable` and pending states) and
`tests/workflows/w3-attachment.test.ts`.

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
- Not yet met — the concept tools and the concept-db half of the mixed tools call concept-db over
  direct REST (see [SPEC.md](SPEC.md) § Concept graph tools); discovery locates it but is not the path
  the calls take.
