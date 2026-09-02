/**
 * Minimal MCP-over-stdio driver for the demo beats.
 *
 * Spawns a REAL server the way a client would, so nothing on camera is a mock.
 * Each call gets its own process — which is the point of beat 1: the second
 * process is not the first one kept alive.
 */
import { spawn, type ChildProcess } from 'child_process';

const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  opts: { healthPort?: number } = {},
): Promise<{ text: string; pid: number }> {
  const child: ChildProcess = spawn('bun', ['run', `${REPO}/src/cli.ts`], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env,
      METABOB_CONFIG_PATH: `${REPO}/.metabob/config.json`,
      HEALTH_PORT: String(opts.healthPort ?? 18700 + Math.floor(Math.random() * 80)),
      METABOB_AGENT_RESOLVER: '0',
      NO_PROXY: 'localhost,127.0.0.1',
      WORKSPACE_PATH: REPO,
      LOG_LEVEL: 'error',
    },
  });

  let buffer = '';
  const seen = new Map<number, any>();
  child.stdout!.on('data', (d: Buffer) => {
    buffer += d.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const m = JSON.parse(line);
        if (typeof m.id === 'number') seen.set(m.id, m);
      } catch { /* partial line */ }
    }
  });

  const send = (o: unknown) => child.stdin!.write(JSON.stringify(o) + '\n');
  const wait = async (id: number, ms = 25_000) => {
    const deadline = Date.now() + ms;
    while (!seen.has(id)) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for id=${id}`);
      await new Promise(r => setTimeout(r, 40));
    }
    return seen.get(id);
  };

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'demo', version: '1' } } });
    await wait(1);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
    const res = await wait(2);
    const text = res?.result?.content?.[0]?.text ?? JSON.stringify(res?.error ?? res);
    return { text, pid: child.pid! };
  } finally {
    child.kill('SIGKILL');           // beat 1: the author does not survive
  }
}
