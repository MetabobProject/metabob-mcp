# Docs ↔ code links

`scripts/doclinks.mjs` maintains **`docs/links.json`**, a committed database of how the docs and the
code cite each other. It tells you — and any agent working here — which docs a change affects, and
which code a doc change affects. It runs under `node` and `bun`, with Node built-ins and git only.

The tree it sees is the git index: tracked files plus files staged for the next commit. A new doc,
citation or coverage rule joins it on `git add`; untracked files (local scratch notes, audits) never
enter `derived`, so a `build` in a working checkout matches a clean clone. Ignored files (`dist/`) are outside it.

## The database

| key | who edits it | what it holds |
|---|---|---|
| `curated.docs` | you | the registry of doc names → paths. Code cites docs by name (`SPEC §get_problems`); this is where a name resolves. A renamed or moved doc changes here, once. |
| `curated.live` | you | which docs describe the tree *now* and are held to the checks. Records (evaluations, scopes, proposals) are not live. |
| `curated.covers` | you | doc → the code it describes (globs). Changing covered code names the doc for review. Keep these narrow: a doc that covers everything is a reminder nobody reads. |
| `curated.retired` | you | files deleted on purpose (globs allowed) that live docs may still name, each with why. |
| `curated.outsideTree` | you | path globs a doc may name that are not in this tree on purpose — build output, the `vendor/cpg-inference` submodule's contents, sibling substrate repositories — each with why. |
| `curated.notDocs` / `curated.notCode` | you | strings that look like doc names (`NAME §…`) or file names (`Node.js`) and are not. |
| `curated.reviewed` | `reviewed` | doc → the commit it was last checked against with no change needed, and why. Clears the "older than the code it covers" warning until the code moves again. |
| `derived` | `build` only | every code→doc citation with its sections, every doc→code citation, and a fingerprint of each anchored line. |

## Citing, so the database can follow

- **Sections are heading slugs.** Every `##`–`####` heading opens a section whose id is its text with
  parenthesised asides and backticks dropped, lowercased, and every run of characters other than
  `a-z 0-9 _` turned into `-` (`scripts/doclinks.mjs@slug`): `## Impulse shapes (HTTP resolver)` is
  `impulse-shapes`, `### get_problems` is `get_problems`. A citation of a parent section covers its
  subsections.
- **In code, naming a doc:** the registered name, `§`, the section id — `SPEC §get_problems`,
  `CLAUDE §environment-variables`. `check` fails when the section does not exist, so renaming a heading
  means updating the code that cites it.
- **In a doc, naming code:** `` `<file>.ts@<name>` `` — `name` is a `// @anchor name` comment placed on the
  line above the code, or a uniquely named declaration (function, class, interface, type, enum,
  `const`/`let`/`var`, method). Never `` `<file>.ts:120` ``: the first line added above it makes it wrong,
  silently. Give the path when two files share a basename (`src/index.ts`, `src/tools/index.ts`).
- **In a doc that records the past:** `` `<file>.ts:120@<sha>` `` — line 120 *as it was at that commit*.
  It never drifts, and `check` verifies the commit and line exist.
- A file whose first lines contain `doclinks: ignore-citations` is not scanned for doc citations (the
  scanner itself, and the test that holds its fixtures).

## Commands (repo root)

```
node scripts/doclinks.mjs build             # refresh derived — run after changing citations or anchors
node scripts/doclinks.mjs check [--memory]  # errors exit 1; --memory also checks the agent memory dir
node scripts/doclinks.mjs impacted [files]  # what to review; default = your uncommitted changes
node scripts/doclinks.mjs reviewed <docs> --why "..."   # checked at HEAD, no change needed — clears drift
```

## Where it runs

| trigger | what happens |
|---|---|
| **the gate** (`tests/unit/doclinks.test.ts` under `bun test`, plus a `doclinks check` step in CI) | **fails** on broken citations: a missing file, an unresolved or ambiguous anchor, a bad pin, a bare line citation in a live doc, a broken relative link, an unregistered doc name, a cited section that does not exist, a `covers` glob or registry entry matching nothing. **Warns** on drift: anchored code changed, `derived` stale, a doc older than the code it covers |
| **Claude Code** (`.claude/settings.json`) | after an Edit/Write, the agent is told which docs are linked *to what it touched*, with the sections the file cites; at the end of a turn it is stopped once and shown the linked live docs it changed code under without reviewing, and any check errors |
| **git** (`scripts/git-hooks/pre-commit`) | lists linked docs missing from the commit, and check errors — warns, never blocks |

For code edits, impact reports include short doc sentences that name the enclosing symbol at the changed
lines. The hook uses the replacement text; `impacted` and the commit hook use the diff's changed lines.
The symbol map is a small brace-based scan (`scripts/doclinks.mjs@symbolRegions`) that understands
TypeScript modifiers and return types; it is not a parser and can miss unusual or computed declarations.
