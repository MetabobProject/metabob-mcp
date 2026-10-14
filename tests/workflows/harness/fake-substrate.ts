/**
 * An in-process fake of the substrate the MCP server talks to: discovery,
 * identity, goal-host, activity-api and concept-db, each a Bun.serve on
 * 127.0.0.1 with an OS-assigned port (or a chosen one, for scenarios whose
 * arithmetic depends on it).
 *
 * Every operation is ONE handler keyed by operation name (`OPERATIONS`). The
 * HTTP surface the server calls is a separate routing table (`ROUTES`) that
 * maps (service, method, path) — or, for the impulse resolvers, `pointer.type`
 * — to an operation name, with the adapter that turns the shape's pointer into
 * the operation's input and its result into the producer's envelope. A server
 * that reaches the same operation by another route needs only a routing entry;
 * the operations, their state and every scenario stay as they are.
 *
 * Discovery `POST /resolve` behaves as discovery-vessel's does: its own shapes
 * (`vesselCapability`, `vesselRegistry`, …) it answers itself; any other shape
 * it forwards as `{ impulse: { pointer } }`, with the caller's Authorization,
 * to the service that owns it (`shapeOwners`), and returns that producer's
 * status and body; a shape nobody owns is `404 { error: "Not found", shape }`.
 *
 * Every request is recorded, matched or not, so scenarios can assert both what
 * was called and what never was (`/register`, workspace content). A request
 * discovery forwarded is recorded on the producer with `forwarded: true`.
 */

export type Service = 'discovery' | 'identity' | 'goalHost' | 'activity' | 'conceptDb';

const SERVICES: readonly Service[] = ['discovery', 'identity', 'goalHost', 'activity', 'conceptDb'];

export interface RecordedRequest {
  service: Service;
  method: string;
  path: string;
  query: Record<string, string>;
  /** The operation the request was routed to, or null when nothing matched. */
  operation: string | null;
  /**
   * The operation's input: the parsed body, or for a shape route the input its
   * adapter built from the pointer. `rawBody` is always what was sent.
   */
  body: unknown;
  rawBody: string;
  status: number;
  /** True when discovery forwarded this request to the producer. */
  forwarded: boolean;
}

export interface OpRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
  headers: Headers;
}

export interface OpResult {
  status?: number;
  body?: unknown;
  /** Answer with this HTML instead of JSON (a captive portal / block page). */
  html?: string;
}

/** A scripted dispatch: each `goalWalkState` read returns the next frame; the last one repeats. */
export interface ScriptedDispatch {
  goal?: string;
  frames: Array<Record<string, unknown>>;
}

export interface Concept {
  id: string;
  summary: string | null;
  content: string;
  shape: string;
  source_type: string;
  created_at: string;
  updated_at: string;
  times_loaded: number;
  times_succeeded: number;
  times_failed: number;
}

export interface SubstrateState {
  /** Dispatches by id, created by `goalDispatchAsync` from `nextDispatches`. */
  dispatches: Map<string, { script: ScriptedDispatch; reads: number; body: any }>;
  /** Scripts consumed in order by successive `goalDispatchAsync` calls. */
  nextDispatches: ScriptedDispatch[];
  /** Durable execution traces by execution id; absent → 404. */
  traces: Map<string, Record<string, unknown>>;
  /** Oracle-corpus labels written by `goalVerificationLabelWrite`. */
  labels: Array<Record<string, unknown>>;
  concepts: Concept[];
  usage: Array<{ conceptId: string; outcome: string; trace_id?: string }>;
  edges: Array<{ id: string; from: string; to: string; edge_type: string }>;
  registrations: unknown[];
  solicitationResponses: unknown[];
}

type Handler = (state: SubstrateState, req: OpRequest, fake: FakeSubstrate) => OpResult | Promise<OpResult>;

let seq = 0;
const nextId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;

/** One handler per substrate operation, independent of how it is reached. */
export const OPERATIONS: Record<string, Handler> = {
  // ── discovery ─────────────────────────────────────────────────────────────
  vesselCapability(_s, req, fake) {
    const shape = String(req.body?.pointer?.shape ?? '');
    const owner = fake.shapeOwners[shape];
    if (!owner) return { body: { content: { shape, found: false, vessels: [] } } };
    const vessel = {
      vesselId: `fake-${owner}`,
      vesselName: `fake-${owner}`,
      endpoint: fake.url(owner),
      protocol: 'http',
      confidence: 1,
      lastSeen: new Date().toISOString(),
      resolve_endpoint: RESOLVE_PATHS[owner],
      auth_scheme: 'ApiKey',
    };
    return { body: { content: { shape, found: true, vessels: [vessel] } } };
  },
  /** Every registered vessel with the shapes it advertises: one fake vessel per owning service. */
  vesselRegistry(_s, _req, fake) {
    const byOwner = new Map<Service, string[]>();
    for (const [shape, owner] of Object.entries(fake.shapeOwners)) {
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), shape]);
    }
    const vessels = [...byOwner.entries()].map(([owner, shapes]) => ({
      vesselId: `fake-${owner}`,
      vesselName: `fake-${owner}`,
      shapes,
      endpoint: fake.url(owner),
      protocol: 'http',
      resolve_endpoint: RESOLVE_PATHS[owner],
      status: 'healthy',
      lastSeen: new Date().toISOString(),
    }));
    return { body: { content: { vessels, totalCount: vessels.length } } };
  },
  bootstrap(_s, _req, fake) {
    if (fake.bootstrapHtml) {
      return { html: '<!doctype html><html><body>Sign in to continue</body></html>' };
    }
    return {
      body: {
        relay_multiaddrs: [],
        // Empty strings mean absent, as on a live substrate.
        identity_endpoint: fake.bootstrapIdentity ?? fake.url('identity'),
        discovery_endpoint: '',
        prefer_transport: 'libp2p',
      },
    };
  },
  register(s, req) {
    s.registrations.push(req.body);
    return { body: { registered: true } };
  },

  // ── identity ──────────────────────────────────────────────────────────────
  identityHealth() {
    return { body: { status: 'ok', service: 'identity-vessel' } };
  },
  /** The org check: the flat header form, as identity-vessel answers it. */
  authResolve(_s, req, fake) {
    const auth = req.headers.get('authorization') ?? '';
    const key = auth.startsWith('ApiKey ') ? auth.slice('ApiKey '.length) : '';
    if (!fake.validKeys.has(key)) {
      return { status: 401, body: { valid: false, error: 'Invalid API key' } };
    }
    return {
      body: { valid: true, org_id: fake.orgId, user_id: 'user_fake', key_id: 'key_fake', role: 'member' },
    };
  },

  // ── goal-host ─────────────────────────────────────────────────────────────
  goalDispatchAsync(s, req) {
    const script = s.nextDispatches.shift();
    if (!script) return { status: 503, body: { error: 'fake goal-host: no dispatch scripted' } };
    const dispatchId = nextId('dispatch_');
    s.dispatches.set(dispatchId, { script: { goal: req.body?.goal, ...script }, reads: 0, body: req.body });
    return { status: 202, body: { dispatchId, status: 'running' } };
  },
  goalWalkState(s, req) {
    const d = s.dispatches.get(req.params.id ?? '');
    if (!d) return { status: 404, body: { error: 'dispatch not found' } };
    const frame = d.script.frames[Math.min(d.reads, d.script.frames.length - 1)] ?? {};
    d.reads++;
    return { body: { dispatchId: req.params.id, goal: d.script.goal, operator: d.body?.operator, ...frame } };
  },
  solicitationResponseWrite(s, req) {
    s.solicitationResponses.push(req.body);
    return { body: { resolved: true } };
  },

  // ── activity-api ──────────────────────────────────────────────────────────
  health() {
    return { body: { status: 'healthy' } };
  },
  executionTrace(s, req) {
    const trace = s.traces.get(req.params.id ?? '');
    return trace ? { body: trace } : { status: 404, body: { error: 'trace not found' } };
  },
  goalVerificationLabelWrite(s, req) {
    const id = nextId('label_');
    s.labels.push({ id, ...req.body?.impulse?.pointer });
    return { body: { success: true, content: JSON.stringify({ id }) } };
  },
  mcpAnalysisRun() {
    return { body: { status: 'accepted', results: [] } };
  },
  mcpEvents() {
    return { body: { accepted: true } };
  },

  // ── concept-db ────────────────────────────────────────────────────────────
  conceptCreate(s, req) {
    const now = new Date().toISOString();
    const c: Concept = {
      id: nextId('concept_'),
      summary: req.body?.summary ?? null,
      content: String(req.body?.content ?? ''),
      shape: String(req.body?.shape ?? ''),
      source_type: String(req.body?.source_type ?? ''),
      created_at: now,
      updated_at: now,
      times_loaded: 0,
      times_succeeded: 0,
      times_failed: 0,
    };
    s.concepts.push(c);
    return { status: 201, body: c };
  },
  conceptSearch(s, req) {
    const { shape, source_type: sourceType, query } = req.query;
    const limit = Number(req.query.limit ?? 10);
    const offset = Number(req.query.offset ?? 0);
    let rows = s.concepts.filter(c =>
      (!shape || c.shape === shape) &&
      (!sourceType || c.source_type === sourceType) &&
      (!query || `${c.summary}\n${c.content}`.toLowerCase().includes(query.toLowerCase())));
    rows = [...rows].reverse();
    return { body: { concepts: rows.slice(offset, offset + limit), total: rows.length } };
  },
  conceptGet(s, req) {
    const id = (req.params.id ?? '').replace(/^concept:/, '');
    const c = s.concepts.find(x => x.id === id);
    return c ? { body: c } : { status: 404, body: { error: 'concept not found' } };
  },
  conceptUsage(s, req) {
    const id = (req.params.id ?? '').replace(/^concept:/, '');
    const c = s.concepts.find(x => x.id === id);
    if (!c) return { status: 404, body: { error: 'concept not found' } };
    const outcome = String(req.body?.outcome ?? 'neutral');
    c.times_loaded++;
    if (outcome === 'success') c.times_succeeded++;
    if (outcome === 'failure') c.times_failed++;
    s.usage.push({ conceptId: id, outcome, trace_id: req.body?.trace_id });
    return { body: { ok: true } };
  },
  conceptLink(s, req) {
    const from = (req.params.id ?? '').replace(/^concept:/, '');
    const to = String(req.body?.to_concept_id ?? '').replace(/^concept:/, '');
    if (!s.concepts.some(c => c.id === from) || !s.concepts.some(c => c.id === to)) {
      return { status: 404, body: { error: 'concept not found' } };
    }
    const edge = { id: nextId('edge_'), from, to, edge_type: String(req.body?.edge_type ?? '') };
    s.edges.push(edge);
    return { status: 201, body: { ...edge, weight: req.body?.weight ?? 0.5, created_at: new Date().toISOString() } };
  },
};

/** Where each producer serves impulse resolves, as it advertises to discovery. */
const RESOLVE_PATHS: Record<Service, string> = {
  discovery: '/resolve',
  identity: '/v1/impulses/resolve',
  goalHost: '/resolve',
  activity: '/v2/impulses/resolve',
  conceptDb: '/v2/impulses/resolve',
};

/** The shapes discovery answers itself instead of forwarding (discovery-vessel DISCOVERY_SHAPES). */
const DISCOVERY_SHAPES = new Set(['vesselCapability', 'vesselEndpoint', 'vesselHealth', 'vesselRegistry']);

/**
 * How a shape reaches an operation on its producer: the operation, the input
 * built from the pointer (default: the request body as sent), and the
 * producer's response envelope built from the operation's result (default:
 * the result as is).
 */
interface ShapeRoute {
  operation: string;
  request?: (pointer: any, req: OpRequest) => Partial<Pick<OpRequest, 'params' | 'query' | 'body'>>;
  response?: (result: OpResult, pointer: any, fake: FakeSubstrate) => OpResult;
}

interface Route {
  service: Service;
  method: string;
  /** Path pattern; `:name` segments become params. */
  path: string;
  /** An operation name, a function choosing one (impulse resolvers), or shape routes by pointer.type. */
  operation: string | ((req: OpRequest) => string | null) | Record<string, ShapeRoute>;
}

/** How the server under test reaches each operation today. */
export const ROUTES: Route[] = [
  // Discovery answers its own shapes; any other shape is forwarded (see FakeSubstrate.discoveryResolve).
  {
    service: 'discovery', method: 'POST', path: '/resolve', operation: {
      vesselCapability: { operation: 'vesselCapability' },
      vesselRegistry: { operation: 'vesselRegistry' },
    },
  },
  { service: 'discovery', method: 'GET', path: '/bootstrap', operation: 'bootstrap' },
  { service: 'discovery', method: 'POST', path: '/register', operation: 'register' },

  { service: 'identity', method: 'GET', path: '/health', operation: 'identityHealth' },
  { service: 'identity', method: 'POST', path: '/v1/auth/resolve', operation: 'authResolve' },

  {
    service: 'goalHost', method: 'POST', path: '/resolve', operation: {
      // goal-host reads the dispatch fields off the pointer, as POST /run-goal reads its body.
      goalDispatchAsync: { operation: 'goalDispatchAsync', request: (p) => ({ body: p }) },
      // goal-host wraps the dispatch record: { resolved, shape, body }, or 404 { resolved:false }.
      goalWalkState: {
        operation: 'goalWalkState',
        request: (p) => ({ params: { id: String(p.dispatchId ?? '') }, body: p }),
        response: (r) => (r.status ?? 200) === 200
          ? { body: { resolved: true, shape: 'goalWalkState', body: r.body } }
          : { status: r.status, body: { resolved: false, shape: 'goalWalkState', error: 'dispatch not found' } },
      },
      solicitationResponse_write: { operation: 'solicitationResponseWrite' },
    },
  },

  { service: 'activity', method: 'GET', path: '/health', operation: 'health' },
  {
    service: 'activity', method: 'POST', path: '/v2/impulses/resolve', operation: {
      goal_verification_label_write: { operation: 'goalVerificationLabelWrite' },
      // activity-api's resolver answers { success, content: <the trace row as JSON> }, or 404.
      activityExecutionTrace: {
        operation: 'executionTrace',
        request: (p) => ({ params: { id: String(p.executionId ?? '') }, body: p }),
        response: (r, p) => (r.status ?? 200) === 200
          ? { body: { success: true, content: JSON.stringify(r.body) } }
          : { status: r.status, body: { success: false, error: `Execution trace not found: ${p.executionId}` } },
      },
    },
  },
  { service: 'activity', method: 'POST', path: '/v2/mcp/analysis/run', operation: 'mcpAnalysisRun' },
  { service: 'activity', method: 'POST', path: '/v2/events/mcp', operation: 'mcpEvents' },

  {
    service: 'conceptDb', method: 'POST', path: '/v2/impulses/resolve', operation: {
      // concept-db answers reads as { content, metadata }.
      conceptSearch: {
        operation: 'conceptSearch',
        request: (p) => ({
          query: Object.fromEntries(
            ['query', 'shape', 'source_type', 'limit'].filter(k => p[k] !== undefined).map(k => [k, String(p[k])]),
          ),
          body: p,
        }),
        response: (r) => {
          const rows = (r.body as any)?.concepts ?? [];
          return { body: { content: rows, metadata: { shape: 'conceptSearch', count: rows.length } } };
        },
      },
      // The root is the row GET /concepts/:id returns; edges pair each edge with its neighbour row.
      conceptGraph: {
        operation: 'conceptGet',
        request: (p) => ({ params: { id: String(p.concept_id ?? '') }, body: p }),
        response: (r, p, fake) => {
          if ((r.status ?? 200) !== 200) return { status: 404, body: { error: `Concept not found: ${p.concept_id}` } };
          const id = String(p.concept_id ?? '').replace(/^concept:/, '');
          const direction = String(p.direction ?? 'both');
          const edges = fake.state.edges
            .filter(e => (direction !== 'incoming' && e.from === id) || (direction !== 'outgoing' && e.to === id))
            .slice(0, Number(p.limit ?? 25))
            .map(e => ({
              edge: { id: e.id, edge_type: e.edge_type, weight: 0.5, times_traversed: 0 },
              neighbor: fake.state.concepts.find(c => c.id === (e.from === id ? e.to : e.from)) ?? {},
            }));
          return { body: { content: { root: r.body, edges }, metadata: { shape: 'conceptGraph', root_id: p.concept_id } } };
        },
      },
      // Writes answer { success, content: <result as JSON> }, or 400 { success:false, error }.
      concept_create_write: {
        operation: 'conceptCreate',
        request: (p) => ({ body: p.conceptData }),
        response: (r) => (r.status ?? 200) < 300
          ? { body: { success: true, content: JSON.stringify(r.body), metadata: { shape: 'concept_create_write_result' } } }
          : { status: 400, body: { success: false, error: (r.body as any)?.error } },
      },
      conceptLink_write: {
        operation: 'conceptLink',
        request: (p) => ({ params: { id: String(p.linkData?.from_concept_id ?? '') }, body: p.linkData }),
        response: (r) => {
          if ((r.status ?? 200) >= 300) return { status: 400, body: { success: false, error: (r.body as any)?.error } };
          const edge = r.body as any;
          return { body: { success: true, content: JSON.stringify({ id: edge.id, created: true, new_weight: edge.weight }) } };
        },
      },
      conceptUsage_write: {
        operation: 'conceptUsage',
        request: (p) => ({ params: { id: String(p.usageData?.concept_id ?? '') }, body: p.usageData }),
        response: (r, p) => (r.status ?? 200) < 300
          ? { body: { success: true, content: JSON.stringify({ id: `usage_${p.usageData?.trace_id}`, outcome: p.usageData?.outcome }) } }
          : { status: 400, body: { success: false, error: `concept not found: ${p.usageData?.concept_id} — usage row refused` } },
      },
    },
  },
];

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/');
  const a = path.split('/');
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(a[i]!);
    else if (seg !== a[i]) return null;
  }
  return params;
}

function emptyState(): SubstrateState {
  return {
    dispatches: new Map(),
    nextDispatches: [],
    traces: new Map(),
    labels: [],
    concepts: [],
    usage: [],
    edges: [],
    registrations: [],
    solicitationResponses: [],
  };
}

const FORWARDED_HEADER = 'x-fake-forwarded-by';

export class FakeSubstrate {
  state: SubstrateState = emptyState();
  readonly requests: RecordedRequest[] = [];
  /** Which service owns (produces) each shape: discovery forwards it there, `vesselCapability` reports it. */
  readonly shapeOwners: Record<string, Service> = {
    goal_execution: 'goalHost',
    conceptGraph: 'conceptDb',
    conceptSearch: 'conceptDb',
    concept_create_write: 'conceptDb',
    conceptLink_write: 'conceptDb',
    conceptUsage_write: 'conceptDb',
    activityExecutionTrace: 'activity',
    goal_verification_label_write: 'activity',
    goalDispatchAsync: 'goalHost',
    goalWalkState: 'goalHost',
    solicitationResponse_write: 'goalHost',
  };
  /** Keys identity accepts; any other key is a foreign one (401). */
  readonly validKeys = new Set(['mb_test_workflow_key']);
  readonly orgId = 'org_fake_substrate';
  /** The identity_endpoint /bootstrap advertises; unset → the fake identity's URL. */
  bootstrapIdentity: string | undefined;
  /** When true, /bootstrap answers with an HTML page. */
  bootstrapHtml = false;
  private servers = new Map<Service, ReturnType<typeof Bun.serve>>();

  /** Start every service; `ports` pins a service to a port (0 or absent → OS-assigned). */
  static async start(options: { ports?: Partial<Record<Service, number>> } = {}): Promise<FakeSubstrate> {
    const fake = new FakeSubstrate();
    for (const service of SERVICES) {
      fake.servers.set(service, Bun.serve({
        hostname: '127.0.0.1',
        port: options.ports?.[service] ?? 0,
        fetch: (req) => fake.handle(service, req),
      }));
    }
    return fake;
  }

  url(service: Service): string {
    const server = this.servers.get(service);
    if (!server) throw new Error(`fake substrate: ${service} is not running`);
    return `http://127.0.0.1:${server.port}`;
  }

  /** Environment pointing a server under test at this fake, and nowhere else. */
  env(): Record<string, string> {
    return {
      METABOB_ENDPOINT: this.url('activity'),
      // A METABOB_ENDPOINT outside the local port convention derives no
      // siblings, so discovery is given explicitly, as for a remote substrate.
      DISCOVERY_ENDPOINT: this.url('discovery'),
    };
  }

  requestsFor(operation: string): RecordedRequest[] {
    return this.requests.filter(r => r.operation === operation);
  }

  /** Forget substrate state (dispatches, traces, concepts…); the request log is kept. */
  resetState(): void {
    this.state = emptyState();
  }

  async stop(): Promise<void> {
    for (const server of this.servers.values()) server.stop(true);
    this.servers.clear();
  }

  /**
   * Discovery's forward of a shape it does not answer itself, as discovery-vessel
   * does it: to the owning producer's resolve endpoint, as `{ impulse: { pointer } }`,
   * with the caller's Authorization; the producer's status and body come back as is.
   */
  private async discoveryResolve(pointer: any, headers: Headers): Promise<OpResult> {
    const shape = String(pointer?.type ?? '');
    const owner = this.shapeOwners[shape];
    if (!owner) return { status: 404, body: { error: 'Not found', shape } };
    try {
      const res = await fetch(`${this.url(owner)}${RESOLVE_PATHS[owner]}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [FORWARDED_HEADER]: 'discovery',
          ...(headers.get('authorization') ? { Authorization: headers.get('authorization')! } : {}),
        },
        body: JSON.stringify({ impulse: { pointer } }),
      });
      return { status: res.status, body: await res.json() };
    } catch (err) {
      return { status: 502, body: { error: 'forward_failed', shape, detail: (err as Error).message } };
    }
  }

  private async handle(service: Service, req: Request): Promise<Response> {
    const url = new URL(req.url);
    const rawBody = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
    let body: unknown = rawBody;
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      // keep the raw text
    }
    const query = Object.fromEntries(url.searchParams.entries());
    const record: RecordedRequest = {
      service, method: req.method, path: url.pathname, query, operation: null, body, rawBody, status: 404,
      forwarded: req.headers.get(FORWARDED_HEADER) === 'discovery',
    };
    this.requests.push(record);

    const respond = (result: OpResult): Response => {
      record.status = result.status ?? 200;
      if (result.html !== undefined) {
        return new Response(result.html, { status: record.status, headers: { 'content-type': 'text/html' } });
      }
      return Response.json(result.body ?? {}, { status: record.status });
    };

    for (const route of ROUTES) {
      if (route.service !== service || route.method !== req.method) continue;
      const params = matchPath(route.path, url.pathname);
      if (!params) continue;
      const opReq: OpRequest = { params, query, body, headers: req.headers };

      if (typeof route.operation === 'object') {
        const pointer = (body as any)?.impulse?.pointer ?? (body as any)?.pointer;
        const type = typeof pointer?.type === 'string' ? pointer.type : '';
        const shapeRoute = route.operation[type];
        if (!shapeRoute) {
          if (service === 'discovery' && type && !DISCOVERY_SHAPES.has(type)) {
            record.operation = 'discoveryResolve';
            return respond(await this.discoveryResolve(pointer, req.headers));
          }
          continue;
        }
        const handler = OPERATIONS[shapeRoute.operation];
        if (!handler) continue;
        const adapted: OpRequest = { ...opReq, ...(shapeRoute.request?.(pointer, opReq) ?? {}) };
        record.operation = shapeRoute.operation;
        record.body = adapted.body;
        const result = await handler(this.state, adapted, this);
        return respond(shapeRoute.response ? shapeRoute.response(result, pointer, this) : result);
      }

      const operation = typeof route.operation === 'string' ? route.operation : route.operation(opReq);
      if (!operation) continue;
      const handler = OPERATIONS[operation];
      if (!handler) continue;
      record.operation = operation;
      return respond(await handler(this.state, opReq, this));
    }
    return Response.json({ error: `fake substrate: no operation for ${service} ${req.method} ${url.pathname}` }, { status: 404 });
  }
}
