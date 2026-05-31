/**
 * Diagnostic TLS error translator (mitigation #2).
 *
 * Wraps raw Node TLS errors with a structured error that explains the
 * likely cause (corporate proxy / Zscaler / MITM CA) and identifies the
 * intercepting CA when one is present on `err.cert`.
 *
 * The original error is preserved as `.cause` so debuggers can still see
 * the raw `code` / `stack`.
 */

const TLS_CHAIN_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_UNTRUSTED',
  'CERT_CHAIN_TOO_LONG',
]);

export interface TlsErrorContext {
  url?: string;
  host?: string;
}

export interface TlsCertSubject {
  CN?: string;
  O?: string;
  OU?: string;
  [k: string]: string | undefined;
}

interface NodeTlsError extends Error {
  code?: string;
  cert?: {
    subject?: TlsCertSubject;
    issuer?: TlsCertSubject;
    fingerprint256?: string;
    valid_from?: string;
    valid_to?: string;
  };
}

export class MetabobTlsError extends Error {
  readonly code: string;
  readonly originalCode: string;
  readonly interceptingCA?: TlsCertSubject;
  readonly interceptingIssuer?: TlsCertSubject;
  readonly host?: string;
  readonly hint: string;

  constructor(message: string, opts: {
    code: string;
    originalCode: string;
    cause: unknown;
    host?: string;
    interceptingCA?: TlsCertSubject;
    interceptingIssuer?: TlsCertSubject;
    hint: string;
  }) {
    super(message, { cause: opts.cause });
    this.name = 'MetabobTlsError';
    this.code = opts.code;
    this.originalCode = opts.originalCode;
    this.host = opts.host;
    this.interceptingCA = opts.interceptingCA;
    this.interceptingIssuer = opts.interceptingIssuer;
    this.hint = opts.hint;
  }

  /** Structured form suitable for MCP error responses. */
  toMcpDetails(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      original_code: this.originalCode,
      host: this.host,
      intercepting_ca: this.interceptingCA,
      intercepting_issuer: this.interceptingIssuer,
      hint: this.hint,
    };
  }
}

function isTlsChainError(err: unknown): err is NodeTlsError {
  if (!err || typeof err !== 'object') return false;
  const e = err as NodeTlsError;
  if (e.code && TLS_CHAIN_CODES.has(e.code)) return true;
  // Walk .cause chain — node's fetch wraps the underlying TLS error.
  const cause = (e as { cause?: unknown }).cause;
  if (cause && cause !== err) return isTlsChainError(cause);
  return false;
}

function findTlsError(err: unknown): NodeTlsError | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as NodeTlsError;
  if (e.code && TLS_CHAIN_CODES.has(e.code)) return e;
  const cause = (e as { cause?: unknown }).cause;
  if (cause && cause !== err) return findTlsError(cause);
  return null;
}

function describeSubject(subject?: TlsCertSubject): string {
  if (!subject) return 'unknown';
  const parts: string[] = [];
  if (subject.CN) parts.push(`CN=${subject.CN}`);
  if (subject.O) parts.push(`O=${subject.O}`);
  if (subject.OU) parts.push(`OU=${subject.OU}`);
  return parts.length > 0 ? parts.join(', ') : 'unknown';
}

function buildHint(intercepting: TlsCertSubject | undefined, host: string | undefined): string {
  const who = describeSubject(intercepting);
  const hostHint = host ? ` (${host})` : '';
  return (
    `TLS handshake${hostHint} was intercepted by ${who}. ` +
    `metabob-mcp already tries to load OS trust roots at startup ` +
    `(disable with --no-system-ca); if you are still seeing this, the ` +
    `intercepting CA is not in your OS trust store. ` +
    `Fix options: (1) ask IT to add the Metabob hosts ` +
    `(*.metabob.com) to your proxy's SSL inspection bypass list, ` +
    `(2) install the corporate root CA into your OS trust store, or ` +
    `(3) set NODE_EXTRA_CA_CERTS=/path/to/corp-root.pem.`
  );
}

/**
 * If `err` is (or wraps) a TLS chain error, return a structured
 * MetabobTlsError. Otherwise return null and the caller should rethrow.
 */
export function translateTlsError(err: unknown, ctx: TlsErrorContext = {}): MetabobTlsError | null {
  if (!isTlsChainError(err)) return null;
  const tlsErr = findTlsError(err);
  if (!tlsErr) return null;

  const subject = tlsErr.cert?.subject;
  const issuer = tlsErr.cert?.issuer;
  const host = ctx.host ?? (ctx.url ? safeHostFromUrl(ctx.url) : undefined);
  const hint = buildHint(issuer ?? subject, host);

  const msg =
    `TLS handshake failed (${tlsErr.code}): cert chain rejected. ` +
    `Likely cause: corporate SSL inspection (Zscaler / Netskope / Cisco Umbrella / Forcepoint). ${hint}`;

  return new MetabobTlsError(msg, {
    code: 'TLS_INTERCEPTED',
    originalCode: tlsErr.code ?? 'UNKNOWN_TLS_ERROR',
    cause: err,
    host,
    interceptingCA: subject,
    interceptingIssuer: issuer,
    hint,
  });
}

function safeHostFromUrl(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Wrap an async function so any TLS-chain error it throws is re-thrown as
 * a MetabobTlsError. Other errors pass through untouched.
 */
export async function withTlsErrorTranslation<T>(
  fn: () => Promise<T>,
  ctx: TlsErrorContext = {},
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const translated = translateTlsError(err, ctx);
    if (translated) throw translated;
    throw err;
  }
}
