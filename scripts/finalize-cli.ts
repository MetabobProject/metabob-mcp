import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const cliPath = join(process.cwd(), 'dist', 'cli.js');

// Replace the Node shebang with bun. The bundle pulls in `bun:sqlite` (via
// LocalStore) which Node cannot resolve; bun is required at runtime.
const text = await readFile(cliPath, 'utf-8');
const replaced = text.replace(/^#!\/usr\/bin\/env node\n/, '#!/usr/bin/env bun\n');
if (replaced !== text) {
  await writeFile(cliPath, replaced);
}

if (process.platform !== 'win32') {
  await chmod(cliPath, 0o755);
}
