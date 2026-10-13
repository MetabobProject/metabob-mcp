#!/usr/bin/env node
// doclinks: ignore-citations — this file's examples and regexes are not citations.
// =================================================================================================
// DOCLINKS — the link database between the docs and the code, and the checks that keep it honest.
// Runs under node and bun; Node built-ins and git only.
//
// THE DATABASE is `docs/links.json`, committed. Two halves:
//   curated — edited by hand: the doc-name registry ("SPEC" -> docs/SPEC.md), which docs are LIVE,
//             which code each doc COVERS (so changing the code names the doc to review), files that
//             are RETIRED (deleted on purpose, so a live doc may still name them), and paths that sit
//             OUTSIDE the tree on purpose (build output, sibling repositories).
//   derived — rebuilt by `build` from the tree, never edited: every citation in both directions,
//             and a fingerprint of the line under every anchor a doc points at.
//
// THE CITATION FORMS it understands (and CLAUDE.md asks everyone to write):
//   in a doc, naming code:   `src/x.ts`                 the file
//                            `src/x.ts@name`            a `// @anchor name` marker, or a declaration
//                            `src/x.ts:120@abc1234`     line 120 AS IT WAS at commit abc1234 — a
//                                                       record, frozen, for docs that describe the past
//   in code, naming a doc:   SPEC §get_problems, CLAUDE §environment-variables
//                            (the registered name, then § and the heading's slug — see `slug`)
// A bare `src/x.ts:120` in a LIVE doc is an error: it rots the first time a line is added above it.
//
// COMMANDS (from the repo root):
//   node scripts/doclinks.mjs build              rewrite `derived`
//   node scripts/doclinks.mjs check [--memory]   errors exit 1; warnings print. --memory also checks
//                                                the agent memory directory for dangling paths
//   node scripts/doclinks.mjs reviewed <docs> --why "…"   record: checked at HEAD, no change needed
//   node scripts/doclinks.mjs impacted [files]   what to review for these changes (default: the
//                                                working tree against HEAD)
//   node scripts/doclinks.mjs hook-post          Claude Code PostToolUse hook (JSON on stdin)
//   node scripts/doclinks.mjs hook-stop          Claude Code Stop hook (JSON on stdin)
//   node scripts/doclinks.mjs precommit          git pre-commit hook (warns, never blocks)
// =================================================================================================
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = 'docs/links.json';
const CMD = 'node scripts/doclinks.mjs';
// @anchor code-extensions
const CODE_EXTS = ['tsx', 'ts', 'mts', 'cts', 'mjs', 'cjs', 'js', 'sh', 'py'];
const CODE_EXT = new RegExp(`\\.(?:${CODE_EXTS.join('|')})$`);
// A code file carrying this pragma is not scanned for doc citations (fixtures, the scanner itself).
const IGNORE_PRAGMA = /doclinks:\s*ignore-citations/;
const posixBase = p => posix.basename(p);

// ---------------------------------------------------------------------------------------------------
// THE REPO VIEW. Everything below takes one of these, so a test can hand in a fixture instead of git.
// ---------------------------------------------------------------------------------------------------
export function gitRepo(root = ROOT) {
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  // The index: tracked files plus files staged for the next commit. Untracked files stay outside the
  // view — a local scratch doc never enters `derived` — so a new doc or code file joins it on `git add`.
  // Deleted tracked paths are absent from the current tree.
  const files = [...new Set(git('ls-files', '--cached', '-z')
    .split('\0').filter(Boolean))].filter(f => existsSync(join(root, f)));
  const cache = new Map(), times = new Map();
  return {
    root, files,
    read(f) { if (!cache.has(f)) { try { cache.set(f, readFileSync(join(root, f), 'utf8')); } catch { cache.set(f, null); } } return cache.get(f); },
    // A pinned citation is checked against the commit it names, never against today's file.
    linesAt(sha, f) {
      try { return git('show', `${sha}:${f}`).split('\n').length; } catch { return null; }
    },
    commitTime(sha) { try { return Number(git('show', '-s', '--format=%ct', sha).trim()) || 0; } catch { return 0; } },
    head() { return git('rev-parse', '--short=7', 'HEAD').trim(); },
    lastCommitTime(f) {
      if (!times.has(f)) { try { times.set(f, Number(git('log', '-1', '--format=%ct', '--', f).trim()) || 0); } catch { times.set(f, 0); } }
      return times.get(f);
    },
    changed() {
      const out = git('status', '--porcelain', '-z', '--untracked-files=all').split('\0').filter(Boolean);
      const paths = [];
      for (let i = 0; i < out.length; i++) {
        const e = out[i]; const code = e.slice(0, 2);
        if (code[0] === 'R' || code[0] === 'C') i++;            // the rename's source rides the next entry
        if (code === '??') continue;                            // untracked: outside the view
        paths.push(e.slice(3));
      }
      return paths;
    },
    staged() { return git('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean); },
    // The lines of `f` that changed, in the NEW file's numbering — so a doc edit can be mapped to the
    // sections it touched. `cached` = the index against HEAD (a commit); else the working tree against HEAD.
    changedLines(f, { cached = false } = {}) {
      let out = ''; try { out = git('diff', '-U0', ...(cached ? ['--cached'] : ['HEAD']), '--', f); } catch { return null; }
      if (!out) return null;                                 // untracked or unchanged: no hunks to read
      const lines = [];
      for (const m of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = +m[1], n = m[2] == null ? 1 : +m[2];
        for (let i = 0; i < Math.max(n, 1); i++) lines.push(start + i);
      }
      return lines;
    },
  };
}

export function loadDb(repo) {
  const raw = repo.read(DB_PATH);
  if (!raw) throw new Error(`${DB_PATH} is missing — it is the curated half of the link database and cannot be regenerated.`);
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------------------------------
// SMALL PIECES
// ---------------------------------------------------------------------------------------------------
const globToRe = g => new RegExp('^' + g.split('**').map(s => s.split('*').map(t => t.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^/]*')).join('.*') + '$');
export const matches = (glob, f) => globToRe(glob).test(f);
const fingerprint = s => createHash('sha256').update(String(s).trim()).digest('hex').slice(0, 12);
const isLive = (db, f) => (db.curated.live || []).some(p => p.endsWith('/') ? f.startsWith(p) : f === p);
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toPosix = p => p.split(sep).join('/');
function nextCodeIndex(text, from) {
  let i = from;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith('//', i)) { const n = text.indexOf('\n', i + 2); i = n < 0 ? text.length : n + 1; continue; }
    if (text.startsWith('/*', i)) { const n = text.indexOf('*/', i + 2); i = n < 0 ? text.length : n + 2; continue; }
    return i;
  }
}
/** Past a TypeScript return-type annotation (`): Promise<{ a: T }> {`) to the token that follows it:
 *  the `{` of a body or the `=>` of an arrow. `at` is the first code index after the closing `)`. */
function skipReturnType(text, at) {
  if (text[at] !== ':') return at;
  let depth = 0;
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '=' && text[i + 1] === '>') { if (depth === 0) return i; i++; continue; }
    if (c === '<' || c === '(' || c === '[') depth++;
    else if (c === '>' || c === ')' || c === ']') depth--;
    else if (c === '{') {
      // At depth 0 a brace after a complete type (`Foo {`, `T> {`, `) {`, `} {`) opens the body; a
      // brace right after `:` `|` `&` `,` opens an object type.
      if (depth === 0 && /[\w$)>\]}]\s*$/.test(text.slice(at + 1, i))) return i;
      depth++;
    }
    else if (c === '}') depth--;
    else if (c === ';' && depth === 0) return -1;            // an overload or abstract signature
  }
  return -1;
}

/** The single slug rule for section ids, used for headings AND for citations in code: drop
 *  parenthesised asides and backticks, lowercase, runs of anything but [a-z0-9_] become '-', trim '-'.
 *  "## Impulse shapes (HTTP resolver)" -> impulse-shapes; "### get_problems" -> get_problems. */
// @anchor slug
export const slug = s => String(s).replace(/\([^)]*\)/g, ' ').replace(/`/g, '').toLowerCase()
  .replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '');

// TS/JS declaration keywords that may precede a name.
const MODS = '(?:(?:export|default|declare|public|private|protected|static|readonly|override|abstract|async|get|set)\\s+)*';

/** Resolve `name` in a code file: a `@anchor name` marker (the line after it is the anchored line),
 *  else exactly one declaration — function, class, interface, type, enum, const/let/var (with or
 *  without a type annotation), or a method at the start of a line. */
// @anchor resolveAnchor
export function resolveAnchor(text, name) {
  const L = text.split('\n');
  const esc = escRe(name);
  const marks = L.flatMap((l, i) => new RegExp(`(?://|#)\\s*@anchor\\s+${esc}\\s*$`).test(l) ? [i] : []);
  if (marks.length === 1) {
    let j = marks[0] + 1; while (j < L.length && !L[j].trim()) j++;
    return { ok: true, kind: 'marker', line: j + 1, text: L[j] ?? '' };
  }
  if (marks.length > 1) return { ok: false, why: `the marker @anchor ${name} appears ${marks.length} times` };
  const decl = new RegExp(`^\\s*${MODS}(?:function\\*?\\s+${esc}\\b|class\\s+${esc}\\b|(?:interface|type|enum)\\s+${esc}\\b|(?:const|let|var)\\s+${esc}\\s*(?::[^=]*)?=(?!=)|\\*?${esc}\\s*(?:<[^>]*>)?\\s*\\((?:[^()]*\\)\\s*(?::[^;]*)?\\{?\\s*|[^)]*)$)`);
  // (a method: its parameter list either closes on the line, followed only by a return type and/or
  //  `{`, or runs onto the next line — so a call such as `main().catch(…)` is not a declaration)
  const reserved = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function']);
  const hits = reserved.has(name) ? [] : L.flatMap((l, i) => decl.test(l) ? [i] : []);
  if (hits.length === 1) return { ok: true, kind: 'declaration', line: hits[0] + 1, text: L[hits[0]] };
  return { ok: false, why: hits.length ? `${hits.length} declarations are named ${name}; add a // @anchor marker` : `no // @anchor ${name} and no declaration of that name` };
}

// ---------------------------------------------------------------------------------------------------
// SCANNERS
// ---------------------------------------------------------------------------------------------------
const DOC_CODE_RE = new RegExp(`(?<![\\w/.*-])((?:\\.\\.?\\/)*(?:[\\w-]+\\/)*[\\w.-]+\\.(?:${CODE_EXTS.join('|')}))(?![\\w-])(?:@([A-Za-z_$][\\w$-]*)|:(\\d+(?:[-,]\\d+)*)(?:@([0-9a-f]{7,40}))?)?`, 'g');
/** Citations in a doc that name code. */
export function scanDocForCode(text) {
  const out = [];
  for (const m of text.matchAll(DOC_CODE_RE)) {
    const [, path, anchor, lines, sha] = m;
    out.push({ path, anchor: anchor || null, line: lines ? parseInt(lines, 10) : null, lineText: lines || null, sha: sha || null, at: lineOf(text, m.index) });
  }
  return out;
}

/** Markdown links in a doc (relative ones only). */
export function scanDocLinks(text) {
  return [...text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)].map(m => ({ target: m[1], at: lineOf(text, m.index) }))
    .filter(l => !/^[a-z]+:/i.test(l.target));
}

/** Citations in code that name a doc, with the section slug when the citation gives one. */
// @anchor scanCodeForDocs
export function scanCodeForDocs(text, names, notDocs = new Set()) {
  const hits = [];
  if (IGNORE_PRAGMA.test(text.slice(0, 400))) return { hits, unknown: [] };
  const alt = [...names].sort((a, b) => b.length - a.length).map(escRe).join('|');
  if (alt) {
    const re = new RegExp(`(?<![\\w/.-])(${alt})(?:\\.md)?(?![\\w-])(?:\\s*§\\s*([A-Za-z0-9][\\w-]*))?`, 'g');
    for (const m of text.matchAll(re)) hits.push({ name: m[1], section: m[2] ? slug(m[2]) || null : null, at: lineOf(text, m.index) });
  }
  // A capitalised name followed by § LOOKS like a doc citation; unregistered, it is a dangling one.
  const unknown = [...new Set([...text.matchAll(/(?<![\w/.-])([A-Z][A-Z0-9_-]{2,})(?:\.md)?\s*§/g)].map(m => m[1]))]
    .filter(n => !names.has(n) && !notDocs.has(n));
  return { hits, unknown };
}

/** The sections of a doc, as [startLine, slug, level] in order. Every heading of level 2–4 opens one;
 *  fenced code blocks are skipped. */
// @anchor sectionsOf
export function sectionsOf(text) {
  const out = []; let fence = false;
  text.split('\n').forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    if (fence) return;
    const m = /^(#{2,4})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) { const s = slug(m[2]); if (s) out.push([i + 1, s, m[1].length]); }
  });
  return out;
}
/** The innermost section containing `line`. */
export const sectionAt = (text, line) => sectionPathAt(text, line)[0] || null;
/** The innermost section containing `line`, then each enclosing one — a citation of a parent section
 *  (`SPEC §tools`) covers edits in its subsections. */
export function sectionPathAt(text, line) {
  const stack = [];
  for (const [at, s, level] of sectionsOf(text)) {
    if (at > line) break;
    while (stack.length && stack[stack.length - 1][1] >= level) stack.pop();
    stack.push([s, level]);
  }
  return stack.map(([s]) => s).reverse();
}

/** A deliberately small symbol map for impact reports. It recognizes declarations whose bodies are
 *  brace-delimited (functions, classes, interfaces, methods, const/let/var initializers), including
 *  TypeScript return types and modifiers. It is not a parser: comments and quoted strings are skipped
 *  while pairing braces, and the nearest/smallest recognized declaration containing an edited line
 *  supplies the symbol. Generic angle brackets are not paired; they rarely hold a brace. */
// @anchor symbolRegions
export function symbolRegions(text) {
  const pairs = new Map(), parens = new Map(), stack = [];
  let quote = null, lineComment = false, blockComment = false, escaped = false;
  const regexCanStart = at => {
    let p = at - 1; while (p >= 0 && /\s/.test(text[p])) p--;
    if (text.slice(Math.max(0, at - 2), at) === '=>') return true;
    if (p < 0 || '=(:,[!&|?{};'.includes(text[p])) return true;
    const word = text.slice(0, p + 1).match(/([\w$]+)$/)?.[1];
    return ['return', 'case', 'throw', 'typeof', 'void', 'delete', 'await', 'yield', 'in', 'of'].includes(word);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === '/' && regexCanStart(i)) {
      let inClass = false, slashEscaped = false;
      for (i++; i < text.length; i++) {
        const r = text[i];
        if (slashEscaped) { slashEscaped = false; continue; }
        if (r === '\\') { slashEscaped = true; continue; }
        if (r === '\n') break;                                 // not a regex after all
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
      }
      while (i + 1 < text.length && /[a-z]/i.test(text[i + 1])) i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('({['.includes(c)) stack.push([c, i]);
    else if (')}]'.includes(c) && stack.length) {
      const [open, at] = stack[stack.length - 1];
      if ((open === '(' && c === ')') || (open === '{' && c === '}') || (open === '[' && c === ']')) {
        stack.pop();
        if (open === '{') pairs.set(at, i);
        if (open === '(') parens.set(at, i);
      }
    }
  }
  const ranges = [];
  const decl = new RegExp(`^\\s*${MODS}(?:function\\*?\\s+([\\w$]+)\\b|(?:class|interface|enum)\\s+([\\w$]+)\\b|(?:const|let|var)\\s+([\\w$]+)\\s*(?::[^=]*)?=(?!=)|\\*?([\\w$]+)\\s*(?:<[^>(]*>)?\\s*\\()`);
  const reserved = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function']);
  // From an open paren: past its close and any return type, to the body brace (or -1).
  const bodyAfterParams = open => {
    const close = parens.get(open); if (close == null) return -1;
    let at = skipReturnType(text, nextCodeIndex(text, close + 1));
    if (at >= 0 && text.startsWith('=>', at)) at = nextCodeIndex(text, at + 2);
    return at >= 0 && text[at] === '{' ? at : -1;
  };
  const lines = text.split('\n'); let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = decl.exec(lines[i]);
    if (m) {
      const name = m[1] || m[2] || m[3] || m[4];
      const from = offset;
      const lineEnd = from + lines[i].length;
      let brace = -1;
      if (m[2]) { const b = text.indexOf('{', from); brace = b; }       // class / interface / enum body
      else if (m[1] || m[4]) brace = bodyAfterParams(text.indexOf('(', from + m[0].length - 1));
      else {
        const eq = from + m[0].length;                                 // just past the `=`
        const p = nextCodeIndex(text, eq);
        const init = text.slice(eq, lineEnd);
        if (text[p] === '{' && p <= lineEnd + 1) brace = p;            // object initializer
        else if (/^\s*(?:async\s*)?(?:<[^>]*>\s*)?\(/.test(init)) {    // arrow function, params may span lines
          brace = bodyAfterParams(text.indexOf('(', eq));
        } else if (/^\s*(?:async\s*)?[\w$]+\s*=>/.test(init)) {       // x => { … }
          const body = nextCodeIndex(text, text.indexOf('=>', eq) + 2);
          if (text[body] === '{') brace = body;
        } else if (/^\s*(?:async\s+)?function\b/.test(init)) {
          brace = bodyAfterParams(text.indexOf('(', eq));
        }
      }
      const endAt = brace >= 0 ? pairs.get(brace) : null;
      if (endAt != null && !reserved.has(name)) ranges.push({ name, start: i + 1, end: lineOf(text, endAt) });
    }
    offset += lines[i].length + 1;
  }
  return ranges;
}

function symbolsAt(text, lines) {
  const regions = symbolRegions(text), found = new Set();
  for (const line of lines) {
    const containing = regions.filter(r => r.start <= line && line <= r.end).sort((a, b) => (a.end - a.start) - (b.end - b.start));
    if (containing[0]) found.add(containing[0].name);
  }
  return found;
}

function symbolAtAnchor(text, name) {
  const anchor = resolveAnchor(text, name);
  return anchor.ok ? symbolsAt(text, [anchor.line]).values().next().value || null : null;
}

function editedLines(text, snippets) {
  const out = new Set();
  for (const snippet of snippets.filter(s => typeof s === 'string' && s.trim())) {
    let from = 0, at;
    while ((at = text.indexOf(snippet, from)) >= 0) {
      const first = lineOf(text, at), count = snippet.split('\n').length;
      for (let i = 0; i < count; i++) out.add(first + i);
      from = at + Math.max(snippet.length, 1);
    }
  }
  return [...out];
}

/** Sentences of `text` naming one of `symbols` (the symbols edited in `file`). When the doc names
 *  `file` by path, only the sections that name it are searched — a symbol name such as `handle` is
 *  shared by every tool module — and a citation of ANOTHER file's anchor is not a mention. */
function sentencesMentioning(text, symbols, file = null) {
  const out = [];
  const scope = new Set();
  if (file) for (let i = text.indexOf(file); i >= 0; i = text.indexOf(file, i + 1)) { const s = sectionAt(text, lineOf(text, i)); if (s) scope.add(s); }
  const foreign = s => s.replace(DOC_CODE_RE, (m, path) => (file && path !== file && !file.endsWith('/' + path) ? '' : m));
  // Join wrapped prose within paragraphs, while keeping table cells separate. This returns the
  // smallest useful excerpt without treating an entire paragraph as impact evidence.
  let at = 0;
  for (const block of text.split(/(\n\s*\n)/)) {
    const start = at; at += block.length;
    if (!block.trim() || block.includes('```')) continue;
    if (scope.size && !scope.has(sectionAt(text, lineOf(text, start)))) continue;
    for (const cell of block.split('|')) {
      for (const part of cell.replace(/\n/g, ' ').split(/(?<=[.!?])\s+/)) {
        const sentence = part.trim().replace(/^[-*+\s]+/, '').replace(/\s+/g, ' ');
        if (sentence && [...symbols].some(s => identifierOccurs(foreign(sentence), s))) out.push(sentence);
      }
    }
  }
  return [...new Set(out)];
}

const commonWordSymbols = new Set(['add', 'anchor', 'build', 'check', 'class', 'code', 'create', 'doc', 'edit', 'file', 'first', 'from', 'function', 'get', 'handle', 'link', 'lines', 'name', 'new', 'open', 'path', 'read', 'return', 'run', 'section', 'text', 'to', 'update', 'write']);
const identifierOccurs = (text, name) => {
  const escaped = escRe(name);
  // Common English words make weak prose matches unless the doc marks them as code or calls them.
  if (commonWordSymbols.has(name)) return new RegExp('(?:`' + escaped + '`|@' + escaped + '\\b|' + escaped + '\\s*\\()').test(text);
  return new RegExp(`(^|[^\\w$])${escaped}(?![\\w$])`).test(text);
};

// ---------------------------------------------------------------------------------------------------
// PATHS — a doc names code by repo-relative path, doc-relative path, or (when unique) bare basename.
// ---------------------------------------------------------------------------------------------------
function pathResolver(files) {
  const fileSet = new Set(files), byBase = new Map();
  for (const f of files) { const b = posixBase(f); byBase.set(b, [...(byBase.get(b) || []), f]); }
  /** -> { path } when the citation names exactly one file, { ambiguous: [...] } or { missing: true }. */
  return (from, p) => {
    if (p.includes('/')) {
      const rel = posix.normalize(posix.join(posix.dirname(from), p));
      if (fileSet.has(rel)) return { path: rel };
      const clean = posix.normalize(p).replace(/^(\.\.\/)+/, '');
      if (fileSet.has(clean)) return { path: clean };
      return { missing: true };
    }
    const c = byBase.get(p) || [];
    return c.length === 1 ? { path: c[0] } : c.length ? { ambiguous: c } : { missing: true };
  };
}
// Paths outside the tree on purpose (build output, submodule contents, sibling repositories), and
// words that only look like file names (`Node.js`): neither is a citation of the tree.
const isOutsideTree = (db, p) => (db.curated.notCode || []).includes(p) || Object.keys(db.curated.outsideTree || {}).some(g => matches(g, p) || matches(g, posix.normalize(p).replace(/^(\.\.\/)+/, '')));
const codeFilesOf = repo => repo.files.filter(f => CODE_EXT.test(f));

// ---------------------------------------------------------------------------------------------------
// BUILD — the derived half
// ---------------------------------------------------------------------------------------------------
// @anchor build
export function build(repo, db) {
  const names = new Set(Object.keys(db.curated.docs));
  const docFiles = repo.files.filter(f => f.endsWith('.md'));
  const resolvePath = pathResolver(repo.files);

  const cites = {};      // code file -> { docName: [sections] }
  for (const f of codeFilesOf(repo)) {
    const { hits } = scanCodeForDocs(repo.read(f) || '', names);
    if (!hits.length) continue;
    const m = {};
    for (const h of hits) { m[h.name] = m[h.name] || new Set(); if (h.section) m[h.name].add(h.section); }
    cites[f] = Object.fromEntries(Object.entries(m).sort().map(([k, v]) => [k, [...v].sort()]));
  }
  const refs = {};       // doc -> [ "path", "path@anchor", "path:N@sha" ]
  const anchors = {};    // "path@anchor" -> fingerprint of the anchored line
  for (const d of docFiles) {
    const set = new Set();
    for (const c of scanDocForCode(repo.read(d) || '')) {
      if (isOutsideTree(db, c.path)) continue;
      const p = resolvePath(d, c.path).path || c.path;
      if (c.anchor) {
        const key = `${p}@${c.anchor}`; set.add(key);
        const t = repo.read(p);
        if (t != null) { const r = resolveAnchor(t, c.anchor); if (r.ok) anchors[key] = fingerprint(r.text); }
      } else if (c.sha) set.add(`${p}:${c.lineText}@${c.sha}`);
      else set.add(p);
    }
    for (const l of scanDocLinks(repo.read(d) || '')) {
      const t = posix.normalize(posix.join(posix.dirname(d), l.target));
      if (repo.files.includes(t) && t.endsWith('.md')) set.add(t);
    }
    if (set.size) refs[d] = [...set].sort();
  }
  return {
    note: `REBUILT by \`${CMD} build\` — do not edit by hand.`,
    codeCitesDocs: Object.fromEntries(Object.entries(cites).sort()),
    docCitesCode: Object.fromEntries(Object.entries(refs).sort()),
    anchors: Object.fromEntries(Object.entries(anchors).sort()),
  };
}

// ---------------------------------------------------------------------------------------------------
// CHECK — errors break the gate, warnings are printed
// ---------------------------------------------------------------------------------------------------
// @anchor check
export function check(repo, db, { memoryDir = null } = {}) {
  const errors = [], warnings = [];
  const E = (where, msg) => errors.push(`${where}: ${msg}`);
  const W = (where, msg) => warnings.push(`${where}: ${msg}`);
  const names = new Set(Object.keys(db.curated.docs));
  const retired = db.curated.retired || {};
  const isRetired = p => Object.keys(retired).some(r => r === p || matches(r, p) || matches(r, p.replace(/^(\.\.\/)+/, '')) || (!r.includes('*') && !r.includes('/') && posixBase(r) === posixBase(p)));
  const fileSet = new Set(repo.files);
  const resolvePath = pathResolver(repo.files);

  for (const [n, p] of Object.entries(db.curated.docs)) if (!fileSet.has(p)) E(DB_PATH, `the registry maps "${n}" to ${p}, which does not exist`);
  for (const [doc, globs] of Object.entries(db.curated.covers || {})) {
    if (!fileSet.has(doc)) E(DB_PATH, `covers names a doc that does not exist: ${doc}`);
    for (const g of globs) if (!repo.files.some(f => matches(g, f))) E(DB_PATH, `${doc} covers "${g}", which matches no file`);
  }
  for (const r of Object.keys(retired)) if (!r.includes('*') && fileSet.has(r)) W(DB_PATH, `${r} is listed as retired but exists again`);

  const derived = db.derived || {};
  for (const d of repo.files.filter(f => f.endsWith('.md') && isLive(db, f))) {
    const text = repo.read(d) || '';
    for (const c of scanDocForCode(text)) {
      const where = `${d}:${c.at}`;
      if (isOutsideTree(db, c.path)) continue;
      const r = resolvePath(d, c.path);
      if (c.sha) {
        const full = r.path || r.ambiguous?.[0] || c.path;
        const n = repo.linesAt(c.sha, full);
        if (n == null) E(where, `\`${c.path}:${c.lineText}@${c.sha}\` — that file does not exist at ${c.sha}`);
        else if (c.line > n) E(where, `\`${c.path}:${c.lineText}@${c.sha}\` — the file had only ${n} lines at ${c.sha}`);
        continue;
      }
      if (r.missing) { if (!isRetired(c.path)) E(where, `cites ${c.path}, which does not exist (fix the citation, or add it to curated.retired with why)`); continue; }
      if (c.line != null) { E(where, `\`${c.path}:${c.lineText}\` is a bare line citation in a live doc — use \`${c.path}@<anchor>\`, or pin it to a commit as \`${c.path}:${c.lineText}@<sha>\` if it describes the past`); continue; }
      if (r.ambiguous) { if (c.anchor) E(where, `\`${c.path}@${c.anchor}\` is ambiguous — ${r.ambiguous.join(', ')} share that name; give the path`); continue; }
      if (c.anchor) {
        const a = resolveAnchor(repo.read(r.path) || '', c.anchor);
        if (!a.ok) { E(where, `\`${c.path}@${c.anchor}\` does not resolve: ${a.why}`); continue; }
        const key = `${r.path}@${c.anchor}`, was = derived.anchors?.[key];
        if (was && was !== fingerprint(a.text)) W(where, `the code under \`${c.path}@${c.anchor}\` changed since the last build — check the doc still says what the code does, then \`build\``);
      }
    }
    for (const l of scanDocLinks(text)) {
      const t = posix.normalize(posix.join(posix.dirname(d), l.target)).replace(/\/$/, '');
      if (!existsSync(join(repo.root, t)) && !fileSet.has(t)) E(`${d}:${l.at}`, `link to ${l.target} is broken`);
    }
  }
  const sectionsByName = new Map();
  const sectionsFor = n => {
    if (!sectionsByName.has(n)) sectionsByName.set(n, new Set(sectionsOf(repo.read(db.curated.docs[n]) || '').map(([, s]) => s)));
    return sectionsByName.get(n);
  };
  for (const f of codeFilesOf(repo)) {
    const text = repo.read(f) || '';
    const { hits, unknown } = scanCodeForDocs(text, names, new Set(db.curated.notDocs || []));
    for (const u of unknown) if (!isRetired(`${u}.md`)) E(f, `cites ${u}, which is not a registered doc (register it in curated.docs, or correct the name)`);
    // A heading-name section id breaks when the heading is renamed — so every cited section must exist.
    for (const h of hits) if (h.section && fileSet.has(db.curated.docs[h.name]) && !sectionsFor(h.name).has(h.section))
      E(`${f}:${h.at}`, `cites ${h.name} §${h.section}, which is not a section of ${db.curated.docs[h.name]} (sections are heading slugs)`);
  }
  for (const [n, p] of Object.entries(db.curated.docs)) {
    const seen = new Map();
    for (const [at, s] of sectionsOf(repo.read(p) || '')) { if (seen.has(s)) W(`${p}:${at}`, `section §${s} repeats the heading at line ${seen.get(s)} — a citation of ${n} §${s} is ambiguous`); else seen.set(s, at); }
  }
  // The derived half must be what the tree says it is.
  const fresh = build(repo, db);
  for (const k of ['codeCitesDocs', 'docCitesCode']) if (JSON.stringify(fresh[k]) !== JSON.stringify(derived[k])) { W(DB_PATH, `derived.${k} is stale — run \`${CMD} build\``); }
  const newAnchors = Object.keys(fresh.anchors).filter(k => !(k in (derived.anchors || {})));
  if (newAnchors.length) W(DB_PATH, `${newAnchors.length} anchor(s) not fingerprinted yet — run build`);

  // A doc older than the code it covers is the drift the whole database exists to surface.
  for (const [doc, globs] of Object.entries(db.curated.covers || {})) {
    // A doc is current as of its own last commit OR its last recorded review (`reviewed`), whichever is later:
    // "I checked it against the code and nothing needed to change" is an answer, and it is recorded, not assumed.
    const rv = db.curated.reviewed?.[doc];
    const td = Math.max(repo.lastCommitTime(doc), rv?.at && repo.commitTime ? repo.commitTime(rv.at) : 0); if (!td) continue;
    const newer = repo.files.filter(f => globs.some(g => matches(g, f)) && repo.lastCommitTime(f) > td);
    if (newer.length) W(doc, `older than ${newer.length} file(s) it covers (${newer.slice(0, 3).join(', ')}${newer.length > 3 ? ', …' : ''}) — review it`);
  }
  if (memoryDir) for (const w of checkMemory(repo, memoryDir)) W('memory', w);
  return { errors, warnings, stats: { liveDocs: repo.files.filter(f => f.endsWith('.md') && isLive(db, f)).length, codeFilesCiting: Object.keys(fresh.codeCitesDocs).length, docsCiting: Object.keys(fresh.docCitesCode).length, anchors: Object.keys(fresh.anchors).length } };
}

/** The agent memory directory lives outside the repo; its path-like mentions are checked against the tree. */
export function checkMemory(repo, dir) {
  const out = []; if (!existsSync(dir)) return [`no memory directory at ${dir}`];
  const baseSet = new Set(repo.files.map(f => posixBase(f)));
  for (const f of readdirSync(dir).filter(f => f.endsWith('.md'))) {
    const t = readFileSync(join(dir, f), 'utf8');
    for (const m of t.matchAll(new RegExp(`\`((?:[\\w.-]+\\/)*[\\w.-]+\\.(?:${CODE_EXTS.join('|')}|md|json))\``, 'g'))) {
      const p = m[1];
      if (p.startsWith('~') || p.includes('out/') || f === 'MEMORY.md') continue;
      if (!repo.files.includes(p) && !baseSet.has(posixBase(p))) out.push(`${f} mentions ${p}, which is not in the tree`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// IMPACT — what to review when these files change
// ---------------------------------------------------------------------------------------------------
// @anchor impacted
export function impacted(repo, db, changed, { editText = null, changedLines = null, editSnippets = [] } = {}) {
  const derived = db.derived || build(repo, db);
  const out = new Map();   // target -> Set(reasons)
  const impactSymbols = new Map();   // doc -> Map(source file -> Set(edited symbols))
  const add = (t, why, symbols = null, from = null) => {
    if (changed.includes(t)) return;
    if (!out.has(t)) out.set(t, new Set());
    out.get(t).add(why);
    if (symbols?.size && t.endsWith('.md')) {
      if (!impactSymbols.has(t)) impactSymbols.set(t, new Map());
      const byFile = impactSymbols.get(t);
      if (!byFile.has(from)) byFile.set(from, new Set());
      for (const s of symbols) byFile.get(from).add(s);
    }
  };
  const docPath = n => db.curated.docs[n];
  for (const f of changed) {
    if (f.endsWith('.md')) {
      const name = Object.entries(db.curated.docs).find(([, p]) => p === f)?.[0];
      for (const g of db.curated.covers?.[f] || []) for (const c of repo.files.filter(x => matches(g, x))) add(c, `covered by ${f}`);
      if (name) {
        // WHICH SECTIONS CHANGED. From the edit's own text (a hook) or from the diff's hunks (a commit,
        // a turn). With neither, nothing is listed: "every file that cites SPEC" is most of src/,
        // and a reminder that long is a reminder nobody reads.
        const t = repo.read(f) || '';
        const secs = new Set();
        const mark = ln => { for (const s of sectionPathAt(t, ln)) secs.add(s); };
        if (editText) { for (const ln of editText.split('\n').map(l => l.trim()).filter(l => l.length > 12)) { const i = t.indexOf(ln); if (i >= 0) mark(lineOf(t, i)); } }
        else if (changedLines) for (const ln of changedLines(f) || []) mark(ln);
        if (secs.size) for (const [code, m] of Object.entries(derived.codeCitesDocs)) {
          const h = (m[name] || []).filter(s => secs.has(s));
          if (h.length) add(code, `cites ${name} ${h.map(s => '§' + s).join(', ')}`);
        }
      }
      // (a doc that merely LINKS to this one is not asked to change with it — links are navigation, not claims)
      continue;
    }
    const sourceText = repo.read(f) || '';
    const hunks = changedLines ? changedLines(f) : null;
    const whole = !!changedLines && hunks == null;          // untracked or no diff: every line counts as touched
    const lines = changedLines ? hunks || [] : editedLines(sourceText, editSnippets.length ? editSnippets : (editText ? [editText] : []));
    const fileSymbols = symbolsAt(sourceText, lines);
    for (const [doc, globs] of Object.entries(db.curated.covers || {})) if (globs.some(g => matches(g, f))) add(doc, `covers ${f}`, fileSymbols, f);
    // The sections this file cites by name: its own statement of which doc text describes it.
    for (const [name, secs] of Object.entries(derived.codeCitesDocs[f] || {})) {
      if (docPath(name) && secs.length) add(docPath(name), `${f} cites ${name} ${secs.map(s => '§' + s).join(', ')}`, fileSymbols, f);
    }
    // A doc that points at an ANCHOR in this file is asked to review — but when we know what the edit
    // touched, only if it touched the anchored line. A doc that merely NAMES the file is not: records
    // name files constantly, and a reminder on every edit is a reminder nobody reads.
    const text = sourceText;
    for (const [doc, rs] of Object.entries(derived.docCitesCode)) {
      if (!isLive(db, doc)) continue;
      const hit = rs.filter(r => r.startsWith(f + '@')).filter(r => {
        if ((!editText && !changedLines) || whole) return true;
        const anchorName = r.slice(f.length + 1);
        const a = resolveAnchor(text, anchorName);
        const owningSymbol = symbolAtAnchor(text, anchorName);
        if (!a.ok) return true;
        if (editText && ((a.text.trim() && editText.includes(a.text.trim().slice(0, 60))) || editText.includes(`@anchor ${anchorName}`))) return true;
        if (!editText && lines.includes(a.line)) return true;
        return !!(owningSymbol && fileSymbols.has(owningSymbol));
      });
      if (hit.length) {
        // Name the doc section each anchor is cited from, so the reminder points at the paragraph.
        const docText = repo.read(doc) || '';
        const where = hit.map(h => {
          const anchor = h.slice(h.indexOf('@'));
          const i = docText.indexOf(`${f}${anchor}`);
          const s = i >= 0 ? sectionAt(docText, lineOf(docText, i)) : null;
          return s ? `§${s} cites ${anchor}` : `cites ${anchor}`;
        });
        add(doc, where.join(', '), fileSymbols, f);
      }
    }
    if (editText) {
      const { hits } = scanCodeForDocs(editText, new Set(Object.keys(db.curated.docs)));
      for (const h of hits) if (docPath(h.name)) add(docPath(h.name), `the edited code cites ${h.name}${h.section ? ' §' + h.section : ''}`, fileSymbols, f);
    }
  }
  for (const [target, reasons] of out) {
    if (!target.endsWith('.md')) continue;
    for (const [from, symbols] of impactSymbols.get(target) || []) {
      for (const sentence of sentencesMentioning(repo.read(target) || '', symbols, from)) reasons.add(`mentions ${[...symbols].filter(s => identifierOccurs(sentence, s)).join(', ')}: ${sentence}`);
    }
  }
  return [...out].map(([target, why]) => ({ target, why: [...why] })).sort((a, b) => a.target.localeCompare(b.target));
}

const fmt = list => list.map(i => `  - ${i.target} — ${i.why.join('; ')}`).join('\n');
export const memoryDirFor = root => join(homedir(), '.claude', 'projects', toPosix(resolve(root)).replace(/[/.:\\]/g, '-'), 'memory');

// ---------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------
async function stdinJson() { let s = ''; for await (const c of process.stdin) s += c; try { return JSON.parse(s || '{}'); } catch { return {}; } }
const writeDb = db => writeFileSync(join(ROOT, DB_PATH), JSON.stringify(db, null, 2) + '\n');

async function main() {
  const [cmd = 'check', ...args] = process.argv.slice(2);
  const repo = gitRepo(); const db = loadDb(repo);
  if (cmd === 'build') {
    db.derived = build(repo, db);
    writeDb(db);
    const d = db.derived; console.log(`built ${DB_PATH}: ${Object.keys(d.codeCitesDocs).length} code files cite docs, ${Object.keys(d.docCitesCode).length} docs cite code, ${Object.keys(d.anchors).length} anchors`);
    return;
  }
  if (cmd === 'check') {
    const r = check(repo, db, { memoryDir: args.includes('--memory') ? memoryDirFor(ROOT) : null });
    for (const w of r.warnings) console.log(`WARN  ${w}`);
    for (const e of r.errors) console.log(`ERROR ${e}`);
    console.log(`doclinks: ${r.errors.length} error(s), ${r.warnings.length} warning(s) — ${JSON.stringify(r.stats)}`);
    process.exit(r.errors.length ? 1 : 0);
  }
  if (cmd === 'reviewed') {
    // Record that these docs were checked against the code at HEAD and needed no change — with why.
    const why = args.includes('--why') ? args[args.indexOf('--why') + 1] : null;
    const docs = args.filter((a, i) => a !== '--why' && args[i - 1] !== '--why');
    if (!docs.length || !why) { console.error('usage: doclinks reviewed <doc...> --why "<what you checked and why no change was needed>"'); process.exit(2); }
    db.curated.reviewed = db.curated.reviewed || {};
    for (const d of docs) { if (!repo.files.includes(d)) { console.error(`no such doc: ${d}`); process.exit(2); } db.curated.reviewed[d] = { at: repo.head(), why }; }
    db.curated.reviewed = Object.fromEntries(Object.entries(db.curated.reviewed).sort());
    writeDb(db);
    console.log(`recorded review of ${docs.length} doc(s) at ${repo.head()}`);
    return;
  }
  if (cmd === 'impacted') {
    const files = args.length ? args.map(toPosix) : repo.changed();
    const list = impacted(repo, db, files, { changedLines: f => repo.changedLines(f) });
    console.log(list.length ? `For ${files.length} changed file(s), review:\n${fmt(list)}` : `Nothing linked to ${files.length} changed file(s).`);
    return;
  }
  if (cmd === 'hook-post') {
    const inp = await stdinJson();
    const abs = inp?.tool_input?.file_path; if (!abs) return;
    const f = toPosix(relative(ROOT, resolve(ROOT, abs))); if (f.startsWith('..') || f === DB_PATH) return;
    const editSnippets = [inp.tool_input.new_string, inp.tool_input.content, ...(inp.tool_input.edits || []).map(e => e.new_string)].filter(Boolean);
    const editText = [inp.tool_input.old_string, inp.tool_input.new_string, inp.tool_input.content, ...(inp.tool_input.edits || []).flatMap(e => [e.old_string, e.new_string])].filter(Boolean).join('\n') || null;
    const list = impacted(repo, db, [f], { editText, editSnippets });
    if (!list.length) return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse',
      additionalContext: `doclinks: ${f} is linked to the following. If this edit changed behaviour they describe (or a rule they state), update them in this task; if not, carry on.\n${fmt(list)}` } }));
    return;
  }
  if (cmd === 'hook-stop') {
    const inp = await stdinJson();
    if (inp.stop_hook_active) return;                       // remind once per stop, never loop
    const changed = repo.changed().filter(f => f !== DB_PATH);
    if (!changed.length) return;
    const list = impacted(repo, db, changed, { changedLines: f => repo.changedLines(f) }).filter(i => i.target.endsWith('.md') && isLive(db, i.target));
    const r = check(repo, db);
    const notes = [];
    if (list.length) notes.push(`These live docs are linked to files you changed and were not themselves changed:\n${fmt(list)}\nReview each; update it if the change affects what it says, otherwise record why not: ${CMD} reviewed <doc> --why "...".`);
    if (r.errors.length) notes.push(`doclinks check has ${r.errors.length} error(s) (the gate will fail):\n${r.errors.slice(0, 8).map(e => '  - ' + e).join('\n')}`);
    if (r.warnings.some(w => w.includes('stale'))) notes.push(`docs/links.json is stale — run \`${CMD} build\` and include it in the commit.`);
    if (notes.length) process.stdout.write(JSON.stringify({ decision: 'block', reason: notes.join('\n\n') }));
    return;
  }
  if (cmd === 'precommit') {
    const staged = repo.staged(); if (!staged.length) return;
    const list = impacted(repo, db, staged, { changedLines: f => repo.changedLines(f, { cached: true }) }).filter(i => isLive(db, i.target) || !i.target.endsWith('.md'));
    const r = check(repo, db);
    if (list.length) console.error(`doclinks — linked to what you are committing, and not in the commit:\n${fmt(list)}`);
    for (const e of r.errors) console.error(`doclinks ERROR ${e}`);
    if (r.warnings.some(w => w.includes('stale'))) console.error(`doclinks — docs/links.json is stale: ${CMD} build`);
    return;                                                  // warns, never blocks
  }
  console.error(`unknown command ${cmd}`); process.exit(2);
}

// Run as a script, not when imported. Windows paths compare case-insensitively (drive letters vary).
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && samePath(resolve(fileURLToPath(import.meta.url)), invokedPath)) main().catch(e => { console.error(e.message); process.exit(1); });
