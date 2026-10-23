// Contract (behaviour): SPEC §workspace
/**
 * The workspace the server works in: which repository the ledger is keyed by, where the local store scopes its
 * findings, and the path the coordination identity is derived from. A wrong workspace reads and writes the wrong
 * ledger, so it is decided in one place, in this order:
 *
 *   1. a path `init_workspace` was given (the session's explicit choice; src/local-index.ts@activeWorkspacePath);
 *   2. `WORKSPACE_PATH`, when set: a person who sets it means it;
 *   3. the client's first `file:` root (MCP `roots/list`), since a client may start the server in another directory
 *      (Agent Plugins starts it in the plugin's own folder);
 *   4. the directory the server was launched in.
 *
 * The client's roots are asked for once the client has initialized, and again when it says they changed. A tool
 * call that needs the workspace waits for the first answer, up to ROOTS_WAIT_MS, then goes on with the fallback.
 */
import { fileURLToPath } from 'node:url';

/** How long a tool call waits for the client's first roots answer. */
export const ROOTS_WAIT_MS = 2_000;

export type WorkspaceSource = 'WORKSPACE_PATH' | 'client roots' | 'launch directory';

let clientRoots: string[] = [];
let decided!: () => void;
let rootsDecided = new Promise<void>((resolve) => { decided = resolve; });

/** The `file:` roots a client listed, as paths, in its order; any other scheme is not a workspace. */
export function fileRoots(roots: ReadonlyArray<{ uri?: string }>): string[] {
  const out: string[] = [];
  for (const r of roots) {
    if (typeof r.uri !== 'string' || !r.uri.startsWith('file:')) continue;
    try { out.push(fileURLToPath(r.uri)); } catch { /* not a local file URI */ }
  }
  return out;
}

/** Record the client's roots (empty: it has none, or does not support them) and mark the first answer given. */
export function setClientRoots(paths: string[]): void {
  clientRoots = [...paths];
  decided();
}

/** The client gave no roots answer to wait for (it does not support roots, or never initialized). */
export function noClientRoots(): void {
  decided();
}

export function clientRootPaths(): readonly string[] {
  return clientRoots;
}

/** Wait for the client's first roots answer, up to `ms`. */
export async function rootsSettled(ms = ROOTS_WAIT_MS): Promise<void> {
  await Promise.race([rootsDecided, new Promise<void>((r) => setTimeout(r, ms).unref?.())]);
}

/** The configured workspace, before any `init_workspace`: steps 2–4 above. */
export function configuredWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  return env['WORKSPACE_PATH'] || clientRoots[0] || process.cwd();
}

/** Where `configuredWorkspace()` came from. */
export function workspaceSource(env: NodeJS.ProcessEnv = process.env): WorkspaceSource {
  if (env['WORKSPACE_PATH']) return 'WORKSPACE_PATH';
  return clientRoots[0] ? 'client roots' : 'launch directory';
}

let identityWorkspace: string | null = null;

/** Record the workspace the coordination identity was derived from; it is kept for the life of the process. */
export function setIdentityWorkspace(path: string): void {
  identityWorkspace ??= path;
}

/** The workspace the coordination identity was derived from, or null before it is derived. */
export function identityWorkspacePath(): string | null {
  return identityWorkspace;
}

/** Tests only: forget the client's roots. */
export function resetClientRootsForTests(): void {
  clientRoots = [];
  rootsDecided = new Promise<void>((resolve) => { decided = resolve; });
}
