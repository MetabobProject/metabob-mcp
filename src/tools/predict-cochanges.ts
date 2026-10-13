// Contract (input schema, behaviour): SPEC §predict_cochanges
import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { getLocalIndex } from '../local-index.js';
import type { LocalStore } from '../local-store.js';
import { mineGitCochanges } from '../git-cochange.js';

export const PredictCochangesTool = {
  name: 'predict_cochanges',
  description:
    'Predict which files and components should be changed together with the given files. Combines git-history co-change mining (primary) with a GCN name-similarity ranking (secondary — the model sees only node-name char-codes, not learned structure) — all local, no API call. Requires init_workspace to have been run first.',
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

  const localIndex = getLocalIndex();

  if (!localIndex.isReady()) {
    return 'Workspace not indexed. Run init_workspace first.';
  }

  const stats = localIndex.stats();
  if (stats.componentsIndexed === 0) {
    return 'No components in index. Run init_workspace to parse the workspace.';
  }

  // ── Primary signal: git-history co-change mining ──────────────────────────
  const workspaceRoot = localIndex.workspacePath();
  const gitPredictions = workspaceRoot
    ? (await mineGitCochanges(workspaceRoot, input.changed_files, input.limit)).filter(
        p => p.confidence >= input.confidence_threshold,
      )
    : [];

  // ── Secondary signal: GCN name-similarity ranking (NOT structural) ────────
  const componentIds: string[] = [];
  for (const file of input.changed_files) {
    componentIds.push(...localIndex.componentIdsForFile(file));
  }
  const filesNotIndexed = componentIds.length === 0;
  const gcnPredictions =
    componentIds.length > 0
      ? (await localIndex.predictor.predictCochanges(componentIds, input.limit)).filter(
          p => p.similarityScore >= input.confidence_threshold,
        )
      : [];

  const duration = Date.now() - startTime;

  if (filesNotIndexed && gitPredictions.length === 0) {
    return (
      `Files not in the local index:\n` +
      input.changed_files.map(f => `  - ${f}`).join('\n') +
      `\n\nIndex coverage: ${stats.filesIndexed} files, ${stats.componentsIndexed} components indexed.` +
      `\nThese files are not yet indexed — run init_workspace.` +
      `\n(Git-history mining also found no co-changes above the threshold.)`
    );
  }

  if (gitPredictions.length === 0 && gcnPredictions.length === 0) {
    return (
      `No co-change predictions above ${(input.confidence_threshold * 100).toFixed(0)}% confidence for:\n` +
      input.changed_files.map(f => `  - ${f}`).join('\n') +
      `\n\nThese files can likely be changed independently.` +
      `\n(Caveat: git-history mining can miss files — verify with a grep of the changed symbol.)`
    );
  }

  let text = `Co-change predictions for:\n`;
  for (const f of input.changed_files) text += `  - ${f}\n`;

  if (gitPredictions.length > 0) {
    text += `\nFrom git history (files that change together with these — PRIMARY signal):\n\n`;
    for (let i = 0; i < gitPredictions.length; i++) {
      const p = gitPredictions[i]!;
      text += `${i + 1}. ${p.filePath}\n`;
      text += `   Confidence: ${(p.confidence * 100).toFixed(0)}% (co-changed in ${p.cooccurrences} commit${p.cooccurrences === 1 ? '' : 's'})\n`;
    }
    text += `\nCaveat: history mining can miss files (known false negatives) — verify with a grep of the changed symbol.\n`;
  }

  if (filesNotIndexed) {
    text += `\nNote: none of the changed files are in the local index (${stats.filesIndexed} files, ${stats.componentsIndexed} components indexed) — not yet indexed; run init_workspace. Name-similarity ranking skipped.\n`;
  }

  if (gcnPredictions.length > 0) {
    text += `\nName-similarity ranking (experimental; NOT structural evidence — the GCN sees only component-name characters, and its scores are not probabilities):\n\n`;
    for (let i = 0; i < gcnPredictions.length; i++) {
      const p = gcnPredictions[i]!;
      text += `${i + 1}. ${p.componentName} (${p.componentType})\n`;
      text += `   File: ${p.filePath}:${p.startLine}\n`;
      text += `   ID:   ${p.componentId}\n`;
    }
  }

  text += `\nSignals: git history (${gitPredictions.length}) + name-similarity (${gcnPredictions.length}, ${stats.componentsIndexed} components indexed)\n`;
  text += `Query completed in ${duration}ms`;

  // ── Sidecar mode: append cached problem seeds as supplementary context.
  // Never gates the GCN prediction above — an empty cache just enqueues the
  // files for background analysis and stays silent.
  if (localStore) {
    const allSeeds: ReturnType<LocalStore['getCachedSeeds']> = [];
    let oldestAgeMs = 0;
    let anyStale = false;

    for (const f of input.changed_files) {
      const seeds = localStore.getCachedSeeds(f);
      const freshness = localStore.getFreshness(f);
      if (seeds.length > 0) allSeeds.push(...seeds);
      if (freshness.age_ms !== Infinity && freshness.age_ms > oldestAgeMs) {
        oldestAgeMs = freshness.age_ms;
      }
      if (freshness.stale) anyStale = true;
    }

    if (allSeeds.length === 0) {
      for (const f of input.changed_files) {
        localStore.enqueue(f, 0 /* P0 */, 'default');
      }
    } else {
      const ageSec = Math.round(oldestAgeMs / 1000);
      const shown = allSeeds.slice(0, input.limit);
      text += `\n\nKnown problems in changed files (cached, ${ageSec}s old${anyStale ? ', stale' : ''}):\n`;
      for (const s of shown) {
        text += `  • [${s.severity}] ${s.category}  ${s.file_path}:${s.line_start} — ${s.brief}\n    id: ${s.id}\n`;
      }
    }
  }

  return text;
}
