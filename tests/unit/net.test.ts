/**
 * The one outbound path (src/net.ts): proxy selection per request, NO_PROXY and
 * the loopback bypass, credential redaction, error classification; the OS proxy
 * readers (src/os-proxy.ts); the installer's configuration names. The network
 * conditions themselves are exercised end to end by
 * tests/workflows/networks/matrix.test.ts.
 * SPEC §network, CONFORMANCE §c8-proxy-and-tls-in-the-vessel-role
 */
import { describe, expect, test } from 'bun:test';

import {
  NetError,
  causeOfLine,
  classifyNetError,
  readProxyEnv,
  redactText,
  redactUrl,
  request,
  selectProxy,
} from '../../src/net';
import { describeOsProxy, parseGsettings, parseRegQuery, parseScutil } from '../../src/os-proxy';
import { applySubstrateEnvAliases, CONFIG_LOOKUP_ORDER, resolveConfigPath } from '../../src/config';

const P = 'http://proxy.corp:3128';

describe('selectProxy', () => {
  test('https uses HTTPS_PROXY, falling back to HTTP_PROXY; http uses HTTP_PROXY only', () => {
    expect(selectProxy('https://a.example/', { HTTPS_PROXY: P }).proxy).toBe(P);
    expect(selectProxy('https://a.example/', { HTTP_PROXY: P }).proxy).toBe(P);
    expect(selectProxy('http://a.example/', { HTTPS_PROXY: P }).proxy).toBeNull();
    expect(selectProxy('http://a.example/', { HTTP_PROXY: P }).proxy).toBe(P);
  });

  test('lowercase names win; a scheme-less proxy is http', () => {
    expect(selectProxy('https://a.example/', { HTTPS_PROXY: P, https_proxy: 'http://lower:1' }).proxy).toBe('http://lower:1');
    expect(selectProxy('https://a.example/', { HTTPS_PROXY: 'proxy.corp:3128' }).proxy).toBe('http://proxy.corp:3128');
  });

  test('loopback always goes direct when a proxy is set, without a NO_PROXY entry', () => {
    for (const u of ['http://127.0.0.1:18100', 'http://localhost:8080', 'http://[::1]:18100', 'https://127.5.0.1', 'http://app.localhost']) {
      expect(selectProxy(u, { HTTPS_PROXY: P, HTTP_PROXY: P })).toEqual({ proxy: null, bypass: 'loopback' });
    }
    expect(readProxyEnv({ HTTPS_PROXY: P }).effectiveNoProxy).toEqual(['localhost', '127.0.0.1', '::1']);
    expect(readProxyEnv({}).effectiveNoProxy).toEqual([]);
  });

  test('NO_PROXY: exact, domain suffix, leading dot, wildcard, port, CIDR', () => {
    const env = (no: string) => ({ HTTPS_PROXY: P, HTTP_PROXY: P, NO_PROXY: no });
    expect(selectProxy('https://hub.corp/', env('hub.corp')).bypass).toBe('no_proxy');
    expect(selectProxy('https://a.hub.corp/', env('hub.corp')).bypass).toBe('no_proxy');
    expect(selectProxy('https://a.hub.corp/', env('.hub.corp')).bypass).toBe('no_proxy');
    expect(selectProxy('https://nothub.corp/', env('hub.corp')).proxy).toBe(P);
    expect(selectProxy('https://x.y/', env('*')).bypass).toBe('no_proxy');
    expect(selectProxy('http://hub.corp:18100/', env('hub.corp:18100')).bypass).toBe('no_proxy');
    expect(selectProxy('https://hub.corp/', env('hub.corp:18100')).proxy).toBe(P);
    expect(selectProxy('http://10.1.2.3:18100/', env('10.0.0.0/8')).bypass).toBe('no_proxy');
    expect(selectProxy('http://11.1.2.3:18100/', env('10.0.0.0/8')).proxy).toBe(P);
    expect(selectProxy('https://hub.corp/', env(' a.b , hub.corp ')).bypass).toBe('no_proxy');
  });

  test('no proxy configured', () => {
    expect(selectProxy('https://a.example/', {})).toEqual({ proxy: null, bypass: 'no_proxy_configured' });
  });
});

describe('redaction', () => {
  test('proxy credentials never survive', () => {
    expect(redactUrl('http://user:s3cret@proxy:3128')).toBe('http://***@proxy:3128');
    expect(redactUrl('http://proxy:3128')).toBe('http://proxy:3128');
    expect(redactText('via http://u:p%40ss@proxy:3128 and https://x:y@other/')).toBe('via http://***@proxy:3128 and https://***@other/');
  });

  test('a NetError through a credentialed proxy names it redacted', async () => {
    // Nothing listens on port 1: connect_refused, naming the proxy without its credentials.
    const err = await request('https://a.invalid/', { env: { HTTPS_PROXY: 'http://u:s3cret@127.0.0.1:1' }, timeoutMs: 9_000, connectTimeoutMs: 8_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(NetError);
    expect(err.kind).toBe('connect_refused');
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain('s3cret');
    expect(err.details.via).toBe('http://***@127.0.0.1:1');
  });
});

describe('classification', () => {
  test('a scripted or runtime fetch error is named by its code or message', () => {
    expect(classifyNetError(new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:9'))?.kind).toBe('connect_refused');
    expect(classifyNetError(Object.assign(new Error('getaddrinfo ENOTFOUND x.invalid'), { code: 'ENOTFOUND' }))?.kind).toBe('dns_failed');
    expect(classifyNetError(new Error('socket hang up'))?.kind).toBe('connection_reset');
    expect(classifyNetError(Object.assign(new Error('x'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }))?.kind).toBe('tls_intercepted');
    expect(classifyNetError(new DOMException('The operation timed out.', 'TimeoutError'))?.kind).toBe('response_timeout');
    expect(classifyNetError(new Error('something else'))).toBeNull();
  });

  test('a one-line report names its cause first', () => {
    expect(causeOfLine('proxy_auth_required(NTLM): the proxy …')).toBe('proxy_auth_required');
    expect(causeOfLine('blocked_by_portal: …')).toBe('blocked_by_portal');
    expect(causeOfLine('HTTP 503')).toBeNull();
    expect(causeOfLine('no_producer(x): …')).toBeNull();
  });
});

describe('OS proxy settings (read, never applied)', () => {
  test('macOS scutil --proxy', () => {
    const pac = parseScutil('<dictionary> {\n  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://wpad.corp/proxy.pac\n  HTTPSEnable : 0\n}');
    expect(pac).toEqual({ source: 'scutil', pacUrl: 'http://wpad.corp/proxy.pac', autoDiscovery: false, proxy: null });
    const manual = parseScutil('<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : proxy.corp\n  HTTPSPort : 8080\n}');
    expect(manual?.proxy).toBe('proxy.corp:8080');
    expect(parseScutil('<dictionary> {\n  HTTPEnable : 0\n}')).toBeNull();
  });

  test('Windows Internet Settings', () => {
    const out = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '    ProxyEnable    REG_DWORD    0x1',
      '    ProxyServer    REG_SZ    http=proxy.corp:80;https=proxy.corp:8443',
      '    AutoConfigURL    REG_SZ    http://wpad.corp/wpad.dat',
    ].join('\r\n');
    expect(parseRegQuery(out)).toEqual({ source: 'registry', pacUrl: 'http://wpad.corp/wpad.dat', autoDiscovery: false, proxy: 'proxy.corp:8443' });
    expect(parseRegQuery('    ProxyEnable    REG_DWORD    0x0\r\n')).toBeNull();
  });

  test('GNOME gsettings', () => {
    expect(parseGsettings("'auto'\n", "'http://wpad.corp/proxy.pac'\n", "''", '0')).toMatchObject({ pacUrl: 'http://wpad.corp/proxy.pac' });
    expect(parseGsettings("'manual'", "''", "'proxy.corp'", '3128')).toMatchObject({ proxy: 'proxy.corp:3128' });
    expect(parseGsettings("'none'", "''", "''", '0')).toBeNull();
  });

  test('the failure note tells the operator to set HTTPS_PROXY', () => {
    expect(describeOsProxy({ source: 'scutil', pacUrl: 'http://wpad.corp/proxy.pac', autoDiscovery: false, proxy: null }))
      .toBe('the OS proxy settings (scutil) use a PAC script (http://wpad.corp/proxy.pac), which this process does not see; set HTTPS_PROXY (and HTTP_PROXY for a plain-http anchor) to the proxy it names');
    expect(describeOsProxy(null)).toBeNull();
  });
});

describe('configuration: the installer’s names', () => {
  test('SUBSTRATE_* fill METABOB_*; when both differ METABOB_* wins, with one warning', () => {
    const env: NodeJS.ProcessEnv = { SUBSTRATE_API_KEY: 'k1', SUBSTRATE_ENDPOINT: 'http://h:18080' };
    expect(applySubstrateEnvAliases(env)).toEqual([]);
    expect(env.METABOB_API_KEY).toBe('k1');
    expect(env.METABOB_ENDPOINT).toBe('http://h:18080');
    const both: NodeJS.ProcessEnv = { SUBSTRATE_API_KEY: 'k1', METABOB_API_KEY: 'k2' };
    expect(applySubstrateEnvAliases(both)).toEqual(['SUBSTRATE_API_KEY and METABOB_API_KEY are both set and differ; using METABOB_API_KEY.']);
    expect(both.METABOB_API_KEY).toBe('k2');
  });

  test('SUBSTRATE_CONFIG_PATH wins over METABOB_CONFIG_PATH, and the lookup order names both homes', () => {
    expect(resolveConfigPath({ SUBSTRATE_CONFIG_PATH: '/a.json', METABOB_CONFIG_PATH: '/b.json' })).toBe('/a.json');
    expect(resolveConfigPath({ METABOB_CONFIG_PATH: '/b.json' })).toBe('/b.json');
    expect(CONFIG_LOOKUP_ORDER).toBe(
      '$SUBSTRATE_CONFIG_PATH, then $METABOB_CONFIG_PATH, then ./.substrate/config.json, then ./.metabob/config.json, then ~/.substrate/config.json, then ~/.metabob/config.json',
    );
  });
});
