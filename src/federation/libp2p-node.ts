/**
 * Optional libp2p federation node.
 *
 * Makes this vessel reachable over a circuit-relay overlay (so peers behind NAT
 * or a corporate proxy can resolve our shapes without us being HTTP-dialable).
 * It is strictly ADDITIVE and OPTIONAL:
 *
 *   - Started only in FEDERATED mode (a relay multiaddr was discovered via
 *     /bootstrap). LOCAL mode never touches libp2p.
 *   - The transport package (`@avigopal/libp2p-federation-transport`) is a
 *     heavy, github-only OPTIONAL dependency, dynamically imported here. If it
 *     is absent (not installed, or a corp environment that couldn't fetch it),
 *     start returns null and the vessel stays HTTP-only — the compliant
 *     fallback, not a failure.
 *
 * The libp2p resolve handler is the SAME `resolveImpulseContent` the HTTP
 * resolver uses, so a shape resolves identically over either transport.
 */

import type {
  FederationTransportModule,
  ResolveHandler,
  VesselLibp2p,
} from './transport-types.js';

// Non-literal specifier: keeps `import()` typed as `any` so this file compiles
// WITHOUT the optional package installed. The build marks the same specifier
// `--external`, so it resolves from node_modules at runtime (or throws → null).
const TRANSPORT_PKG = '@avigopal/libp2p-federation-transport';

export interface FederationNode {
  peerId: string;
  /** The current relay-circuit multiaddr, re-derived on each call (may be ''). */
  currentCircuit(): string;
  /** Client resolve over the overlay: target = multiaddr or peerId. */
  resolveViaLibp2p(target: string, pointer: unknown): Promise<unknown>;
  resolveViaHttp(target: string, pointer: unknown): Promise<unknown>;
  stop(): Promise<void>;
}

async function loadTransport(): Promise<FederationTransportModule | null> {
  try {
    const spec = TRANSPORT_PKG;
    const mod = (await import(spec)) as unknown as FederationTransportModule;
    if (typeof mod?.createVesselLibp2p !== 'function') return null;
    return mod;
  } catch (err) {
    console.error(
      `[federation] libp2p transport unavailable — staying HTTP-only: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

function findCircuit(vl: VesselLibp2p): string {
  try {
    return vl.advertiseMultiaddrs().find((m) => m.includes('p2p-circuit')) ?? '';
  } catch {
    return '';
  }
}

export interface StartFederationNodeOptions {
  vesselId: string;
  relayMultiaddr: string;
  /** Serves shapes over the overlay — identical to the HTTP resolve path. */
  resolveHandler: ResolveHandler;
  /** Max time to wait for the initial circuit reservation. */
  circuitWaitMs?: number;
}

/**
 * Start the federation node. Returns null (not throw) whenever the overlay
 * can't be established — missing transport package, node init failure — so the
 * caller cleanly continues HTTP-only.
 */
export async function startFederationNode(
  opts: StartFederationNodeOptions,
): Promise<FederationNode | null> {
  const transport = await loadTransport();
  if (!transport) return null;

  let vl: VesselLibp2p;
  try {
    vl = await transport.createVesselLibp2p({
      vesselId: opts.vesselId,
      relayMultiaddr: opts.relayMultiaddr,
      enableHttp: true,
    });
    await transport.serveResolve(vl, opts.resolveHandler);
    await transport.serveResolveHttp(vl, opts.resolveHandler);
  } catch (err) {
    console.error(
      `[federation] node init failed — staying HTTP-only: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  // Bounded wait for the initial circuit reservation; a late reservation is
  // still picked up by currentCircuit() on later heartbeat cycles.
  const deadline = Date.now() + (opts.circuitWaitMs ?? 20_000);
  while (Date.now() < deadline) {
    if (findCircuit(vl)) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  return {
    peerId: vl.peerId,
    currentCircuit: () => findCircuit(vl),
    resolveViaLibp2p: (target, pointer) => transport.resolveViaLibp2p(vl, target, pointer),
    resolveViaHttp: (target, pointer) => transport.resolveViaHttp(vl, target, pointer),
    stop: () => vl.stop(),
  };
}
