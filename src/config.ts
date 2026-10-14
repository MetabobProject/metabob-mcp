import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const RawConfigSchema = z.object({
  metabob: z.object({
    apiKey: z.string().min(1).optional(),
    endpoint: z.string().min(1).optional(),
    vesselId: z.string().min(1).optional(),
    discoveryEndpoint: z.string().min(1).optional(),
    identityEndpoint: z.string().min(1).optional(),
  }).optional(),
  instance: z.object({
    apiKey: z.string().min(1).optional(),
  }).optional(),
}).passthrough();

export interface MetabobCLIConfig {
  apiKey?: string;
  vesselId?: string;
  /** The substrate endpoint (`metabob.endpoint` / METABOB_ENDPOINT); a local one derives discovery. */
  endpoint?: string;
  discoveryEndpoint?: string;
  /** True when `discoveryEndpoint` was derived from the endpoint (census class H1) rather than given. */
  discoveryDerived?: boolean;
  identityEndpoint?: string;
  sourcePath: string;
}

// @anchor config-lookup
/**
 * Config resolution is directory-aware, like git: a project pins its own
 * backend by keeping .substrate/config.json or .metabob/config.json in the
 * directory the server is launched from (MCP clients spawn stdio servers with
 * cwd = project root). Falls back to the per-user config — `~/.substrate`,
 * which the substrate installer writes, then `~/.metabob` — when the project
 * has none. SUBSTRATE_CONFIG_PATH, then METABOB_CONFIG_PATH, override all of
 * them (configPathFromEnv). SPEC §configuration-lookup
 */
export function getDefaultConfigPath(): string {
  const candidates = [
    join(process.cwd(), '.substrate', 'config.json'),
    join(process.cwd(), '.metabob', 'config.json'),
    join(homedir(), '.substrate', 'config.json'),
    join(homedir(), '.metabob', 'config.json'),
  ];
  // None exists: name the installer's path, the one to create.
  return candidates.find((c) => existsSync(c)) ?? candidates[2]!;
}

/** An explicit config path from the environment: SUBSTRATE_CONFIG_PATH, then METABOB_CONFIG_PATH. */
export function configPathFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.SUBSTRATE_CONFIG_PATH?.trim() || env.METABOB_CONFIG_PATH?.trim() || undefined;
}

/** The config file this process reads: the explicit path, else the first that exists in the lookup order. */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return configPathFromEnv(env) ?? getDefaultConfigPath();
}

// @anchor substrate-env-aliases
/**
 * The installer's environment names, accepted alongside this server's:
 * SUBSTRATE_API_KEY and SUBSTRATE_ENDPOINT fill METABOB_API_KEY and
 * METABOB_ENDPOINT when those are unset. When both names are set and differ,
 * the METABOB_* value wins, and the conflict is returned as one warning to log
 * once. Runs before the config loaders. SPEC §configuration-lookup
 */
export function applySubstrateEnvAliases(env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = [];
  for (const [alias, name] of [['SUBSTRATE_API_KEY', 'METABOB_API_KEY'], ['SUBSTRATE_ENDPOINT', 'METABOB_ENDPOINT']] as const) {
    const aliasValue = env[alias]?.trim();
    if (!aliasValue) continue;
    const value = env[name]?.trim();
    if (!value) {
      env[name] = aliasValue;
    } else if (value !== aliasValue) {
      warnings.push(`${alias} and ${name} are both set and differ; using ${name}.`);
    }
  }
  return warnings;
}

function normalizeUrl(urlString: string): string | undefined {
  try {
    return new URL(urlString).toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

/**
 * The local-substrate branch of SPEC §endpoint-derivation: an endpoint on an
 * explicit http port ≡ 80 (mod 100) — 8080, 18080, 28080, … — names a
 * port-published substrate whose discovery sits at the same block's …100.
 * Census class H1 interim debt (CONFORMANCE §c4-anchoring): kept only until the
 * substrate installer writes the discovery endpoint into the client config.
 *
 * What signals the convention is the PORT, not the hostname: a remote
 * port-published substrate derives the same way. A bare `http://host` (implicit
 * port 80) and any https:// endpoint derive nothing.
 */
export function deriveLocalDiscoveryEndpoint(endpoint?: string): string | undefined {
  if (!endpoint) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }

  if (url.protocol !== 'http:' || !url.port) {
    return undefined;
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port % 100 !== 80) {
    return undefined;
  }
  url.port = String(port - 80 + 100);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/**
 * Build a config from the environment. The attachment is two inputs:
 *
 *   METABOB_API_KEY   — the API key
 *   METABOB_ENDPOINT  — the substrate endpoint (no default)
 *
 * METABOB_ENDPOINT is the env-var mirror of `metabob.endpoint` from
 * ~/.metabob/config.json, and discovery derives from a local one exactly as it
 * does for the file.
 *
 * This loader activates only on an explicit METABOB_ENDPOINT. DISCOVERY_ENDPOINT
 * and IDENTITY_ENDPOINT still win when set explicitly, because
 * applyConfigDefaults() only fills variables that are currently unset.
 */
export function loadMetabobEnvConfig(env: NodeJS.ProcessEnv = process.env): MetabobCLIConfig | null {
  const explicitEndpoint = env.METABOB_ENDPOINT?.trim() || undefined;
  if (!explicitEndpoint) {
    return null;
  }

  const endpoint = normalizeUrl(explicitEndpoint);
  if (!endpoint) {
    console.error(`[metabob-mcp] Ignoring malformed METABOB_ENDPOINT: ${explicitEndpoint}`);
    return null;
  }

  const apiKey = env.METABOB_API_KEY?.trim() || undefined;
  const discoveryEndpoint = deriveLocalDiscoveryEndpoint(endpoint);

  return {
    apiKey,
    endpoint,
    discoveryEndpoint,
    discoveryDerived: Boolean(discoveryEndpoint),
    identityEndpoint: undefined,
    sourcePath: '<env:METABOB_ENDPOINT>',
  };
}

export function loadMetabobCLIConfig(configPath = resolveConfigPath()): MetabobCLIConfig | null {
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
  const endpoint = normalizeUrl(result.data.metabob?.endpoint ?? '');
  const explicitDiscovery = normalizeUrl(result.data.metabob?.discoveryEndpoint ?? '');
  const discoveryEndpoint = explicitDiscovery ?? deriveLocalDiscoveryEndpoint(endpoint);
  const identityEndpoint = normalizeUrl(result.data.metabob?.identityEndpoint ?? '');

  if (!apiKey && !endpoint && !discoveryEndpoint && !identityEndpoint) {
    return null;
  }

  return {
    apiKey,
    vesselId,
    endpoint,
    discoveryEndpoint,
    discoveryDerived: !explicitDiscovery && Boolean(discoveryEndpoint),
    identityEndpoint,
    sourcePath: configPath,
  };
}

/**
 * The credential half of a config (apiKey, vesselId) without its endpoints.
 * Used when an explicit METABOB_ENDPOINT already chose the substrate: the file's
 * endpoints describe a different substrate and must not fill the gaps the
 * explicit endpoint left (a remote endpoint derives no discovery), or the
 * attachment would split across two substrates.
 */
export function withoutEndpoints(config: MetabobCLIConfig | null): MetabobCLIConfig | null {
  if (!config) {
    return null;
  }
  return { apiKey: config.apiKey, vesselId: config.vesselId, sourcePath: config.sourcePath };
}

/** Per environment: the discovery URL applyConfigDefaults filled from a derivation. */
const derivedDiscoveryEndpoints = new WeakMap<NodeJS.ProcessEnv, string>();

/**
 * How the discovery URL in `env` was obtained: `explicit` (DISCOVERY_ENDPOINT
 * or metabob.discoveryEndpoint), `derived-h1` (port-offset derivation from the
 * endpoint, census class H1 — forbidden by CONFORMANCE §c4-anchoring and kept
 * only until the substrate installer writes the discovery endpoint), or `none`.
 */
export function discoveryEndpointSource(env: NodeJS.ProcessEnv = process.env): 'explicit' | 'derived-h1' | 'none' {
  const value = env.DISCOVERY_ENDPOINT?.trim();
  if (!value) return 'none';
  return derivedDiscoveryEndpoints.get(env) === value ? 'derived-h1' : 'explicit';
}

/**
 * The one WARN for a derived discovery URL, or null when it is explicit.
 * CONFORMANCE §c4-anchoring
 */
export function derivedDiscoveryWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  if (discoveryEndpointSource(env) !== 'derived-h1') return null;
  return (
    `The discovery endpoint ${env.DISCOVERY_ENDPOINT} is derived from the substrate endpoint by the ` +
    'published-port convention (…080 → …100), census class H1, which CONFORMANCE §c4-anchoring forbids. ' +
    'It is interim debt: the substrate installer will write metabob.discoveryEndpoint into the client config.'
  );
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

  if (!env.METABOB_ENDPOINT && config.endpoint) {
    env.METABOB_ENDPOINT = config.endpoint;
  }

  if (!env.DISCOVERY_ENDPOINT && config.discoveryEndpoint) {
    env.DISCOVERY_ENDPOINT = config.discoveryEndpoint;
    if (config.discoveryDerived) derivedDiscoveryEndpoints.set(env, config.discoveryEndpoint);
  }

  if (!env.IDENTITY_ENDPOINT && config.identityEndpoint) {
    env.IDENTITY_ENDPOINT = config.identityEndpoint;
  }
}

/** Where a config file is looked for, in order — named in every "not attached" message. */
export const CONFIG_LOOKUP_ORDER =
  '$SUBSTRATE_CONFIG_PATH, then $METABOB_CONFIG_PATH, then ./.substrate/config.json, then ./.metabob/config.json, ' +
  'then ~/.substrate/config.json, then ~/.metabob/config.json';

/**
 * The one message for a process that is not attached to a substrate, or null
 * when it is. The attachment needs a key and an endpoint; this names whichever
 * is missing and where the configuration is read from, so a missing input
 * surfaces once instead of as an error from every service that needs it.
 * CONFORMANCE §c4-anchoring
 */
export function unattachedMessage(env: NodeJS.ProcessEnv = process.env): string | null {
  const hasKey = Boolean(env.METABOB_API_KEY?.trim());
  const hasEndpoint = Boolean(env.METABOB_ENDPOINT?.trim() || env.DISCOVERY_ENDPOINT?.trim());
  if (hasKey && hasEndpoint) {
    return null;
  }
  const missing = [
    hasKey ? null : 'an API key (METABOB_API_KEY or SUBSTRATE_API_KEY, or metabob.apiKey in a config file)',
    hasEndpoint ? null : 'a substrate endpoint (METABOB_ENDPOINT or SUBSTRATE_ENDPOINT, or metabob.endpoint in a config file)',
  ].filter(Boolean).join(' and ');
  return (
    `Not attached to a substrate: missing ${missing}. ` +
    `Config files are read from ${CONFIG_LOOKUP_ORDER}. ` +
    'Local tools work; substrate tools are unavailable until this is set.'
  );
}

/**
 * The configured substrate URLs, anchor first (discovery, then the endpoint
 * and an explicit identity), for code that needs a host to name or probe:
 * proxy selection, the TLS fingerprint probe and doctor. No request is routed
 * by them: substrate calls go through the attachment.
 */
export function configuredSubstrateUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const urls = [
    env.DISCOVERY_ENDPOINT,
    env.METABOB_ENDPOINT,
    env.IDENTITY_ENDPOINT,
  ].map((u) => u?.trim()).filter((u): u is string => Boolean(u));
  return [...new Set(urls)];
}

// @anchor apply-configuration
/**
 * Fill `env` with the attachment's inputs, lowest precedence last: the
 * installer's env names (applySubstrateEnvAliases), then METABOB_ENDPOINT's
 * derivation, then the config file — whose endpoints are ignored when an
 * explicit endpoint already chose the substrate (withoutEndpoints). Proxy and
 * trust are never configuration: they come from the environment and the OS.
 * Answers the config file read and any warnings to log once. SPEC §precedence
 */
export function applyConfiguration(env: NodeJS.ProcessEnv = process.env): { configPath: string; warnings: string[] } {
  const warnings = applySubstrateEnvAliases(env);
  const envConfig = loadMetabobEnvConfig(env);
  applyConfigDefaults(env, envConfig);
  const configPath = resolveConfigPath(env);
  const fileConfig = loadMetabobCLIConfig(configPath);
  applyConfigDefaults(env, envConfig ? withoutEndpoints(fileConfig) : fileConfig);
  return { configPath, warnings };
}
