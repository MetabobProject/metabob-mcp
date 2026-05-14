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
    sourcePath: path,
  });
});

test('loadMetabobCLIConfig falls back to instance api key', () => {
  const path = writeConfigFile(JSON.stringify({
    instance: {
      apiKey: 'mb_instance_key',
    },
  }));

  expect(loadMetabobCLIConfig(path)).toEqual({
    apiKey: 'mb_instance_key',
    activityApiUrl: undefined,
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
    sourcePath: '/tmp/config.json',
  });

  expect(env.METABOB_API_KEY).toBe('existing_key');
  expect(env.ACTIVITY_API_URL).toBe('https://activity.metabob.com');
});
