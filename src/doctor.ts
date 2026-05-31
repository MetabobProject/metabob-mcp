/**
 * Diagnostic doctor for corporate-proxy / Zscaler / MDM TLS-inspection issues.
 *
 * Runs a battery of probes against the user's network environment and prints
 * a human-readable report plus a JSON artifact for support tickets.
 *
 * Entry points:
 *   - `metabob-mcp doctor` (subcommand of the main CLI)
 *   - `metabob-mcp-doctor` (dedicated bin)
 *
 * No env vars required. Safe to run with or without an API key.
 */

import * as tls from 'node:tls';
import * as https from 'node:https';
import * as dns from 'node:dns/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  readKnownHosts,
  isMonitoredHost,
} from './cert-fingerprint.js';

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
  webSocketProbes: Record<string, WebSocketProbeResult>;
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
}

export interface WebSocketProbeResult {
  url: string;
  durationMs: number;
  available: boolean;
  upgraded: boolean;
  error?: string;
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

export interface Diagnosis {
  status: 'ok' | 'mitm-handled' | 'mitm-failed' | 'unreachable' | 'unknown';
  summary: string;
  suggestedActions: string[];
}

export interface RunDoctorOptions {
  /** Override probe target hosts (default: activity/identity/ide + npm). */
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

const DEFAULT_METABOB_HOSTS = [
  'activity.metabob.com',
  'identity.metabob.com',
  'ide.metabob.com',
];

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

function snapshotProxy(): ProxySnapshot {
  return {
    httpProxy: process.env.HTTP_PROXY ?? process.env.http_proxy ?? null,
    httpsProxy: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null,
    noProxy: process.env.NO_PROXY ?? process.env.no_proxy ?? null,
    // npm config values would require shelling out; skip for speed + portability.
    npmProxy: null,
    npmHttpsProxy: null,
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
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { systemCertsSync } = require('system-ca') as typeof import('system-ca');
    systemCerts = systemCertsSync({ includeNodeCertificates: false });
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
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
      mitmCaMatches: matches,
    },
    systemCerts,
  };
}

async function probeTlsHandshake(
  host: string,
  systemCerts: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<TlsHandshakeResult> {
  const start = performance.now();
  const port = 443;
  const bundled = new Set(tls.rootCertificates);
  const systemSet = new Set(systemCerts);

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
        host,
        port,
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

  const doOne = async (ca: string[] | undefined): Promise<{ status: number | null; error?: string }> => {
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
      if (ca && ca.length > 0) {
        opts.ca = ca;
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
  };
}

async function probeWebSocket(url: string, timeoutMs: number): Promise<WebSocketProbeResult> {
  const start = performance.now();
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (typeof WS !== 'function') {
    return {
      url,
      durationMs: Math.round(performance.now() - start),
      available: false,
      upgraded: false,
      error: 'WebSocket not available in this Node runtime (Node 22+ required for built-in)',
    };
  }

  return new Promise<WebSocketProbeResult>((resolve) => {
    let settled = false;
    const finish = (r: WebSocketProbeResult) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(r);
    };

    let ws: WebSocket;
    try {
      ws = new WS(url);
    } catch (err) {
      resolve({
        url,
        durationMs: Math.round(performance.now() - start),
        available: true,
        upgraded: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      finish({
        url,
        durationMs: Math.round(performance.now() - start),
        available: true,
        upgraded: false,
        error: 'handshake timeout',
      });
    }, timeoutMs);

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      finish({
        url,
        durationMs: Math.round(performance.now() - start),
        available: true,
        upgraded: true,
      });
    });
    ws.addEventListener('error', (ev) => {
      clearTimeout(timer);
      const evAny = ev as unknown as { message?: string; error?: { message?: string; code?: string } };
      const msg =
        evAny.message ||
        evAny.error?.message ||
        evAny.error?.code ||
        'websocket handshake failed (no error detail from runtime)';
      finish({
        url,
        durationMs: Math.round(performance.now() - start),
        available: true,
        upgraded: false,
        error: msg,
      });
    });
  });
}

function snapshotConfig(): ConfigSnapshot {
  const configPath = path.join(os.homedir(), '.metabob', 'config.json');
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

export function synthesizeDiagnosis(input: {
  dns: Record<string, DnsProbeResult>;
  tlsHandshakes: Record<string, TlsHandshakeResult>;
  httpsProbes: Record<string, HttpsProbeResult>;
  trustStore: TrustStoreSnapshot;
}): Diagnosis {
  const metabobHosts = Object.keys(input.tlsHandshakes).filter((h) => isMonitoredHost(h));

  // Did any metabob host fail DNS or handshake entirely?
  const unreachable = metabobHosts.filter((h) => {
    const dnsRes = input.dns[h];
    const tlsRes = input.tlsHandshakes[h];
    const dnsFailed = !dnsRes || dnsRes.error || dnsRes.addresses.length === 0;
    const tlsFailed = !tlsRes || tlsRes.error;
    return dnsFailed || tlsFailed;
  });

  if (metabobHosts.length > 0 && unreachable.length === metabobHosts.length) {
    return {
      status: 'unreachable',
      summary: 'Cannot reach any Metabob host. This is a network or DNS failure, not TLS interception.',
      suggestedActions: [
        'Verify general internet connectivity (e.g., `curl https://example.com`).',
        'Check VPN status — some VPNs allow only allowlisted domains.',
        'Confirm DNS resolution: `dig activity.metabob.com`.',
        'Ask IT whether `*.metabob.com` is blocked by your firewall.',
      ],
    };
  }

  const mitmHosts = metabobHosts.filter((h) => input.tlsHandshakes[h]?.mitmSuspected);
  const vendor = mitmHosts
    .map((h) => input.tlsHandshakes[h]?.mitmVendor)
    .find((v): v is string => Boolean(v));

  if (mitmHosts.length === 0) {
    return {
      status: 'ok',
      summary: 'No TLS interception detected. Metabob hosts are reachable with the bundled Mozilla CA chain.',
      suggestedActions: [],
    };
  }

  // MITM detected — check whether https probes succeed with OS-trust injection.
  const mitmHandled = mitmHosts.every((h) => {
    // Find a corresponding https probe for this host.
    const probe = Object.values(input.httpsProbes).find((p) => {
      try {
        return new URL(p.url).hostname === h;
      } catch {
        return false;
      }
    });
    if (!probe) return false;
    // Probe handled if OS-trust call returned ANY HTTP status (auth errors are fine).
    return probe.statusOsTrust !== null;
  });

  if (mitmHandled) {
    return {
      status: 'mitm-handled',
      summary: `TLS inspection detected${vendor ? ` (vendor: ${vendor})` : ''}. The in-binary mitigations (OS trust auto-load) successfully completed the handshake.`,
      suggestedActions: [
        'No action required — metabob-mcp will work transparently in your environment.',
        'If you still see intermittent failures, share this JSON report with Metabob support.',
      ],
    };
  }

  return {
    status: 'mitm-failed',
    summary: `TLS inspection detected${vendor ? ` (vendor: ${vendor})` : ''} but mitigations did not restore connectivity.`,
    suggestedActions: [
      'Ask IT to add `*.metabob.com` to your proxy\'s SSL inspection bypass list.',
      'Install the corporate root CA into your OS trust store (Keychain on macOS, Trusted Root Certification Authorities on Windows, /etc/ssl/certs on Linux).',
      'Set `NODE_EXTRA_CA_CERTS=/path/to/corp-root.pem` in the environment that launches the MCP client.',
      'Attach this JSON report to your IT or Metabob support ticket.',
    ],
  };
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
  const proxyLines: string[] = [];
  if (report.proxy.httpProxy) proxyLines.push(`  HTTP_PROXY=${report.proxy.httpProxy}`);
  if (report.proxy.httpsProxy) proxyLines.push(`  HTTPS_PROXY=${report.proxy.httpsProxy}`);
  if (report.proxy.noProxy) proxyLines.push(`  NO_PROXY=${report.proxy.noProxy}`);
  if (proxyLines.length === 0) {
    lines.push(`  ${check} no proxy environment variables set`);
  } else {
    lines.push(`  ${warn} proxy environment variables detected:`);
    lines.push(...proxyLines);
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
  if (report.trustStore.systemCertLoadError) {
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
    if (r.error) {
      lines.push(`  ${cross} ${host} — ${r.error} (${r.durationMs}ms)`);
      continue;
    }
    const mark = r.mitmSuspected ? warn : check;
    const proto = `${r.protocol ?? '?'}/${r.alpn ?? '?'}`;
    lines.push(`  ${mark} ${host} ${proto} — root: ${r.rootIssuer ?? 'unknown'} (${r.durationMs}ms)`);
    lines.push(`      bundled-root=${r.rootInMozillaBundle ? 'yes' : 'no'}  os-root=${r.rootInOsTrustStore ? 'yes' : 'no'}  mitm=${r.mitmSuspected ? `yes${r.mitmVendor ? ` (${r.mitmVendor})` : ''}` : 'no'}`);
  }
  lines.push('');

  // HTTPS probes
  lines.push(c('HTTPS probes (default trust vs OS-trust injected)', 'bold'));
  for (const [host, r] of Object.entries(report.httpsProbes)) {
    const defStr = r.statusDefault !== null ? `HTTP ${r.statusDefault}` : `error (${r.errorDefault ?? 'unknown'})`;
    const osStr = r.statusOsTrust !== null ? `HTTP ${r.statusOsTrust}` : `error (${r.errorOsTrust ?? 'unknown'})`;
    const mark = r.statusOsTrust !== null ? check : cross;
    lines.push(`  ${mark} ${host}`);
    lines.push(`      default: ${defStr}`);
    lines.push(`      os-trust: ${osStr}`);
    if (r.mitmConfirmed) {
      lines.push(`      ${warn} MITM confirmed: default trust failed, OS-trust succeeded`);
    }
  }
  lines.push('');

  // WebSocket probes
  if (Object.keys(report.webSocketProbes).length > 0) {
    lines.push(c('WebSocket probes', 'bold'));
    for (const [host, r] of Object.entries(report.webSocketProbes)) {
      if (!r.available) {
        lines.push(`  ${warn} ${host} — ${r.error ?? 'unavailable'}`);
      } else if (r.upgraded) {
        lines.push(`  ${check} ${host} — Upgrade succeeded (${r.durationMs}ms)`);
      } else {
        lines.push(`  ${cross} ${host} — ${r.error ?? 'failed'} (${r.durationMs}ms)`);
      }
    }
    lines.push('');
  }

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
    'mitm-handled': 'yellow',
    'mitm-failed': 'red',
    unreachable: 'red',
    unknown: 'yellow',
  };
  const statusGlyph: Record<Diagnosis['status'], string> = {
    ok: check,
    'mitm-handled': warn,
    'mitm-failed': cross,
    unreachable: cross,
    unknown: warn,
  };
  lines.push(`  ${statusGlyph[report.diagnosis.status]} ${c(report.diagnosis.summary, statusColor[report.diagnosis.status])}`);
  if (report.diagnosis.suggestedActions.length > 0) {
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

export async function runDoctor(options: RunDoctorOptions = {}): Promise<{
  report: DoctorReport;
  exitCode: number;
  artifactPath: string | null;
}> {
  const overallStart = performance.now();
  const probeTimeoutMs = options.probeTimeoutMs ?? 5000;
  const hosts = options.hosts ?? DEFAULT_METABOB_HOSTS;
  const allHosts = Array.from(new Set([...hosts, REFERENCE_HOST]));

  // Environment + proxy + trust store are synchronous.
  const environment = snapshotEnvironment();
  const proxy = snapshotProxy();
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
      await probeTlsHandshake(h, systemCerts, probeTimeoutMs),
    ]),
  );
  const tlsMap: Record<string, TlsHandshakeResult> = Object.fromEntries(tlsEntries);

  // HTTPS probes against metabob hosts only.
  const httpsTargets = hosts
    .filter((h) => h.endsWith('.metabob.com'))
    .map((h) => `https://${h}/health`);
  const httpsEntries: Array<[string, HttpsProbeResult]> = await Promise.all(
    httpsTargets.map(async (url): Promise<[string, HttpsProbeResult]> => [
      new URL(url).hostname,
      await probeHttps(url, systemCerts, probeTimeoutMs),
    ]),
  );
  const httpsMap: Record<string, HttpsProbeResult> = Object.fromEntries(httpsEntries);

  // WebSocket probe — just activity.metabob.com.
  const wsTargets = hosts
    .filter((h) => h === 'activity.metabob.com')
    .map((h) => `wss://${h}/ws`);
  const wsEntries: Array<[string, WebSocketProbeResult]> = await Promise.all(
    wsTargets.map(async (url): Promise<[string, WebSocketProbeResult]> => [
      new URL(url).hostname,
      await probeWebSocket(url, probeTimeoutMs),
    ]),
  );
  const wsMap: Record<string, WebSocketProbeResult> = Object.fromEntries(wsEntries);

  const config = snapshotConfig();

  const diagnosis = synthesizeDiagnosis({
    dns: dnsMap,
    tlsHandshakes: tlsMap,
    httpsProbes: httpsMap,
    trustStore,
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
    webSocketProbes: wsMap,
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

  // Exit code: 0 if no host is fully unreachable, 1 if any metabob host is.
  const metabobHosts = hosts.filter((h) => h.endsWith('.metabob.com'));
  const anyUnreachable = metabobHosts.some((h) => {
    const t = tlsMap[h];
    return !t || t.error;
  });
  const exitCode = anyUnreachable ? 1 : 0;

  return { report, exitCode, artifactPath };
}
