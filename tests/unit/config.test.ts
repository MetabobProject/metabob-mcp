import { afterEach, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applyConfigDefaults, configuredSubstrateUrls, getDefaultConfigPath, loadMetabobCLIConfig, loadMetabobEnvConfig, unattachedMessage, withoutEndpoints } from '../../src/config';

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
    discoveryEndpoint: undefined,
    identityEndpoint: undefined,
    conceptDbUrl: undefined,
    goalHostVesselUrl: undefined,
    sourcePath: path,
  });
});

test('loadMetabobCLIConfig falls back to instance api key and defaults no endpoint', () => {
  const path = writeConfigFile(JSON.stringify({
    instance: {
      apiKey: 'mb_instance_key',
    },
  }));

  // An apiKey-only config names no substrate: nothing is defaulted.
  expect(loadMetabobCLIConfig(path)).toEqual({
    apiKey: 'mb_instance_key',
    activityApiUrl: undefined,
    discoveryEndpoint: undefined,
    identityEndpoint: undefined,
    conceptDbUrl: undefined,
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
    identityEndpoint: undefined,
    conceptDbUrl: 'http://localhost:18260',
    goalHostVesselUrl: undefined,
    sourcePath: path,
  });
});

test('loadMetabobCLIConfig derives sibling endpoints from a REMOTE port-published substrate', () => {
  // A remote substrate that publishes ports directly (the deploy-remote.sh /
  // deploy-hub.sh shape) follows the same 18xxx block convention as a local one.
  // Gating the port-offset derivation on a localhost hostname sent this case to
  // the path-splitting reverse-proxy branch, which handed out
  // http://host:18080/discovery — a route no port-published deployment serves.
  // Every cockpit tool then 404s and reports the substrate as undiscoverable.
  const path = writeConfigFile(JSON.stringify({
    metabob: {
      apiKey: 'mb_test_key',
      endpoint: 'http://syzygy.host:18080',
    },
  }));

  expect(loadMetabobCLIConfig(path)).toEqual({
    apiKey: 'mb_test_key',
    activityApiUrl: 'http://syzygy.host:18080',
    discoveryEndpoint: 'http://syzygy.host:18100',
    identityEndpoint: undefined,
    conceptDbUrl: 'http://syzygy.host:18260',
    goalHostVesselUrl: undefined,
    sourcePath: path,
  });
});

test('loadMetabobCLIConfig derives nothing for a portless http endpoint', () => {
  // A bare http:// host has no explicit port, so it must NOT be read as
  // port-published (an implicit port 80 conforms to %100===80 and would derive
  // :100) — and no path-prefixed siblings are assumed either.
  const path = writeConfigFile(JSON.stringify({
    metabob: {
      apiKey: 'mb_test_key',
      endpoint: 'http://substrate.example',
    },
  }));

  const config = loadMetabobCLIConfig(path);
  expect(config?.discoveryEndpoint).toBeUndefined();
  expect(config?.conceptDbUrl).toBeUndefined();
});

test('loadMetabobCLIConfig prefers explicit substrate endpoints over derived defaults', () => {
  const path = writeConfigFile(JSON.stringify({
    metabob: {
      endpoint: 'http://localhost:18080',
      discoveryEndpoint: 'http://localhost:9990',
      identityEndpoint: 'http://localhost:9992',
      conceptDbUrl: 'http://localhost:9993',
      goalHostVesselUrl: 'http://localhost:9994',
    },
  }));

  expect(loadMetabobCLIConfig(path)).toEqual({
    apiKey: undefined,
    activityApiUrl: 'http://localhost:18080',
    discoveryEndpoint: 'http://localhost:9990',
    identityEndpoint: 'http://localhost:9992',
    conceptDbUrl: 'http://localhost:9993',
    goalHostVesselUrl: 'http://localhost:9994',
    sourcePath: path,
  });
});

test('loadMetabobEnvConfig treats METABOB_ENDPOINT as the gateway and derives siblings', () => {
  const config = loadMetabobEnvConfig({
    METABOB_API_KEY: 'mb_env_key',
    METABOB_ENDPOINT: 'https://substrate.example',
  });

  expect(config).toEqual({
    apiKey: 'mb_env_key',
    activityApiUrl: 'https://substrate.example',
    discoveryEndpoint: undefined,
    identityEndpoint: undefined,
    conceptDbUrl: undefined,
    goalHostVesselUrl: undefined,
    sourcePath: '<env:METABOB_ENDPOINT>',
  });
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
    metabob: { apiKey: 'mb_test_key', endpoint: 'http://127.0.0.1:18080' },
  }));

  const envA: NodeJS.ProcessEnv = { METABOB_API_KEY: 'mb_test_key', METABOB_ENDPOINT: 'http://127.0.0.1:18080' };
  applyConfigDefaults(envA, loadMetabobEnvConfig(envA));

  const envB: NodeJS.ProcessEnv = {};
  applyConfigDefaults(envB, loadMetabobCLIConfig(path));

  for (const key of ['ACTIVITY_API_URL', 'DISCOVERY_ENDPOINT', 'IDENTITY_ENDPOINT', 'CONCEPT_DB_URL']) {
    expect(envA[key]).toBe(envB[key]);
  }
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
    identityEndpoint: 'http://localhost:18101',
    conceptDbUrl: 'http://localhost:18260',
    goalHostVesselUrl: 'http://localhost:18210',
    sourcePath: '/tmp/config.json',
  });

  expect(env.METABOB_API_KEY).toBe('existing_key');
  expect(env.ACTIVITY_API_URL).toBe('https://activity.metabob.com');
  expect(env.DISCOVERY_ENDPOINT).toBe('http://localhost:18100');
  expect(env.IDENTITY_ENDPOINT).toBe('http://localhost:18101');
  expect(env.CONCEPT_DB_URL).toBe('http://localhost:18260');
  expect(env.GOAL_HOST_VESSEL_URL).toBe('http://localhost:18210');
});

test('an env-supplied key keeps the file endpoint (env apiKey via MCP client)', () => {
  // MCP clients inject METABOB_API_KEY via env while ~/.metabob/config.json
  // points at a local substrate: the file's endpoint still applies.
  const path = writeConfigFile(JSON.stringify({
    metabob: { apiKey: 'mb_file_key', endpoint: 'http://localhost:18080' },
  }));

  const env: NodeJS.ProcessEnv = { METABOB_API_KEY: 'mb_env_key' };
  applyConfigDefaults(env, loadMetabobEnvConfig(env));      // cli.ts order
  applyConfigDefaults(env, loadMetabobCLIConfig(path));

  expect(env.ACTIVITY_API_URL).toBe('http://localhost:18080');
  expect(env.DISCOVERY_ENDPOINT).toBe('http://localhost:18100');
  expect(env.METABOB_API_KEY).toBe('mb_env_key'); // env key still wins
});

test('explicit METABOB_ENDPOINT still beats the file endpoint', () => {
  const path = writeConfigFile(JSON.stringify({
    metabob: { apiKey: 'mb_file_key', endpoint: 'http://localhost:18080' },
  }));

  const env: NodeJS.ProcessEnv = {
    METABOB_API_KEY: 'mb_env_key',
    METABOB_ENDPOINT: 'https://substrate.example',
  };
  const envConfig = loadMetabobEnvConfig(env);              // cli.ts order
  applyConfigDefaults(env, envConfig);
  applyConfigDefaults(env, envConfig ? withoutEndpoints(loadMetabobCLIConfig(path)) : loadMetabobCLIConfig(path));

  expect(env.ACTIVITY_API_URL).toBe('https://substrate.example');
  // The file's local discovery must not fill the gap the remote gateway
  // leaves — that would split activity and discovery across two substrates.
  expect(env.DISCOVERY_ENDPOINT).toBeUndefined();
  expect(env.CONCEPT_DB_URL).toBeUndefined();
});

// ===== project-local config resolution (directory-aware, like git) =====

function makeTempDir(): string {
  const dir = join(tmpdir(), `metabob-mcp-proj-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempPaths.push(dir);
  return dir;
}

test('getDefaultConfigPath prefers project-local .metabob/config.json over the user config', () => {
  const proj = makeTempDir();
  mkdirSync(join(proj, '.metabob'), { recursive: true });
  writeFileSync(join(proj, '.metabob', 'config.json'), '{}', 'utf-8');

  const prevCwd = process.cwd();
  try {
    process.chdir(proj);
    expect(getDefaultConfigPath()).toBe(join(proj, '.metabob', 'config.json'));
  } finally {
    process.chdir(prevCwd);
  }
});

test('getDefaultConfigPath falls back to the user config when the project has none', () => {
  const proj = makeTempDir();
  const prevCwd = process.cwd();
  try {
    process.chdir(proj);
    expect(getDefaultConfigPath()).toContain('.metabob');
    expect(getDefaultConfigPath()).not.toContain(proj);
  } finally {
    process.chdir(prevCwd);
  }
});

test('loadMetabobCLIConfig picks up the project-local config from the launch directory', () => {
  const proj = makeTempDir();
  mkdirSync(join(proj, '.metabob'), { recursive: true });
  writeFileSync(
    join(proj, '.metabob', 'config.json'),
    JSON.stringify({ metabob: { apiKey: 'mb_project_key', endpoint: 'http://localhost:18080' } }),
    'utf-8',
  );

  const prevCwd = process.cwd();
  const prevConfigPath = process.env.METABOB_CONFIG_PATH;
  delete process.env.METABOB_CONFIG_PATH;
  try {
    process.chdir(proj);
    const config = loadMetabobCLIConfig();
    expect(config?.apiKey).toBe('mb_project_key');
    expect(config?.activityApiUrl).toBe('http://localhost:18080');
    expect(config?.discoveryEndpoint).toBe('http://localhost:18100');
    expect(config?.sourcePath).toBe(join(proj, '.metabob', 'config.json'));
  } finally {
    process.chdir(prevCwd);
    if (prevConfigPath === undefined) delete process.env.METABOB_CONFIG_PATH;
    else process.env.METABOB_CONFIG_PATH = prevConfigPath;
  }
});

test('METABOB_CONFIG_PATH overrides the project-local config', () => {
  const proj = makeTempDir();
  mkdirSync(join(proj, '.metabob'), { recursive: true });
  writeFileSync(
    join(proj, '.metabob', 'config.json'),
    JSON.stringify({ metabob: { apiKey: 'mb_project_key' } }),
    'utf-8',
  );
  const override = writeConfigFile(JSON.stringify({ metabob: { apiKey: 'mb_override_key' } }));

  const prevCwd = process.cwd();
  const prevConfigPath = process.env.METABOB_CONFIG_PATH;
  process.env.METABOB_CONFIG_PATH = override;
  try {
    process.chdir(proj);
    expect(loadMetabobCLIConfig()?.apiKey).toBe('mb_override_key');
  } finally {
    process.chdir(prevCwd);
    if (prevConfigPath === undefined) delete process.env.METABOB_CONFIG_PATH;
    else process.env.METABOB_CONFIG_PATH = prevConfigPath;
  }
});

// ===== one configuration: no default endpoint, one message when unattached =====

test('the installer-written config attaches: key + local endpoint, nothing else', () => {
  const path = writeConfigFile(JSON.stringify({
    metabob: { apiKey: 'mb_installer_key', endpoint: 'http://127.0.0.1:18080' },
  }));
  const env: NodeJS.ProcessEnv = {};
  applyConfigDefaults(env, loadMetabobEnvConfig(env));
  applyConfigDefaults(env, loadMetabobCLIConfig(path));

  expect(env.METABOB_API_KEY).toBe('mb_installer_key');
  expect(env.ACTIVITY_API_URL).toBe('http://127.0.0.1:18080');
  expect(env.DISCOVERY_ENDPOINT).toBe('http://127.0.0.1:18100');
  expect(env.CONCEPT_DB_URL).toBe('http://127.0.0.1:18260');
  expect(env.IDENTITY_ENDPOINT).toBeUndefined();
  expect(unattachedMessage(env)).toBeNull();
  expect(configuredSubstrateUrls(env)[0]).toBe('http://127.0.0.1:18100');
});

test('an api key alone names no endpoint, and the message says which input is missing', () => {
  const env: NodeJS.ProcessEnv = { METABOB_API_KEY: 'mb_env_key' };
  applyConfigDefaults(env, loadMetabobEnvConfig(env));

  expect(env.ACTIVITY_API_URL).toBeUndefined();
  expect(env.DISCOVERY_ENDPOINT).toBeUndefined();
  const message = unattachedMessage(env)!;
  expect(message).toContain('a substrate endpoint (METABOB_ENDPOINT');
  expect(message).not.toContain('API key');
  expect(message).toContain('$METABOB_CONFIG_PATH, then ./.metabob/config.json, then ~/.metabob/config.json');
});

test('with nothing configured, one message names both inputs', () => {
  const message = unattachedMessage({})!;
  expect(message).toContain('an API key (METABOB_API_KEY');
  expect(message).toContain('a substrate endpoint (METABOB_ENDPOINT');
  expect(message.split('\n')).toHaveLength(1);
});

test('an endpoint without a key names the key', () => {
  const message = unattachedMessage({ DISCOVERY_ENDPOINT: 'http://127.0.0.1:18100' })!;
  expect(message).toContain('an API key (METABOB_API_KEY');
  expect(message).not.toContain('substrate endpoint');
});
