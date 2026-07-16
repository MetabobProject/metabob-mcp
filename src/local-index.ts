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
