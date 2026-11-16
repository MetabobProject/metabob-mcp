/**
 * metabob.apiKeyFile (SPEC §config-file-schema): the key read from a JSON file of another layout, by path and field.
 * Whatever the file holds is never logged: each failure says only whether the file exists, is JSON, and holds a string
 * at the field.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyConfigDefaults, loadMetabobCLIConfig } from '../../src/config';

const KEY = 'mb_fixture_cockpit_key';
const ENDPOINT = 'https://substrate.example';

let spy: ReturnType<typeof spyOn> | undefined;
afterEach(() => spy?.mockRestore());

/** A config dir holding `config.json` (the metabob section given) and, when given, `creds.json`. */
function setup(metabob: Record<string, unknown>, creds?: string): { path: string; dir: string; logged: () => string } {
  const dir = mkdtempSync(join(tmpdir(), 'keyfile-'));
  if (creds !== undefined) writeFileSync(join(dir, 'creds.json'), creds);
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ metabob: { endpoint: ENDPOINT, ...metabob } }));
  const lines: string[] = [];
  spy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  return { path, dir, logged: () => lines.join('\n') };
}

describe('metabob.apiKeyFile', () => {
  test('takes the key at a dotted field of another JSON layout, relative to the config file', () => {
    const { path, logged } = setup({ apiKeyFile: { path: 'creds.json', field: 'cockpit.key' } }, JSON.stringify({ cockpit: { key: KEY }, other: 'x' }));
    const env: NodeJS.ProcessEnv = {};
    applyConfigDefaults(env, loadMetabobCLIConfig(path));
    expect(env.METABOB_API_KEY).toBe(KEY);
    expect(logged()).not.toContain(KEY);
  });

  test('an absolute path works the same', () => {
    const { path, dir } = setup({}, JSON.stringify({ key: KEY }));
    writeFileSync(path, JSON.stringify({ metabob: { endpoint: ENDPOINT, apiKeyFile: { path: join(dir, 'creds.json'), field: 'key' } } }));
    expect(loadMetabobCLIConfig(path)?.apiKey).toBe(KEY);
  });

  test('a missing file gives no key, and the line names neither the path nor anything read', () => {
    const { path, logged } = setup({ apiKeyFile: { path: 'secret-dir/nope.json', field: 'key' } });
    expect(loadMetabobCLIConfig(path)?.apiKey).toBeUndefined();
    expect(logged()).toContain('metabob.apiKeyFile');
    expect(logged()).toContain('the file it names does not exist');
    expect(logged()).not.toContain('secret-dir');
  });

  test('a file that is not JSON gives no key, and none of its text is logged', () => {
    const { path, logged } = setup({ apiKeyFile: { path: 'creds.json', field: 'key' } }, `key=${KEY}`);
    expect(loadMetabobCLIConfig(path)?.apiKey).toBeUndefined();
    expect(logged()).toContain('exists but is not readable JSON');
    expect(logged()).not.toContain(KEY);
  });

  test('a field that holds no string gives no key, and the value beside it is not logged', () => {
    const { path, logged } = setup({ apiKeyFile: { path: 'creds.json', field: 'cockpit.key' } }, JSON.stringify({ cockpit: { token: KEY } }));
    expect(loadMetabobCLIConfig(path)?.apiKey).toBeUndefined();
    expect(logged()).toContain('holds no string at "cockpit.key"');
    expect(logged()).not.toContain(KEY);
  });

  test('with metabob.apiKey set too, apiKey is used, the file is not read, and the line says to remove apiKey', () => {
    const { path, logged } = setup({ apiKey: 'mbk_inline_key', apiKeyFile: { path: 'creds.json', field: 'key' } }, JSON.stringify({ key: KEY }));
    expect(loadMetabobCLIConfig(path)?.apiKey).toBe('mbk_inline_key');
    expect(logged()).toContain('remove it to use the file');
    expect(logged()).not.toContain('mbk_inline_key');
  });

  test('METABOB_API_KEY in the environment still wins over the file', () => {
    const { path } = setup({ apiKeyFile: { path: 'creds.json', field: 'key' } }, JSON.stringify({ key: KEY }));
    const env: NodeJS.ProcessEnv = { METABOB_API_KEY: 'mbk_env_key' };
    applyConfigDefaults(env, loadMetabobCLIConfig(path));
    expect(env.METABOB_API_KEY).toBe('mbk_env_key');
  });
});
