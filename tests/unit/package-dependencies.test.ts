/**
 * The package installs only what the server loads at runtime (SPEC §runtime): the build bundles every other
 * dependency into dist/, so `dependencies` is exactly the build's `--external` list, and nothing else ships to a
 * user's `npx`. A new external with no dependency, or an import the build leaves bare, would ship broken.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const build: string = pkg.scripts.build;
const externals = [...build.matchAll(/--external\s+(\S+)/g)].map((m) => m[1]!).sort();
const out = mkdtempSync(join(tmpdir(), 'mcp-deps-build-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** The package name of a bare specifier (`@scope/name/sub` → `@scope/name`, `name/sub` → `name`). */
const packageOf = (spec: string) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
const builtin = (spec: string) => spec.startsWith('node:') || builtinModules.includes(packageOf(spec));

describe('the package dependencies', () => {
  test('dependencies are exactly the packages the build keeps external', () => {
    expect(externals.length).toBeGreaterThan(0);
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(externals);
  });

  test('the built bundle loads no package beyond them', () => {
    // The build script's own `bun build …` command, with only its output directory moved, so the test bundles what
    // ships whatever the build's entries, target or flags.
    const command = /\bbun build ([^&]+)/.exec(build)?.[1]?.trim().split(/\s+/) ?? [];
    const outdir = command.indexOf('--outdir');
    expect(outdir).toBeGreaterThan(-1);
    command[outdir + 1] = out;
    const r = spawnSync('bun', ['build', ...command], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const specs = new Set<string>();
    for (const f of readdirSync(out).filter((f) => f.endsWith('.js'))) {
      const text = readFileSync(join(out, f), 'utf8');
      // Real loads only: a `require("…")` inside a string or template is code another tool generates (ajv's
      // standalone output), never run here.
      const name = String.raw`((?:@[\w-][\w.-]*\/)?[\w-][\w.-]*(?:\/[\w.@-]+)*)`;
      const load = new RegExp(String.raw`(?<![\x60'"\w.])(?:require|import)\(\s*"${name}"\s*\)|^\s*(?:import|export)\b[^;"]*?\bfrom\s*"${name}"|^\s*import\s*"${name}"`, 'gm');
      for (const m of text.matchAll(load)) specs.add(m[1] ?? m[2] ?? m[3]!);
    }
    const loaded = [...specs].filter((s) => !builtin(s)).map(packageOf);
    expect([...new Set(loaded)].sort()).toEqual(externals);
  }, 60_000);
});
