import { chmod, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const distDir = join(process.cwd(), 'dist');

// cli.js: KEEP the `#!/usr/bin/env node` shebang. Do not rewrite it to bun.
//
// Every documented entrypoint (`npx @metabob/mcp`) starts the bin under Node. A bun
// shebang would fail on a machine without Bun before any JS runs (`/usr/bin/env:
// 'bun': No such file or directory`, exit 127). Under Node the server runs in-process
// on node:sqlite, or src/cli.ts's trampoline re-execs into Bun on an older Node, or
// names both fixes; all three need the shebang to stay node. This is load-bearing.
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
