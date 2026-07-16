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
