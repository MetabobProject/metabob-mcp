import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { getLocalIndex } from '../local-index.js';

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

function matchesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

export async function handle(
  input: SearchCodebaseInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
): Promise<string> {
  const startTime = Date.now();
  const q = input.query.toLowerCase();
  const sections: string[] = [];

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
          matchesQuery(name, q) ||
          matchesQuery(filePath, q) ||
          matchesQuery(type, q);

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
        if (!matchesQuery(r.path, q) && !matchesQuery(r.category, q) && !matchesQuery(r.summary, q) && !matchesQuery(r.description, q)) return false;
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

  return sections.join('\n') + `\nSearch completed in ${duration}ms`;
}
