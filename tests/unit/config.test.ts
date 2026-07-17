import { afterEach, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applyConfigDefaults, loadMetabobCLIConfig, loadMetabobDefaultConfig, loadMetabobEnvConfig } from '../../src/config';

const tempPaths: string[] = [];

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function writeConfigFile(contents: string): string {
  const dir = join(tmpdir(), `metabob-mcp-config-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json');
  writeFileSync(path, contents, 'utf-8');
  tempPaths.push(dir);
  return path;
}

test('loadMetabobCLIConfig reads api key and activity endpoint from metabob config', () => {
  const path = writeConfigFile(JSON.stringify({
    metabob: {
      apiKey: 'mb_test_key',
      endpoint: 'https://activity.metabob.com',
    },
  }));

  expect(loadMetabobCLIConfig(path)).toEqual({
    apiKey: 'mb_test_key',
    activityApiUrl: 'https://activity.metabob.com',
    discoveryEndpoint: 'https://activity.metabob.com/discovery',
    analysisApiUrl: 'https://activity.metabob.com/analysis',
    identityEndpoint: 'https://activity.metabob.com/identity',
    conceptDbUrl: 'https://activity.metabob.com/conceptdb',
    goalHostVesselUrl: undefined,
    sourcePath: path,
  });
});

test('loadMetabobCLIConfig falls back to instance api key and defaults the endpoint', () => {
  const path = writeConfigFile(JSON.stringify({
    instance: {
      apiKey: 'mb_instance_key',
    },
  }));

  // An apiKey-only config routes everything through the single public
  // endpoint — identity included, never a specialized host.
  expect(loadMetabobCLIConfig(path)).toEqual({
    apiKey: 'mb_instance_key',
    activityApiUrl: 'https://ide.metabob.com',
    discoveryEndpoint: 'https://ide.metabob.com/discovery',
    analysisApiUrl: 'https://ide.metabob.com/analysis',
    identityEndpoint: 'https://ide.metabob.com/identity',
    conceptDbUrl: 'https://ide.metabob.com/conceptdb',
    goalHostVesselUrl: undefined,
    sourcePath: path,
  });
});

test('loadMetabobCLIConfig derives substrate sibling endpoints from local activity endpoint', () => {
  const path = writeConfigFile(JSON.stringify({
    metabob: {
      apiKey: 'mb_test_key',
      endpoint: 'http://localhost:18080',
    },
  }));

  expect(loadMetabobCLIConfig(path)).toEqual({
    apiKey: 'mb_test_key',
    activityApiUrl: 'http://localhost:18080',
    discoveryEndpoint: 'http://localhost:18100',
    analysisApiUrl: 'http://localhost:18250',
    identityEndpoint: undefined,
    conceptDbUrl: 'http://localhost:18260',
    goalHostVesselUrl: undefined,
    sourcePath: path,
  });
});

test('loadMetabobCLIConfig prefers explicit substrate endpoints over derived defaults', () => {
  const path = writeConfigFile(JSON.stringify({
    metabob: {
      endpoint: 'http://localhost:18080',
      discoveryEndpoint: 'http://localhost:9990',
      analysisApiUrl: 'http://localhost:9991',
      identityEndpoint: 'http://localhost:9992',
      conceptDbUrl: 'http://localhost:9993',
      goalHostVesselUrl: 'http://localhost:9994',
    },
  }));

  expect(loadMetabobCLIConfig(path)).toEqual({
    apiKey: undefined,
    activityApiUrl: 'http://localhost:18080',
    discoveryEndpoint: 'http://localhost:9990',
    analysisApiUrl: 'http://localhost:9991',
    identityEndpoint: 'http://localhost:9992',
    conceptDbUrl: 'http://localhost:9993',
    goalHostVesselUrl: 'http://localhost:9994',
    sourcePath: path,
  });
});

test('loadMetabobEnvConfig treats METABOB_ENDPOINT as the gateway and derives siblings', () => {
  const config = loadMetabobEnvConfig({
    METABOB_API_KEY: 'mb_env_key',
    METABOB_ENDPOINT: 'https://ide.metabob.com',
  });

  expect(config).toEqual({
    apiKey: 'mb_env_key',
    activityApiUrl: 'https://ide.metabob.com',
    discoveryEndpoint: 'https://ide.metabob.com/discovery',
    analysisApiUrl: 'https://ide.metabob.com/analysis',
    identityEndpoint: 'https://ide.metabob.com/identity',
    conceptDbUrl: 'https://ide.metabob.com/conceptdb',
    goalHostVesselUrl: undefined,
    sourcePath: '<env:METABOB_ENDPOINT>',
  });
});

test('loadMetabobDefaultConfig defaults the endpoint to ide.metabob.com — api key alone is valid', () => {
  expect(loadMetabobEnvConfig({ METABOB_API_KEY: 'mb_env_key' })).toBeNull();
  const config = loadMetabobDefaultConfig({ METABOB_API_KEY: 'mb_env_key' });

  expect(config).toEqual({
    apiKey: 'mb_env_key',
    activityApiUrl: 'https://ide.metabob.com',
    discoveryEndpoint: 'https://ide.metabob.com/discovery',
    analysisApiUrl: 'https://ide.metabob.com/analysis',
    identityEndpoint: 'https://ide.metabob.com/identity',
    conceptDbUrl: 'https://ide.metabob.com/conceptdb',
    goalHostVesselUrl: undefined,
    sourcePath: '<env:default-endpoint>',
  });
});

test('loadMetabobEnvConfig leaves the legacy ANALYSIS_API_URL-only style untouched', () => {
  const env: NodeJS.ProcessEnv = {
    METABOB_API_KEY: 'mb_env_key',
    ANALYSIS_API_URL: 'https://custom.example',
  };
  // No METABOB_ENDPOINT → both loaders stay inert → nothing changes.
  applyConfigDefaults(env, loadMetabobEnvConfig(env));
  applyConfigDefaults(env, loadMetabobDefaultConfig(env));

  expect(env.ANALYSIS_API_URL).toBe('https://custom.example');
  expect(env.ACTIVITY_API_URL).toBeUndefined();
  expect(env.DISCOVERY_ENDPOINT).toBeUndefined();
  expect(env.IDENTITY_ENDPOINT).toBeUndefined();
  expect(env.CONCEPT_DB_URL).toBeUndefined();
});

test('loadMetabobEnvConfig derives local substrate ports from METABOB_ENDPOINT', () => {
  const config = loadMetabobEnvConfig({
    METABOB_API_KEY: 'mb_env_key',
    METABOB_ENDPOINT: 'http://localhost:18080',
  });

  expect(config).toEqual({
    apiKey: 'mb_env_key',
    activityApiUrl: 'http://localhost:18080',
    discoveryEndpoint: 'http://localhost:18100',
    analysisApiUrl: 'http://localhost:18250',
    identityEndpoint: undefined,
    conceptDbUrl: 'http://localhost:18260',
    goalHostVesselUrl: undefined,
    sourcePath: '<env:METABOB_ENDPOINT>',
  });
});

test('loadMetabobEnvConfig returns null when neither key nor endpoint is set', () => {
  expect(loadMetabobEnvConfig({})).toBeNull();
});

test('env-var path derives the same endpoints as the config-file path', () => {
  const path = writeConfigFile(JSON.stringify({
    metabob: { apiKey: 'mb_test_key', endpoint: 'https://ide.metabob.com' },
  }));

  const envA: NodeJS.ProcessEnv = { METABOB_API_KEY: 'mb_test_key', METABOB_ENDPOINT: 'https://ide.metabob.com' };
  applyConfigDefaults(envA, loadMetabobEnvConfig(envA));

  const envB: NodeJS.ProcessEnv = {};
  applyConfigDefaults(envB, loadMetabobCLIConfig(path));

  for (const key of ['ACTIVITY_API_URL', 'ANALYSIS_API_URL', 'DISCOVERY_ENDPOINT', 'IDENTITY_ENDPOINT', 'CONCEPT_DB_URL']) {
    expect(envA[key]).toBe(envB[key]);
  }
});

test('explicit ANALYSIS_API_URL still wins over the METABOB_ENDPOINT-derived value', () => {
  const env: NodeJS.ProcessEnv = {
    METABOB_API_KEY: 'mb_env_key',
    METABOB_ENDPOINT: 'https://ide.metabob.com',
    ANALYSIS_API_URL: 'https://custom.example/analysis',
  };
  applyConfigDefaults(env, loadMetabobEnvConfig(env));

  expect(env.ANALYSIS_API_URL).toBe('https://custom.example/analysis');
  // …but the untouched siblings still derive from the gateway.
  expect(env.DISCOVERY_ENDPOINT).toBe('https://ide.metabob.com/discovery');
});

test('loadMetabobCLIConfig returns null for invalid json', () => {
  const path = writeConfigFile('{invalid');
  const stderr = mock(() => {});
  const original = console.error;
  console.error = stderr;

  try {
    expect(loadMetabobCLIConfig(path)).toBeNull();
    expect(stderr).toHaveBeenCalled();
  } finally {
    console.error = original;
  }
});

test('applyConfigDefaults fills only missing environment values', () => {
  const env: NodeJS.ProcessEnv = {
    METABOB_API_KEY: 'existing_key',
  };

  applyConfigDefaults(env, {
    apiKey: 'config_key',
    activityApiUrl: 'https://activity.metabob.com',
    discoveryEndpoint: 'http://localhost:18100',
    analysisApiUrl: 'http://localhost:18250',
    identityEndpoint: 'http://localhost:18101',
    conceptDbUrl: 'http://localhost:18260',
    goalHostVesselUrl: 'http://localhost:18210',
    sourcePath: '/tmp/config.json',
  });

  expect(env.METABOB_API_KEY).toBe('existing_key');
  expect(env.ACTIVITY_API_URL).toBe('https://activity.metabob.com');
  expect(env.DISCOVERY_ENDPOINT).toBe('http://localhost:18100');
  expect(env.ANALYSIS_API_URL).toBe('http://localhost:18250');
  expect(env.IDENTITY_ENDPOINT).toBe('http://localhost:18101');
  expect(env.CONCEPT_DB_URL).toBe('http://localhost:18260');
  expect(env.GOAL_HOST_VESSEL_URL).toBe('http://localhost:18210');
});

test('file-supplied endpoint beats the api-key-alone default (env apiKey via MCP client)', () => {
  // Regression: MCP clients inject METABOB_API_KEY via env while
  // ~/.metabob/config.json points at a local substrate. The defaulted public
  // gateway must NOT preempt the file endpoint.
  const path = writeConfigFile(JSON.stringify({
    metabob: { apiKey: 'mb_file_key', endpoint: 'http://localhost:18080' },
  }));

  const env: NodeJS.ProcessEnv = { METABOB_API_KEY: 'mb_env_key' };
  applyConfigDefaults(env, loadMetabobEnvConfig(env));      // cli.ts order
  applyConfigDefaults(env, loadMetabobCLIConfig(path));
  applyConfigDefaults(env, loadMetabobDefaultConfig(env));

  expect(env.ACTIVITY_API_URL).toBe('http://localhost:18080');
  expect(env.DISCOVERY_ENDPOINT).toBe('http://localhost:18100');
  expect(env.ANALYSIS_API_URL).toBe('http://localhost:18250');
  expect(env.METABOB_API_KEY).toBe('mb_env_key'); // env key still wins
});

test('explicit METABOB_ENDPOINT still beats the file endpoint', () => {
  const path = writeConfigFile(JSON.stringify({
    metabob: { apiKey: 'mb_file_key', endpoint: 'http://localhost:18080' },
  }));

  const env: NodeJS.ProcessEnv = {
    METABOB_API_KEY: 'mb_env_key',
    METABOB_ENDPOINT: 'https://ide.metabob.com',
  };
  applyConfigDefaults(env, loadMetabobEnvConfig(env));
  applyConfigDefaults(env, loadMetabobCLIConfig(path));
  applyConfigDefaults(env, loadMetabobDefaultConfig(env));

  expect(env.ACTIVITY_API_URL).toBe('https://ide.metabob.com');
  expect(env.DISCOVERY_ENDPOINT).toBe('https://ide.metabob.com/discovery');
});
