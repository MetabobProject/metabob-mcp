# Multi-agent coordination: what was demonstrated, and what was not

A record of what this surface was measured to do, assembled from controlled runs
rather than from its documentation. Companion to
`METABOB-VALUE-HYPOTHESIS.md` (the claim) and `METABOB-EVALUATION-PROTOCOL.md`
(the method).

The headline is narrower than the product's framing and better supported:

> **Coordination value is real where agents must not collide or repeat each
> other. It is near zero where the question is "what does this code do" — a
> well-documented repository answers that faster.**

## Demonstrated: five concurrent agents, one repository, no collisions

The strongest result. Five agents were given a tranche id and a one-line title
each, and had to **recall their own brief from metabob** — the ownership
boundaries, the finding numbers, the test bar were deliberately *not* in their
prompts.

- 5/5 recalled successfully; 4/5 purely from metabob, one fell back to reading
  the audit file.
- Five agents edited one working tree concurrently. **Zero file collisions.**
- Outcome: 9 high-severity findings closed, suite 278 → 326, all merged.

The adjudicating judge's finding is the load-bearing one:

> the titles in the prompt would **not** have sufficed — ownership boundaries and
> the test bar lived only in the recalled detail, and those are what kept five
> concurrent agents off each other's files.

That is coordination changing an outcome, not a route. The alternative — pasting
every brief into every prompt — is what an earlier run did, and its own
evaluation concluded the result was unfalsifiable because of it.

## Demonstrated: work survives the process that did it

A finding recorded by a process that was then killed was read back — both the
local seed and the cross-agent recall — by a separate server that never
restarted. Verified in both directions: a finding written by the fresh process
was visible to the original session.

`get_problems` re-queries SQLite per call rather than serving an in-memory
snapshot, so a second agent sees a first agent's work without a restart. The CPG
is the one thing that does not survive; re-warming costs ~1.3s for 118 files.

## Demonstrated: dispatched work reaches an agent and comes back

`human_input` solicitation POSTed to a running vessel → durably enqueued keyed by
the stable vessel id → returned by `pull_assigned_work` → answered by
`submit_resolution`. The loop closes across processes and sessions.

This path had never been exercised; `pull_assigned_work` had only ever returned
empty.

## Demonstrated: closed work stops being offered as open

Before the verdict join, every finding ever recorded rendered as open forever —
agents were handed work already finished, one of them insisting a test did not
exist that had been written hours earlier. After: nine findings render under a
`[FIXED]` closed section, one genuinely-open finding remains in the live list.

## Not demonstrated: recall beating `grep` for facts

Three independent controlled runs, three negatives.

1. **Investigation A/B** — control arm (`grep`/`git`/`sqlite` only) matched or
   beat the equipped arm on all three tasks, and caught the equipped arm's one
   confident over-claim.
2. **Fleet-memory run** — three planted "unrediscoverable" facts turned out to be
   greppable in-tree. All three fleet agents checked and reported this against
   their own arm's interest.
3. **Design-decision run** — a measurement recorded only in metabob. All four
   agents produced identical designs; the isolated arm measured it themselves at
   *lower* tool cost.

The mechanism is consistent and worth stating plainly:

> **A well-documented codebase erodes the fleet-memory advantage for facts.** The
> session that discovers something also writes it into a comment or a commit
> message, so `grep` finds it. What survives is the window between observation
> and commit — and facts that never land in-tree at all.

Run 3 makes the confound explicit: `src/tools/_findings.ts:272` states the rule
outright, and `scanConceptShape()` is a ready-made correct implementation. The
codebase carried the knowledge; the memory only carried the reason.

## Not demonstrated: safe concurrency

Claiming is **advisory, not exclusive**. `claimAgentTask` is an unconditional
last-writer-wins `UPDATE` with no rows-affected check, and the pending list still
returns claimed rows. Three agents each pulled all five tasks and three answered
the same four; the schema cannot record that a collision occurred.

The no-collision result above came from **static file ownership assigned in the
brief**, not from the queue. Those are different mechanisms, and only the first
was tested.

Delivery is also misreported: `submit_resolution` marks a resolution
`delivered=1` on its terminal-failure branch, so answers that never reached the
substrate are recorded as delivered and are unreachable by the retry path.

## What this adds up to

| Claim | Status |
|---|---|
| Agents can divide work without colliding, given briefs only they can see | **demonstrated** |
| Work survives the process, the session, and the machine | **demonstrated** |
| Dispatched work reaches an agent and returns | **demonstrated** |
| Completed work stops being re-offered | **demonstrated** |
| Recall beats reading the repo, for facts | **falsified, three times** |
| The queue is safe under concurrency | **falsified** |
| Delivery is reliably reported | **falsified** |

The honest positioning: this is **coordination infrastructure**, and it earns its
place where multiple agents share work over time. It is not code intelligence,
and every attempt to demonstrate it as such has produced a negative.

## The correction that matters most

One measurement in this record was wrong. A "semantic search returns 0 of 24"
result did not reproduce — replay found 3 of 24. The conclusion survived (that
retrieval path is still wrong) but the evidence for it did not, and the corrected
number is *more* alarming: a path returning a plausible handful passes review,
where one returning zero would not.

That correction exists because the adjudicator was told to re-run the ground
truth rather than accept it. A ledger that cannot record "the earlier
measurement was wrong" accumulates confident errors — the same failure as recall
that cannot record "this finding is closed", which took four months to notice.
