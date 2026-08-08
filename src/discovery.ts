export interface DiscoveryCapability {
  vesselId: string;
  vesselName: string;
  endpoint: string;
  /**
   * Optional host/LAN-reachable URL advertised by the vessel at registration
   * (discovery-vessel SC-P4 contract). When present, callers outside the
   * container network should use it verbatim instead of remapping `endpoint`.
   */
  public_endpoint?: string;
  protocol?: string;
  /** libp2p overlay reachability (present when the vessel advertised a circuit). */
  libp2p_peer_id?: string;
  libp2p_multiaddr?: string[];
  confidence: number;
  lastSeen: string;
  resolve_endpoint?: string;
  resolve_request_format?: 'pointer' | 'mcp-tool';
  auth_scheme?: 'none' | 'ApiKey' | 'Bearer';
  resolve_timeout_ms?: number;
  auth_token_source?: string;
  auth_delegation_mode?: string;
}

interface DiscoveryResponse {
  content?: {
    shape?: string;
    found?: boolean;
    vessels?: DiscoveryCapability[];
  };
}

const DISCOVERY_CACHE_TTL_MS = 60_000;
const discoveryCache = new Map<string, { expiresAt: number; capability: DiscoveryCapability | null }>();

/**
 * LEGACY FALLBACK for registrations that predate `public_endpoint`.
 *
 * Heuristically rewrites a substrate-internal `localhost:8xxx` endpoint to the
 * host-mapped `localhost:<port+10000>` when the discovery endpoint itself is
 * host-mapped. Vessels that advertise `public_endpoint` bypass this entirely —
 * see resolveVesselBaseUrl().
 */
function normalizeDiscoveredUrl(rawUrl: string, discoveryEndpoint?: string): string {
  try {
    const url = new URL(rawUrl);
    if (!discoveryEndpoint) {
      return url.toString().replace(/\/$/, '');
    }

    const discoveryUrl = new URL(discoveryEndpoint);
    const discoveredPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const discoveryPort = Number(discoveryUrl.port || (discoveryUrl.protocol === 'https:' ? 443 : 80));
    const hostMappedDiscovery =
      discoveryUrl.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(discoveryUrl.hostname) &&
      discoveryPort >= 18000 &&
      discoveryPort < 19000;
    const internalLoopbackTarget =
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname) &&
      discoveredPort >= 8000 &&
      discoveredPort < 9000;

    if (hostMappedDiscovery && internalLoopbackTarget) {
      url.protocol = discoveryUrl.protocol;
      url.hostname = discoveryUrl.hostname;
      url.port = String(discoveredPort + 10_000);
    }

    return url.toString().replace(/\/$/, '');
  } catch {
    return rawUrl.replace(/\/$/, '');
  }
}

/**
 * Preferred way to obtain a discovered vessel's base URL: use the
 * registry-advertised `public_endpoint` verbatim when present (it is already
 * reachable from outside the container network), and only fall back to the
 * legacy `endpoint` + port-remap heuristic when it is absent.
 */
function resolveVesselBaseUrl(capability: DiscoveryCapability, discoveryEndpoint?: string): string {
  if (typeof capability.public_endpoint === 'string' && capability.public_endpoint.trim().length > 0) {
    return capability.public_endpoint.replace(/\/+$/, '');
  }
  return normalizeDiscoveredUrl(capability.endpoint, discoveryEndpoint);
}

export function deriveLocalDiscoveryEndpoint(activityApiUrl?: string): string | undefined {
  if (!activityApiUrl) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(activityApiUrl);
  } catch {
    return undefined;
  }

  if (url.protocol !== 'http:') {
    return undefined;
  }

  // Port-published substrate convention: the activity gateway ends in …080 and
  // its siblings sit at fixed offsets in the same block (discovery …100,
  // analysis …250, concept …260). Derive discovery = blockBase + 100 for ANY
  // conforming port (8080, 18080, 19080, 28080, …) rather than enumerating a
  // hardcoded pair — a bare-port allowlist silently mis-derived every other
  // deployment's port scheme (e.g. dashboard-test's 19080 → 19100).
  //
  // What signals this convention is the PORT, not the hostname. Gating on
  // localhost/127.0.0.1 made every remote port-published substrate fall through
  // to the path-splitting reverse-proxy branch in config.ts, which then handed
  // out {endpoint}/discovery, /analysis and /conceptdb — routes that deployment
  // has never served. It 404s the whole cockpit: registry_query, run_goal(_async)
  // and vessel-mode resolve_impulse all report "could not find X via discovery",
  // which reads as a dead substrate rather than a mis-derived client URL.
  // An EXPLICIT conforming port is the evidence; that is exactly the same class
  // of allowlist error as the bare-port one above, one level up.
  //
  // The reverse-proxy branch keeps everything it actually owns: bare
  // http://host (implicit port 80) has no explicit port and still falls
  // through to it, as does any https:// endpoint.
  if (!url.port) {
    return undefined;
  }
  const activityPort = Number(url.port);
  if (!Number.isInteger(activityPort) || activityPort % 100 !== 80) {
    return undefined;
  }
  url.port = String(activityPort - 80 + 100);

  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export async function discoverFirstVesselByShape(options: {
  discoveryEndpoint?: string;
  shape: string;
  apiKey?: string;
}): Promise<DiscoveryCapability | null> {
  const discoveryEndpoint = options.discoveryEndpoint?.replace(/\/$/, '');
  if (!discoveryEndpoint) {
    return null;
  }

  const cacheKey = `${discoveryEndpoint}:${options.shape}`;
  const cached = discoveryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.capability;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.apiKey) {
    headers.Authorization = `ApiKey ${options.apiKey}`;
  }

  try {
    const response = await fetch(`${discoveryEndpoint}/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        pointer: {
          type: 'vesselCapability',
          shape: options.shape,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as DiscoveryResponse;
    const capability = payload.content?.vessels?.[0] ?? null;
    discoveryCache.set(cacheKey, {
      capability,
      expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS,
    });
    return capability;
  } catch {
    return null;
  }
}

export async function resolveServiceEndpointByShape(options: {
  explicitUrl?: string;
  discoveryEndpoint?: string;
  shape: string;
  apiKey?: string;
}): Promise<string | undefined> {
  if (options.explicitUrl) {
    return options.explicitUrl.replace(/\/$/, '');
  }

  const capability = await discoverFirstVesselByShape(options);
  return capability ? resolveVesselBaseUrl(capability, options.discoveryEndpoint) : undefined;
}

export function buildResolverUrl(capability: DiscoveryCapability, discoveryEndpoint?: string): string {
  const resolveEndpoint = capability.resolve_endpoint ?? '/v2/impulses/resolve';
  if (/^https?:\/\//.test(resolveEndpoint)) {
    return normalizeDiscoveredUrl(resolveEndpoint, discoveryEndpoint);
  }

  const url = new URL(resolveVesselBaseUrl(capability, discoveryEndpoint));
  url.pathname = resolveEndpoint.startsWith('/') ? resolveEndpoint : `/${resolveEndpoint}`;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}
