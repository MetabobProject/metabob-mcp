/**
 * Local type mirror of the subset of `@avigopal/libp2p-federation-transport`
 * we consume.
 *
 * That package is an OPTIONAL, github-only dependency carrying a heavy libp2p
 * tree — it is dynamically imported at runtime and may be absent (corp proxy
 * that can't fetch it, or a deployment with no relay). Declaring the API shape
 * locally lets this code typecheck and build WITHOUT the package installed; the
 * dynamic import site casts the loaded module to `FederationTransportModule`.
 *
 * Keep in sync with the transport package's exported signatures
 * (createVesselLibp2p / serveResolve / serveResolveHttp / resolveViaLibp2p /
 * resolveViaHttp).
 */

export interface VesselLibp2pOptions {
  vesselId: string;
  relayMultiaddr?: string;
  localTcpPort?: number;
  enableHttp?: boolean;
  disableDcutr?: boolean;
  reReserveAtTtlFraction?: number;
  assumedReservationTtlMs?: number;
  extraServices?: Record<string, unknown>;
}

export interface TransportHealth {
  peerId: string;
  activeReservations: number;
  reservationTtlRemainingMs: number | null;
  connections: Array<{
    peer: string;
    addr: string;
    limited: boolean;
    bytesRemaining: number | null;
    secondsRemaining: number | null;
  }>;
  holePunchSuccess: number;
  holePunchFail: number;
  streamResets: number;
}

export interface VesselLibp2p {
  node: unknown;
  peerId: string;
  advertiseMultiaddrs: () => string[];
  health: () => TransportHealth;
  stop: () => Promise<void>;
}

/** A resolve handler: given a decoded pointer, return arbitrary content. */
export type ResolveHandler = (pointer: any) => Promise<any> | any;

export interface FederationTransportModule {
  createVesselLibp2p(opts: VesselLibp2pOptions): Promise<VesselLibp2p>;
  serveResolve(vl: VesselLibp2p, handler: ResolveHandler): Promise<void>;
  serveResolveHttp(vl: VesselLibp2p, handler: ResolveHandler): Promise<void>;
  /** target = multiaddr string (forces relay circuit) or a PeerId string. */
  resolveViaLibp2p(vl: VesselLibp2p, target: string, pointer: any): Promise<any>;
  resolveViaHttp(vl: VesselLibp2p, target: string, pointer: any): Promise<any>;
}
