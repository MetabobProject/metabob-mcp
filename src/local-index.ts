// @anchor index-not-persisted
/**
 * Local CPG bridge.
 *
 * KNOWN LIMITATION — intentionally NOT persisted across launches.
 * The index (parsed CPG nodes/edges and their components) is rebuilt from source
 * each process start via repeated `init_workspace` batches. A disk cache keyed by
 * file path + mtime/size was assessed and deliberately NOT adopted, because it
 * cannot be invalidated correctly at file granularity:
 *   1. CALLS edges are authored across files. vendor GraphBuilder.findCallExpressions
 *      resolves each call by a whole-graph name lookup at parse time
 *      (cpg.findByName(calleeName)), so the edges INTO a file are created while
 *      OTHER files are being parsed. Invalidating one changed file therefore
 *      requires re-resolving edges across the whole graph.
 *   2. Secondary hazard at the component layer: component ids embed the start
 *      line. generateComponentId (src/cochange-predictor.ts) is
 *      `filePath::type::name::startLine`, so a line shift changes a file's
 *      component ids. (Note: graph-node ids from generateNodeId are a per-file
 *      monotonic counter — `currentFile::type-<counter>[::name]`, NOT startLine —
 *      so they are stable under a whitespace-only shift; it is the component
 *      layer, not the node layer, that the line-number coupling breaks.)
 * Only all-or-nothing whole-index invalidation is safe, and that is voided by the
 * first edit, i.e. the primary agent-editing workflow. SPEC §init_workspace states
 * the constraints any persistence must meet; a stale index would serve wrong analyze_impact /
 * assign_git_changes answers, which is worse than a slower cold start.
 */
import { resolve } from 'node:path';
import { chosenWorkspacePath, configuredWorkspace, workspaceDetermined } from './workspace-root.js';
import type { CoChangePredictor } from './cpg-inference.js';
import type { CodePropertyGraph } from './cpg-inference.js';

// @anchor lazy-native
/**
 * The CPG and its parser (tree-sitter and its grammars) are native modules, loaded
 * on the first local-tool call that needs them, not at startup. A module that cannot load (no prebuilt binary for
 * this platform, a missing shared library) makes that call answer `local_index_unavailable(<module>: <reason>)`,
 * and the ledger, memory and substrate tools, which never touch it, work as usual. SPEC §init_workspace
 */
export class LocalIndexUnavailable extends Error {
  constructor(readonly module: string, readonly reason: string) {
    super(`local_index_unavailable(${module}: ${reason}): the local code tools cannot run here; the ledger, memory and substrate tools are unaffected`);
    this.name = 'LocalIndexUnavailable';
  }
}

type CpgModule = typeof import('./cpg-inference.js');
let cpgModule: Promise<CpgModule> | null = null;
/** The load failure, once one happened: later calls report it instead of asking for init_workspace again. */
let cpgFailure: LocalIndexUnavailable | null = null;
let importCpg: () => Promise<CpgModule> = () => import('./cpg-inference.js');

/** Tests only: replace how the CPG module is imported (null restores the real import), and forget a past load. */
export function setCpgImportForTests(fn: (() => Promise<CpgModule>) | null): void {
  importCpg = fn ?? (() => import('./cpg-inference.js'));
  cpgModule = null;
  cpgFailure = null;
  _instance = null;
}

/** The CPG module, loaded once; a failure is kept, so every later call names the same cause without retrying. */
function loadCpg(): Promise<CpgModule> {
  cpgModule ??= importCpg().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const module = /(tree-sitter[\w-]*)/.exec(message)?.[1] ?? 'cpg-inference';
    cpgFailure = new LocalIndexUnavailable(module, message.split('\n')[0]!.slice(0, 200));
    throw cpgFailure;
  });
  return cpgModule;
}

export interface LocalIndexStats {
  filesIndexed: number;
  componentsIndexed: number;
  workspacePath: string | null;
  ready: boolean;
}

export class LocalIndex {
  private _predictor: CoChangePredictor | null = null;
  private _ready = false;
  private _workspacePath: string | null = null;
  private _filesIndexed = 0;
  private _parsedFiles = new Set<string>();
  /** file (absolute) → import specifiers, recorded at index time. The vendored
   *  CPG's own import extraction is broken (walks a child property the parser
   *  wrapper does not expose), so the bridge keeps its own map. */
  private _imports = new Map<string, string[]>();

  /** The predictor, once `init()` has loaded it; every caller checks `isReady()` or calls `init()` first. */
  get predictor(): CoChangePredictor {
    if (!this._predictor) throw new Error('LocalIndex not initialised: call init() first');
    return this._predictor;
  }

  /** Load the CPG (on first use) and initialise the predictor. Throws LocalIndexUnavailable when it cannot load. */
  async init(): Promise<void> {
    if (this._ready) return;
    if (!this._predictor) {
      const { CoChangePredictor } = await loadCpg();
      this._predictor = new CoChangePredictor();
    }
    this._ready = true;
  }

  isReady(): boolean {
    return this._ready;
  }

  /** What a local tool answers before the index is ready: the load failure when there was one, else run init_workspace. */
  notReadyMessage(): string {
    return cpgFailure?.message ?? 'Workspace not indexed. Run init_workspace first.';
  }

  /**
   * Point the index at a workspace. Switching to a DIFFERENT workspace drops
   * the previous workspace's graph entirely — one CPG per workspace. Without
   * this, components from an earlier workspace (indexed under other paths)
   * bleed into path lookups and produce wrong-repo impact/co-change results.
   */
  async setWorkspace(path: string, filesIndexed: number): Promise<void> {
    if (this._workspacePath !== null && this._workspacePath !== path) {
      this._parsedFiles.clear();
      this._imports.clear();
      this._predictor = null;
      this._ready = false;
      await this.init();
    }
    this._workspacePath = path;
    this._filesIndexed = filesIndexed;
  }

  workspacePath(): string | null {
    return this._workspacePath;
  }

  /** Resolve a possibly-relative file path against the active workspace. */
  resolvePath(filePath: string): string {
    return this._workspacePath ? resolve(this._workspacePath, filePath) : resolve(filePath);
  }

  isParsed(filePath: string): boolean {
    return this._parsedFiles.has(this.resolvePath(filePath));
  }

  /** Number of workspace files parsed into the local CPG this process. */
  parsedCount(): number {
    return this._parsedFiles.size;
  }

  /** Absolute paths of all files parsed into the local CPG this process. */
  parsedFilePaths(): string[] {
    return [...this._parsedFiles];
  }

  /** Coverage snapshot: files parsed locally vs total scanned. */
  coverage(): { parsedFiles: number; totalFiles: number } {
    return {
      parsedFiles: this._parsedFiles.size,
      totalFiles: this._filesIndexed,
    };
  }

  markParsed(filePath: string): void {
    this._parsedFiles.add(this.resolvePath(filePath));
  }

  /** Extract and remember a file's import specifiers (ES import/export-from,
   *  require(), dynamic import(), python import/from-import). */
  recordImports(filePath: string, content: string): void {
    const specs = new Set<string>();
    const patterns = [
      /(?:^|\n)\s*(?:import|export)\s+[^;'"]*?from\s+['"]([^'"]+)['"]/g,
      /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
      /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
      /(?:^|\n)\s*from\s+([\w.]+)\s+import\b/g,
      /(?:^|\n)\s*import\s+([\w.]+)\s*$/gm,
    ];
    for (const re of patterns) {
      for (const m of content.matchAll(re)) {
        if (m[1]) specs.add(m[1]);
      }
    }
    this._imports.set(this.resolvePath(filePath), [...specs]);
  }

  getCPG(): CodePropertyGraph {
    return this.predictor.getCPG();
  }

  stats(): LocalIndexStats {
    return {
      filesIndexed: this._filesIndexed,
      componentsIndexed: this._predictor ? this._predictor.getStats().componentsIndexed : 0,
      workspacePath: this._workspacePath,
      ready: this._ready,
    };
  }

  /**
   * Component ids for a file. Matching is exact on the workspace-resolved
   * path — no bidirectional suffix matching (a relative-indexed node from one
   * repo must never match an absolute query from another).
   *
   * Files with no function/method/class components (schemas, configs, pure
   * type/const modules) fall back to their file-level CPG node so impact and
   * git-change assignment can still resolve them.
   */
  componentIdsForFile(filePath: string): string[] {
    const abs = this.resolvePath(filePath);
    const seen = new Set<string>();
    for (const [id, node] of this.predictor.componentMap) {
      const nodePath = (node as any).filePath as string | undefined;
      if (!nodePath) continue;
      if (nodePath === abs || nodePath === filePath || this.resolvePath(nodePath) === abs) {
        seen.add(id);
      }
    }

    if (seen.size === 0) {
      const meta = this.getCPG().fileIndex.get(abs) ?? this.getCPG().fileIndex.get(filePath);
      if (meta) {
        for (const id of meta.nodeIds) {
          if (/::file-\d+$/.test(id)) seen.add(id);
        }
      }
    }

    return [...seen];
  }

  /**
   * File-level import graph over the indexed workspace, built from the CPG's
   * fileIndex metadata (the graph itself has no IMPORTS edges). Keys and
   * values are indexed file paths. Relative specifiers are resolved against
   * the importing file; TS/JS extension rewrites (./x.js -> ./x.ts) are tried.
   */
  fileImportGraph(): Map<string, Set<string>> {
    const cpg = this.getCPG();
    const indexed = new Set(cpg.fileIndex.keys());
    const graph = new Map<string, Set<string>>();

    const candidates = (fromFile: string, spec: string): string[] => {
      if (!spec.startsWith('.')) return [];
      const base = resolve(fromFile, '..', spec);
      const out = [base];
      if (/\.(js|mjs|cjs)$/.test(base)) {
        out.push(
          base.replace(/\.js$/, '.ts'),
          base.replace(/\.js$/, '.tsx'),
          base.replace(/\.mjs$/, '.mts'),
          base.replace(/\.cjs$/, '.cts'),
        );
      } else if (!/\.[a-z]+$/.test(base)) {
        for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.py']) out.push(base + ext);
        for (const ext of ['.ts', '.js']) out.push(`${base}/index${ext}`);
      }
      return out;
    };

    for (const filePath of cpg.fileIndex.keys()) {
      const targets = new Set<string>();
      const specs = this._imports.get(filePath) ?? cpg.fileIndex.get(filePath)?.imports ?? [];
      for (const spec of specs) {
        for (const cand of candidates(filePath, spec)) {
          if (indexed.has(cand)) {
            targets.add(cand);
            break;
          }
        }
      }
      graph.set(filePath, targets);
    }

    return graph;
  }
}

let _instance: LocalIndex | null = null;

export function getLocalIndex(): LocalIndex {
  if (!_instance) {
    _instance = new LocalIndex();
  }
  return _instance;
}

/**
 * The workspace root to ATTRIBUTE work to — repo name on a recorded finding,
 * the term a cross-agent recall filters on.
 *
 * `init_workspace` is the authority, but it only sets in-memory index state,
 * which exists solely in the process where it ran. A tool reaching for
 * `workspacePath()` directly therefore attributes to "unknown" whenever it
 * runs in a process that has not indexed — a per-call spawn, or an agent
 * reconnected to a different sidecar instance. Fall back to the SAME ladder
 * `init_workspace` itself resolves from (init-workspace.ts), so attribution
 * never depends on call ordering.
 *
 * Deliberately NOT used by `resolvePath` / component lookups: those must stay
 * bound to the indexed workspace, or a fallback root would silently match
 * components across repos.
 */
// @anchor activeWorkspacePath
export function activeWorkspacePath(): string {
  return sessionWorkspacePath() ?? configuredWorkspace();
}

/** The workspace this session chose through `init_workspace` (the index's root, else a path it named), or null. */
export function sessionWorkspacePath(): string | null {
  return getLocalIndex().workspacePath() ?? chosenWorkspacePath();
}

// @anchor workspace-gate
/**
 * The one line every tool but `init_workspace` with a path answers while the workspace is undetermined: the server
 * runs in the plugin's own folder and nothing named a project (SPEC §workspace). Nothing reads or writes a ledger,
 * and no identity is derived, until the agent names the project.
 */
export const WORKSPACE_UNDETERMINED =
  'workspace_undetermined: this client started the server in the plugin\'s own folder (PLUGIN_ROOT) and named no '
  + 'project (no MCP roots, no WORKSPACE_PATH). Call init_workspace { workspace_path: "<the project\'s root>" } first; '
  + 'until then no tool reads or writes a ledger, so nothing is recorded against the plugin\'s folder.';

/** The refusal for `tool` while the workspace is undetermined, or null when it may run. */
export function workspaceGateRefusal(tool: string, input: Record<string, unknown> | undefined): string | null {
  if (sessionWorkspacePath() || workspaceDetermined()) return null;
  if (tool === 'init_workspace' && typeof input?.['workspace_path'] === 'string' && input['workspace_path'] !== '') return null;
  return WORKSPACE_UNDETERMINED;
}
