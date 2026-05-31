import { chmod, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const distDir = join(process.cwd(), 'dist');

// cli.js: rewrite to bun shebang. The bundle pulls in `bun:sqlite` (via
// LocalStore) which Node cannot resolve; bun is required at runtime.
const cliPath = join(distDir, 'cli.js');
const text = await readFile(cliPath, 'utf-8');
const replaced = text.replace(/^#!\/usr\/bin\/env node\n/, '#!/usr/bin/env bun\n');
if (replaced !== text) {
  await writeFile(cliPath, replaced);
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
