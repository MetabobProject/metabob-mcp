# metabob-mcp git hooks

Versioned git hooks for the metabob-mcp vessel repo. Installed by running:

```bash
scripts/git-hooks/install.sh
```

This sets `core.hooksPath` to `scripts/git-hooks/` so updates to the hooks land via `git pull`. Same pattern as the `metabob-devbob` super-repo and the `deployment` repo.

## Philosophy

metabob-mcp is an MCP server distributed via npm (`@metabob/metabob-mcp`). The repo is organised around:

- `src/` — server source (`cli.ts`, `index.ts`, tool handlers)
- `tests/` — test suites
- `docs/` — stateless reference docs (`DEPLOYMENT.md`, `PUBLISHING.md`, `QUICK_START.md`)
- `scripts/` — operational tooling (incl. `scripts/git-hooks/`)
- `openspec/` — change proposals

A small allowlist of project-metadata files lives at root (`CLAUDE.md`, `README.md`, `LICENSE`, `package.json`, `bun.lock`, `tsconfig.json`, `Dockerfile`, `.gitignore`, `.dockerignore`, `.npmignore`, `.env.example`, etc.). Anything else accumulates as cruft.

The pre-commit hook rejects new cruft at commit time. Existing files are grandfathered — the hook only checks newly-added or renamed-into entries.

## Where things go

| You have | Put it in |
|---|---|
| Stateless reference doc | `docs/<topic>.md` |
| One-off operational script | `scripts/<verb>-<noun>.sh` |
| Test (unit / integration) | `tests/<...>` |
| Change proposal | `openspec/changes/<YYYY-MM-DD>-<slug>/proposal.md` |
| Screenshots / playwright output | gitignored — these are session artefacts |
| Status snapshot, fix-complete, investigation note | nowhere — write a commit message instead |

## Branch policy (pre-push hook)

metabob-mcp runs a **two-branch model**:

- **`dev`** — the default/integration branch. All development lands here, via PRs. This is the branch you clone, branch off, and open PRs against.
- **`main`** — the release branch. It advances **only in lockstep with a version update**, and only ever carries commits that already exist on `dev`. `main` never receives direct feature work — it is a sequence of release checkpoints.

The `pre-push` hook enforces this. A push that updates `main` is allowed only when **both**:

1. every pushed commit is already contained in `origin/dev` (main is a subset of dev — release checkpoints, not new work), **and**
2. the pushed range bumps the `"version"` field in `package.json` (the sequential version update).

Pushes to `dev` and feature branches are unaffected.

```bash
# Emergency override (use sparingly):
METABOB_ALLOW_MAIN_PUSH=1 git push origin main
```

## What the pre-commit hook does

The hook runs two layers, in order:

1. **Placement check** — rejects newly-added or renamed-into entries that violate the placement rules. Pre-existing files are grandfathered.
2. **Secrets scan** (`gitleaks protect --staged`) — scans the staged diff for credentials. If gitleaks isn't installed, the scan is skipped with a one-line install hint.

Bypass with `git commit --no-verify` (use sparingly).

## What the pre-commit hook blocks

A commit is rejected when it adds (or renames into) a file that violates any of these rules:

1. **Files at the metabob-mcp root** are limited to a small allowlist of project metadata.
2. **No new top-level markdown** outside `docs/`. Time-bound writeups (FIX_COMPLETE, INVESTIGATION, STATUS, SUMMARY, …) go in commit messages.
3. **No new ad-hoc scripts at root** (`*.sh`, `*.ts`, `*.js`, `*.mjs`, `*.py`). Source goes in `src/`; operational scripts in `scripts/`. Ad-hoc `test-*.{ts,sh}`, `demo-*.sh`, and `show-*.sh` at root are explicitly rejected.
4. **No new test files** outside `tests/` or co-located `src/<module>/__tests__/`.
5. **No new YAML / JSON / SQL / TOML / HTML at root**. Config goes alongside what it configures.
6. **No new image / video / archive files** anywhere outside `docs/assets/`.
7. **No new top-level directories** outside the allowed set.

## Gitleaks

`gitleaks protect --staged --redact --no-banner` runs after a successful placement check. The redact flag masks matched secrets in the output.

Install:

```bash
brew install gitleaks
go install github.com/gitleaks/gitleaks/v8@latest
```

If gitleaks is not on `PATH` the hook prints an install hint and lets the commit through.

## Bypass

```bash
git commit --no-verify
```

Use sparingly. The rules exist to keep `git blame` readable.

## Extending the rules

Edit `scripts/git-hooks/pre-commit`:

- `ROOT_ALLOWLIST` — exact-name files allowed at the metabob-mcp root.
- `ALLOWED_TOPLEVEL_DIRS` — directories allowed at root.
- `ARTEFACT_EXTENSIONS` — pipe-separated extensions treated as binary artefacts.

Add a comment explaining the change so future readers understand the carve-out.

## Related

- The super-repo (`metabob-devbob`) has a parallel hook at `scripts/git-hooks/pre-commit`.
- The deployment repo and other vessels (`minibob`, `metabob-analysis-api`) carry the same two-layer pattern with their own allowlists.
