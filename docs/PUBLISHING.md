# Publishing @metabob/mcp

## Prerequisites

- npm account with publish access to `@metabob` org
- `npm login` completed

## About the build

`bun build` compiles all TypeScript — including `@metabob/cpg-inference` source, which is bundled inline — into `dist/cli.js`. Native Node addons (`tree-sitter`, `tree-sitter-javascript`, `tree-sitter-python`, `tree-sitter-typescript`) are kept **external** because `.node` binaries cannot be bundled; they are listed in `dependencies` so npm installs them alongside `dist/cli.js`. They are the only `dependencies`: every other package the server uses (the MCP SDK, zod, hono, undici, ajv, system-ca) is bundled into `dist/` and listed in `devDependencies`, so a user's `npx` installs the four native packages and nothing else. `tests/unit/package-dependencies.test.ts` holds `dependencies` equal to the build's `--external` list and checks that the bundle loads no other package.

The published tarball is the `files` allowlist in `package.json`: `dist/**/*`, `skills/**/*`, `README.md`, `LICENSE`. `skills/` carries the bundled agent skill, which is required at runtime, not incidental.

## The CPG library

The CPG library is a git submodule at `vendor/cpg-inference`, imported by
relative path (`src/cpg-inference.ts` re-exports `../vendor/cpg-inference/src/*`).
There is no `@metabob/cpg-inference` entry in `package.json` and no npm
resolution involved — it is source that gets bundled into `dist/cli.js`.

`bun run preflight` (`scripts/verify-vendor.ts`) fails the build when
`vendor/cpg-inference/src/index.ts` is absent; the fix is
`git submodule update --init --recursive`.

## Preconditions

- `bun run typecheck` passes
- `bun run build` succeeds (`dist/cli.js` and `dist/doctor-cli.js` present)
- `npm link && metabob-mcp --version` works from a different directory
- `npm publish --dry-run` shows no warnings
- `README.md` matches the tool set in `src/tools/index.ts` and the env vars in `src/cli.ts`

## Workflow

The plugins pin the server to the package's exact version (README § Agent plugins), so a version bump regenerates
them in the same commit, and the package is published before `main` moves: plugin marketplaces clone `main`, and a
pinned version that is not on npm yet cannot start.

```bash
# 1. Bump the version and regenerate the plugin bundles, which pin it
npm version --no-git-tag-version <x.y.z>
node scripts/build-plugins.mjs && node scripts/build-plugins.mjs --check
bun install --frozen-lockfile        # the lockfile is unchanged by a version bump

# 2. Check, then commit the release on dev
bun run typecheck && bun run build && bun run test
npm pack --dry-run                   # dist/, skills/, README.md, LICENSE; no other files
git commit -am "chore(release): <x.y.z>"
git push origin HEAD:dev             # CI and Package smoke run at this head: both green on every job

# 3. Publish, then verify the published package
npm publish --dry-run
npm publish
npm info @metabob/mcp version
npx -y @metabob/mcp@<x.y.z> --version

# 4. Tag, and fast-forward main to the release commit
git tag v<x.y.z> && git push origin v<x.y.z>
git push origin HEAD:main            # allowed: version bumped, and the commit is already on dev
```

For a pre-release, publish with `npm publish --tag beta` and leave `main` where it is.

## Troubleshooting

**Authentication** — `npm logout && npm login`

**Build too large** — the `files` allowlist in `package.json` is authoritative and wins over `.npmignore`; nothing outside `dist/`, `skills/`, `README.md`, and `LICENSE` ships. Confirm with `npm pack --dry-run`.

**Version conflict** — bump with `npm version patch` and republish; published versions cannot be overwritten.

**Emergency deprecation** — `npm deprecate @metabob/mcp@<version> "reason"` (preferred over unpublish).
