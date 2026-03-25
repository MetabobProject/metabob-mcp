/**
 * Tool: get_priority_issues
 * Fetch high-priority problems for current codebase
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

export const GetPriorityIssuesTool = {
  name: 'get_priority_issues',
  description: 'Fetch high-priority analysis issues for current codebase. Returns problems ranked by severity and impact score.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of issues to return (default: 10, max: 100)',
        default: 10,
      },
      severity: {
        type: 'array',
        description: 'Filter by severity levels',
        items: {
          type: 'string',
          enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'],
        },
      },
      category: {
        type: 'array',
        description: 'Filter by problem categories (e.g., security, performance)',
        items: { type: 'string' },
      },
      scope: {
        type: 'string',
        description: 'Analysis scope (session = current files, project = all files, org = all projects)',
        enum: ['session', 'project', 'org'],
        default: 'session',
      },
    },
  },
};

export const InputSchema = z.object({
  limit: z.number().int().positive().max(100).default(10),
  severity: z.array(z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'])).optional(),
  category: z.array(z.string()).optional(),
  scope: z.enum(['session', 'project', 'org']).default('session'),
});

export type GetPriorityIssuesInput = z.infer<typeof InputSchema>;

export interface GetPriorityIssuesOutput {
  issues: Array<{
    id: string;
    session_id: string;
    component_id: string;
    severity: string;
    category: string;
    message: string;
    impact_score: number;
    status: string;
    created_at: string;
    updated_at: string;
  }>;
  total_issues: number;
  query_time_ms: number;
}

export async function handle(
  input: GetPriorityIssuesInput,
  apiClient: AnalysisAPIClient,
  sessionId: string
): Promise<string> {
  const startTime = Date.now();

  // Call API
  const result: GetPriorityIssuesOutput = await apiClient.get(
    '/v2/analysis/priority',
    {
      limit: input.limit,
      severity: input.severity,
      category: input.category,
      scope: input.scope,
    },
    sessionId
  );

  const duration = Date.now() - startTime;

  // Format as human-readable text
  return formatAsText(result, duration);
}

function formatAsText(result: GetPriorityIssuesOutput, durationMs: number): string {
  const { issues, total_issues } = result;

  if (issues.length === 0) {
    return 'No priority issues found. The codebase looks clean!';
  }

  let text = `Found ${issues.length} priority issue${issues.length === 1 ? '' : 's'}`;
  if (total_issues > issues.length) {
    text += ` (${total_issues} total)`;
  }
  text += ':\n\n';

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i]!;
    const rank = i + 1;

    text += `${rank}. [${issue.severity}] ${issue.category}\n`;
    text += `   Component: ${issue.component_id}\n`;
    text += `   Problem: ${issue.message}\n`;
    text += `   Impact Score: ${(issue.impact_score * 100).toFixed(0)}%\n`;
    text += `   Status: ${issue.status}\n`;
    text += `   ID: ${issue.id}\n`;
    text += '\n';
  }

  text += `\nQuery completed in ${durationMs}ms`;

  return text;
}
