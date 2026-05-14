import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const RawConfigSchema = z.object({
  metabob: z.object({
    apiKey: z.string().min(1).optional(),
    endpoint: z.string().min(1).optional(),
  }).optional(),
  instance: z.object({
    apiKey: z.string().min(1).optional(),
  }).optional(),
}).passthrough();

export interface MetabobCLIConfig {
  apiKey?: string;
  activityApiUrl?: string;
  sourcePath: string;
}

export function getDefaultConfigPath(): string {
  return join(homedir(), '.metabob', 'config.json');
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
  const activityApiUrl = result.data.metabob?.endpoint;

  if (!apiKey && !activityApiUrl) {
    return null;
  }

  return {
    apiKey,
    activityApiUrl,
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
}
