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

// ── Named causes ─────────────────────────────────────────────────────────────

export type AttachCause =
  | 'not_configured'
  | 'anchor_unreachable'
  | 'blocked_by_portal'
  | 'identity_unreachable'
  | 'key_rejected';

export type AnchorSource = 'explicit' | 'derived-h1' | 'none';
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
  log?: (level: 'info' | 'warn', message: string) => void;
  /**
   * Holds the resolved tenant for the process and runs the key-issuance
   * heartbeat against the chosen identity. Without one (doctor) the org check
   * runs once and nothing repeats.
   */
  authService?: AuthService;
  /** Key-issuance heartbeat interval; 0 disables it. */
  heartbeatMs?: number;
  fetchImpl?: typeof fetch;
}

export interface Attachment {
  state(): AttachmentState;
  /** Resolves once the attachment has settled (never rejects). */
  settled(): Promise<AttachmentState>;
  /** The one-line refusal for a keyed call, after the attachment settles; null when authenticated. */
  refusal(): Promise<string | null>;
  /**
   * Resolve a pointer through discovery `POST /resolve` with `Authorization: ApiKey`.
   * Throws AttachmentRefusedError, naming the cause, when the attachment is not authenticated.
   */
  resolve(pointer: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>;
  stop(): void;
}

export class AttachmentRefusedError extends Error {
  constructor(readonly attachCause: AttachCause, message: string) {
    super(message);
    this.name = 'AttachmentRefusedError';
  }
}

const BOOTSTRAP_TIMEOUT_MS = 5_000;
const DIAL_TIMEOUT_MS = 2_000;
const RESOLVE_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 5 * 60_000;

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
    await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(DIAL_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

function refusalMessage(state: AttachmentState): string | null {
  const id = state.identity;
  switch (state.cause) {
    case null:
      return null;
    case 'not_configured':
      return `not_configured: ${state.auth.detail ?? 'the attachment is not configured'}; ${LOCAL_TOOLS_NOTE}`;
    case 'anchor_unreachable':
      return `anchor_unreachable: discovery ${state.anchor.discovery} did not answer GET /bootstrap (${state.bootstrap.detail ?? 'no response'}); ${LOCAL_TOOLS_NOTE}`;
    case 'blocked_by_portal': {
      const where = state.bootstrap.status === 'not_substrate'
        ? `GET ${state.anchor.discovery}/bootstrap`
        : `POST ${id.endpoint}/v1/auth/resolve`;
      return `blocked_by_portal: ${where} answered with something other than the substrate (non-JSON or HTML — a captive portal or block page?); ${LOCAL_TOOLS_NOTE}`;
    }
    case 'identity_unreachable':
      return `identity_unreachable(advertised=${id.advertised ?? 'none'}, tried=[${id.tried.join(', ')}])${state.auth.detail ? `: ${state.auth.detail}` : ''}; ${LOCAL_TOOLS_NOTE}`;
    case 'key_rejected':
      return `key_rejected: the substrate's identity (${id.endpoint}) rejected the API key${state.auth.detail ? ` (${state.auth.detail})` : ''}; ${LOCAL_TOOLS_NOTE}`;
  }
}

/**
 * Attach to the substrate at `discovery` with `key`. Returns at once; the
 * sequence runs in the background (see Attachment.settled).
 */
export function attach(options: AttachOptions): Attachment {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((level, message) => console.error(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`));
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
    startedAt: new Date().toISOString(),
    settledAt: null,
    lastCheckedAt: null,
  };

  const settle = (cause: AttachCause | null) => {
    state.cause = cause;
    state.message = refusalMessage(state);
    state.settledAt = new Date().toISOString();
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
        const res = await fetchImpl(`${discovery}/bootstrap`, { signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS) });
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
        state.bootstrap = { status: 'unreachable', detail: err instanceof Error ? err.message : String(err) };
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
    const cause = applyResolution(await check(chosen));
    if (cause === 'identity_unreachable' && state.identity.source === 'rehosted-h1' && !state.auth.detail) {
      state.auth.detail = 'the rehosted identity is not dialable either';
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
            log('warn', state.message!);
          }
        }, fetchImpl);
      }
    } else {
      log('warn', state.message!);
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
    async resolve(pointer, opts) {
      await done;
      if (state.cause || state.auth.status !== 'authenticated' || !discovery) {
        throw new AttachmentRefusedError(state.cause ?? 'not_configured', state.message ?? 'not_configured: no discovery endpoint');
      }
      const res = await fetchImpl(`${discovery}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `ApiKey ${key}` },
        body: JSON.stringify({ pointer }),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? RESOLVE_TIMEOUT_MS),
      });
      const text = await res.text();
      if (looksLikeHtmlOrNonJson(res.headers.get('content-type'), text)) {
        throw new AttachmentRefusedError('blocked_by_portal', `blocked_by_portal: POST ${discovery}/resolve answered HTTP ${res.status} with non-JSON`);
      }
      const body = JSON.parse(text) as unknown;
      if (!res.ok) {
        throw new Error(`discovery /resolve HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return body;
    },
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
 * The shared gate for keyed substrate calls: null when they may proceed, else
 * the one-line named cause. Waits for a pending attachment to settle. With no
 * attachment installed (a handler driven directly, as unit tests do) it never
 * refuses.
 */
export async function substrateRefusal(): Promise<string | null> {
  return current ? current.refusal() : null;
}
