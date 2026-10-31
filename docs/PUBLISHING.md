# Publishing @metabob/mcp

## Prerequisites

The release workflow publishes (§ Workflow); nobody publishes from a machine. A release needs push access to `dev`
and permission to push a `v*` tag.

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
- npm accepts the release workflow's publish: `@metabob/mcp` lists this repository's
  `.github/workflows/release.yml` as a trusted publisher on npmjs.com, or the repository has an `NPM_TOKEN` secret
  with publish access
- `README.md`'s tool table is the default set (`src/tool-allowlist.ts@default-tool-set`), its "Every tool" paragraph
  names every other tool in `src/tools/index.ts`, and its configuration table lists the variables `src/cli.ts`
  and `src/config.ts` read

## Workflow

The plugins pin the server to the package's exact version (README § Agent plugins), and plugin marketplaces clone
the repository's default branch, `main`: a pinned version that is not on npm cannot start. So `main` moves only
after npm has the version its bundles pin. The release workflow, `.github/workflows/release.yml`, publishes a
tagged release commit and then fast-forwards `main` to it; the `pre-push` hook refuses a push that adds commits to
`main` (scripts/git-hooks/README.md § Branch policy).

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

# 3. Tag the release commit: the tag starts the release workflow
git tag v<x.y.z> && git push origin v<x.y.z>
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

The workflow, for a tag `v<x.y.z>`:

1. refuses a tag that does not match `package.json`'s version, a commit not on `dev`, a `main` that cannot
   fast-forward to the commit, and bundles (`mcp.json`, `plugin/.mcp.json`, `.mcp.json`) that pin another version;
2. installs, typechecks, checks the doc links and the generated bundles, builds, runs the tests, and packs;
3. publishes `@metabob/mcp@<x.y.z>` with provenance, as `latest`, and adds `next` to it, so `next` is never older
   than `latest`;
4. waits until npm serves the version, then starts it as the plugins launch it
   (`npx -y --package=metabob-mcp-server@npm:@metabob/mcp@<x.y.z> metabob-mcp --version`);
5. fast-forwards `main` to the tagged commit.

Each step is idempotent: a version already on npm is not published again, and a `main` that already contains the
commit is left alone. A run that failed is re-run from the Actions page, or for a tag that is already pushed:
`gh workflow run release.yml -f tag=v<x.y.z>`. With `-f dry_run=true` the workflow checks, builds, tests and runs
`npm publish --dry-run`, and publishes nothing and leaves `main` alone.

### A pre-release

A release candidate (`<x.y.z>-rc.<n>`) takes the same steps, with the candidate's version. The workflow publishes
it under the `next` tag, so `latest` and `npx -y @metabob/mcp` keep the last release, and leaves `main` where it
is: plugin marketplaces clone `main`, whose bundles pin the last release.

```bash
npm version --no-git-tag-version <x.y.z>-rc.<n>
node scripts/build-plugins.mjs && node scripts/build-plugins.mjs --check
git show :.mcp.json | sed 's#@metabob/mcp@[^"]*"#@metabob/mcp@<x.y.z>-rc.<n>"#' > "${TMPDIR:-/tmp}/mcp.json" \
  && git update-index --cacheinfo "100644,$(git hash-object -w "${TMPDIR:-/tmp}/mcp.json"),.mcp.json" \
  && git update-index --skip-worktree .mcp.json
bun run typecheck && bun run build && bun run test
git commit -am "chore(release): <x.y.z>-rc.<n>"
git push origin HEAD:dev             # CI and Package smoke green on every job before tagging
git tag v<x.y.z>-rc.<n> && git push origin v<x.y.z>-rc.<n>
```

A client tries the candidate by pinning it, in the form the plugins use, which also works inside a checkout of
this repository (`npx -y --package=metabob-mcp-server@npm:@metabob/mcp@<x.y.z>-rc.<n> metabob-mcp`).

## Troubleshooting

**The workflow cannot publish** (`E401`, `E403`, `ENEEDAUTH`) — the trusted publisher on npmjs.com names another
repository or workflow file, or `NPM_TOKEN` has expired. Fix it, then re-run the failed run.

**main cannot fast-forward** — the first step refuses before anything is published: `main` has commits `dev` lacks
(`git log origin/dev..origin/main`). Bring them onto `dev`, then release from a new commit there.

**Build too large** — the `files` allowlist in `package.json` is authoritative and wins over `.npmignore`; nothing outside `dist/`, `skills/`, `README.md`, and `LICENSE` ships. Confirm with `npm pack --dry-run`.

**Version conflict** — bump with `npm version patch` and republish; published versions cannot be overwritten.

**Emergency deprecation** — `npm deprecate @metabob/mcp@<version> "reason"` (preferred over unpublish).
