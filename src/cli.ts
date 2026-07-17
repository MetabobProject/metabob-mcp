#!/usr/bin/env node
/**
 * CLI wrapper for metabob-mcp
 * Provides command-line argument parsing for npx usage
 */

// Re-exec under Bun with the OS trust store enabled, before any network I/O.
// The shipped bin runs under Bun (see scripts/finalize-cli.ts), and Bun 1.3.x
// ignores NODE_EXTRA_CA_CERTS (oven-sh/bun#23735). Behind a TLS-inspecting
// corporate proxy (Zscaler, Netskope, …) every fetch then fails with
// "unable to get local issuer certificate" until Bun is launched with
// `--use-system-ca`. `npx @metabob/mcp` and the Windows npm shim invoke bare
// `bun dist/cli.js` with no flag, so we re-exec ourselves with it. Bun already
// honors HTTP(S)_PROXY natively, so this is the only missing piece.
// Opt out: METABOB_NO_SYSTEM_CA=1 or --no-system-ca.
if (
  process.versions.bun &&
  process.argv[1] &&
  !process.execArgv.includes('--use-system-ca') &&
  !process.env.__METABOB_SYSTEM_CA_REEXEC &&
  process.env.METABOB_NO_SYSTEM_CA !== '1' &&
  !process.argv.includes('--no-system-ca')
) {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve) => {
    const child = spawn(
      process.execPath,
      ['--use-system-ca', ...process.argv.slice(1)],
      { stdio: 'inherit', env: { ...process.env, __METABOB_SYSTEM_CA_REEXEC: '1' } },
    );
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    child.on('error', (err) => {
      // Could not re-spawn (e.g. bun not on PATH) — run in-process rather than
      // failing to start; TLS may still fail, but that is strictly no worse.
      console.error(
        `[metabob-mcp] could not re-exec with --use-system-ca (${err.message}); ` +
          `continuing without the OS trust store`,
      );
      resolve();
    });
  });
}

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
import { applyConfigDefaults, loadMetabobCLIConfig, loadMetabobEnvConfig } from './config.js';
import { installSystemTrustStoreSync } from './tls-trust.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CLIOptions {
  apiUrl?: string;
  endpoint?: string;
  sessionId?: string;
  apiKey?: string;
  sessionToken?: string;
  logLevel?: string;
  healthPort?: number;
  maxRequestsPerMinute?: number;
  noSystemCa?: boolean;
  help?: boolean;
  version?: boolean;
}

function showHelp() {
  console.log(`
metabob-mcp - MCP server for Metabob code analysis

USAGE:
  npx @metabob/mcp [OPTIONS]
  npx @metabob/mcp doctor             Diagnose corporate-proxy / TLS-inspection issues

OPTIONS:
  --api-key <KEY>              Metabob API key for authentication (recommended)
  --endpoint <URL>             Gateway in the vessel (optional; default:
                               https://ide.metabob.com). The single endpoint everything
                               derives from — analysis, discovery, identity, concept-db.
                               Flag mirror of METABOB_ENDPOINT / metabob.endpoint.
                               Omit it and --api-key alone is the whole configuration.
  --api-url <URL>              Advanced: raw analysis-base override (no sibling
                               derivation). Same as ANALYSIS_API_URL. Prefer --endpoint.
  --session-id <ID>            Session identifier (default: default-session)
  --session-token <TOKEN>      Pre-obtained session token (advanced)
  --log-level <LEVEL>          Logging level: debug, info, warn, error (default: info)
  --health-port <PORT>         HTTP port for health checks (default: 8080)
  --max-requests-per-minute <N> Rate limit per session (default: 60)
  --no-system-ca               Skip loading OS root CAs at startup (advanced;
                               for users who hit a system-ca read bug). Without
                               this flag, metabob-mcp augments Node's bundled
                               Mozilla roots with the OS trust store so it
                               works behind corporate SSL inspection out-of-box.
  --help                       Show this help message
  --version                    Show version information

AUTHENTICATION:
  Use --api-key or METABOB_API_KEY for authentication. The API key is exchanged
  for a session token on startup, with automatic refresh.

  If METABOB_API_KEY is not set, metabob-mcp also checks ~/.metabob/config.json
  and uses metabob.apiKey (or instance.apiKey) as a fallback.

  Get your API key from the Metabob dashboard: https://app.metabob.com/settings/api-keys

EXAMPLES:
  # Start with API key authentication (recommended)
  npx @metabob/mcp --api-key=mb_live_your_api_key_here

  # Start with default settings (no auth)
  npx @metabob/mcp

  # Point at a specific gateway (analysis/discovery/identity/concept-db all derive from it)
  npx @metabob/mcp --api-key=mb_live_... --endpoint=https://ide.metabob.com

  # Custom session and debug logging
  npx @metabob/mcp --session-id=my-session --log-level=debug

ENVIRONMENT VARIABLES:
  Minimal setup is a single variable — METABOB_API_KEY:
    METABOB_API_KEY            API key for authentication
    METABOB_ENDPOINT           Gateway in the vessel. OPTIONAL — defaults to
                               https://ide.metabob.com, so an API key alone is a
                               valid, fully-derived config. When set, it is the
                               gateway everything else derives from (analysis,
                               discovery, identity, concept-db), exactly like
                               metabob.endpoint in ~/.metabob/config.json.

  Advanced overrides (rarely needed — each wins over the derived value when set):
  ACTIVITY_API_URL             Activity API URL (fallback: METABOB_ENDPOINT / config.json)
  DISCOVERY_ENDPOINT           Discovery-vessel URL for substrate routing
  ANALYSIS_API_URL             Raw analysis-base override; same as --api-url
  SESSION_ID                   Same as --session-id
  SESSION_TOKEN                Pre-obtained session token (advanced)
  LOG_LEVEL                    Same as --log-level
  HEALTH_PORT                  Same as --health-port
  MAX_REQUESTS_PER_MINUTE      Same as --max-requests-per-minute
  SUBMIT_TIMEOUT_MS            Timeout for init_workspace file submission (default: 120000)

  Precedence: CLI flags > environment variables > ~/.metabob/config.json.

  Local substrate note:
    If ~/.metabob/config.json points metabob.endpoint at http://localhost:18080,
    metabob-mcp automatically derives DISCOVERY_ENDPOINT=http://localhost:18100.
    Substrate tools then resolve concept-db / goal-host-vessel through discovery.

INTEGRATION WITH MCP CLIENTS:

  Claude Desktop (~/Library/Application Support/Claude/claude_desktop_config.json):
  {
    "mcpServers": {
      "metabob": {
        "command": "npx",
        "args": ["@metabob/mcp@latest"],
        "env": {
          "METABOB_API_KEY": "mb_live_your_api_key_here",
          "METABOB_ENDPOINT": "https://ide.metabob.com"
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
        'endpoint': { type: 'string' },
        'api-url': { type: 'string' },
        'session-id': { type: 'string' },
        'api-key': { type: 'string' },
        'session-token': { type: 'string' },
        'jwt-token': { type: 'string' },
        'log-level': { type: 'string' },
        'health-port': { type: 'string' },
        'max-requests-per-minute': { type: 'string' },
        'no-system-ca': { type: 'boolean' },
        'help': { type: 'boolean', short: 'h' },
        'version': { type: 'boolean', short: 'v' },
      },
      strict: true,
      allowPositionals: false,
    });

      return {
        apiUrl: values['api-url'] as string | undefined,
        endpoint: values['endpoint'] as string | undefined,
        sessionId: values['session-id'] as string | undefined,
        apiKey: values['api-key'] as string | undefined,
        sessionToken: (values['session-token'] as string | undefined) ?? (values['jwt-token'] as string | undefined),
        logLevel: values['log-level'] as string | undefined,
        healthPort: values['health-port'] ? parseInt(values['health-port'] as string, 10) : undefined,
        maxRequestsPerMinute: values['max-requests-per-minute']
          ? parseInt(values['max-requests-per-minute'] as string, 10)
          : undefined,
      noSystemCa: values['no-system-ca'] as boolean | undefined,
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
  // Doctor subcommand: handle BEFORE parseArgs (strict mode rejects positionals).
  // Form: `npx @metabob/mcp doctor [...]`
  if (process.argv[2] === 'doctor') {
    // Strip the subcommand so doctor-cli sees only its own args.
    process.argv.splice(2, 1);
    const { runDoctor } = await import('./doctor.js');
    try {
      const { exitCode } = await runDoctor();
      process.exit(exitCode);
    } catch (err) {
      console.error('[metabob-mcp doctor] fatal:', err instanceof Error ? err.message : err);
      process.exit(2);
    }
    return;
  }

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

  // Install OS trust store BEFORE any HTTPS request fires. This is the
  // single most impactful mitigation for corporate proxies / Zscaler /
  // MDM-deployed SSL inspection that otherwise breaks every Metabob call
  // with UNABLE_TO_GET_ISSUER_CERT_LOCALLY. Opt-out via --no-system-ca or
  // METABOB_NO_SYSTEM_CA=1.
  const noSystemCa = options.noSystemCa === true || process.env.METABOB_NO_SYSTEM_CA === '1';
  installSystemTrustStoreSync({ disabled: noSystemCa });

  // The two derivation-participating flags (--endpoint, --api-key) must land in
  // the environment BEFORE the config loaders run, so the gateway derivation in
  // loadMetabobEnvConfig() sees the flag value. --endpoint is the flag mirror of
  // METABOB_ENDPOINT / metabob.endpoint.
  if (options.apiKey) {
    process.env.METABOB_API_KEY = options.apiKey;
  }
  if (options.endpoint) {
    process.env.METABOB_ENDPOINT = options.endpoint;
  }

  // Precedence, lowest to highest: ~/.metabob/config.json  <  env vars  <
  // explicit specific overrides (ANALYSIS_API_URL, --api-url). applyConfigDefaults
  // only fills variables that are currently unset, so applying the env-derived
  // config (METABOB_ENDPOINT gateway) BEFORE the file config lets its derived
  // siblings win over the file. The canonical minimal setup is METABOB_API_KEY +
  // METABOB_ENDPOINT — the endpoint is the gateway everything else derives from.
  applyConfigDefaults(process.env, loadMetabobEnvConfig());
  applyConfigDefaults(process.env, loadMetabobCLIConfig());

  // Remaining CLI options are raw overrides that beat any derived/file value.
  // --api-url / ANALYSIS_API_URL is the advanced raw analysis-base override —
  // it deliberately overwrites the gateway-derived analysis endpoint.
  if (options.apiUrl) {
    process.env.ANALYSIS_API_URL = options.apiUrl;
  }
  if (options.sessionId) {
    process.env.SESSION_ID = options.sessionId;
  }
  if (options.sessionToken) {
    process.env.SESSION_TOKEN = options.sessionToken;
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

  // The server requires the Bun runtime (bun:sqlite in the local seed store).
  // Under Node the import below would die with an opaque
  // ERR_UNSUPPORTED_ESM_URL_SCHEME — fail fast with an actionable message
  // instead. --help, --version, and the doctor subcommand still run under Node.
  if (!process.versions.bun) {
    console.error(
      '[metabob-mcp] The MCP server requires the Bun runtime (https://bun.sh) — ' +
        'it uses bun:sqlite for the local analysis cache.\n' +
        '  Install: curl -fsSL https://bun.sh/install | bash   (Windows: powershell -c "irm bun.sh/install.ps1 | iex")\n' +
        '  Then re-run; the npx/npm bin shim invokes bun automatically once it is on PATH.\n' +
        '  Note: Bun has no Windows ARM64 build — Windows on ARM is unsupported.',
    );
    process.exit(1);
  }

  // Import and start the MCP server
  // The index.ts file will read from environment variables we just set
  await import('./index.js');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
