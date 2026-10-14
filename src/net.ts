/**
 * The one outbound HTTP path (SPEC §network). Every request this process makes
 * to a substrate goes through `request()` — the attachment's /bootstrap, the
 * identity dial and org check, discovery `POST /resolve`, the key-issuance
 * heartbeat, the usage-history read, and doctor's HTTPS probe — so proxy
 * selection, trust, the connect budget and error classification live here and
 * nowhere else. CONFORMANCE §c8-proxy-and-tls-in-the-vessel-role
 *
 * It is a small HTTP/1.1 client on node:net and node:tls rather than `fetch`,
 * for three reasons:
 *   - it behaves identically under Bun and Node — the server runs under Bun,
 *     doctor and `attach --check` under whichever runtime launched them;
 *   - a proxy's own answer to CONNECT (407 with its Proxy-Authenticate
 *     schemes, 403 for a port, an HTML page instead of a tunnel) is only
 *     visible on the raw tunnel response, which fetch hides;
 *   - it never follows a redirect, so a captive portal's 302 is seen, not
 *     followed.
 *
 * Node-safe: no Bun-only module.
 */

import * as net from 'node:net';
import * as tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { systemCaAdditions } from './tls-trust.js';

// ── Named causes ─────────────────────────────────────────────────────────────

// @anchor net-causes
export type NetCauseKind =
  | 'proxy_auth_required'
  | 'proxy_port_blocked'
  | 'proxy_unsupported'
  | 'tls_intercepted'
  | 'tls_name_mismatch'
  | 'tls_failed'
  | 'dns_failed'
  | 'connect_timeout'
  | 'connect_refused'
  | 'connection_reset'
  | 'response_timeout'
  | 'blocked_by_portal'
  | 'anchor_unreachable';

/** A request that did not produce an HTTP answer from its target, named by what the network did. */
export class NetError extends Error {
  constructor(
    readonly kind: NetCauseKind,
    /** The cause with its argument, e.g. `proxy_auth_required(NTLM)` — the first token of `message`. */
    readonly cause_: string,
    message: string,
    readonly details: {
      url: string;
      /** The proxy the request went through, credentials redacted; null when direct. */
      via: string | null;
      /** tls_intercepted: the intercepting issuer's common name. */
      issuer?: string;
      /** proxy_auth_required: the schemes the proxy offered. */
      schemes?: string[];
      port?: number;
      elapsedMs: number;
      transient: boolean;
    },
  ) {
    super(message);
    this.name = 'NetError';
  }
}

// ── Budgets ──────────────────────────────────────────────────────────────────

// @anchor connect-budget
/**
 * The connect budget: TCP connect to the first hop, the proxy's CONNECT answer,
 * and the TLS handshake. Separate from (and normally much shorter than) the
 * caller's response budget, so a blackholed anchor or proxy fails in seconds
 * rather than at the response timeout. METABOB_CONNECT_TIMEOUT_MS overrides it.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Backoff before each retry of a transient failure on an idempotent request. */
export const TRANSIENT_RETRY_DELAYS_MS = [250, 750] as const;

export function connectBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.METABOB_CONNECT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CONNECT_TIMEOUT_MS;
}

// ── Redaction ────────────────────────────────────────────────────────────────

// @anchor redact-credentials
/** A URL with any `user:pass@` replaced by `***@`. Proxy credentials are never logged. */
export function redactUrl(u: string): string {
  return u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1***@');
}

/** Any `scheme://user:pass@` inside free text, redacted. */
export function redactText(s: string): string {
  return s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s"']*@/gi, '$1***@');
}

// ── Proxy selection ──────────────────────────────────────────────────────────

const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1'];

function envFirst(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

export interface ProxyEnv {
  httpsProxy: string | null;
  httpProxy: string | null;
  /** NO_PROXY as the operator set it. */
  noProxy: string | null;
  /** The entries in force: the operator's plus loopback, added whenever a proxy is set. */
  effectiveNoProxy: string[];
}

export function readProxyEnv(env: NodeJS.ProcessEnv = process.env): ProxyEnv {
  const httpProxy = envFirst(env, 'http_proxy', 'HTTP_PROXY') ?? null;
  const httpsProxy = envFirst(env, 'https_proxy', 'HTTPS_PROXY') ?? null;
  const noProxy = envFirst(env, 'no_proxy', 'NO_PROXY') ?? null;
  const entries = (noProxy ?? '').split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  // CONFORMANCE §c8-proxy-and-tls-in-the-vessel-role: loopback never goes through a proxy.
  const effectiveNoProxy = httpProxy || httpsProxy ? [...new Set([...entries, ...LOOPBACK_NO_PROXY])] : entries;
  return { httpsProxy, httpProxy, noProxy, effectiveNoProxy };
}

function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}

function ipv4ToInt(ip: string): number | null {
  if (net.isIPv4(ip) === false) return null;
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function matchesNoProxy(hostname: string, port: string, entries: string[]): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  for (const raw of entries) {
    if (raw === '*') return true;
    let entry = raw;
    let entryPort: string | null = null;
    const m = /^(.*?)(?::(\d+))?$/.exec(entry.startsWith('[') ? entry.replace(/^\[([^\]]+)\](.*)$/, '$1$2') : entry);
    if (m && m[2] && !net.isIPv6(entry)) {
      entry = m[1]!;
      entryPort = m[2];
    }
    if (entryPort && entryPort !== port) continue;
    if (entry.includes('/')) {
      const [base, bitsRaw] = entry.split('/');
      const b = ipv4ToInt(base ?? '');
      const h = ipv4ToInt(host);
      const bitCount = Number(bitsRaw);
      if (b !== null && h !== null && bitCount >= 0 && bitCount <= 32) {
        const mask = bitCount === 0 ? 0 : (0xffffffff << (32 - bitCount)) >>> 0;
        if ((b & mask) === (h & mask)) return true;
      }
      continue;
    }
    const bare = entry.replace(/^\*?\./, '');
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

export interface ProxyChoice {
  /** The proxy URL to use (with credentials), or null for a direct connection. */
  proxy: string | null;
  /** Why the request goes direct, when it does. */
  bypass: 'loopback' | 'no_proxy' | 'no_proxy_configured' | 'http_proxy_unset' | null;
}

// @anchor select-proxy
/**
 * The proxy for one URL, chosen per request from HTTP(S)_PROXY / NO_PROXY:
 * https uses HTTPS_PROXY and falls back to HTTP_PROXY; http uses HTTP_PROXY.
 * Loopback always goes direct. Lowercase names win over uppercase.
 */
export function selectProxy(target: URL | string, env: NodeJS.ProcessEnv = process.env): ProxyChoice {
  const url = typeof target === 'string' ? new URL(target) : target;
  const pe = readProxyEnv(env);
  const proxy = url.protocol === 'https:' ? pe.httpsProxy ?? pe.httpProxy : pe.httpProxy;
  if (!pe.httpsProxy && !pe.httpProxy) return { proxy: null, bypass: 'no_proxy_configured' };
  if (isLoopback(url.hostname)) return { proxy: null, bypass: 'loopback' };
  // A plain-http URL with only HTTPS_PROXY set goes direct (curl / undici semantics), and says why.
  if (!proxy) return { proxy: null, bypass: 'http_proxy_unset' };
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (matchesNoProxy(url.hostname, port, pe.effectiveNoProxy)) return { proxy: null, bypass: 'no_proxy' };
  return { proxy: /^[a-z][a-z0-9+.-]*:\/\//i.test(proxy) ? proxy : `http://${proxy}`, bypass: null };
}

/** The proxy configuration for /health, doctor and `attach --check`, credentials redacted. */
export interface ProxySummary {
  httpsProxy: string | null;
  httpProxy: string | null;
  noProxy: string | null;
  /** Entries in force, loopback included whenever a proxy is set. */
  effectiveNoProxy: string[];
}

export function proxySummary(env: NodeJS.ProcessEnv = process.env): ProxySummary {
  const pe = readProxyEnv(env);
  return {
    httpsProxy: pe.httpsProxy ? redactUrl(pe.httpsProxy) : null,
    httpProxy: pe.httpProxy ? redactUrl(pe.httpProxy) : null,
    noProxy: pe.noProxy,
    effectiveNoProxy: pe.effectiveNoProxy,
  };
}

// ── Trust ────────────────────────────────────────────────────────────────────

let extraCaCache: { path: string; pems: string[] } | null = null;

function extraCas(env: NodeJS.ProcessEnv): string[] {
  const path = env.NODE_EXTRA_CA_CERTS?.trim();
  if (!path) return [];
  if (extraCaCache?.path === path) return extraCaCache.pems;
  let pems: string[] = [];
  try {
    pems = readFileSync(path, 'utf-8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  } catch {
    // Reported by doctor; an unreadable bundle adds nothing.
  }
  extraCaCache = { path, pems };
  return pems;
}

// @anchor trusted-cas
/**
 * The roots a substrate certificate is checked against: the bundled roots, the
 * OS trust store (unless METABOB_NO_SYSTEM_CA=1), and NODE_EXTRA_CA_CERTS read
 * by this module — Bun does not read that variable itself.
 */
export function trustedCas(env: NodeJS.ProcessEnv = process.env): string[] {
  const system = env.METABOB_NO_SYSTEM_CA === '1' ? [] : systemCaAdditions();
  return [...new Set([...tls.rootCertificates, ...system, ...extraCas(env)])];
}

// ── Connection info (for attach --check and doctor) ──────────────────────────

export interface ConnectionInfo {
  url: string;
  /** The proxy used, credentials redacted; null when direct. */
  via: string | null;
  bypass: ProxyChoice['bypass'];
  tls: null | { authorized: boolean; issuer: string | null; protocol: string | null };
}

// One entry per origin, last write wins: a process has one attachment, so this
// is that anchor's connection. Concurrent attachments to one origin (the network
// matrix) share it; their causes come from the errors they throw, not from here.
const lastConnections = new Map<string, ConnectionInfo>();

/** How the last request to `origin` was made: proxy or direct (and why), and its TLS. */
export function lastConnection(origin: string): ConnectionInfo | null {
  return lastConnections.get(origin) ?? null;
}

// ── The request ──────────────────────────────────────────────────────────────

export interface NetRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Response budget for the whole request (ms), connect included. */
  timeoutMs?: number;
  /** Connect budget (ms); default METABOB_CONNECT_TIMEOUT_MS or 5 s. */
  connectTimeoutMs?: number;
  /** Retry transient failures (a reset connection). Default: GET and HEAD only; never a write. */
  idempotent?: boolean;
  /** Also retry 502/503/504 answers (an idempotent read whose caller does not classify them itself). */
  retryStatus?: boolean;
  /** Proxy and trust are read from here; default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Override the trusted roots (doctor compares bundled-only against the OS store). */
  ca?: string[];
  signal?: AbortSignal;
  /** Internal: hand back the TLS socket unverified, for a probe that inspects the chain (openTlsSocket). */
  inspectTls?: boolean;
}

interface Hop {
  socket: net.Socket;
  via: string | null;
  bypass: ProxyChoice['bypass'];
  tls: ConnectionInfo['tls'];
}

function errCode(err: unknown): string {
  let e: any = err;
  for (let i = 0; i < 4 && e; i++) {
    if (typeof e.code === 'string') return e.code;
    e = e.cause;
  }
  return '';
}

function hostPort(u: URL): { host: string; port: number } {
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
}

function proxySchemes(headers: Map<string, string[]>): string[] {
  const values = headers.get('proxy-authenticate') ?? [];
  const schemes = values.flatMap((v) => v.split(/,(?=\s*[A-Za-z-]+(?:\s|$))/)).map((v) => v.trim().split(/\s+/)[0] ?? '').filter(Boolean);
  return [...new Set(schemes)];
}

function proxyAuthMessage(schemes: string[], hadCredentials: boolean, via: string): string {
  const list = schemes.length ? schemes.join(', ') : 'unknown scheme';
  const kerberos = schemes.some((s) => /^(ntlm|negotiate|kerberos)$/i.test(s));
  const basic = schemes.some((s) => /^basic$/i.test(s));
  if (basic && !kerberos) {
    return hadCredentials
      ? `the proxy ${via} rejected the credentials in the proxy URL (Basic)`
      : `the proxy ${via} requires Basic authentication: put the credentials in the proxy URL (HTTPS_PROXY=http://user:password@host:port)`;
  }
  return (
    `the proxy ${via} requires ${list} authentication, which this process does not speak; ` +
    'run a local authenticating relay (a px- or cntlm-style proxy) and point HTTPS_PROXY at it ' +
    '(for example HTTPS_PROXY=http://127.0.0.1:3128)'
  );
}

/** Read one HTTP head (status line + headers) from a socket; leftover bytes are returned. */
function readHead(socket: net.Socket): Promise<{ status: number; reason: string; headers: Map<string, string[]>; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) {
        if (buf.length > 64 * 1024) finish(new Error('response head too large'));
        return;
      }
      const head = buf.subarray(0, idx).toString('latin1');
      const rest = buf.subarray(idx + 4);
      const lines = head.split('\r\n');
      const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(lines[0] ?? '');
      if (!m) return finish(Object.assign(new Error(`not an HTTP answer: ${JSON.stringify((lines[0] ?? '').slice(0, 60))}`), { code: 'NOT_HTTP' }));
      const headers = new Map<string, string[]>();
      for (const line of lines.slice(1)) {
        const c = line.indexOf(':');
        if (c <= 0) continue;
        const k = line.slice(0, c).trim().toLowerCase();
        headers.set(k, [...(headers.get(k) ?? []), line.slice(c + 1).trim()]);
      }
      finish(null, { status: Number(m[1]), reason: m[2] ?? '', headers, rest });
    };
    const onEnd = () => finish(Object.assign(new Error('connection closed before an answer'), { code: 'ECONNRESET' }));
    const onError = (err: Error) => finish(err);
    const finish = (err: Error | null, value?: { status: number; reason: string; headers: Map<string, string[]>; rest: Buffer }) => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onError);
      if (err) reject(err);
      else resolve(value!);
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
    socket.once('error', onError);
  });
}

function rootIssuer(peer: tls.DetailedPeerCertificate): string | null {
  let cur: tls.DetailedPeerCertificate | undefined = peer;
  const seen = new Set<string>();
  let issuer: string | null = null;
  while (cur && cur.fingerprint256 && !seen.has(cur.fingerprint256)) {
    seen.add(cur.fingerprint256);
    const i = cur.issuer as unknown as Record<string, string | undefined> | undefined;
    issuer = i?.CN ?? i?.O ?? issuer;
    cur = cur.issuerCertificate && cur.issuerCertificate !== cur ? cur.issuerCertificate : undefined;
  }
  return issuer;
}

let secureContextCache: { key: string; ctx: tls.SecureContext } | null = null;

function secureContextFor(cas: string[]): tls.SecureContext | undefined {
  const key = `${cas.length}:${cas[cas.length - 1]?.slice(-80) ?? ''}`;
  if (secureContextCache?.key === key) return secureContextCache.ctx;
  try {
    const ctx = tls.createSecureContext({ ca: cas });
    secureContextCache = { key, ctx };
    return ctx;
  } catch {
    return undefined;
  }
}

/**
 * Open the connection a request rides on: direct, or through the chosen proxy
 * (CONNECT for https, by hostname so the proxy resolves it), then TLS when the
 * target is https. Everything here runs inside the connect budget.
 */
async function openHop(target: URL, opts: NetRequestOptions, env: NodeJS.ProcessEnv, track: (s: net.Socket) => void): Promise<Hop> {
  const choice = selectProxy(target, env);
  const via = choice.proxy ? redactUrl(choice.proxy) : null;
  const { host, port } = hostPort(target);
  const fail = (kind: NetCauseKind, cause: string, message: string, extra: Partial<NetError['details']> = {}) =>
    new NetError(kind, cause, `${cause}: ${message}`, {
      url: target.toString(),
      via,
      elapsedMs: 0,
      transient: false,
      ...extra,
    });

  let proxyUrl: URL | null = null;
  if (choice.proxy) {
    try {
      proxyUrl = new URL(choice.proxy);
    } catch {
      throw fail('proxy_unsupported', 'proxy_unsupported(malformed)', `the proxy URL ${via} does not parse`);
    }
    if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
      const scheme = proxyUrl.protocol.replace(/:$/, '');
      throw fail('proxy_unsupported', `proxy_unsupported(${scheme})`, `the proxy ${via} is ${scheme}; only http:// and https:// proxies are supported (an HTTP CONNECT proxy)`);
    }
  }

  const first = proxyUrl ? hostPort(proxyUrl) : { host, port };
  const firstLabel = `${first.host}:${first.port}${proxyUrl ? ' (the proxy)' : ''}`;
  let socket: net.Socket;
  try {
    socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = proxyUrl?.protocol === 'https:'
        ? tls.connect({ host: first.host, port: first.port, servername: net.isIP(first.host) ? undefined : first.host, secureContext: secureContextFor(opts.ca ?? trustedCas(env)) })
        : net.connect({ host: first.host, port: first.port });
      track(s);
      s.once(proxyUrl?.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
        s.removeAllListeners('error');
        resolve(s);
      });
      s.once('error', reject);
    });
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME' || code === 'EAI_FAIL') {
      throw fail('dns_failed', `dns_failed(${first.host})`, `${first.host} does not resolve${proxyUrl ? ' (the proxy host)' : ''}; if this network allows egress only through a proxy, set HTTPS_PROXY`);
    }
    if (code === 'ECONNREFUSED') {
      throw fail('connect_refused', `connect_refused(${firstLabel})`, `nothing accepts connections at ${firstLabel}`);
    }
    if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EADDRNOTAVAIL') {
      throw fail('connect_timeout', `connect_timeout(${firstLabel})`, `no connection to ${firstLabel} (${code}: no route, or packets dropped)`);
    }
    if (code === 'ECONNRESET' || code === 'EPIPE') {
      throw fail('connection_reset', `connection_reset(${firstLabel})`, `the connection to ${firstLabel} was reset`, { transient: true });
    }
    throw fail('anchor_unreachable', `anchor_unreachable(${firstLabel})`, err instanceof Error ? err.message : String(err));
  }

  // An http:// target through a proxy is sent absolute-form on this socket; no tunnel.
  if (proxyUrl && target.protocol === 'http:') {
    return { socket, via, bypass: null, tls: null };
  }

  if (proxyUrl) {
    const auth = proxyUrl.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')}\r\n`
      : '';
    const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nUser-Agent: metabob-mcp\r\n${auth}\r\n`);
    let head;
    try {
      head = await readHead(socket);
    } catch (err) {
      socket.destroy();
      if (errCode(err) === 'NOT_HTTP') {
        throw fail('blocked_by_portal', 'blocked_by_portal', `the proxy ${via} answered CONNECT ${authority} with something other than HTTP`);
      }
      throw fail('connection_reset', `connection_reset(${via})`, `the proxy ${via} closed the connection before answering CONNECT ${authority}`, { transient: true });
    }
    const contentType = (head.headers.get('content-type') ?? []).join(',').toLowerCase();
    const contentLength = Number((head.headers.get('content-length') ?? ['0'])[0]);
    if (head.status === 407) {
      socket.destroy();
      const schemes = proxySchemes(head.headers);
      throw fail('proxy_auth_required', `proxy_auth_required(${schemes.join(', ') || 'unknown'})`, proxyAuthMessage(schemes, Boolean(proxyUrl.username), via!), { schemes });
    }
    if ((head.status === 403 || head.status === 405) && port !== 443) {
      socket.destroy();
      throw fail('proxy_port_blocked', `proxy_port_blocked(${port})`, `the proxy ${via} refuses CONNECT to port ${port} (HTTP ${head.status}); many proxies tunnel only to 443 — the anchor needs a 443 endpoint, or a NO_PROXY entry if it is reachable directly`, { port });
    }
    if (head.status >= 500) {
      socket.destroy();
      throw fail('anchor_unreachable', `anchor_unreachable(${authority})`, `the proxy ${via} could not reach ${authority} (HTTP ${head.status} ${head.reason})`, { transient: true });
    }
    if (head.status !== 200 || contentType.includes('text/html') || contentLength > 0 || head.rest.length > 0) {
      socket.destroy();
      throw fail('blocked_by_portal', 'blocked_by_portal', `the proxy ${via} answered CONNECT ${authority} with its own page (HTTP ${head.status}${contentType ? `, ${contentType}` : ''}) instead of a tunnel — a block page or captive portal`);
    }
  }

  if (target.protocol !== 'https:') {
    return { socket, via, bypass: choice.bypass, tls: null };
  }

  // TLS to the target, end to end through any tunnel. Nothing is sent until the
  // chain and the name are verified.
  const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const cas = opts.ca ?? trustedCas(env);
    const s = tls.connect({
      socket,
      servername: net.isIP(host) ? undefined : host,
      secureContext: secureContextFor(cas),
      ...(secureContextFor(cas) ? {} : { ca: cas }),
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    track(s);
    s.once('secureConnect', () => {
      s.removeAllListeners('error');
      resolve(s);
    });
    s.once('error', reject);
  }).catch((err) => {
    socket.destroy();
    const code = errCode(err);
    if (code === 'ECONNRESET' || code === 'EPIPE') {
      throw fail('connection_reset', `connection_reset(${host}:${port})`, `the connection was reset during the TLS handshake with ${host}:${port}`, { transient: true });
    }
    throw fail('tls_failed', `tls_failed(${host}:${port})`, `the TLS handshake with ${host}:${port} failed (${code || (err instanceof Error ? err.message : String(err))})${via ? ` through ${via}` : ''}`);
  });

  if (opts.inspectTls) {
    return { socket: tlsSocket, via, bypass: choice.bypass, tls: { authorized: tlsSocket.authorized, issuer: null, protocol: tlsSocket.getProtocol?.() ?? null } };
  }
  const peer = tlsSocket.getPeerCertificate(true);
  const issuer = peer && Object.keys(peer).length ? rootIssuer(peer) : null;
  const info: ConnectionInfo['tls'] = { authorized: tlsSocket.authorized, issuer, protocol: tlsSocket.getProtocol?.() ?? null };
  if (!tlsSocket.authorized) {
    tlsSocket.destroy();
    const reason = String(tlsSocket.authorizationError ?? 'untrusted chain');
    lastConnections.set(target.origin, { url: target.toString(), via, bypass: choice.bypass, tls: info });
    throw fail(
      'tls_intercepted',
      `tls_intercepted(${issuer ?? 'unknown issuer'})`,
      `TLS_INTERCEPTED — the certificate chain for ${host}:${port} is signed by "${issuer ?? 'unknown'}", which this process does not trust (${reason})${via ? `, through ${via}` : ''}. ` +
        'Install that CA into the OS trust store (it is read at startup), or set NODE_EXTRA_CA_CERTS to a PEM file holding it, or ask IT to exempt the substrate host from inspection',
      { issuer: issuer ?? undefined },
    );
  }
  const nameError = tls.checkServerIdentity(host, peer);
  if (nameError) {
    tlsSocket.destroy();
    throw fail('tls_name_mismatch', `tls_name_mismatch(${host})`, `the certificate ${host}:${port} presented is not for ${host} (${nameError.message})`);
  }
  return { socket: tlsSocket, via, bypass: choice.bypass, tls: info };
}

function dechunk(body: Buffer): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  while (i < body.length) {
    const eol = body.indexOf('\r\n', i);
    if (eol < 0) break;
    const size = parseInt(body.subarray(i, eol).toString('latin1').split(';')[0]!.trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(body.subarray(eol + 2, eol + 2 + size));
    i = eol + 2 + size + 2;
  }
  return Buffer.concat(out);
}

function readAll(socket: net.Socket, initial: Buffer, expectedLength: number | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [initial];
    let total = initial.length;
    if (expectedLength !== null && total >= expectedLength) return resolve(Buffer.concat(chunks).subarray(0, expectedLength));
    const onData = (c: Buffer) => {
      chunks.push(c);
      total += c.length;
      if (expectedLength !== null && total >= expectedLength) done();
    };
    const done = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      const all = Buffer.concat(chunks);
      if (expectedLength !== null && all.length < expectedLength) {
        return reject(Object.assign(new Error('connection closed mid-body'), { code: 'ECONNRESET' }));
      }
      resolve(expectedLength !== null ? all.subarray(0, expectedLength) : all);
    };
    const onError = (err: Error) => {
      socket.off('data', onData);
      reject(err);
    };
    socket.on('data', onData);
    socket.once('end', done);
    socket.once('close', done);
    socket.once('error', onError);
  });
}

async function once(target: URL, opts: NetRequestOptions, env: NodeJS.ProcessEnv, started: number): Promise<Response> {
  const timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const connectMs = Math.min(opts.connectTimeoutMs ?? connectBudgetMs(env), timeoutMs);
  const deadline = { at: started + timeoutMs, phase: 'connect' as 'connect' | 'response' };
  const sockets: net.Socket[] = [];
  const choice = selectProxy(target, env);
  const via = choice.proxy ? redactUrl(choice.proxy) : null;
  const { host, port } = hostPort(target);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    const fire = (phase: 'connect' | 'response', aborted = false) => {
      for (const s of sockets) s.destroy();
      if (phase === 'connect') {
        let first = `${host}:${port}`;
        try {
          if (choice.proxy) first = `${hostPort(new URL(choice.proxy)).host}:${hostPort(new URL(choice.proxy)).port} (the proxy)`;
        } catch {
          // A malformed proxy URL is named by openHop.
        }
        reject(new NetError('connect_timeout', `connect_timeout(${first})`, `connect_timeout(${first}): no connection${choice.proxy ? ' and tunnel' : ''} to ${target.host} within ${connectMs}ms${via ? ` through ${via}` : ' (direct)'} — packets dropped, or a proxy is required`, { url: target.toString(), via, elapsedMs: Date.now() - started, transient: false }));
      } else {
        reject(new NetError('response_timeout', `response_timeout(${target.host}, ${timeoutMs}ms)`, `response_timeout(${target.host}, ${timeoutMs}ms): connected, but no complete answer within ${timeoutMs}ms${aborted ? ' (aborted)' : ''}`, { url: target.toString(), via, elapsedMs: Date.now() - started, transient: false }));
      }
    };
    timer = setTimeout(() => fire('connect'), connectMs);
    (deadline as any).toResponse = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fire('response'), Math.max(1, deadline.at - Date.now()));
    };
    if (opts.signal) {
      abortListener = () => fire(deadline.phase, true);
      if (opts.signal.aborted) abortListener();
      else opts.signal.addEventListener('abort', abortListener, { once: true });
    }
  });
  timedOut.catch(() => {});

  const work = (async (): Promise<Response> => {
    const hop = await openHop(target, opts, env, (s) => sockets.push(s));
    deadline.phase = 'response';
    (deadline as any).toResponse();
    lastConnections.set(target.origin, { url: target.toString(), via: hop.via, bypass: hop.bypass, tls: hop.tls });

    const method = (opts.method ?? 'GET').toUpperCase();
    const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? Buffer.from(opts.body) : Buffer.from(opts.body);
    const absolute = hop.via !== null && target.protocol === 'http:';
    const path = absolute ? target.toString() : `${target.pathname}${target.search}`;
    const headers: Record<string, string> = { Host: target.host, 'User-Agent': 'metabob-mcp', Accept: 'application/json', Connection: 'close', ...opts.headers };
    if (body) headers['Content-Length'] = String(body.length);
    if (absolute && choice.proxy) {
      const p = new URL(choice.proxy);
      if (p.username) headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}`;
    }
    const head = `${method} ${path} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
    hop.socket.write(head);
    if (body) hop.socket.write(body);

    let res;
    try {
      res = await readHead(hop.socket);
      while (res.status >= 100 && res.status < 200) {
        hop.socket.unshift(res.rest);
        res = await readHead(hop.socket);
      }
    } catch (err) {
      hop.socket.destroy();
      if (errCode(err) === 'NOT_HTTP') {
        throw new NetError('blocked_by_portal', 'blocked_by_portal', `blocked_by_portal: ${target.host} answered with something other than HTTP${via ? ` through ${via}` : ''}`, { url: target.toString(), via, elapsedMs: Date.now() - started, transient: false });
      }
      throw new NetError('connection_reset', `connection_reset(${target.host})`, `connection_reset(${target.host}): the connection closed before an answer${via ? ` — the proxy ${via} may cut idle or long requests` : ''}`, { url: target.toString(), via, elapsedMs: Date.now() - started, transient: true });
    }
    if (res.status === 407 && hop.via) {
      hop.socket.destroy();
      const schemes = proxySchemes(res.headers);
      const cause = `proxy_auth_required(${schemes.join(', ') || 'unknown'})`;
      throw new NetError('proxy_auth_required', cause, `${cause}: ${proxyAuthMessage(schemes, Boolean(new URL(choice.proxy!).username), hop.via)}`, { url: target.toString(), via, schemes, elapsedMs: Date.now() - started, transient: false });
    }
    const te = (res.headers.get('transfer-encoding') ?? []).join(',').toLowerCase();
    const cl = res.headers.get('content-length')?.[0];
    const noBody = method === 'HEAD' || res.status === 204 || res.status === 304;
    let raw: Buffer;
    try {
      raw = noBody ? Buffer.alloc(0) : await readAll(hop.socket, res.rest, te.includes('chunked') || cl === undefined ? null : Number(cl));
    } catch {
      hop.socket.destroy();
      throw new NetError('connection_reset', `connection_reset(${target.host})`, `connection_reset(${target.host}): the connection closed mid-answer${via ? ` — the proxy ${via} may cut idle or long requests` : ''}`, { url: target.toString(), via, elapsedMs: Date.now() - started, transient: true });
    }
    hop.socket.destroy();
    const bodyBuf = te.includes('chunked') ? dechunk(raw) : raw;
    const h = new Headers();
    for (const [k, vs] of res.headers) {
      if (k === 'transfer-encoding' || k === 'content-length') continue;
      for (const v of vs) h.append(k, v);
    }
    const status = res.status;
    const nullBody = status === 101 || status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : bodyBuf, { status: status < 200 || status > 599 ? 502 : status, statusText: res.reason, headers: h });
  })();

  try {
    return await Promise.race([work, timedOut]);
  } catch (err) {
    if (err instanceof NetError) {
      (err.details as { elapsedMs: number }).elapsedMs = Date.now() - started;
      if (!err.details.via && via) (err.details as { via: string | null }).via = via;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (abortListener) opts.signal?.removeEventListener('abort', abortListener);
    work.catch(() => {});
    for (const s of sockets) s.destroy();
  }
}

// @anchor net-request
/**
 * One HTTP request on the one outbound path. Answers a Response for any HTTP
 * answer from the target; throws NetError, naming the cause, when the network
 * produced none. Transient failures (a reset connection, a proxy's 5xx to
 * CONNECT; 502/503/504 with `retryStatus`) are retried with bounded backoff
 * on idempotent requests only, within the response budget.
 */
export async function request(url: string | URL, opts: NetRequestOptions = {}): Promise<Response> {
  const target = typeof url === 'string' ? new URL(url) : url;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new NetError('anchor_unreachable', `anchor_unreachable(${target.protocol})`, `anchor_unreachable: ${target.protocol} URLs are not supported`, { url: target.toString(), via: null, elapsedMs: 0, transient: false });
  }
  const env = opts.env ?? process.env;
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const method = (opts.method ?? 'GET').toUpperCase();
  const idempotent = opts.idempotent ?? (method === 'GET' || method === 'HEAD');
  for (let attempt = 0; ; attempt++) {
    const remaining = timeoutMs - (Date.now() - started);
    let res: Response | null = null;
    let error: unknown = null;
    try {
      res = await once(target, { ...opts, timeoutMs: Math.max(1, remaining) }, env, Date.now());
    } catch (err) {
      error = err;
    }
    const delay = TRANSIENT_RETRY_DELAYS_MS[attempt];
    const transient = error instanceof NetError
      ? error.details.transient
      : Boolean(res && opts.retryStatus && [502, 503, 504].includes(res.status));
    const left = timeoutMs - (Date.now() - started);
    if (!idempotent || !transient || delay === undefined || left <= delay + 50) {
      if (error) throw error;
      return res!;
    }
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** Extra request options a caller can pass through the fetch-shaped adapter (ignored by any other fetch). */
export interface NetInit extends RequestInit {
  net?: Pick<NetRequestOptions, 'timeoutMs' | 'connectTimeoutMs' | 'idempotent' | 'retryStatus'>;
}

/**
 * `request()` in the shape of `fetch`, so code that takes a `fetchImpl`
 * (the attachment, the org check) runs on the one path by default and on a
 * scripted fetch in tests.
 */
export function netFetch(env?: NodeJS.ProcessEnv): typeof fetch {
  return (async (input: string | URL | Request, init?: NetInit) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => {
      headers[k] = v;
    });
    const body = init?.body;
    return request(url, {
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers,
      body: typeof body === 'string' || body instanceof Uint8Array ? body : body == null ? undefined : String(body),
      signal: init?.signal ?? undefined,
      env,
      ...init?.net,
    });
  }) as typeof fetch;
}

// ── Classification of any error, for one-line reporting ──────────────────────

export interface NamedCause {
  kind: NetCauseKind;
  /** e.g. `connect_refused(127.0.0.1:9)` */
  cause: string;
  /** One line, starting with the cause. */
  line: string;
  issuer?: string;
}

// @anchor classify-error
/**
 * The named cause of any request failure: a NetError as is; anything else (a
 * scripted fetch's TypeError, a raw socket error, a TLS chain error) classified
 * by its code or message. Null when it does not look like a network failure.
 */
export function classifyNetError(err: unknown): NamedCause | null {
  if (err instanceof NetError) {
    return { kind: err.kind, cause: err.cause_, line: redactText(err.message), ...(err.details.issuer ? { issuer: err.details.issuer } : {}) };
  }
  const msg = err instanceof Error ? `${err.message} ${(err as { cause?: { message?: string } }).cause?.message ?? ''}` : String(err);
  const code = errCode(err);
  const text = `${code} ${msg}`;
  const pick = (kind: NetCauseKind, cause: string): NamedCause => ({ kind, cause, line: redactText(`${cause}: ${msg.trim()}`) });
  if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME|getaddrinfo/i.test(text)) return pick('dns_failed', 'dns_failed');
  if (/ECONNREFUSED|connection refused/i.test(text)) return pick('connect_refused', 'connect_refused');
  if (/ECONNRESET|EPIPE|socket hang up|other side closed/i.test(text)) return pick('connection_reset', 'connection_reset');
  if (/EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|connect timeout/i.test(text)) return pick('connect_timeout', 'connect_timeout');
  if (/UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_UNTRUSTED|unable to get local issuer/i.test(text)) {
    return pick('tls_intercepted', 'tls_intercepted(unknown issuer)');
  }
  if (/TimeoutError|timed out|timeout|aborted/i.test(text)) return pick('response_timeout', 'response_timeout');
  return null;
}

const NET_CAUSE_KINDS: ReadonlySet<string> = new Set<NetCauseKind>([
  'proxy_auth_required', 'proxy_port_blocked', 'proxy_unsupported', 'tls_intercepted', 'tls_name_mismatch',
  'tls_failed', 'dns_failed', 'connect_timeout', 'connect_refused', 'connection_reset', 'response_timeout',
  'blocked_by_portal', 'anchor_unreachable',
]);

/** The network cause a one-line report starts with (`connect_refused(…): …`), or null. */
export function causeOfLine(line: string): NetCauseKind | null {
  const m = /^([a-z_]+)[(:]/.exec(line);
  return m && NET_CAUSE_KINDS.has(m[1]!) ? (m[1] as NetCauseKind) : null;
}

// @anchor open-tls-socket
/**
 * A TLS socket to `https://host:port`, on the same path a request takes
 * (proxy chosen per request, CONNECT by hostname), handed back unverified so a
 * probe can inspect the chain it was served — doctor's handshake probe and the
 * certificate-fingerprint self-probe. Proxy refusals are named as for a request.
 */
export async function openTlsSocket(
  url: string | URL,
  opts: { env?: NodeJS.ProcessEnv; connectTimeoutMs?: number; ca?: string[] } = {},
): Promise<{ socket: tls.TLSSocket; via: string | null; bypass: ProxyChoice['bypass'] }> {
  const target = typeof url === 'string' ? new URL(url) : url;
  const env = opts.env ?? process.env;
  const budget = opts.connectTimeoutMs ?? connectBudgetMs(env);
  const sockets: net.Socket[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const choice = selectProxy(target, env);
  const via = choice.proxy ? redactUrl(choice.proxy) : null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      for (const s of sockets) s.destroy();
      const cause = `connect_timeout(${target.host})`;
      reject(new NetError('connect_timeout', cause, `${cause}: no TLS connection within ${budget}ms${via ? ` through ${via}` : ' (direct)'}`, { url: target.toString(), via, elapsedMs: budget, transient: false }));
    }, budget);
  });
  try {
    const hop = await Promise.race([openHop(target, { ca: opts.ca, inspectTls: true }, env, (s) => sockets.push(s)), timeout]);
    return { socket: hop.socket as tls.TLSSocket, via: hop.via, bypass: hop.bypass };
  } finally {
    clearTimeout(timer);
  }
}
