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
  /**
   * The operator authority goal-host validated for this dispatch. Behind goal-host's caller
   * validation it is set only from a credential carrying operator:direct or admin; on an older
   * record (no `principal`) it is the operator id the request claimed.
   */
  operator?: string | null;
  /** The operator id the request body claimed: a label, never authority. */
  operator_label?: string | null;
  /** The validated caller, or null/absent when goal-host does not report one. */
  principal?: DispatchPrincipal | null;
  goal?: string;
  goalReachReason?: string | null;
  /** What the walk taught the substrate (goal-host's LearningConsequences), or null when not reported. */
  learning?: LearningConsequences | null;
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

export interface LearningConsequences {
  alphaBetaDelta?: Array<{ templateId?: string; dAlpha?: number; dBeta?: number }>;
  gapsFiled?: string[];
  goalPathRecorded?: boolean;
  oracleLabelWritten?: boolean;
}

/** One line stating a requested learning mode as a request, not an outcome. */
export function requestedLearningModeLine(mode: 'observe' | 'learn' | undefined): string | null {
  if (!mode) return null;
  return mode === 'observe'
    ? '  learning_mode:      observe (requested; a goal-host older than the goalDispatchAsync learning_mode forward still learns — the `learning:` line of goal_status shows what the walk taught)'
    : '  learning_mode:      learn (requested)';
}

/** Posterior entries that moved: goal-host lists every template it graded, Δ0 included. */
function changedDeltas(l: LearningConsequences): NonNullable<LearningConsequences['alphaBetaDelta']> {
  return (l.alphaBetaDelta ?? []).filter(d => (d.dAlpha ?? 0) !== 0 || (d.dBeta ?? 0) !== 0);
}

/** True when the walk changed what the substrate has learned. */
function taught(l: LearningConsequences): boolean {
  return Boolean(l.goalPathRecorded || changedDeltas(l).length > 0 || (l.gapsFiled?.length ?? 0) > 0 || l.oracleLabelWritten);
}

const signed = (sym: string, n?: number): string => (n ? `${sym}${n > 0 ? '+' : ''}${n}` : '');

/**
 * The `learning:` line(s) for a dispatch record: what the walk actually taught
 * the substrate (goal-host's `learning` consequences — paths, posteriors, gaps,
 * oracle labels), and a mismatch line when `observe` was requested but the walk
 * taught anyway. Absent consequences are said, never read as "none".
 */
export function learningLines(learning: unknown, requested?: 'observe' | 'learn'): string[] {
  if (!learning || typeof learning !== 'object') {
    return ['  learning:           not reported by goal-host for this dispatch'];
  }
  const l = learning as LearningConsequences;
  if (!taught(l)) return ['  learning:           none recorded'];
  const parts: string[] = [];
  if (l.goalPathRecorded) parts.push('goal path recorded');
  const deltas = changedDeltas(l).map(d =>
    [d.templateId ?? '?', signed('α', d.dAlpha), signed('β', d.dBeta)].filter(Boolean).join(' '));
  if (deltas.length) parts.push(`posteriors ${deltas.join(', ')}`);
  if (l.gapsFiled?.length) parts.push(`gaps filed ${l.gapsFiled.join(', ')}`);
  if (l.oracleLabelWritten) parts.push('oracle label written');
  const lines = [`  learning:           ${parts.join('; ')}`];
  if (requested === 'observe') {
    // goal-host sets goalPathRecorded on its trace branch whether or not it wrote the
    // path, so under observe the flag alone is not evidence of a write; posterior
    // changes, filed gaps and labels are.
    const recorded = changedDeltas(l).length > 0 || (l.gapsFiled?.length ?? 0) > 0 || Boolean(l.oracleLabelWritten);
    lines.push(recorded
      ? '  ⚠ observe was requested, but this walk taught the substrate (see learning above)'
      : '  (observe: goal-host reports a goal path but sets that flag without writing one under observe; no posterior, gap or label was recorded)');
  }
  return lines;
}

/** goal-host's validated caller for a dispatch. */
export interface DispatchPrincipal {
  kind?: 'key' | 'node_self' | string;
  /** True iff the caller's credential carries operator:direct or admin, validated at identity. */
  operator?: boolean;
  /** A non-reversible tag: a key id's hash prefix, or a literal for node-self. */
  tag?: string;
  /** Pre-amendment builds served `label` ("key:<keyId>"); a raw key id is never displayed. */
  label?: string;
}

/**
 * The principal lines for a dispatch record: who goal-host validated as the caller, the
 * operator id the request merely claimed, and — when the caller held no operator authority —
 * one plain line saying so. A record without a principal is "not reported", never read as
 * non-operator: an older goal-host or a pre-validation record does not say. SPEC §goal_status
 */
export function principalLines(record: { principal?: DispatchPrincipal | null; operator_label?: string | null }): string[] {
  const p = record.principal;
  const lines: string[] = [];
  if (!p || typeof p !== 'object') {
    lines.push('  principal:          not reported');
  } else {
    const tag = typeof p.tag === 'string' && p.tag ? p.tag
      : typeof p.label === 'string' && p.label && !p.label.startsWith('key:') ? p.label : null;
    const kind = p.kind ?? 'unknown';
    lines.push(`  principal:          ${kind}${tag ? ` (${tag})` : p.label ? ' (key id withheld)' : ''}`);
    if (p.operator === true) lines.push('  operator authority: yes (validated)');
  }
  if (typeof record.operator_label === 'string' && record.operator_label) {
    lines.push(`  operator label:     ${record.operator_label} (claimed, unverified)`);
  }
  if (p && typeof p === 'object' && p.operator === false) {
    lines.push(p.kind === 'node_self'
      ? '  ran without operator authority (node self-call): the node\'s own key never carries operator authority; directed edits and operator priority do not apply'
      : '  ran without operator authority: an ordinary keyed caller; directed edits and operator priority do not apply');
  }
  return lines;
}
