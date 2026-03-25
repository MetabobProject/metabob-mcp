/**
 * Tool: suggest_related_changes
 * Suggest files that should be changed together based on co-change patterns
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

export const SuggestRelatedChangesTool = {
  name: 'suggest_related_changes',
  description: 'Suggest related files that should be changed together based on historical co-change patterns and semantic similarity. Helps prevent incomplete changes.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      changed_files: {
        type: 'array',
        description: 'List of file paths that are being changed',
        items: { type: 'string' },
      },
      limit: {
        type: 'number',
        description: 'Maximum number of suggestions to return (default: 5)',
        default: 5,
      },
      confidence_threshold: {
        type: 'number',
        description: 'Minimum confidence score (0.0 to 1.0, default: 0.3)',
        default: 0.3,
      },
      config: {
        type: 'object',
        description: 'Hybrid scoring configuration',
        properties: {
          embedding_weight: {
            type: 'number',
            description: 'Weight for semantic similarity (default: 0.6)',
            default: 0.6,
          },
          frequency_weight: {
            type: 'number',
            description: 'Weight for historical frequency (default: 0.4)',
            default: 0.4,
          },
        },
      },
    },
    required: ['changed_files'],
  },
};

export const InputSchema = z.object({
  changed_files: z.array(z.string()).min(1),
  limit: z.number().int().positive().max(50).default(5),
  confidence_threshold: z.number().min(0).max(1).default(0.3),
  config: z
    .object({
      embedding_weight: z.number().min(0).max(1).default(0.6),
      frequency_weight: z.number().min(0).max(1).default(0.4),
    })
    .optional(),
});

export type SuggestRelatedChangesInput = z.infer<typeof InputSchema>;

export interface SuggestRelatedChangesOutput {
  suggestions: Array<{
    file_path: string;
    confidence: number;
    reason: string;
    affected_components: string[];
    historical_frequency?: number;
    embedding_similarity?: number;
  }>;
  model_version: string;
  query_time_ms: number;
}

export async function handle(
  input: SuggestRelatedChangesInput,
  apiClient: AnalysisAPIClient,
  sessionId: string
): Promise<string> {
  const startTime = Date.now();

  // Call API
  const result: SuggestRelatedChangesOutput = await apiClient.post(
    '/v2/analysis/cochange/suggest',
    {
      changed_files: input.changed_files,
      limit: input.limit,
      confidence_threshold: input.confidence_threshold,
      config: input.config || {},
    },
    sessionId
  );

  const duration = Date.now() - startTime;

  // Format as human-readable text
  return formatAsText(input.changed_files, result, duration);
}

function formatAsText(
  changedFiles: string[],
  result: SuggestRelatedChangesOutput,
  durationMs: number
): string {
  const { suggestions, model_version } = result;

  let text = `Co-change suggestions for:\n`;
  changedFiles.forEach(file => {
    text += `  - ${file}\n`;
  });
  text += '\n';

  if (suggestions.length === 0) {
    text += 'No related changes found. These files can likely be changed independently.\n';
  } else {
    text += `Found ${suggestions.length} file${suggestions.length === 1 ? '' : 's'} that should likely be changed together:\n\n`;

    for (let i = 0; i < suggestions.length; i++) {
      const suggestion = suggestions[i]!;
      const rank = i + 1;

      text += `${rank}. ${suggestion.file_path}\n`;
      text += `   Confidence: ${(suggestion.confidence * 100).toFixed(1)}%\n`;
      text += `   Reason: ${suggestion.reason}\n`;

      if (suggestion.historical_frequency !== undefined) {
        text += `   Historical Co-changes: ${suggestion.historical_frequency}\n`;
      }

      if (suggestion.embedding_similarity !== undefined) {
        text += `   Semantic Similarity: ${(suggestion.embedding_similarity * 100).toFixed(1)}%\n`;
      }

      if (suggestion.affected_components.length > 0) {
        text += `   Affected Components:\n`;
        suggestion.affected_components.slice(0, 3).forEach(comp => {
          text += `     - ${comp}\n`;
        });
        if (suggestion.affected_components.length > 3) {
          text += `     ... and ${suggestion.affected_components.length - 3} more\n`;
        }
      }

      text += '\n';
    }
  }

  text += `\nModel: ${model_version}\n`;
  text += `Analysis completed in ${durationMs}ms`;

  return text;
}
