export interface DiscoveryCapability {
  vesselId: string;
  vesselName: string;
  endpoint: string;
  protocol?: string;
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

  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
    return undefined;
  }

  const activityPort = Number(url.port || 80);
  if (activityPort === 18080) {
    url.port = '18100';
  } else if (activityPort === 8080) {
    url.port = '8100';
  } else {
    return undefined;
  }

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
  return capability ? normalizeDiscoveredUrl(capability.endpoint, options.discoveryEndpoint) : undefined;
}

export function buildResolverUrl(capability: DiscoveryCapability, discoveryEndpoint?: string): string {
  const resolveEndpoint = capability.resolve_endpoint ?? '/v2/impulses/resolve';
  if (/^https?:\/\//.test(resolveEndpoint)) {
    return normalizeDiscoveredUrl(resolveEndpoint, discoveryEndpoint);
  }

  const url = new URL(normalizeDiscoveredUrl(capability.endpoint, discoveryEndpoint));
  url.pathname = resolveEndpoint.startsWith('/') ? resolveEndpoint : `/${resolveEndpoint}`;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}
