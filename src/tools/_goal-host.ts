/**
 * goal-host-vessel, reached through the attachment — discovery `POST /resolve`,
 * which forwards to goal-host's resolver (CONFORMANCE §c11-attachment-model).
 * Shared by run_goal, run_goal_async, goal_status, goal_reasoning and
 * provide_feedback (SPEC §substrate-goal-tools).
 *
 * Pointer contracts, from goal-host-vessel src/index.ts `handleResolve`:
 *   - `goalDispatchAsync { goal | targetTemplateId, variables?, tags?, operator?,
 *     parent_execution_id?, composition_chain? }` enqueues the goal exactly as
 *     `POST /run-goal` does and answers at once: `202 { dispatchId, status:"running" }`,
 *     `429 { dispatchId, status:"failed", refused:true, goalReachReason }` (the
 *     spend-rate breaker), `503 { error, draining:true }`, or `400 { error }`.
 *   - `goalWalkState { dispatchId }` answers the in-memory dispatch record as
 *     `{ resolved:true, shape:"goalWalkState", body:{ dispatchId, status, reached,
 *     executionId, selectedTemplateId, operator, goal, error, walkLog (last 60), … } }`,
 *     or `404 { resolved:false, error:"dispatch not found" }` once pruned (about
 *     the last 100 dispatches are kept).
 */

import { RESOLVE_TIMEOUT_MS, describeResolveFailure, resolveShape } from '../attachment.js';

/** The dispatch record goalWalkState carries. */
export interface WalkState {
  dispatchId?: string;
  status?: string;
  executionId?: string;
  selectedTemplateId?: string;
  error?: string;
  /** Honest goal-reach verdict (distinct from `status`, the template exit status). */
  reached?: boolean | null;
  /** Operator identity attributed to this dispatch, if any. */
  operator?: string | null;
  goal?: string;
  goalReachReason?: string | null;
  /** The walk's decision lines, in order (goal-host keeps the last 60 here). */
  walkLog?: string[];
  stateSignature?: unknown;
}

export type WalkStateRead =
  | { kind: 'ok'; record: WalkState }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

/**
 * The cap for one goalWalkState read. The record is in goal-host's memory, so a
 * read answers in milliseconds; discovery's 60 s cut for goal-host is meant for
 * dispatches, and a stuck read should be named and retried long before it.
 */
const WALK_STATE_TIMEOUT_MS = 15_000;

/** Read one dispatch record: a read, retried when it is cut at its timeout. */
export async function readWalkState(dispatchId: string): Promise<WalkStateRead> {
  let res;
  try {
    res = await resolveShape({ type: 'goalWalkState', dispatchId }, { timeoutMs: WALK_STATE_TIMEOUT_MS, read: true });
  } catch (err) {
    return {
      kind: 'error',
      message: describeResolveFailure(err, {
        noProducer: `no producer answered, or goal-host has no dispatch ${dispatchId} (unknown, or pruned from its in-memory records); discovery's peer forward does not say which`,
      }),
    };
  }
  if (res.status === 404) return { kind: 'not_found' };
  const body = res.body as { resolved?: boolean; body?: WalkState; error?: string } | undefined;
  if (res.status !== 200 || body?.resolved === false || !body?.body || typeof body.body !== 'object') {
    return { kind: 'error', message: `goalWalkState answered ${res.status}: ${body?.error ?? JSON.stringify(body).slice(0, 200)}` };
  }
  return { kind: 'ok', record: body.body };
}

export interface DispatchFields {
  goal?: string;
  targetTemplateId?: string;
  variables?: Record<string, unknown>;
  parent_execution_id?: string;
  composition_chain?: string[];
  /** goal-host's learning mode: `observe` runs the walk without recording paths, posteriors or traces. */
  learning_mode?: 'observe' | 'learn';
  tags?: string[];
  operator: string;
}

export interface DispatchAnswer {
  status: number;
  dispatchId?: string;
  dispatchStatus?: string;
  error?: string;
}

/**
 * Dispatch a goal asynchronously (`goalDispatchAsync`). A write: never retried.
 * Throws the attachment's named failures (no_producer, producer_timeout, …).
 */
export async function dispatchGoal(fields: DispatchFields): Promise<DispatchAnswer> {
  const pointer: Record<string, unknown> = { type: 'goalDispatchAsync', operator: fields.operator };
  if (fields.goal) pointer.goal = fields.goal;
  if (fields.targetTemplateId) pointer.targetTemplateId = fields.targetTemplateId;
  if (fields.variables) pointer.variables = fields.variables;
  if (fields.parent_execution_id) pointer.parent_execution_id = fields.parent_execution_id;
  if (fields.composition_chain) pointer.composition_chain = fields.composition_chain;
  if (fields.learning_mode) pointer.learning_mode = fields.learning_mode;
  if (fields.tags?.length) pointer.tags = fields.tags;

  const res = await resolveShape(pointer, { timeoutMs: RESOLVE_TIMEOUT_MS.goal });
  const body = (res.body ?? {}) as { dispatchId?: string; status?: string; error?: string; goalReachReason?: string };
  return {
    status: res.status,
    dispatchId: typeof body.dispatchId === 'string' ? body.dispatchId : undefined,
    dispatchStatus: body.status,
    error: body.error ?? body.goalReachReason,
  };
}

/** A refused or failed dispatch, as the goal tools print it: the status, then goal-host's error. */
export function dispatchFailure(tool: string, d: { status: number; error?: string }): string {
  return [`${tool}: ${d.status}`, d.error ? `  error: ${d.error}` : null].filter(Boolean).join('\n');
}
