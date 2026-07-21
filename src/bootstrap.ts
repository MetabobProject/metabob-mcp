/**
 * Discovery bootstrap — point-and-go anchor derivation read at use time.
 *
 * `GET {discovery}/bootstrap` returns the federation anchors a joining vessel
 * needs without any of them being hardcoded or pinned:
 *   { relay_multiaddrs, identity_endpoint, discovery_endpoint, prefer_transport }
 *
 * The relay multiaddr in particular is READ EACH JOIN, never persisted, so a
 * relay restart or a re-homed hub can't leave us dialing a stale pin. Empty
 * strings (a local/dashboard deployment with no PUBLIC_IP) are treated as
 * absent — the caller falls back to its already-derived HTTP anchors and
 * simply runs LOCAL (HTTP-only) mode.
 */

export interface BootstrapAnchors {
  relayMultiaddrs: string[];
  identityEndpoint?: string;
  discoveryEndpoint?: string;
  /** Server's hint: "libp2p" when a relay is available; informational. */
  preferTransport?: string;
}

interface RawBootstrap {
  relay_multiaddrs?: unknown;
  identity_endpoint?: unknown;
  discovery_endpoint?: unknown;
  prefer_transport?: unknown;
}

function cleanString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Fetch bootstrap anchors from a discovery endpoint. Never throws — an
 * unreachable or non-JSON discovery yields empty anchors (LOCAL/HTTP mode), so
 * bootstrap can only ever ADD reachability, never block startup.
 */
export async function fetchBootstrapAnchors(
  discoveryEndpoint: string | undefined,
  timeoutMs = 5_000,
): Promise<BootstrapAnchors> {
  const empty: BootstrapAnchors = { relayMultiaddrs: [] };
  if (!discoveryEndpoint) return empty;

  const base = discoveryEndpoint.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/bootstrap`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return empty;
    const raw = (await res.json()) as RawBootstrap;
    const relayMultiaddrs = Array.isArray(raw.relay_multiaddrs)
      ? raw.relay_multiaddrs.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
      : [];
    return {
      relayMultiaddrs,
      identityEndpoint: cleanString(raw.identity_endpoint),
      discoveryEndpoint: cleanString(raw.discovery_endpoint),
      preferTransport: cleanString(raw.prefer_transport),
    };
  } catch {
    return empty;
  }
}
