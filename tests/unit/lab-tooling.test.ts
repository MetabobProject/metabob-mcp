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

  test('no shell function shadows a command the script runs', () => {
    const functions = [...script.matchAll(/^([a-z_][a-z0-9_]*)\(\)\s*\{/gm)].map((m) => m[1]!);
    for (const binary of ['node', 'bun', 'podman', 'docker', 'sed', 'cat', 'find', 'mktemp', 'tail', 'grep']) {
      expect(functions).not.toContain(binary);
    }
  });

  test('destroy removes the lab network and both compose default networks', () => {
    const destroy = /^cmd_destroy\(\) \{([\s\S]*?)^\}/m.exec(script)?.[1] ?? '';
    for (const net of ['"$NET"', 'spoke_default', 'hub_default']) expect(destroy).toContain(net);
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
    for (const entry of ['keys/', 'manifest.yml', 'lab.log', 'results/']) expect(lines).toContain(entry);
  });
});

describe('lab.sh cleanup', () => {
  // An EXIT trap runs after the function that set it returns, so a variable it
  // names must not be function-local: under `set -u` the trap would fail, and
  // the temp dir holding the MCP config (with a key) would be left behind.
  test('no EXIT trap names a function-local variable', () => {
    const script = read('lab.sh');
    const locals = new Set([...script.matchAll(/^\s*local\s+([^;\n]+)/gm)]
      .flatMap(m => m[1]!.split(/\s+/).map(v => v.split('=')[0]!)));
    const trapped = [...script.matchAll(/trap\s+'([^']*)'\s+EXIT/g)]
      .flatMap(m => [...m[1]!.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map(v => v[1]!));
    expect(trapped.length).toBeGreaterThan(0);
    expect(trapped.filter(v => locals.has(v))).toEqual([]);
  });
});

describe('light lab', () => {
  // The lab runs only what metabob-mcp touches; the selection lives in the env files.
  const disabled = (name: string) =>
    new Set((/^DISABLED_VESSELS=(.*)$/m.exec(read(name))?.[1] ?? '').split(',').map(s => s.trim()).filter(Boolean));

  test('the hub runs hub-minimal with a DISABLED_VESSELS selection', () => {
    expect(read('hub.env')).toMatch(/^PROFILE=hub-minimal$/m);
    expect(disabled('hub.env').size).toBeGreaterThan(20);
  });

  test('the spoke carries a DISABLED_VESSELS selection', () => {
    expect(disabled('spoke.env').size).toBeGreaterThan(20);
  });

  test('nothing the MCP or `lab.sh check` needs is masked', () => {
    const needs: Record<string, string[]> = {
      'hub.env': ['identity', 'discovery', 'concept-db', 'activity-api', 'surrealdb', 'valkey', 'bootstrap-seeder', 'substrate-ready'],
      'spoke.env': ['discovery', 'goal-host', 'local-tools', 'bootstrap-seeder', 'substrate-ready'],
    };
    for (const [file, units] of Object.entries(needs)) {
      const masked = [...disabled(file)];
      for (const unit of units) {
        expect(masked.filter(m => m.replace(/\.(service|timer)$/, '').replace(/-vessel$/, '') === unit.replace(/-vessel$/, ''))).toEqual([]);
      }
    }
  });

  test('up waits for served, not usable (usable needs a real LLM completion)', () => {
    expect(read('lab.sh')).not.toMatch(/wait_level\s+\w+\s+usable/);
  });
});

describe('lab.sh boot readiness', () => {
  // `served` does not wait for the workspace local-tools spawns its shell in; a check goal
  // dispatched before it exists fails with ENOENT (posix_spawn 'bash').
  test('up waits for the spoke workspace after served, before the keys and check', () => {
    const script = read('lab.sh');
    const served = script.indexOf('wait_level spoke served');
    const workspace = script.indexOf('ensure_workspace spoke');
    expect(served).toBeGreaterThan(-1);
    expect(workspace).toBeGreaterThan(served);
    expect(script).toMatch(/^ensure_workspace\(\) \{/m);
    expect(script).toContain('mkdir -p "$d"');
  });
});

describe('lab.sh image currency', () => {
  // A local copy of a mutable tag can be any age: the lab once ran a week-old :dev
  // whose goal-host predated a fix, while the published tag carried it.
  test('a tag is pulled on every up unless LAB_PULL=0; a digest only when missing', () => {
    const script = read('lab.sh');
    expect(script).toContain('${LAB_PULL:-1}');
    expect(script).toContain('${IMAGE#*@sha256:}');
    expect(script).not.toContain('${LAB_PULL:-0}');
  });

  test('up reads the revision label where docker keeps it as well as where podman does', () => {
    const fn = read('lab.sh').slice(read('lab.sh').indexOf('image_revision() {'));
    expect(fn.slice(0, 600)).toContain('index .Config.Labels "org.opencontainers.image.revision"');
    expect(fn.slice(0, 600)).toContain('index .Labels "org.opencontainers.image.revision"');
  });

  test('up and check state the image revision they ran', () => {
    const script = read('lab.sh');
    expect(script).toMatch(/log "image: \$IMAGE revision/);
    expect(script).toContain('running image revision: hub');
  });
});

describe('lab.sh check verdicts', () => {
  // A release gate keys on `lab.sh check`'s exit code; a throttled goal check proved attach only.
  test('a throttled goal check exits 3, never 0', () => {
    const script = read('lab.sh');
    const throttled = script.slice(script.indexOf('goal check THROTTLED'));
    expect(throttled.slice(0, 300)).toMatch(/\n\s*exit 3\n/);
    expect(throttled.slice(0, 300)).not.toMatch(/\n\s*return 0\n/);
  });
});

describe('lab.sh capacity', () => {
  // A lab on a shared host must never take memory from the fleet there: with no swap, the OOM killer's
  // likeliest victim is the largest process, the host's live substrate.
  test('every node is capped from creation, boot included', () => {
    const net = read('lab-net.yml');
    expect(net).toContain('cpus: ${LAB_CPUS:-2}');
    expect(net).toContain('mem_limit: ${LAB_MEM:-6g}');
    expect(net).toContain('memswap_limit: ${LAB_MEM:-6g}');
  });

  test('`capacity` runs the same check as a dry run and starts nothing', () => {
    const script = read('lab.sh');
    const branch = script.slice(script.indexOf('  capacity)'), script.indexOf(';;', script.indexOf('  capacity)')));
    expect(branch).toContain('LAB_DRY_RUN=1 LAB_FORCE=0 capacity_check');
    expect(branch).not.toMatch(/cmd_up|compose_node|issue_key/);
  });

  test('up checks capacity before it starts anything', () => {
    const script = read('lab.sh');
    const up = script.slice(script.indexOf('cmd_up() {'));
    expect(up.indexOf('capacity_check')).toBeGreaterThan(-1);
    expect(up.indexOf('capacity_check')).toBeLessThan(up.indexOf('compose_node hub up'));
  });

  const { mkdtempSync, writeFileSync, chmodSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  /** capacity_check with fake /proc files and, as cotenants() lines, the host's other containers. */
  function capacity(availKb: number, swapKb: number, loads: string, cotenants: string[] = [], extra: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'labcap-'));
    writeFileSync(join(dir, 'meminfo'), `MemAvailable:   ${availKb} kB\nSwapTotal:      ${swapKb} kB\n`);
    writeFileSync(join(dir, 'loadavg'), `${loads} 1.00 1/100 1\n`);
    const harness = [
      'info(){ echo "INFO $*"; }; log(){ echo "LOG $*"; }; fail(){ echo "FAIL $*"; exit 1; }; running(){ return 1; }',
      // eval of awk's range output, not `source <(sed …)`: macOS's bash 3.2 sources nothing from a process substitution,
      // and BSD sed rejects ranges joined by `;`.
      `eval "$(awk '/^mem_mb\\(\\) \\{/,/^}/; /^capacity_check\\(\\) \\{/,/^}/' ${JSON.stringify(join(LAB, 'lab.sh'))})"`,
      `cotenants(){ printf '%s\\n' ${cotenants.map((l) => JSON.stringify(l)).join(' ')}; }`,
      'capacity_check',
    ].join('\n');
    return spawnSync('bash', ['-c', harness], {
      encoding: 'utf-8',
      env: { PATH: process.env.PATH ?? '', LAB_MEMINFO: join(dir, 'meminfo'), LAB_LOADAVG: join(dir, 'loadavg'), ...extra },
    });
  }

  test.skipIf(process.platform === 'win32')('refuses the hub host as measured: an unbounded live substrate and a capped regate leave no room', () => {
    // syzygy, 00:32Z: 9 GB available, no swap; substrate-live has no limit, the regate is capped at 8 GB.
    const r = capacity(9 * 1024 * 1024, 0, '3.98 3.80', ['substrate-live 0 18289', 'regate-x 8192 491'], { LAB_MEM: '3g' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('2 node(s) at 3g plus 16845 MB headroom need 22989 MB, and 9216 MB is available with no swap');
    // The unbounded reserve is one total, scaled to half the largest unbounded co-tenant (18289 MB → 9144 MB).
    expect(r.stdout).toContain('the headroom reserves 9144 MB in total for the co-tenant(s) with no memory limit: substrate-live');
  });

  test.skipIf(process.platform === 'win32')('passes with room, refuses at the load limit over 1 or 5 minutes, and LAB_FORCE overrides', () => {
    expect(capacity(28 * 1024 * 1024, 64 * 1024 * 1024, '7.9 6.8').status).toBe(0);
    const spike = capacity(28 * 1024 * 1024, 64 * 1024 * 1024, '9.1 11.2');
    expect(spike.status).toBe(1);
    expect(spike.stdout).toContain('load is 9.1 / 11.2 over 1 and 5 minutes (the limit is 10)');
    expect(capacity(9 * 1024 * 1024, 0, '3.98 3.80', ['substrate-live 0 18289'], { LAB_FORCE: '1' }).stdout).toContain('capacity check overridden (LAB_FORCE=1)');
  });

  test.skipIf(process.platform === 'win32')('refuses a host already swapping heavily, however much memory reads as available', () => {
    const dir = mkdtempSync(join(tmpdir(), 'labswap-'));
    writeFileSync(join(dir, 'meminfo'), 'MemAvailable:   28000000 kB\nSwapTotal:      67108860 kB\nSwapFree:       30000000 kB\n');
    writeFileSync(join(dir, 'loadavg'), '4.8 6.1 1.00 1/100 1\n');
    const harness = [
      'info(){ echo "INFO $*"; }; log(){ echo "LOG $*"; }; fail(){ echo "FAIL $*"; exit 1; }; running(){ return 1; }; cotenants(){ :; }',
      // eval of awk's range output, not `source <(sed …)`: macOS's bash 3.2 sources nothing from a process substitution,
      // and BSD sed rejects ranges joined by `;`.
      `eval "$(awk '/^mem_mb\\(\\) \\{/,/^}/; /^capacity_check\\(\\) \\{/,/^}/' ${JSON.stringify(join(LAB, 'lab.sh'))})"`,
      'capacity_check',
    ].join('\n');
    const r = spawnSync('bash', ['-c', harness], { encoding: 'utf-8', env: { PATH: process.env.PATH ?? '', LAB_MEMINFO: join(dir, 'meminfo'), LAB_LOADAVG: join(dir, 'loadavg') } });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('55% of swap is in use (the limit is 50%)');
  });

  test.skipIf(process.platform === 'win32')('cotenants() reads the engine: limits from inspect, usage from stats, the lab\'s own nodes left out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'labeng-'));
    const eng = join(dir, 'fake-engine');
    writeFileSync(eng, [
      '#!/usr/bin/env bash',
      'case "$1" in',
      '  stats) printf "substrate-live\\t17.86GiB / 31.34GiB\\nregate-x\\t490.8MiB / 8GiB\\nlab-hub-live\\t1GiB / 6GiB\\n" ;;',
      '  inspect) case "${@: -1}" in substrate-live) echo 0 ;; regate-x) echo 8589934592 ;; *) echo 6442450944 ;; esac ;;',
      'esac',
    ].join('\n'));
    chmodSync(eng, 0o755);
    const harness = [
      `ENG=${JSON.stringify(eng)}`,
      'c(){ echo "lab-$1-live"; }',
      `eval "$(awk '/^to_mb\\(\\) \\{/,/^}/; /^cotenants\\(\\) \\{/,/^}/' ${JSON.stringify(join(LAB, 'lab.sh'))})"`,
      'cotenants',
    ].join('\n');
    const r = spawnSync('bash', ['-c', harness], { encoding: 'utf-8' });
    expect(r.stdout.trim().split('\n')).toEqual(['substrate-live 0 18289', 'regate-x 8192 491']);
  });
});

describe('the agent cell (lab/cell.sh, lab/cell/)', () => {
  const cell = read('cell.sh');
  const entry = read('cell/entrypoint.sh');
  const image = read('cell/Containerfile');
  const code = (text: string) => text.split('\n').filter((l) => !l.trimStart().startsWith('#'));

  test.skipIf(process.platform === 'win32')('the scripts parse (bash -n)', () => {
    for (const f of ['cell.sh', 'cell/entrypoint.sh', 'cell/smoke.sh']) {
      const r = spawnSync('bash', ['-n', join(LAB, f)], { encoding: 'utf-8' });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    }
  });

  test('the cell has one identity: task pull and the harness\'s MCP server both get the same VESSEL_ID', () => {
    const lines = code(entry);
    const set = lines.findIndex((l) => /^VESSEL_ID="\$\{CELL_VESSEL_ID:-metabob-cell-\$\(hostname\)\}"; export VESSEL_ID$/.test(l));
    const pull = lines.findIndex((l) => /task pull --origin/.test(l));
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(pull);
    expect(entry).toMatch(/"VESSEL_ID": "\$VESSEL_ID"/);
  });

  test('documents and handles every subcommand', () => {
    const usage = cell.split('\n').filter((l) => l.startsWith('#')).join('\n');
    const dispatch = cell.slice(cell.lastIndexOf('case "${1:-}" in'));
    for (const cmd of ['build', 'run', 'clean']) {
      expect(usage).toMatch(new RegExp(`\\./cell\\.sh ${cmd}\\b`));
      expect(dispatch).toMatch(new RegExp(`^\\s+${cmd}\\)`, 'm'));
    }
  });

  test('a cell mounts nothing, is labelled and capped, and one runs at a time', () => {
    const create = /"\$ENG" create ([\s\S]*?)>\/dev\/null/.exec(cell)?.[1] ?? '';
    expect(create).toContain('--label "pilot-cell=$LABEL"');
    expect(create).toMatch(/--cpus /);
    expect(create).toMatch(/--memory /);
    expect(create).not.toMatch(/(^|\s)(-v|--volume|--mount)\b/);
    expect(cell).toMatch(/\[ -z "\$\(existing\)" \] \|\| fail/);
  });

  test('the env file is written 0600 and removed once create has read it', () => {
    expect(cell).toMatch(/\( umask 077\n/);
    expect(cell).toMatch(/--env-file "\$tmp\/cell\.env" "\$IMAGE:latest" >\/dev\/null\n\s+rm -f "\$tmp\/cell\.env"/);
  });

  test('no key is printed: the provider key is read only into a command substitution', () => {
    for (const line of code(cell)) {
      if (line.includes('anthropic_key') && !/^\s*anthropic_key\(\)/.test(line)) expect(line).toMatch(/\$\(anthropic_key\)/);
      expect(line).not.toMatch(/(log|echo)[^|>]*\$(k|ANTHROPIC_API_KEY|METABOB_API_KEY)\b/);
    }
  });

  test('the cell cannot push, keeps the MCP key out of the harness, and redacts keys from the bundle', () => {
    expect(entry).toContain('remote set-url --push origin no-push://');
    expect(entry).toContain("git config --global credential.helper ''");
    expect(entry).toContain('export -n METABOB_API_KEY');
    expect(entry).toMatch(/for v in "\$\{METABOB_API_KEY:-\}" "\$\{ANTHROPIC_API_KEY:-\}"/);
  });

  test('the image is built from committed source and runs as a non-root user', () => {
    expect(cell).toContain('git -C "$REPO_ROOT" archive "$sha"');
    expect(image).toMatch(/^USER cell$/m);
    expect(image).not.toMatch(/^COPY \.mcp\.json/m);
  });
});
