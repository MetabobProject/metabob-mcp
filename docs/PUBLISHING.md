# Publishing @metabob/mcp

## Prerequisites

- npm account with publish access to `@metabob` org
- `npm login` completed

## Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun run build` succeeds
- [ ] `README.md` reflects current tools and env vars
- [ ] `package.json` version is correct

## Workflow

```bash
# 1. Type check + build
bun run typecheck
bun run build

# 2. Verify package contents
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

**Build too large** — check `.npmignore`; `docs/`, `scripts/`, `tests/`, `src/` should all be excluded (only `dist/` is published)

**Version conflict** — bump with `npm version patch` and republish; published versions cannot be overwritten

**Emergency deprecation** — `npm deprecate @metabob/mcp@<version> "reason"` (preferred over unpublish)
