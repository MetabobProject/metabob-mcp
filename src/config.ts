import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { deriveLocalDiscoveryEndpoint } from './discovery.js';

const RawConfigSchema = z.object({
  metabob: z.object({
    apiKey: z.string().min(1).optional(),
    endpoint: z.string().min(1).optional(),
    vesselId: z.string().min(1).optional(),
    discoveryEndpoint: z.string().min(1).optional(),
    identityEndpoint: z.string().min(1).optional(),
    conceptDbUrl: z.string().min(1).optional(),
    goalHostVesselUrl: z.string().min(1).optional(),
  }).optional(),
  instance: z.object({
    apiKey: z.string().min(1).optional(),
  }).optional(),
}).passthrough();

export interface MetabobCLIConfig {
  apiKey?: string;
  vesselId?: string;
  activityApiUrl?: string;
  discoveryEndpoint?: string;
  identityEndpoint?: string;
  conceptDbUrl?: string;
  goalHostVesselUrl?: string;
  sourcePath: string;
}

/**
 * Config resolution is directory-aware, like git: a project pins its own
 * backend by keeping .metabob/config.json in the directory the server is
 * launched from (MCP clients spawn stdio servers with cwd = project root).
 * Falls back to the per-user config when the project has none.
 * METABOB_CONFIG_PATH still overrides both (see loadMetabobCLIConfig).
 */
export function getDefaultConfigPath(): string {
  const projectConfig = join(process.cwd(), '.metabob', 'config.json');
  if (existsSync(projectConfig)) {
    return projectConfig;
  }
  return join(homedir(), '.metabob', 'config.json');
}

function normalizeUrl(urlString: string): string | undefined {
  try {
    return new URL(urlString).toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

/** Sibling services derived from the gateway endpoint — SPEC §endpoint-derivation, CONFORMANCE §c4-anchoring. */
function deriveSubstrateDefaults(activityApiUrl?: string): Pick<
  MetabobCLIConfig,
  'discoveryEndpoint' | 'conceptDbUrl'
> {
  // Local port-published substrate: the vessels sit at fixed offsets from the
  // activity port (18080 → discovery 18100, concept-db 18260;
  // same pattern for 8xxx and 28xxx prefixes).
  const localDiscovery = deriveLocalDiscoveryEndpoint(activityApiUrl);
  if (localDiscovery) {
    const base = new URL(activityApiUrl!);
    const activityPort = Number(base.port || 80);
    const portAt = (offset: number) => {
      const url = new URL(base);
      url.port = String(activityPort - 80 + offset);
      url.pathname = '';
      return url.toString().replace(/\/$/, '');
    };
    return {
      discoveryEndpoint: localDiscovery,
      conceptDbUrl: portAt(260),
    };
  }

  // No path-prefix derivation for remote endpoints: no live node serves
  // {endpoint}/discovery, /identity or /conceptdb, and encoding a reverse-proxy
  // layout is a pinned-topology assumption. A remote substrate is anchored by an
  // explicit discoveryEndpoint (DISCOVERY_ENDPOINT) plus the key; the vessels
  // the tools call are found through discovery.
  return {};
}

/**
 * Build a config from the environment. The attachment is two inputs:
 *
 *   METABOB_API_KEY   — the API key
 *   METABOB_ENDPOINT  — the substrate endpoint (no default)
 *
 * METABOB_ENDPOINT is the env-var mirror of `metabob.endpoint` from
 * ~/.metabob/config.json, and the siblings derive from it through
 * deriveSubstrateDefaults() exactly as they do for the file.
 *
 * This loader activates only on an explicit METABOB_ENDPOINT. The specific env
 * vars (DISCOVERY_ENDPOINT, CONCEPT_DB_URL, …) still win when set explicitly,
 * because applyConfigDefaults() only fills variables that are currently unset.
 */
export function loadMetabobEnvConfig(env: NodeJS.ProcessEnv = process.env): MetabobCLIConfig | null {
  const explicitEndpoint = env.METABOB_ENDPOINT?.trim() || undefined;
  if (!explicitEndpoint) {
    return null;
  }

  const activityApiUrl = normalizeUrl(explicitEndpoint);
  if (!activityApiUrl) {
    console.error(`[metabob-mcp] Ignoring malformed METABOB_ENDPOINT: ${explicitEndpoint}`);
    return null;
  }

  const apiKey = env.METABOB_API_KEY?.trim() || undefined;
  const derived = deriveSubstrateDefaults(activityApiUrl);

  return {
    apiKey,
    activityApiUrl,
    discoveryEndpoint: derived.discoveryEndpoint,
    identityEndpoint: undefined,
    conceptDbUrl: derived.conceptDbUrl,
    goalHostVesselUrl: undefined,
    sourcePath: '<env:METABOB_ENDPOINT>',
  };
}

export function loadMetabobCLIConfig(configPath = process.env.METABOB_CONFIG_PATH ?? getDefaultConfigPath()): MetabobCLIConfig | null {
  if (!existsSync(configPath)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[metabob-mcp] Failed to read ${configPath}: ${message}`);
    return null;
  }

  const result = RawConfigSchema.safeParse(parsed);
  if (!result.success) {
    console.error(
      `[metabob-mcp] Invalid config in ${configPath}: ${result.error.issues.map(issue => issue.message).join(', ')}`,
    );
    return null;
  }

  const apiKey = result.data.metabob?.apiKey ?? result.data.instance?.apiKey;
  const vesselId = result.data.metabob?.vesselId;
  // No endpoint means no endpoint: an apiKey-only config is not attached to
  // any substrate (see unattachedMessage).
  const activityApiUrl = normalizeUrl(result.data.metabob?.endpoint ?? '');
  const derived = deriveSubstrateDefaults(activityApiUrl);
  const discoveryEndpoint = normalizeUrl(result.data.metabob?.discoveryEndpoint ?? '') ?? derived.discoveryEndpoint;
  const identityEndpoint = normalizeUrl(result.data.metabob?.identityEndpoint ?? '');
  const conceptDbUrl = normalizeUrl(result.data.metabob?.conceptDbUrl ?? '') ?? derived.conceptDbUrl;
  const goalHostVesselUrl = normalizeUrl(result.data.metabob?.goalHostVesselUrl ?? '');

  if (!apiKey && !activityApiUrl && !discoveryEndpoint && !identityEndpoint && !conceptDbUrl && !goalHostVesselUrl) {
    return null;
  }

  return {
    apiKey,
    vesselId,
    activityApiUrl,
    discoveryEndpoint,
    identityEndpoint,
    conceptDbUrl,
    goalHostVesselUrl,
    sourcePath: configPath,
  };
}

/**
 * The credential half of a config (apiKey, vesselId) without its endpoints.
 * Used when an explicit METABOB_ENDPOINT already chose the substrate: the file's
 * endpoints describe a different substrate and must not fill the gaps the
 * explicit gateway left (a remote gateway derives no siblings), or discovery
 * and activity would split across two substrates.
 */
export function withoutEndpoints(config: MetabobCLIConfig | null): MetabobCLIConfig | null {
  if (!config) {
    return null;
  }
  return { apiKey: config.apiKey, vesselId: config.vesselId, sourcePath: config.sourcePath };
}

/** Fill only variables that are still unset, so the first loader applied wins — SPEC §precedence. */
export function applyConfigDefaults(
  env: NodeJS.ProcessEnv,
  config: MetabobCLIConfig | null,
): void {
  if (!config) {
    return;
  }

  if (!env.METABOB_API_KEY && config.apiKey) {
    env.METABOB_API_KEY = config.apiKey;
  }

  if (!env.VESSEL_ID && config.vesselId) {
    env.VESSEL_ID = config.vesselId;
  }

  if (!env.ACTIVITY_API_URL && config.activityApiUrl) {
    env.ACTIVITY_API_URL = config.activityApiUrl;
  }

  if (!env.DISCOVERY_ENDPOINT && config.discoveryEndpoint) {
    env.DISCOVERY_ENDPOINT = config.discoveryEndpoint;
  }

  if (!env.IDENTITY_ENDPOINT && config.identityEndpoint) {
    env.IDENTITY_ENDPOINT = config.identityEndpoint;
  }

  if (!env.CONCEPT_DB_URL && config.conceptDbUrl) {
    env.CONCEPT_DB_URL = config.conceptDbUrl;
  }

  if (!env.GOAL_HOST_VESSEL_URL && config.goalHostVesselUrl) {
    env.GOAL_HOST_VESSEL_URL = config.goalHostVesselUrl;
  }
}

/** Where a config file is looked for, in order — named in every "not attached" message. */
export const CONFIG_LOOKUP_ORDER = '$METABOB_CONFIG_PATH, then ./.metabob/config.json, then ~/.metabob/config.json';

/**
 * The one message for a process that is not attached to a substrate, or null
 * when it is. The attachment needs a key and an endpoint; this names whichever
 * is missing and where the configuration is read from, so a missing input
 * surfaces once instead of as an error from every service that needs it.
 * CONFORMANCE §c4-anchoring
 */
export function unattachedMessage(env: NodeJS.ProcessEnv = process.env): string | null {
  const hasKey = Boolean(env.METABOB_API_KEY?.trim());
  const hasEndpoint = Boolean(env.ACTIVITY_API_URL?.trim() || env.DISCOVERY_ENDPOINT?.trim());
  if (hasKey && hasEndpoint) {
    return null;
  }
  const missing = [
    hasKey ? null : 'an API key (METABOB_API_KEY, or metabob.apiKey in a config file)',
    hasEndpoint ? null : 'a substrate endpoint (METABOB_ENDPOINT, or metabob.endpoint in a config file)',
  ].filter(Boolean).join(' and ');
  return (
    `Not attached to a substrate: missing ${missing}. ` +
    `Config files are read from ${CONFIG_LOOKUP_ORDER}. ` +
    'Local tools work; substrate tools are unavailable until this is set.'
  );
}

/**
 * The configured substrate URLs, anchor first (discovery, then the endpoint),
 * for code that needs a host to name or probe: proxy selection, the TLS
 * fingerprint probe and doctor.
 */
export function configuredSubstrateUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const urls = [
    env.DISCOVERY_ENDPOINT,
    env.ACTIVITY_API_URL,
    env.IDENTITY_ENDPOINT,
    env.CONCEPT_DB_URL,
    env.GOAL_HOST_VESSEL_URL,
  ].map((u) => u?.trim()).filter((u): u is string => Boolean(u));
  return [...new Set(urls)];
}
