/**
 * Shape-driven advertisement (Law 1: behaviour is steered by observable state
 * read at use time, not frozen at boot).
 *
 * metabob-mcp's CPG-dependent shapes (code:cochange_prediction,
 * code:impact_analysis, code:git_change_assignment) only produce meaningful
 * output once a workspace has been indexed into the local CPG (init_workspace).
 * Advertising them before then would route a discovering caller to a resolver
 * that can only error. So the advertised shape-set is RE-DERIVED from the
 * vessel's actual current capability — "how it is managed" (what has been
 * indexed) changes what it serves — and re-advertised whenever that changes.
 *
 * This is the runtime steering surface that replaces boot-time env mode gates:
 * env stays bootstrap-only (identity, port, key); what the vessel serves is a
 * function of live state.
 */

/** Always serviceable: the generic passthrough + the gracefully-degrading context snapshot. */
const ALWAYS_SHAPES = ['mcp:tool_call', 'code:analysis_context'] as const;

/** Meaningful only once a workspace CPG exists. */
const CPG_DEPENDENT_SHAPES = [
  'code:cochange_prediction',
  'code:impact_analysis',
  'code:git_change_assignment',
] as const;

/**
 * Shapes the substrate dispatches TO the agent when it is available as a
 * resolver. Advertised only when the agent-resolver role is enabled so goal-host
 * can select this session for solicited decisions.
 */
const AGENT_RESOLVER_SHAPES = ['human_input'] as const;

/**
 * The shapes to advertise, from two use-time conditions: whether a workspace CPG
 * is populated (gates the code:* shapes) and whether this session is acting as
 * an agent-resolver (gates human_input). Pure and deterministic so the
 * heartbeat's change-detection is stable. CONFORMANCE §c7-shapes.
 */
export function computeAdvertisedShapes(indexed: boolean, agentResolver = false): string[] {
  const shapes: string[] = [...ALWAYS_SHAPES];
  if (indexed) shapes.push(...CPG_DEPENDENT_SHAPES);
  if (agentResolver) shapes.push(...AGENT_RESOLVER_SHAPES);
  return shapes;
}

export interface PresenceAdvertiserOptions {
  /** The heartbeat actuator — setShapes re-registers on a changed set. */
  heartbeat: { setShapes(shapes: string[]): Promise<void> };
  /** Recompute the shapes to advertise from current use-time conditions. */
  desiredShapes: () => string[];
  /** Recompute cadence. A light poll is sufficient; conditions change rarely. */
  intervalMs?: number;
}

/**
 * Start periodically reconciling the advertised shape-set with current
 * capability. Returns a stop function. The first reconcile runs on the next
 * tick, not synchronously, so the caller's initial registration (which should
 * already use computeAdvertisedShapes) is authoritative at boot.
 */
export function startPresenceAdvertiser(opts: PresenceAdvertiserOptions): () => void {
  const intervalMs = opts.intervalMs ?? 30_000;
  const handle = setInterval(() => {
    void opts.heartbeat
      .setShapes(opts.desiredShapes())
      .catch((err) => {
        console.error(
          `[presence] re-advertise failed: ${err instanceof Error ? err.message : err}`,
        );
      });
  }, intervalMs);
  // Do not keep the process alive solely for this timer.
  (handle as { unref?: () => void }).unref?.();
  return () => clearInterval(handle);
}
