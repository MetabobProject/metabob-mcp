import { CodePropertyGraph } from '../vendor/cpg-inference/src/graph.js';
import { GraphBuilder } from '../vendor/cpg-inference/src/graph-builder.js';
import { ONNXEmbeddingModel } from '../vendor/cpg-inference/src/embedding-model.js';
import type { CPGNode } from '../vendor/cpg-inference/src/types.js';
import { FAISSIndex } from './vector-index.js';

export interface PredictorConfig {
  modelPath?: string;
  embeddingDim?: number;
  inputDim?: number;
  topK?: number;
  minSimilarity?: number;
}

export interface CoChangePrediction {
  componentId: string;
  similarityScore: number;
  filePath: string;
  componentName: string;
  componentType: string;
  startLine: number;
}

export interface AddFileResult {
  filePath: string;
  componentsAdded: number;
  duration: number;
}

export class CoChangePredictor {
  private readonly cpg: CodePropertyGraph;
  private readonly builder: GraphBuilder;
  private readonly embeddingModel: ONNXEmbeddingModel;
  private readonly index: FAISSIndex;
  private readonly config: Required<Omit<PredictorConfig, 'modelPath'>> & { modelPath?: string };
  componentMap: Map<string, CPGNode>;

  constructor(config: PredictorConfig = {}) {
    this.config = {
      modelPath: config.modelPath,
      embeddingDim: config.embeddingDim ?? 32,
      inputDim: config.inputDim ?? 128,
      topK: config.topK ?? 10,
      minSimilarity: config.minSimilarity ?? 0,
    };

    this.cpg = new CodePropertyGraph();
    this.builder = new GraphBuilder(this.cpg);
    this.embeddingModel = new ONNXEmbeddingModel({
      modelPath: this.config.modelPath,
      embeddingDim: this.config.embeddingDim,
      inputDim: this.config.inputDim,
    });
    this.index = new FAISSIndex(this.config.embeddingDim, 'flat');
    this.componentMap = new Map();
  }

  async initialize(): Promise<void> {
    await this.embeddingModel.initialize();
  }

  async addFile(filePath: string, content: string): Promise<AddFileResult> {
    const startTime = performance.now();
    this.builder.addFile(filePath, content);

    let componentsAdded = 0;
    for (const node of this.cpg.nodes.values()) {
      if (
        node.id.startsWith(filePath) &&
        (node.type === 'function' || node.type === 'method' || node.type === 'class')
      ) {
        const componentId = this.generateComponentId(node, filePath);
        if (this.componentMap.has(componentId)) {
          continue;
        }

        const nodeWithFilePath = { ...node, filePath };
        this.componentMap.set(componentId, nodeWithFilePath);

        const features = this.generateSimpleFeatures(nodeWithFilePath);
        const embedding = await this.embeddingModel.infer(features);
        await this.index.add(componentId, embedding);
        componentsAdded++;
      }
    }

    return {
      filePath,
      componentsAdded,
      duration: performance.now() - startTime,
    };
  }

  async addFiles(files: Record<string, string>): Promise<AddFileResult[]> {
    const results: AddFileResult[] = [];
    for (const [filePath, content] of Object.entries(files)) {
      results.push(await this.addFile(filePath, content));
    }
    return results;
  }

  async predictCochanges(componentIds: string[], k?: number): Promise<CoChangePrediction[]> {
    const actualK = k ?? this.config.topK;
    const embeddings: Float32Array[] = [];

    for (const componentId of componentIds) {
      const node = this.componentMap.get(componentId);
      if (!node) {
        continue;
      }

      embeddings.push(await this.embeddingModel.infer(this.generateSimpleFeatures(node)));
    }

    if (embeddings.length === 0) {
      return [];
    }

    const queryEmbedding = this.embeddingModel.averageEmbeddings(embeddings);
    const results = await this.index.search(queryEmbedding, actualK);
    const predictions: CoChangePrediction[] = [];

    for (const result of results) {
      if (result.similarity < this.config.minSimilarity || componentIds.includes(result.id)) {
        continue;
      }

      const node = this.componentMap.get(result.id);
      if (!node) {
        continue;
      }

      predictions.push({
        componentId: result.id,
        similarityScore: result.similarity,
        filePath: (node as CPGNode & { filePath?: string }).filePath ?? '',
        componentName: node.name,
        componentType: node.type,
        startLine: node.startLine,
      });
    }

    return predictions;
  }

  async searchSimilar(_query: string, _k?: number): Promise<CoChangePrediction[]> {
    return [];
  }

  getCPG(): CodePropertyGraph {
    return this.cpg;
  }

  getComponent(componentId: string): CPGNode | null {
    return this.componentMap.get(componentId) ?? null;
  }

  getStats(): { componentsIndexed: number; filesAdded: number; embeddingDim: number } {
    const filePaths = new Set(
      [...this.componentMap.values()]
        .map((node) => (node as CPGNode & { filePath?: string }).filePath)
        .filter((filePath): filePath is string => typeof filePath === 'string'),
    );

    return {
      componentsIndexed: this.componentMap.size,
      filesAdded: filePaths.size,
      embeddingDim: this.config.embeddingDim,
    };
  }

  private generateComponentId(node: CPGNode, filePath: string): string {
    return `${filePath}::${node.type}::${node.name}::${node.startLine}`;
  }

  private generateSimpleFeatures(node: CPGNode): Float32Array {
    const features = new Float32Array(this.config.inputDim);
    const text = node.name;

    for (let i = 0; i < Math.min(text.length, this.config.inputDim); i++) {
      const charCode = text.charCodeAt(i);
      if (!Number.isNaN(charCode)) {
        features[i] = charCode / 255;
      }
    }

    return features;
  }
}
