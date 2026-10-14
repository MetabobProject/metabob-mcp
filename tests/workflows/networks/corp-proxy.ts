/**
 * A configurable corporate HTTP proxy on node:net, for the network matrix.
 * It speaks HTTP CONNECT (for https targets) and absolute-form requests (for
 * plain-http targets) and can be told to behave like the proxies the server
 * meets in the field:
 *
 *   - tunnel only to some ports (Squid's SSL_ports: CONNECT to anything but 443 → 403);
 *   - require Basic credentials (407 + Proxy-Authenticate: Basic);
 *   - challenge with NTLM and/or Negotiate (407), which a client can only meet through a relay;
 *   - cut connections idle for N ms;
 *   - answer with an HTML block page instead of tunnelling;
 *   - intercept TLS, re-signing with its own CA (a Zscaler-style inspection proxy);
 *   - blackhole: accept the connection and never answer.
 *
 * Host names are resolved by the proxy from `hosts` ("name:port" → a local
 * port), never by the client — so a name that does not resolve on the test
 * machine is reachable only through the proxy, as on a network whose DNS
 * egress is the proxy's. Every request is recorded.
 */
import * as net from 'node:net';
import * as tls from 'node:tls';
import { makeLeaf, type Issued } from './test-ca';

export interface CorpProxyOptions {
  /** "host:port" → the 127.0.0.1 port that serves it. */
  hosts: Record<string, number>;
  /** CONNECT is allowed only to these ports (others → 403). Unset → any. */
  connectPorts?: number[];
  basic?: { user: string; pass: string };
  challenge?: Array<'NTLM' | 'Negotiate'>;
  idleKillMs?: number;
  blockPage?: boolean;
  /** Terminate TLS for CONNECT targets with leaves this CA signs; `hosts` then name plain-http ports. */
  mitm?: Issued;
  blackhole?: boolean;
}

export interface ProxiedRequest {
  method: string;
  target: string;
  proxyAuthorization: string | null;
}

const BLOCK_PAGE = '<!doctype html><html><body><h1>Access denied</h1><p>Blocked by the Corp Web Gateway.</p></body></html>';

export class CorpProxy {
  readonly requests: ProxiedRequest[] = [];
  private server!: net.Server;
  private sockets = new Set<net.Socket>();
  private mitmServers = new Map<string, Promise<number>>();
  private extraServers: net.Server[] = [];
  port = 0;

  private constructor(private readonly opts: CorpProxyOptions) {}

  static async start(opts: CorpProxyOptions): Promise<CorpProxy> {
    const p = new CorpProxy(opts);
    p.server = net.createServer((c) => p.onConnection(c));
    await new Promise<void>((r) => p.server.listen(0, '127.0.0.1', () => r()));
    p.port = (p.server.address() as net.AddressInfo).port;
    return p;
  }

  /** The proxy URL, optionally with credentials. */
  url(creds?: { user: string; pass: string }): string {
    return creds ? `http://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.pass)}@127.0.0.1:${this.port}` : `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    for (const s of this.extraServers) s.close();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private track(s: net.Socket) {
    this.sockets.add(s);
    s.on('close', () => this.sockets.delete(s));
    s.on('error', () => {});
  }

  private onConnection(client: net.Socket) {
    this.track(client);
    if (this.opts.blackhole) return; // accept, never answer
    if (this.opts.idleKillMs) {
      client.setTimeout(this.opts.idleKillMs, () => client.destroy());
    }
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      client.off('data', onData);
      void this.onHead(client, buf.subarray(0, idx).toString('latin1'), buf.subarray(idx + 4));
    };
    client.on('data', onData);
  }

  private reply(client: net.Socket, status: string, headers: string[] = [], body = '') {
    client.end(`HTTP/1.1 ${status}\r\n${[...headers, `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close'].join('\r\n')}\r\n\r\n${body}`);
  }

  private async onHead(client: net.Socket, head: string, rest: Buffer) {
    const lines = head.split('\r\n');
    const [method = '', target = ''] = (lines[0] ?? '').split(' ');
    const header = (name: string) =>
      lines.slice(1).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim() ?? null;
    this.requests.push({ method, target, proxyAuthorization: header('proxy-authorization') });

    if (this.opts.challenge?.length) {
      return this.reply(client, '407 Proxy Authentication Required', this.opts.challenge.map((s) => `Proxy-Authenticate: ${s}`));
    }
    if (this.opts.basic) {
      const expected = `Basic ${Buffer.from(`${this.opts.basic.user}:${this.opts.basic.pass}`).toString('base64')}`;
      if (header('proxy-authorization') !== expected) {
        return this.reply(client, '407 Proxy Authentication Required', ['Proxy-Authenticate: Basic realm="corp"']);
      }
    }
    if (this.opts.blockPage) {
      return this.reply(client, '200 OK', ['Content-Type: text/html'], BLOCK_PAGE);
    }

    if (method === 'CONNECT') {
      const [host = '', portRaw = '443'] = target.split(':');
      const port = Number(portRaw);
      if (this.opts.connectPorts && !this.opts.connectPorts.includes(port)) {
        return this.reply(client, '403 Forbidden', ['Content-Type: text/html'], BLOCK_PAGE);
      }
      const upstreamPort = this.opts.hosts[`${host}:${port}`];
      if (!upstreamPort) return this.reply(client, '502 Bad Gateway');
      const via = this.opts.mitm ? await this.mitmServer(host, upstreamPort) : upstreamPort;
      const upstream = net.connect(via, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        if (rest.length) upstream.write(rest);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      this.track(upstream);
      upstream.on('close', () => client.destroy());
      client.on('close', () => upstream.destroy());
      return;
    }

    // Absolute-form: GET http://host:port/path HTTP/1.1
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return this.reply(client, '400 Bad Request');
    }
    const upstreamPort = this.opts.hosts[`${url.hostname}:${url.port || '80'}`];
    if (!upstreamPort) return this.reply(client, '502 Bad Gateway');
    const forwarded = [
      `${method} ${url.pathname}${url.search} HTTP/1.1`,
      ...lines.slice(1).filter((l) => !/^proxy-/i.test(l)),
    ].join('\r\n') + '\r\n\r\n';
    const upstream = net.connect(upstreamPort, '127.0.0.1', () => {
      upstream.write(forwarded);
      if (rest.length) upstream.write(rest);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    this.track(upstream);
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream.destroy());
  }

  /** A TLS terminator for `host`, signed by the inspection CA, that relays plaintext to `upstreamPort`. */
  private mitmServer(host: string, upstreamPort: number): Promise<number> {
    const key = `${host}:${upstreamPort}`;
    let p = this.mitmServers.get(key);
    if (!p) {
      p = tlsTerminator(makeLeaf(this.opts.mitm!, [host]), upstreamPort).then(({ server, port }) => {
        this.extraServers.push(server);
        return port;
      });
      this.mitmServers.set(key, p);
    }
    return p;
  }
}

/** A TLS server presenting `leaf` that relays each connection's plaintext to 127.0.0.1:`upstreamPort`. */
export async function tlsTerminator(leaf: Issued, upstreamPort: number): Promise<{ server: tls.Server; port: number }> {
  const sockets = new Set<net.Socket>();
  const server = tls.createServer({ cert: leaf.cert, key: leaf.key }, (s) => {
    const up = net.connect(upstreamPort, '127.0.0.1');
    for (const x of [s, up]) {
      sockets.add(x);
      x.on('error', () => {});
      x.on('close', () => sockets.delete(x));
    }
    s.pipe(up);
    up.pipe(s);
    up.on('close', () => s.destroy());
    s.on('close', () => up.destroy());
  });
  server.on('close', () => {
    for (const x of sockets) x.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as net.AddressInfo).port };
}

/** A plain TCP server that accepts connections and never answers. */
export async function silentServer(): Promise<{ server: net.Server; port: number; stop: () => void }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('error', () => {});
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    server,
    port: (server.address() as net.AddressInfo).port,
    stop: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

/** A port nothing listens on. */
export async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
