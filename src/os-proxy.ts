/**
 * The OS proxy settings this process does not see (SPEC §network). A desktop
 * set up for a corporate network often has its proxy — or a PAC / WPAD script —
 * configured in the OS rather than in HTTP(S)_PROXY. This process honours only
 * the environment and evaluates no PAC script, so when a direct connection
 * fails, the OS settings are read cheaply (macOS `scutil --proxy`, the Windows
 * Internet Settings registry key, GNOME `gsettings`) and named in the failure:
 * "set HTTPS_PROXY". Best-effort and bounded: it never blocks startup, and any
 * failure to read answers null. CONFORMANCE §c8-proxy-and-tls-in-the-vessel-role
 *
 * Node-safe: no Bun-only module.
 */

import { execFile } from 'node:child_process';

export interface OsProxySettings {
  source: 'scutil' | 'registry' | 'gsettings';
  /** A PAC script URL, when one is configured. */
  pacUrl: string | null;
  /** WPAD auto-discovery is on. */
  autoDiscovery: boolean;
  /** A manual proxy, host:port. */
  proxy: string | null;
}

const OS_PROXY_TIMEOUT_MS = 1_500;

function run(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : String(stdout));
      });
    } catch {
      resolve(null);
    }
  });
}

/** `scutil --proxy` output (macOS). */
export function parseScutil(out: string): OsProxySettings | null {
  const field = (k: string) => new RegExp(`^\\s*${k}\\s*:\\s*(.+?)\\s*$`, 'm').exec(out)?.[1] ?? null;
  const pacOn = field('ProxyAutoConfigEnable') === '1';
  const pacUrl = pacOn ? field('ProxyAutoConfigURLString') : null;
  const autoDiscovery = field('ProxyAutoDiscoveryEnable') === '1';
  let proxy: string | null = null;
  if (field('HTTPSEnable') === '1' && field('HTTPSProxy')) proxy = `${field('HTTPSProxy')}:${field('HTTPSPort') ?? '443'}`;
  else if (field('HTTPEnable') === '1' && field('HTTPProxy')) proxy = `${field('HTTPProxy')}:${field('HTTPPort') ?? '80'}`;
  if (!pacUrl && !autoDiscovery && !proxy) return null;
  return { source: 'scutil', pacUrl, autoDiscovery, proxy };
}

/** `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"` output (Windows). */
export function parseRegQuery(out: string): OsProxySettings | null {
  const value = (k: string) => new RegExp(`^\\s*${k}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'mi').exec(out)?.[1] ?? null;
  const pacUrl = value('AutoConfigURL');
  const enabled = value('ProxyEnable');
  const server = value('ProxyServer');
  const proxyOn = enabled !== null && Number(enabled) !== 0;
  let proxy: string | null = null;
  if (proxyOn && server) {
    // "host:port" or "http=host:port;https=host:port"
    const https = /(?:^|;)https=([^;]+)/i.exec(server)?.[1];
    proxy = https ?? (server.includes('=') ? /(?:^|;)http=([^;]+)/i.exec(server)?.[1] ?? null : server);
  }
  const autoDetect = value('AutoDetect');
  const autoDiscovery = autoDetect !== null && Number(autoDetect) !== 0;
  if (!pacUrl && !proxy && !autoDiscovery) return null;
  return { source: 'registry', pacUrl, autoDiscovery, proxy };
}

/** `gsettings get org.gnome.system.proxy …` values (GNOME): mode, autoconfig-url, https host, https port. */
export function parseGsettings(mode: string, autoconfigUrl: string, httpsHost: string, httpsPort: string): OsProxySettings | null {
  const unquote = (s: string) => s.trim().replace(/^'(.*)'$/, '$1');
  const m = unquote(mode);
  if (m === 'auto') {
    const url = unquote(autoconfigUrl);
    return { source: 'gsettings', pacUrl: url || null, autoDiscovery: !url, proxy: null };
  }
  if (m === 'manual') {
    const host = unquote(httpsHost);
    return host ? { source: 'gsettings', pacUrl: null, autoDiscovery: false, proxy: `${host}:${httpsPort.trim() || '443'}` } : null;
  }
  return null;
}

// @anchor detect-os-proxy
/** Read the OS proxy settings, bounded by `timeoutMs`; null when none are set or they cannot be read. */
export async function detectOsProxy(timeoutMs = OS_PROXY_TIMEOUT_MS, platform: string = process.platform): Promise<OsProxySettings | null> {
  try {
    if (platform === 'darwin') {
      const out = await run('scutil', ['--proxy'], timeoutMs);
      return out ? parseScutil(out) : null;
    }
    if (platform === 'win32') {
      const out = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], timeoutMs);
      return out ? parseRegQuery(out) : null;
    }
    const get = (key: string) => run('gsettings', ['get', ...key.split(' ')], timeoutMs);
    const mode = await get('org.gnome.system.proxy mode');
    if (!mode) return null;
    const [url, host, port] = await Promise.all([
      get('org.gnome.system.proxy autoconfig-url'),
      get('org.gnome.system.proxy.https host'),
      get('org.gnome.system.proxy.https port'),
    ]);
    return parseGsettings(mode, url ?? '', host ?? '', port ?? '');
  } catch {
    return null;
  }
}

/** One sentence naming OS proxy settings the process does not see, or null. */
export function describeOsProxy(s: OsProxySettings | null): string | null {
  if (!s) return null;
  const what = s.pacUrl
    ? `a PAC script (${s.pacUrl})`
    : s.proxy
      ? `a proxy (${s.proxy})`
      : 'proxy auto-discovery (WPAD)';
  return `the OS proxy settings (${s.source}) use ${what}, which this process does not see; set HTTPS_PROXY (and HTTP_PROXY for a plain-http anchor) to the proxy it names`;
}
