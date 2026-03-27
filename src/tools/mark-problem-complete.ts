/**
 * Tool: mark_problem_complete
 * Mark a code problem as resolved with optional commit reference
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

export const MarkProblemCompleteTool = {
  name: 'mark_problem_complete',
  description: 'Mark a code problem as resolved. Use this after fixing a bug or implementing a suggested improvement. Optionally creates an annotation documenting the fix.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      problem_id: {
        type: 'string',
        description: 'Problem ID to mark as complete',
      },
      resolution_summary: {
        type: 'string',
        description: 'Summary of how the problem was resolved',
      },
      fixed_in_commit: {
        type: 'string',
        description: 'Optional: Git commit SHA or reference where fix was made',
      },
      create_annotation: {
        type: 'boolean',
        description: 'Whether to automatically create an annotation documenting the fix (default: true)',
      },
    },
    required: ['problem_id', 'resolution_summary'],
  },
};

export const InputSchema = z.object({
  problem_id: z.string(),
  resolution_summary: z.string().min(1),
  fixed_in_commit: z.string().optional(),
  create_annotation: z.boolean().default(true),
});

export type MarkProblemCompleteInput = z.infer<typeof InputSchema>;

export interface MarkProblemCompleteOutput {
  problem: {
    id: string;
    status: string;
    resolution_summary: string;
    fixed_in_commit?: string;
    resolved_at: string;
    resolved_by: string;
  };
  annotation?: {
    id: string;
    component_id: string;
    text: string;
    type: string;
  };
}

export async function handle(
  input: MarkProblemCompleteInput,
  apiClient: AnalysisAPIClient,
  sessionId: string
): Promise<string> {
  const startTime = Date.now();

  // Call API
  const result: MarkProblemCompleteOutput = await apiClient.put(
    `/v2/analysis/problems/${input.problem_id}/complete`,
    {
      resolution_summary: input.resolution_summary,
      fixed_in_commit: input.fixed_in_commit,
      create_annotation: input.create_annotation,
    },
    sessionId
  );

  const duration = Date.now() - startTime;

  // Extract actual changed files from the resolution
  // The component_id typically contains the file path
  const actualFiles: string[] = [];
  if (result.annotation?.component_id) {
    // Extract file path from component_id (format: file/path::type::name::line)
    const filePath = result.annotation.component_id.split('::')[0];
    if (filePath) {
      actualFiles.push(filePath);
    }
  }

  // If we have a commit reference, the actual files should include that context
  // For now, just use the component as the changed file
  if (actualFiles.length > 0) {
    // Record actual changes and submit feedback for recent predictions (non-blocking)
    apiClient.recordActualChangesAndSubmitFeedback(sessionId, actualFiles);
  }

  // Report tool usage (non-blocking)
  apiClient.reportToolUsage(sessionId, 'mark_problem_complete', input as Record<string, unknown>, {
    success: true,
    durationMs: duration,
  });

  // Format as human-readable text
  return formatAsText(result, duration);
}

function formatAsText(result: MarkProblemCompleteOutput, durationMs: number): string {
  const { problem, annotation } = result;

  let text = 'Problem marked as complete:\n\n';
  text += `Problem ID: ${problem.id}\n`;
  text += `Status: ${problem.status}\n`;
  text += `Resolution: ${problem.resolution_summary}\n`;

  if (problem.fixed_in_commit) {
    text += `Fixed in Commit: ${problem.fixed_in_commit}\n`;
  }

  text += `Resolved At: ${problem.resolved_at}\n`;
  text += `Resolved By: ${problem.resolved_by}\n`;

  if (annotation) {
    text += `\nAnnotation created:\n`;
    text += `  ID: ${annotation.id}\n`;
    text += `  Component: ${annotation.component_id}\n`;
    text += `  Type: ${annotation.type}\n`;
  }

  text += `\nCompleted in ${durationMs}ms`;

  return text;
}
