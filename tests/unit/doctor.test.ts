import { describe, expect, test } from 'bun:test';
import {
  matchMitmVendor,
  synthesizeDiagnosis,
  renderReport,
  type DoctorReport,
  type DnsProbeResult,
  type TlsHandshakeResult,
  type HttpsProbeResult,
  type TrustStoreSnapshot,
} from '../../src/doctor';

describe('matchMitmVendor', () => {
  test('identifies Zscaler', () => {
    expect(matchMitmVendor('CN=Zscaler Intermediate Root CA')?.vendor).toBe('Zscaler');
  });
  test('identifies Netskope', () => {
    expect(matchMitmVendor('CN=Netskope Certificate Authority')?.vendor).toBe('Netskope');
  });
  test('identifies Palo Alto', () => {
    expect(matchMitmVendor('CN=Palo Alto Networks Prisma Access Root')?.vendor).toBe('Palo Alto Networks');
  });
  test('ignores ordinary issuers', () => {
    expect(matchMitmVendor('CN=ISRG Root X1, O=Internet Security Research Group')).toBeNull();
    expect(matchMitmVendor('CN=DigiCert Global Root G2')).toBeNull();
  });
});

function dnsOk(host: string): DnsProbeResult {
  return { host, addresses: ['1.2.3.4'], durationMs: 5 };
}
function tlsOk(host: string): TlsHandshakeResult {
  return {
    host,
    port: 443,
    durationMs: 10,
    protocol: 'TLSv1.3',
    alpn: 'h2',
    chain: [
      { subject: 'CN=' + host, issuer: 'CN=R3', validFrom: '', validTo: '', fingerprint256: 'AA' },
      { subject: 'CN=R3', issuer: 'CN=ISRG Root X1', validFrom: '', validTo: '', fingerprint256: 'BB' },
      { subject: 'CN=ISRG Root X1', issuer: 'CN=ISRG Root X1', validFrom: '', validTo: '', fingerprint256: 'CC' },
    ],
    rootInMozillaBundle: true,
    rootInOsTrustStore: true,
    rootIssuer: 'CN=ISRG Root X1',
    mitmSuspected: false,
    viaProxy: false,
  };
}
function tlsMitm(host: string, vendor: string): TlsHandshakeResult {
  return {
    host,
    port: 443,
    durationMs: 10,
    protocol: 'TLSv1.2',
    alpn: 'http/1.1',
    chain: [
      { subject: 'CN=' + host, issuer: `CN=${vendor} Intermediate`, validFrom: '', validTo: '', fingerprint256: 'AA' },
      { subject: `CN=${vendor} Intermediate`, issuer: `CN=${vendor} Root`, validFrom: '', validTo: '', fingerprint256: 'BB' },
    ],
    rootInMozillaBundle: false,
    rootInOsTrustStore: true,
    rootIssuer: `CN=${vendor} Root`,
    mitmSuspected: true,
    mitmVendor: vendor,
    viaProxy: false,
  };
}
const emptyTrust: TrustStoreSnapshot = {
  systemCertCount: 0,
  bundledCertCount: 100,
  mitmCaMatches: [],
};

describe('synthesizeDiagnosis', () => {
  test('clean network → ok', () => {
    const d = synthesizeDiagnosis({
      dns: {
        'activity.metabob.com': dnsOk('activity.metabob.com'),
        'identity.metabob.com': dnsOk('identity.metabob.com'),
      },
      tlsHandshakes: {
        'activity.metabob.com': tlsOk('activity.metabob.com'),
        'identity.metabob.com': tlsOk('identity.metabob.com'),
      },
      httpsProbes: {},
      trustStore: emptyTrust,
    });
    expect(d.status).toBe('ok');
    expect(d.suggestedActions).toEqual([]);
  });

  test('MITM but mitigation works → mitm-handled', () => {
    const probe: HttpsProbeResult = {
      url: 'https://activity.metabob.com/health',
      durationMs: 50,
      statusDefault: null,
      errorDefault: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      statusOsTrust: 200,
      mitmConfirmed: true,
      viaProxy: false,
    };
    const d = synthesizeDiagnosis({
      dns: { 'activity.metabob.com': dnsOk('activity.metabob.com') },
      tlsHandshakes: { 'activity.metabob.com': tlsMitm('activity.metabob.com', 'Zscaler') },
      httpsProbes: { 'activity.metabob.com': probe },
      trustStore: emptyTrust,
    });
    expect(d.status).toBe('mitm-handled');
    expect(d.summary).toContain('Zscaler');
  });

  test('MITM and mitigation fails → mitm-failed', () => {
    const probe: HttpsProbeResult = {
      url: 'https://activity.metabob.com/health',
      durationMs: 50,
      statusDefault: null,
      errorDefault: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      statusOsTrust: null,
      errorOsTrust: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      mitmConfirmed: false,
      viaProxy: false,
    };
    const d = synthesizeDiagnosis({
      dns: { 'activity.metabob.com': dnsOk('activity.metabob.com') },
      tlsHandshakes: { 'activity.metabob.com': tlsMitm('activity.metabob.com', 'Netskope') },
      httpsProbes: { 'activity.metabob.com': probe },
      trustStore: emptyTrust,
    });
    expect(d.status).toBe('mitm-failed');
    expect(d.suggestedActions.length).toBeGreaterThan(0);
    expect(d.suggestedActions.join(' ')).toContain('NODE_EXTRA_CA_CERTS');
  });

  test('user scenario: HTTPS via proxy ok, raw TLS direct fail, 5xx on activity → degraded, not unreachable', () => {
    // Replicates the corporate-proxy report in the bug brief:
    // - DNS ok, HTTPS probes succeed via proxy (activity returns 503),
    //   raw TLS direct connections fail because direct egress is blocked.
    const dead: TlsHandshakeResult = {
      host: 'activity.metabob.com',
      port: 443,
      durationMs: 38,
      protocol: null,
      alpn: null,
      chain: [],
      rootInMozillaBundle: false,
      rootInOsTrustStore: false,
      rootIssuer: null,
      mitmSuspected: false,
      viaProxy: false, // bypassed proxy (the old bug)
      error: 'Client network socket disconnected before secure TLS connection was established',
    };
    const httpsActivity: HttpsProbeResult = {
      url: 'https://activity.metabob.com/health',
      durationMs: 200,
      statusDefault: 503,
      statusOsTrust: 503,
      mitmConfirmed: false,
      viaProxy: true,
      proxyUrl: 'http://proxygate20.nic.nec.co.jp:8080',
    };
    const httpsIdentity: HttpsProbeResult = {
      url: 'https://identity.metabob.com/health',
      durationMs: 200,
      statusDefault: 200,
      statusOsTrust: 200,
      mitmConfirmed: false,
      viaProxy: true,
      proxyUrl: 'http://proxygate20.nic.nec.co.jp:8080',
    };
    const d = synthesizeDiagnosis({
      dns: {
        'activity.metabob.com': dnsOk('activity.metabob.com'),
        'identity.metabob.com': dnsOk('identity.metabob.com'),
      },
      tlsHandshakes: {
        'activity.metabob.com': dead,
        'identity.metabob.com': { ...dead, host: 'identity.metabob.com' },
      },
      httpsProbes: {
        'activity.metabob.com': httpsActivity,
        'identity.metabob.com': httpsIdentity,
      },
      trustStore: emptyTrust,
      proxy: {
        httpProxy: 'http://proxygate20.nic.nec.co.jp:8080',
        httpsProxy: 'http://proxygate20.nic.nec.co.jp:8080',
        noProxy: null,
        npmProxy: null,
        npmHttpsProxy: null,
        effectiveProxyForMetabob: 'http://proxygate20.nic.nec.co.jp:8080',
        proxyScheme: 'http',
        noProxyExcludesMetabob: [],
        nodeExtraCaCerts: null,
      },
    });
    // Must NOT say unreachable / DNS failure.
    expect(d.status).not.toBe('unreachable');
    expect(d.summary).not.toMatch(/DNS/i);
    // Must surface the 5xx as a service-side issue.
    expect(d.observations.some((o) => o.code === 'service-5xx')).toBe(true);
    // Must explain the raw-TLS-direct-failure as expected proxy behavior.
    expect(d.observations.some((o) => o.code === 'tls-direct-blocked')).toBe(true);
  });

  test('proxy set but unreachable (HTTP_PROXY=http://127.0.0.1:1) → proxy-unreachable', () => {
    const dead: HttpsProbeResult = {
      url: 'https://activity.metabob.com/health',
      durationMs: 50,
      statusDefault: null,
      errorDefault: 'ECONNREFUSED',
      statusOsTrust: null,
      errorOsTrust: 'ECONNREFUSED',
      mitmConfirmed: false,
      viaProxy: true,
      proxyUrl: 'http://127.0.0.1:1',
    };
    const d = synthesizeDiagnosis({
      dns: { 'activity.metabob.com': dnsOk('activity.metabob.com') },
      tlsHandshakes: {
        'activity.metabob.com': {
          host: 'activity.metabob.com',
          port: 443,
          durationMs: 5,
          protocol: null,
          alpn: null,
          chain: [],
          rootInMozillaBundle: false,
          rootInOsTrustStore: false,
          rootIssuer: null,
          mitmSuspected: false,
          viaProxy: true,
          proxyUrl: 'http://127.0.0.1:1',
          error: 'ECONNREFUSED',
        },
      },
      httpsProbes: { 'activity.metabob.com': dead },
      trustStore: emptyTrust,
      proxy: {
        httpProxy: 'http://127.0.0.1:1',
        httpsProxy: 'http://127.0.0.1:1',
        noProxy: null,
        npmProxy: null,
        npmHttpsProxy: null,
        effectiveProxyForMetabob: 'http://127.0.0.1:1',
        proxyScheme: 'http',
        noProxyExcludesMetabob: [],
        nodeExtraCaCerts: null,
      },
    });
    expect(d.observations.some((o) => o.code === 'proxy-unreachable')).toBe(true);
    expect(d.summary).toMatch(/127\.0\.0\.1:1/);
  });

  test('OS trust store skipped (missing optional native module) is info, not error', () => {
    const d = synthesizeDiagnosis({
      dns: { 'activity.metabob.com': dnsOk('activity.metabob.com') },
      tlsHandshakes: { 'activity.metabob.com': tlsOk('activity.metabob.com') },
      httpsProbes: {},
      trustStore: {
        systemCertCount: 0,
        bundledCertCount: 100,
        systemCertSkipped: true,
        systemCertSkipReason: 'Cannot require module win-export-certificate-and-key',
        mitmCaMatches: [],
      },
    });
    expect(d.status).toBe('ok');
    const skip = d.observations.find((o) => o.code === 'os-trust-skipped');
    expect(skip?.severity).toBe('info');
  });

  test('all metabob hosts unreachable → unreachable', () => {
    const dead: TlsHandshakeResult = {
      host: 'activity.metabob.com',
      port: 443,
      durationMs: 5000,
      protocol: null,
      alpn: null,
      chain: [],
      rootInMozillaBundle: false,
      rootInOsTrustStore: false,
      rootIssuer: null,
      mitmSuspected: false,
      error: 'ECONNREFUSED',
    };
    const d = synthesizeDiagnosis({
      dns: {
        'activity.metabob.com': { host: 'activity.metabob.com', addresses: [], durationMs: 5000, error: 'ENOTFOUND' },
      },
      tlsHandshakes: { 'activity.metabob.com': dead },
      httpsProbes: {},
      trustStore: emptyTrust,
    });
    expect(d.status).toBe('unreachable');
  });
});

describe('artifact filename (cross-platform safety)', () => {
  test('default artifact filename contains only Windows-safe chars', () => {
    // Mirrors the pattern in runDoctor: metabob-mcp-doctor-<unix-ts>.json
    const name = `metabob-mcp-doctor-${Math.floor(Date.now() / 1000)}.json`;
    // Windows forbids: < > : " / \ | ? *
    expect(name).not.toMatch(/[<>:"/\\|?*]/);
    expect(name).toMatch(/^metabob-mcp-doctor-\d+\.json$/);
  });
});

describe('renderReport', () => {
  test('emits section headers, no crashes on minimal report', () => {
    const r: DoctorReport = {
      schema: 'metabob-mcp-doctor/v1',
      generatedAt: '2026-05-31T00:00:00.000Z',
      durationMs: 100,
      metabobMcpVersion: '0.2.12',
      environment: {
        nodeVersion: 'v20.0.0',
        bunVersion: null,
        platform: 'linux',
        arch: 'x64',
        osRelease: '6.0.0',
        cwd: '/tmp',
        envVars: {},
      },
      proxy: {
        httpProxy: null,
        httpsProxy: null,
        noProxy: null,
        npmProxy: null,
        npmHttpsProxy: null,
      },
      dns: { 'activity.metabob.com': dnsOk('activity.metabob.com') },
      trustStore: emptyTrust,
      tlsHandshakes: { 'activity.metabob.com': tlsOk('activity.metabob.com') },
      httpsProbes: {},
      webSocketProbes: {},
      config: {
        configPath: '/tmp/config.json',
        configExists: false,
        apiKeyConfigured: false,
        knownHostsPath: '/tmp/known-hosts.json',
        knownHosts: {},
      },
      diagnosis: {
        status: 'ok',
        summary: 'No interception detected.',
        suggestedActions: [],
      },
    };
    // Force no color for stable assertions.
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      const out = renderReport(r);
      expect(out).toContain('Environment');
      expect(out).toContain('Proxy');
      expect(out).toContain('DNS');
      expect(out).toContain('TLS handshakes');
      expect(out).toContain('Diagnosis');
      expect(out).toContain('No interception detected');
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });
});
