#!/usr/bin/env node
/**
 * CLI wrapper for metabob-mcp
 * Provides command-line argument parsing for npx usage
 */

// Conformal npm entrypoint. This bin ships with the `#!/usr/bin/env node` shebang it
// is written with (scripts/finalize-cli.ts deliberately leaves it alone), so
// `npx @metabob/mcp` starts under Node like every other npm package. The MCP server
// itself needs Bun — bun:sqlite backs the local seed store — so a server invocation
// that lands here under Node re-execs into Bun, and prints an actionable install
// message when Bun is absent. --help, --version and `doctor` are Node-safe and stay
// in-process; they must keep working on a machine that has never seen Bun.
const NODE_SAFE_FLAGS = new Set(['--help', '-h', '--version', '-v']);
const isNodeSafeInvocation =
  process.argv[2] === 'doctor' || process.argv.slice(2).some((a) => NODE_SAFE_FLAGS.has(a));

if (!process.versions.bun && !isNodeSafeInvocation && process.argv[1]) {
  // Same opt-out conditions as the Bun-side re-exec below; passing the flag here
  // means the child starts correctly configured and does not spawn a third process.
  const skipSystemCa =
    process.env.METABOB_NO_SYSTEM_CA === '1' || process.argv.includes('--no-system-ca');
  // Dynamic import: this block runs above the module's import statements, so take the
  // dependency explicitly rather than relying on ESM hoisting surviving the bundler.
  const { resolveBunLauncher, winQuote } = await import('./bun-launcher.js');
  const bun = resolveBunLauncher();
  if (!bun) {
    printBunRequired();
    process.exit(1);
  }
  const { spawn } = await import('node:child_process');
  const bunArgs = [...(skipSystemCa ? [] : ['--use-system-ca']), ...process.argv.slice(1)];
  await new Promise<void>(() => {
    const child = spawn(
      bun.shell ? winQuote([bun.command, ...bunArgs]) : bun.command,
      bun.shell ? [] : bunArgs,
      {
        stdio: 'inherit',
        shell: bun.shell,
        env: { ...process.env, __METABOB_SYSTEM_CA_REEXEC: '1' },
      },
    );
    // An MCP client that kills this process must not orphan the Bun child.
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.on(sig, () => child.kill(sig));
    }
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        printBunRequired();
        process.exit(1);
      }
      console.error(`[metabob-mcp] could not start Bun (${err.message})`);
      process.exit(1);
    });
  });
}

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

// (The Node heap-expansion re-exec that used to live here is gone: ONNX / Tree-sitter
// load only inside the server, the server only runs under Bun, and Bun manages its own
// memory. Under Node this file now reaches nothing heavier than --help or the doctor.)

import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyConfigDefaults, loadMetabobCLIConfig, loadMetabobEnvConfig, withoutEndpoints } from './config.js';
import { installSystemTrustStoreSync } from './tls-trust.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CLIOptions {
  endpoint?: string;
  sessionId?: string;
  apiKey?: string;
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
  npx @metabob/mcp doctor             Diagnose proxy / TLS-inspection issues on the path to the substrate

OPTIONS:
  --api-key <KEY>              API key for the substrate. Same as METABOB_API_KEY.
  --endpoint <URL>             Substrate endpoint (no default). Same as METABOB_ENDPOINT
                               and metabob.endpoint in a config file.
  --session-id <ID>            Session identifier (default: a fresh UUID)
  --log-level <LEVEL>          Logging level: debug, info, warn, error (default: info)
  --health-port <PORT>         Port of the loopback HTTP resolver (default: ephemeral)
  --max-requests-per-minute <N> Rate limit per session (default: 60)
  --no-system-ca               Skip loading OS root CAs at startup (advanced;
                               for users who hit a system-ca read bug). Without
                               this flag, metabob-mcp augments Node's bundled
                               Mozilla roots with the OS trust store so it
                               works behind corporate SSL inspection out-of-box.
  --help                       Show this help message
  --version                    Show version information

ATTACHMENT:
  The server attaches to a substrate with two inputs, an API key and an
  endpoint, and neither has a default. The substrate installer writes both
  into ~/.metabob/config.json, so a machine it has set up needs no flags or
  env. With either missing the server still starts: local tools work, and it
  says once which input is missing.

EXAMPLES:
  # Attach with the installer's config file (no flags)
  npx @metabob/mcp

  # Attach to a local substrate explicitly
  npx @metabob/mcp --api-key=mb_live_... --endpoint=http://127.0.0.1:18080

  # Custom session and debug logging
  npx @metabob/mcp --session-id=my-session --log-level=debug

ENVIRONMENT VARIABLES:
  METABOB_API_KEY              API key
  METABOB_ENDPOINT             Substrate endpoint. A local port-published endpoint
                               (http://127.0.0.1:18080) derives discovery (:18100);
                               a remote endpoint derives nothing, so set
                               DISCOVERY_ENDPOINT with it.

  Advanced overrides (each wins over the derived value when set):
  DISCOVERY_ENDPOINT           Discovery-vessel URL: the anchor (derived from a local
                               endpoint with a warning, census class H1)
  IDENTITY_ENDPOINT            Identity vessel for the org check (default: the
                               identity_endpoint discovery's /bootstrap advertises)
  SESSION_ID                   Same as --session-id
  LOG_LEVEL                    Same as --log-level
  HEALTH_PORT                  Same as --health-port
  MAX_REQUESTS_PER_MINUTE      Same as --max-requests-per-minute

  Precedence: CLI flags > environment variables > config file. An explicit
  METABOB_ENDPOINT takes only the credentials from a config file, never its
  endpoints, so the two cannot split across substrates.

CONFIGURATION FILE:
  Resolution is directory-aware: METABOB_CONFIG_PATH > ./.metabob/config.json
  (the launch directory, which lets a project pin its own backend) >
  ~/.metabob/config.json.
  {
    "metabob": {
      "apiKey": "mb_live_...",                  // or legacy instance.apiKey
      "endpoint": "http://127.0.0.1:18080",     // the substrate endpoint
      // Advanced pins, each winning over its derived value when set:
      "discoveryEndpoint": "...",               // discovery-vessel: the anchor (preferred)
      "identityEndpoint": "..."                 // identity, overriding /bootstrap's
    }
  }
  All keys optional; unknown keys ignored.

INTEGRATION WITH MCP CLIENTS:

  On a machine the substrate installer has set up:
  {
    "mcpServers": {
      "metabob": { "command": "metabob-mcp" }
    }
  }

  Otherwise pass both inputs:
  {
    "mcpServers": {
      "metabob": {
        "command": "npx",
        "args": ["@metabob/mcp@latest"],
        "env": {
          "METABOB_API_KEY": "mb_live_your_api_key_here",
          "METABOB_ENDPOINT": "http://127.0.0.1:18080"
        }
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

// Hoisted so the trampoline at the top of the module can call it before any import.
function printBunRequired() {
  console.error(
    '[metabob-mcp] The MCP server requires the Bun runtime (https://bun.sh) — ' +
      'it uses bun:sqlite for the local analysis cache.\n' +
      '  Install: curl -fsSL https://bun.sh/install | bash   (Windows: powershell -c "irm bun.sh/install.ps1 | iex")\n' +
      '  Then re-run — this command re-execs into bun automatically once it is on PATH.\n' +
      '  Note: Bun has no Windows ARM64 build — Windows on ARM is unsupported.',
  );
}

function parseCliArgs(): CLIOptions {
  try {
    const { values } = parseArgs({
      options: {
        'endpoint': { type: 'string' },
        'session-id': { type: 'string' },
        'api-key': { type: 'string' },
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
        endpoint: values['endpoint'] as string | undefined,
        sessionId: values['session-id'] as string | undefined,
        apiKey: values['api-key'] as string | undefined,
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

  // Precedence, lowest to highest: config file  <  env vars  <  CLI flags.
  // applyConfigDefaults only fills variables that are currently unset, so the
  // explicit METABOB_ENDPOINT derivation runs first, then the config file. An
  // explicit METABOB_ENDPOINT chose the substrate, so only the file's
  // credentials still apply — never its endpoints (see withoutEndpoints).
  // Nothing is defaulted: a missing key or endpoint is reported once, by
  // index.ts (config.ts unattachedMessage). SPEC §precedence,
  // CLAUDE §environment-variables.
  const envConfig = loadMetabobEnvConfig();
  applyConfigDefaults(process.env, envConfig);
  const fileConfig = loadMetabobCLIConfig();
  applyConfigDefaults(process.env, envConfig ? withoutEndpoints(fileConfig) : fileConfig);

  // Install the OS trust store BEFORE any HTTPS request fires, and after the
  // configuration, so the proxy is chosen for the configured substrate host.
  // Behind corporate SSL inspection (Zscaler, MDM-deployed CAs) every call
  // otherwise fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY. Opt-out via
  // --no-system-ca or METABOB_NO_SYSTEM_CA=1.
  const noSystemCa = options.noSystemCa === true || process.env.METABOB_NO_SYSTEM_CA === '1';
  installSystemTrustStoreSync({ disabled: noSystemCa });
  // src/index.ts installs the trust store too, gated only on the env var — export the
  // flag so --no-system-ca actually suppresses it there as well (it is documented as
  // equivalent to METABOB_NO_SYSTEM_CA=1, and the trampoline above reads it the same way).
  if (noSystemCa) {
    process.env.METABOB_NO_SYSTEM_CA = '1';
  }

  // Remaining CLI options beat any file value.
  if (options.sessionId) {
    process.env.SESSION_ID = options.sessionId;
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

  // Belt-and-braces: the trampoline at the top of this file already re-execs into Bun
  // (or exits with the same message) for every server invocation, so reaching here
  // under Node means someone imported this module directly.
  if (!process.versions.bun) {
    printBunRequired();
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
