# Substrate participation conformance

This vessel joins a substrate it does not own. Where the vessel's own design and the substrate's
expectations disagree, **the substrate's expectations take priority** — that is the user's ruling,
and it settles every conflict below. The requirements originate in the substrate's deployment:
`docs/FEDERATION.md` of the substrate repository and the discovery-vessel contract it describes.

Each section states one requirement, then the status of this code against it: **met** (with the code
that meets it), **partially met**, or **not yet met** (with the gap stated plainly). Code that
implements a requirement cites it as `CONFORMANCE §<section>`; the rules for those citations are in
[DOCLINKS.md](DOCLINKS.md).

## C1 — Transport

**Requirement.**
- Cross-node reach happens only over the substrate's overlay, never through a published port.
- A vessel has no overlay identity of its own: there is one overlay peer per substrate.
- Inside a substrate, a vessel registers with its **local** discovery; the substrate mirrors the row
  to other nodes as `<vessel>@<substrate>`.
- A host-run vessel reaches the overlay through the ingress-sidecar pattern.
- A vessel never runs a second libp2p peer.

**Status: not yet met.** When `GET /bootstrap` advertises a relay and the optional transport package
is installed, the vessel starts its own libp2p node (`src/federation/libp2p-node.ts@startFederationNode`,
called from `src/index.ts@main`) with its own peer id and circuit reservation, and advertises that
peer in its registration row. That is a second peer and a vessel-owned overlay identity. Without the
relay or the package the vessel is HTTP-only, which is the conforming state.

## C2 — Endpoint

**Requirement.**
- A row advertises only an endpoint its reader can dial. Loopback is dialable only within the same
  network namespace — the host's `127.0.0.1` is not a container's.
- Host-address overrides are not the mechanism for reachability.
- A vessel advertises an endpoint only after reachability has been observed.
- A vessel never registers when its server is not bound.

**Status: partially met.**
- Met — no registration without a bound server: `src/index.ts@httpServerBound` gates the discovery
  registration, and a failed bind leaves the process client-only.
- Met — no loopback default: `src/index.ts@advertisedEndpoint` is the explicit
  `VESSEL_PUBLIC_ENDPOINT` or nothing, and nothing means no registration. Registration also requires
  an explicit `HEALTH_PORT`, since an ephemeral port cannot be what an operator-chosen endpoint names.
- Not yet met — `VESSEL_PUBLIC_ENDPOINT` is itself a host-address override, and nothing probes the
  advertised endpoint before the row is written: the vessel trusts the operator's value.

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
- Not yet met — the vessel does not check that its key belongs to the discovery's namespace before it
  registers; a foreign key surfaces only as a rejected registration that the heartbeat keeps retrying.

## C4 — Anchoring

**Requirement.**
- A vessel's inputs are exactly two: the discovery endpoint and the key.
- Relay, identity and discovery addresses are learned from `GET /bootstrap`, whose fields are
  `relay_multiaddrs`, `identity_endpoint`, `discovery_endpoint` and `prefer_transport`. There is no
  namespace field: the namespace is a property of the key.
- No address is derived by path prefix from another.
- Inside a substrate, discovery is `127.0.0.1:8100`.

**Status: partially met.**
- Met — no path-prefix derivation: `src/config.ts@deriveSubstrateDefaults` derives port-offset
  siblings only for a local substrate endpoint and nothing for a remote one, and
  `src/config.ts@withoutEndpoints` keeps a config file's endpoints from mixing with an explicit
  `METABOB_ENDPOINT`.
- Met — the relay is read from `/bootstrap` at use time (`src/bootstrap.ts@fetchBootstrapAnchors`).
- Not yet met — identity is not learned from `/bootstrap`. `fetchBootstrapAnchors` parses
  `identity_endpoint`, but nothing consumes it; `src/index.ts@IDENTITY_ENDPOINT` and
  `src/auth-service.ts@DEFAULT_IDENTITY_ENDPOINT` fall back to `https://ide.metabob.com/identity`.
- Not yet met — the inputs are more than two: the gateway `METABOB_ENDPOINT` and its derivations,
  `ANALYSIS_API_URL`, `CONCEPT_DB_URL`, `GOAL_HOST_VESSEL_URL` and `VESSEL_PUBLIC_ENDPOINT` all feed
  routing.

## C5 — What breaks under enforcement

Under the substrate's enforce mode these fail, whatever the vessel intends:
- a cross-node call that does not forward the key;
- a key from a foreign namespace;
- reachability that exists only through rows nobody can dial;
- reliance on unauthenticated ingress for a non-public shape, such as `mcp:tool_call`.

**Status.** The vessel's advertised shapes, `mcp:tool_call` included, require a key at its own
resolver, so it does not depend on unauthenticated ingress. The other three follow from C2, C3 and C1:
each holds only where those are met.

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

**Status: partially met.**
- Met — `human_input` is opt-in: `src/vessel-identity.ts@agentResolverEnabled` is true only for
  `METABOB_AGENT_RESOLVER=1|true|on`.
- Not yet met — `src/presence-advertiser.ts@computeAdvertisedShapes` advertises `mcp:tool_call` and
  the `code:*` family (`code:analysis_context`, `code:cochange_prediction`, `code:impact_analysis`,
  `code:git_change_assignment`).

## C8 — Proxy and TLS in the vessel role

**Requirement.**
- Trust the OS trust store.
- Honour `HTTP_PROXY` / `HTTPS_PROXY` and `NO_PROXY`, with `127.0.0.1` and `localhost` added to
  `NO_PROXY` automatically so local substrate traffic never goes through a corporate proxy.
- Report an intercepted TLS connection as `TLS_INTERCEPTED`, with the diagnostics to act on it.

**Status: partially met.**
- Met — `src/tls-trust.ts@installSystemTrustStoreSync` merges the OS trust store into Node's roots
  and the global fetch dispatcher; `src/tls-error.ts@translateTlsError` reports interception as
  `TLS_INTERCEPTED`.
- Not yet met — `127.0.0.1` and `localhost` are not added to `NO_PROXY`. With an undici that has
  `EnvHttpProxyAgent`, `NO_PROXY` is honoured as the operator set it; with an older undici the
  fallback resolves one proxy for `ide.metabob.com` and sends every host through it, ignoring
  `NO_PROXY`.

## C9 — Fail visibly

**Requirement.**
- "Advertised endpoint not reachable" and states like it are reported in `/health` and in `doctor`,
  never dropped silently.
- A vessel stops heartbeating a row it cannot show to be reachable. Discovery removes a row only when
  its 5-minute TTL lapses or on an explicit `DELETE /vessels/:vesselId`, never for being undialable,
  so an unreachable row the vessel keeps refreshing stays in the registry.

**Status: not yet met.** `src/vessel-heartbeat.ts@VesselHeartbeat` re-registers on its interval
(half the TTL, 150 s by default) with no reachability check, and
`src/presence-advertiser.ts@startPresenceAdvertiser` re-registers every 30 s whenever the shape-set
changes. `/health` reports only the circuit-breaker state, and the vessel never deletes its row.

## C10 — One registrant per key and workspace

**Requirement.** For one key and one workspace there is one registrant: the instance that holds the
bind registers, and the others run client-only. Rows are never per session.

**Status: met.** `src/vessel-identity.ts@resolveVesselId` derives the vessel id from the key and the
workspace, so every session of the same workspace writes the same row. Registration requires an
explicit `HEALTH_PORT`; a second instance on that port fails to bind and, by the C2 bind gate, stays
client-only.

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

**Status: not yet met.**
- The substrate tools call concept-db, goal-host-vessel and activity-api over direct REST (see
  [SPEC.md](SPEC.md) § Substrate goal tools and § Concept graph tools); discovery locates some of
  them but is not the path the calls take.
- `src/tools/run-goal.ts@RESOLVE_TIMEOUT_MS` holds a synchronous goal resolve for up to 290 s, and
  the agent-resolver registration advertises a 300 s resolve timeout (`src/index.ts@main`).
- Inbound is offered whenever C2's gates pass, with no outside-vantage probe.
