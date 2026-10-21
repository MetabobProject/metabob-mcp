/**
 * `metabob-mcp attach --check` — the first troubleshooting step (SPEC §attach-check).
 * Runs the attachment once, as the server runs it — the same config lookup,
 * the same request path (src/net.ts), the same sequence (src/attachment.ts) —
 * then one read through discovery `POST /resolve`, and prints each hop: proxy,
 * TLS, /bootstrap, identity and its source, the org check, the resolve, and the
 * named cause on failure. Exit 0 when attached, 1 otherwise. Makes no writes:
 * the one resolve is `vesselRegistry`, which discovery answers itself, and it
 * leaves no file behind. CONFORMANCE §c9-fail-visibly
 *
 * Node-safe: it runs under whichever runtime launched it (SPEC §runtime).
 */

import { existsSync } from 'node:fs';
import { attach, RESOLVE_TIMEOUT_MS, describeResolveFailure, type AttachmentState } from './attachment.js';
import { applyConfiguration, derivedDiscoveryWarning, discoveryEndpointSource, unattachedMessage } from './config.js';
import { redactText } from './net.js';

export interface AttachCheckReport {
  attached: boolean;
  runtime: string;
  config: { path: string; found: boolean };
  /** One line per hop, in order. */
  hops: Array<{ hop: string; ok: boolean | null; detail: string }>;
  /** The named cause of a failure, or null. */
  cause: string | null;
  message: string | null;
  state: AttachmentState | null;
  warnings: string[];
}

const BYPASS_REASONS: Record<string, string> = {
  loopback: 'loopback always bypasses the proxy',
  no_proxy: 'NO_PROXY matches the anchor',
  no_proxy_configured: 'no proxy configured',
  http_proxy_unset: 'a plain-http anchor uses HTTP_PROXY, which is unset; HTTPS_PROXY applies to https anchors only',
};

function runtimeName(): string {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return bun ? `bun ${bun}` : `node ${process.versions.node}`;
}

function redactKey(key: string): string {
  return key.length <= 8 ? '****' : `…${key.slice(-4)}`;
}

/** Run the check against `env` (default: a copy of process.env); never throws for a network failure. */
export async function attachCheck(baseEnv: NodeJS.ProcessEnv = process.env): Promise<AttachCheckReport> {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const { configPath, warnings } = applyConfiguration(env);
  const derived = derivedDiscoveryWarning(env);
  if (derived) warnings.push(derived);
  const report: AttachCheckReport = {
    attached: false,
    runtime: runtimeName(),
    config: { path: configPath, found: existsSync(configPath) },
    hops: [],
    cause: null,
    message: null,
    state: null,
    warnings,
  };
  const key = env.METABOB_API_KEY?.trim();
  report.hops.push({
    hop: 'config',
    ok: null,
    detail: `${report.config.found ? configPath : `${configPath} (not found)`}; key ${key ? redactKey(key) : 'missing'}; anchor ${env.DISCOVERY_ENDPOINT ?? 'missing'} (${discoveryEndpointSource(env)})`,
  });

  const missing = unattachedMessage(env);
  if (missing) {
    report.cause = 'not_configured';
    report.message = missing;
    report.hops.push({ hop: 'result', ok: false, detail: missing });
    return report;
  }

  const logs: string[] = [];
  const attachment = attach({
    discovery: env.DISCOVERY_ENDPOINT,
    discoverySource: discoveryEndpointSource(env),
    key,
    identityOverride: env.IDENTITY_ENDPOINT,
    heartbeatMs: 0,
    env,
    log: (level, message) => {
      if (level === 'warn') logs.push(message);
    },
  });
  const state = await attachment.settled();
  report.state = state;
  const net = state.network;

  const proxyEnv = net.proxy.httpsProxy || net.proxy.httpProxy
    ? `HTTPS_PROXY=${net.proxy.httpsProxy ?? '-'} HTTP_PROXY=${net.proxy.httpProxy ?? '-'} NO_PROXY in force=${net.proxy.effectiveNoProxy.join(',')}`
    : 'no HTTP(S)_PROXY set';
  const route = net.anchorRoute;
  report.hops.push({
    hop: 'proxy',
    ok: null,
    detail: `${route?.via ? `through ${route.via}` : `direct (${BYPASS_REASONS[route?.bypass ?? ''] ?? 'no proxy configured'})`}; ${proxyEnv}`,
  });

  let anchorHttps = false;
  try {
    anchorHttps = new URL(state.anchor.discovery ?? '').protocol === 'https:';
  } catch {
    // reported by the bootstrap hop
  }
  if (!anchorHttps) {
    report.hops.push({ hop: 'tls', ok: null, detail: 'plain http anchor: no TLS (the key travels in clear; CONFORMANCE §c3-identity accepted risk)' });
  } else if (net.tls) {
    report.hops.push({
      hop: 'tls',
      ok: net.tls.authorized,
      detail: net.tls.authorized
        ? `verified; chain issued by ${net.tls.issuer ?? 'unknown'}`
        : `intercepted: the chain is signed by ${net.tls.issuer ?? 'an unknown issuer'}, which is not trusted`,
    });
  } else {
    report.hops.push({ hop: 'tls', ok: null, detail: 'no handshake completed' });
  }

  const b = state.bootstrap;
  report.hops.push({
    hop: 'bootstrap',
    ok: b.status === 'ok',
    detail: b.status === 'ok'
      ? `GET ${state.anchor.discovery}/bootstrap ok; identity_endpoint ${b.identityEndpoint ?? 'none'}`
      : `GET ${state.anchor.discovery}/bootstrap ${b.status}${b.detail ? ` — ${b.detail}` : ''}`,
  });
  report.hops.push({
    hop: 'identity',
    ok: state.identity.endpoint !== null && state.auth.status !== 'identity_unreachable',
    detail: `${state.identity.endpoint ?? 'none'} (${state.identity.source}); advertised ${state.identity.advertised ?? 'none'}; tried [${state.identity.tried.join(', ')}]`,
  });
  report.hops.push({
    hop: 'org check',
    ok: state.auth.status === 'authenticated',
    detail: state.auth.status === 'authenticated'
      ? `authenticated, orgId=${state.auth.orgId}${state.auth.accountId ? `, account ${state.auth.accountId}` : ''}; scopes ${state.auth.scopes ? state.auth.scopes.join(', ') || 'none' : 'unknown (identity reported none, as the flat org check through a proxy does), so writes are not gated by scope'}`
      : `${state.auth.status}${state.auth.detail ? ` — ${state.auth.detail}` : ''}`,
  });

  if (state.cause) {
    report.cause = net.cause ?? state.cause;
    report.message = state.message;
    report.hops.push({ hop: 'resolve', ok: null, detail: 'skipped: not attached' });
  } else {
    try {
      const res = await attachment.resolve({ type: 'vesselRegistry' }, { timeoutMs: RESOLVE_TIMEOUT_MS.discovery, read: true });
      const vessels = (res.body as { content?: { vessels?: unknown[]; totalCount?: number } })?.content;
      const ok = res.status >= 200 && res.status < 300;
      report.hops.push({
        hop: 'resolve',
        ok,
        detail: `vesselRegistry through POST ${state.anchor.discovery}/resolve: HTTP ${res.status}${Array.isArray(vessels?.vessels) ? `, ${vessels!.vessels!.length} vessels` : ''}, ${res.elapsedMs}ms`,
      });
      report.attached = ok;
      if (!ok) {
        report.cause = `resolve_http_${res.status}`;
        report.message = `vesselRegistry answered HTTP ${res.status}`;
      }
    } catch (err) {
      const line = describeResolveFailure(err);
      report.hops.push({ hop: 'resolve', ok: false, detail: `vesselRegistry — ${line}` });
      const lastDiscovery = attachment.state().network.lastByFamily.discovery;
      report.cause = lastDiscovery?.cause ?? 'resolve_failed';
      report.message = line;
    }
    report.state = attachment.state();
  }
  attachment.stop();

  report.hops.push({
    hop: 'result',
    ok: report.attached,
    detail: report.attached ? `attached (orgId=${state.auth.orgId})` : `not attached — ${report.message ?? report.cause ?? 'unknown'}`,
  });
  // The attachment's own refusal WARN repeats the result line; the rest (H1 notes) are kept.
  for (const l of logs) if (!warnings.includes(l) && !(state.message && l.startsWith(state.message))) warnings.push(l);
  return report;
}

export function renderAttachCheck(r: AttachCheckReport): string {
  const mark = (ok: boolean | null) => (ok === null ? '  ' : ok ? 'ok' : '!!');
  const width = Math.max(...r.hops.map((h) => h.hop.length));
  const lines = [`metabob-mcp attach --check  (runtime: ${r.runtime}; the MCP server itself runs under bun)`];
  for (const h of r.hops) lines.push(`  ${mark(h.ok)} ${h.hop.padEnd(width)}  ${h.detail}`);
  for (const w of r.warnings) lines.push(`  warn: ${w}`);
  return redactText(lines.join('\n'));
}

/** CLI entry: `attach --check [--json]`. Returns the exit code. */
export async function runAttachCheck(args: string[]): Promise<number> {
  if (!args.includes('--check')) {
    console.error('usage: metabob-mcp attach --check [--json]');
    return 2;
  }
  const report = await attachCheck();
  if (args.includes('--json')) {
    process.stdout.write(redactText(JSON.stringify(report, null, 2)) + '\n');
  } else {
    process.stdout.write(renderAttachCheck(report) + '\n');
  }
  return report.attached ? 0 : 1;
}
