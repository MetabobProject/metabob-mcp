/**
 * concept_usage_stats — per-concept usage timeline + aggregates.
 *
 * Returns both the lifetime aggregate (success_rate, total_uses) and the
 * recent usage rows (trace_id + outcome + recorded_at). Lets MCP-side
 * agents distinguish "concept has high lifetime relevance" from "concept
 * is currently active." Pairs with concept_search (find what's there)
 * and concept_neighbors (find what's related).
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

const DEFAULT_CONCEPT_DB_URL = process.env.CONCEPT_DB_URL || 'http://127.0.0.1:18260';

export const ConceptUsageStatsTool = {
  name: 'concept_usage_stats',
  description:
    'Get usage statistics and recent history for a concept. Returns aggregate counters (total_uses, success_rate, failure_rate) plus the most recent usage rows with trace_id, outcome, and timestamp. Use to distinguish lifetime relevance from current activity.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      concept_id: {
        type: 'string',
        description: 'Concept id (without the "concept:" prefix).',
      },
      include_history: {
        type: 'boolean',
        description: 'Include recent usage rows (default: true)',
        default: true,
      },
      history_limit: {
        type: 'number',
        description: 'Max usage rows to return (default: 10, max: 50)',
        default: 10,
      },
    },
    required: ['concept_id'],
  },
};

export const InputSchema = z.object({
  concept_id: z.string().min(1),
  include_history: z.boolean().default(true),
  history_limit: z.number().int().positive().max(50).default(10),
});

export type ConceptUsageStatsInput = z.infer<typeof InputSchema>;

interface StatsResponse {
  total_uses?: number;
  success_rate?: number;
  failure_rate?: number;
  neutral_rate?: number;
}

interface UsageRow {
  id?: string;
  trace_id?: string;
  activity_id?: string | null;
  outcome?: string;
  recorded_at?: string;
}

interface HistoryResponse {
  usage?: UsageRow[];
}

export async function handle(
  input: ConceptUsageStatsInput,
  apiClient: AnalysisAPIClient,
): Promise<string> {
  if (!apiClient.isVesselMode()) {
    return 'concept_usage_stats is only available in vessel mode.';
  }

  const start = Date.now();
  const apiKey = process.env.METABOB_API_KEY;
  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;

  const idEnc = encodeURIComponent(input.concept_id);
  const statsUrl = `${DEFAULT_CONCEPT_DB_URL}/concepts/${idEnc}/stats`;

  let statsRes: Response;
  try {
    statsRes = await fetch(statsUrl, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `concept_usage_stats failed to reach ${DEFAULT_CONCEPT_DB_URL}: ${msg}`;
  }
  if (!statsRes.ok) {
    return `concept_usage_stats: ${statsRes.status} ${(await statsRes.text().catch(() => '')).slice(0, 200)}`;
  }
  const stats = (await statsRes.json()) as StatsResponse;

  let history: UsageRow[] = [];
  if (input.include_history) {
    const historyUrl = `${DEFAULT_CONCEPT_DB_URL}/concepts/${idEnc}/usage?limit=${input.history_limit}`;
    try {
      const histRes = await fetch(historyUrl, { headers, signal: AbortSignal.timeout(10_000) });
      if (histRes.ok) {
        const histPayload = (await histRes.json()) as HistoryResponse;
        history = histPayload.usage ?? [];
      }
    } catch {
      // history is non-fatal; carry on with stats only
    }
  }

  const duration = Date.now() - start;

  const sr = typeof stats.success_rate === 'number' ? stats.success_rate.toFixed(2) : '–';
  const fr = typeof stats.failure_rate === 'number' ? stats.failure_rate.toFixed(2) : '–';

  let text = `Concept ${input.concept_id}\n\n`;
  text += `Aggregate:\n`;
  text += `  total_uses:   ${stats.total_uses ?? 0}\n`;
  text += `  success_rate: ${sr}\n`;
  text += `  failure_rate: ${fr}\n\n`;

  if (input.include_history) {
    if (history.length === 0) {
      text += 'No recent usage rows.\n';
    } else {
      text += `Recent usage (${history.length}):\n`;
      for (let i = 0; i < history.length; i++) {
        const u = history[i]!;
        text += `  ${i + 1}. [${u.outcome ?? '?'}] ${u.recorded_at ?? ''}\n`;
        text += `       trace_id: ${u.trace_id ?? '-'}\n`;
        if (u.activity_id) text += `       activity: ${u.activity_id}\n`;
      }
      text += '\n';
    }
  }

  text += `Query completed in ${duration}ms.`;
  return text;
}
