// Contract (input schema, behaviour): SPEC §get_metrics
import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import type { LocalStore } from '../local-store.js';

export const GetMetricsTool = {
  name: 'get_metrics',
  description:
    'Retrieve session and project metrics. Combines GET /metrics, GET /session/stats, and GET /analysis to give an overview of analysis health.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

export const InputSchema = z.object({});

export type GetMetricsInput = z.infer<typeof InputSchema>;

export async function handle(
  _input: GetMetricsInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  const startTime = Date.now();

  // ── Sidecar mode: include local cache summary ─────────────────────────────
  let cacheTag: string | null = null;
  let cacheSummaryText = '';
  if (localStore) {
    // Best-effort: query total seeds from the store's internal db
    try {
      const db = (localStore as any)['db'];
      if (db) {
        const row = db.query('SELECT COUNT(*) as cnt FROM seeds WHERE stale = 0').get() as { cnt: number } | null;
        const total = row?.cnt ?? 0;
        cacheSummaryText = `\nLocal cache: ${total} cached seed${total === 1 ? '' : 's'} (non-stale)`;
        cacheTag = `[cache: local store active]`;
      }
    } catch {
      // Non-fatal
    }
  }

  const [metricsResult, sessionResult, analysisResult] = await Promise.allSettled([
    apiClient.get<Record<string, unknown>>('/metrics', {}, sessionId),
    apiClient.get<Record<string, unknown>>('/session/stats', {}, sessionId),
    apiClient.getAnalysis(sessionId),
  ]);

  const duration = Date.now() - startTime;

  let text = `Session Metrics\n${'═'.repeat(40)}\n\n`;

  // Analysis summary (always available if files submitted)
  if (analysisResult.status === 'fulfilled') {
    const a = analysisResult.value;
    const results = a.results ?? [];
    const bySeverity: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    let discarded = 0;
    let endorsed = 0;
    for (const r of results) {
      const sev = r.severity ?? 'LOW';
      bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
      byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
      if (r.discarded) discarded++;
      if (r.endorsed) endorsed++;
    }
    text += `Analysis status: ${a.status}${a.jobId ? `  (job: ${a.jobId})` : ''}\n`;
    text += `Problems detected: ${results.length}`;
    if (results.length > 0) {
      const sevStr = Object.entries(bySeverity).sort(([a], [b]) => a.localeCompare(b)).map(([s, n]) => `${s}: ${n}`).join('  ');
      text += `  [${sevStr}]`;
    }
    text += '\n';
    if (endorsed > 0 || discarded > 0) {
      text += `  Endorsed: ${endorsed}   Discarded: ${discarded}\n`;
    }
    if (Object.keys(byCategory).length > 0) {
      const catStr = Object.entries(byCategory).sort(([, a], [, b]) => b - a).slice(0, 5).map(([c, n]) => `${c}: ${n}`).join('  ');
      text += `  Top categories: ${catStr}\n`;
    }
    text += '\n';
  }

  // Session stats
  if (sessionResult.status === 'fulfilled') {
    text += `Session stats:\n${JSON.stringify(sessionResult.value, null, 2)}\n\n`;
  }

  // Metrics endpoint
  if (metricsResult.status === 'fulfilled') {
    text += `Metrics:\n${JSON.stringify(metricsResult.value, null, 2)}\n\n`;
  }

  text += `Fetched in ${duration}ms`;
  if (cacheSummaryText) text += cacheSummaryText;
  if (cacheTag) text += `\n\n${cacheTag}`;
  return text;
}
