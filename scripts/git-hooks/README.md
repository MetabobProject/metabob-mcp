# metabob-mcp git hooks

Versioned git hooks for the metabob-mcp vessel repo. Installed by running:

```bash
scripts/git-hooks/install.sh
```

This sets `core.hooksPath` to `scripts/git-hooks/` so updates to the hooks land via `git pull`. Same pattern as the `metabob-devbob` super-repo and the `deployment` repo.

## Philosophy

metabob-mcp is an MCP server distributed via npm (`@metabob/mcp`). The repo is organised around:

- `src/` — server source (`cli.ts`, `index.ts`, tool handlers)
- `tests/` — test suites
- `docs/` — stateless reference docs (`DEPLOYMENT.md`, `PUBLISHING.md`, `QUICK_START.md`)
- `scripts/` — operational tooling (incl. `scripts/git-hooks/` and `scripts/doclinks.mjs`)
- `lab/` — the two-node substrate lab (`lab/lab.sh`) used for live testing

A small allowlist of project-metadata files lives at root (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `README.md`, `LICENSE`, `package.json`, `bun.lock`, `tsconfig.json`, `Dockerfile`, `.gitignore`, `.dockerignore`, `.npmignore`, `.env.example`, etc.), plus the generated Agent Plugins bundle's `plugin.json` and `mcp.json`, whose place the Agent Plugins spec fixes. Anything else accumulates as cruft.

The pre-commit hook rejects new cruft at commit time. Existing files are grandfathered — the hook only checks newly-added or renamed-into entries.

## Where things go

| You have | Put it in |
|---|---|
| Stateless reference doc | `docs/<topic>.md` |
| One-off operational script | `scripts/<verb>-<noun>.sh` |
| Test (unit / integration) | `tests/<...>` |
| Screenshots / playwright output | gitignored — these are session artefacts |
| Status snapshot, fix-complete, investigation note | nowhere — write a commit message instead |

## Branch policy (pre-push hook)

metabob-mcp runs a **two-branch model**:

- **`dev`** — the default/integration branch. All development lands here, via PRs. This is the branch you clone, branch off, and open PRs against.
- **`main`** — the release branch. Plugin marketplaces clone it, and its bundles launch the exact npm version they pin, so `main` moves only after npm has that version: the release workflow (`.github/workflows/release.yml`) publishes a tagged release commit, then fast-forwards `main` to it (`docs/PUBLISHING.md` § Workflow).

The `pre-push` hook enforces the order:

1. a push that adds commits to `main` is refused (pushing a commit `main` already contains is allowed);
2. a push of a `v<version>` tag is allowed only when `<version>` is the tagged commit's `package.json` version and the commit is already on `origin/dev`.

Pushes to `dev` and feature branches are unaffected.

```bash
# Emergency override (use sparingly):
METABOB_ALLOW_MAIN_PUSH=1 git push origin main
```

## What the pre-commit hook does

The hook runs three layers, in order:

1. **Doc links** (`node scripts/doclinks.mjs precommit`) — runs on every commit and lists the live docs linked to what is staged but not in the commit, plus any broken docs ↔ code citations (see `docs/DOCLINKS.md`). **Warns only, never blocks**; it is skipped when `node` is not on `PATH`. The check that fails on broken citations is `tests/unit/doclinks.test.ts`, run by `bun test` and CI.
2. **Placement check** — rejects newly-added or renamed-into entries that violate the placement rules. Pre-existing files are grandfathered. A commit that adds or renames no file passes this step and continues to the secrets scan.
3. **Secrets scan** (`gitleaks protect --staged`) — scans the staged diff of every commit, modify-only commits included, for credentials. If gitleaks isn't installed, the scan is skipped with a one-line install hint.

Bypass with `git commit --no-verify` (use sparingly).

## What the pre-commit hook blocks

A commit is rejected when it adds (or renames into) a file that violates any of these rules:

1. **Files at the metabob-mcp root** are limited to a small allowlist of project metadata.
2. **No new top-level markdown** outside `docs/`. Time-bound writeups (FIX_COMPLETE, INVESTIGATION, STATUS, SUMMARY, …) go in commit messages.
3. **No new ad-hoc scripts at root** (`*.sh`, `*.ts`, `*.tsx`, `*.js`, `*.mjs`, `*.cjs`, `*.py`). Source goes in `src/`; operational scripts in `scripts/`. Ad-hoc `test-*.{ts,sh}`, `demo-*.sh`, and `show-*.sh` at root are explicitly rejected.
4. **No new test files** outside `tests/` or co-located `src/<module>/__tests__/`.
5. **No new YAML / JSON / SQL / SurrealQL / TOML / HTML / TXT / JSONL at root**. Config goes alongside what it configures.
6. **No new image / video / archive files** anywhere outside `docs/assets/`.
7. **New files must sit under an allowed top-level directory**: `src/`, `plugin/` (the generated Claude Code plugin), `skills/` (the agent skills the package and plugins ship), `test/`, `tests/`, `scripts/`, `docs/`, `lab/` (the two-node substrate lab), `packages/`, `.github/`, `.continue/` (the Continue rule that points at `AGENTS.md`), `.minibob/`, `.claude/` (the shared Claude Code `settings.json`; machine-local files under it are gitignored), `.agents/` (the generated Codex marketplace, at the path Codex reads). This is a path check, not a directory-creation check — adding a file under an existing-but-unlisted directory (`vendor/`, `include/`) is rejected too. Extend `ALLOWED_TOPLEVEL_DIRS` rather than bypassing.

## Gitleaks

`gitleaks protect --staged --redact --no-banner` runs on every commit after the placement check passes, whether or not the commit adds files. The redact flag masks matched secrets in the output.

Install:

```bash
brew install gitleaks
go install github.com/gitleaks/gitleaks/v8@latest
```

If gitleaks is not on `PATH` the hook prints an install hint and lets the commit through.

## Extending the rules

Edit `scripts/git-hooks/pre-commit`:

- `ROOT_ALLOWLIST` — exact-name files allowed at the metabob-mcp root.
- `ALLOWED_TOPLEVEL_DIRS` — directories allowed at root.
- `ARTEFACT_EXTENSIONS` — pipe-separated extensions treated as binary artefacts.

Add a comment explaining the change so future readers understand the carve-out.


