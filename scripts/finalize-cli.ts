import { chmod } from 'node:fs/promises';
import { join } from 'node:path';

if (process.platform !== 'win32') {
  await chmod(join(process.cwd(), 'dist', 'cli.js'), 0o755);
}
