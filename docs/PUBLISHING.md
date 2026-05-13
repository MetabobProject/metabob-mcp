# Publishing @metabob/mcp

## Prerequisites

- npm account with publish access to `@metabob` org
- `npm login` completed

## About the build

`bun build` compiles all TypeScript — including `@metabob/cpg-inference` source, which is bundled inline — into `dist/cli.js`. Native Node addons (`onnxruntime-node`, `tree-sitter-*`, `usearch`) are kept **external** because `.node` binaries cannot be bundled; they are listed in `dependencies` so npm installs them alongside `dist/cli.js`.

The published tarball contains only `dist/cli.js`, `README.md`, and `LICENSE`. Consumers never see the `file:../cpg-inference-ts` reference — it resolves at build time and the output is self-contained.

## @metabob/cpg-inference dependency

`package.json` references `@metabob/cpg-inference` as `file:../cpg-inference-ts`. This is intentional: the source is bundled into `dist/cli.js` at build time and is not a runtime dependency. npm accepts this because the `file:` package is not present in the published tarball's dependency tree.

If you want to publish `@metabob/cpg-inference` as a standalone package (e.g. for consumers who use the CPG library directly), it now has its own build pipeline:

```bash
cd repos/cpg-inference-ts
bun run build   # → dist/index.js + dist/*.d.ts
npm publish
```

After publishing, update `metabob-mcp/package.json` to use the version range:

```json
"@metabob/cpg-inference": "^0.1.0"
```

## Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun run build` succeeds (`dist/cli.js` present)
- [ ] `npm link && metabob-mcp --version` works from a different directory
- [ ] `npm publish --dry-run` shows no warnings
- [ ] `README.md` reflects current tools and env vars
- [ ] `package.json` version is correct

## Workflow

```bash
# 1. Type check + build
bun run typecheck
bun run build

# 2. Verify package contents (dist/cli.js, README.md, LICENSE)
npm pack --dry-run

# 3. Bump version (patch / minor / major)
npm version minor   # e.g. 0.2.0 → 0.3.0

# 4. Dry run publish
npm publish --dry-run

# 5. Publish
npm publish

# 6. Verify
npm info @metabob/mcp
npx @metabob/mcp@latest --version

# 7. Push version commit + tag
git push origin main
git push origin --tags
```

For pre-release: `npm publish --tag beta`

## Troubleshooting

**Authentication** — `npm logout && npm login`

**Build too large** — check `.npmignore`; `docs/`, `scripts/`, `tests/`, `src/` should all be excluded (only `dist/` and root metadata files are published).

**Version conflict** — bump with `npm version patch` and republish; published versions cannot be overwritten.

**Emergency deprecation** — `npm deprecate @metabob/mcp@<version> "reason"` (preferred over unpublish).
