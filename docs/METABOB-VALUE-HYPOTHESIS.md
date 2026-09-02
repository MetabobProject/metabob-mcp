# What metabob-mcp is for

A statement of the value hypothesis, the evidence for and against it, and the
test that would falsify it. Companion to `METABOB-EVALUATION-PROTOCOL.md` (the
method) and `METABOB-TOOL-QUESTIONS.md` (the per-tool mapping).

## The hypothesis

**metabob-mcp is the vessel interface: durable, attributable, shared memory for
agents working the same code — with a structural map as a secondary aid.**

Not code intelligence. An agent equipped with `grep`, `git`, `sqlite3` and a file
reader is already excellent at understanding a repository placed in front of it.
The questions it *cannot* answer are all about things that were never written
into that repository:

- What did another agent already conclude here?
- What was tried and rejected, and why?
- Has work been assigned to me?
- What did I myself establish before this session began?

Those are memory questions, not analysis questions.

## Evidence for

**Cross-process durability is real and was measured.** A finding written by a
process that no longer existed was read back — both the local seed and the
cross-agent recall — by a separate running server that never restarted. The
sidecar database is re-queried per call rather than served from an in-memory
snapshot, so a second agent sees a first agent's work without a restart.

**One tool's contribution was non-substitutable in a controlled run.**
`concept_search` returned a verdict concept's write timestamp, origin and author
— data that exists in no file and no local table. It settled a sub-claim the
control arm could only report conditionally.

**A tool-by-tool pass found a consistent shape.** Every tool that survives
comparison with `grep` is either a *write* (making something durable or shared)
or a *read of something another agent wrote*. No tool that merely re-reads the
current repository survived. That is a coherent design position and a sharper
claim than the product's own framing.

## Evidence against

**The analysis tier loses to `grep`.** In a controlled A/B over three real
defects, the control arm — no metabob, `grep`/`git`/`sqlite` only — matched or
beat the equipped arm on every task, and caught the equipped arm's one confident
over-claim. `search_codebase` was net-negative: redundant with a one-second
`grep`, and it rendered a fabricated cache tag over day-old data.

`analyze_impact` is the exception and should be defended as such: transitive
reach with test discovery is a genuine question `grep` answers badly.

**Backend analysis does not generalise.** The analysis vessel reads
`filePaths` from its own filesystem; no resolver reads an inline excerpt. It can
therefore only analyse files it has **mounted**. For an arbitrary host
repository it returns ENOENT — regardless of how well-connected the substrate is.

**The differentiated half was the unverified half.** The structural tier had
tests. The memory tier carried both criticals and most of the highs in an audit:
a store that deleted itself on launch, recall serving another repository's
findings, verdicts written but never read so closed findings resurfaced forever,
seeds written under one workspace and read under another. A tool that confidently
hands you another repository's problems is worse than no tool. For most of its
life the tier carrying the unique value was not merely unproven — it was wrong.

## What "value without a full connection" actually means

The offline/online split is not *degraded vs full*. It is **single-agent memory
vs fleet memory**:

| | Offline | Connected |
|---|---|---|
| Structural map | local CPG — comparable to `grep`, and `analyze_impact` better than it | unchanged |
| Memory | LocalStore: cross-**session** on one machine | concept-db: cross-**agent**, cross-machine |
| Backend analysis | none | only for files the vessel has mounted |

Offline value is real but modest: a structural map plus memory that survives
restarts on one machine. The differentiated capability — a fleet of agents
sharing what they learn — requires the connection by definition.

## The falsifiable claim

The hypothesis predicts something specific and testable:

> There exist tasks an agent **cannot complete without** this surface, not merely
> completes more slowly — because the necessary fact exists only in memory
> written by another agent, in another process, possibly against another
> repository.

The prior evaluation could not test this. It used tasks whose ground truth was
sitting in the repository, so `grep` was always sufficient and the control arm
was always going to win. **That was a flaw in the test, not a result about the
tool.**

The discriminating test needs a fact that is *unrediscoverable locally*:

- established by observing a **running system** (a live service's actual
  behaviour, which no file records), or
- established in a **different repository** the second agent cannot see, or
- a **decision** — what was tried and rejected — which by nature leaves no trace
  in the code that survived.

Under such a task the prediction is not "fleet is faster". It is **the isolated
arm fails outright**. Anything less than that is consistent with the tool being
a convenience, and should be reported as such.

## What follows if the hypothesis holds

1. `search_codebase` should go. It loses to `grep` and misleads.
2. `analyze_impact` is the local tier worth defending.
3. The memory loop deserves the test rigour the structural tier already had —
   every critical found so far has lived there, and audit found them, not the
   suite.
4. The mounted-files limitation bounds what backend analysis can ever mean for an
   arbitrary repository. That is a larger constraint than any tool-surface
   question and should be stated in the product's own documentation.

## What follows if it does not

If an isolated agent can complete the discriminating tasks — by probing the
running system itself, or by re-deriving the decision — then metabob-mcp is a
convenience layer over `curl` and `grep`, and its value is ergonomic rather than
structural. That is a legitimate product, but it is a different one, and it
should not be sold as memory.
