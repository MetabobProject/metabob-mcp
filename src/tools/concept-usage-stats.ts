// Contract (input schema, behaviour): SPEC §concept_usage_stats
/**
 * concept_usage_stats — per-concept usage timeline + aggregates.
 *
 * Returns both the lifetime aggregate (success_rate, total_uses) and the
 * recent usage rows (trace_id + outcome + recorded_at). Lets MCP-side
 * agents distinguish "concept has high lifetime relevance" from "concept
 * is currently active." Pairs with concept_search (find what's there)
 * and concept_neighbors (find what's related).
 *
 * The aggregate is the `conceptUsageStats` shape through discovery
 * `POST /resolve` (src/tools/_concept-db.ts). The recent rows have no shape;
 * see fetchUsageHistory. CONFORMANCE §c11-attachment-model
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { RESOLVE_TIMEOUT_MS, describeResolveFailure, getAttachment, resolveShape } from '../attachment.js';
import { classifyNetError, netFetch, type NetInit } from '../net.js';
import { conceptUsageStats } from './_concept-db.js';
import { plainConceptId } from './_concept-content.js';

export const ConceptUsageStatsTool = {
  name: 'concept_usage_stats',
  description:
    'Get usage statistics and recent history for a concept. Returns aggregate counters (total_uses, success_rate, failure_rate) plus the most recent usage rows with trace_id, outcome, and timestamp. Use to distinguish lifetime relevance from current activity.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      concept_id: {
        type: 'string',
        description: 'Concept id, with or without the "concept:" prefix.',
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

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

// @anchor usage-history-direct-edge
/**
 * Recent usage rows: the one direct REST call the substrate tools still make
 * (CONFORMANCE §c11-attachment-model records it). No concept-db shape serves
 * usage history — `conceptUsageStats` answers only the aggregate — so this
 * reads `GET /concepts/:id/usage` from concept-db itself. concept-db is located
 * through discovery's own `vesselCapability` shape (through the attachment);
 * a loopback endpoint from a remote discovery is taken onto discovery's host.
 * Best-effort: a failure is reported in one line naming its cause, and the
 * stats still render. It takes the attachment's request path — the one
 * outbound path (src/net.ts@net-request) — so the proxy, trust and connect
 * budget are those of every other request.
 */
/** How long the direct read of recent rows may take: short, since the aggregate already answers. */
const HISTORY_TIMEOUT_MS = 3_000;

/** RFC 1918, CGNAT and link-local IPv4: addresses another host's private network uses. */
function isPrivateAddress(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

async function fetchUsageHistory(conceptId: string, limit: number): Promise<{ rows: UsageRow[] } | { error: string }> {
  let base: string | undefined;
  try {
    const cap = await resolveShape(
      { type: 'vesselCapability', shape: 'conceptUsageStats' },
      { timeoutMs: RESOLVE_TIMEOUT_MS.discovery, read: true },
    );
    const vessel = (cap.body as { content?: { vessels?: Array<{ endpoint?: string; public_endpoint?: string }> } })
      ?.content?.vessels?.[0];
    base = (vessel?.public_endpoint || vessel?.endpoint)?.replace(/\/+$/, '');
  } catch (err) {
    return { error: describeResolveFailure(err) };
  }
  if (!base) return { error: 'no vessel advertises conceptUsageStats, so concept-db has no endpoint to read history from' };

  const discovery = getAttachment()?.state().anchor.discovery;
  try {
    const url = new URL(base);
    if (discovery && LOOPBACK_HOSTS.includes(url.hostname) && !LOOPBACK_HOSTS.includes(new URL(discovery).hostname)) {
      url.hostname = new URL(discovery).hostname;
      base = url.toString().replace(/\/+$/, '');
    }
  } catch {
    return { error: `concept-db's advertised endpoint ${base} does not parse` };
  }

  // The recent rows come from concept-db's own address, not through discovery. A private address on another host than
  // discovery is almost always out of reach from here, so it is not dialled; an agent waits for nothing.
  try {
    const host = new URL(base).hostname;
    const anchorHost = discovery ? new URL(discovery).hostname : null;
    if (isPrivateAddress(host) && host !== anchorHost) {
      return { error: `recent rows come from concept-db directly at ${base}, a private address on another host than discovery, which this machine cannot reach; the aggregate above is complete` };
    }
  } catch { /* parsed above */ }

  const headers: Record<string, string> = {};
  const apiKey = process.env.METABOB_API_KEY;
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;
  const fetchImpl = getAttachment()?.fetch ?? netFetch();
  const url = `${base}/concepts/${encodeURIComponent(conceptId)}/usage?limit=${limit}`;
  try {
    const res = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS + 1_000),
      net: { timeoutMs: HISTORY_TIMEOUT_MS },
    } as NetInit);
    if (!res.ok) return { error: `recent rows come from concept-db directly at ${base}, which answered HTTP ${res.status}; the aggregate above is complete` };
    return { rows: ((await res.json()) as HistoryResponse).usage ?? [] };
  } catch (err) {
    const line = classifyNetError(err)?.line;
    const cause = (line && /^[a-z_]+(?:\([^)]*\))?/.exec(line)?.[0]) ?? (err instanceof Error ? err.message : String(err));
    return { error: `recent rows come from concept-db directly at ${base}, which did not answer from here (${cause}); the aggregate above is complete` };
  }
}

export async function handle(
  input: ConceptUsageStatsInput,
  _apiClient: AnalysisAPIClient,
): Promise<string> {
  const start = Date.now();

  const conceptId = plainConceptId(input.concept_id);
  const statsRead = await conceptUsageStats(conceptId);
  if (!statsRead.ok) {
    return `concept_usage_stats: ${statsRead.error}`;
  }
  const stats = statsRead.value as StatsResponse;

  let history: UsageRow[] = [];
  let historyError: string | null = null;
  if (input.include_history) {
    // history is non-fatal; carry on with stats only, and name why it is missing
    const read = await fetchUsageHistory(conceptId, input.history_limit);
    if ('rows' in read) history = read.rows;
    else historyError = read.error;
  }

  const duration = Date.now() - start;

  const sr = typeof stats.success_rate === 'number' ? stats.success_rate.toFixed(2) : '–';
  const fr = typeof stats.failure_rate === 'number' ? stats.failure_rate.toFixed(2) : '–';

  let text = `Concept ${conceptId}\n\n`;
  text += `Aggregate:\n`;
  text += `  total_uses:   ${stats.total_uses ?? 0}\n`;
  text += `  success_rate: ${sr}\n`;
  text += `  failure_rate: ${fr}\n\n`;

  if (input.include_history) {
    if (historyError) {
      text += `Recent usage: unavailable — ${historyError}\n\n`;
    } else if (history.length === 0) {
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
