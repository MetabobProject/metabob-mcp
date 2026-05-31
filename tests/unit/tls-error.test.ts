import { describe, expect, test } from 'bun:test';
import { MetabobTlsError, translateTlsError, withTlsErrorTranslation } from '../../src/tls-error';

function makeTlsError(code: string, cert?: {
  subject?: Record<string, string>;
  issuer?: Record<string, string>;
}): Error & { code: string; cert?: unknown } {
  const err = new Error(`TLS error: ${code}`) as Error & { code: string; cert?: unknown };
  err.code = code;
  if (cert) err.cert = cert;
  return err;
}

describe('translateTlsError', () => {
  test('returns null for non-TLS errors', () => {
    expect(translateTlsError(new Error('whatever'))).toBeNull();
    expect(translateTlsError(null)).toBeNull();
    expect(translateTlsError(undefined)).toBeNull();
    expect(translateTlsError('string-error')).toBeNull();
  });

  test('translates UNABLE_TO_GET_ISSUER_CERT_LOCALLY into structured error', () => {
    const original = makeTlsError('UNABLE_TO_GET_ISSUER_CERT_LOCALLY', {
      subject: { CN: 'activity.metabob.com' },
      issuer: { CN: 'Zscaler Root CA', O: 'Zscaler Inc.' },
    });
    const translated = translateTlsError(original, { url: 'https://activity.metabob.com/health' });
    expect(translated).not.toBeNull();
    expect(translated!.code).toBe('TLS_INTERCEPTED');
    expect(translated!.originalCode).toBe('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    expect(translated!.host).toBe('activity.metabob.com');
    expect(translated!.interceptingIssuer?.CN).toBe('Zscaler Root CA');
    expect(translated!.hint).toContain('Zscaler');
    expect(translated!.hint).toContain('--no-system-ca');
    expect(translated!.hint).toContain('*.metabob.com');
    expect(translated!.cause).toBe(original);
  });

  test('translates SELF_SIGNED_CERT_IN_CHAIN', () => {
    const original = makeTlsError('SELF_SIGNED_CERT_IN_CHAIN');
    const translated = translateTlsError(original);
    expect(translated).not.toBeNull();
    expect(translated!.code).toBe('TLS_INTERCEPTED');
    expect(translated!.originalCode).toBe('SELF_SIGNED_CERT_IN_CHAIN');
  });

  test('walks .cause chain (Node fetch wraps TLS errors)', () => {
    const inner = makeTlsError('CERT_HAS_EXPIRED', {
      issuer: { CN: 'Corporate MITM CA' },
    });
    const outer = new Error('fetch failed');
    (outer as Error & { cause?: unknown }).cause = inner;

    const translated = translateTlsError(outer, { host: 'identity.metabob.com' });
    expect(translated).not.toBeNull();
    expect(translated!.originalCode).toBe('CERT_HAS_EXPIRED');
    expect(translated!.host).toBe('identity.metabob.com');
    expect(translated!.interceptingIssuer?.CN).toBe('Corporate MITM CA');
  });

  test('toMcpDetails returns structured object', () => {
    const original = makeTlsError('UNABLE_TO_VERIFY_LEAF_SIGNATURE', {
      issuer: { CN: 'Netskope CA' },
    });
    const translated = translateTlsError(original, { url: 'https://activity.metabob.com' })!;
    const details = translated.toMcpDetails();
    expect(details.code).toBe('TLS_INTERCEPTED');
    expect(details.original_code).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(details.host).toBe('activity.metabob.com');
    expect((details.intercepting_issuer as { CN: string }).CN).toBe('Netskope CA');
  });
});

describe('withTlsErrorTranslation', () => {
  test('passes through successful results', async () => {
    const result = await withTlsErrorTranslation(async () => 42);
    expect(result).toBe(42);
  });

  test('passes through non-TLS errors unchanged', async () => {
    const err = new Error('boom');
    await expect(withTlsErrorTranslation(async () => { throw err; })).rejects.toBe(err);
  });

  test('translates TLS errors into MetabobTlsError', async () => {
    const tls = makeTlsError('DEPTH_ZERO_SELF_SIGNED_CERT', { issuer: { CN: 'X' } });
    let caught: unknown;
    try {
      await withTlsErrorTranslation(async () => { throw tls; }, { host: 'h' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MetabobTlsError);
    expect((caught as MetabobTlsError).originalCode).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
  });
});
