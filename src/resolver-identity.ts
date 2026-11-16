/**
 * Resolver identity — this process's vesselId, set once at boot and read at use
 * time.
 *
 * The vesselId (metabob-mcp-<hash(apiKey+workspace)>) is the author of the
 * findings and verdicts this process writes: a later session in the same
 * workspace+key re-derives the identical id. It is a process-wide constant, so a
 * tiny module-level holder avoids threading it through every tool.
 */

const identity: { vesselId?: string } = { vesselId: undefined };

/**
 * Set once from boot after the vesselId is resolved. A present `vesselId` key is
 * applied verbatim (including an explicit `undefined` to clear it, e.g. when no
 * key was configured); an absent key leaves the current value untouched.
 */
export function setResolverIdentity(next: { vesselId?: string }): void {
  if ('vesselId' in next) identity.vesselId = next.vesselId;
}

/** The author id, or undefined when there is no key and no VESSEL_ID. */
export function getResolverVesselId(): string | undefined {
  return identity.vesselId;
}
