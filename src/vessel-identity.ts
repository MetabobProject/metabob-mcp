/**
 * Vessel identity — the single source of truth for how this process names
 * itself.
 *
 * Three facts live here so they can never drift apart across the MCP server
 * and the loopback HTTP capabilities document:
 *   - VESSEL_VERSION  — read once from package.json (was hand-duplicated in
 *     four places: index.ts MCP_VERSION, the MCP Server ctor, vessel-server's
 *     VERSION, and package.json).
 *   - VESSEL_BASE_NAME — the vessel-type name ('metabob-mcp'); the MCP server
 *     name and the DERIVED vesselId prefix.
 *   - SERVED_SHAPES   — the impulse shapes the loopback HTTP resolver can
 *     answer, as its capabilities document lists them. Nothing advertises them
 *     to discovery: the process is client-only (CONFORMANCE §c11-attachment-model).
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
 * self-description in its capabilities document, for local callers.
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

export interface VesselIdInputs {
  /**
   * Explicit operator-supplied id (VESSEL_ID env / metabob.vesselId config).
   * Wins outright — two instances with the same value share one task queue and
   * one finding author.
   */
  explicit?: string;
  /**
   * The API key. Its secret already scopes the namespace server-side (the org
   * comes from the verified key), so it is folded into the derived id only to
   * separate instances WITHIN one namespace.
   */
  apiKey?: string;
  /** Workspace root this instance serves; distinguishes instances on one key. */
  workspaceRoot?: string;
}

/**
 * Resolve this instance's vesselId: the key of its local agent-task queue and
 * the `recorded_by` / `reviewed_by` author of the findings and verdicts it
 * writes. It is never registered with discovery. CONFORMANCE §c10-one-registrant-per-key-and-workspace
 *
 * With only the key an instance still gets a STABLE, UNIQUE id, so multiple
 * concurrent instances disambiguate without a third required input:
 *   - explicit id            → used verbatim (deliberate replica semantics).
 *   - else metabob-mcp-<hash(apiKey + workspaceId)>: same key + same workspace
 *     → same id across restarts (stable); same key + different workspace →
 *     different id (disambiguated).
 *
 * Returns undefined only when there is neither an explicit id nor an apiKey,
 * rather than synthesising a colliding hostname-based id; findings are then
 * recorded without an author line.
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
  // which is the durable key for the agent task queue, so pending work would
  // become unreachable.
  const fingerprint = createHash('sha256')
    .update(`${inputs.apiKey}\0${workspaceId}`)
    .digest('hex')
    .slice(0, 12);
  return `${VESSEL_BASE_NAME}-${fingerprint}`;
}
