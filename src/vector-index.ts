import { readFileSync, writeFileSync } from 'node:fs';

export interface SimilarityResult {
  id: string;
  distance: number;
  similarity: number;
}

export type IndexType = 'flat' | 'ivf';

interface StoredVector {
  internalId: number;
  embedding: Float32Array;
}

export class FAISSIndex {
  private readonly idMap = new Map<number, string>();
  private readonly reverseIdMap = new Map<string, number>();
  private readonly vectors = new Map<string, StoredVector>();
  private readonly dimension: number;
  private readonly indexType: IndexType;
  private nextId = 0;

  constructor(dimension: number, indexType: IndexType = 'flat') {
    this.dimension = dimension;
    this.indexType = indexType;
  }

  async add(componentId: string, embedding: Float32Array): Promise<void> {
    this.ensureDimension(embedding, 'Embedding');
    if (this.reverseIdMap.has(componentId)) {
      throw new Error(`Component ${componentId} already exists in index`);
    }

    const internalId = this.nextId++;
    this.idMap.set(internalId, componentId);
    this.reverseIdMap.set(componentId, internalId);
    this.vectors.set(componentId, { internalId, embedding: new Float32Array(embedding) });
  }

  async addBatch(componentIds: string[], embeddings: Float32Array[]): Promise<void> {
    if (componentIds.length !== embeddings.length) {
      throw new Error('Number of IDs must match number of embeddings');
    }

    for (let i = 0; i < componentIds.length; i++) {
      const componentId = componentIds[i];
      const embedding = embeddings[i];

      if (!componentId) {
        throw new Error(`Component ID at index ${i} is undefined`);
      }
      if (!embedding) {
        throw new Error(`Embedding at index ${i} is undefined`);
      }

      await this.add(componentId, embedding);
    }
  }

  async search(query: Float32Array, k: number): Promise<SimilarityResult[]> {
    this.ensureDimension(query, 'Query');
    if (this.vectors.size === 0) {
      return [];
    }

    const results: SimilarityResult[] = [];
    for (const [componentId, { embedding }] of this.vectors) {
      const squaredDistance = this.computeSquaredDistance(query, embedding);
      results.push({
        id: componentId,
        distance: Math.sqrt(squaredDistance),
        similarity: Math.max(0, 1 - squaredDistance / 2),
      });
    }

    results.sort((a, b) => a.distance - b.distance);
    return results.slice(0, Math.min(k, results.length));
  }

  async remove(componentId: string): Promise<void> {
    const internalId = this.reverseIdMap.get(componentId);
    if (internalId === undefined) {
      throw new Error(`Component ${componentId} not found in index`);
    }

    this.reverseIdMap.delete(componentId);
    this.idMap.delete(internalId);
    this.vectors.delete(componentId);
  }

  size(): number {
    return this.vectors.size;
  }

  getDimension(): number {
    return this.dimension;
  }

  has(componentId: string): boolean {
    return this.reverseIdMap.has(componentId);
  }

  clear(): void {
    this.idMap.clear();
    this.reverseIdMap.clear();
    this.vectors.clear();
    this.nextId = 0;
  }

  serialize(): Buffer {
    return Buffer.from(JSON.stringify({
      dimension: this.dimension,
      indexType: this.indexType,
      nextId: this.nextId,
      vectors: [...this.vectors.entries()].map(([componentId, value]) => ({
        componentId,
        internalId: value.internalId,
        embedding: [...value.embedding],
      })),
    }), 'utf-8');
  }

  static deserialize(data: Buffer, dimension: number, indexType: IndexType): FAISSIndex {
    const parsed = JSON.parse(data.toString('utf-8')) as {
      nextId: number;
      vectors: Array<{ componentId: string; internalId: number; embedding: number[] }>;
    };

    const index = new FAISSIndex(dimension, indexType);
    index.nextId = parsed.nextId;
    for (const { componentId, internalId, embedding } of parsed.vectors) {
      index.idMap.set(internalId, componentId);
      index.reverseIdMap.set(componentId, internalId);
      index.vectors.set(componentId, {
        internalId,
        embedding: Float32Array.from(embedding),
      });
    }
    return index;
  }

  save(filepath: string): void {
    writeFileSync(filepath, this.serialize());
  }

  load(filepath: string): void {
    const parsed = FAISSIndex.deserialize(readFileSync(filepath), this.dimension, this.indexType);
    this.clear();
    this.nextId = parsed.nextId;
    for (const [internalId, componentId] of parsed.idMap) {
      this.idMap.set(internalId, componentId);
    }
    for (const [componentId, internalId] of parsed.reverseIdMap) {
      this.reverseIdMap.set(componentId, internalId);
    }
    for (const [componentId, value] of parsed.vectors) {
      this.vectors.set(componentId, value);
    }
  }

  private ensureDimension(vector: Float32Array, label: string): void {
    if (vector.length !== this.dimension) {
      throw new Error(`${label} dimension mismatch: expected ${this.dimension}, got ${vector.length}`);
    }
  }

  private computeSquaredDistance(a: Float32Array, b: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < this.dimension; i++) {
      const delta = (a[i] ?? 0) - (b[i] ?? 0);
      sum += delta * delta;
    }
    return sum;
  }
}
