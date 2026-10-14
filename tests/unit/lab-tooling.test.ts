/**
 * The two-node lab's tooling (lab/README.md) still exists and is well formed. CI cannot run the lab
 * itself (no rootless podman fleet, and the image pull is slow), so this holds the pieces it is built
 * from to their contract: the script parses and handles every subcommand it documents, the network
 * override and the node env files agree, the ignore file keeps keys out of git, and the script never
 * prints a key.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const LAB = resolve(import.meta.dir, '..', '..', 'lab');
const read = (name: string) => readFileSync(join(LAB, name), 'utf-8').replace(/\r\n/g, '\n');
const script = read('lab.sh');
const SUBCOMMANDS = ['up', 'down', 'destroy', 'status', 'keys', 'check', 'cycle'];

function envFile(name: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of read(name).split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) vars[m[1]!] = m[2]!;
  }
  return vars;
}

describe('lab/lab.sh', () => {
  // Ubuntu covers the parse; on Windows `bash` may be the WSL launcher.
  test.skipIf(process.platform === 'win32')('parses (bash -n)', () => {
    const r = spawnSync('bash', ['-n', join(LAB, 'lab.sh')], { encoding: 'utf-8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  test('documents and handles every subcommand', () => {
    const usage = script.split('\n').filter((l) => l.startsWith('#')).join('\n');
    const dispatch = script.slice(script.lastIndexOf('case "${1:-}" in'));
    for (const cmd of SUBCOMMANDS) {
      expect(usage).toMatch(new RegExp(`\\./lab\\.sh ${cmd}\\b`));
      expect(dispatch).toMatch(new RegExp(`^\\s+${cmd}\\)`, 'm'));
    }
    expect(dispatch).toMatch(/^\s+\*\) sed -n '2,\d+p' "\$0"; exit 2 ;;/m);
  });

  test('cycle is destroy, then up, then check', () => {
    const cycle = /^\s+cycle\)([\s\S]*?);;/m.exec(script)?.[1] ?? '';
    expect(cycle).toMatch(/cmd_destroy;\s*cmd_up;\s*cmd_check/);
  });

  test('timeouts and the log are configurable from the environment', () => {
    for (const v of ['LAB_WAIT_S', 'LAB_CHECK_TIMEOUT_S', 'LAB_LOG', 'LAB_KEYS_DIR']) expect(script).toContain(`\${${v}:-`);
    expect(script).toMatch(/-q\|--quiet\)/);
  });

  test('falls back to the installer\'s stored provider key', () => {
    expect(script).toContain('${SUBSTRATE_CONFIG_PATH:-$HOME/.substrate/config.json}');
    expect(script).toContain('providers');
  });

  test('never prints a key', () => {
    // A key file is read only inside a command substitution (into a variable or the environment),
    // never with its contents sent to the terminal.
    const code = script.split('\n').filter((l) => !l.trimStart().startsWith('#'));
    for (const line of code) {
      for (const m of line.matchAll(/cat\s+"?\$?\{?(KEYS|keys)\b[^|;)]*/g)) {
        const before = line.slice(0, m.index);
        expect(`${before}`).toMatch(/\$\(\s*$/);
      }
      expect(line).not.toMatch(/echo[^|>]*\$(pkey|apiKey)\b/);
    }
    // The provider key is exported into the environment and its name, not its value, is logged.
    expect(script).toMatch(/export "\$name=\$pkey"/);
    expect(script).not.toMatch(/(info|log) "[^"]*\$pkey/);
  });
});

describe('lab/lab-net.yml', () => {
  const doc = Bun.YAML.parse(read('lab-net.yml')) as any;

  test('declares the external metabob-lab network', () => {
    expect(doc.networks['metabob-lab']).toEqual({ external: true });
    expect(script).toContain('NET=metabob-lab');
  });

  test('gives the node a fixed address from LAB_IP', () => {
    const net = doc.services.substrate.networks['metabob-lab'];
    expect(net.ipv4_address).toMatch(/^\$\{LAB_IP[:}]/);
  });
});

describe('lab/hub.env and lab/spoke.env', () => {
  const hub = envFile('hub.env');
  const spoke = envFile('spoke.env');

  test('declare what lab.sh and lab-net.yml need', () => {
    for (const env of [hub, spoke]) {
      for (const v of ['SUBSTRATE_NAME', 'SUBSTRATE_PORT_PREFIX', 'SUBSTRATE_PUBLISH_IP', 'LAB_IP']) expect(env[v]).toBeTruthy();
    }
    expect(spoke.DISCOVERY_ENDPOINT).toBe(`http://${hub.LAB_IP}:8100`);
  });

  test('distinct names and port prefixes, matching the host view', () => {
    expect(hub.SUBSTRATE_NAME).not.toBe(spoke.SUBSTRATE_NAME);
    expect(hub.SUBSTRATE_PORT_PREFIX).not.toBe(spoke.SUBSTRATE_PORT_PREFIX);
    expect(script).toContain(`http://127.0.0.1:${spoke.SUBSTRATE_PORT_PREFIX}100`);
    expect(script).toContain(`http://127.0.0.1:${hub.SUBSTRATE_PORT_PREFIX}101`);
  });

  test('LAB_IPs are distinct and on the lab subnet', () => {
    const subnet = /SUBNET=(\d+\.\d+\.\d+)\.0\/24/.exec(script)?.[1];
    expect(subnet).toBeTruthy();
    expect(hub.LAB_IP).not.toBe(spoke.LAB_IP);
    for (const ip of [hub.LAB_IP, spoke.LAB_IP]) expect(ip!.startsWith(`${subnet}.`)).toBe(true);
  });
});

describe('lab/.gitignore', () => {
  test('keeps keys, the generated manifest and the log out of git', () => {
    const lines = read('.gitignore').split('\n').map((l) => l.trim());
    for (const entry of ['keys/', 'manifest.yml', 'lab.log']) expect(lines).toContain(entry);
  });
});
