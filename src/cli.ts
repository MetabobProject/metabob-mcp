#!/usr/bin/env node
/**
 * CLI wrapper for metabob-mcp
 * Provides command-line argument parsing for npx usage
 */

// Re-exec under Node.js with an expanded heap before loading ONNX / Tree-sitter.
// Bun manages its own memory, so this guard is Node-only.
if (!process.versions.bun && !process.env.__METABOB_HEAP_EXPANDED) {
  const { spawn } = await import('node:child_process');
  const child = spawn(
    process.execPath,
    ['--max-old-space-size=4096', ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, __METABOB_HEAP_EXPANDED: '1' } },
  );
  child.on('exit', (code) => process.exit(code ?? 0));
  await new Promise(() => {}); // wait for child to call process.exit
}

import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CLIOptions {
  apiUrl?: string;
  sessionId?: string;
  apiKey?: string;
  jwtToken?: string;
  logLevel?: string;
  healthPort?: number;
  maxRequestsPerMinute?: number;
  help?: boolean;
  version?: boolean;
}

function showHelp() {
  console.log(`
metabob-mcp - MCP server for Metabob code analysis

USAGE:
  npx @metabob/mcp [OPTIONS]

OPTIONS:
  --api-url <URL>              Analysis API URL (default: https://ide.metabob.com)
  --session-id <ID>            Session identifier (default: default-session)
  --api-key <KEY>              Metabob API key for authentication (recommended)
  --jwt-token <TOKEN>          JWT token for authentication (advanced, use --api-key instead)
  --log-level <LEVEL>          Logging level: debug, info, warn, error (default: info)
  --health-port <PORT>         HTTP port for health checks (default: 8080)
  --max-requests-per-minute <N> Rate limit per session (default: 60)
  --help                       Show this help message
  --version                    Show version information

AUTHENTICATION:
  Use --api-key or METABOB_API_KEY for authentication. The API key is exchanged
  for a short-lived JWT token on startup, with automatic refresh.

  Get your API key from the Metabob dashboard: https://app.metabob.com/settings/api-keys

EXAMPLES:
  # Start with API key authentication (recommended)
  npx @metabob/mcp --api-key=mb_live_your_api_key_here

  # Start with default settings (no auth)
  npx @metabob/mcp

  # Connect to remote API with auth
  npx @metabob/mcp --api-url=https://api.metabob.com --api-key=mb_live_...

  # Custom session and debug logging
  npx @metabob/mcp --session-id=my-session --log-level=debug

ENVIRONMENT VARIABLES:
  METABOB_API_KEY              API key for authentication (recommended)
  ANALYSIS_API_URL             Same as --api-url
  SESSION_ID                   Same as --session-id
  JWT_TOKEN                    Same as --jwt-token (advanced)
  LOG_LEVEL                    Same as --log-level
  HEALTH_PORT                  Same as --health-port
  MAX_REQUESTS_PER_MINUTE      Same as --max-requests-per-minute

  Note: Command-line options take precedence over environment variables.

INTEGRATION WITH MCP CLIENTS:

  Claude Desktop (~/Library/Application Support/Claude/claude_desktop_config.json):
  {
    "mcpServers": {
      "metabob": {
        "command": "npx",
        "args": ["@metabob/mcp@latest"],
        "env": {
          "METABOB_API_KEY": "mb_live_your_api_key_here",
          "ANALYSIS_API_URL": "https://api.metabob.com"
        }
      }
    }
  }

  Cursor (.cursor/mcp.json):
  {
    "mcpServers": {
      "metabob": {
        "command": "npx",
        "args": [
          "@metabob/mcp@latest",
          "--api-key=mb_live_your_api_key_here"
        ]
      }
    }
  }

For more information, visit: https://github.com/metabob/metabob-devbob/tree/main/repos/metabob-mcp
`);
}

function showVersion() {
  try {
    // Try to read version from package.json
    const packageJsonPath = join(__dirname, '../package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      console.log(`metabob-mcp v${packageJson.version}`);
    } else {
      console.log('metabob-mcp (version unknown)');
    }
  } catch (error) {
    console.log('metabob-mcp (version unknown)');
  }
}

function parseCliArgs(): CLIOptions {
  try {
    const { values } = parseArgs({
      options: {
        'api-url': { type: 'string' },
        'session-id': { type: 'string' },
        'api-key': { type: 'string' },
        'jwt-token': { type: 'string' },
        'log-level': { type: 'string' },
        'health-port': { type: 'string' },
        'max-requests-per-minute': { type: 'string' },
        'help': { type: 'boolean', short: 'h' },
        'version': { type: 'boolean', short: 'v' },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      apiUrl: values['api-url'] as string | undefined,
      sessionId: values['session-id'] as string | undefined,
      apiKey: values['api-key'] as string | undefined,
      jwtToken: values['jwt-token'] as string | undefined,
      logLevel: values['log-level'] as string | undefined,
      healthPort: values['health-port'] ? parseInt(values['health-port'] as string, 10) : undefined,
      maxRequestsPerMinute: values['max-requests-per-minute']
        ? parseInt(values['max-requests-per-minute'] as string, 10)
        : undefined,
      help: values['help'] as boolean | undefined,
      version: values['version'] as boolean | undefined,
    };
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error parsing arguments: ${error.message}`);
      console.error('Use --help for usage information');
    }
    process.exit(1);
  }
}

function validateOptions(options: CLIOptions): void {
  if (options.logLevel) {
    const validLevels = ['debug', 'info', 'warn', 'error'];
    if (!validLevels.includes(options.logLevel)) {
      console.error(`Invalid log level: ${options.logLevel}`);
      console.error(`Valid levels: ${validLevels.join(', ')}`);
      process.exit(1);
    }
  }

  if (options.healthPort !== undefined) {
    if (isNaN(options.healthPort) || options.healthPort < 1 || options.healthPort > 65535) {
      console.error(`Invalid health port: ${options.healthPort}`);
      console.error('Port must be between 1 and 65535');
      process.exit(1);
    }
  }

  if (options.maxRequestsPerMinute !== undefined) {
    if (isNaN(options.maxRequestsPerMinute) || options.maxRequestsPerMinute < 1) {
      console.error(`Invalid max requests per minute: ${options.maxRequestsPerMinute}`);
      console.error('Must be a positive integer');
      process.exit(1);
    }
  }
}

async function main() {
  const options = parseCliArgs();

  // Handle help and version flags
  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (options.version) {
    showVersion();
    process.exit(0);
  }

  // Validate options
  validateOptions(options);

  // Set environment variables from CLI options (CLI takes precedence)
  if (options.apiUrl) {
    process.env.ANALYSIS_API_URL = options.apiUrl;
  }
  if (options.sessionId) {
    process.env.SESSION_ID = options.sessionId;
  }
  if (options.apiKey) {
    process.env.METABOB_API_KEY = options.apiKey;
  }
  if (options.jwtToken) {
    process.env.JWT_TOKEN = options.jwtToken;
  }
  if (options.logLevel) {
    process.env.LOG_LEVEL = options.logLevel;
  }
  if (options.healthPort !== undefined) {
    process.env.HEALTH_PORT = options.healthPort.toString();
  }
  if (options.maxRequestsPerMinute !== undefined) {
    process.env.MAX_REQUESTS_PER_MINUTE = options.maxRequestsPerMinute.toString();
  }

  // Import and start the MCP server
  // The index.ts file will read from environment variables we just set
  await import('./index.js');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
