/**
 * Real Claude Code sessions against this build of the plugin.
 *
 * Each session is `claude -p` with a temporary copy of the plugin (`.claude-plugin/`, `skills/`) whose
 * `.mcp.json` starts THIS build (`node dist/cli.js`), never the published package. The MCP server gets
 * its own HOME (the sidecar store lives in `~/.metabob`), its own config file, and — for the proxy leg
 * — the proxy and trust variables. `claude` itself keeps the user's HOME: the login lives there.
 *
 * A session's stream-json output is parsed into a typed transcript: the init event (plugins, MCP
 * servers, tools, skills), every tool call in order with its input and result, skill loads, the final
 * text, cost and duration.
 *
 * Targets: the in-process fake substrate (../workflows/harness/fake-substrate.ts) or a live lab
 * (`LAB_DISCOVERY`, `LAB_KEY_FILE`, `LAB_IDENTITY`, defaulting to lab/lab.sh's lab: `labEnv`). Proxy leg: the corporate proxy fixture
 * (../workflows/networks/corp-proxy.ts) maps `.invalid` host names onto the target's 127.0.0.1 ports,
 * so the MCP reaches the substrate only through the proxy.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { FakeSubstrate } from '../workflows/harness/fake-substrate';
import { CorpProxy, tlsTerminator } from '../workflows/networks/corp-proxy';
import { makeCa, makeLeaf, type Issued } from '../workflows/networks/test-ca';

export const REPO_ROOT = resolve(import.meta.dir, '..', '..');
export const SERVER_PREFIX = 'mcp__plugin_metabob_metabob__';
export const SERVER_NAME = 'plugin:metabob:metabob';
/** The key the fake's identity accepts. */
export const FAKE_KEY = 'mb_test_workflow_key';
/** A key no namespace issued. */
export const FOREIGN_KEY = 'mb_foreign_namespace_key_claude_sessions';

// ── Temp dirs ────────────────────────────────────────────────────────────────

const ROOT_TMP = mkdtempSync(join(tmpdir(), 'mcp-cc-'));

export function tempDir(prefix: string): string {
  return mkdtempSync(join(ROOT_TMP, `${prefix}-`));
}

export function cleanupTemp(): void {
  try {
    rmSync(ROOT_TMP, { recursive: true, force: true });
  } catch {
    // a child may still hold a file; a leftover temp dir is harmless
  }
}

/** A git repository with the given files committed, named so the ledger's repo key is predictable. */
export function makeWorkspace(name: string, files: Record<string, string>): string {
  const root = join(tempDir('ws'), name);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '.');
  git('add', '.');
  git('-c', 'user.email=harness@example.invalid', '-c', 'user.name=harness', 'commit', '-qm', 'initial');
  return root;
}

// ── Targets ──────────────────────────────────────────────────────────────────

export type ProxyMode = 'none' | 'http' | 'connect' | 'basic' | 'mitm';
export type TargetKind = 'fake' | 'lab';

const PROXY_USER = 'corp-user';
const PROXY_PASSWORD = 'not-a-real-proxy-password'; // gitleaks:allow (a test fixture)

export interface Target {
  kind: TargetKind;
  proxyMode: ProxyMode;
  /** The fake, when the target is the fake. */
  fake: FakeSubstrate | null;
  proxy: CorpProxy | null;
  /** The anchor the MCP is configured with (a proxied `.invalid` name on the proxy leg). */
  anchor: string;
  /** Pinned identity endpoint, when the target needs one (the lab on the proxy leg). */
  identityEndpoint: string | null;
  key: string;
  /** Environment the MCP server needs on top of HOME and its config (proxy, trust). */
  netEnv: Record<string, string>;
  /** A one-line description for the report. */
  describe: string;
  notes: string[];
  stop(): Promise<void>;
}

function localPort(url: string): number {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`the proxy leg maps .invalid names onto local ports; ${url} is not on 127.0.0.1`);
  }
  return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
}

/**
 * Where the lab target lives. Defaults are lab/lab.sh's host view (lab/README.md): the spoke's discovery
 * as the anchor, the hub's identity, the hub-issued read-write key and both nodes for NET. Each one is
 * overridden by its LAB_* variable, for a lab elsewhere.
 */
export function labEnv(): { discovery: string; identity: string | null; keyFile: string; nodes: string } {
  const strip = (u: string) => u.replace(/\/+$/, '');
  const identity = process.env.LAB_IDENTITY ?? 'http://127.0.0.1:24101';
  return {
    discovery: strip(process.env.LAB_DISCOVERY ?? 'http://127.0.0.1:25100'),
    identity: identity ? strip(identity) : null,
    keyFile: process.env.LAB_KEY_FILE ?? join(process.env.LAB_KEYS_DIR ?? join(REPO_ROOT, 'lab', 'keys'), 'mcp-rw.key'),
    // Seen from the spoke, the hub's producers carry its lab-network address.
    nodes: process.env.LAB_NODES ?? '10.89.77.10',
  };
}

export async function startTarget(kind: TargetKind, proxyMode: ProxyMode): Promise<Target> {
  const stoppers: Array<() => unknown> = [];
  const notes: string[] = [];
  let fake: FakeSubstrate | null = null;
  let key: string;
  let discovery: string;
  let identity: string | null;

  if (kind === 'fake') {
    fake = await FakeSubstrate.start();
    stoppers.push(() => fake!.stop());
    key = FAKE_KEY;
    discovery = fake.url('discovery');
    identity = fake.url('identity');
  } else {
    const lab = labEnv();
    if (!existsSync(lab.keyFile)) throw new Error(`--target lab: no key at ${lab.keyFile} (bring the lab up with lab/lab.sh up, or set LAB_KEY_FILE)`);
    key = readFileSync(lab.keyFile, 'utf-8').trim();
    discovery = lab.discovery;
    identity = lab.identity;
  }

  if (proxyMode === 'none') {
    return {
      // A lab's /bootstrap advertises the hub's lab-network identity, which the host cannot dial: the lab's
      // identity is pinned on every leg. The fake advertises a loopback identity and needs no pin.
      kind, proxyMode, fake, proxy: null, anchor: discovery, identityEndpoint: kind === 'lab' ? identity : null, key, netEnv: {},
      describe: `${kind} at ${discovery}, direct`, notes,
      stop: async () => { for (const s of stoppers.reverse()) await s(); },
    };
  }

  // The proxy leg: the MCP knows the substrate only by .invalid names, which no resolver answers.
  const discPort = localPort(discovery);
  const idPort = identity ? localPort(identity) : null;
  if (kind === 'lab' && !identity) {
    notes.push('LAB_IDENTITY unset: the identity hop goes wherever the lab\'s /bootstrap points (direct when loopback)');
  }
  const netEnv: Record<string, string> = {};
  const hosts: Record<string, number> = {};
  let anchor: string;
  let identityUrl: string | null = null;
  let mitm: Issued | undefined;
  const tmp = tempDir('proxy');

  if (proxyMode === 'http') {
    // A plain-http anchor: absolute-form requests through HTTP_PROXY.
    anchor = 'http://spoke.invalid:18100';
    hosts['spoke.invalid:18100'] = discPort;
    if (idPort) {
      identityUrl = 'http://identity.invalid:18101';
      hosts['identity.invalid:18101'] = idPort;
    }
  } else {
    // An https anchor: CONNECT tunnels, TLS fronted with a test substrate CA the MCP trusts.
    anchor = 'https://spoke.invalid';
    if (idPort) identityUrl = 'https://identity.invalid';
    const substrateCa = makeCa('Substrate Test Root CA');
    let caPem = substrateCa.cert;
    if (proxyMode === 'mitm') {
      // The inspection proxy terminates TLS itself and relays plaintext to the target's port.
      mitm = makeCa('Corp Inspection CA', 'Corp IT');
      caPem = mitm.cert;
      hosts['spoke.invalid:443'] = discPort;
      if (idPort) hosts['identity.invalid:443'] = idPort;
    } else {
      const leaf = makeLeaf(substrateCa, ['spoke.invalid', 'identity.invalid']);
      const frontDisc = await tlsTerminator(leaf, discPort);
      stoppers.push(() => frontDisc.server.close());
      hosts['spoke.invalid:443'] = frontDisc.port;
      if (idPort) {
        const frontId = await tlsTerminator(leaf, idPort);
        stoppers.push(() => frontId.server.close());
        hosts['identity.invalid:443'] = frontId.port;
      }
    }
    const caFile = join(tmp, 'ca.pem');
    writeFileSync(caFile, caPem);
    netEnv.NODE_EXTRA_CA_CERTS = caFile;
  }

  const proxy = await CorpProxy.start({
    hosts,
    ...(proxyMode === 'basic' ? { basic: { user: PROXY_USER, pass: PROXY_PASSWORD } } : {}),
    ...(mitm ? { mitm } : {}),
  });
  stoppers.push(() => proxy.stop());
  const proxyUrl = proxyMode === 'basic' ? proxy.url({ user: PROXY_USER, pass: PROXY_PASSWORD }) : proxy.url();
  netEnv.HTTPS_PROXY = proxyUrl;
  netEnv.HTTP_PROXY = proxyUrl;

  let identityEndpoint: string | null = null;
  if (fake && identityUrl) {
    // The fake advertises the proxied identity, as a substrate behind a gateway would.
    fake.bootstrapIdentity = identityUrl;
  } else if (identityUrl) {
    identityEndpoint = identityUrl;
    notes.push(`identity pinned to ${identityUrl} (metabob.identityEndpoint), mapped through the proxy to ${identity}`);
  }

  return {
    kind, proxyMode, fake, proxy, anchor, identityEndpoint, key, netEnv,
    describe: `${kind} via ${proxyMode} proxy ${proxy.url()} as ${anchor}${identityUrl ? ` + ${identityUrl}` : ''}`,
    notes,
    stop: async () => { for (const s of stoppers.reverse()) await s(); },
  };
}

// ── Plugin dir ───────────────────────────────────────────────────────────────

export interface McpSetup {
  /** The MCP server's HOME; a fresh one per session unless shared on purpose. */
  home: string;
  /** Overrides the target's key (S5 passes a foreign one). */
  key?: string;
  extraEnv?: Record<string, string>;
}

/**
 * A copy of the plugin whose `.mcp.json` starts this build with the session's own HOME, config file
 * and network environment. The repo's committed `.mcp.json` (the published package) is never used.
 */
export function buildPluginDir(target: Target, setup: McpSetup): string {
  const cli = join(REPO_ROOT, 'dist', 'cli.js');
  if (!existsSync(cli)) throw new Error(`${cli} not found: run \`bun run build\` first`);
  const dir = tempDir('plugin');
  cpSync(join(REPO_ROOT, '.claude-plugin'), join(dir, '.claude-plugin'), { recursive: true });
  cpSync(join(REPO_ROOT, 'skills'), join(dir, 'skills'), { recursive: true });

  mkdirSync(setup.home, { recursive: true });
  const configPath = join(setup.home, 'metabob-config.json');
  writeFileSync(configPath, JSON.stringify({
    metabob: {
      apiKey: setup.key ?? target.key,
      discoveryEndpoint: target.anchor,
      ...(target.identityEndpoint ? { identityEndpoint: target.identityEndpoint } : {}),
    },
  }, null, 2));

  const env: Record<string, string> = {
    HOME: setup.home,
    USERPROFILE: setup.home,
    METABOB_CONFIG_PATH: configPath,
    METABOB_TELEMETRY: 'off',
    LOG_LEVEL: 'info',
    ...target.netEnv,
    ...(setup.extraEnv ?? {}),
  };
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: { metabob: { command: 'node', args: [cli], env } },
  }, null, 2));
  return dir;
}

// ── Transcript ───────────────────────────────────────────────────────────────

export interface ToolCall {
  index: number;
  id: string;
  /** The full tool name as Claude Code names it. */
  name: string;
  /** The metabob tool name without the server prefix, or the built-in name. */
  tool: string;
  metabob: boolean;
  input: any;
  result: string | null;
  isError: boolean;
  /** Milliseconds from session start to the tool_use event. */
  atMs: number;
}

export interface Transcript {
  label: string;
  init: {
    plugins: Array<{ name: string; source?: string; path?: string; version?: string }>;
    mcpServers: Array<{ name: string; status: string; source?: string }>;
    tools: string[];
    metabobTools: string[];
    skills: string[];
    model: string | null;
    permissionMode: string | null;
  } | null;
  calls: ToolCall[];
  skillLoads: Array<{ skill: string; isError: boolean; result: string | null }>;
  finalText: string;
  resultSubtype: string | null;
  costUsd: number;
  durationMs: number;
  numTurns: number | null;
  permissionDenials: unknown[];
  /** A refusal of a tool the harness pre-approved: a harness problem, not a scenario result. */
  harnessErrors: string[];
  /** Refusals of tools the harness does not offer (the agent reaching outside its brief). */
  outOfScope: string[];
  /** Tool names the session pre-approved (a metabob tool matches by its server prefix). */
  allowed: string[];
  exitCode: number | null;
  stderrTail: string;
  rawPath: string;
}

function emptyTranscript(label: string, rawPath: string): Transcript {
  return {
    label, init: null, calls: [], skillLoads: [], finalText: '', resultSubtype: null, costUsd: 0,
    durationMs: 0, numTurns: null, permissionDenials: [], harnessErrors: [], outOfScope: [], allowed: [], exitCode: null,
    stderrTail: '', rawPath,
  };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? JSON.stringify(c))).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

const PERMISSION_RE = /(permission to use|haven't granted it|requires approval|was blocked|not allowed to use)/i;

function isAllowed(t: Transcript, name: string): boolean {
  return t.allowed.some((a) => name === a || (a === SERVER_PREFIX.slice(0, -2) && name.startsWith(SERVER_PREFIX)));
}

/** Folds one stream-json event into the transcript. */
export function foldEvent(t: Transcript, e: any, startedAt: number): void {
  if (e?.type === 'system' && e.subtype === 'init') {
    const tools: string[] = e.tools ?? [];
    t.init = {
      plugins: e.plugins ?? [],
      mcpServers: e.mcp_servers ?? [],
      tools,
      metabobTools: tools.filter((n) => n.startsWith(SERVER_PREFIX)).map((n) => n.slice(SERVER_PREFIX.length)),
      skills: e.skills ?? [],
      model: e.model ?? null,
      permissionMode: e.permissionMode ?? null,
    };
    return;
  }
  if (e?.type === 'assistant' && Array.isArray(e.message?.content)) {
    for (const c of e.message.content) {
      if (c?.type !== 'tool_use') continue;
      const metabob = String(c.name).startsWith(SERVER_PREFIX);
      t.calls.push({
        index: t.calls.length,
        id: c.id,
        name: c.name,
        tool: metabob ? c.name.slice(SERVER_PREFIX.length) : c.name,
        metabob,
        input: c.input ?? {},
        result: null,
        isError: false,
        atMs: Date.now() - startedAt,
      });
    }
    return;
  }
  if (e?.type === 'user' && Array.isArray(e.message?.content)) {
    for (const c of e.message.content) {
      if (c?.type !== 'tool_result') continue;
      const call = t.calls.find((x) => x.id === c.tool_use_id);
      if (!call) continue;
      call.result = resultText(c.content);
      call.isError = c.is_error === true;
      if (call.isError && PERMISSION_RE.test(call.result)) {
        const line = `${call.name}: ${call.result.slice(0, 200)}`;
        (isAllowed(t, call.name) ? t.harnessErrors : t.outOfScope).push(line);
      }
      if (call.name === 'Skill') {
        t.skillLoads.push({ skill: String(call.input?.skill ?? call.input?.command ?? ''), isError: call.isError, result: call.result });
      }
    }
    return;
  }
  if (e?.type === 'result') {
    t.resultSubtype = e.subtype ?? null;
    t.finalText = typeof e.result === 'string' ? e.result : '';
    t.costUsd = Number(e.total_cost_usd ?? 0);
    t.numTurns = e.num_turns ?? null;
    t.permissionDenials = (e.permission_denials ?? []).filter((d: any) => isAllowed(t, String(d?.tool_name ?? '')));
  }
}

/** Parses a whole stream-json file (used to check the parser against saved output). */
export function parseStreamFile(path: string, label = 'saved'): Transcript {
  const t = emptyTranscript(label, path);
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      foldEvent(t, JSON.parse(line), 0);
    } catch {
      // not an event
    }
  }
  return t;
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export interface SessionOptions {
  label: string;
  prompt: string;
  workspace: string;
  pluginDir: string;
  maxTurns: number;
  model?: string;
  maxBudgetUsd?: number;
  /** Built-in tools pre-approved besides the metabob server and Skill. */
  extraTools?: string[];
  debugFile?: string;
  /** Called for each event as it arrives (S3 starts B on A's first finding). */
  onEvent?: (e: any, t: Transcript) => void;
  timeoutMs?: number;
  /** Where the raw stream-json goes. */
  rawDir: string;
}

/** Variables that would steer the MCP server away from the config the harness writes. */
const ROUTING_ENV = /^(METABOB_|SUBSTRATE_|MB_|DISCOVERY_ENDPOINT$|IDENTITY_ENDPOINT$|VESSEL_|HEALTH_PORT$|SESSION_ID$|WORKSPACE_PATH$|ANALYSIS_API_URL$|USER_VESSEL_URL$|CONCEPT_DB_URL$|GOAL_HOST_VESSEL_URL$|NODE_EXTRA_CA_CERTS$|RUN_GOAL_|RESOLVE_IMPULSE_)/;
const PROXY_ENV = /^(https?_proxy|no_proxy|all_proxy)$/i;

export const BASE_TOOLS = ['Read', 'Glob', 'Grep'];

/**
 * With --no-session-persistence Claude Code writes no transcript, but still creates an empty
 * auto-memory directory under ~/.claude/projects/<cwd slug>; remove it when that is all it holds.
 */
function removeEmptyProjectDir(cwd: string): void {
  const dir = join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  try {
    const entries = readdirSync(dir);
    const memory = join(dir, 'memory');
    if (entries.every((e) => e === 'memory') && (!existsSync(memory) || readdirSync(memory).length === 0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // nothing there
  }
}

export function runSession(opts: SessionOptions): Promise<Transcript> {
  mkdirSync(opts.rawDir, { recursive: true });
  const rawPath = join(opts.rawDir, `${opts.label}.jsonl`);
  const t = emptyTranscript(opts.label, rawPath);
  const allowed = [SERVER_PREFIX.slice(0, -2), 'Skill', ...BASE_TOOLS, ...(opts.extraTools ?? [])];
  t.allowed = allowed;
  const args = [
    '-p', opts.prompt,
    '--plugin-dir', opts.pluginDir,
    '--output-format', 'stream-json', '--verbose',
    '--max-turns', String(opts.maxTurns),
    '--model', opts.model ?? 'sonnet',
    // User settings (and the user-level skills dir) stay out: only the plugin under test supplies `metabob`.
    '--setting-sources', 'project',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--no-session-persistence',
    '--max-budget-usd', String(opts.maxBudgetUsd ?? 1.5),
    '--allowedTools', ...allowed,
    ...(opts.debugFile ? ['--debug-file', opts.debugFile] : []),
  ];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || ROUTING_ENV.test(k) || PROXY_ENV.test(k)) continue;
    env[k] = v;
  }
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn('claude', args, { cwd: opts.workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const raw: string[] = [];
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      raw.push(line);
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      foldEvent(t, e, started);
      try {
        opts.onEvent?.(e, t);
      } catch {
        // a scenario hook never breaks the session
      }
    });
    const kill = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 10 * 60_000);
    child.on('close', (code) => {
      clearTimeout(kill);
      t.exitCode = code;
      t.durationMs = Date.now() - started;
      t.stderrTail = stderr.slice(-800);
      writeFileSync(rawPath, raw.join('\n') + '\n');
      removeEmptyProjectDir(opts.workspace);
      resolvePromise(t);
    });
  });
}

// ── Helpers for assertions ───────────────────────────────────────────────────

export function metabobCalls(t: Transcript, tool?: string): ToolCall[] {
  return t.calls.filter((c) => c.metabob && (!tool || c.tool === tool));
}

/** One line per tool call: `#3 record_finding {files:[…]} → agf_x… (ok)`. */
export function callLines(t: Transcript, width = 140): string[] {
  return t.calls.map((c) => {
    const input = JSON.stringify(c.input);
    const result = (c.result ?? '(no result)').replace(/\s+/g, ' ');
    const line = `#${c.index} ${c.tool} ${input.length > 120 ? `${input.slice(0, 117)}...` : input} → ${result.slice(0, width)}${c.isError ? ' [ERROR]' : ''}`;
    return line;
  });
}

/** Ids of the forms the ledger hands out (`agf_*`, `concept_*`, dispatch ids). */
export function idsIn(text: string): string[] {
  return [...new Set(text.match(/\b(agf_[a-z0-9]+|concept_[a-z0-9_-]*[a-z0-9]|dispatch_[a-z0-9]+|exec-[a-z0-9-]+)\b/gi) ?? [])];
}

export interface Check {
  name: string;
  /** null: not checked against this target. */
  pass: boolean | null;
  detail?: string;
}

export function check(name: string, pass: boolean, detail?: string): Check {
  return { name, pass, ...(detail ? { detail } : {}) };
}

export function skipped(name: string, why: string): Check {
  return { name, pass: null, detail: why };
}
