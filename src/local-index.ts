import { CoChangePredictor } from '@metabob/cpg-inference';
import type { CoChangePrediction } from '@metabob/cpg-inference';
import type { CodePropertyGraph } from '@metabob/cpg-inference';

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
    this._workspacePath = path;
    this._filesIndexed = filesIndexed;
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
    const ids: string[] = [];
    for (const [id, node] of this.predictor.componentMap) {
      const nodePath = (node as any).filePath as string | undefined;
      if (nodePath && (nodePath === filePath || nodePath.endsWith(`/${filePath}`) || filePath.endsWith(`/${nodePath}`))) {
        ids.push(id);
      }
    }
    return ids;
  }
}

let _instance: LocalIndex | null = null;

export function getLocalIndex(): LocalIndex {
  if (!_instance) {
    _instance = new LocalIndex();
  }
  return _instance;
}
