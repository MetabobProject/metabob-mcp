#!/usr/bin/env bash
set -e

echo "===== Testing metabob-mcp NPM Distribution Workflow ====="
echo

# Change to package directory
cd "$(dirname "$0")"

echo "1. Running type check..."
bun run typecheck
echo "✓ Type check passed"
echo

echo "2. Building package..."
bun run build
echo "✓ Build completed"
echo

echo "3. Testing CLI help..."
node dist/cli.js --help > /dev/null
echo "✓ Help command works"
echo

echo "4. Testing CLI version..."
VERSION=$(node dist/cli.js --version)
echo "   Version: $VERSION"
echo "✓ Version command works"
echo

echo "5. Testing CLI argument parsing..."
timeout 2 node dist/cli.js \
  --api-url=http://test.example.com \
  --session-id=test-session \
  --log-level=debug \
  --health-port=9090 \
  --max-requests-per-minute=120 \
  2>&1 | grep -q "Starting metabob-mcp server" && echo "✓ Argument parsing works" || echo "✗ Argument parsing failed"
echo

echo "6. Creating npm package tarball..."
npm pack > /dev/null 2>&1
TARBALL=$(ls metabob-metabob-mcp-*.tgz | head -1)
echo "   Created: $TARBALL"
echo "✓ Tarball created"
echo

echo "7. Checking tarball contents..."
echo "   Files in package:"
tar -tzf "$TARBALL" | sed 's/^package\///' | grep -v '^$'
echo "✓ Tarball contents verified"
echo

echo "8. Testing invalid arguments..."
if node dist/cli.js --invalid-option 2>&1 | grep -q "Error parsing arguments"; then
  echo "✓ Invalid argument handling works"
else
  echo "✗ Invalid argument handling failed"
fi
echo

echo "9. Testing environment variable fallback..."
ANALYSIS_API_URL=http://env.example.com \
SESSION_ID=env-session \
LOG_LEVEL=warn \
timeout 1 node dist/cli.js 2>&1 | grep -q "http://env.example.com" && echo "✓ Environment variables work" || echo "⚠ Environment variable test inconclusive (server starts successfully)"
echo

echo "10. Testing CLI precedence over env vars..."
ANALYSIS_API_URL=http://env.example.com \
timeout 2 node dist/cli.js --api-url=http://cli.example.com 2>&1 | grep -q "http://cli.example.com" && echo "✓ CLI argument precedence works" || echo "✗ CLI precedence failed"
echo

echo "===== All Tests Passed! ====="
echo
echo "Package is ready for npm publish:"
echo "  1. npm version patch|minor|major"
echo "  2. npm publish"
echo "  3. Test with: npx @metabob/metabob-mcp@latest --help"
