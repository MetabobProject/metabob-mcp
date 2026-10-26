/**
 * The plugin bundles (README §agent-plugins): generated from one source, so they cannot drift; the Claude Code plugin
 * lives in plugin/ with no package.json (no dependency install), pins its server to this exact version, carries
 * nothing machine-specific, and leaves every setting blank by default; an unfilled setting is never used as a value.
 * The Agent Plugins 1.0 bundle at the root validates against the published schemas (copies in tests/fixtures/, so
 * the check needs no network) and carries the same server, version and skill; the Codex marketplace lists the root.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { dropUnsubstitutedPlaceholders } from '../../src/config';

const ROOT = resolve(import.meta.dir, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((f) => {
    const p = join(dir, f);
    return statSync(join(ROOT, p)).isDirectory() ? files(p) : [p];
  });
}

describe('the plugin bundles', () => {
  test('every generated file is what the generator writes from its source', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/build-plugins.mjs'), '--check'], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  test('the Claude Code plugin pins its server to this exact version, and the marketplace lists it from plugin/', () => {
    const mcp = JSON.parse(read('plugin/.mcp.json'));
    expect(mcp.mcpServers.metabob.args).toEqual(['-y', `--package=metabob-mcp-server@npm:@metabob/mcp@${pkg.version}`, 'metabob-mcp']);
    expect(Object.keys(pkg.bin)).toContain('metabob-mcp');
    expect(JSON.parse(read('plugin/.claude-plugin/plugin.json')).version).toBe(pkg.version);
    const market = JSON.parse(read('.claude-plugin/marketplace.json'));
    expect(market.plugins).toEqual([expect.objectContaining({ name: 'metabob', source: './plugin', version: pkg.version })]);
  });

  test('plugin/ holds no package.json, so Claude Code runs no dependency install for it', () => {
    expect(existsSync(join(ROOT, 'plugin', 'package.json'))).toBe(false);
    expect(existsSync(join(ROOT, '.claude-plugin', 'plugin.json'))).toBe(false);
  });

  test('nothing machine-specific ships: no absolute path, no HEALTH_PORT, no ssh URL', () => {
    for (const f of [...files('plugin'), '.claude-plugin/marketplace.json', 'plugin.json', 'mcp.json', '.agents/plugins/marketplace.json']) {
      const text = read(f);
      expect({ f, home: /\/(home|Users)\/[\w.-]+\//.test(text) }).toEqual({ f, home: false });
      expect({ f, port: /HEALTH_PORT/.test(text) }).toEqual({ f, port: false });
      expect({ f, ssh: /git@github\.com:|ssh:\/\//.test(text) }).toEqual({ f, ssh: false });
    }
  });

  test('every setting is blank by default and maps to the variable the server reads; the key is sensitive', () => {
    const manifest = JSON.parse(read('plugin/.claude-plugin/plugin.json'));
    const env = JSON.parse(read('plugin/.mcp.json')).mcpServers.metabob.env;
    expect(Object.keys(manifest.userConfig).sort()).toEqual(['api_key', 'discovery_endpoint', 'endpoint']);
    for (const [key, field] of Object.entries<any>(manifest.userConfig)) {
      expect(field.default).toBe('');
      expect(Object.values(env)).toContain(`\${user_config.${key}}`);
    }
    expect(manifest.userConfig.api_key.sensitive).toBe(true);
    expect(env).toEqual({ METABOB_API_KEY: '${user_config.api_key}', DISCOVERY_ENDPOINT: '${user_config.discovery_endpoint}', METABOB_ENDPOINT: '${user_config.endpoint}' });
  });

  test('a setting the host left unfilled is dropped, never used as a key or an endpoint', () => {
    const env: NodeJS.ProcessEnv = { METABOB_API_KEY: '${user_config.api_key}', DISCOVERY_ENDPOINT: ' ${user_config.discovery_endpoint} ', METABOB_ENDPOINT: 'http://127.0.0.1:18080', OTHER: '${x}' };
    expect(dropUnsubstitutedPlaceholders(env)).toEqual(['METABOB_API_KEY', 'DISCOVERY_ENDPOINT']);
    expect(env).toEqual({ METABOB_ENDPOINT: 'http://127.0.0.1:18080', OTHER: '${x}' });
  });

  test('the shipped skill and edit check are the repository\'s own', () => {
    // Both skills ship: `metabob` for the default tool set, `metabob-substrate` for METABOB_TOOLS=all.
    const skills = JSON.parse(read('scripts/plugins/source.json')).skills as string[];
    expect(skills).toEqual(['metabob', 'metabob-substrate']);
    for (const name of skills) {
      expect(read(`plugin/skills/${name}/SKILL.md`)).toBe(read(`skills/${name}/SKILL.md`));
      // Line endings aside: a Windows checkout may hold the skill with CRLF.
      expect(read(`skills/${name}/SKILL.md`).replace(/\r\n/g, '\n')).toStartWith(`---\nname: ${name}\n`);
    }
    expect(read('plugin/scripts/edit-check.mjs')).toBe(read('scripts/claude-plugin/edit-check.mjs'));
    expect(relative(ROOT, join(ROOT, 'plugin'))).toBe('plugin');
  });

  test('the Agent Plugins bundle validates against the published 1.0 schemas', () => {
    const ajv = new Ajv2020({ strict: false });
    for (const [file, schema] of [['plugin.json', 'plugin'], ['mcp.json', 'mcp']] as const) {
      const validate = ajv.compile(JSON.parse(read(`tests/fixtures/agent-plugins/1.0.0/${schema}.schema.json`)));
      const doc = JSON.parse(read(file));
      expect({ file, valid: validate(doc), errors: validate.errors ?? null }).toEqual({ file, valid: true, errors: null });
      expect(doc.$schema).toBe(`https://agent-plugins.org/schemas/1.0.0/${schema}.schema.json`);
    }
  });

  test('the two bundles carry the same name, version, description, server and skill; the root one no environment', () => {
    const claude = JSON.parse(read('plugin/.claude-plugin/plugin.json'));
    const portable = JSON.parse(read('plugin.json'));
    for (const k of ['name', 'version', 'description']) expect(portable[k]).toBe(claude[k]);
    expect(portable.version).toBe(pkg.version);
    const claudeServer = JSON.parse(read('plugin/.mcp.json')).mcpServers.metabob;
    const portableServer = JSON.parse(read('mcp.json')).mcpServers.metabob;
    expect(portableServer).toEqual({ type: 'stdio', command: claudeServer.command, args: claudeServer.args });
    expect(portableServer.args).toEqual(['-y', `--package=metabob-mcp-server@npm:@metabob/mcp@${pkg.version}`, 'metabob-mcp']);
    expect(existsSync(join(ROOT, 'skills', 'metabob', 'SKILL.md'))).toBe(true);
  });

  test('the Codex marketplace lists the root bundle, by the path form Codex accepts', () => {
    const market = JSON.parse(read('.agents/plugins/marketplace.json'));
    expect(market.name).toBe('metabob');
    expect(market.plugins).toEqual([{ name: 'metabob', source: { source: 'local', path: './' }, category: expect.any(String) }]);
  });
});
