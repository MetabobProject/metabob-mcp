# Publishing @metabob/mcp

## Prerequisites

- npm account with publish access to `@metabob` org
- `npm login` completed

## About the build

`bun build` compiles all TypeScript — including `@metabob/cpg-inference` source, which is bundled inline — into `dist/cli.js`. Native Node addons (`tree-sitter`, `tree-sitter-javascript`, `tree-sitter-python`, `tree-sitter-typescript`) are kept **external** because `.node` binaries cannot be bundled; they are listed in `dependencies` so npm installs them alongside `dist/cli.js`.

The published tarball is the `files` allowlist in `package.json`: `dist/**/*`, `skills/**/*`, `README.md`, `LICENSE`. `skills/` carries the bundled agent skill, which is required at runtime, not incidental.

## The CPG library

The CPG library is a git submodule at `vendor/cpg-inference`, imported by
relative path (`src/cpg-inference.ts` re-exports `../vendor/cpg-inference/src/*`).
There is no `@metabob/cpg-inference` entry in `package.json` and no npm
resolution involved — it is source that gets bundled into `dist/cli.js`.

`bun run preflight` (`scripts/verify-vendor.ts`) fails the build when
`vendor/cpg-inference/src/index.ts` or `vendor/cpg-inference/include` is
absent; the fix is `git submodule update --init --recursive`.

## Preconditions

- `bun run typecheck` passes
- `bun run build` succeeds (`dist/cli.js` and `dist/doctor-cli.js` present)
- `npm link && metabob-mcp --version` works from a different directory
- `npm publish --dry-run` shows no warnings
- `README.md` matches the tool set in `src/tools/index.ts` and the env vars in `src/cli.ts`

## Workflow

```bash
# 1. Type check + build
bun run typecheck
bun run build

# 2. Verify package contents (dist/cli.js, README.md, LICENSE)
npm pack --dry-run

# 3. Bump version (patch / minor / major)
npm version minor   # patch | minor | major

# 4. Dry run publish
npm publish --dry-run

# 5. Publish
npm publish

# 6. Verify
npm info @metabob/mcp
npx @metabob/mcp@latest --version

# 7. Land the version commit on dev, then fast-forward main
git push origin HEAD:dev
git push origin main          # allowed: version bumped + commit already on dev
git push origin --tags
```

For pre-release: `npm publish --tag beta`

## Troubleshooting

**Authentication** — `npm logout && npm login`

**Build too large** — the `files` allowlist in `package.json` is authoritative and wins over `.npmignore`; nothing outside `dist/`, `skills/`, `README.md`, and `LICENSE` ships. Confirm with `npm pack --dry-run`.

**Version conflict** — bump with `npm version patch` and republish; published versions cannot be overwritten.

**Emergency deprecation** — `npm deprecate @metabob/mcp@<version> "reason"` (preferred over unpublish).
