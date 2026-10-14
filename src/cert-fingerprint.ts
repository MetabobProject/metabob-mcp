/**
 * Cert fingerprint self-probe (mitigation #6).
 *
 * On first successful TLS connect to a configured substrate host, record the leaf cert's
 * SHA-256 SPKI fingerprint in `~/.metabob/known-hosts.json`. On subsequent
 * runs, compare and emit a one-time stderr warning if the fingerprint
 * changed AND the new chain's root is not in Mozilla's bundled CA list but
 * IS in the OS trust store — a clear signal of MITM.
 *
 * Never blocks. Never prompts. Corrupt JSON is treated as empty.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as tls from 'node:tls';
import * as crypto from 'node:crypto';
import { openTlsSocket } from './net.js';

export interface KnownHostEntry {
  fingerprint: string;
  recordedAt: string;
}

export interface KnownHostsFile {
  hosts: Record<string, KnownHostEntry>;
}

function defaultStorePath(): string {
  return path.join(os.homedir(), '.metabob', 'known-hosts.json');
}

export function readKnownHosts(storePath = defaultStorePath()): KnownHostsFile {
  try {
    const text = fs.readFileSync(storePath, 'utf-8');
    const parsed = JSON.parse(text) as Partial<KnownHostsFile>;
    if (parsed && typeof parsed === 'object' && parsed.hosts && typeof parsed.hosts === 'object') {
      return { hosts: parsed.hosts as Record<string, KnownHostEntry> };
    }
  } catch {
    // Missing or corrupt — start fresh.
  }
  return { hosts: {} };
}

export function writeKnownHosts(data: KnownHostsFile, storePath = defaultStorePath()): void {
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  } catch (err) {
    // Best-effort: store is observability, not security gating.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[metabob-mcp] known-hosts: write failed (${msg})`);
  }
}

/**
 * Compute SHA-256 fingerprint of a leaf cert's SubjectPublicKeyInfo (SPKI).
 * SPKI rather than full-cert digest so that legitimate cert rotations on
 * the same keypair don't trigger MITM warnings.
 */
export function spkiFingerprint(leafCertDer: Buffer | string): string {
  const der = typeof leafCertDer === 'string' ? Buffer.from(leafCertDer, 'base64') : leafCertDer;
  // Parse with crypto.X509Certificate (Node 15.6+).
  // Bun and modern Node both have it.
  const x509 = new crypto.X509Certificate(der);
  const pubkey = x509.publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(pubkey).digest('hex');
}

export interface ProbeOpts {
  host: string;
  port?: number;
  storePath?: string;
  bundledRoots?: ReadonlyArray<string>;
  systemRoots?: ReadonlyArray<string>;
  timeoutMs?: number;
}

export interface ProbeResult {
  host: string;
  fingerprint: string;
  changed: boolean;
  firstSeen: boolean;
  mitmSuspected: boolean;
  rootSubject?: string;
}

/**
 * Connect once, capture the leaf SPKI fingerprint and root chain, and
 * compare against the known-hosts store. Returns the probe result (also
 * surfaces a one-time stderr warning if MITM is suspected).
 *
 * Designed to be called fire-and-forget after process startup.
 */
export async function probeHostFingerprint(opts: ProbeOpts): Promise<ProbeResult> {
  const host = opts.host;
  const port = opts.port ?? 443;
  const timeout = opts.timeoutMs ?? 5000;
  const bundled = new Set(opts.bundledRoots ?? tls.rootCertificates);
  const systemRoots = opts.systemRoots ?? [];
  const storePath = opts.storePath ?? defaultStorePath();

  // The same path a request takes: the proxy is chosen per request and the
  // tunnel opened by hostname (src/net.ts@open-tls-socket); the chain is
  // captured whatever it is — this probe watches for a change, it does not trust.
  const { socket } = await openTlsSocket(`https://${host}:${port}`, { connectTimeoutMs: timeout });
  let result: ProbeResult;
  try {
    const peer = socket.getPeerCertificate(true);
    const der = peer.raw;
    const leafFp = spkiFingerprint(der);

    // Walk to the root.
    const seen = new Set<string>();
    let cur: typeof peer | undefined = peer;
    let rootPem: string | undefined;
    let rootSubject: string | undefined;
    while (cur && !seen.has(cur.fingerprint256)) {
      seen.add(cur.fingerprint256);
      if (cur.issuerCertificate && cur.issuerCertificate !== cur) {
        cur = cur.issuerCertificate;
      } else {
        // self-signed — this is the root we received
        rootPem = derToPem(cur.raw);
        rootSubject = describeSubject(cur.subject);
        cur = undefined;
      }
    }

    const inBundled = rootPem ? bundled.has(rootPem) : false;
    const inSystem = rootPem ? systemRoots.includes(rootPem) : false;

    const known = readKnownHosts(storePath);
    const prior = known.hosts[host];
    const firstSeen = !prior;
    const changed = !!prior && prior.fingerprint !== leafFp;
    const mitmSuspected = changed && !inBundled && inSystem;

    if (firstSeen || changed) {
      known.hosts[host] = {
        fingerprint: leafFp,
        recordedAt: new Date().toISOString(),
      };
      writeKnownHosts(known, storePath);
    }

    if (mitmSuspected) {
      console.error(
        `[metabob-mcp] WARNING: TLS fingerprint for ${host} changed and the ` +
          `new chain's root (${rootSubject ?? 'unknown'}) is in your OS trust ` +
          `store but NOT in Mozilla's bundled CA list. This is consistent with ` +
          `corporate SSL inspection (Zscaler / Netskope / proxy MITM). ` +
          `Connections will still proceed; if this is unexpected, contact your IT team.`,
      );
    }

    result = {
      host,
      fingerprint: leafFp,
      changed,
      firstSeen,
      mitmSuspected,
      rootSubject,
    };
  } finally {
    socket.destroy();
  }

  return result;
}

function derToPem(der: Buffer): string {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return ['-----BEGIN CERTIFICATE-----', ...lines, '-----END CERTIFICATE-----'].join('\n') + '\n';
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

/**
 * The hosts to probe: every https host among the configured substrate URLs.
 * A plain-http endpoint has no certificate to fingerprint.
 */
export function pickMonitoredHosts(urls: ReadonlyArray<string | undefined>): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'https:') continue;
      out.add(parsed.hostname);
    } catch {
      // skip
    }
  }
  return [...out];
}
