/**
 * Tool: search_codebase
 * Semantic search through detected issues
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

export const SearchCodebaseTool = {
  name: 'search_codebase',
  description: 'Search for code issues using natural language queries. Uses semantic search to find relevant problems.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Natural language search query (e.g., "find authentication bugs")',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10)',
        default: 10,
      },
      filters: {
        type: 'object',
        description: 'Optional filters to narrow search',
        properties: {
          severity: {
            type: 'array',
            items: { type: 'string' },
          },
          category: {
            type: 'array',
            items: { type: 'string' },
          },
          file_pattern: {
            type: 'string',
            description: 'Glob pattern to filter files (e.g., "src/**/*.ts")',
          },
          scope: {
            type: 'string',
            enum: ['session', 'project', 'org'],
            default: 'session',
          },
        },
      },
    },
    required: ['query'],
  },
};

export const InputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).default(10),
  filters: z
    .object({
      severity: z.array(z.string()).optional(),
      category: z.array(z.string()).optional(),
      file_pattern: z.string().optional(),
      scope: z.enum(['session', 'project', 'org']).default('session'),
    })
    .optional(),
});

export type SearchCodebaseInput = z.infer<typeof InputSchema>;

export interface SearchCodebaseOutput {
  results: Array<{
    id: string;
    component_id: string;
    severity: string;
    category: string;
    message: string;
    impact_score: number;
    status: string;
    similarity_score: number;
    match_reason: string;
  }>;
  query_time_ms: number;
}

export async function handle(
  input: SearchCodebaseInput,
  apiClient: AnalysisAPIClient,
  sessionId: string
): Promise<string> {
  const startTime = Date.now();

  // Call API
  const result: SearchCodebaseOutput = await apiClient.post(
    '/v2/analysis/search',
    {
      query: input.query,
      limit: input.limit,
      filters: input.filters || {},
    },
    sessionId
  );

  const duration = Date.now() - startTime;

  // Format as human-readable text
  return formatAsText(input.query, result, duration);
}

function formatAsText(query: string, result: SearchCodebaseOutput, durationMs: number): string {
  const { results } = result;

  if (results.length === 0) {
    return `No results found for query: "${query}"`;
  }

  let text = `Search results for: "${query}"\n`;
  text += `Found ${results.length} relevant issue${results.length === 1 ? '' : 's'}:\n\n`;

  for (let i = 0; i < results.length; i++) {
    const issue = results[i]!;
    const rank = i + 1;

    text += `${rank}. [${issue.severity}] ${issue.category}\n`;
    text += `   Component: ${issue.component_id}\n`;
    text += `   Problem: ${issue.message}\n`;
    text += `   Similarity: ${(issue.similarity_score * 100).toFixed(1)}%\n`;
    text += `   Match Reason: ${issue.match_reason}\n`;
    text += `   Impact Score: ${(issue.impact_score * 100).toFixed(0)}%\n`;
    text += `   Status: ${issue.status}\n`;
    text += `   ID: ${issue.id}\n`;
    text += '\n';
  }

  text += `\nSearch completed in ${durationMs}ms`;

  return text;
}
