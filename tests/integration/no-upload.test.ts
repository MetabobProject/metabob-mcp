/**
 * No workspace content leaves the machine.
 *
 * Starts the real server (src/index.ts over stdio) with an API key — the
 * configuration under which any background sender would run — and points every
 * outbound endpoint it knows at one fake HTTP server that records each request.
 * The workspace holds files a careless sender would ship: a source file, a
 * `.env`, a log, and a binary that looks like a sqlite WAL, each carrying a
 * unique sentinel. The test runs `init_workspace`, edits files afterwards (the
 * path a file watcher would take), calls the analysis tools, waits long enough
 * for any background sender to fire, and then asserts that no request carried
 * any content sentinel or a sentinel file's name, and that none went to a
 * submission path.
 *
 * It asserts on bodies rather than on "zero requests": the substrate tools
 * legitimately reach the configured endpoints, and must carry none of this.
 */
import { test, expect, afterAll } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Recorded {
  method: string;
  url: string;
  body: Buffer;
}

const SOURCE_SENTINEL = 'SRC_SENTINEL_7f3a91c2';
const ENV_SENTINEL = 'ENV_SENTINEL_b84e0d55';
const LOG_SENTINEL = 'LOG_SENTINEL_2c6f19aa';
const WAL_SENTINEL = 'WAL_SENTINEL_e05d7b31';
const EDIT_SENTINEL = 'EDIT_SENTINEL_91aa04fe';
/** A file-name stem: file lists count as workspace content too. */
const NAME_SENTINEL = 'zz_sentinel_module';

/** File content: no request may carry any of these. */
const CONTENT_SENTINELS = [SOURCE_SENTINEL, ENV_SENTINEL, LOG_SENTINEL, WAL_SENTINEL, EDIT_SENTINEL];

/** Paths a workspace-content sender would use. */
const SUBMISSION_PATHS = [/\/v2\/mcp\/analysis\/run/, /\/v2\/submit/, /^\/resolve$/, /^\/v2\/impulses\/resolve$/];

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-no-upload-ws-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', `${NAME_SENTINEL}.ts`),
    `export const marker = '${SOURCE_SENTINEL}';\nexport function compute(x: number): number {\n  return x * 2;\n}\n`,
  );
  writeFileSync(join(dir, 'src', 'consumer.ts'), `import { compute } from './${NAME_SENTINEL}';\nexport const y = compute(2);\n`);
  writeFileSync(join(dir, '.env'), `API_TOKEN=${ENV_SENTINEL}\n`);
  writeFileSync(join(dir, 'app.log'), `2026-10-13 INFO started ${LOG_SENTINEL}\n`);
  // A sqlite-WAL-like binary: the WAL magic, NULs, then the sentinel.
  writeFileSync(
    join(dir, 'sidecar.db-wal'),
    Buffer.concat([Buffer.from([0x37, 0x7f, 0x06, 0x82, 0, 0, 0, 0]), Buffer.alloc(64), Buffer.from(WAL_SENTINEL)]),
  );
  // A git repository with a commit, so a git-state poller would have a HEAD to
  // watch. Skipped quietly where git is unavailable.
  const git = (...args: string[]) =>
    spawnSync('git', args, {
      cwd: dir,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
  if (git('init', '-q').status === 0) {
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
  }
  return dir;
}

test('the server sends no workspace content to any endpoint it is configured with', async () => {
  const recorded: Recorded[] = [];
  const fake = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = Buffer.from(await req.arrayBuffer());
      recorded.push({ method: req.method, url: req.url, body });
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const endpoint = `http://127.0.0.1:${fake.port}`;

  const workspace = makeWorkspace();
  const home = mkdtempSync(join(tmpdir(), 'mcp-no-upload-home-'));
  tempDirs.push(home);

  const runtime = process.execPath;
  const args = process.versions.bun ? ['run', 'src/index.ts'] : ['src/index.ts'];
  const child: ChildProcess = spawn(runtime, args, {
    stdio: ['pipe', 'pipe', 'ignore'],
    cwd: import.meta.dir + '/../..',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      METABOB_CONFIG_PATH: join(home, 'no-such-config.json'),
      METABOB_API_KEY: 'test-key-no-upload',
      WORKSPACE_PATH: workspace,
      SESSION_ID: 'no-upload-session',
      METABOB_ENDPOINT: endpoint,
      ACTIVITY_API_URL: endpoint,
      DISCOVERY_ENDPOINT: endpoint,
      IDENTITY_ENDPOINT: endpoint,
      CONCEPT_DB_URL: endpoint,
      GOAL_HOST_VESSEL_URL: endpoint,
      HEALTH_PORT: String(19900 + Math.floor(Math.random() * 90)),
      LOG_LEVEL: 'error',
    },
  });

  const responses = new Map<number, { result?: { content?: Array<{ text?: string }> }; error?: unknown }>();
  let buffer = '';
  child.stdout!.on('data', (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.jsonrpc === '2.0' && typeof parsed.id === 'number') responses.set(parsed.id, parsed);
      } catch {
        // partial / non-JSON line
      }
    }
  });

  const call = async (id: number, method: string, params: unknown) => {
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const deadline = Date.now() + 60_000;
    while (!responses.has(id)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for response id=${id}`);
      await Bun.sleep(25);
    }
    return responses.get(id)!;
  };
  const tool = (id: number, name: string, args: Record<string, unknown>) =>
    call(id, 'tools/call', { name, arguments: args });

  try {
    await call(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'no-upload-test', version: '0' },
    });

    const init = await tool(2, 'init_workspace', {
      workspace_path: workspace,
      recently_changed_files: [`src/${NAME_SENTINEL}.ts`],
      sync_api: true,
      batch_size: 20,
    });
    expect(init.error).toBeUndefined();
    const initText = init.result?.content?.[0]?.text ?? '';
    expect(initText).toContain('Local index: 2/2 files parsed');
    expect(initText).toContain('No file content was sent off the machine');

    // Edit files after indexing — the event a file or git watcher reacts to.
    appendFileSync(join(workspace, 'src', `${NAME_SENTINEL}.ts`), `export const edited = '${EDIT_SENTINEL}';\n`);
    appendFileSync(join(workspace, '.env'), `SECOND=${EDIT_SENTINEL}\n`);
    appendFileSync(join(workspace, 'app.log'), `edited ${EDIT_SENTINEL}\n`);
    await Bun.sleep(3_000);

    for (const [id, name, args] of [
      [3, 'get_problems', {}],
      [4, 'get_problems', { file_path: `src/${NAME_SENTINEL}.ts` }],
      [5, 'get_analysis_context', { recently_changed_files: [`src/${NAME_SENTINEL}.ts`] }],
      [6, 'get_metrics', {}],
      [7, 'search_codebase', { query: 'compute' }],
      [8, 'analyze_impact', { changed_files: [`src/${NAME_SENTINEL}.ts`] }],
      [9, 'assign_git_changes', { changed_files: [`src/${NAME_SENTINEL}.ts`] }],
      [10, 'predict_cochanges', { changed_files: [`src/${NAME_SENTINEL}.ts`] }],
    ] as const) {
      const res = await tool(id, name, args as Record<string, unknown>);
      expect(res.error).toBeUndefined();
    }

    // Long enough for any background sender to fire.
    await Bun.sleep(6_000);
  } finally {
    child.kill();
    fake.stop(true);
  }

  for (const req of recorded) {
    const where = `${req.method} ${req.url}`;
    const pathname = new URL(req.url).pathname;
    const carries = (s: string) => req.body.includes(s) || req.url.includes(s);
    for (const sentinel of CONTENT_SENTINELS) {
      expect({ where, carries: carries(sentinel) }).toEqual({ where, carries: false });
    }
    expect({ where, carriesFileName: carries(NAME_SENTINEL) }).toEqual({ where, carriesFileName: false });
    for (const path of SUBMISSION_PATHS) {
      expect({ where, submission: path.test(pathname) }).toEqual({ where, submission: false });
    }
  }
}, 90_000);
