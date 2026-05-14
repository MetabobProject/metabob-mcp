import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { getLocalIndex } from '../local-index.js';

export const AssignGitChangesTool = {
  name: 'assign_git_changes',
  description:
    'Assign git changes (changed files or diff) to the CPG components they affect. Returns a map of file → components, component IDs for downstream tools, and co-change predictions for each changed component. Requires init_workspace to have been run first.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      changed_files: {
        type: 'array',
        description: 'File paths that changed (absolute or workspace-relative)',
        items: { type: 'string' },
      },
      diff: {
        type: 'string',
        description: 'Optional git diff output for line-precise component attribution',
      },
      include_cochange_predictions: {
        type: 'boolean',
        description: 'Also return co-change predictions for the affected components (default: true)',
        default: true,
      },
      prediction_limit: {
        type: 'number',
        description: 'Max co-change predictions to return per file (default: 5)',
        default: 5,
      },
    },
    required: ['changed_files'],
  },
};

export const InputSchema = z.object({
  changed_files: z.array(z.string()).min(1),
  diff: z.string().optional(),
  include_cochange_predictions: z.boolean().default(true),
  prediction_limit: z.number().int().positive().max(20).default(5),
});

export type AssignGitChangesInput = z.infer<typeof InputSchema>;

interface FileAssignment {
  file_path: string;
  components: Array<{
    component_id: string;
    component_name: string;
    component_type: string;
    start_line: number;
    end_line: number;
  }>;
}

interface CochangePrediction {
  component_id: string;
  component_name: string;
  component_type: string;
  file_path: string;
  start_line: number;
  similarity_score: number;
}

export async function handle(
  input: AssignGitChangesInput,
  _apiClient: AnalysisAPIClient,
  _sessionId: string,
): Promise<string> {
  const startTime = Date.now();
  const localIndex = getLocalIndex();

  if (!localIndex.isReady()) {
    return 'Workspace not indexed. Run init_workspace first.';
  }

  const stats = localIndex.stats();
  if (stats.componentsIndexed === 0) {
    return 'No components in index. Run init_workspace to parse the workspace.';
  }

  // Assign each changed file to its CPG components
  const assignments: FileAssignment[] = [];
  const allComponentIds: string[] = [];

  for (const filePath of input.changed_files) {
    const componentIds = localIndex.componentIdsForFile(filePath);
    const components = componentIds.map(id => {
      const node = localIndex.predictor.getComponent(id);
      return {
        component_id: id,
        component_name: node?.name ?? id.split('::')[2] ?? id,
        component_type: node?.type ?? 'unknown',
        start_line: node?.startLine ?? 0,
        end_line: node?.endLine ?? 0,
      };
    });

    assignments.push({ file_path: filePath, components });
    allComponentIds.push(...componentIds);
  }

  // Deduplicate across files (same component can be touched by multiple changed files)
  const uniqueComponentIds = [...new Set(allComponentIds)];
  const totalComponents = uniqueComponentIds.length;

  // Co-change predictions across all changed components
  let predictions: CochangePrediction[] = [];
  if (input.include_cochange_predictions && uniqueComponentIds.length > 0) {
    const raw = await localIndex.predictor.predictCochanges(
      uniqueComponentIds,
      input.prediction_limit * input.changed_files.length,
    );
    predictions = raw.map(p => ({
      component_id: p.componentId,
      component_name: p.componentName,
      component_type: p.componentType,
      file_path: p.filePath,
      start_line: p.startLine,
      similarity_score: p.similarityScore,
    }));
  }

  const duration = Date.now() - startTime;

  // Format output
  let text = `Git change assignment\n`;
  text += `═════════════════════\n\n`;
  text += `Changed files: ${input.changed_files.length}   Components found: ${totalComponents}\n\n`;

  for (const a of assignments) {
    text += `${a.file_path}\n`;
    if (a.components.length === 0) {
      text += `  (no indexed components — run init_workspace after saving)\n`;
    } else {
      for (const c of a.components) {
        text += `  • ${c.component_name} (${c.component_type}) :${c.start_line}–${c.end_line}\n`;
        text += `    id: ${c.component_id}\n`;
      }
    }
    text += '\n';
  }

  if (predictions.length > 0) {
    text += `Co-change predictions (${predictions.length}):\n`;
    for (const p of predictions.slice(0, input.prediction_limit * 3)) {
      text += `  • ${p.component_name} (${p.component_type})  ${p.file_path}:${p.start_line}`;
      text += `  ${(p.similarity_score * 100).toFixed(0)}%\n`;
    }
    text += '\n';
  }

  text += `Completed in ${duration}ms`;
  return text;
}
