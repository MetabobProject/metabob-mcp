// Contract (input schema, behaviour): SPEC §get_metrics
import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { getLocalIndex } from '../local-index.js';
import type { LocalStore } from '../local-store.js';
import { noServerAnalysis } from './_findings.js';

export const GetMetricsTool = {
  name: 'get_metrics',
  description:
    'Summarise this workspace\'s local analysis state: open findings in the local store by severity, category and source, and the local CPG index size. Makes no network request; there is no server-side analysis to report on.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

export const InputSchema = z.object({});

export type GetMetricsInput = z.infer<typeof InputSchema>;

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

export async function handle(
  _input: GetMetricsInput,
  _apiClient: AnalysisAPIClient,
  _sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  const startTime = Date.now();
  let text = `Session Metrics\n${'═'.repeat(40)}\n\n`;

  // ── Findings in the local store (this workspace, open only) ───────────────
  if (localStore) {
    const seeds = localStore.getAllCachedSeeds();
    const agentRecorded = seeds.filter(s => s.id.startsWith('agf_')).length;
    text += `Open findings in the local store: ${seeds.length}`;
    if (seeds.length > 0) {
      const sevStr = Object.entries(countBy(seeds, s => s.severity.toUpperCase()))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([s, n]) => `${s}: ${n}`)
        .join('  ');
      text += `  [${sevStr}]`;
    }
    text += '\n';
    if (seeds.length > 0) {
      text += `  Agent-recorded (agf_*): ${agentRecorded}   Other: ${seeds.length - agentRecorded}\n`;
      const catStr = Object.entries(countBy(seeds, s => s.category))
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([c, n]) => `${c}: ${n}`)
        .join('  ');
      text += `  Top categories: ${catStr}\n`;
    }
  } else {
    text += `Local store: unavailable (it failed to open; see the startup log)\n`;
  }
  text += '\n';

  // ── Local CPG index ───────────────────────────────────────────────────────
  const localIndex = getLocalIndex();
  if (localIndex.isReady() && localIndex.stats().filesIndexed > 0) {
    const stats = localIndex.stats();
    text += `Local CPG: ${stats.filesIndexed} files, ${stats.componentsIndexed} components`;
    if (stats.workspacePath) text += ` (${stats.workspacePath})`;
    text += '\n\n';
  } else {
    text += `Local CPG: not initialised (run init_workspace)\n\n`;
  }

  text += `${noServerAnalysis()}\n\n`;
  text += `Computed locally in ${Date.now() - startTime}ms`;
  return text;
}
