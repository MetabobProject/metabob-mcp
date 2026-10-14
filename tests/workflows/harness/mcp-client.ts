/**
 * A stdio MCP client for the server under test: spawns it, speaks
 * newline-delimited JSON-RPC as an MCP client does, and times every request out.
 *
 * MCP_UNDER_TEST=dist runs the built `dist/cli.js`; anything else runs
 * `src/cli.ts`. Each server gets its own temp HOME (the sidecar store lives in
 * ~/.metabob) and its own workspace.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

export function entryUnderTest(): string {
  const entry = process.env.MCP_UNDER_TEST === 'dist'
    ? join(REPO_ROOT, 'dist', 'cli.js')
    : join(REPO_ROOT, 'src', 'cli.ts');
  if (!existsSync(entry)) throw new Error(`server under test not found: ${entry} (run \`bun run build\` for MCP_UNDER_TEST=dist)`);
  return entry;
}

const tempDirs: string[] = [];

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mcp-wf-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold a file briefly after the child exits; leaving a temp dir is harmless.
    }
  }
}

/** A small workspace with a named root, so the repo name the ledger keys on is predictable. */
export function makeWorkspace(name: string, files: Record<string, string> = {}): string {
  const root = join(tempDir('ws'), name);
  mkdirSync(root, { recursive: true });
  const all = { 'src/index.ts': 'export const answer = 42;\n', ...files };
  for (const [rel, content] of Object.entries(all)) {
    const path = join(root, rel);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

export interface ServerOptions {
  workspace: string;
  /** Extra environment; `undefined` values remove a variable. */
  env?: Record<string, string | undefined>;
  home?: string;
}

export interface ToolResult {
  text: string;
  isError: boolean;
  error?: { code: number; message: string };
}

const REQUEST_TIMEOUT_MS = 20_000;

export class McpServer {
  /** The `initialize` result: serverInfo, capabilities, instructions. */
  initializeResult: any;
  readonly home: string;
  private child: ChildProcess;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private exited: Promise<number | null>;
  stderr = '';
  /** Lines on stdout that were not JSON-RPC — the MCP stdio contract forbids any. */
  readonly strayStdout: string[] = [];

  private constructor(opts: ServerOptions) {
    this.home = opts.home ?? tempDir('home');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    // Nothing from the developer's or the CI's environment may steer routing.
    for (const k of Object.keys(env)) {
      if (/^(METABOB_|MB_|DISCOVERY_ENDPOINT|IDENTITY_|VESSEL_|HEALTH_PORT|SESSION_|WORKSPACE_PATH|RUN_GOAL_|RESOLVE_IMPULSE_)/.test(k)) {
        delete env[k];
      }
    }
    Object.assign(env, {
      HOME: this.home,
      USERPROFILE: this.home,
      WORKSPACE_PATH: opts.workspace,
      METABOB_API_KEY: 'mb_test_workflow_key',
      // Without this the CLI re-execs itself under `bun --use-system-ca`, and
      // the process we hold would be a trampoline rather than the server.
      METABOB_NO_SYSTEM_CA: '1',
      LOG_LEVEL: 'info',
    });
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }

    this.child = spawn(process.execPath, [entryUnderTest()], {
      cwd: opts.workspace,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise(resolveExit => this.child.once('exit', code => resolveExit(code)));
    this.child.stdout!.on('data', (chunk: Buffer) => this.onStdout(chunk.toString()));
    this.child.stderr!.on('data', (chunk: Buffer) => { this.stderr += chunk.toString(); });
  }

  /** Spawn the server and complete the MCP handshake. */
  static async start(opts: ServerOptions): Promise<McpServer> {
    const server = new McpServer(opts);
    const init = await server.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'workflow-tests', version: '1' },
    });
    if (!init.result?.serverInfo) {
      throw new Error(`initialize failed: ${JSON.stringify(init)}\n--- stderr ---\n${server.stderr}`);
    }
    server.notify('notifications/initialized', {});
    server.initializeResult = init.result;
    return server;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        this.strayStdout.push(line);
        continue;
      }
      const resolveMsg = msg?.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (resolveMsg) {
        this.pending.delete(msg.id);
        resolveMsg(msg);
      }
    }
  }

  request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolveReq, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms\n--- stderr ---\n${this.stderr.slice(-4000)}`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveReq(msg);
      });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params: unknown): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async listTools(): Promise<Array<{ name: string; description: string; inputSchema: any }>> {
    const res = await this.request('tools/list', {});
    return res.result?.tools ?? [];
  }

  async call(name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<ToolResult> {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (res.error) return { text: '', isError: true, error: res.error };
    const text = (res.result?.content ?? []).map((c: any) => c.text ?? '').join('\n');
    return { text, isError: res.result?.isError === true };
  }

  /** Call a tool and return its text, failing loudly on a protocol error. */
  async text(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const r = await this.call(name, args);
    if (r.error) throw new Error(`${name} failed: ${r.error.message}`);
    return r.text;
  }

  /** The vessel HTTP server's bound port, read from its startup line. */
  async vesselPort(timeoutMs = 10_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const m = /Vessel server listening on port (\d+)/.exec(this.stderr);
      if (m) return Number(m[1]);
      if (Date.now() > deadline) throw new Error(`no vessel port in stderr:\n${this.stderr.slice(-2000)}`);
      await Bun.sleep(50);
    }
  }

  /** Close stdin (the server exits on EOF), then kill if it lingers. */
  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin!.end();
    const timeout = Bun.sleep(3_000).then(() => 'timeout' as const);
    if ((await Promise.race([this.exited, timeout])) === 'timeout') {
      this.child.kill('SIGKILL');
      await this.exited;
    }
  }
}
