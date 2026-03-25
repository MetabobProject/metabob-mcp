/**
 * Tool: generate_implementation_spec
 * Generate implementation specification from goal description
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

export const GenerateImplementationSpecTool = {
  name: 'generate_implementation_spec',
  description: 'Generate a detailed implementation specification from a high-level goal. Analyzes codebase structure, dependencies, and patterns to create a step-by-step implementation plan.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      goal: {
        type: 'string',
        description: 'High-level goal or feature description',
      },
      entry_points: {
        type: 'array',
        description: 'Optional: Starting files/components to analyze (e.g., ["src/main.ts"])',
        items: { type: 'string' },
      },
      context: {
        type: 'string',
        description: 'Optional: Additional context about the codebase or requirements',
      },
    },
    required: ['goal'],
  },
};

export const InputSchema = z.object({
  goal: z.string().min(1),
  entry_points: z.array(z.string()).optional(),
  context: z.string().optional(),
});

export type GenerateImplementationSpecInput = z.infer<typeof InputSchema>;

export interface ImplementationStep {
  step_number: number;
  title: string;
  description: string;
  files_to_modify: string[];
  files_to_create: string[];
  dependencies: string[];
  estimated_complexity: 'low' | 'medium' | 'high';
}

export interface GenerateImplementationSpecOutput {
  spec_id: string;
  goal: string;
  overview: string;
  steps: ImplementationStep[];
  affected_components: string[];
  estimated_effort: string;
  risks: string[];
  created_at: string;
}

const MAX_RESPONSE_SIZE = 100 * 1024; // 100KB

export async function handle(
  input: GenerateImplementationSpecInput,
  apiClient: AnalysisAPIClient,
  sessionId: string
): Promise<string> {
  const startTime = Date.now();

  // Call API
  const result: GenerateImplementationSpecOutput = await apiClient.post(
    '/v2/analysis/specs/generate',
    {
      goal: input.goal,
      entry_points: input.entry_points,
      context: input.context,
    },
    sessionId
  );

  const duration = Date.now() - startTime;

  // Format as human-readable text
  const text = formatAsText(result, duration);

  // Handle large responses
  return handleLargeResponse(text);
}

function formatAsText(result: GenerateImplementationSpecOutput, durationMs: number): string {
  let text = 'Implementation Specification Generated:\n\n';
  text += `Spec ID: ${result.spec_id}\n`;
  text += `Goal: ${result.goal}\n\n`;

  text += '## Overview\n\n';
  text += `${result.overview}\n\n`;

  text += `## Implementation Steps (${result.steps.length} steps)\n\n`;

  for (const step of result.steps) {
    text += `### Step ${step.step_number}: ${step.title}\n`;
    text += `Complexity: ${step.estimated_complexity.toUpperCase()}\n\n`;
    text += `${step.description}\n\n`;

    if (step.files_to_modify.length > 0) {
      text += `Files to modify:\n`;
      for (const file of step.files_to_modify) {
        text += `  - ${file}\n`;
      }
      text += '\n';
    }

    if (step.files_to_create.length > 0) {
      text += `Files to create:\n`;
      for (const file of step.files_to_create) {
        text += `  - ${file}\n`;
      }
      text += '\n';
    }

    if (step.dependencies.length > 0) {
      text += `Dependencies: ${step.dependencies.join(', ')}\n\n`;
    }
  }

  if (result.affected_components.length > 0) {
    text += `## Affected Components (${result.affected_components.length})\n\n`;
    for (const component of result.affected_components) {
      text += `  - ${component}\n`;
    }
    text += '\n';
  }

  text += `## Estimated Effort\n\n${result.estimated_effort}\n\n`;

  if (result.risks.length > 0) {
    text += `## Risks & Considerations\n\n`;
    for (const risk of result.risks) {
      text += `  - ${risk}\n`;
    }
    text += '\n';
  }

  text += `---\nGenerated in ${durationMs}ms at ${result.created_at}`;

  return text;
}

function handleLargeResponse(text: string): string {
  const byteSize = Buffer.byteLength(text, 'utf8');

  if (byteSize <= MAX_RESPONSE_SIZE) {
    return text;
  }

  // Truncate response and add warning
  const truncatedText = text.slice(0, MAX_RESPONSE_SIZE);
  const lastNewline = truncatedText.lastIndexOf('\n');
  const finalText = truncatedText.slice(0, lastNewline);

  const warning = `\n\n--- RESPONSE TRUNCATED ---\n`;
  const info = `Original size: ${(byteSize / 1024).toFixed(1)}KB, Truncated to: ${(MAX_RESPONSE_SIZE / 1024).toFixed(1)}KB\n`;
  const suggestion = `Suggestion: Use more specific entry_points or break down the goal into smaller tasks.`;

  return finalText + warning + info + suggestion;
}
