import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { deriveLocalDiscoveryEndpoint } from './discovery.js';

const RawConfigSchema = z.object({
  metabob: z.object({
    apiKey: z.string().min(1).optional(),
    endpoint: z.string().min(1).optional(),
    discoveryEndpoint: z.string().min(1).optional(),
    analysisApiUrl: z.string().min(1).optional(),
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
  activityApiUrl?: string;
  discoveryEndpoint?: string;
  analysisApiUrl?: string;
  identityEndpoint?: string;
  conceptDbUrl?: string;
  goalHostVesselUrl?: string;
  sourcePath: string;
}

/** The single public endpoint. Every sibling service derives from it. */
export const DEFAULT_ENDPOINT = 'https://ide.metabob.com';

export function getDefaultConfigPath(): string {
  return join(homedir(), '.metabob', 'config.json');
}

function normalizeUrl(urlString: string): string | undefined {
  try {
    return new URL(urlString).toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function deriveSubstrateDefaults(activityApiUrl?: string): Pick<
  MetabobCLIConfig,
  'discoveryEndpoint' | 'analysisApiUrl' | 'identityEndpoint' | 'conceptDbUrl'
> {
  // Local port-published substrate: the vessels sit at fixed offsets from the
  // activity port (18080 → discovery 18100, analysis 18250, concept-db 18260;
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
      analysisApiUrl: portAt(250),
      conceptDbUrl: portAt(260),
    };
  }

  // Remote substrate behind a path-splitting reverse proxy: sibling services
  // live under conventional path prefixes of the same base endpoint.
  if (activityApiUrl && /^https?:\/\/[^/]+$/.test(activityApiUrl)) {
    return {
      discoveryEndpoint: `${activityApiUrl}/discovery`,
      analysisApiUrl: `${activityApiUrl}/analysis`,
      identityEndpoint: `${activityApiUrl}/identity`,
      conceptDbUrl: `${activityApiUrl}/conceptdb`,
    };
  }

  return {};
}

/**
 * Env vars that manually pin a specific substrate endpoint. Their presence
 * (without METABOB_ENDPOINT) marks the legacy / hand-configured env style,
 * where we must NOT auto-default the gateway — see loadMetabobEnvConfig.
 */
const SPECIFIC_ENDPOINT_ENV_VARS = [
  'ANALYSIS_API_URL',
  'ACTIVITY_API_URL',
  'DISCOVERY_ENDPOINT',
  'IDENTITY_ENDPOINT',
  'CONCEPT_DB_URL',
  'GOAL_HOST_VESSEL_URL',
] as const;

/**
 * Build a config from the environment — the canonical minimal setup is just:
 *
 *   METABOB_API_KEY   — the API key
 *   METABOB_ENDPOINT  — the gateway in the vessel (optional; DEFAULTS to
 *                       https://ide.metabob.com)
 *
 * METABOB_ENDPOINT is the env-var mirror of `metabob.endpoint` from
 * ~/.metabob/config.json: it points at the gateway and every sibling service
 * (analysis, discovery, identity, concept-db) is derived from it via
 * deriveSubstrateDefaults(), keeping the env-var and config-file paths
 * byte-for-byte equivalent.
 *
 * The endpoint DEFAULTS to the public deployment, so an API key alone is a
 * valid, fully-derived config (analysis at https://ide.metabob.com/analysis,
 * plus discovery/identity/concept-db) — identical to an api-key-only
 * ~/.metabob/config.json.
 *
 * The one carve-out preserves the older env style: if the user has manually
 * pinned a specific endpoint var (e.g. METABOB_API_KEY + ANALYSIS_API_URL, as
 * in the historical Claude Desktop / Cursor examples) WITHOUT setting
 * METABOB_ENDPOINT, we stay inert rather than forcing the remaining siblings
 * onto the default gateway (which would split-brain their routing). Setting
 * METABOB_ENDPOINT is the explicit opt-in that overrides even that carve-out.
 *
 * Precedence note: the specific env vars (ANALYSIS_API_URL, DISCOVERY_ENDPOINT,
 * …) still win when set explicitly, because applyConfigDefaults() only fills
 * variables that are currently unset.
 */
export function loadMetabobEnvConfig(env: NodeJS.ProcessEnv = process.env): MetabobCLIConfig | null {
  const explicitEndpoint = env.METABOB_ENDPOINT?.trim() || undefined;
  const apiKey = env.METABOB_API_KEY?.trim() || undefined;

  // Legacy / hand-configured style: specific endpoint vars set, no gateway var.
  // Leave it untouched — the user is driving those endpoints themselves.
  const hasManualEndpoint = SPECIFIC_ENDPOINT_ENV_VARS.some((k) => !!env[k]?.trim());
  if (!explicitEndpoint && hasManualEndpoint) {
    return null;
  }

  // Endpoint defaults to the public deployment: an api key alone is valid.
  const endpoint = explicitEndpoint ?? (apiKey ? DEFAULT_ENDPOINT : undefined);
  if (!endpoint) {
    return null;
  }

  const activityApiUrl = normalizeUrl(endpoint);
  if (!activityApiUrl) {
    console.error(`[metabob-mcp] Ignoring malformed METABOB_ENDPOINT: ${endpoint}`);
    return null;
  }

  const derived = deriveSubstrateDefaults(activityApiUrl);

  return {
    apiKey,
    activityApiUrl,
    discoveryEndpoint: derived.discoveryEndpoint,
    analysisApiUrl: derived.analysisApiUrl,
    identityEndpoint: derived.identityEndpoint,
    conceptDbUrl: derived.conceptDbUrl,
    goalHostVesselUrl: undefined,
    sourcePath: explicitEndpoint ? '<env:METABOB_ENDPOINT>' : '<env:default-endpoint>',
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
  // An apiKey-only config is valid: the endpoint defaults to the public
  // deployment and every sibling service (identity included) derives from it.
  // Nothing defaults to a specialized host — all traffic routes through the
  // one endpoint.
  const activityApiUrl = normalizeUrl(result.data.metabob?.endpoint ?? '')
    ?? (apiKey ? DEFAULT_ENDPOINT : undefined);
  const derived = deriveSubstrateDefaults(activityApiUrl);
  const discoveryEndpoint = normalizeUrl(result.data.metabob?.discoveryEndpoint ?? '') ?? derived.discoveryEndpoint;
  const analysisApiUrl = normalizeUrl(result.data.metabob?.analysisApiUrl ?? '') ?? derived.analysisApiUrl;
  const identityEndpoint = normalizeUrl(result.data.metabob?.identityEndpoint ?? '') ?? derived.identityEndpoint;
  const conceptDbUrl = normalizeUrl(result.data.metabob?.conceptDbUrl ?? '') ?? derived.conceptDbUrl;
  const goalHostVesselUrl = normalizeUrl(result.data.metabob?.goalHostVesselUrl ?? '');

  if (!apiKey && !activityApiUrl && !discoveryEndpoint && !analysisApiUrl && !identityEndpoint && !conceptDbUrl && !goalHostVesselUrl) {
    return null;
  }

  return {
    apiKey,
    activityApiUrl,
    discoveryEndpoint,
    analysisApiUrl,
    identityEndpoint,
    conceptDbUrl,
    goalHostVesselUrl,
    sourcePath: configPath,
  };
}

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

  if (!env.ACTIVITY_API_URL && config.activityApiUrl) {
    env.ACTIVITY_API_URL = config.activityApiUrl;
  }

  if (!env.DISCOVERY_ENDPOINT && config.discoveryEndpoint) {
    env.DISCOVERY_ENDPOINT = config.discoveryEndpoint;
  }

  if (!env.ANALYSIS_API_URL && config.analysisApiUrl) {
    env.ANALYSIS_API_URL = config.analysisApiUrl;
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
