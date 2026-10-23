#!/usr/bin/env node
// A minimal npm registry for the package smoke (.github/workflows/package-smoke.yml, SPEC §runtime): it serves one packed tarball
// as the only version of its package, so `npx --package=<alias>@npm:@metabob/mcp@<version>` can be run exactly as
// the plugins write it before that version is published. Point only the package's scope at it
// (`@metabob:registry=http://127.0.0.1:<port>/`); every dependency still comes from the public registry.
//
//   node scripts/ci/smoke-registry.mjs <tarball> <port>
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [tarball, port = '4874'] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'package.json'), 'utf8'));
const body = readFileSync(tarball);
const file = basename(tarball);
const base = `http://127.0.0.1:${port}`;
const packument = {
  name: pkg.name,
  'dist-tags': { latest: pkg.version },
  versions: {
    [pkg.version]: {
      ...pkg,
      _id: `${pkg.name}@${pkg.version}`,
      dist: {
        tarball: `${base}/${pkg.name}/-/${file}`,
        shasum: createHash('sha1').update(body).digest('hex'),
        integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
      },
    },
  },
};

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', base).pathname);
  if (path === `/${pkg.name}`) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(packument));
  }
  if (path.endsWith(`/-/${file}`)) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return res.end(body);
  }
  res.writeHead(404);
  res.end();
}).listen(Number(port), '127.0.0.1', () => console.log(`smoke registry: ${pkg.name}@${pkg.version} on ${base}`));
