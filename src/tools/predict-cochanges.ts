import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { getLocalIndex } from '../local-index.js';
import type { LocalStore } from '../local-store.js';

export const PredictCochangesTool = {
  name: 'predict_cochanges',
  description:
    'Predict which files and components should be changed together with the given files. Runs locally via the embedded GCN model — no API call required. Requires init_workspace to have been run first.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      changed_files: {
        type: 'array',
        description: 'Files currently being changed (absolute or workspace-relative paths)',
        items: { type: 'string' },
      },
      limit: {
        type: 'number',
        description: 'Max suggestions (default: 10)',
        default: 10,
      },
      confidence_threshold: {
        type: 'number',
        description: 'Minimum similarity score 0.0–1.0 (default: 0.3)',
        default: 0.3,
      },
    },
    required: ['changed_files'],
  },
};

export const InputSchema = z.object({
  changed_files: z.array(z.string()).min(1),
  limit: z.number().int().positive().max(50).default(10),
  confidence_threshold: z.number().min(0).max(1).default(0.3),
});

export type PredictCochangesInput = z.infer<typeof InputSchema>;

export async function handle(
  input: PredictCochangesInput,
  _apiClient: AnalysisAPIClient,
  _sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  const startTime = Date.now();

  // ── Sidecar mode: surface cached seeds as change context ──────────────────
  if (localStore && input.changed_files.length > 0) {
    const allSeeds: ReturnType<LocalStore['getCachedSeeds']> = [];
    let hasCache = false;
    let oldestAgeMs = 0;
    let anyStale = false;

    for (const f of input.changed_files) {
      const seeds = localStore.getCachedSeeds(f);
      const freshness = localStore.getFreshness(f);
      if (seeds.length > 0) { hasCache = true; allSeeds.push(...seeds); }
      if (freshness.age_ms !== Infinity && freshness.age_ms > oldestAgeMs) {
        oldestAgeMs = freshness.age_ms;
      }
      if (freshness.stale) anyStale = true;
    }

    if (!hasCache) {
      for (const f of input.changed_files) {
        localStore.enqueue(f, 0 /* P0 */, 'default');
      }
      return `No cached analysis for changed files. Analysis queued — try again in a few seconds.\n\n[cache: warming]`;
    }

    if (hasCache && allSeeds.length > 0) {
      const ageSec = Math.round(oldestAgeMs / 1000);
      const cacheTag = `[cache: ${ageSec}s old${anyStale ? ', stale' : ''}]`;
      const shown = allSeeds.slice(0, input.limit);

      let text = `Co-change context (from cache) for:\n`;
      for (const f of input.changed_files) text += `  - ${f}\n`;
      text += `\n${shown.length} related problem${shown.length === 1 ? '' : 's'} in changed files:\n\n`;
      for (let i = 0; i < shown.length; i++) {
        const s = shown[i]!;
        text += `${i + 1}. [${s.severity}] ${s.category}  ${s.file_path}:${s.line_start}\n`;
        text += `   ${s.brief}\n   id: ${s.id}\n\n`;
      }
      text += `Query completed in ${Date.now() - startTime}ms\n\n${cacheTag}`;
      return text;
    }
  }

  const localIndex = getLocalIndex();

  if (!localIndex.isReady()) {
    return 'Workspace not indexed. Run init_workspace first.';
  }

  const stats = localIndex.stats();
  if (stats.componentsIndexed === 0) {
    return 'No components in index. Run init_workspace to parse the workspace.';
  }

  // Resolve component IDs for the changed files
  const componentIds: string[] = [];
  for (const file of input.changed_files) {
    const ids = localIndex.componentIdsForFile(file);
    componentIds.push(...ids);
  }

  if (componentIds.length === 0) {
    return (
      `No indexed components found for:\n` +
      input.changed_files.map(f => `  - ${f}`).join('\n') +
      `\n\nRun init_workspace again after saving the files, or check the paths.`
    );
  }

  const predictions = await localIndex.predictor.predictCochanges(componentIds, input.limit);
  const filtered = predictions.filter(p => p.similarityScore >= input.confidence_threshold);

  const duration = Date.now() - startTime;

  if (filtered.length === 0) {
    return (
      `No co-change predictions above ${(input.confidence_threshold * 100).toFixed(0)}% confidence for:\n` +
      input.changed_files.map(f => `  - ${f}`).join('\n') +
      `\n\nThese files can likely be changed independently.`
    );
  }

  let text = `Co-change predictions for:\n`;
  for (const f of input.changed_files) text += `  - ${f}\n`;
  text += `\n${filtered.length} suggestion${filtered.length === 1 ? '' : 's'}:\n\n`;

  for (let i = 0; i < filtered.length; i++) {
    const p = filtered[i]!;
    text += `${i + 1}. ${p.componentName} (${p.componentType})\n`;
    text += `   File:       ${p.filePath}:${p.startLine}\n`;
    text += `   Confidence: ${(p.similarityScore * 100).toFixed(1)}%\n`;
    text += `   ID:         ${p.componentId}\n\n`;
  }

  text += `\nModel: embedded GCN (${stats.componentsIndexed} components indexed)\n`;
  text += `Query completed in ${duration}ms`;
  return text;
}
