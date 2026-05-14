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

class LocalIndex {
  readonly predictor: CoChangePredictor;
  private _ready = false;
  private _workspacePath: string | null = null;
  private _filesIndexed = 0;
  private _submittedFiles = new Set<string>();
  private _parsedFiles = new Set<string>();

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

  setWorkspace(path: string, filesIndexed: number): void {
    // Reset submission tracking when workspace changes
    if (this._workspacePath !== path) {
      this._submittedFiles.clear();
      this._parsedFiles.clear();
    }
    this._workspacePath = path;
    this._filesIndexed = filesIndexed;
  }

  isParsed(filePath: string): boolean {
    return this._parsedFiles.has(filePath);
  }

  markParsed(filePath: string): void {
    this._parsedFiles.add(filePath);
  }

  isSubmitted(filePath: string): boolean {
    return this._submittedFiles.has(filePath);
  }

  markSubmitted(filePaths: string[]): void {
    for (const p of filePaths) this._submittedFiles.add(p);
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

  componentIdsForFile(filePath: string): string[] {
    const seen = new Set<string>();
    for (const [id, node] of this.predictor.componentMap) {
      const nodePath = (node as any).filePath as string | undefined;
      if (nodePath && (nodePath === filePath || nodePath.endsWith(`/${filePath}`) || filePath.endsWith(`/${nodePath}`))) {
        seen.add(id);
      }
    }
    return [...seen];
  }
}

let _instance: LocalIndex | null = null;

export function getLocalIndex(): LocalIndex {
  if (!_instance) {
    _instance = new LocalIndex();
  }
  return _instance;
}
