/**
 * Agent-resolution delivery — posts the agent's answer back to the substrate
 * and retries across sessions.
 *
 * The answer is recorded durably BEFORE delivery (delivered=0), so a failed
 * post-back (network down, goal-host briefly unreachable) is not lost: the
 * startup reconcile drains any undelivered answers on the next session, keyed by
 * the stable vesselId. Targets an explicit GOAL_HOST_VESSEL_URL when set, else
 * the goal-host discovery returns for the `goal_execution` shape (and the
 * resolve endpoint it advertises). Contract: SPEC §submit_resolution.
 */

import type { AnalysisAPIClient } from './api-client.js';
import type { LocalStore, AgentResolutionRecord } from './local-store.js';
import { discoverFirstVesselByShape, buildResolverUrl } from './discovery.js';
import { operatorId } from './operator-id.js';
import { substrateRefusal } from './attachment.js';

const DELIVERY_TIMEOUT_MS = 20_000;

export interface DeliveryOutcome {
  ok: boolean;
  /** True when the substrate is no longer waiting (404) — stop retrying. */
  terminal?: boolean;
  error?: string;
}

async function goalHostResolveUrl(apiClient: AnalysisAPIClient): Promise<string | undefined> {
  const explicit = process.env.GOAL_HOST_VESSEL_URL?.replace(/\/$/, '');
  if (explicit) return `${explicit}/resolve`;
  const discovered = await discoverFirstVesselByShape({
    discoveryEndpoint: apiClient.getDiscoveryEndpoint(),
    shape: 'goal_execution',
    apiKey: process.env.METABOB_API_KEY,
  });
  return discovered ? buildResolverUrl(discovered, apiClient.getDiscoveryEndpoint()) : undefined;
}

/**
 * Deliver one resolution to goal-host as `solicitationResponse_write`. goal-host
 * reads solicitationId/outcome/answer off the pointer (body.X ?? pointer.X), so
 * the standard {impulse:{pointer}} envelope carries them.
 */
export async function deliverResolution(
  apiClient: AnalysisAPIClient,
  res: AgentResolutionRecord,
): Promise<DeliveryOutcome> {
  // Keyed: nothing is sent until the key is proven. Not terminal — a later
  // session with a working attachment re-delivers. CONFORMANCE §c3-identity
  const refusal = await substrateRefusal();
  if (refusal) return { ok: false, error: refusal };

  const url = await goalHostResolveUrl(apiClient);
  if (!url) return { ok: false, error: 'goal-host not found (no discovery / GOAL_HOST_VESSEL_URL)' };

  const apiKey = process.env.METABOB_API_KEY;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;

  const pointer: Record<string, unknown> = {
    type: 'solicitationResponse_write',
    operator: operatorId(),
    solicitationId: res.task_id,
    outcome: res.outcome,
  };
  if (res.answer !== null) pointer['answer'] = res.answer;

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ impulse: { pointer } }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    const text = await r.text();
    let payload: { resolved?: boolean; error?: string } = {};
    try { payload = JSON.parse(text); } catch { /* non-JSON body */ }

    if (r.status === 404) {
      return { ok: false, terminal: true, error: 'solicitation no longer pending (timed out on the substrate)' };
    }
    if (!r.ok || payload.resolved === false) {
      return { ok: false, error: `${r.status} ${payload.error ?? text.slice(0, 160)}`.trim() };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Drain undelivered resolutions for this vessel. Called at startup (resume a
 * prior session's answers) and after each submit. Terminal failures (the
 * solicitation is gone) are marked delivered so they stop retrying; transient
 * failures bump the attempt counter and stay queued.
 */
export async function reconcileUndelivered(
  apiClient: AnalysisAPIClient,
  localStore: LocalStore,
  vesselId: string,
): Promise<{ delivered: number; abandoned: number; pending: number }> {
  const undelivered = localStore.getUndeliveredResolutions(vesselId);
  let delivered = 0;
  let abandoned = 0;
  for (const res of undelivered) {
    const out = await deliverResolution(apiClient, res);
    if (out.ok) {
      localStore.markResolutionDelivered(vesselId, res.task_id);
      delivered++;
    } else if (out.terminal) {
      localStore.markResolutionDelivered(vesselId, res.task_id); // stop retrying a gone solicitation
      abandoned++;
    } else {
      localStore.bumpResolutionAttempt(vesselId, res.task_id, out.error ?? 'unknown');
    }
  }
  return { delivered, abandoned, pending: undelivered.length - delivered - abandoned };
}
