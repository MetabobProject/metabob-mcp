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

    // 3. Wire into undici (the engine behind global `fetch` in Node 18+).
    //    Undici is bundled with Node, so a static import would still work,
    //    but we lazy-load to keep this module side-effect-free on older Node.
    try {
      // Lazy + untyped require so projects without @types/undici (it's
      // bundled with Node 18+ but lacks first-party type declarations) still
      // build cleanly.
      const undici = require('undici') as {
        setGlobalDispatcher: (d: unknown) => void;
        Agent: new (opts: { connect?: { ca?: string | string[] } }) => unknown;
      };
      undici.setGlobalDispatcher(
        new undici.Agent({
          connect: { ca: merged },
        }),
      );
    } catch (err) {
      // If undici is unavailable, global fetch will keep using its own pool —
      // log so the operator can diagnose if requests still fail.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[metabob-mcp] system-ca: undici dispatcher not installed (${msg})`);
    }

    appendedCount = additions.length;
    installed = true;
  } else if (!readError) {
    // System trust store was readable but identical to bundled — still mark
    // installed so we don't retry on every call.
    installed = true;
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
