import { CodePropertyGraph } from '../vendor/cpg-inference/src/graph.js';
import { GraphBuilder } from '../vendor/cpg-inference/src/graph-builder.js';
import type { CPGNode } from '../vendor/cpg-inference/src/types.js';

export interface AddFileResult {
  filePath: string;
  componentsAdded: number;
  duration: number;
}

/**
 * The local code index: the CPG the parser builds, and its components (functions, methods, classes) by id, for
 * analyze_impact, assign_git_changes and search_codebase. Co-change comes from git history (src/git-cochange.ts),
 * not from this index.
 */
export class CoChangePredictor {
  private readonly cpg: CodePropertyGraph;
  private readonly builder: GraphBuilder;
  componentMap: Map<string, CPGNode>;

  constructor() {
    this.cpg = new CodePropertyGraph();
    this.builder = new GraphBuilder(this.cpg);
    this.componentMap = new Map();
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

  getCPG(): CodePropertyGraph {
    return this.cpg;
  }

  getComponent(componentId: string): CPGNode | null {
    return this.componentMap.get(componentId) ?? null;
  }

  getStats(): { componentsIndexed: number; filesAdded: number } {
    const filePaths = new Set(
      [...this.componentMap.values()]
        .map((node) => (node as CPGNode & { filePath?: string }).filePath)
        .filter((filePath): filePath is string => typeof filePath === 'string'),
    );

    return {
      componentsIndexed: this.componentMap.size,
      filesAdded: filePaths.size,
    };
  }

  private generateComponentId(node: CPGNode, filePath: string): string {
    return `${filePath}::${node.type}::${node.name}::${node.startLine}`;
  }
}
