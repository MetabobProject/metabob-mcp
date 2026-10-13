/**
 * Diagnostic doctor for corporate-proxy / Zscaler / MDM TLS-inspection issues.
 *
 * Runs a battery of probes against the path to the configured substrate (the
 * hosts of METABOB_ENDPOINT / DISCOVERY_ENDPOINT and their siblings, read the
 * same way the server reads them) and prints a human-readable report plus a
 * JSON artifact for support tickets.
 *
 * Entry points:
 *   - `metabob-mcp doctor` (subcommand of the main CLI)
 *   - `metabob-mcp-doctor` (dedicated bin)
 *
 * Safe to run with or without an API key. With no endpoint configured it says
 * so once (config.ts unattachedMessage) and probes only the trust store and a
 * reference host.
 */

import * as tls from 'node:tls';
import * as net from 'node:net';
import * as https from 'node:https';
import * as dns from 'node:dns/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import { readKnownHosts } from './cert-fingerprint.js';
import {
  applyConfigDefaults,
  configuredSubstrateUrls,
  getDefaultConfigPath,
  loadMetabobCLIConfig,
  loadMetabobEnvConfig,
  unattachedMessage,
  withoutEndpoints,
} from './config.js';

/**
 * proxy-from-env's getProxyForUrl() runs the legacy url.parse() when handed a
 * string, which emits `DEP0169 DeprecationWarning: url.parse()` under Node ≥21.
 * Handing it a WHATWG URL instead makes it skip url.parse() and read
 * .protocol/.host/.port directly — those fields are byte-compatible with what
 * it read off the legacy Url, so the result is identical, just warning-free.
 * Falls back to the string form if the input isn't a parseable absolute URL.
 */
function proxyForUrl(rawUrl: string): string {
  try {
    return getProxyForUrl(new URL(rawUrl) as unknown as import('node:url').Url);
  } catch {
    return getProxyForUrl(rawUrl);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DoctorReport {
  schema: 'metabob-mcp-doctor/v1';
  generatedAt: string;
  durationMs: number;
  metabobMcpVersion: string;
  environment: EnvironmentSnapshot;
  proxy: ProxySnapshot;
  dns: Record<string, DnsProbeResult>;
  trustStore: TrustStoreSnapshot;
  tlsHandshakes: Record<string, TlsHandshakeResult>;
  httpsProbes: Record<string, HttpsProbeResult>;
  /** The configured substrate URLs probed, and the one message when none is configured. */
  substrate: SubstrateTargets;
  config: ConfigSnapshot;
  diagnosis: Diagnosis;
}

export interface EnvironmentSnapshot {
  nodeVersion: string;
  bunVersion: string | null;
  platform: string;
  arch: string;
  osRelease: string;
  cwd: string;
  envVars: Record<string, string>;
}

export interface ProxySnapshot {
  httpProxy: string | null;
  httpsProxy: string | null;
  noProxy: string | null;
  npmProxy: string | null;
  npmHttpsProxy: string | null;
  /** Effective HTTPS proxy URL after applying NO_PROXY against a metabob host. */
  effectiveProxyForMetabob: string | null;
  proxyScheme: 'http' | 'https' | 'socks' | 'unknown' | null;
  /** Hosts in NO_PROXY that exclude any metabob target. */
  noProxyExcludesMetabob: string[];
  /** NODE_EXTRA_CA_CERTS path + parse result. */
  nodeExtraCaCerts: {
    path: string;
    exists: boolean;
    parseError?: string;
    certCount: number;
    /** SHA-1 fingerprints of CAs that are NOT in the bundled Mozilla set. */
    nonStandardFingerprintsSha1: string[];
  } | null;
}

export interface DnsProbeResult {
  host: string;
  addresses: string[];
  durationMs: number;
  error?: string;
  suspiciousPrivateIp?: boolean;
}

export interface MitmCaMatch {
  vendor: string;
  cn?: string;
  o?: string;
}

export interface TrustStoreSnapshot {
  systemCertCount: number;
  bundledCertCount: number;
  systemCertLoadError?: string;
  /** True when the OS trust store is skipped because the optional native
   * helper isn't installed, NOT because of a probe failure. */
  systemCertSkipped?: boolean;
  systemCertSkipReason?: string;
  mitmCaMatches: MitmCaMatch[];
}

export interface PeerCertSummary {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  fingerprint256: string;
  spkiFingerprint?: string;
}

export interface TlsHandshakeResult {
  host: string;
  port: number;
  durationMs: number;
  protocol: string | null;
  alpn: string | null;
  chain: PeerCertSummary[];
  rootInMozillaBundle: boolean;
  rootInOsTrustStore: boolean;
  rootIssuer: string | null;
  mitmSuspected: boolean;
  mitmVendor?: string;
  /** True when the probe was routed through HTTPS_PROXY via CONNECT. */
  viaProxy: boolean;
  proxyUrl?: string;
  error?: string;
}

export interface HttpsProbeResult {
  url: string;
  durationMs: number;
  statusDefault: number | null;
  errorDefault?: string;
  statusOsTrust: number | null;
  errorOsTrust?: string;
  mitmConfirmed: boolean;
  /** True when the probe was routed through HTTPS_PROXY via CONNECT. */
  viaProxy: boolean;
  proxyUrl?: string;
}

export interface SubstrateTargets {
  /** Every configured substrate URL, anchor first. */
  urls: string[];
  /** Hosts with an https URL: the ones TLS can be diagnosed for. */
  tlsHosts: string[];
  /** Plain-http URLs: reachability only, there is no TLS to inspect. */
  plainHttpUrls: string[];
  /** Set when the key or the endpoint is missing (config.ts unattachedMessage). */
  unattached: string | null;
}

export interface ConfigSnapshot {
  configPath: string;
  configExists: boolean;
  apiKeyConfigured: boolean;
  apiKeyRedacted?: string;
  endpoint?: string;
  knownHostsPath: string;
  knownHosts: Record<string, { fingerprint: string; recordedAt: string }>;
}

export type DiagnosisSeverity = 'info' | 'warn' | 'error';

export interface DiagnosisObservation {
  severity: DiagnosisSeverity;
  /** Short machine-readable code, e.g. 'dns-fail', 'proxy-required', 'service-5xx'. */
  code: string;
  /** Human-readable one-line summary. */
  message: string;
  /** Optional verification step the user can run to confirm. */
  verify?: string;
  /** Optional remediation action (singular, falsifiable). */
  action?: string;
}

export interface Diagnosis {
  /** Overall rollup: `ok` when no error observations, `degraded` for warnings,
   * `failed` when any error observation is present. */
  status: 'ok' | 'mitm-handled' | 'mitm-failed' | 'unreachable' | 'degraded' | 'failed' | 'unknown';
  summary: string;
  /** Backward-compat flat list. Derived from `observations`. */
  suggestedActions: string[];
  observations: DiagnosisObservation[];
}

export interface RunDoctorOptions {
  /** Override probe target hosts (default: the configured substrate's https hosts). */
  hosts?: string[];
  /** Override output path for JSON artifact. */
  artifactPath?: string;
  /** Suppress writing artifact (for tests). */
  noArtifact?: boolean;
  /** Suppress stdout output (for tests). */
  silent?: boolean;
  /** Override default 5s per-probe timeout. */
  probeTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REFERENCE_HOST = 'registry.npmjs.org';

const MITM_CA_VENDORS: Array<{ pattern: RegExp; vendor: string }> = [
  { pattern: /zscaler/i, vendor: 'Zscaler' },
  { pattern: /netskope/i, vendor: 'Netskope' },
  { pattern: /forcepoint|websense/i, vendor: 'Forcepoint' },
  { pattern: /paloalto|palo alto|prisma/i, vendor: 'Palo Alto Networks' },
  { pattern: /symantec|broadcom/i, vendor: 'Symantec/Broadcom' },
  { pattern: /bluecoat|blue coat/i, vendor: 'Blue Coat' },
  { pattern: /mcafee/i, vendor: 'McAfee' },
  { pattern: /sophos/i, vendor: 'Sophos' },
  { pattern: /trendmicro|trend micro/i, vendor: 'Trend Micro' },
  { pattern: /fortinet|fortigate/i, vendor: 'Fortinet' },
  { pattern: /checkpoint|check point/i, vendor: 'Check Point' },
  { pattern: /cisco umbrella|opendns/i, vendor: 'Cisco Umbrella' },
  { pattern: /cisco/i, vendor: 'Cisco (possible MITM)' },
];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function colorsEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function color(s: string, c: keyof typeof ANSI, enabled: boolean): string {
  return enabled ? `${ANSI[c]}${s}${ANSI.reset}` : s;
}

function redact(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function isPrivateIp(ip: string): boolean {
  // RFC1918 / loopback / link-local
  if (ip === '127.0.0.1' || ip.startsWith('127.')) return true;
  if (ip === '0.0.0.0') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
  if (ip.startsWith('169.254.')) return true;
  return false;
}

function readMetabobMcpVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, '..', 'package.json'),
      path.join(here, 'package.json'),
      path.join(process.cwd(), 'package.json'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const pkg = JSON.parse(fs.readFileSync(c, 'utf-8'));
        if (pkg.name === '@metabob/mcp' && typeof pkg.version === 'string') {
          return pkg.version;
        }
      }
    }
  } catch {
    // fall through
  }
  return 'unknown';
}

function describeSubject(subject: tls.PeerCertificate['subject'] | undefined): string {
  if (!subject) return 'unknown';
  const s = subject as unknown as Record<string, string | undefined>;
  const parts: string[] = [];
  if (s.CN) parts.push(`CN=${s.CN}`);
  if (s.O) parts.push(`O=${s.O}`);
  if (s.OU) parts.push(`OU=${s.OU}`);
  return parts.length > 0 ? parts.join(', ') : 'unknown';
}

function derToPem(der: Buffer): string {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return ['-----BEGIN CERTIFICATE-----', ...lines, '-----END CERTIFICATE-----'].join('\n') + '\n';
}

export function matchMitmVendor(subjectOrIssuer: string): MitmCaMatch | null {
  for (const { pattern, vendor } of MITM_CA_VENDORS) {
    if (pattern.test(subjectOrIssuer)) {
      return { vendor, cn: subjectOrIssuer };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

function snapshotEnvironment(): EnvironmentSnapshot {
  const bunVersion =
    typeof (globalThis as { Bun?: { version: string } }).Bun !== 'undefined'
      ? ((globalThis as { Bun?: { version: string } }).Bun?.version ?? null)
      : null;

  const envVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (/PROXY|CA|SSL|TLS|NODE_/i.test(k)) {
      // Skip noisy NODE_ keys that don't matter for diagnostics.
      if (k === 'NODE' || k === 'NODE_PATH' || k === 'NODE_ENV') {
        envVars[k] = v.length > 80 ? redact(v) : v;
        continue;
      }
      envVars[k] = v.length > 8 ? redact(v) : '****';
    }
  }

  return {
    nodeVersion: process.version,
    bunVersion,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cwd: process.cwd(),
    envVars,
  };
}

function detectProxyScheme(url: string | null): 'http' | 'https' | 'socks' | 'unknown' | null {
  if (!url) return null;
  if (/^socks/i.test(url)) return 'socks';
  if (/^https:/i.test(url)) return 'https';
  if (/^http:/i.test(url)) return 'http';
  return 'unknown';
}

/** Inspect NODE_EXTRA_CA_CERTS file (if set) and return parse details. */
function inspectNodeExtraCaCerts(): ProxySnapshot['nodeExtraCaCerts'] {
  const p = process.env.NODE_EXTRA_CA_CERTS;
  if (!p) return null;
  const exists = fs.existsSync(p);
  if (!exists) {
    return { path: p, exists: false, certCount: 0, nonStandardFingerprintsSha1: [] };
  }
  try {
    const pem = fs.readFileSync(p, 'utf-8');
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    const bundled = new Set(tls.rootCertificates.map((c) => c.replace(/\s+/g, '')));
    const nonStandard: string[] = [];
    for (const block of blocks) {
      try {
        const x509 = new crypto.X509Certificate(block);
        // Normalize for set comparison: bundle PEMs vary in trailing newlines.
        const normalized = block.replace(/\s+/g, '');
        if (!bundled.has(normalized)) {
          nonStandard.push(x509.fingerprint); // SHA-1 colon-separated
        }
      } catch {
        // skip unparseable block
      }
    }
    return { path: p, exists: true, certCount: blocks.length, nonStandardFingerprintsSha1: nonStandard };
  } catch (err) {
    return {
      path: p,
      exists: true,
      certCount: 0,
      nonStandardFingerprintsSha1: [],
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

function snapshotProxy(anchorHosts: readonly string[]): ProxySnapshot {
  const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy ?? null;
  const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null;
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? null;

  // Resolve the effective proxy for the anchor host (honors NO_PROXY).
  const anchor = anchorHosts[0];
  const effective = anchor ? proxyForUrl(`https://${anchor}/`) : '';
  const effectiveProxyForMetabob = effective && effective.length > 0 ? effective : null;

  // Detect which substrate hosts are excluded by NO_PROXY.
  const noProxyExcludesMetabob: string[] = [];
  for (const h of anchorHosts) {
    const eff = proxyForUrl(`https://${h}/`);
    if (httpsProxy && (!eff || eff.length === 0)) {
      noProxyExcludesMetabob.push(h);
    }
  }

  return {
    httpProxy,
    httpsProxy,
    noProxy,
    npmProxy: null,
    npmHttpsProxy: null,
    effectiveProxyForMetabob,
    proxyScheme: detectProxyScheme(effectiveProxyForMetabob ?? httpsProxy ?? httpProxy),
    noProxyExcludesMetabob,
    nodeExtraCaCerts: inspectNodeExtraCaCerts(),
  };
}

async function probeDns(host: string, timeoutMs: number): Promise<DnsProbeResult> {
  const start = performance.now();
  try {
    const addresses = await Promise.race([
      dns.resolve4(host),
      new Promise<string[]>((_, reject) =>
        setTimeout(() => reject(new Error('dns timeout')), timeoutMs),
      ),
    ]);
    const suspicious = addresses.some(isPrivateIp);
    return {
      host,
      addresses,
      durationMs: Math.round(performance.now() - start),
      suspiciousPrivateIp: suspicious,
    };
  } catch (err) {
    return {
      host,
      addresses: [],
      durationMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function snapshotTrustStore(): { snapshot: TrustStoreSnapshot; systemCerts: string[] } {
  let systemCerts: string[] = [];
  let loadError: string | undefined;
  let skipped = false;
  let skipReason: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { systemCertsSync } = require('system-ca') as typeof import('system-ca');
    systemCerts = systemCertsSync({ includeNodeCertificates: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // On Windows, system-ca uses the optional `win-export-certificate-and-key`
    // native module. On macOS it uses `macos-export-certificate-and-key`. When
    // those aren't installed (they're heavy native deps and ship as optional),
    // the failure is a known-skip, not a probe failure.
    const isOptionalNativeMissing =
      /win-export-certificate-and-key|macos-export-certificate-and-key/.test(msg) ||
      /Cannot (find|require) module/i.test(msg);
    if (isOptionalNativeMissing) {
      skipped = true;
      skipReason = msg;
    } else {
      loadError = msg;
    }
  }

  const bundled = new Set(tls.rootCertificates);
  const additions = systemCerts.filter((pem) => !bundled.has(pem));

  // Inspect additions for MITM CA vendors.
  const matches: MitmCaMatch[] = [];
  for (const pem of additions) {
    let subjectStr = '';
    try {
      // Parse subject via X509Certificate.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const crypto = require('node:crypto');
      const x509 = new crypto.X509Certificate(pem);
      subjectStr = `${x509.subject ?? ''}`;
    } catch {
      continue;
    }
    const match = matchMitmVendor(subjectStr);
    if (match) {
      matches.push(match);
    }
  }

  return {
    snapshot: {
      systemCertCount: systemCerts.length,
      bundledCertCount: tls.rootCertificates.length,
      systemCertLoadError: loadError,
      systemCertSkipped: skipped,
      systemCertSkipReason: skipReason,
      mitmCaMatches: matches,
    },
    systemCerts,
  };
}

/**
 * Open a TCP socket to an HTTP CONNECT proxy and request a tunnel to
 * `host:port`. Resolves with the underlying socket once the proxy returns
 * 200, or rejects on any error / non-200 response.
 */
function openProxyTunnel(
  proxyUrl: string,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(proxyUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const proxyPort = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const proxyHost = u.hostname;

    let settled = false;
    const cleanup = (sock: net.Socket | null, err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        try { sock?.destroy(); } catch { /* ignore */ }
        reject(err);
      } else if (sock) {
        resolve(sock);
      }
    };

    // For an `https:` proxy the CONNECT request itself rides on TLS to the
    // proxy. For an `http:` proxy it's plain TCP.
    const socket: net.Socket =
      u.protocol === 'https:'
        ? tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost })
        : net.connect({ host: proxyHost, port: proxyPort });

    const timer = setTimeout(
      () => cleanup(socket, new Error(`proxy tunnel timeout to ${proxyHost}:${proxyPort}`)),
      timeoutMs,
    );

    socket.once('error', (err) => {
      clearTimeout(timer);
      cleanup(socket, err);
    });

    const onReady = () => {
      const auth = u.username
        ? `Proxy-Authorization: Basic ${Buffer.from(
            `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password ?? '')}`,
          ).toString('base64')}\r\n`
        : '';
      const req =
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        auth +
        `\r\n`;
      socket.write(req);

      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        socket.removeListener('data', onData);
        const head = buf.slice(0, idx);
        const m = head.match(/^HTTP\/\d\.\d (\d+) (.*?)\r?\n/);
        if (!m) {
          clearTimeout(timer);
          cleanup(socket, new Error(`malformed proxy response: ${head.slice(0, 80)}`));
          return;
        }
        const code = Number(m[1]);
        if (code !== 200) {
          clearTimeout(timer);
          cleanup(socket, new Error(`proxy returned HTTP ${code} ${m[2]} for CONNECT ${targetHost}:${targetPort}`));
          return;
        }
        clearTimeout(timer);
        // Leftover bytes after headers would be TLS bytes — but we haven't
        // started TLS yet, so the server shouldn't be sending any.
        cleanup(socket);
      };
      socket.on('data', onData);
    };

    if (u.protocol === 'https:') {
      (socket as tls.TLSSocket).once('secureConnect', onReady);
    } else {
      socket.once('connect', onReady);
    }
  });
}

async function probeTlsHandshake(
  host: string,
  systemCerts: ReadonlyArray<string>,
  timeoutMs: number,
  port = 443,
): Promise<TlsHandshakeResult> {
  const start = performance.now();
  const bundled = new Set(tls.rootCertificates);
  const systemSet = new Set(systemCerts);

  // Honor HTTPS_PROXY + NO_PROXY for the raw TLS probe. Without this, the
  // probe bypasses the proxy and looks like a network failure even when the
  // proxy is the required egress path.
  const proxyUrl = proxyForUrl(`https://${host}/`);
  const viaProxy = Boolean(proxyUrl);

  let baseSocket: net.Socket | null = null;
  if (proxyUrl) {
    try {
      baseSocket = await openProxyTunnel(proxyUrl, host, port, timeoutMs);
    } catch (err) {
      return {
        host,
        port,
        durationMs: Math.round(performance.now() - start),
        protocol: null,
        alpn: null,
        chain: [],
        rootInMozillaBundle: false,
        rootInOsTrustStore: false,
        rootIssuer: null,
        mitmSuspected: false,
        viaProxy: true,
        proxyUrl,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return new Promise<TlsHandshakeResult>((resolve) => {
    let settled = false;
    const finish = (r: TlsHandshakeResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let socket: tls.TLSSocket;
    try {
      socket = tls.connect({
        host: baseSocket ? undefined : host,
        port: baseSocket ? undefined : port,
        socket: baseSocket ?? undefined,
        servername: host,
        ALPNProtocols: ['h2', 'http/1.1'],
        rejectUnauthorized: false, // capture chain even if invalid
      });
    } catch (err) {
      finish({
        host,
        port,
        durationMs: Math.round(performance.now() - start),
        protocol: null,
        alpn: null,
        chain: [],
        rootInMozillaBundle: false,
        rootInOsTrustStore: false,
        rootIssuer: null,
        mitmSuspected: false,
        viaProxy,
        proxyUrl: proxyUrl || undefined,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      socket.destroy(new Error('handshake timeout'));
    }, timeoutMs);

    socket.on('secureConnect', () => {
      try {
        const peer = socket.getPeerCertificate(true);
        const chain: PeerCertSummary[] = [];
        const seen = new Set<string>();
        let cur: typeof peer | undefined = peer;
        let rootSubject: string | null = null;
        let rootPem: string | undefined;

        while (cur && cur.fingerprint256 && !seen.has(cur.fingerprint256)) {
          seen.add(cur.fingerprint256);
          chain.push({
            subject: describeSubject(cur.subject),
            issuer: describeSubject(cur.issuer),
            validFrom: cur.valid_from ?? '',
            validTo: cur.valid_to ?? '',
            fingerprint256: cur.fingerprint256 ?? '',
          });
          if (cur.issuerCertificate && cur.issuerCertificate !== cur) {
            cur = cur.issuerCertificate;
          } else {
            // self-signed root
            if (cur.raw) {
              rootPem = derToPem(cur.raw);
            }
            rootSubject = describeSubject(cur.subject);
            cur = undefined;
          }
        }

        const rootInBundle = rootPem ? bundled.has(rootPem) : false;
        const rootInSystem = rootPem ? systemSet.has(rootPem) : false;

        // Identify MITM vendor by inspecting cert chain subjects/issuers.
        let mitmVendor: string | undefined;
        for (const c of chain) {
          const m = matchMitmVendor(c.subject) ?? matchMitmVendor(c.issuer);
          if (m) {
            mitmVendor = m.vendor;
            break;
          }
        }
        if (!mitmVendor && rootSubject) {
          const m = matchMitmVendor(rootSubject);
          if (m) mitmVendor = m.vendor;
        }

        const mitmSuspected = !rootInBundle && (rootInSystem || mitmVendor != null);

        const protocol = socket.getProtocol();
        const alpn = (socket as unknown as { alpnProtocol?: string | false }).alpnProtocol;
        const alpnStr = typeof alpn === 'string' && alpn.length > 0 ? alpn : null;

        clearTimeout(timer);
        try {
          socket.end();
        } catch {
          // ignore
        }

        finish({
          host,
          port,
          durationMs: Math.round(performance.now() - start),
          protocol,
          alpn: alpnStr,
          chain,
          rootInMozillaBundle: rootInBundle,
          rootInOsTrustStore: rootInSystem,
          rootIssuer: rootSubject,
          mitmSuspected,
          mitmVendor,
          viaProxy,
          proxyUrl: proxyUrl || undefined,
        });
      } catch (err) {
        clearTimeout(timer);
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        finish({
          host,
          port,
          durationMs: Math.round(performance.now() - start),
          protocol: null,
          alpn: null,
          chain: [],
          rootInMozillaBundle: false,
          rootInOsTrustStore: false,
          rootIssuer: null,
          mitmSuspected: false,
          viaProxy,
          proxyUrl: proxyUrl || undefined,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      finish({
        host,
        port,
        durationMs: Math.round(performance.now() - start),
        protocol: null,
        alpn: null,
        chain: [],
        rootInMozillaBundle: false,
        rootInOsTrustStore: false,
        rootIssuer: null,
        mitmSuspected: false,
        viaProxy,
        proxyUrl: proxyUrl || undefined,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

async function probeHttps(
  url: string,
  systemCerts: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<HttpsProbeResult> {
  const start = performance.now();
  const proxyUrl = proxyForUrl(url);
  const viaProxy = Boolean(proxyUrl);

  // Read NODE_EXTRA_CA_CERTS into PEM string(s) once. Node's globalAgent
  // already injects this on its own, but custom agents (HttpsProxyAgent) need
  // it passed explicitly so we don't drop the user's bundle.
  let nodeExtraCaPems: string[] = [];
  if (process.env.NODE_EXTRA_CA_CERTS) {
    try {
      const pem = fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf-8');
      nodeExtraCaPems = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    } catch {
      // ignore — surfaced separately in ProxySnapshot.nodeExtraCaCerts
    }
  }

  const doOne = async (extraCa: string[] | undefined): Promise<{ status: number | null; error?: string }> => {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (r: { status: number | null; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      const u = new URL(url);
      const opts: https.RequestOptions = {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        timeout: timeoutMs,
      };
      // Merge extra CAs with NODE_EXTRA_CA_CERTS so the OS-trust probe and the
      // default-trust probe both honor the user's explicit bundle.
      const mergedCa = [...(extraCa ?? []), ...nodeExtraCaPems];
      if (mergedCa.length > 0) {
        opts.ca = mergedCa;
      }
      if (proxyUrl) {
        opts.agent = new HttpsProxyAgent(proxyUrl, {
          ca: opts.ca,
          timeout: timeoutMs,
        });
      }
      const req = https.request(opts, (res) => {
        // Drain response to free socket
        res.on('data', () => undefined);
        res.on('end', () => settle({ status: res.statusCode ?? null }));
        res.on('error', (err) => settle({ status: null, error: err.message }));
      });
      req.on('timeout', () => {
        req.destroy(new Error('request timeout'));
      });
      req.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        settle({ status: null, error: code ? `${code}: ${err.message}` : err.message });
      });
      req.end();
    });
  };

  // Default trust = Mozilla bundled only.
  const defaultResult = await doOne(undefined);

  // OS-trust = bundled + system additions.
  const merged = Array.from(new Set([...tls.rootCertificates, ...systemCerts]));
  const osTrustResult = await doOne(merged);

  return {
    url,
    durationMs: Math.round(performance.now() - start),
    statusDefault: defaultResult.status,
    errorDefault: defaultResult.error,
    statusOsTrust: osTrustResult.status,
    errorOsTrust: osTrustResult.error,
    mitmConfirmed: defaultResult.status === null && osTrustResult.status !== null,
    viaProxy,
    proxyUrl: proxyUrl || undefined,
  };
}

function snapshotConfig(): ConfigSnapshot {
  const configPath = process.env.METABOB_CONFIG_PATH ?? getDefaultConfigPath();
  const knownHostsPath = path.join(os.homedir(), '.metabob', 'known-hosts.json');

  let apiKeyConfigured = false;
  let apiKeyRedacted: string | undefined;
  let endpoint: string | undefined;
  const configExists = fs.existsSync(configPath);
  if (configExists) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const key = cfg?.metabob?.apiKey ?? cfg?.instance?.apiKey;
      if (typeof key === 'string' && key.length > 0) {
        apiKeyConfigured = true;
        apiKeyRedacted = redact(key);
      }
      if (typeof cfg?.metabob?.endpoint === 'string') {
        endpoint = cfg.metabob.endpoint;
      }
    } catch {
      // ignore
    }
  }

  let knownHosts: ConfigSnapshot['knownHosts'] = {};
  try {
    const kh = readKnownHosts(knownHostsPath);
    knownHosts = kh.hosts;
  } catch {
    // ignore
  }

  return {
    configPath,
    configExists,
    apiKeyConfigured,
    apiKeyRedacted,
    endpoint,
    knownHostsPath,
    knownHosts,
  };
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/**
 * Build a list of observations from the probe results. Each observation is an
 * independent, actionable statement about something we measured. The status
 * rollup is derived from the highest severity observation:
 *   - any 'error' → 'failed' (with specific aliases for back-compat:
 *     'unreachable' when all metabob HTTPS+TLS fail, 'mitm-failed' when MITM
 *     stops HTTPS, 'mitm-handled' when OS-trust restores it)
 *   - else any 'warn' → 'degraded' (or 'ok' if only soft warnings)
 *   - else → 'ok'
 */
export function synthesizeDiagnosis(input: {
  dns: Record<string, DnsProbeResult>;
  tlsHandshakes: Record<string, TlsHandshakeResult>;
  httpsProbes: Record<string, HttpsProbeResult>;
  trustStore: TrustStoreSnapshot;
  proxy?: ProxySnapshot;
  /** The substrate hosts (default: every probed host but the reference host). */
  anchorHosts?: readonly string[];
}): Diagnosis {
  const observations: DiagnosisObservation[] = [];
  const anchorSet = new Set(
    input.anchorHosts ?? Object.keys(input.tlsHandshakes).filter((h) => h !== REFERENCE_HOST),
  );
  const metabobHosts = Object.keys(input.tlsHandshakes).filter((h) => anchorSet.has(h));
  const firstHost = metabobHosts[0] ?? [...anchorSet][0] ?? '<substrate host>';

  // 1. DNS observations.
  const dnsFailures = metabobHosts.filter((h) => {
    const r = input.dns[h];
    return !r || r.error || r.addresses.length === 0;
  });
  if (dnsFailures.length === metabobHosts.length && metabobHosts.length > 0) {
    observations.push({
      severity: 'error',
      code: 'dns-fail',
      message: 'DNS resolution failed for every substrate host.',
      verify: `nslookup ${firstHost}`,
      action: 'Check your DNS resolver and confirm that the substrate host resolves from this network.',
    });
  } else if (dnsFailures.length > 0) {
    observations.push({
      severity: 'warn',
      code: 'dns-partial',
      message: `DNS resolution failed for ${dnsFailures.join(', ')}.`,
      verify: `nslookup ${dnsFailures[0]}`,
    });
  }

  // 2. HTTPS-probe-driven reachability assessment. Note: HTTPS probes are
  //    proxy-aware. If they succeed, the host IS reachable, regardless of
  //    what the raw TLS probe says.
  const metabobHttpsProbes = Object.values(input.httpsProbes).filter((p) => {
    try { return anchorSet.has(new URL(p.url).hostname); } catch { return false; }
  });
  const httpsReachable = metabobHttpsProbes.filter(
    (p) => p.statusDefault !== null || p.statusOsTrust !== null,
  );
  const httpsUnreachable = metabobHttpsProbes.filter(
    (p) => p.statusDefault === null && p.statusOsTrust === null,
  );

  const proxySet = Boolean(input.proxy?.effectiveProxyForMetabob);
  const proxyUrl = input.proxy?.effectiveProxyForMetabob;

  if (metabobHttpsProbes.length > 0 && httpsUnreachable.length === metabobHttpsProbes.length) {
    // All HTTPS probes failed.
    if (proxySet) {
      observations.push({
        severity: 'error',
        code: 'proxy-unreachable',
        message: `Proxy ${proxyUrl} is configured but no substrate host is reachable through it.`,
        verify: `curl -x ${proxyUrl} -I https://${firstHost}/`,
        action: `Ask IT to confirm that ${firstHost} is on the proxy allowlist and that the proxy itself is reachable.`,
      });
    } else {
      observations.push({
        severity: 'error',
        code: 'egress-blocked',
        message: 'Direct egress to the substrate host is blocked, and no HTTPS_PROXY is configured.',
        verify: `curl -I https://${firstHost}/`,
        action: 'On a corporate network: set HTTPS_PROXY to your proxy URL. Otherwise: check VPN / firewall rules.',
      });
    }
  } else if (httpsReachable.length > 0) {
    // Surface service-level 5xx responses separately from connectivity.
    for (const p of httpsReachable) {
      const status = p.statusOsTrust ?? p.statusDefault;
      const host = (() => { try { return new URL(p.url).hostname; } catch { return p.url; } })();
      if (status !== null && status >= 500 && status < 600) {
        observations.push({
          severity: 'warn',
          code: 'service-5xx',
          message: `${host} is reachable but returned HTTP ${status}. This is a service-side issue, not a connectivity problem on your end.`,
        });
      }
    }
  }

  // 3. Raw TLS probe vs HTTPS probe divergence.
  //    If the HTTPS probe succeeded through the proxy but the raw TLS probe
  //    failed (and was NOT routed through the proxy because direct-connect
  //    isn't allowed), explain it instead of treating it as a failure.
  const tlsFailedHosts = metabobHosts.filter((h) => {
    const t = input.tlsHandshakes[h];
    return t && t.error;
  });
  const httpsOkHosts = new Set(
    httpsReachable
      .map((p) => { try { return new URL(p.url).hostname; } catch { return null; } })
      .filter((h): h is string => Boolean(h)),
  );
  const tlsFailHttpsOk = tlsFailedHosts.filter((h) => httpsOkHosts.has(h));
  if (tlsFailHttpsOk.length > 0 && proxySet) {
    const allViaProxy = tlsFailHttpsOk.every((h) => input.tlsHandshakes[h]?.viaProxy);
    if (!allViaProxy) {
      observations.push({
        severity: 'info',
        code: 'tls-direct-blocked',
        message: `Raw TLS probes to ${tlsFailHttpsOk.join(', ')} bypassed the proxy and failed; HTTPS probes through the proxy succeeded. Direct TLS egress is blocked, which is normal in proxy-required networks.`,
      });
    } else {
      observations.push({
        severity: 'warn',
        code: 'tls-via-proxy-fail',
        message: `TLS handshake through proxy ${proxyUrl} failed for ${tlsFailHttpsOk.join(', ')}, but HTTPS probes succeeded. This usually indicates the proxy permits HTTPS/CONNECT only on specific paths or methods.`,
      });
    }
  } else if (tlsFailedHosts.length === metabobHosts.length && metabobHosts.length > 0 && httpsReachable.length === 0) {
    // already covered by egress-blocked / proxy-unreachable above
  }

  // 4. TLS interception detection. Two evidence paths:
  //    (a) HTTPS probe diverges (default fails, OS-trust succeeds) → confirmed.
  //    (b) TLS handshake chain shows a known MITM vendor / non-Mozilla root → suspected.
  const mitmConfirmed = metabobHttpsProbes.filter((p) => p.mitmConfirmed);
  const mitmSuspectedHosts = metabobHosts.filter((h) => input.tlsHandshakes[h]?.mitmSuspected);
  const vendor = metabobHosts
    .map((h) => input.tlsHandshakes[h]?.mitmVendor)
    .find((v): v is string => Boolean(v));
  if (mitmConfirmed.length > 0 || mitmSuspectedHosts.length > 0) {
    observations.push({
      severity: 'warn',
      code: 'mitm-detected',
      message: `TLS interception detected${vendor ? ` (vendor: ${vendor})` : ''}. The default Mozilla CA chain rejects the cert; ${mitmConfirmed.length > 0 ? 'the OS trust store accepts it.' : 'a non-Mozilla root signs the chain.'}`,
      action: 'Set NODE_EXTRA_CA_CERTS=/path/to/corp-root.pem so the MCP client trusts the corporate root.',
    });
  }

  // 6. OS trust store skipped (not a failure).
  if (input.trustStore.systemCertSkipped) {
    observations.push({
      severity: 'info',
      code: 'os-trust-skipped',
      message: 'OS trust store inspection was skipped because the optional native helper is not installed.',
      action: process.platform === 'win32'
        ? 'Install `win-export-certificate-and-key` (npm i -g win-export-certificate-and-key) or run on Node ≥ 22 with `--use-system-ca`.'
        : process.platform === 'darwin'
        ? 'Install `macos-export-certificate-and-key` or run on Node ≥ 22 with `--use-system-ca`.'
        : 'Run on Node ≥ 22 with `--use-system-ca` to read the OS trust store.',
    });
  } else if (input.trustStore.systemCertLoadError) {
    observations.push({
      severity: 'warn',
      code: 'os-trust-error',
      message: `OS trust store could not be loaded: ${input.trustStore.systemCertLoadError}`,
    });
  }

  // 7. NODE_EXTRA_CA_CERTS sanity.
  const extra = input.proxy?.nodeExtraCaCerts ?? null;
  if (extra) {
    if (!extra.exists) {
      observations.push({
        severity: 'error',
        code: 'extra-ca-missing',
        message: `NODE_EXTRA_CA_CERTS points to ${extra.path} but the file does not exist.`,
        action: 'Fix the path or unset NODE_EXTRA_CA_CERTS.',
      });
    } else if (extra.parseError) {
      observations.push({
        severity: 'error',
        code: 'extra-ca-parse',
        message: `NODE_EXTRA_CA_CERTS (${extra.path}) could not be read: ${extra.parseError}.`,
      });
    } else if (extra.certCount === 0) {
      observations.push({
        severity: 'warn',
        code: 'extra-ca-empty',
        message: `NODE_EXTRA_CA_CERTS (${extra.path}) contains no parseable PEM certificates.`,
      });
    } else {
      observations.push({
        severity: 'info',
        code: 'extra-ca-loaded',
        message: `NODE_EXTRA_CA_CERTS is in effect: ${extra.certCount} cert(s) loaded from ${extra.path}${extra.nonStandardFingerprintsSha1.length > 0 ? `, ${extra.nonStandardFingerprintsSha1.length} non-Mozilla root(s)` : ''}.`,
      });
    }
  }

  // 8. NO_PROXY excludes metabob (only relevant if HTTPS_PROXY is set).
  if (input.proxy?.httpsProxy && input.proxy.noProxyExcludesMetabob.length > 0) {
    observations.push({
      severity: 'warn',
      code: 'no-proxy-excludes-metabob',
      message: `NO_PROXY excludes ${input.proxy.noProxyExcludesMetabob.join(', ')} from the proxy; direct TLS will be attempted to these hosts.`,
    });
  }

  // Derive status + summary.
  const hasError = observations.some((o) => o.severity === 'error');
  const hasWarn = observations.some((o) => o.severity === 'warn');

  let status: Diagnosis['status'];
  let summary: string;

  // Back-compat status aliases for existing consumers.
  const mitmEvidence = mitmConfirmed.length > 0 || mitmSuspectedHosts.length > 0;
  if (
    mitmEvidence &&
    metabobHttpsProbes.length > 0 &&
    metabobHttpsProbes.every((p) => p.statusOsTrust !== null)
  ) {
    status = 'mitm-handled';
    summary = `TLS interception detected${vendor ? ` (vendor: ${vendor})` : ''}; reachable via OS-trust / NODE_EXTRA_CA_CERTS.`;
  } else if (
    mitmEvidence &&
    metabobHttpsProbes.length > 0 &&
    httpsUnreachable.length === metabobHttpsProbes.length
  ) {
    status = 'mitm-failed';
    summary = `TLS interception detected${vendor ? ` (vendor: ${vendor})` : ''} and the bundled mitigations did not restore connectivity.`;
  } else if (
    hasError &&
    metabobHosts.length > 0 &&
    metabobHosts.every((h) => {
      const t = input.tlsHandshakes[h];
      const p = Object.values(input.httpsProbes).find((pp) => {
        try { return new URL(pp.url).hostname === h; } catch { return false; }
      });
      const tlsFailed = !t || Boolean(t.error);
      const httpsFailed = !p || (p.statusDefault === null && p.statusOsTrust === null);
      return tlsFailed && httpsFailed;
    })
  ) {
    status = 'unreachable';
    summary = proxySet
      ? `No substrate host is reachable through proxy ${proxyUrl}.`
      : 'No substrate host is reachable from this network.';
  } else if (hasError) {
    status = 'failed';
    summary = 'One or more probes returned an error. See observations below.';
  } else if (hasWarn) {
    status = httpsReachable.length === metabobHttpsProbes.length && metabobHttpsProbes.length > 0
      ? 'degraded'
      : 'degraded';
    summary = 'Substrate hosts are reachable, with caveats. See observations below.';
  } else if (metabobHttpsProbes.length > 0 && httpsReachable.length === metabobHttpsProbes.length) {
    status = 'ok';
    summary = proxySet
      ? `All substrate hosts reachable through proxy ${proxyUrl}.`
      : 'All substrate hosts reachable. No TLS interception detected.';
  } else if (
    metabobHttpsProbes.length === 0 &&
    metabobHosts.length > 0 &&
    metabobHosts.every((h) => {
      const t = input.tlsHandshakes[h];
      return t && !t.error && !t.mitmSuspected;
    })
  ) {
    // No HTTPS probes were run, but raw TLS to every metabob host succeeded
    // with a bundled root — treat as ok.
    status = 'ok';
    summary = 'No TLS interception detected. Substrate hosts are reachable with the bundled Mozilla CA chain.';
  } else {
    status = 'unknown';
    summary = 'Probes did not produce enough signal to render a diagnosis.';
  }

  // Sort observations: error → warn → info, preserve insertion order within.
  const order: Record<DiagnosisSeverity, number> = { error: 0, warn: 1, info: 2 };
  observations.sort((a, b) => order[a.severity] - order[b.severity]);

  // Back-compat flat suggestedActions list (extracted from observations).
  const suggestedActions = observations
    .map((o) => o.action)
    .filter((a): a is string => Boolean(a));

  return { status, summary, observations, suggestedActions };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function renderReport(report: DoctorReport): string {
  const useColor = colorsEnabled();
  const c = (s: string, color: keyof typeof ANSI) =>
    useColor ? `${ANSI[color]}${s}${ANSI.reset}` : s;
  const check = c('✓', 'green');
  const cross = c('✗', 'red');
  const warn = c('⚠', 'yellow');

  const lines: string[] = [];
  lines.push(c(`metabob-mcp doctor — v${report.metabobMcpVersion}`, 'bold'));
  lines.push(c(`generated ${report.generatedAt} (${report.durationMs}ms)`, 'dim'));
  lines.push('');

  // Environment
  lines.push(c('Environment', 'bold'));
  lines.push(`  Node:     ${report.environment.nodeVersion}`);
  lines.push(`  Bun:      ${report.environment.bunVersion ?? 'n/a'}`);
  lines.push(`  Platform: ${report.environment.platform} ${report.environment.arch} (${report.environment.osRelease})`);
  const envKeys = Object.keys(report.environment.envVars);
  if (envKeys.length > 0) {
    lines.push(`  Env vars: ${envKeys.join(', ')}`);
  }
  lines.push('');

  // Proxy
  lines.push(c('Proxy', 'bold'));
  if (
    !report.proxy.httpProxy &&
    !report.proxy.httpsProxy &&
    !report.proxy.noProxy &&
    !report.proxy.nodeExtraCaCerts
  ) {
    lines.push(`  ${check} no proxy environment variables set`);
  } else {
    if (report.proxy.httpProxy) lines.push(`  HTTP_PROXY=${report.proxy.httpProxy}`);
    if (report.proxy.httpsProxy) lines.push(`  HTTPS_PROXY=${report.proxy.httpsProxy}`);
    if (report.proxy.noProxy) lines.push(`  NO_PROXY=${report.proxy.noProxy}`);
    if (report.proxy.effectiveProxyForMetabob) {
      lines.push(`  ${check} effective proxy for the substrate host: ${report.proxy.effectiveProxyForMetabob} (${report.proxy.proxyScheme})`);
    } else if (report.proxy.httpsProxy) {
      lines.push(`  ${warn} HTTPS_PROXY is set but does not apply to the substrate host (excluded by NO_PROXY)`);
    }
    if (report.proxy.noProxyExcludesMetabob.length > 0) {
      lines.push(`  ${warn} NO_PROXY excludes: ${report.proxy.noProxyExcludesMetabob.join(', ')}`);
    }
    if (report.proxy.nodeExtraCaCerts) {
      const e = report.proxy.nodeExtraCaCerts;
      if (!e.exists) {
        lines.push(`  ${cross} NODE_EXTRA_CA_CERTS=${e.path} (file not found)`);
      } else if (e.parseError) {
        lines.push(`  ${cross} NODE_EXTRA_CA_CERTS=${e.path} (parse error: ${e.parseError})`);
      } else {
        lines.push(`  ${check} NODE_EXTRA_CA_CERTS=${e.path} (${e.certCount} cert(s), ${e.nonStandardFingerprintsSha1.length} non-Mozilla root(s))`);
        for (const fp of e.nonStandardFingerprintsSha1.slice(0, 5)) {
          lines.push(`      sha1: ${fp}`);
        }
      }
    }
  }
  lines.push('');

  // DNS
  lines.push(c('DNS', 'bold'));
  for (const [host, r] of Object.entries(report.dns)) {
    if (r.error) {
      lines.push(`  ${cross} ${host} — ${r.error} (${r.durationMs}ms)`);
    } else {
      const mark = r.suspiciousPrivateIp ? warn : check;
      const note = r.suspiciousPrivateIp ? ' (RFC1918 — likely proxied)' : '';
      lines.push(`  ${mark} ${host} → ${r.addresses.join(', ')}${note} (${r.durationMs}ms)`);
    }
  }
  lines.push('');

  // Trust store
  lines.push(c('OS trust store', 'bold'));
  if (report.trustStore.systemCertSkipped) {
    const hint =
      report.environment.platform === 'win32'
        ? 'install `win-export-certificate-and-key` or use Node ≥ 22 with `--use-system-ca`'
        : report.environment.platform === 'darwin'
        ? 'install `macos-export-certificate-and-key` or use Node ≥ 22 with `--use-system-ca`'
        : 'use Node ≥ 22 with `--use-system-ca`';
    lines.push(`  ${warn} OS trust store: skipped (${hint})`);
  } else if (report.trustStore.systemCertLoadError) {
    lines.push(`  ${cross} failed to load OS trust store: ${report.trustStore.systemCertLoadError}`);
  } else {
    lines.push(`  ${check} loaded ${report.trustStore.systemCertCount} OS root cert(s) (Mozilla bundle: ${report.trustStore.bundledCertCount})`);
  }
  if (report.trustStore.mitmCaMatches.length > 0) {
    lines.push(`  ${warn} known MITM-vendor CAs detected in OS trust store:`);
    for (const m of report.trustStore.mitmCaMatches) {
      lines.push(`    - ${m.vendor}${m.cn ? ` (${m.cn})` : ''}`);
    }
  } else {
    lines.push(`  ${check} no known TLS-inspection vendor CAs in OS trust store`);
  }
  lines.push('');

  // TLS handshakes
  lines.push(c('TLS handshakes', 'bold'));
  for (const [host, r] of Object.entries(report.tlsHandshakes)) {
    const via = r.viaProxy ? ` [via proxy ${r.proxyUrl ?? ''}]` : ' [direct]';
    if (r.error) {
      lines.push(`  ${cross} ${host}${via} — ${r.error} (${r.durationMs}ms)`);
      continue;
    }
    const mark = r.mitmSuspected ? warn : check;
    const proto = `${r.protocol ?? '?'}/${r.alpn ?? '?'}`;
    lines.push(`  ${mark} ${host}${via} ${proto} — root: ${r.rootIssuer ?? 'unknown'} (${r.durationMs}ms)`);
    lines.push(`      bundled-root=${r.rootInMozillaBundle ? 'yes' : 'no'}  os-root=${r.rootInOsTrustStore ? 'yes' : 'no'}  mitm=${r.mitmSuspected ? `yes${r.mitmVendor ? ` (${r.mitmVendor})` : ''}` : 'no'}`);
  }
  lines.push('');

  // HTTPS probes
  lines.push(c('HTTPS probes (default trust vs OS-trust injected)', 'bold'));
  for (const [host, r] of Object.entries(report.httpsProbes)) {
    const defStr = r.statusDefault !== null ? `HTTP ${r.statusDefault}` : `error (${r.errorDefault ?? 'unknown'})`;
    const osStr = r.statusOsTrust !== null ? `HTTP ${r.statusOsTrust}` : `error (${r.errorOsTrust ?? 'unknown'})`;
    const reachable = r.statusDefault !== null || r.statusOsTrust !== null;
    const mark = reachable ? check : cross;
    const via = r.viaProxy ? ` [via proxy ${r.proxyUrl ?? ''}]` : ' [direct]';
    lines.push(`  ${mark} ${host}${via}`);
    lines.push(`      default: ${defStr}`);
    lines.push(`      os-trust: ${osStr}`);
    if (r.mitmConfirmed) {
      lines.push(`      ${warn} MITM confirmed: default trust failed, OS-trust succeeded`);
    }
  }
  lines.push('');

  // Substrate
  lines.push(c('Substrate', 'bold'));
  if (report.substrate.unattached) {
    lines.push(`  ${cross} ${report.substrate.unattached}`);
  }
  for (const u of report.substrate.urls) {
    lines.push(`  ${u}`);
  }
  for (const u of report.substrate.plainHttpUrls) {
    const loopback = (() => {
      try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(u).hostname); } catch { return false; }
    })();
    lines.push(loopback
      ? `  ${check} ${u} is plain HTTP on loopback: no TLS to diagnose`
      : `  ${warn} ${u} is plain HTTP: no TLS to diagnose, and the key travels in cleartext (CONFORMANCE §c3-identity)`);
  }
  lines.push('');

  // Config
  lines.push(c('Configuration', 'bold'));
  if (report.config.configExists) {
    lines.push(`  ${check} config found at ${report.config.configPath}`);
    if (report.config.apiKeyConfigured) {
      lines.push(`      apiKey: ${report.config.apiKeyRedacted}`);
    } else {
      lines.push(`      ${warn} no apiKey set`);
    }
    if (report.config.endpoint) {
      lines.push(`      endpoint: ${report.config.endpoint}`);
    }
  } else {
    lines.push(`  ${warn} no config at ${report.config.configPath}`);
  }
  const khCount = Object.keys(report.config.knownHosts).length;
  if (khCount > 0) {
    lines.push(`  ${check} ${khCount} known host fingerprint(s) recorded`);
    for (const [h, e] of Object.entries(report.config.knownHosts)) {
      lines.push(`      ${h} → ${e.fingerprint.slice(0, 16)}… (${e.recordedAt})`);
    }
  }
  lines.push('');

  // Diagnosis
  lines.push(c('Diagnosis', 'bold'));
  const statusColor: Record<Diagnosis['status'], keyof typeof ANSI> = {
    ok: 'green',
    degraded: 'yellow',
    'mitm-handled': 'yellow',
    'mitm-failed': 'red',
    failed: 'red',
    unreachable: 'red',
    unknown: 'yellow',
  };
  const statusGlyph: Record<Diagnosis['status'], string> = {
    ok: check,
    degraded: warn,
    'mitm-handled': warn,
    'mitm-failed': cross,
    failed: cross,
    unreachable: cross,
    unknown: warn,
  };
  lines.push(`  ${statusGlyph[report.diagnosis.status]} ${c(report.diagnosis.summary, statusColor[report.diagnosis.status])}`);

  const obs = report.diagnosis.observations ?? [];
  if (obs.length > 0) {
    lines.push('  Observations:');
    const sevGlyph: Record<DiagnosisSeverity, string> = {
      error: cross,
      warn: warn,
      info: c('•', 'cyan'),
    };
    for (const o of obs) {
      lines.push(`    ${sevGlyph[o.severity]} [${o.code}] ${o.message}`);
      if (o.verify) lines.push(`        verify: ${o.verify}`);
      if (o.action) lines.push(`        action: ${o.action}`);
    }
  } else if (report.diagnosis.suggestedActions.length > 0) {
    lines.push('  Suggested actions:');
    for (const a of report.diagnosis.suggestedActions) {
      lines.push(`    - ${a}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The substrate the server would attach to, read with the server's own
 * loaders (env first, then the config file) without changing process.env.
 */
function resolveSubstrateTargets(): SubstrateTargets & { tlsPorts: Record<string, number> } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const envConfig = loadMetabobEnvConfig(env);
  applyConfigDefaults(env, envConfig);
  const fileConfig = loadMetabobCLIConfig(env.METABOB_CONFIG_PATH ?? getDefaultConfigPath());
  applyConfigDefaults(env, envConfig ? withoutEndpoints(fileConfig) : fileConfig);

  const urls = configuredSubstrateUrls(env);
  const tlsHosts: string[] = [];
  const tlsPorts: Record<string, number> = {};
  const plainHttpUrls: string[] = [];
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol === 'https:') {
        if (!tlsHosts.includes(parsed.hostname)) {
          tlsHosts.push(parsed.hostname);
          tlsPorts[parsed.hostname] = Number(parsed.port || 443);
        }
      } else {
        plainHttpUrls.push(u);
      }
    } catch {
      // A malformed URL is the server's to report; doctor skips it.
    }
  }
  return { urls, tlsHosts, tlsPorts, plainHttpUrls, unattached: unattachedMessage(env) };
}

export async function runDoctor(options: RunDoctorOptions = {}): Promise<{
  report: DoctorReport;
  exitCode: number;
  artifactPath: string | null;
}> {
  const overallStart = performance.now();
  const probeTimeoutMs = options.probeTimeoutMs ?? 5000;
  const substrate = resolveSubstrateTargets();
  const hosts = options.hosts ?? substrate.tlsHosts;
  const allHosts = Array.from(new Set([...hosts, REFERENCE_HOST]));

  // Environment + proxy + trust store are synchronous.
  const environment = snapshotEnvironment();
  const proxy = snapshotProxy(hosts);
  const { snapshot: trustStore, systemCerts } = snapshotTrustStore();

  // DNS in parallel.
  const dnsEntries: Array<[string, DnsProbeResult]> = await Promise.all(
    allHosts.map(async (h): Promise<[string, DnsProbeResult]> => [h, await probeDns(h, probeTimeoutMs)]),
  );
  const dnsMap: Record<string, DnsProbeResult> = Object.fromEntries(dnsEntries);

  // TLS handshakes in parallel (only for hosts that resolved or had an error — try anyway).
  const tlsEntries: Array<[string, TlsHandshakeResult]> = await Promise.all(
    allHosts.map(async (h): Promise<[string, TlsHandshakeResult]> => [
      h,
      await probeTlsHandshake(h, systemCerts, probeTimeoutMs, substrate.tlsPorts[h] ?? 443),
    ]),
  );
  const tlsMap: Record<string, TlsHandshakeResult> = Object.fromEntries(tlsEntries);

  // HTTPS probes against the substrate hosts only.
  const httpsTargets = hosts.map((h) => {
    const port = substrate.tlsPorts[h];
    return `https://${h}${port && port !== 443 ? `:${port}` : ''}/health`;
  });
  const httpsEntries: Array<[string, HttpsProbeResult]> = await Promise.all(
    httpsTargets.map(async (url): Promise<[string, HttpsProbeResult]> => [
      new URL(url).hostname,
      await probeHttps(url, systemCerts, probeTimeoutMs),
    ]),
  );
  const httpsMap: Record<string, HttpsProbeResult> = Object.fromEntries(httpsEntries);

  const config = snapshotConfig();

  const diagnosis = synthesizeDiagnosis({
    dns: dnsMap,
    tlsHandshakes: tlsMap,
    httpsProbes: httpsMap,
    trustStore,
    proxy,
    anchorHosts: hosts,
  });

  const durationMs = Math.round(performance.now() - overallStart);

  const report: DoctorReport = {
    schema: 'metabob-mcp-doctor/v1',
    generatedAt: new Date().toISOString(),
    durationMs,
    metabobMcpVersion: readMetabobMcpVersion(),
    environment,
    proxy,
    dns: dnsMap,
    trustStore,
    tlsHandshakes: tlsMap,
    httpsProbes: httpsMap,
    substrate: {
      urls: substrate.urls,
      tlsHosts: substrate.tlsHosts,
      plainHttpUrls: substrate.plainHttpUrls,
      unattached: substrate.unattached,
    },
    config,
    diagnosis,
  };

  // Write artifact
  let artifactPath: string | null = null;
  if (!options.noArtifact) {
    artifactPath = options.artifactPath ?? path.join(process.cwd(), `metabob-mcp-doctor-${Math.floor(Date.now() / 1000)}.json`);
    try {
      fs.writeFileSync(artifactPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!options.silent) {
        console.error(`[metabob-mcp doctor] failed to write artifact ${artifactPath}: ${msg}`);
      }
      artifactPath = null;
    }
  }

  if (!options.silent) {
    process.stdout.write(renderReport(report) + '\n');
    if (artifactPath) {
      process.stdout.write(`\nJSON artifact: ${artifactPath}\n`);
    }
  }

  // Exit code: 0 if every https substrate host is reachable via HTTPS (the
  // proxy-aware probe), 1 otherwise, or when nothing is configured. Raw TLS
  // failures alone don't justify exit-1 in proxy-required networks where
  // direct TLS is blocked by design.
  const anyHttpsUnreachable = hosts.some((h) => {
    const p = httpsMap[h];
    return !p || (p.statusDefault === null && p.statusOsTrust === null);
  });
  const exitCode = anyHttpsUnreachable || (substrate.unattached && !options.hosts) ? 1 : 0;

  return { report, exitCode, artifactPath };
}
