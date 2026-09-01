import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { getLocalIndex } from '../local-index.js';
import type { LocalStore } from '../local-store.js';

export const SearchCodebaseTool = {
  name: 'search_codebase',
  description:
    'Search the codebase for problems or components matching a query. Searches both local CPG components (by name) and analysis results (by category/summary). Run init_workspace first for best results.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search term — matched against component names, file paths, problem categories and summaries',
      },
      limit: {
        type: 'number',
        description: 'Max results (default: 10, max: 50)',
        default: 10,
      },
      target: {
        type: 'string',
        description: '"components" — local CPG index. "problems" — analysis results. "both" — (default)',
        enum: ['components', 'problems', 'both'],
        default: 'both',
      },
      file_filter: {
        type: 'array',
        description: 'Narrow to these file paths (substring match)',
        items: { type: 'string' },
      },
    },
    required: ['query'],
  },
};

export const InputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).default(10),
  target: z.enum(['components', 'problems', 'both']).default('both'),
  file_filter: z.array(z.string()).optional(),
});

export type SearchCodebaseInput = z.infer<typeof InputSchema>;

/** Split an identifier into lowercase tokens — handles camelCase, snake_case, kebab-case. */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → camel Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // HTMLParser → HTML Parser
    .split(/[\s_\-./\\:]+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length > 1);
}

function matchesQuery(text: string, queryTokens: string[]): boolean {
  if (queryTokens.length === 0) return false;
  const textTokens = tokenize(text);
  const textLower = text.toLowerCase();
  // Exact substring match first (fast path)
  if (queryTokens.length === 1 && textLower.includes(queryTokens[0]!)) return true;
  // Token intersection — any query token matches any text token
  return queryTokens.some(qt => textTokens.some(tt => tt.includes(qt) || qt.includes(tt)));
}

export async function handle(
  input: SearchCodebaseInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  const startTime = Date.now();
  const queryTokens = tokenize(input.query);
  const sections: string[] = [];

  // ── Sidecar mode: seed (problem) search from local SQLite cache ───────────
  let cacheTag: string | null = null;
  if (localStore && input.target !== 'components') {
    // file_filter NARROWS the seed search; its absence must not skip it. Without
    // a filter this searched zero seeds, so `search_codebase({ query,
    // target: "problems" })` — the plain form — could never return an
    // agent-recorded finding, only backend detections from getAnalysis().
    const filesToSearch = input.file_filter ?? [];
    const candidateSeeds = filesToSearch.length > 0
      ? filesToSearch.flatMap(f => localStore.getCachedSeeds(f))
      : localStore.getAllCachedSeeds();

    const seedResults: Array<{ severity: string; category: string; file_path: string; line_start: number; brief: string; id: string }> = [];
    for (const s of candidateSeeds) {
      if (
        matchesQuery(s.brief, queryTokens) ||
        matchesQuery(s.category, queryTokens) ||
        matchesQuery(s.file_path, queryTokens)
      ) {
        seedResults.push({
          severity: s.severity,
          category: s.category,
          file_path: s.file_path,
          line_start: s.line_start,
          brief: s.brief,
          id: s.id,
        });
      }
    }

    if (seedResults.length > 0) {
      const freshness = filesToSearch[0]
        ? localStore.getFreshness(filesToSearch[0])
        : { age_ms: 0, stale: false };
      const ageSec = Math.round(freshness.age_ms / 1000);
      cacheTag = `[cache: ${ageSec}s old${freshness.stale ? ', stale' : ''}]`;

      const capped = seedResults.slice(0, input.limit);
      let text = `Problems matching "${input.query}" (${capped.length}, from cache):\n`;
      for (const p of capped) {
        text += `  • [${p.severity}] ${p.category}  ${p.file_path}:${p.line_start}\n`;
        text += `    ${p.brief}\n`;
        text += `    id: ${p.id}\n`;
      }
      sections.push(text);
    }
  }

  // ── Local CPG component search ─────────────────────────────────────────────
  if (input.target !== 'problems') {
    const localIndex = getLocalIndex();
    if (localIndex.isReady()) {
      const allComponents: Array<{ id: string; name: string; type: string; filePath: string; startLine: number }> = [];

      const cpg = localIndex.getCPG();
      for (const [id, node] of (cpg as any).nodes ?? []) {
        const name: string = node.name ?? '';
        const filePath: string = node.filePath ?? node.file_path ?? '';
        const type: string = node.type ?? '';

        const matches =
          matchesQuery(name, queryTokens) ||
          matchesQuery(filePath, queryTokens) ||
          matchesQuery(type, queryTokens);

        if (!matches) continue;
        if (input.file_filter?.length && !input.file_filter.some(f => filePath.includes(f))) continue;

        allComponents.push({ id, name, type, filePath, startLine: node.startLine ?? 0 });
        if (allComponents.length >= input.limit * 2) break;
      }

      if (allComponents.length > 0) {
        let text = `Components (${Math.min(allComponents.length, input.limit)} shown):\n`;
        for (const c of allComponents.slice(0, input.limit)) {
          text += `  • ${c.name} (${c.type})  ${c.filePath}:${c.startLine}\n`;
          text += `    id: ${c.id}\n`;
        }
        sections.push(text);
      }
    } else if (input.target === 'components') {
      return 'Workspace not indexed — run init_workspace first.';
    }
  }

  // ── Problem search via GET /analysis ──────────────────────────────────────
  if (input.target !== 'components') {
    try {
      const analysis = await apiClient.getAnalysis(sessionId);
      const results = (analysis.results ?? []).filter(r => {
        if (!matchesQuery(r.path, queryTokens) && !matchesQuery(r.category, queryTokens) && !matchesQuery(r.summary, queryTokens) && !matchesQuery(r.description, queryTokens)) return false;
        if (input.file_filter?.length && !input.file_filter.some(f => r.path.includes(f))) return false;
        return true;
      }).slice(0, input.limit);

      if (results.length > 0) {
        let text = `Problems matching "${input.query}" (${results.length}):\n`;
        for (const p of results) {
          text += `  • [${p.severity ?? 'LOW'}] ${p.category}  ${p.path}:${p.startLine}\n`;
          text += `    ${p.summary}\n`;
          text += `    id: ${p.id}\n`;
        }
        sections.push(text);
      }
    } catch {
      // non-fatal — API may be unavailable
    }
  }

  const duration = Date.now() - startTime;

  if (sections.length === 0) {
    return `No results for "${input.query}" — try a different term or run init_workspace.`;
  }

  const suffix = cacheTag ? `\nSearch completed in ${duration}ms\n\n${cacheTag}` : `\nSearch completed in ${duration}ms`;
  return sections.join('\n') + suffix;
}
