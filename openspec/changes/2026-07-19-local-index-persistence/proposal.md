# Local CPG index persistence across launches

Status: PROPOSED (deferred — do not implement without satisfying the safety constraints below)
Date: 2026-07-19

## Problem

The local Code Property Graph + vector index (`src/local-index.ts`,
`src/cochange-predictor.ts`, `src/vector-index.ts`) is in-memory only. Every
process launch starts with an empty index and rebuilds it incrementally as the
agent calls `init_workspace` (default 5 files/batch). A restart loses all
indexed coverage; `predict_cochanges` and `analyze_impact` (which require prior
`init_workspace` in the same process) start cold again.

## Why this is not already fixed

The naive plan — a disk cache keyed by file path + mtime/size (or content
hash), storing parsed CPG nodes/edges + embeddings, invalidated per changed
file — is CORRECTNESS-UNSAFE. The primary, independently-sufficient reason:

1. **Edges are authored across files.** `GraphBuilder.findCallExpressions`
   (vendor/cpg-inference/src/graph-builder.ts) creates `CALLS` edges by
   `cpg.findByName(calleeName)` against whatever files are already in the CPG
   at parse time. The edges INTO file X are created while parsing OTHER files.
   Correctly invalidating a single changed file therefore requires
   re-resolving edges across the whole graph.

A secondary, narrower hazard reinforces this at the co-change layer:

2. **Component ids embed line numbers.** `generateComponentId`
   (src/cochange-predictor.ts) is `${filePath}::${node.type}::${node.name}::${node.startLine}`,
   so a line shift changes a file's component ids even when nothing structural
   changed. NOTE: graph-node ids are NOT startLine-based — `generateNodeId`
   (graph-builder.ts) is `${currentFile}::${type}-${nodeIdCounter++}[::${name}]`,
   a per-file monotonic counter, so node ids survive a whitespace-only shift.
   The line-number coupling breaks the component/co-change layer, not the raw
   node layer.

Consequence: per-file invalidation would leave `analyze_impact` (BFS over
`CALLS` edges) and `predict_cochanges` serving dependents that point at
stale/absent ids — wrong answers, silently.

Note: `src/vector-index.ts` is a pure-JS flat cosine index and already has
`serialize()`/`deserialize()`/`save()`/`load()`; embeddings are deterministic
from `node.name`. Serialization is NOT the blocker — invalidation is.

## Only-safe design (whole-index, all-or-nothing)

If implemented, persistence MUST:

- Define a `CACHE_VERSION` constant; bump it whenever CPG node/id shape,
  embedding pipeline, or serialization format changes. Version mismatch =
  discard + full rebuild.
- Key the cache by `resolveWorkspaceId(rootPath)` (src/workspace.ts).
- Store, for EVERY indexed file, `{ absPath, mtimeMs, size }` (or content
  hash), plus the serialized cpg (`nodes`, `edges`, `fileIndex` — note
  `FileMetadata` carries `Set` and `Date` fields; `CPGNode` carries large
  `sourceText`), `componentMap`, `FAISSIndex.serialize()`, and
  `LocalIndex` state (`_imports`, `_parsedFiles`, `_submittedFiles`,
  `_filesIndexed`, `_workspacePath`).
- On load: verify `CACHE_VERSION`; `stat` every stored file; if ANY is
  missing / mtime-changed / size-changed, DISCARD THE ENTIRE CACHE and full
  rebuild. Never partially invalidate.
- Wrap load in try/catch: ANY error (corrupt/truncated/parse) → silently
  discard and full rebuild. Never fail startup on cache error.
- Write atomically (temp file + rename) after each `init_workspace` batch or on
  shutdown.

## Open question / cost-benefit

Whole-index invalidation is voided by the first file edit — the primary
workflow is an agent editing code, so the realistic cache-hit case is
"restart without edits." Before implementing, measure the actual cold-start
cost (tree-sitter parse + ONNX embeddings for a full workspace) to confirm the
saved time justifies the serialization surface and the standing staleness
risk. If the win is marginal, keep the index non-persistent.

## Tests required before merge

- Round-trip: serialize -> deserialize reproduces identical
  cpg.nodes/edges/fileIndex, componentMap, FAISS search results, `_imports`.
- Invalidation: mutating one cached file's mtime/size on load discards the
  whole cache and triggers full rebuild.
- Version mismatch discards.
- Corrupt/truncated cache file falls back to full rebuild without throwing.
