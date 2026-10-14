/**
 * The attachment: one anchor {discovery, key} → GET /bootstrap → identity →
 * POST /v1/auth/resolve → orgId. The key is proven against the substrate's own
 * identity before any other keyed call, and the outcome is one small typed
 * state, reported by /health and doctor (SPEC §attachment, CONFORMANCE §c3-identity,
 * CONFORMANCE §c4-anchoring, CONFORMANCE §c9-fail-visibly).
 *
 * attach() runs once at startup and never blocks it: local tools work at once,
 * and a keyed call waits for the attachment to settle (bounded by the timeouts
 * below), then either proceeds or refuses with the one named cause.
 *
 * Node-safe: doctor runs under Node, so nothing here imports a Bun-only module.
 */

import { resolveTenant, type AuthService, type TenantResolution } from './auth-service.js';
import {
  causeOfLine,
  classifyNetError,
  lastConnection,
  netFetch,
  proxySummary,
  selectProxy,
  redactUrl,
  type NetCauseKind,
  type NetInit,
  type ProxySummary,
} from './net.js';
import { describeOsProxy, detectOsProxy, type OsProxySettings } from './os-proxy.js';

// ── Named causes ─────────────────────────────────────────────────────────────

export type AttachCause =
  | 'not_configured'
  | 'anchor_unreachable'
  | 'blocked_by_portal'
  | 'identity_unreachable'
  | 'key_rejected';

export type AnchorSource = 'explicit' | 'derived-h1' | 'none';

/** The last outcome of one family of calls: the attachment itself, or one producer family. */
export interface FamilyOutcome {
  ok: boolean;
  /** The named cause, e.g. `connect_timeout` or `no_producer`; null when ok. */
  cause: string | null;
  /** The one line reported for it; null when ok. */
  line: string | null;
  shape?: string;
  at: string;
}

// @anchor network-diagnosis
/**
 * What the network did, next to the attachment state: the proxy configuration
 * (credentials redacted), how the anchor is reached, the named network cause of
 * a failed attachment, the TLS issuer seen, and the last outcome per family.
 * CONFORMANCE §c9-fail-visibly
 */
export interface NetworkDiagnosis {
  proxy: ProxySummary;
  /** How a request to the anchor travels: through which proxy (redacted), or direct and why. */
  anchorRoute: { via: string | null; bypass: string | null } | null;
  /** The network-level cause of a failed attachment (e.g. `tls_intercepted`), or null. */
  cause: NetCauseKind | null;
  causeLine: string | null;
  /** The anchor's TLS, when it is https: verified, or intercepted and by which issuer. */
  tls: { host: string; authorized: boolean; issuer: string | null } | null;
  /** OS proxy settings the process does not see, named when a direct connection failed. */
  osProxy: string | null;
  /** The last outcome per family: `attachment`, `discovery`, `trace`, `concept`, `goal`, `other`. */
  lastByFamily: Record<string, FamilyOutcome>;
}
export type IdentitySource = 'explicit' | 'bootstrap' | 'rehosted-h1' | 'none';

export interface AttachmentState {
  /** The anchor: the discovery URL and how it was obtained. */
  anchor: { discovery: string | null; source: AnchorSource };
  /** GET {discovery}/bootstrap: ok, unreachable, not_substrate (non-JSON / HTML), or skipped (no anchor). */
  bootstrap: {
    status: 'pending' | 'ok' | 'unreachable' | 'not_substrate' | 'skipped';
    /** The identity_endpoint /bootstrap advertised ("" and absent are both null). */
    identityEndpoint?: string | null;
    detail?: string;
  };
  /**
   * The identity endpoint the key is proven against, and how it was chosen.
   * `advertised` is what /bootstrap said; `tried` is every address actually
   * contacted, in order — each at most once.
   */
  identity: { endpoint: string | null; source: IdentitySource; advertised: string | null; tried: string[] };
  /** The org check: POST {identity}/v1/auth/resolve with the key. */
  auth: {
    status: 'pending' | 'authenticated' | 'key_rejected' | 'identity_unreachable' | 'not_configured';
    orgId?: string;
    keyId?: string;
    detail?: string;
  };
  /** Why keyed calls are refused, or null when they may proceed (or the attachment is still pending). */
  cause: AttachCause | null;
  /** The one-line refusal substrate tools return, or null. */
  message: string | null;
  /** The process makes no inbound offer (CONFORMANCE §c11-attachment-model). */
  advertised: 'none (client-only)';
  network: NetworkDiagnosis;
  startedAt: string;
  settledAt: string | null;
  /** The last org check, including the periodic key-issuance heartbeat. */
  lastCheckedAt: string | null;
}

export interface AttachOptions {
  /** The discovery URL — the anchor. */
  discovery?: string;
  /** How `discovery` was obtained (config.ts discoveryEndpointSource). */
  discoverySource?: AnchorSource;
  /** The substrate key — the one the tools send, and so the one proven. */
  key?: string;
  /** An explicit identity endpoint (IDENTITY_ENDPOINT / metabob.identityEndpoint). */
  identityOverride?: string;
  /** Logger for the one-time WARNs; defaults to stderr. */
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
  /**
   * Holds the resolved tenant for the process and runs the key-issuance
   * heartbeat against the chosen identity. Without one (doctor) the org check
   * runs once and nothing repeats.
   */
  authService?: AuthService;
  /** Key-issuance heartbeat interval; 0 disables it. */
  heartbeatMs?: number;
  /** The request path; default the one outbound path, src/net.ts, reading proxy and trust from `env`. */
  fetchImpl?: typeof fetch;
  /** Where proxy and trust settings are read; default process.env. */
  env?: NodeJS.ProcessEnv;
  /** OS proxy settings for a failure message; default src/os-proxy.ts@detect-os-proxy. */
  osProxy?: () => Promise<OsProxySettings | null>;
  /** The backoff sleep between read retries; injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface Attachment {
  state(): AttachmentState;
  /** Resolves once the attachment has settled (never rejects). */
  settled(): Promise<AttachmentState>;
  /** The one-line refusal for a keyed call, after the attachment settles; null when authenticated. */
  refusal(): Promise<string | null>;
  /**
   * Resolve a pointer through discovery `POST /resolve` with `Authorization: ApiKey` —
   * the one ingress every substrate call takes (CONFORMANCE §c11-attachment-model).
   * Answers the producer's status and body as discovery forwarded them. Throws
   * AttachmentRefusedError, naming the cause, when the attachment is not
   * authenticated, and ResolveError for discovery's own failures (no producer,
   * a producer cut at its timeout, an unreachable producer or anchor).
   */
  resolve(pointer: Record<string, unknown>, options?: ResolveOptions): Promise<ResolveResult>;
  /** The attachment's request path (src/net.ts by default), for the one direct read no shape serves. */
  fetch: typeof fetch;
  stop(): void;
}

export interface ResolveOptions {
  /**
   * The client-side cap for one request. Set just above discovery's cut for the
   * producer family, so the named timeout normally comes from discovery; never
   * above 60 s (RESOLVE_MAX_TIMEOUT_MS).
   */
  timeoutMs?: number;
  /**
   * A read: retried with bounded backoff when the producer is cut at its
   * timeout. A write is never retried — it may have landed.
   */
  read?: boolean;
}

/** One resolve as discovery answered it: the producer's HTTP status and JSON body. */
export interface ResolveResult<T = any> {
  status: number;
  body: T;
  elapsedMs: number;
}

export type ResolveFailure = 'no_producer' | 'producer_timeout' | 'producer_unreachable' | 'anchor_unreachable';

/** Discovery's own failure to resolve a shape, or the network's, as one named line. */
export class ResolveError extends Error {
  constructor(
    readonly kind: ResolveFailure,
    readonly shape: string,
    message: string,
    /** The network cause when the network produced no answer (src/net.ts@net-causes). */
    readonly netCause?: NetCauseKind,
  ) {
    super(message);
    this.name = 'ResolveError';
  }
}

/** The family a shape's producer belongs to, for the per-family outcome /health reports. */
export function shapeFamily(shape: string): 'discovery' | 'trace' | 'concept' | 'goal' | 'other' {
  if (/^vessel/.test(shape)) return 'discovery';
  if (/^concept/i.test(shape)) return 'concept';
  if (/^goal(?!_verification)|^solicitation/i.test(shape)) return 'goal';
  if (/trace|execution|goal_verification/i.test(shape)) return 'trace';
  return 'other';
}

export class AttachmentRefusedError extends Error {
  constructor(readonly attachCause: AttachCause, message: string) {
    super(message);
    this.name = 'AttachmentRefusedError';
  }
}

const BOOTSTRAP_TIMEOUT_MS = 5_000;
const DIAL_TIMEOUT_MS = 2_000;
const DEFAULT_HEARTBEAT_MS = 5 * 60_000;

// @anchor resolve-timeouts
// Client-side caps per producer family, each just above the producer's advertised
// resolve_timeout_ms — the cut discovery applies to its forward (activity-api 10 s,
// concept-db 30 s, goal-host 60 s) — so the named timeout normally comes from
// discovery. No request is held past 60 s. CONFORMANCE §c11-attachment-model
export const RESOLVE_TIMEOUT_MS = {
  discovery: 10_000,
  trace: 15_000,
  concept: 35_000,
  goal: 60_000,
} as const;
export const RESOLVE_MAX_TIMEOUT_MS = 60_000;
/** Backoff before each retry of a read cut at its producer's timeout. */
export const READ_RETRY_DELAYS_MS = [500, 1_500] as const;

function isTimeoutText(text: string): boolean {
  return /time(d)?\s*out|timeout|abort/i.test(text);
}

/**
 * The sentence after `no_producer(shape):`. Discovery's peer forward turns every
 * non-2xx answer from a peer's producer into the same `404 {error:"Not found",
 * shape}` discovery sends when it has no producer, so through a spoke the answer
 * cannot tell "nothing produces this" from "the producer refused this request"
 * or "the producer has no such item". The line says so rather than guess.
 * SPEC §attachment
 */
// @anchor no-producer-line
export const NO_PRODUCER_MEANING =
  'discovery found no producer for this shape, or, through a peer forward, the producer refused the request or has no such item; the forward does not say which';

/**
 * Discovery's own answers, told apart from a producer's: `404 {error:"Not found",
 * shape}` is "no producer for this shape" — or a peer forward's flattening of a
 * producer's refusal (NO_PRODUCER_MEANING); a producer's own 404 on this hop
 * always carries more or other fields — and `502 {error:"forward_failed", shape,
 * detail}` is its forward failing — cut at the producer's resolve_timeout_ms, or
 * unreachable. discovery-vessel src/index.ts, POST /resolve.
 */
export function classifyDiscoveryAnswer(
  shape: string,
  status: number,
  body: unknown,
  elapsedMs: number,
): ResolveError | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const keys = Object.keys(b).sort().join(',');
  if (status === 404 && b.error === 'Not found' && b.shape === shape && keys === 'error,shape') {
    return new ResolveError('no_producer', shape, `no_producer(${shape}): ${NO_PRODUCER_MEANING}`);
  }
  if (status === 502 && b.error === 'forward_failed') {
    const detail = typeof b.detail === 'string' ? b.detail : '';
    if (isTimeoutText(detail)) {
      return new ResolveError('producer_timeout', shape, `producer_timeout(${shape}, ${elapsedMs}ms): discovery cut the producer at its timeout`);
    }
    return new ResolveError('producer_unreachable', shape, `producer_unreachable(${shape})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
  }
  return null;
}

/**
 * One line for any resolve failure, for a tool's output. A tool that knows what
 * the ambiguous `no_producer` can mean for its own request passes `noProducer`,
 * which replaces the generic sentence (e.g. execution_trace: the trace may not
 * exist). The `no_producer(shape)` token is kept either way.
 */
export function describeResolveFailure(err: unknown, opts: { noProducer?: string } = {}): string {
  if (err instanceof ResolveError && err.kind === 'no_producer' && opts.noProducer) {
    return `no_producer(${err.shape}): ${opts.noProducer}`;
  }
  if (err instanceof ResolveError || err instanceof AttachmentRefusedError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

const LOCAL_TOOLS_NOTE = 'substrate tools are unavailable; local tools still work.';

function trimUrl(u: string): string {
  return u.trim().replace(/\/+$/, '');
}

function isLoopbackHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

/** A container-DNS name: one label, not an IP literal (`substrate-live`). */
function isSingleLabelHost(hostname: string): boolean {
  return hostname.length > 0 && !hostname.includes('.') && !hostname.includes(':') && !hostname.startsWith('[');
}

function looksLikeHtmlOrNonJson(contentType: string | null, text: string): boolean {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('text/html')) return true;
  const t = text.trimStart();
  if (t.startsWith('<')) return true;
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}

// CONFORMANCE §c4-anchoring
// @anchor rehost-h1
// H1-CLASS INTERIM DEBT — delete once the substrate installer writes a
// host-visible identity endpoint into the client config (or /bootstrap answers
// per vantage). A substrate's /bootstrap advertises its identity at the
// container-internal address (node1: http://127.0.0.1:8101; compose2:
// http://substrate-live:8101), which the host cannot dial. When that address is
// loopback or a single-label container name on an 8xxx port, it is mapped onto
// the discovery URL's host with the same published-port offset discovery has
// from its internal 8100: port + (discoveryPort − 8100). node1 → :18101,
// compose2 (discovery :26100) → :26101. A plain +10000 would send compose2's
// key to node1's identity. The heuristic only picks an address: the org check
// against it is what makes it trusted.
export function rehostH1Identity(advertised: string, discovery: string): string | null {
  let adv: URL;
  let disc: URL;
  try {
    adv = new URL(advertised);
    disc = new URL(discovery);
  } catch {
    return null;
  }
  if (!isLoopbackHost(adv.hostname) && !isSingleLabelHost(adv.hostname)) return null;
  const advPort = Number(adv.port);
  if (!adv.port || advPort < 8000 || advPort > 8999) return null;
  if (!disc.port) return null;
  const offset = Number(disc.port) - 8100;
  if (offset <= 0 || offset % 1000 !== 0) return null;
  const mapped = new URL(disc.toString());
  mapped.port = String(advPort + offset);
  mapped.pathname = '';
  mapped.search = '';
  mapped.hash = '';
  return trimUrl(mapped.toString());
}

/** One quick dial: any HTTP answer from GET /health means the address is dialable. */
async function dialable(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    await fetchImpl(`${url}/health`, {
      signal: AbortSignal.timeout(DIAL_TIMEOUT_MS + 500),
      net: { timeoutMs: DIAL_TIMEOUT_MS, connectTimeoutMs: DIAL_TIMEOUT_MS },
    } as NetInit);
    return true;
  } catch {
    return false;
  }
}

/** A direct connection failure that a proxy the process does not see would explain. */
const PROXY_SHAPED_FAILURES: ReadonlySet<string> = new Set(['connect_timeout', 'dns_failed', 'connect_refused']);

function osNote(state: AttachmentState): string {
  return state.network.osProxy ? ` — ${state.network.osProxy}` : '';
}

function refusalMessage(state: AttachmentState): string | null {
  const id = state.identity;
  switch (state.cause) {
    case null:
      return null;
    case 'not_configured':
      return `not_configured: ${state.auth.detail ?? 'the attachment is not configured'}; ${LOCAL_TOOLS_NOTE}`;
    case 'anchor_unreachable':
      return `anchor_unreachable: discovery ${state.anchor.discovery} did not answer GET /bootstrap — ${state.bootstrap.detail ?? 'no response'}${osNote(state)}; ${LOCAL_TOOLS_NOTE}`;
    case 'blocked_by_portal': {
      if (state.network.cause === 'blocked_by_portal' && state.network.causeLine) {
        return `${state.network.causeLine}; ${LOCAL_TOOLS_NOTE}`;
      }
      const where = state.bootstrap.status === 'not_substrate'
        ? `GET ${state.anchor.discovery}/bootstrap`
        : `POST ${id.endpoint}/v1/auth/resolve`;
      return `blocked_by_portal: ${where} answered with something other than the substrate (non-JSON or HTML — a captive portal or block page?); ${LOCAL_TOOLS_NOTE}`;
    }
    case 'identity_unreachable':
      return `identity_unreachable(advertised=${id.advertised ?? 'none'}, tried=[${id.tried.join(', ')}])${state.auth.detail ? `: ${state.auth.detail}` : ''}${osNote(state)}; ${LOCAL_TOOLS_NOTE}`;
    case 'key_rejected':
      return `key_rejected: the substrate's identity (${id.endpoint}) rejected the API key${state.auth.detail ? ` (${state.auth.detail})` : ''}; ${LOCAL_TOOLS_NOTE}`;
  }
}

/**
 * Attach to the substrate at `discovery` with `key`. Returns at once; the
 * sequence runs in the background (see Attachment.settled).
 */
export function attach(options: AttachOptions): Attachment {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? netFetch(env);
  const log = options.log ?? ((level, message) => {
    if (level !== 'debug') console.error(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`);
  });
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const discovery = options.discovery?.trim() ? trimUrl(options.discovery) : null;
  const key = options.key?.trim() || undefined;
  const identityOverride = options.identityOverride?.trim() ? trimUrl(options.identityOverride) : undefined;

  const state: AttachmentState = {
    anchor: { discovery, source: discovery ? options.discoverySource ?? 'explicit' : 'none' },
    bootstrap: { status: discovery ? 'pending' : 'skipped' },
    identity: { endpoint: null, source: 'none', advertised: null, tried: [] },
    auth: { status: 'pending' },
    cause: null,
    message: null,
    advertised: 'none (client-only)',
    network: {
      proxy: proxySummary(env),
      anchorRoute: null,
      cause: null,
      causeLine: null,
      tls: null,
      osProxy: null,
      lastByFamily: {},
    },
    startedAt: new Date().toISOString(),
    settledAt: null,
    lastCheckedAt: null,
  };

  if (discovery) {
    try {
      const choice = selectProxy(discovery, env);
      state.network.anchorRoute = { via: choice.proxy ? redactUrl(choice.proxy) : null, bypass: choice.bypass };
    } catch {
      // A malformed anchor is reported by the bootstrap step.
    }
  }

  const record = (family: string, outcome: Omit<FamilyOutcome, 'at'>) => {
    state.network.lastByFamily[family] = { ...outcome, at: new Date().toISOString() };
  };

  /** Name a request failure with its network cause, and note it as the attachment's. */
  const netLine = (err: unknown): string => {
    const named = classifyNetError(err);
    if (!named) return err instanceof Error ? err.message : String(err);
    state.network.cause = named.kind;
    state.network.causeLine = named.line;
    if (named.kind === 'tls_intercepted') {
      try {
        state.network.tls = { host: new URL(discovery ?? '').host, authorized: false, issuer: named.issuer ?? null };
      } catch {
        // no anchor host to name
      }
    }
    return named.line;
  };

  const noteTls = (url: string | null) => {
    if (!url) return;
    try {
      const u = new URL(url);
      const info = lastConnection(u.origin);
      if (info?.tls) state.network.tls = { host: u.host, authorized: info.tls.authorized, issuer: info.tls.issuer };
    } catch {
      // not a URL
    }
  };

  /** OS proxy settings the process does not see, when a direct connection failed in a proxy-shaped way. */
  const explainDirectFailure = async () => {
    const pe = state.network.proxy;
    if (!state.network.cause || !PROXY_SHAPED_FAILURES.has(state.network.cause) || pe.httpsProxy || pe.httpProxy) return;
    try {
      const os = await (options.osProxy ?? (() => detectOsProxy()))();
      state.network.osProxy = describeOsProxy(os)
        ?? (state.network.cause === 'connect_timeout'
          ? 'no proxy is configured here; if this network reaches the internet only through a proxy (a PAC / WPAD setup), set HTTPS_PROXY'
          : null);
    } catch {
      // best-effort
    }
  };

  const settle = (cause: AttachCause | null) => {
    state.cause = cause;
    state.message = refusalMessage(state);
    state.settledAt = new Date().toISOString();
    record('attachment', cause ? { ok: false, cause: state.network.cause ?? cause, line: state.message } : { ok: true, cause: null, line: null });
  };

  const applyResolution = (r: TenantResolution) => {
    state.lastCheckedAt = new Date().toISOString();
    switch (r.kind) {
      case 'authenticated':
        state.auth = { status: 'authenticated', orgId: r.orgId, ...(r.keyId ? { keyId: r.keyId } : {}) };
        return null;
      case 'key_rejected':
        state.auth = { status: 'key_rejected', detail: `HTTP ${r.status}` };
        return 'key_rejected' as const;
      case 'not_identity':
        state.auth = { status: 'identity_unreachable', detail: r.detail };
        return 'blocked_by_portal' as const;
      case 'unreachable':
        state.auth = { status: 'identity_unreachable', detail: r.detail };
        return 'identity_unreachable' as const;
    }
  };

  const run = async (): Promise<void> => {
    if (!key) {
      state.auth = { status: 'not_configured', detail: 'no API key (METABOB_API_KEY, or metabob.apiKey in a config file)' };
      return settle('not_configured');
    }
    if (!discovery && !identityOverride) {
      state.auth = {
        status: 'not_configured',
        detail: 'no discovery endpoint (DISCOVERY_ENDPOINT, or metabob.discoveryEndpoint in a config file)',
      };
      return settle('not_configured');
    }

    // 1. GET /bootstrap — public and keyless; a weak first filter, never proof.
    let advertised: string | null = null;
    if (discovery) {
      try {
        const res = await fetchImpl(`${discovery}/bootstrap`, {
          signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS + 1_000),
          net: { timeoutMs: BOOTSTRAP_TIMEOUT_MS, retryStatus: true },
        } as NetInit);
        noteTls(discovery);
        const text = await res.text();
        if (looksLikeHtmlOrNonJson(res.headers.get('content-type'), text)) {
          state.bootstrap = { status: 'not_substrate', detail: `HTTP ${res.status}, ${res.headers.get('content-type') ?? 'no content-type'}` };
        } else if (!res.ok) {
          state.bootstrap = { status: 'unreachable', detail: `HTTP ${res.status}` };
        } else {
          const body = JSON.parse(text) as { identity_endpoint?: unknown };
          const raw = typeof body?.identity_endpoint === 'string' ? body.identity_endpoint.trim() : '';
          advertised = raw ? trimUrl(raw) : null;
          state.bootstrap = { status: 'ok', identityEndpoint: advertised };
        }
      } catch (err) {
        const line = netLine(err);
        state.bootstrap = { status: state.network.cause === 'blocked_by_portal' ? 'not_substrate' : 'unreachable', detail: line };
      }
    }
    state.identity.advertised = advertised;

    // 2. Choose the identity address — one pass, each step at most once.
    let chosen: string | null = null;
    if (identityOverride) {
      chosen = identityOverride;
      state.identity.source = 'explicit';
    } else if (state.bootstrap.status === 'not_substrate') {
      state.auth = { status: 'identity_unreachable' };
      return settle('blocked_by_portal');
    } else if (state.bootstrap.status === 'unreachable') {
      state.auth = { status: 'identity_unreachable' };
      await explainDirectFailure();
      return settle('anchor_unreachable');
    } else if (!advertised) {
      state.auth = { status: 'identity_unreachable', detail: '/bootstrap advertises no identity_endpoint' };
      return settle('identity_unreachable');
    } else {
      state.identity.tried.push(advertised);
      if (await dialable(advertised, fetchImpl)) {
        chosen = advertised;
        state.identity.source = 'bootstrap';
      } else {
        const rehosted = rehostH1Identity(advertised, discovery!);
        if (!rehosted || rehosted === advertised) {
          state.auth = { status: 'identity_unreachable', detail: 'the advertised identity is not dialable' };
          return settle('identity_unreachable');
        }
        chosen = rehosted;
        state.identity.source = 'rehosted-h1';
        log(
          'warn',
          `/bootstrap advertises identity_endpoint ${advertised}, which is not dialable from here; using ${rehosted} ` +
            '(the discovery host at its published-port offset). This rehost is census class H1 interim debt ' +
            '(CONFORMANCE §c4-anchoring): the substrate installer will supply a host-visible identity endpoint.',
        );
      }
    }

    // 3. The org check against THAT address — the dial of a rehosted address is this call.
    state.identity.endpoint = chosen;
    if (state.identity.source !== 'bootstrap') state.identity.tried.push(chosen);
    const check = (endpoint: string) =>
      options.authService ? options.authService.resolveTenant(endpoint, key, fetchImpl) : resolveTenant(endpoint, key, fetchImpl);
    let cause = applyResolution(await check(chosen));
    if (cause === 'identity_unreachable' && state.identity.source === 'rehosted-h1' && !state.auth.detail) {
      state.auth.detail = 'the rehosted identity is not dialable either';
    }
    if (cause === 'identity_unreachable' && state.auth.detail) {
      const kind = causeOfLine(state.auth.detail);
      if (kind) {
        state.network.cause = kind;
        state.network.causeLine = state.auth.detail;
        if (kind === 'blocked_by_portal') cause = 'blocked_by_portal';
      }
      await explainDirectFailure();
    }
    settle(cause);

    if (cause === null) {
      log('info', `Attached: orgId=${state.auth.orgId} via identity ${chosen} (${state.identity.source})`);
      const interval = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
      if (options.authService && interval > 0) {
        // The key-issuance heartbeat re-resolves against the same identity; a
        // key revoked meanwhile flips the attachment to key_rejected.
        options.authService.startKeyHeartbeat(interval, chosen, key, (r) => {
          if (r.kind === 'authenticated') {
            state.lastCheckedAt = new Date().toISOString();
            state.auth = { status: 'authenticated', orgId: r.orgId, ...(r.keyId ? { keyId: r.keyId } : {}) };
          } else if (r.kind === 'key_rejected') {
            applyResolution(r);
            settle('key_rejected');
            log('warn', `${state.message!} (CONFORMANCE §c3-identity)`);
          }
        }, fetchImpl);
      }
    } else {
      // One WARN per refusal, naming the requirement it serves.
      log('warn', `${state.message!} (CONFORMANCE §${cause === 'key_rejected' ? 'c3-identity' : 'c9-fail-visibly'})`);
    }
  };

  const done = run().catch((err) => {
    state.auth = { status: 'identity_unreachable', detail: err instanceof Error ? err.message : String(err) };
    settle('identity_unreachable');
  }).then(() => state);

  const handle: Attachment = {
    state: () => structuredClone(state),
    settled: () => done.then(() => structuredClone(state)),
    refusal: () => done.then(() => state.message),
    // CONFORMANCE §c11-attachment-model
    // @anchor attachment-resolve
    async resolve(pointer, opts) {
      await done;
      if (state.cause || state.auth.status !== 'authenticated' || !discovery) {
        throw new AttachmentRefusedError(state.cause ?? 'not_configured', state.message ?? 'not_configured: no discovery endpoint');
      }
      const shape = typeof pointer.type === 'string' ? pointer.type : '(no type)';
      const timeoutMs = Math.min(opts?.timeoutMs ?? RESOLVE_TIMEOUT_MS.concept, RESOLVE_MAX_TIMEOUT_MS);
      const url = `${discovery}/resolve`;

      const once = async (): Promise<ResolveResult> => {
        const started = Date.now();
        // The one place a substrate request leaves this process.
        log('debug', `resolve ${shape} → POST ${url}`);
        let res: Response;
        try {
          res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `ApiKey ${key}` },
            body: JSON.stringify({ pointer }),
            signal: AbortSignal.timeout(timeoutMs + 1_000),
            net: { timeoutMs, idempotent: opts?.read === true },
          } as NetInit);
        } catch (err) {
          const elapsedMs = Date.now() - started;
          const named = classifyNetError(err);
          const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          if (named?.kind === 'response_timeout' || (!named && isTimeoutText(msg))) {
            throw new ResolveError('producer_timeout', shape, `producer_timeout(${shape}, ${elapsedMs}ms): no answer within the ${timeoutMs}ms client cap`, 'response_timeout');
          }
          if (named?.kind === 'blocked_by_portal') {
            throw new AttachmentRefusedError('blocked_by_portal', `${named.line} (POST ${url})`);
          }
          const line = named?.line ?? (err instanceof Error ? err.message : String(err));
          throw new ResolveError('anchor_unreachable', shape, `anchor_unreachable: POST ${url} failed — ${line}`, named?.kind);
        }
        const text = await res.text();
        const elapsedMs = Date.now() - started;
        if (looksLikeHtmlOrNonJson(res.headers.get('content-type'), text)) {
          throw new AttachmentRefusedError('blocked_by_portal', `blocked_by_portal: POST ${url} answered HTTP ${res.status} with non-JSON`);
        }
        const body = JSON.parse(text) as unknown;
        const failure = classifyDiscoveryAnswer(shape, res.status, body, elapsedMs);
        if (failure) throw failure;
        return { status: res.status, body, elapsedMs };
      };

      const delays = opts?.read ? READ_RETRY_DELAYS_MS : [];
      const family = shapeFamily(shape);
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await once();
          record(family, { ok: true, cause: null, line: null, shape });
          return result;
        } catch (err) {
          const retryable = err instanceof ResolveError && err.kind === 'producer_timeout' && attempt < delays.length;
          if (!retryable) {
            const line = err instanceof Error ? err.message : String(err);
            const cause = err instanceof ResolveError ? err.netCause ?? err.kind : err instanceof AttachmentRefusedError ? err.attachCause : 'error';
            record(family, { ok: false, cause, line, shape });
            throw err;
          }
          await sleep(delays[attempt]!);
        }
      }
    },
    fetch: fetchImpl,
    stop() {
      options.authService?.stopKeyHeartbeat();
    },
  };
  return handle;
}

// ── The process's attachment, and the one check keyed calls pass through ─────

let current: Attachment | null = null;

export function setAttachment(a: Attachment | null): void {
  current = a;
}

export function getAttachment(): Attachment | null {
  return current;
}

/**
 * Resolve a shape through the process's attachment — the path every substrate
 * tool takes (CONFORMANCE §c11-attachment-model). With no attachment installed it
 * refuses as not_configured.
 */
export async function resolveShape(pointer: Record<string, unknown>, options?: ResolveOptions): Promise<ResolveResult> {
  if (!current) {
    throw new AttachmentRefusedError('not_configured', `not_configured: not attached to a substrate; ${LOCAL_TOOLS_NOTE}`);
  }
  return current.resolve(pointer, options);
}

/**
 * The shared gate for keyed substrate calls: null when they may proceed, else
 * the one-line named cause. Waits for a pending attachment to settle. With no
 * attachment installed (a handler driven directly, as unit tests do) it never
 * refuses.
 */
export async function substrateRefusal(): Promise<string | null> {
  return current ? current.refusal() : null;
}
