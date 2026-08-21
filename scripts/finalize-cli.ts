import { chmod, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const distDir = join(process.cwd(), 'dist');

// cli.js: KEEP the `#!/usr/bin/env node` shebang. Do not rewrite it to bun.
//
// The server does require bun at runtime (the bundle pulls in `bun:sqlite` via
// LocalStore), and this file used to rewrite the shebang to `#!/usr/bin/env bun` to
// say so. That broke every documented entrypoint on a Node-only machine: `npx
// @metabob/mcp` died with a bare `/usr/bin/env: 'bun': No such file or directory`
// (exit 127) before any JS ran, so the actionable "install bun" message inside the
// bundle could never print. src/cli.ts now opens with a Node-side trampoline that
// re-execs into bun for server invocations and prints that message when bun is
// missing — which only works if the shebang stays node. This is load-bearing.
const cliPath = join(distDir, 'cli.js');
const cliText = await readFile(cliPath, 'utf-8');
if (!cliText.startsWith('#!/usr/bin/env node\n')) {
  throw new Error(
    `dist/cli.js must ship with a node shebang for npx to work on Node-only machines; found: ${cliText.slice(0, cliText.indexOf('\n'))}`,
  );
}

if (process.platform !== 'win32') {
  await chmod(cliPath, 0o755);
}

// doctor-cli.js: keep node shebang so users on plain Node ≥18 (no bun
// installed) can still run the diagnostic. doctor-cli imports only
// Node-safe modules.
const doctorPath = join(distDir, 'doctor-cli.js');
try {
  await stat(doctorPath);
  if (process.platform !== 'win32') {
    await chmod(doctorPath, 0o755);
  }
} catch {
  // doctor-cli not built (skip silently)
}
