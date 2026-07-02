/**
 * OS trust-store auto-load (mitigation #1).
 *
 * Many corporate environments (Zscaler, Netskope, Forcepoint, Cisco Umbrella,
 * Palo Alto Prisma, Sophos, etc.) terminate TLS at an MDM-deployed proxy and
 * re-sign traffic with an internal CA. Node ships its own Mozilla CA bundle and
 * ignores the OS trust store by default, so every HTTPS call fails with
 * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` until the user discovers
 * `NODE_EXTRA_CA_CERTS` (which most never do).
 *
 * This module reads the OS root store at startup and appends the resulting
 * PEMs to:
 *   - `tls.rootCertificates` (advisory; used by some libs that snapshot at import time)
 *   - `https.globalAgent.options.ca` (covers Node's built-in https/http modules)
 *   - `undici.setGlobalDispatcher` (covers global `fetch` in Node 18+)
 *
 * Failure modes are non-fatal: a stripped Linux container with no
 * `/etc/ssl/certs` is logged as a warning and we fall through to the bundled
 * Mozilla roots.
 *
 * Opt-out: pass `--no-system-ca` on the CLI or set `METABOB_NO_SYSTEM_CA=1`.
 */

import * as tls from 'node:tls';
import * as https from 'node:https';

let installed = false;
let appendedCount = 0;
let lastSummary: TrustInstallSummary | null = null;

export interface TrustInstallSummary {
  attempted: boolean;
  installed: boolean;
  systemCertCount: number;
  bundledCertCount: number;
  error?: string;
}

/**
 * Synchronously read OS root CAs and inject into all known TLS surfaces.
 * Idempotent — safe to call more than once.
 */
export function installSystemTrustStoreSync(opts: { disabled?: boolean } = {}): TrustInstallSummary {
  if (opts.disabled) {
    lastSummary = {
      attempted: false,
      installed: false,
      systemCertCount: 0,
      bundledCertCount: tls.rootCertificates.length,
    };
    return lastSummary;
  }
  if (installed) {
    return lastSummary ?? {
      attempted: true,
      installed: true,
      systemCertCount: appendedCount,
      bundledCertCount: tls.rootCertificates.length,
    };
  }

  let systemCerts: string[] = [];
  let readError: string | undefined;
  try {
    // Lazy require so an install-time failure of system-ca doesn't crash
    // the whole module load.
    const { systemCertsSync } = require('system-ca') as typeof import('system-ca');
    systemCerts = systemCertsSync({ includeNodeCertificates: false });
  } catch (err) {
    readError = err instanceof Error ? err.message : String(err);
  }

  // Deduplicate against bundled Mozilla roots so we don't double-count.
  const bundled = new Set(tls.rootCertificates);
  const additions = systemCerts.filter((pem) => !bundled.has(pem));

  // Detect a corporate forward proxy from the environment. This matters even
  // when the OS store has no extra CA: Node's native `fetch` (undici) does NOT
  // honor HTTP(S)_PROXY on its own before Node 24, so in a forced-egress
  // environment (Zscaler, Netskope, …) runtime fetch calls never traverse the
  // proxy unless we install a proxy-aware global dispatcher. The doctor already
  // does this per-request; the runtime previously did not — this closes the gap
  // that made `doctor` pass while the live server failed to connect.
  const proxyEnv =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';
  const proxyPresent = proxyEnv.trim().length > 0;

  if (additions.length > 0) {
    // 1. Mutate the array exported by tls so libraries that snapshot
    //    tls.rootCertificates after this point see the augmented set.
    //    (rootCertificates is a frozen-ish array in some Node versions;
    //    splice may throw — fall back to redefining the property.)
    try {
      (tls.rootCertificates as unknown as string[]).push(...additions);
    } catch {
      try {
        Object.defineProperty(tls, 'rootCertificates', {
          value: [...tls.rootCertificates, ...additions],
          writable: false,
          configurable: true,
        });
      } catch {
        // Best-effort; downstream injections still cover the actual request path.
      }
    }

    // 2. Wire into https.globalAgent so node:https / node:http requests pick it up.
    const agent = https.globalAgent as https.Agent & { options: https.AgentOptions };
    const existingCa = agent.options.ca;
    const merged = [
      ...tls.rootCertificates,
      ...(Array.isArray(existingCa)
        ? existingCa.map((c) => (typeof c === 'string' ? c : c.toString()))
        : existingCa
          ? [typeof existingCa === 'string' ? existingCa : existingCa.toString()]
          : []),
    ];
    agent.options.ca = merged;

    appendedCount = additions.length;
    installed = true;
  } else if (!readError) {
    // System trust store was readable but identical to bundled — still mark
    // installed so we don't retry on every call.
    installed = true;
  }

  // 3. Wire the undici global dispatcher (the engine behind global `fetch` in
  //    Node 18+). Runs whenever we have EITHER a corporate CA to inject OR a
  //    proxy to traverse — native fetch needs both and the previous build did
  //    neither (undici was not even installed, so this always threw and the CA
  //    reached only https.globalAgent, which fetch does not use).
  if (additions.length > 0 || proxyPresent) {
    try {
      const caList = additions.length > 0 ? [...tls.rootCertificates] : undefined;
      const undici = require('undici') as {
        setGlobalDispatcher: (d: unknown) => void;
        Agent: new (opts?: Record<string, unknown>) => unknown;
        ProxyAgent?: new (opts: Record<string, unknown>) => unknown;
        EnvHttpProxyAgent?: new (opts?: Record<string, unknown>) => unknown;
      };

      let dispatcher: unknown;
      // TLS to the destination (Zscaler re-signs the origin cert) needs the CA
      // on the *request* leg, so we pass it as both `connect` (Agent) and
      // `requestTls` (ProxyAgent/EnvHttpProxyAgent) to cover every undici path.
      if (proxyPresent && typeof undici.EnvHttpProxyAgent === 'function') {
        // Preferred: EnvHttpProxyAgent honors HTTP_PROXY/HTTPS_PROXY/NO_PROXY itself.
        dispatcher = new undici.EnvHttpProxyAgent(
          caList ? { requestTls: { ca: caList } } : {},
        );
      } else if (proxyPresent && typeof undici.ProxyAgent === 'function') {
        // Older undici without EnvHttpProxyAgent: resolve the proxy URL ourselves.
        const { getProxyForUrl } = require('proxy-from-env') as {
          getProxyForUrl: (u: string) => string;
        };
        const proxyUri = getProxyForUrl('https://ide.metabob.com') || proxyEnv;
        dispatcher = new undici.ProxyAgent({
          uri: proxyUri,
          ...(caList ? { requestTls: { ca: caList } } : {}),
        });
      } else {
        // No proxy (or no proxy-agent support): plain Agent carrying the CA.
        dispatcher = new undici.Agent(caList ? { connect: { ca: caList } } : {});
      }
      undici.setGlobalDispatcher(dispatcher);
      installed = true;
    } catch (err) {
      // If undici is unavailable, global fetch keeps its own pool — log loudly
      // so the operator can diagnose (this is the request path that actually
      // fails behind an intercepting proxy).
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[metabob-mcp] system-ca: undici global dispatcher not installed (${msg}); ` +
          `runtime fetch will NOT trust the corporate CA or use the proxy`,
      );
    }
  }

  lastSummary = {
    attempted: true,
    installed,
    systemCertCount: additions.length,
    bundledCertCount: tls.rootCertificates.length - additions.length,
    error: readError,
  };

  if (readError) {
    console.error(
      `[metabob-mcp] system-ca: failed to read OS trust store (${readError}); falling back to bundled Mozilla roots`,
    );
  } else if (additions.length > 0) {
    console.error(
      `[metabob-mcp] system-ca: loaded ${additions.length} additional root CA(s) from OS trust store`,
    );
  }

  return lastSummary;
}

export function getLastTrustSummary(): TrustInstallSummary | null {
  return lastSummary;
}
