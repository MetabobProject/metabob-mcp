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
