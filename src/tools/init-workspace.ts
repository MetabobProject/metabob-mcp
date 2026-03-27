/**
 * Tool: init_workspace
 * Initialize workspace by scanning and indexing source files into the CPG
 */

import { z } from 'zod';
import { readdir, readFile, stat } from 'fs/promises';
import { join, relative, extname } from 'path';
import type { AnalysisAPIClient } from '../api-client.js';

export const InitWorkspaceTool = {
  name: 'init_workspace',
  description:
    'Initialize the workspace by scanning source files and indexing them into the Code Property Graph (CPG). Run this before using analysis tools to enable CPG-based features like impact analysis and co-change suggestions.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      root_path: {
        type: 'string',
        description:
          'Root directory to scan (defaults to current working directory)',
      },
      patterns: {
        type: 'array',
        description:
          'File patterns to include (defaults to ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"])',
        items: { type: 'string' },
      },
      max_files: {
        type: 'number',
        description: 'Maximum number of files to index (default: 500)',
      },
      max_file_size: {
        type: 'number',
        description: 'Maximum file size in bytes (default: 100000)',
      },
    },
    required: [],
  },
};

export const InputSchema = z.object({
  root_path: z.string().optional(),
  patterns: z.array(z.string()).optional(),
  max_files: z.number().positive().optional().default(500),
  max_file_size: z.number().positive().optional().default(100000),
});

export type InitWorkspaceInput = z.infer<typeof InputSchema>;

interface IndexingResult {
  indexed: number;
  components: number;
  status: string;
  duration_ms: number;
}

// Default patterns to match TypeScript/JavaScript source files
const DEFAULT_PATTERNS = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'];

// Directories to always exclude
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
]);

// File extensions to index
const INDEXABLE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

/**
 * Check if a path should be excluded
 */
function shouldExclude(name: string): boolean {
  return EXCLUDE_DIRS.has(name) || name.startsWith('.');
}

/**
 * Check if file extension is indexable
 */
function isIndexable(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return INDEXABLE_EXTENSIONS.has(ext);
}

/**
 * Recursively scan directory for indexable files
 */
async function scanDirectory(
  dirPath: string,
  rootPath: string,
  files: Map<string, string>,
  maxFiles: number,
  maxFileSize: number
): Promise<void> {
  if (files.size >= maxFiles) return;

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (files.size >= maxFiles) break;

      const fullPath = join(dirPath, entry.name);
      const relativePath = relative(rootPath, fullPath);

      if (entry.isDirectory()) {
        if (!shouldExclude(entry.name)) {
          await scanDirectory(fullPath, rootPath, files, maxFiles, maxFileSize);
        }
      } else if (entry.isFile() && isIndexable(entry.name)) {
        try {
          const stats = await stat(fullPath);
          if (stats.size <= maxFileSize) {
            const content = await readFile(fullPath, 'utf-8');
            files.set(relativePath, content);
          }
        } catch (err) {
          // Skip files we can't read
          console.error(`[init_workspace] Skipping ${relativePath}: ${err}`);
        }
      }
    }
  } catch (err) {
    console.error(`[init_workspace] Error scanning ${dirPath}: ${err}`);
  }
}

export async function handle(
  input: InitWorkspaceInput,
  apiClient: AnalysisAPIClient,
  sessionId: string
): Promise<string> {
  const startTime = Date.now();

  // Resolve root path
  const rootPath = input.root_path || process.cwd();
  const maxFiles = input.max_files || 500;
  const maxFileSize = input.max_file_size || 100000;

  // Scan for files
  const files = new Map<string, string>();

  try {
    await scanDirectory(rootPath, rootPath, files, maxFiles, maxFileSize);
  } catch (err) {
    return formatError('scan', err);
  }

  if (files.size === 0) {
    return formatEmptyResult(rootPath);
  }

  // Convert Map to Record for API call
  const filesRecord: Record<string, string> = {};
  for (const [path, content] of files) {
    filesRecord[path] = content;
  }

  // Call indexing endpoint
  try {
    const result: IndexingResult = await apiClient.post(
      '/v2/analysis/index',
      { files: filesRecord, incremental: false },
      sessionId
    );

    const duration = Date.now() - startTime;
    return formatSuccess(result, files.size, duration, rootPath);
  } catch (err) {
    return formatError('index', err);
  }
}

function formatSuccess(
  result: IndexingResult,
  scannedFiles: number,
  durationMs: number,
  rootPath: string
): string {
  let text = 'Workspace Initialized Successfully\n\n';

  text += `Root: ${rootPath}\n`;
  text += `Files scanned: ${scannedFiles}\n`;
  text += `Files indexed: ${result.indexed}\n`;
  text += `Components found: ${result.components}\n`;
  text += `Status: ${result.status}\n\n`;

  if (result.components > 0) {
    text += '## Next Steps\n\n';
    text += '- Use `analyze_change_impact` to see how changes affect the codebase\n';
    text += '- Use `suggest_related_changes` to find files that often change together\n';
    text += '- Use `search_codebase` to find code semantically\n';
  } else {
    text += '## Note\n\n';
    text += 'No components were extracted. This could mean:\n';
    text += '- The files do not contain parseable TypeScript/JavaScript\n';
    text += '- The files are empty or only contain comments\n';
  }

  text += `\n---\nCompleted in ${durationMs}ms`;

  return text;
}

function formatEmptyResult(rootPath: string): string {
  let text = 'No Indexable Files Found\n\n';

  text += `Root: ${rootPath}\n\n`;
  text += '## Possible Reasons\n\n';
  text += '- The directory does not contain TypeScript/JavaScript files\n';
  text += '- All source files are in excluded directories (node_modules, .git, etc.)\n';
  text += '- The root_path parameter may be incorrect\n\n';

  text += '## Suggestions\n\n';
  text += '- Check that the workspace contains source files\n';
  text += '- Try specifying a different root_path\n';
  text += '- Use `ls` or file explorer to verify the directory structure\n';

  return text;
}

function formatError(phase: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  let text = `Workspace Initialization Failed\n\n`;
  text += `Phase: ${phase}\n`;
  text += `Error: ${message}\n\n`;

  text += '## Suggestions\n\n';

  if (phase === 'scan') {
    text += '- Check that the root_path exists and is readable\n';
    text += '- Verify you have permission to read the directory\n';
  } else if (phase === 'index') {
    text += '- Check that the analysis API is running\n';
    text += '- Verify your session is valid\n';
    text += '- Try with fewer files (reduce max_files parameter)\n';
  }

  return text;
}
