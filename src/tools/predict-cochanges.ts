// Contract (input schema, behaviour): SPEC §predict_cochanges
import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { activeWorkspacePath } from '../local-index.js';
import { seedCacheTag, type LocalStore } from '../local-store.js';
import { mineGitCochanges } from '../git-cochange.js';

export const PredictCochangesTool = {
  name: 'predict_cochanges',
  description:
    'Predict which files should be changed together with the given files, from git history: the files that changed in the same commits, with a confidence (the share of the given files\' commits that also touched each). Local, no API call; needs a git checkout, not init_workspace.',
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
        description: 'Minimum git co-change confidence 0.0–1.0 (default: 0.3)',
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

  // Git history is the signal (src/git-cochange.ts); it needs no index. The workspace is init_workspace's, else the
  // configured one (SPEC §workspace).
  const workspaceRoot = activeWorkspacePath();
  const gitPredictions = (await mineGitCochanges(workspaceRoot, input.changed_files, input.limit)).filter(
    p => p.confidence >= input.confidence_threshold,
  );

  const duration = Date.now() - startTime;

  if (gitPredictions.length === 0) {
    return (
      `No co-change predictions above ${(input.confidence_threshold * 100).toFixed(0)}% confidence in git history for:\n` +
      input.changed_files.map(f => `  - ${f}`).join('\n') +
      `\n\nThese files can likely be changed independently.` +
      `\n(Caveat: git-history mining can miss files — verify with a grep of the changed symbol.)`
    );
  }

  let text = `Co-change predictions for:\n`;
  for (const f of input.changed_files) text += `  - ${f}\n`;

  text += `\nFrom git history (files that change together with these):\n\n`;
  for (let i = 0; i < gitPredictions.length; i++) {
    const p = gitPredictions[i]!;
    text += `${i + 1}. ${p.filePath}\n`;
    text += `   Confidence: ${(p.confidence * 100).toFixed(0)}% (co-changed in ${p.cooccurrences} commit${p.cooccurrences === 1 ? '' : 's'})\n`;
  }
  text += `\nCaveat: history mining can miss files (known false negatives) — verify with a grep of the changed symbol.\n`;

  text += `\nSignal: git history (${gitPredictions.length})\n`;
  text += `Query completed in ${duration}ms`;

  // ── Local store: append known problems in the changed files as
  // supplementary context. Never gates the prediction above; with no
  // findings it stays silent.
  if (localStore) {
    const allSeeds: ReturnType<LocalStore['getCachedSeeds']> = [];
    for (const f of input.changed_files) {
      allSeeds.push(...localStore.getCachedSeeds(f));
    }

    if (allSeeds.length > 0) {
      const shown = allSeeds.slice(0, input.limit);
      text += `\n\nKnown problems in changed files (local store) ${seedCacheTag(allSeeds)}:\n`;
      for (const s of shown) {
        text += `  • [${s.severity}] ${s.category}  ${s.file_path}:${s.line_start} — ${s.brief}\n    id: ${s.id}\n`;
      }
    }
  }

  return text;
}
