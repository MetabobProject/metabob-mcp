#!/usr/bin/env node
/**
 * Dedicated bin entry for metabob-mcp-doctor.
 *
 * Lives separate from cli.ts so it can be launched even if the main MCP
 * server cannot start (e.g., a Node with no node:sqlite and no Bun). This file
 * imports only Node-safe modules.
 */

import { runDoctor } from './doctor.js';

async function main() {
  // Minimal arg parsing — accept --help / -h.
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`
metabob-mcp-doctor — diagnose corporate-proxy / TLS-inspection issues

USAGE:
  npx @metabob/mcp doctor
  metabob-mcp-doctor

Runs a battery of probes against your network/TLS environment and prints a
human-readable report. Also writes a JSON artifact (metabob-mcp-doctor-<ts>.json
in the current directory) that you can attach to a support ticket.

OPTIONS:
  --attach          Run \`attach --check\` instead: the attachment once, hop by
                    hop (proxy, TLS, /bootstrap, identity, org check, one
                    resolve), naming the cause on failure. Exit 0 when attached.
  --json            With --attach: print the report as JSON
  --help, -h        Show this help message

ENVIRONMENT:
  NO_COLOR          Disable ANSI color output
  FORCE_COLOR       Force ANSI color output

The hosts probed are those of the configured substrate (METABOB_ENDPOINT,
DISCOVERY_ENDPOINT, or a config file), read the same way the server reads them.

Exit code: 0 if every https substrate host is reachable (even if
TLS-intercepted), 1 if any is unreachable or no endpoint is configured.
`);
    process.exit(0);
  }

  // The front door to `attach --check` (SPEC §attach-check).
  if (args.includes('--attach')) {
    const { runAttachCheck } = await import('./attach-check.js');
    process.exit(await runAttachCheck(['--check', ...args.filter((a) => a === '--json')]));
  }

  try {
    const { exitCode } = await runDoctor();
    process.exit(exitCode);
  } catch (err) {
    console.error('[metabob-mcp doctor] fatal:', err instanceof Error ? err.message : err);
    process.exit(2);
  }
}

main();
