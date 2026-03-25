/**
 * Tool: annotate_component
 * Add human annotations to code components
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

export const AnnotateComponentTool = {
  name: 'annotate_component',
  description: 'Add annotations to code components (design decisions, implementation notes, bug context). Useful for documenting why code was written a certain way.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      component_id: {
        type: 'string',
        description: 'Component ID from CPG (format: filepath::type::name::line)',
      },
      content: {
        type: 'string',
        description: 'Annotation text content',
      },
      type: {
        type: 'string',
        description: 'Type of annotation',
        enum: ['design_decision', 'implementation_note', 'bug_context', 'todo'],
      },
      tags: {
        type: 'array',
        description: 'Optional tags for categorization',
        items: { type: 'string' },
      },
      link_to_problem_id: {
        type: 'string',
        description: 'Optional: Link annotation to a specific problem',
      },
    },
    required: ['component_id', 'content', 'type'],
  },
};

export const InputSchema = z.object({
  component_id: z.string(),
  content: z.string().min(1),
  type: z.enum(['design_decision', 'implementation_note', 'bug_context', 'todo']),
  tags: z.array(z.string()).optional(),
  link_to_problem_id: z.string().optional(),
});

export type AnnotateComponentInput = z.infer<typeof InputSchema>;

export interface AnnotateComponentOutput {
  annotation_id: string;
  annotation: {
    id: string;
    component_id: string;
    text: string;
    type: string;
    session_id: string;
    created_by: string;
    created_at: string;
    linked_problem_id?: string;
  };
}

export async function handle(
  input: AnnotateComponentInput,
  apiClient: AnalysisAPIClient,
  sessionId: string
): Promise<string> {
  const startTime = Date.now();

  // Call API
  const result: AnnotateComponentOutput = await apiClient.post(
    '/v2/analysis/annotations',
    {
      component_id: input.component_id,
      content: input.content,
      type: input.type,
      tags: input.tags,
      link_to_problem_id: input.link_to_problem_id,
    },
    sessionId
  );

  const duration = Date.now() - startTime;

  // Format as human-readable text
  return formatAsText(result, duration);
}

function formatAsText(result: AnnotateComponentOutput, durationMs: number): string {
  const { annotation } = result;

  let text = 'Annotation created successfully:\n\n';
  text += `ID: ${annotation.id}\n`;
  text += `Component: ${annotation.component_id}\n`;
  text += `Type: ${annotation.type}\n`;
  text += `Content: ${annotation.text}\n`;
  text += `Created: ${annotation.created_at}\n`;

  if (annotation.linked_problem_id) {
    text += `Linked to Problem: ${annotation.linked_problem_id}\n`;
  }

  text += `\nAnnotation saved in ${durationMs}ms`;

  return text;
}
