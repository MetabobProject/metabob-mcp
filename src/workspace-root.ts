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
 *   4. the directory the server was launched in, unless that is the plugin's own folder: an Agent Plugins client
 *      sets PLUGIN_ROOT and may start the server there, and a plugin folder is no project. Then the workspace is
 *      undetermined until `init_workspace` names one, and no other tool runs (src/local-index.ts@workspace-gate).
 *
 * The client's roots are asked for once the client has initialized, and again when it says they changed. A tool
 * call that needs the workspace waits for the first answer, up to ROOTS_WAIT_MS, then goes on with the fallback.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How long a tool call waits for the client's first roots answer. */
export const ROOTS_WAIT_MS = 2_000;

export type WorkspaceSource = 'WORKSPACE_PATH' | 'client roots' | 'launch directory';

let clientRoots: string[] = [];
let decided!: () => void;
let rootsDecided = new Promise<void>((resolve) => { decided = resolve; });

/**
 * The `file:` roots a client listed, as real paths, in its order; any other scheme is not a workspace. A root takes
 * the place of the launch directory, which `process.cwd()` always gives as a real path, and the workspace id and the
 * identity are hashed from the path string, so a root sent through a symlink (macOS's /var → /private/var, a repo
 * under a linked folder) is resolved: the same checkout keeps the same identity and store scope however the client
 * names it. A root that does not resolve is kept as given. WORKSPACE_PATH and an init_workspace path are used as
 * given, as they always were, so their ids do not change.
 */
export function fileRoots(roots: ReadonlyArray<{ uri?: string }>): string[] {
  const out: string[] = [];
  for (const r of roots) {
    if (typeof r.uri !== 'string' || !r.uri.startsWith('file:')) continue;
    let path: string;
    try { path = fileURLToPath(r.uri); } catch { continue; /* not a local file URI */ }
    try { path = realpathSync.native(path); } catch { /* does not resolve: as given */ }
    out.push(path);
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

const realPath = (p: string): string => { try { return realpathSync.native(p); } catch { return resolve(p); } };

/** The server was started in the plugin's own folder: PLUGIN_ROOT is set, and the launch directory is it or inside it. */
export function launchedInPluginRoot(env: NodeJS.ProcessEnv = process.env): boolean {
  const root = env['PLUGIN_ROOT'];
  if (!root) return false;
  const rel = relative(realPath(root), realPath(process.cwd()));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Steps 2–4 name a workspace: false only when the launch directory is the plugin's folder and nothing else names one. */
export function workspaceDetermined(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['WORKSPACE_PATH'] || clientRoots[0]) || !launchedInPluginRoot(env);
}

let chosenWorkspace: string | null = null;

/** The path an `init_workspace` call named, or null: it wins over steps 2–4 for the rest of the session. */
export function chosenWorkspacePath(): string | null {
  return chosenWorkspace;
}

let chosenListener: ((path: string) => void | Promise<void>) | null = null;

/** Called with the path `init_workspace` binds; the server derives the identity from it when none is derived yet. */
export function onWorkspaceChosen(fn: ((path: string) => void | Promise<void>) | null): void {
  chosenListener = fn;
}

/** `init_workspace` named `path`: record it, then tell the server (which derives the identity from it if none is yet). */
export async function workspaceChosen(path: string): Promise<void> {
  chosenWorkspace = path;
  await chosenListener?.(path);
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
  chosenWorkspace = null;
  rootsDecided = new Promise<void>((resolve) => { decided = resolve; });
}
