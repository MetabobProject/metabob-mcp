/**
 * Vessel identity — the single source of truth for how this process presents
 * itself to a discovery namespace.
 *
 * Three facts live here so they can never drift apart across the MCP server,
 * the HTTP capabilities document, and the discovery heartbeat:
 *   - VESSEL_VERSION  — read once from package.json (was hand-duplicated in
 *     four places: index.ts MCP_VERSION, the MCP Server ctor, vessel-server's
 *     VERSION, and package.json).
 *   - VESSEL_BASE_NAME — the vessel-type name ('metabob-mcp'); the MCP server
 *     name and the DERIVED vesselId prefix.
 *   - SERVED_SHAPES   — the impulse shapes the HTTP resolver can answer; the
 *     capabilities document and the heartbeat advertisement read this one list.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveWorkspaceId } from './workspace.js';

export const VESSEL_BASE_NAME = 'metabob-mcp';

/**
 * The impulse shapes served by `POST /v2/impulses/resolve` (see
 * resolvePointerToTool in vessel-server.ts). This list IS the resolver's
 * self-description — the capabilities document and the discovery heartbeat
 * both advertise exactly these, so a caller that discovers us by shape can
 * call us without a second round-trip.
 */
export const SERVED_SHAPES: readonly string[] = [
  'mcp:tool_call',
  'code:cochange_prediction',
  'code:impact_analysis',
  'code:git_change_assignment',
  'code:analysis_context',
];

function readVersion(): string {
  // src/vessel-identity.ts → ../package.json ; dist/cli.js → ../package.json ;
  // node_modules/@metabob/mcp/dist/cli.js → ../package.json. All three resolve
  // to the package-root package.json, so the version is never bundled stale.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VESSEL_VERSION = readVersion();

/**
 * Whether this session offers itself as an agent-resolver (advertises
 * human_input so the substrate can dispatch solicited decisions to it). OFF by
 * default: human_input already has producers (the human surface is the user's
 * interaction point), and a producer is added only where data locality
 * justifies it — opt in with METABOB_AGENT_RESOLVER=1|true|on.
 * Bootstrap-only (identity class): frozen at process start.
 */
export function agentResolverEnabled(): boolean {
  const v = process.env['METABOB_AGENT_RESOLVER']?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export interface VesselIdInputs {
  /**
   * Explicit operator-supplied id (VESSEL_ID env / metabob.vesselId config).
   * Wins outright — the same value on two instances is a DELIBERATE replica /
   * failover pair (one registry row).
   */
  explicit?: string;
  /**
   * The API key. Its secret already scopes the namespace server-side (discovery
   * takes orgId from the verified key, not the body), so it is folded into the
   * derived id only to separate instances WITHIN one namespace.
   */
  apiKey?: string;
  /** Workspace root this instance serves; distinguishes instances on one key. */
  workspaceRoot?: string;
}

/**
 * Resolve this instance's discovery vesselId.
 *
 * Point-and-go: with only {discovery endpoint, key} an instance still gets a
 * STABLE, UNIQUE id, so multiple concurrent instances disambiguate without a
 * third required input:
 *   - explicit id            → used verbatim (deliberate replica semantics).
 *   - else metabob-mcp-<hash(apiKey + workspaceId)>: same key + same workspace
 *     → same id across restarts (stable); same key + different workspace →
 *     different id (disambiguated).
 *
 * Returns undefined only when there is neither an explicit id nor an apiKey —
 * nothing to register with — so the caller skips registration entirely rather
 * than synthesising a colliding hostname-based id.
 */
export async function resolveVesselId(inputs: VesselIdInputs): Promise<string | undefined> {
  const explicit = inputs.explicit?.trim();
  if (explicit) return explicit;
  if (!inputs.apiKey) return undefined;

  const workspaceId = await resolveWorkspaceId(inputs.workspaceRoot ?? process.cwd());
  // The NUL is a domain separator, so key "ab" + workspace "c" cannot collide with
  // key "a" + workspace "bc". Keep it as the `\0` ESCAPE, never a literal NUL byte:
  // a raw one makes this file `data` rather than text (grep skips it silently), and
  // any tool that normalises the byte away would change every derived vesselId —
  // which is the discovery registration id AND the durable key for the agent task
  // queue, so pending work would become unreachable.
  const fingerprint = createHash('sha256')
    .update(`${inputs.apiKey}\0${workspaceId}`)
    .digest('hex')
    .slice(0, 12);
  return `${VESSEL_BASE_NAME}-${fingerprint}`;
}
