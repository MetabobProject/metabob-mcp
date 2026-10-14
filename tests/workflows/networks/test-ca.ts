/**
 * Test certificates, generated at test time with node:crypto and a small DER
 * encoder: a root CA and a leaf it signs. ECDSA P-256 with SHA-256. No
 * dependency and no openssl binary, so it runs the same on Linux and Windows,
 * under Bun and Node.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';

// ── DER ──────────────────────────────────────────────────────────────────────

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, value: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), len(value.length), value]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const octets = (b: Buffer) => tlv(0x04, b);
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n: number, inner: Buffer) => tlv(0xa0 + n, inner);

function integer(b: Buffer): Buffer {
  let v = b;
  while (v.length > 1 && v[0] === 0 && (v[1]! & 0x80) === 0) v = v.subarray(1);
  if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return tlv(0x02, v);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [40 * parts[0]! + parts[1]!];
  for (const p of parts.slice(2)) {
    const stack: number[] = [p & 0x7f];
    let rest = p >>> 7;
    while (rest > 0) {
      stack.unshift((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

const name = (cn: string, o: string) =>
  seq(set(seq(oid('2.5.4.10'), utf8(o))), set(seq(oid('2.5.4.3'), utf8(cn))));

const ext = (id: string, critical: boolean, value: Buffer) =>
  seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function keyId(publicKey: KeyObject): Buffer {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha1').update(spki).digest();
}

// ── Certificates ─────────────────────────────────────────────────────────────

export interface Issued {
  /** PEM certificate. */
  cert: string;
  /** PEM private key (PKCS#8). */
  key: string;
  commonName: string;
  org: string;
  publicKey: KeyObject;
  privateKey: KeyObject;
}

function toPem(der: Buffer, label: string): string {
  const b64 = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function issue(opts: {
  commonName: string;
  org: string;
  ca: boolean;
  sans?: string[];
  issuer?: Issued;
}): Issued {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const issuerKey = opts.issuer?.privateKey ?? privateKey;
  const issuerName = opts.issuer ? name(opts.issuer.commonName, opts.issuer.org) : name(opts.commonName, opts.org);
  const now = Date.now();
  const extensions: Buffer[] = [
    ext('2.5.29.19', true, opts.ca ? seq(bool(true)) : seq()),
    // keyUsage: CA → keyCertSign|cRLSign; leaf → digitalSignature
    ext('2.5.29.15', true, opts.ca ? bits(Buffer.from([0x06]), 1) : bits(Buffer.from([0x80]), 7)),
    ext('2.5.29.14', false, octets(keyId(publicKey))),
    ext('2.5.29.35', false, seq(tlv(0x80, keyId(opts.issuer?.publicKey ?? publicKey)))),
  ];
  if (!opts.ca) {
    extensions.push(ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))));
    const sans = (opts.sans ?? []).map((s) => {
      if (isIP(s) === 4) return tlv(0x87, Buffer.from(s.split('.').map(Number)));
      return tlv(0x82, Buffer.from(s, 'ascii'));
    });
    extensions.push(ext('2.5.29.17', false, seq(...sans)));
  }
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(randomBytes(12)),
    ECDSA_SHA256,
    issuerName,
    seq(utcTime(new Date(now - 3600_000)), utcTime(new Date(now + 7 * 86400_000))),
    name(opts.commonName, opts.org),
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...extensions)),
  );
  const signature = sign('sha256', tbs, issuerKey);
  const der = seq(tbs, ECDSA_SHA256, bits(signature));
  return {
    cert: toPem(der, 'CERTIFICATE'),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    commonName: opts.commonName,
    org: opts.org,
    publicKey,
    privateKey,
  };
}

export function makeCa(commonName: string, org = 'metabob-mcp tests'): Issued {
  return issue({ commonName, org, ca: true });
}

export function makeLeaf(ca: Issued, hosts: string[], org = 'metabob-mcp tests'): Issued {
  return issue({ commonName: hosts[0]!, org, ca: false, sans: hosts, issuer: ca });
}
