import { mkdir, readdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

const sourceDir = join(process.cwd(), 'vendor', 'cpg-inference', 'include');
const targetDir = join(process.cwd(), 'include');

await mkdir(targetDir, { recursive: true });

for (const entry of await readdir(sourceDir)) {
  if (entry.endsWith('.onnx') || entry.endsWith('.onnx.data')) {
    await copyFile(join(sourceDir, entry), join(targetDir, entry));
  }
}
