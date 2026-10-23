// Contract (input schema, behaviour): SPEC §assign_git_changes
import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { activeWorkspacePath, getLocalIndex } from '../local-index.js';
import { seedCacheTag, type LocalStore } from '../local-store.js';
import { mineGitCochanges } from '../git-cochange.js';
import { gapSummaryLines } from './_gap-activity.js';

export const AssignGitChangesTool = {
  name: 'assign_git_changes',
  description:
    'Assign git changes (changed files or diff) to the CPG components they affect. Returns a map of file → components, component IDs for downstream tools, and the files that change together with these in git history. Requires init_workspace to have been run first.',
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
        description: 'Also return the files that change together with these in git history (default: true)',
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

export async function handle(
  input: AssignGitChangesInput,
  _apiClient: AnalysisAPIClient,
  _sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  const startTime = Date.now();

  // ── Local store: known problems in the changed files ──────────────────────
  let sidecarSeedText = '';
  let cacheTag: string | null = null;
  if (localStore && input.changed_files.length > 0) {
    const allSeeds: ReturnType<LocalStore['getCachedSeeds']> = [];
    for (const f of input.changed_files) {
      allSeeds.push(...localStore.getCachedSeeds(f));
    }
    if (allSeeds.length > 0) {
      cacheTag = seedCacheTag(allSeeds);
      sidecarSeedText = `\nKnown problems in changed files (local store, ${allSeeds.length}):\n`;
      for (const s of allSeeds.slice(0, 10)) {
        sidecarSeedText += `  • [${s.severity}] ${s.category}  ${s.file_path}:${s.line_start}  ${s.brief}\n`;
      }
      if (allSeeds.length > 10) sidecarSeedText += `  … and ${allSeeds.length - 10} more\n`;
    }
  }

  const localIndex = getLocalIndex();

  if (!localIndex.isReady()) {
    return localIndex.notReadyMessage();
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

  // Git-history co-change — the primary "did I miss a lockstep sibling?" signal.
  if (input.include_cochange_predictions) {
    const workspaceRoot = localIndex.workspacePath();
    const gitPreds = workspaceRoot
      ? await mineGitCochanges(workspaceRoot, input.changed_files, input.prediction_limit * 2)
      : [];
    if (gitPreds.length > 0) {
      text += `Co-changes from git history (files that historically move with this diff):\n`;
      for (const p of gitPreds) {
        text += `  • ${p.filePath}  ${(p.confidence * 100).toFixed(0)}% (${p.cooccurrences} commit${p.cooccurrences === 1 ? '' : 's'})\n`;
      }
      text += '\n';
    }
  }

  text += `Completed in ${duration}ms`;
  if (sidecarSeedText) text += sidecarSeedText;
  const inFlight = await gapSummaryLines(input.changed_files, activeWorkspacePath());
  if (inFlight.length) text += `\n${inFlight.join('\n')}`;
  if (cacheTag) text += `\n\n${cacheTag}`;
  return text;
}
