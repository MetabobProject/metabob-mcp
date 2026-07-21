/**
 * Local CPG + vector index bridge.
 *
 * KNOWN LIMITATION — intentionally NOT persisted across launches.
 * The index (parsed CPG nodes/edges + FAISS embeddings) is rebuilt from source
 * each process start via repeated `init_workspace` batches. A disk cache keyed by
 * file path + mtime/size was assessed and deliberately NOT adopted, because it
 * cannot be invalidated correctly at file granularity:
 *   1. CALLS edges are authored across files. vendor GraphBuilder.findCallExpressions
 *      resolves each call by a whole-graph name lookup at parse time
 *      (cpg.findByName(calleeName)), so the edges INTO a file are created while
 *      OTHER files are being parsed. Invalidating one changed file therefore
 *      requires re-resolving edges across the whole graph.
 *   2. Secondary hazard at the co-change layer: component ids embed the start
 *      line. generateComponentId (src/cochange-predictor.ts) is
 *      `filePath::type::name::startLine`, so a line shift changes a file's
 *      component ids. (Note: graph-node ids from generateNodeId are a per-file
 *      monotonic counter — `currentFile::type-<counter>[::name]`, NOT startLine —
 *      so they are stable under a whitespace-only shift; it is the component/
 *      co-change layer, not the node layer, that the line-number coupling breaks.)
 * Only all-or-nothing whole-index invalidation is safe, and that is voided by the
 * first edit, i.e. the primary agent-editing workflow. See
 * openspec/changes/2026-07-19-local-index-persistence/proposal.md before
 * implementing persistence; a stale index would serve wrong analyze_impact /
 * predict_cochanges answers, which is worse than a slower cold start.
 */
import { resolve } from 'node:path';
import { CoChangePredictor } from './cpg-inference.js';
import type { CoChangePrediction } from './cpg-inference.js';
import type { CodePropertyGraph } from './cpg-inference.js';

export type { CoChangePrediction };

export interface LocalIndexStats {
  filesIndexed: number;
  componentsIndexed: number;
  workspacePath: string | null;
  ready: boolean;
}

export class LocalIndex {
  predictor: CoChangePredictor;
  private _ready = false;
  private _workspacePath: string | null = null;
  private _filesIndexed = 0;
  private _submittedFiles = new Set<string>();
  private _parsedFiles = new Set<string>();
  /** file (absolute) → import specifiers, recorded at index time. The vendored
   *  CPG's own import extraction is broken (walks a child property the parser
   *  wrapper does not expose), so the bridge keeps its own map. */
  private _imports = new Map<string, string[]>();

  constructor() {
    this.predictor = new CoChangePredictor({ minSimilarity: 0.0 });
  }

  async init(): Promise<void> {
    if (this._ready) return;
    await this.predictor.initialize();
    this._ready = true;
  }

  isReady(): boolean {
    return this._ready;
  }

  /**
   * Point the index at a workspace. Switching to a DIFFERENT workspace drops
   * the previous workspace's graph entirely — one CPG per workspace. Without
   * this, components from an earlier workspace (indexed under other paths)
   * bleed into path lookups and produce wrong-repo impact/co-change results.
   */
  async setWorkspace(path: string, filesIndexed: number): Promise<void> {
    if (this._workspacePath !== null && this._workspacePath !== path) {
      this._submittedFiles.clear();
      this._parsedFiles.clear();
      this._imports.clear();
      this.predictor = new CoChangePredictor({ minSimilarity: 0.0 });
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

  /** Number of workspace files parsed into the local CPG this process. */
  parsedCount(): number {
    return this._parsedFiles.size;
  }

  /** Absolute paths of all files parsed into the local CPG this process. */
  parsedFilePaths(): string[] {
    return [...this._parsedFiles];
  }

  /** Coverage snapshot: files parsed locally vs total scanned, plus API-submitted count. */
  coverage(): { parsedFiles: number; submittedFiles: number; totalFiles: number } {
    return {
      parsedFiles: this._parsedFiles.size,
      submittedFiles: this._submittedFiles.size,
      totalFiles: this._filesIndexed,
    };
  }

  isSubmitted(filePath: string): boolean {
    return this._submittedFiles.has(this.resolvePath(filePath));
  }

  markSubmitted(filePaths: string[]): void {
    for (const p of filePaths) this._submittedFiles.add(this.resolvePath(p));
  }

  submittedCount(): number {
    return this._submittedFiles.size;
  }

  getCPG(): CodePropertyGraph {
    return this.predictor.getCPG();
  }

  stats(): LocalIndexStats {
    const predictorStats = this.predictor.getStats();
    return {
      filesIndexed: this._filesIndexed,
      componentsIndexed: predictorStats.componentsIndexed,
      workspacePath: this._workspacePath,
      ready: this._ready,
    };
  }

  getIndexedFilePaths(): string[] {
    const seen = new Set<string>();
    for (const node of this.predictor.componentMap.values()) {
      const nodePath = (node as any).filePath as string | undefined;
      if (nodePath) seen.add(nodePath);
    }
    for (const filePath of this.getCPG().fileIndex.keys()) {
      seen.add(filePath);
    }
    return [...seen];
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
