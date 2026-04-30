#!/usr/bin/env bash
# Install metabob-mcp's versioned git hooks for this clone.
# Sets core.hooksPath = scripts/git-hooks/ so updates land via `git pull`.
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
git -C "$REPO_ROOT" config core.hooksPath scripts/git-hooks
chmod +x "$REPO_ROOT/scripts/git-hooks/pre-commit" "$REPO_ROOT/scripts/git-hooks/install.sh"
echo "metabob-mcp: core.hooksPath set to scripts/git-hooks/"
