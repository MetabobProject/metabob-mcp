/**
 * Agent-resolution delivery — posts the agent's answer back to the substrate
 * and retries across sessions.
 *
 * The answer is recorded durably BEFORE delivery (delivered=0), so a failed
 * post-back (network down, goal-host briefly unreachable) is not lost: the
 * startup reconcile drains any undelivered answers on the next session, keyed by
 * the stable vesselId. The answer is the `solicitationResponse_write` shape,
 * resolved through discovery `POST /resolve` to goal-host
 * (CONFORMANCE §c11-attachment-model). Contract: SPEC §submit_resolution.
 */

import type { AnalysisAPIClient } from './api-client.js';
import type { LocalStore, AgentResolutionRecord } from './local-store.js';
import { operatorId } from './operator-id.js';
import { describeResolveFailure, resolveShape, substrateRefusal } from './attachment.js';

const DELIVERY_TIMEOUT_MS = 20_000;

export interface DeliveryOutcome {
  ok: boolean;
  /** True when the substrate is no longer waiting (goal-host's 404) — stop retrying. */
  terminal?: boolean;
  error?: string;
}

/**
 * Deliver one resolution to goal-host as `solicitationResponse_write`. goal-host
 * reads solicitationId/outcome/answer off the pointer (body.X ?? pointer.X).
 * Only goal-host's own 404 ("no pending solicitation") is terminal; discovery
 * having no producer for the shape (goal-host down or unregistered) is not.
 */
export async function deliverResolution(
  _apiClient: AnalysisAPIClient,
  res: AgentResolutionRecord,
): Promise<DeliveryOutcome> {
  // Keyed: nothing is sent until the key is proven. Not terminal — a later
  // session with a working attachment re-delivers. CONFORMANCE §c3-identity
  const refusal = await substrateRefusal();
  if (refusal) return { ok: false, error: refusal };

  const pointer: Record<string, unknown> = {
    type: 'solicitationResponse_write',
    operator: operatorId(),
    solicitationId: res.task_id,
    outcome: res.outcome,
  };
  if (res.answer !== null) pointer['answer'] = res.answer;

  try {
    // A write: never retried within the call (src/attachment.ts@attachment-resolve).
    const r = await resolveShape(pointer, { timeoutMs: DELIVERY_TIMEOUT_MS });
    const payload = (r.body ?? {}) as { resolved?: boolean; error?: string };

    if (r.status === 404) {
      return { ok: false, terminal: true, error: 'solicitation no longer pending (timed out on the substrate)' };
    }
    if (r.status < 200 || r.status >= 300 || payload.resolved === false) {
      return { ok: false, error: `${r.status} ${payload.error ?? JSON.stringify(payload).slice(0, 160)}`.trim() };
    }
    return { ok: true };
  } catch (err) {
    // no_producer, producer_timeout, … — transient from here; the answer stays queued.
    // Through a peer forward goal-host's terminal 404 also arrives as no_producer
    // (src/attachment.ts@no-producer-line), so an answer whose solicitation
    // timed out on a peer's goal-host is retried each session, not retired.
    return { ok: false, error: describeResolveFailure(err) };
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
