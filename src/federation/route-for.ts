/**
 * route-for — the single shared prefer-p2p-then-HTTP egress ladder.
 *
 * One helper, not per-call-site copy-paste (the historical federation failure
 * mode). Given a discovered capability + pointer, resolve over the best
 * available transport:
 *
 *   1. libp2p lpStream  (if we have an overlay node AND the peer advertised a
 *      libp2p multiaddr)      — bounded 10s
 *   2. libp2p HTTP-over-stream (same peer)   — bounded 8s
 *   3. plain HTTP fallback  (always available; the compliant corp-proxy path)
 *
 * Every overlay leg is time-bounded so a dead peer can't hang the caller; any
 * overlay failure falls through to the next leg and ultimately to HTTP.
 */

import type { FederationNode } from './libp2p-node.js';

/** The overlay-addressing subset of a discovery capability row. */
export interface OverlayTarget {
  protocol?: string;
  libp2p_peer_id?: string;
  libp2p_multiaddr?: string[];
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** The overlay dial target: prefer the circuit multiaddr, else the peerId. */
export function overlayTargetOf(capability: OverlayTarget): string | undefined {
  if (capability.protocol !== 'libp2p') return undefined;
  const ma = capability.libp2p_multiaddr?.find((m) => typeof m === 'string' && m.length > 0);
  return ma ?? (capability.libp2p_peer_id || undefined);
}

export interface ResolveViaBestTransportOptions {
  capability: OverlayTarget;
  pointer: unknown;
  /** The local overlay node, or null when we have no libp2p transport. */
  node: FederationNode | null;
  /** Always-available HTTP resolve; the final, compliant fallback. */
  httpFallback: () => Promise<unknown>;
  libp2pTimeoutMs?: number;
  libp2pHttpTimeoutMs?: number;
}

/**
 * Resolve a pointer against a discovered capability, preferring the overlay
 * when both sides support it and falling back to HTTP otherwise. The HTTP
 * fallback runs whenever there is no node, no overlay target, or every overlay
 * leg fails — so a caller with no libp2p at all behaves exactly as before.
 */
export async function resolveViaBestTransport(
  opts: ResolveViaBestTransportOptions,
): Promise<unknown> {
  const target = opts.node ? overlayTargetOf(opts.capability) : undefined;

  if (opts.node && target) {
    try {
      return await withTimeout(
        opts.node.resolveViaLibp2p(target, opts.pointer),
        opts.libp2pTimeoutMs ?? 10_000,
        'overlay resolve',
      );
    } catch {
      try {
        return await withTimeout(
          opts.node.resolveViaHttp(target, opts.pointer),
          opts.libp2pHttpTimeoutMs ?? 8_000,
          'overlay http resolve',
        );
      } catch {
        // fall through to plain HTTP
      }
    }
  }

  return opts.httpFallback();
}
