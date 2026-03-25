# Publishing @metabob/metabob-mcp to npm

This guide covers publishing the metabob-mcp package to npm for distribution via npx.

## Prerequisites

1. **npm Account**: You need an npm account with publish access to the `@metabob` organization
2. **npm CLI**: Install via `npm install -g npm@latest`
3. **Authentication**: Log in via `npm login`

## Pre-Publication Checklist

- [ ] All tests pass: `bun test`
- [ ] Type checking passes: `bun run typecheck`
- [ ] Build succeeds: `bun run build`
- [ ] README.md is up to date
- [ ] CHANGELOG.md updated (if exists)
- [ ] Version number is correct in package.json

## Publishing Workflow

### 1. Verify Authentication

```bash
npm whoami
# Should display your npm username
```

### 2. Run Pre-Publish Checks

```bash
# Type check
bun run typecheck

# Build
bun run build

# Run test workflow
./test-npx-workflow.sh
```

### 3. Update Version

Follow semantic versioning (semver):

- **Patch** (0.1.X): Bug fixes, documentation, minor changes
- **Minor** (0.X.0): New features, backward-compatible changes
- **Major** (X.0.0): Breaking changes

```bash
# For patch release (0.1.0 → 0.1.1)
npm version patch

# For minor release (0.1.0 → 0.2.0)
npm version minor

# For major release (0.1.0 → 1.0.0)
npm version major
```

This will:
- Update version in package.json
- Create a git commit
- Create a git tag

### 4. Test the Package Locally

```bash
# Create a tarball
npm pack

# Test the tarball
./dist/cli.js --help
./dist/cli.js --version

# Verify package contents
tar -tzf metabob-metabob-mcp-*.tgz
```

### 5. Publish to npm

#### Dry Run (Recommended First)

```bash
npm publish --dry-run
```

This shows what will be published without actually publishing.

#### Actual Publish

```bash
npm publish
```

For beta/alpha releases:

```bash
# Beta release
npm publish --tag beta

# Alpha release
npm publish --tag alpha
```

### 6. Verify Publication

```bash
# Check package info
npm info @metabob/metabob-mcp

# Test installation
npx @metabob/metabob-mcp@latest --version
npx @metabob/metabob-mcp@latest --help
```

### 7. Push Git Changes

```bash
# Push the version commit and tag
git push origin main
git push origin --tags
```

## Post-Publication Tasks

1. **Test with MCP Clients**: Verify the package works with Claude Desktop, Cursor, etc.
2. **Update Documentation**: Ensure all docs reference the correct version
3. **Announce**: Notify team/users about the new release
4. **Monitor**: Check npm download stats and watch for issues

## Troubleshooting

### Authentication Issues

```bash
# Re-login to npm
npm logout
npm login

# Verify authentication
npm whoami
```

### Permission Errors

```bash
# Check organization access
npm org ls @metabob

# Request access if needed
# Contact organization admin
```

### Build Failures

```bash
# Clean build
rm -rf dist/
bun run build

# Verify output
ls -la dist/
head -5 dist/cli.js  # Should show shebang
```

### Package Size Issues

```bash
# Check what will be published
npm pack --dry-run

# Check package size
npm pack
du -h metabob-metabob-mcp-*.tgz

# If too large, check .npmignore
```

### Version Already Published

```bash
# Can't overwrite published versions
# Increment version and republish
npm version patch
npm publish
```

## Unpublishing (Emergency Only)

**WARNING**: Unpublishing can break dependent packages. Only use in emergencies.

```bash
# Unpublish specific version (within 72 hours)
npm unpublish @metabob/metabob-mcp@0.1.0

# Deprecate instead (recommended)
npm deprecate @metabob/metabob-mcp@0.1.0 "Critical bug - use 0.1.1 instead"
```

## Version History

Keep track of published versions:

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0   | 2026-03-24 | Initial release with npx support |

## Support

For issues with publishing:
- npm support: https://www.npmjs.com/support
- Internal: Contact DevOps team

## References

- [npm Publishing Guide](https://docs.npmjs.com/cli/v9/commands/npm-publish)
- [Semantic Versioning](https://semver.org/)
- [npm Scoped Packages](https://docs.npmjs.com/cli/v9/using-npm/scope)
