import { afterEach, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applyConfigDefaults, loadMetabobCLIConfig } from '../../src/config';

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
