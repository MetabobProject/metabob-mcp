# Publishing @metabob/mcp

## Prerequisites

- npm account with publish access to `@metabob` org
- `npm login` completed

## About the build

`bun build` compiles all TypeScript — including `@metabob/cpg-inference` source, which is bundled inline — into `dist/` (`dist/cli.js`, `dist/doctor-cli.js` and their chunks). Native Node addons (`tree-sitter`, `tree-sitter-javascript`, `tree-sitter-python`, `tree-sitter-typescript`) are kept **external** because `.node` binaries cannot be bundled; they are listed in `dependencies` so npm installs them alongside `dist/cli.js`. They are the only `dependencies`: every other package the server uses (the MCP SDK, zod, hono, undici, ajv, system-ca) is bundled into `dist/` and listed in `devDependencies`, so a user's `npx` installs the four native packages and nothing else. `tests/unit/package-dependencies.test.ts` holds `dependencies` equal to the build's `--external` list and checks that the bundle loads no other package.

The published tarball is the `files` allowlist in `package.json`: `dist/**/*`, `skills/**/*`, `README.md`, `LICENSE`. `skills/` carries the agent skills (`metabob` and `metabob-substrate`) for clients that install them from the
package; the server itself does not read them.

## The CPG library

The CPG library is a git submodule at `vendor/cpg-inference`, imported by
relative path (`src/cpg-inference.ts` re-exports `../vendor/cpg-inference/src/*`).
There is no `@metabob/cpg-inference` entry in `package.json` and no npm
resolution involved — it is source that gets bundled into `dist/`.

`bun run preflight` (`scripts/verify-vendor.ts`) fails the build when
`vendor/cpg-inference/src/index.ts` is absent; the fix is
`git submodule update --init --recursive`.

## Preconditions

- The repository's default branch on GitHub is `main`, the branch plugin marketplaces clone
  (`gh repo view --json defaultBranchRef`); `dev`'s bundles pin the next version, published or not
- `bun run typecheck` passes
- `bun run build` succeeds (`dist/cli.js` and `dist/doctor-cli.js` present)
- `npm link && metabob-mcp --version` works from a different directory
- `npm publish --dry-run` shows no warnings
- `README.md`'s tool table is the default set (`src/tool-allowlist.ts@default-tool-set`), its "Every tool" paragraph
  names every other tool in `src/tools/index.ts`, and its configuration table lists the variables `src/cli.ts`
  and `src/config.ts` read

## Workflow

The plugins pin the server to the package's exact version (README § Agent plugins), so a version bump regenerates
them in the same commit, and the package is published before `main` moves: plugin marketplaces clone the repository's default branch,
which is `main`, and a
pinned version that is not on npm yet cannot start.

```bash
# 1. Bump the version and regenerate the plugin bundles, which pin it
npm version --no-git-tag-version <x.y.z>
node scripts/build-plugins.mjs && node scripts/build-plugins.mjs --check
# The repository's own .mcp.json pins the same version (a test holds it). Edit it; or, when your copy is
# skip-worktree with local settings (`git ls-files -v .mcp.json` shows S), write the committed one:
git show :.mcp.json | sed 's#@metabob/mcp@[^"]*"#@metabob/mcp@<x.y.z>"#' > "${TMPDIR:-/tmp}/mcp.json" \
  && git update-index --cacheinfo "100644,$(git hash-object -w "${TMPDIR:-/tmp}/mcp.json"),.mcp.json" \
  && git update-index --skip-worktree .mcp.json
bun install --frozen-lockfile        # the lockfile is unchanged by a version bump

# 2. Check, then commit the release on dev
bun run typecheck && bun run build && bun run test
npm pack --dry-run                   # dist/, skills/, README.md, LICENSE; no other files
git commit -am "chore(release): <x.y.z>"
git push origin HEAD:dev             # CI and Package smoke run at this head: both green on every job

# 3. Publish, then verify the published package
npm publish --dry-run
npm publish
npm dist-tag add @metabob/mcp@<x.y.z> next   # so next is never older than latest
npm view @metabob/mcp dist-tags              # latest and next: <x.y.z>
# The alias form, as the plugins launch it: in this checkout, whose package.json has the package's name and
# version, `npx -y @metabob/mcp@<x.y.z>` would take the checkout for the package and fail (`mcp: not found`).
npx -y --package=metabob-mcp-server@npm:@metabob/mcp@<x.y.z> metabob-mcp --version

# 4. Tag, and fast-forward main to the release commit
git tag v<x.y.z> && git push origin v<x.y.z>
git push origin HEAD:main            # allowed: version bumped, and the commit is already on dev
```

### A pre-release

A release candidate (`<x.y.z>-rc.<n>`) is published under the `next` tag, so `latest` and `npx -y @metabob/mcp`
keep the last release, and `main` stays where it is: plugin marketplaces clone the default branch, `main`, whose
bundles pin the last release.

```bash
# 1. Bump to the candidate and regenerate the bundles, which pin it, and the repository's own .mcp.json; commit on dev
npm version --no-git-tag-version <x.y.z>-rc.<n>
node scripts/build-plugins.mjs && node scripts/build-plugins.mjs --check
git show :.mcp.json | sed 's#@metabob/mcp@[^"]*"#@metabob/mcp@<x.y.z>-rc.<n>"#' > "${TMPDIR:-/tmp}/mcp.json" \
  && git update-index --cacheinfo "100644,$(git hash-object -w "${TMPDIR:-/tmp}/mcp.json"),.mcp.json" \
  && git update-index --skip-worktree .mcp.json
bun run typecheck && bun run build && bun run test
git commit -am "chore(release): <x.y.z>-rc.<n>"
git push origin HEAD:dev             # CI and Package smoke green on every job before publishing

# 2. Publish under next, and check that latest did not move
npm publish --tag next
npm view @metabob/mcp dist-tags      # latest: the last release; next: the candidate
npx -y --package=metabob-mcp-server@npm:@metabob/mcp@<x.y.z>-rc.<n> metabob-mcp --version
```

A client tries the candidate by pinning it, in the form the plugins use, which also works inside a checkout of
this repository (`npx -y --package=metabob-mcp-server@npm:@metabob/mcp@<x.y.z>-rc.<n> metabob-mcp`). The release itself is the
workflow above, from a version bump to `<x.y.z>`; the candidate is never tagged and never reaches `main`.

## Troubleshooting

**Authentication** — `npm logout && npm login`

**Build too large** — the `files` allowlist in `package.json` is authoritative and wins over `.npmignore`; nothing outside `dist/`, `skills/`, `README.md`, and `LICENSE` ships. Confirm with `npm pack --dry-run`.

**Version conflict** — bump with `npm version patch` and republish; published versions cannot be overwritten.

**Emergency deprecation** — `npm deprecate @metabob/mcp@<version> "reason"` (preferred over unpublish).
