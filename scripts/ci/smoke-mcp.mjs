#!/usr/bin/env node
// Drives one MCP server over stdio for the package smoke (.github/workflows/package-smoke.yml, SPEC §runtime), as a client would:
// initialize, tools/list, then the checks named below. Exit 0 when every check holds; each failure is one line.
//
//   node scripts/ci/smoke-mcp.mjs [--cwd <dir>] [--env K=V ...] [--expect <check> ...] -- <command> [args...]
//
// Checks (--expect):
//   local-tools    init_workspace on a small temporary project, then search_codebase finds its symbol (the native
//                  parser loads on this platform) and predict_cochanges answers from its git history
//   undetermined   get_problems answers workspace_undetermined (started in the plugin's own folder)
//   runtime=<name> the server's start line names that runtime (node or bun)
// Always: the initialize answer carries this checkout's version, tools/list lists the tools, and stdout carries only
// JSON-RPC lines.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0 || sep === argv.length - 1) { console.error('usage: smoke-mcp.mjs [options] -- <command> [args...]'); process.exit(2); }
const opts = argv.slice(0, sep);
const [command, ...args] = argv.slice(sep + 1);
let cwd = process.cwd();
const env = { ...process.env };
const expects = [];
for (let i = 0; i < opts.length; i++) {
  if (opts[i] === '--cwd') cwd = opts[++i];
  else if (opts[i] === '--env') { const [k, ...v] = opts[++i].split('='); env[k] = v.join('='); }
  else if (opts[i] === '--expect') expects.push(opts[++i]);
}
const version = JSON.parse(readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'package.json'), 'utf8')).version;

const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failures.push(name); };

// Windows resolves npx and npm's .cmd shims only through a shell.
const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
let stdout = '', stderr = '';
child.stderr.on('data', (d) => { stderr += d; });
const pending = new Map();
let buffered = '';
child.stdout.on('data', (d) => {
  stdout += d;
  buffered += d;
  let nl;
  while ((nl = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, nl).trim();
    buffered = buffered.slice(nl + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); pending.get(m.id)?.(m); } catch { /* reported by the stdout check */ }
  }
});
let exited = null;
child.on('exit', (code) => { exited = code; for (const resolve of pending.values()) resolve({ error: { message: `server exited ${code}` } }); });

let nextId = 0;
function rpc(method, params, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const id = ++nextId;
    const timer = setTimeout(() => resolve({ error: { message: `${method} timed out after ${timeoutMs} ms` } }), timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); pending.delete(id); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const text = (m) => m.result?.content?.[0]?.text ?? `error: ${m.error?.message ?? JSON.stringify(m)}`;
const call = async (name, a, timeoutMs) => text(await rpc('tools/call', { name, arguments: a }, timeoutMs));

const started = Date.now();
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'package-smoke', version: '1' } });
check('initialize', init.result?.serverInfo?.version === version, `${init.result?.serverInfo?.name ?? init.error?.message} ${init.result?.serverInfo?.version ?? ''} after ${((Date.now() - started) / 1000).toFixed(1)} s`);
if (init.result) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = (await rpc('tools/list', {})).result?.tools?.map((t) => t.name) ?? [];
  check('tools/list', tools.length > 20 && tools.includes('predict_cochanges') && tools.includes('record_finding'), `${tools.length} tools`);

  for (const e of expects) {
    if (e === 'local-tools') {
      const project = mkdtempSync(join(tmpdir(), 'smoke-project-'));
      writeFileSync(join(project, 'core.ts'), 'export function smokeCoreThing() { return 1; }\n');
      writeFileSync(join(project, 'user.ts'), "import { smokeCoreThing } from './core';\nexport const used = smokeCoreThing();\n");
      const git = (...a) => execFileSync('git', ['-C', project, '-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'commit.gpgsign=false', ...a], { stdio: 'ignore' });
      git('init', '-q'); git('add', '.'); git('commit', '-qm', 'one');
      const indexed = await call('init_workspace', { workspace_path: project });
      check('init_workspace', /^Workspace: /.test(indexed) && !/local_index_unavailable/.test(indexed), indexed.split('\n').slice(0, 2).join(' | '));
      const found = await call('search_codebase', { query: 'smokeCoreThing' });
      check('search_codebase', found.includes('smokeCoreThing') && found.includes('core.ts'), found.split('\n')[0]);
      const co = await call('predict_cochanges', { changed_files: ['core.ts'], confidence_threshold: 0 });
      check('predict_cochanges', /1\. user\.ts\n {3}Confidence: 100%/.test(co), co.split('\n').slice(0, 4).join(' | '));
    } else if (e === 'undetermined') {
      const p = await call('get_problems', {});
      check('workspace_undetermined', p.startsWith('workspace_undetermined:'), p.slice(0, 120));
    } else if (e.startsWith('runtime=')) {
      const want = e.slice('runtime='.length);
      check(`runtime ${want}`, new RegExp(`"runtime":"${want} `).test(stderr), (/"runtime":"[^"]*"/.exec(stderr) ?? ['none'])[0]);
    } else {
      check(`unknown check ${e}`, false);
    }
  }
}

const strays = stdout.split('\n').map((l) => l.trim()).filter((l) => l && (() => { try { JSON.parse(l); return false; } catch { return true; } })());
check('stdout carries only JSON-RPC', strays.length === 0, strays[0]?.slice(0, 120) ?? '');
if (failures.length) console.log(`--- server stderr (tail) ---\n${stderr.slice(-3000)}`);
child.stdin.end();
setTimeout(() => { if (exited === null) child.kill(); process.exit(failures.length ? 1 : 0); }, 3000).unref();
if (exited === null) await new Promise((r) => child.on('exit', r));
process.exit(failures.length ? 1 : 0);
