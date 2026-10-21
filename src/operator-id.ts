/**
 * The operator identity and session this process declares on what it sends: threaded
 * onto goal dispatches (run_goal / run_goal_async) as `operator:` and `session:` tags,
 * folded into feedback labels, and carried on every write as `client_claim`.
 * SPEC §client-claim
 *
 * These are CLAIMS the client makes, not attribution: a producer that stamps who wrote
 * what does so from the credential, and can join its stamp to the claim. The operator is
 * MB_OPERATOR_ID when set; otherwise this workspace's stable vesselId
 * (metabob-mcp-<hash(apiKey+workspace)>), so distinct operators and workspaces are told
 * apart rather than sharing one default. The session is SESSION_ID when set, else a fresh
 * UUID per launch.
 */

import { randomUUID } from 'node:crypto';
import { VESSEL_VERSION } from './vessel-identity.js';

/** The operator id when no workspace identity has resolved (no key configured). */
export const UNIDENTIFIED_OPERATOR = 'metabob-mcp-unidentified';

let workspaceOperator: string | undefined;
const SESSION = process.env.SESSION_ID || randomUUID();

/** Set once at boot from the stable vesselId; the operator default from then on. */
export function setWorkspaceOperator(vesselId: string | undefined): void {
  workspaceOperator = vesselId;
}

export function operatorId(): string {
  return process.env.MB_OPERATOR_ID || workspaceOperator || UNIDENTIFIED_OPERATOR;
}

/** This process's session id: SESSION_ID, or one UUID per launch. */
export function sessionId(): string {
  return SESSION;
}

/** The claim every write carries: who says it sent this, in which session, with which client. */
export interface ClientClaim {
  operator: string;
  session: string;
  client: string;
}

/**
 * Whether writes carry `client_claim`: on unless METABOB_CLIENT_CLAIM is off. A live write smoke
 * showed every implemented write shape accepts the extra field (some substrate tables are
 * schemafull, so it was checked rather than assumed). The dispatch `session:` tag and the feedback
 * notes ride in fields producers already accept, and are always on.
 */
export function clientClaimEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|off|no)$/i.test(env.METABOB_CLIENT_CLAIM ?? '');
}

export function clientClaim(): ClientClaim {
  return { operator: operatorId(), session: sessionId(), client: `metabob-mcp/${VESSEL_VERSION}` };
}
