import { existsSync } from 'node:fs';
import { join } from 'node:path';

const requiredPaths = [
  join(process.cwd(), 'vendor', 'cpg-inference', 'src', 'index.ts'),
];

const missing = requiredPaths.filter((path) => !existsSync(path));

if (missing.length > 0) {
  console.error('Missing vendor/cpg-inference sources.');
  console.error('Run: git submodule update --init --recursive');
  process.exit(1);
}
