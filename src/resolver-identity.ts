/**
 * Resolver identity — the stable keys under which this process participates as
 * an agent-resolver, set once at boot and read at use time.
 *
 * The vesselId (metabob-mcp-<hash(apiKey+workspace)>) is the cross-session
 * partition key for the durable coordination store: a later session in the same
 * workspace+key re-derives the identical id and reattaches to prior tasks. The
 * operatorId is the task owner. Both are process-wide constants, so a tiny
 * module-level holder avoids threading them through the shared resolve handler
 * (which must stay identical across the HTTP and libp2p transports).
 */

import { operatorId } from './operator-id.js';

interface ResolverIdentity {
  vesselId?: string;
  operatorId: string;
}

const identity: ResolverIdentity = { vesselId: undefined, operatorId: operatorId() };

/**
 * Set once from boot after the vesselId is resolved. A present `vesselId` key is
 * applied verbatim (including an explicit `undefined` to clear it, e.g. when no
 * key was configured); an absent key leaves the current value untouched.
 */
export function setResolverIdentity(next: { vesselId?: string; operatorId?: string }): void {
  if ('vesselId' in next) identity.vesselId = next.vesselId;
  if (next.operatorId !== undefined) identity.operatorId = next.operatorId;
}

/** The cross-session partition key, or undefined when there is no key/registration. */
export function getResolverVesselId(): string | undefined {
  return identity.vesselId;
}

export function getResolverOperatorId(): string {
  return identity.operatorId;
}
