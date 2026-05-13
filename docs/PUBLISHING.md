# Publishing @metabob/mcp

## Prerequisites

- npm account with publish access to `@metabob` org
- `npm login` completed
- `@metabob/cpg-inference` published to npm (see below)

## About the build

`bun build` compiles all TypeScript (including `@metabob/cpg-inference`) into `dist/cli.js`. Native Node addons — `onnxruntime-node`, `tree-sitter`, `tree-sitter-javascript`, `tree-sitter-python`, and `usearch` — are kept **external** because `.node` binaries cannot be bundled. They are listed in `dependencies` so npm installs them alongside `dist/cli.js`.

## @metabob/cpg-inference dependency

`package.json` currently references `@metabob/cpg-inference` as `file:../cpg-inference-ts`. Before publishing `@metabob/mcp` to npm you must either:

1. **Publish `@metabob/cpg-inference` separately** — build `cpg-inference-ts`, publish it, then update the dependency to a version range (`"@metabob/cpg-inference": "^0.1.0"`).
2. **Bundle it** — the bun build already inlines cpg-inference TypeScript source, so it works in the bundle; the `file:` reference just needs to resolve at build time. If the final npm package only ships `dist/cli.js` (no source), consumers never see the `file:` reference.

Option 2 is the path of least resistance for the initial publish. Confirm `npm pack --dry-run` shows only `dist/**`, `README.md`, and `LICENSE`.

## Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun run build` succeeds and `dist/cli.js` is present
- [ ] `npm link && metabob-mcp --version` works from a different directory
- [ ] `README.md` reflects current tools and env vars
- [ ] `package.json` version is correct
- [ ] `@metabob/cpg-inference` `file:` dep resolved (see above)

## Workflow

```bash
# 1. Type check + build
bun run typecheck
bun run build

# 2. Verify package contents (should be dist/, README.md, LICENSE only)
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

**`file:` dependency rejected** — npm rejects `file:` references on publish. Replace with a published version range before running `npm publish`.

**Build too large** — check `.npmignore`; `docs/`, `scripts/`, `tests/`, `src/` should all be excluded (only `dist/` and root metadata files are published).

**Version conflict** — bump with `npm version patch` and republish; published versions cannot be overwritten.

**Emergency deprecation** — `npm deprecate @metabob/mcp@<version> "reason"` (preferred over unpublish).
