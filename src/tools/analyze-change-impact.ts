/**
 * Tool: analyze_change_impact
 * Analyze impact of changes via CPG traversal
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

export const AnalyzeChangeImpactTool = {
  name: 'analyze_change_impact',
  description: 'Analyze the impact of code changes using the Code Property Graph. Shows which components will be affected by changes (direct and indirect dependencies).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      changed_files: {
        type: 'array',
        description: 'List of file paths being changed',
        items: { type: 'string' },
      },
      diff: {
        type: 'string',
        description: 'Optional: Git diff output for more precise analysis',
      },
      direction: {
        type: 'string',
        description: 'Traverse direction (forward = dependencies, backward = dependents, both = both directions)',
        enum: ['forward', 'backward', 'both'],
        default: 'both',
      },
      max_depth: {
        type: 'number',
        description: 'Maximum traversal depth (default: 5)',
        default: 5,
      },
      include_tests: {
        type: 'boolean',
        description: 'Include test files in analysis (default: true)',
        default: true,
      },
    },
    required: ['changed_files'],
  },
};

export const InputSchema = z.object({
  changed_files: z.array(z.string()).min(1),
  diff: z.string().optional(),
  direction: z.enum(['forward', 'backward', 'both']).default('both'),
  max_depth: z.number().int().positive().max(10).default(5),
  include_tests: z.boolean().default(true),
});

export type AnalyzeChangeImpactInput = z.infer<typeof InputSchema>;

export interface ImpactedComponent {
  component_id: string;
  component_name: string;
  file_path: string;
  depth: number;
  risk: 'low' | 'medium' | 'high';
  reason: string;
  annotations?: Array<{ text: string; type: string }>;
}

export interface AnalyzeChangeImpactOutput {
  analysis: {
    changed_components: string[];
    direct_dependencies: ImpactedComponent[];
    indirect_dependencies: ImpactedComponent[];
    affected_tests: ImpactedComponent[];
    risk_level: 'low' | 'medium' | 'high' | 'critical';
  };
  query_time_ms: number;
}

export async function handle(
  input: AnalyzeChangeImpactInput,
  apiClient: AnalysisAPIClient,
  sessionId: string
): Promise<string> {
  const startTime = Date.now();

  // Call API
  const result: AnalyzeChangeImpactOutput = await apiClient.post(
    '/v2/analysis/impact',
    {
      changed_files: input.changed_files,
      diff: input.diff,
      direction: input.direction,
      max_depth: input.max_depth,
      include_tests: input.include_tests,
    },
    sessionId
  );

  const duration = Date.now() - startTime;

  // Format as human-readable text
  return formatAsText(input.changed_files, result, duration);
}

function formatAsText(
  changedFiles: string[],
  result: AnalyzeChangeImpactOutput,
  durationMs: number
): string {
  const { analysis } = result;

  let text = `Impact Analysis\n`;
  text += `===============\n\n`;

  text += `Changed Files:\n`;
  changedFiles.forEach(file => {
    text += `  - ${file}\n`;
  });
  text += '\n';

  text += `Risk Level: ${analysis.risk_level.toUpperCase()}\n\n`;

  // Direct dependencies
  if (analysis.direct_dependencies.length > 0) {
    text += `Direct Dependencies (${analysis.direct_dependencies.length}):\n`;
    text += `These components are directly called by or call the changed code:\n\n`;

    analysis.direct_dependencies.forEach((comp, i) => {
      text += `  ${i + 1}. ${comp.component_name} (${comp.file_path})\n`;
      text += `     Risk: ${comp.risk.toUpperCase()}\n`;
      text += `     Reason: ${comp.reason}\n`;

      if (comp.annotations && comp.annotations.length > 0) {
        text += `     Annotations:\n`;
        comp.annotations.forEach(ann => {
          text += `       - [${ann.type}] ${ann.text}\n`;
        });
      }

      text += '\n';
    });
  } else {
    text += `Direct Dependencies: None\n\n`;
  }

  // Indirect dependencies
  if (analysis.indirect_dependencies.length > 0) {
    text += `Indirect Dependencies (${analysis.indirect_dependencies.length}):\n`;
    text += `These components are transitively affected:\n\n`;

    analysis.indirect_dependencies.slice(0, 10).forEach((comp, i) => {
      text += `  ${i + 1}. ${comp.component_name} (${comp.file_path})\n`;
      text += `     Depth: ${comp.depth}, Risk: ${comp.risk.toUpperCase()}\n`;
      text += `     Reason: ${comp.reason}\n`;
      text += '\n';
    });

    if (analysis.indirect_dependencies.length > 10) {
      text += `  ... and ${analysis.indirect_dependencies.length - 10} more\n\n`;
    }
  } else {
    text += `Indirect Dependencies: None\n\n`;
  }

  // Affected tests
  if (analysis.affected_tests.length > 0) {
    text += `Affected Tests (${analysis.affected_tests.length}):\n`;
    text += `These tests should be run to verify the changes:\n\n`;

    analysis.affected_tests.forEach((comp, i) => {
      text += `  ${i + 1}. ${comp.component_name} (${comp.file_path})\n`;
    });
    text += '\n';
  } else {
    text += `Affected Tests: None found\n\n`;
  }

  // Summary
  const totalImpact =
    analysis.direct_dependencies.length +
    analysis.indirect_dependencies.length +
    analysis.affected_tests.length;

  text += `Summary:\n`;
  text += `  Total Impacted Components: ${totalImpact}\n`;
  text += `  Risk Level: ${analysis.risk_level.toUpperCase()}\n`;
  text += `\n`;

  if (analysis.risk_level === 'high' || analysis.risk_level === 'critical') {
    text += `⚠️  HIGH RISK: This change affects many components. Consider:\n`;
    text += `  - Reviewing all impacted components\n`;
    text += `  - Running comprehensive tests\n`;
    text += `  - Getting peer review\n`;
    text += `  - Using feature flags for gradual rollout\n`;
    text += '\n';
  }

  text += `Analysis completed in ${durationMs}ms`;

  return text;
}
