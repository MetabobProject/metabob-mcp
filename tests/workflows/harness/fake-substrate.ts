/**
 * An in-process fake of the substrate the MCP server talks to: discovery,
 * goal-host, activity-api (which also stands in for the analysis endpoint) and
 * concept-db, each a Bun.serve on 127.0.0.1 with an OS-assigned port.
 *
 * Every operation is ONE handler keyed by operation name (`OPERATIONS`). The
 * HTTP surface the server calls is a separate routing table (`ROUTES`) that
 * maps (service, method, path) — or, for the impulse resolvers, `pointer.type`
 * — to an operation name. A server that reaches the same operation by another
 * route (discovery `POST /resolve` by shape, say) needs only a new routing
 * entry; the operations, their state and every scenario stay as they are.
 *
 * Every request is recorded, matched or not, so scenarios can assert both what
 * was called and what never was (`/register`, workspace content).
 */

export type Service = 'discovery' | 'goalHost' | 'activity' | 'conceptDb';

export interface RecordedRequest {
  service: Service;
  method: string;
  path: string;
  query: Record<string, string>;
  /** The operation the request was routed to, or null when nothing matched. */
  operation: string | null;
  body: unknown;
  rawBody: string;
  status: number;
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
      resolve_endpoint: '/resolve',
      auth_scheme: 'ApiKey',
    };
    return { body: { content: { shape, found: true, vessels: [vessel] } } };
  },
  bootstrap(_s, _req, fake) {
    return {
      body: {
        relay_multiaddrs: [],
        identity_endpoint: null,
        discovery_endpoint: fake.url('discovery'),
        prefer_transport: 'http',
      },
    };
  },
  register(s, req) {
    s.registrations.push(req.body);
    return { body: { registered: true } };
  },
  registryShapes(_s, _req, fake) {
    return { body: { shapes: Object.keys(fake.shapeOwners).map(shape => ({ shape })) } };
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

interface Route {
  service: Service;
  method: string;
  /** Path pattern; `:name` segments become params. */
  path: string;
  /** An operation name, or a function choosing one from the request (impulse resolvers). */
  operation: string | ((req: OpRequest) => string | null);
}

/** Impulse envelopes carry the operation in `pointer.type`. */
const byPointerType = (map: Record<string, string>) => (req: OpRequest): string | null => {
  const type = req.body?.impulse?.pointer?.type ?? req.body?.pointer?.type;
  return typeof type === 'string' ? map[type] ?? null : null;
};

/** How the server under test reaches each operation today. */
export const ROUTES: Route[] = [
  { service: 'discovery', method: 'POST', path: '/resolve', operation: byPointerType({ vesselCapability: 'vesselCapability' }) },
  { service: 'discovery', method: 'GET', path: '/bootstrap', operation: 'bootstrap' },
  { service: 'discovery', method: 'POST', path: '/register', operation: 'register' },
  { service: 'discovery', method: 'GET', path: '/registry/shapes', operation: 'registryShapes' },

  { service: 'goalHost', method: 'POST', path: '/run-goal', operation: 'goalDispatchAsync' },
  { service: 'goalHost', method: 'GET', path: '/executions/:id', operation: 'goalWalkState' },
  { service: 'goalHost', method: 'POST', path: '/resolve', operation: byPointerType({ solicitationResponse_write: 'solicitationResponseWrite' }) },

  { service: 'activity', method: 'GET', path: '/health', operation: 'health' },
  { service: 'activity', method: 'GET', path: '/v2/activities/execution-traces/:id', operation: 'executionTrace' },
  { service: 'activity', method: 'POST', path: '/v2/impulses/resolve', operation: byPointerType({ goal_verification_label_write: 'goalVerificationLabelWrite' }) },
  { service: 'activity', method: 'POST', path: '/v2/mcp/analysis/run', operation: 'mcpAnalysisRun' },
  { service: 'activity', method: 'POST', path: '/v2/events/mcp', operation: 'mcpEvents' },

  { service: 'conceptDb', method: 'POST', path: '/concepts', operation: 'conceptCreate' },
  { service: 'conceptDb', method: 'GET', path: '/concepts/search', operation: 'conceptSearch' },
  { service: 'conceptDb', method: 'GET', path: '/concepts/:id', operation: 'conceptGet' },
  { service: 'conceptDb', method: 'POST', path: '/concepts/:id/usage', operation: 'conceptUsage' },
  { service: 'conceptDb', method: 'POST', path: '/concepts/:id/link', operation: 'conceptLink' },
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

export class FakeSubstrate {
  state: SubstrateState = emptyState();
  readonly requests: RecordedRequest[] = [];
  /** Which service owns a shape for discovery's `vesselCapability` lookups. */
  readonly shapeOwners: Record<string, Service> = {
    goal_execution: 'goalHost',
    conceptGraph: 'conceptDb',
  };
  private servers = new Map<Service, ReturnType<typeof Bun.serve>>();

  static async start(): Promise<FakeSubstrate> {
    const fake = new FakeSubstrate();
    for (const service of ['discovery', 'goalHost', 'activity', 'conceptDb'] as const) {
      fake.servers.set(service, Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
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
      DISCOVERY_ENDPOINT: this.url('discovery'),
      // A METABOB_ENDPOINT outside the local port convention derives no
      // siblings, and the analysis base would otherwise default to the public
      // gateway. Pin it here so nothing leaves the machine.
      ANALYSIS_API_URL: this.url('activity'),
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
    };
    this.requests.push(record);

    for (const route of ROUTES) {
      if (route.service !== service || route.method !== req.method) continue;
      const params = matchPath(route.path, url.pathname);
      if (!params) continue;
      const opReq: OpRequest = { params, query, body, headers: req.headers };
      const operation = typeof route.operation === 'string' ? route.operation : route.operation(opReq);
      if (!operation) continue;
      const handler = OPERATIONS[operation];
      if (!handler) continue;
      record.operation = operation;
      const result = await handler(this.state, opReq, this);
      record.status = result.status ?? 200;
      return Response.json(result.body ?? {}, { status: record.status });
    }
    return Response.json({ error: `fake substrate: no operation for ${service} ${req.method} ${url.pathname}` }, { status: 404 });
  }
}
