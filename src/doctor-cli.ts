#!/usr/bin/env node
/**
 * Dedicated bin entry for metabob-mcp-doctor.
 *
 * Lives separate from cli.ts so it can be launched even if the main MCP
 * server fails to load (e.g., bun:sqlite missing on plain Node). This file
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
  --help, -h        Show this help message

ENVIRONMENT:
  NO_COLOR          Disable ANSI color output
  FORCE_COLOR       Force ANSI color output

Exit code: 0 if all Metabob hosts are reachable (even if TLS-intercepted),
1 if any Metabob host is unreachable.
`);
    process.exit(0);
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
