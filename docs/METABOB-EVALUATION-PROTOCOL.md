# Metabob evaluation protocol

A repeatable method for answering one question:

> **On a real investigation into this codebase, does the metabob tool surface let an
> agent reach a correct, mechanism-level answer that it could not have reached with
> `grep` / `git` / `sqlite3` / `Read` alone — and at what cost in tool calls?**

The unit of measurement is a **task**: a symptom observed in the running system, whose
root cause exists in this repo and can be verified independently. The unit of
comparison is an **arm**: two agents, same task, one with metabob and one without.

**What this deliberately does not answer.** It is not a correctness audit of the server
(that is `AUDIT-*.md`), not a latency or throughput benchmark, not a test of the
substrate's goal/reason planes, and not a measure of whether metabob helps *write*
code. It measures investigative yield on read-only diagnosis, nothing else. Findings
about the server surface during the run — record them, but they are a by-product, not
the result.

---

## Why a control arm

Two earlier evaluations in this project concluded metabob's contribution was
**unfalsifiable**, for the same reason both times: every agent was handed the answer in
its own prompt. A prompt that says "the seed cache is served stale because the
`file_path` branch never fires" leaves the agent nothing to discover. Whatever it does
next — call a metabob tool, grep, or neither — it arrives at the stated conclusion, and
the run reads as a success for whichever tool it happened to call on the way.

The failure mode has a name: **confirmation with no counterfactual.** A single arm can
only ever show that an agent holding a tool reached an answer. It cannot show the tool
was load-bearing.

The control arm is the whole design. Everything else in this document exists to keep
the two arms comparable and the control honest:

- **Same task text, same rubric, same judge.** The only intended difference is tool
  access.
- **Symptom only, never mechanism** (see § Task corpus rules). If the task text names
  the cause, both arms are pre-answered and the run is void.
- **Facts the control finds that the treatment missed are the most informative output
  of the whole exercise.** They are direct evidence of what the tool surface does not
  buy. Rank them explicitly in the judgement.

---

## Method

### 1. Prepare the server, once, before any task

Start the sidecar the way a real user runs it, note the PID and start time, and leave it
running untouched for the entire evaluation. A restart mid-run invalidates every
durability claim and silently rewarms the CPG.

Check and record before starting:

- substrate reachability (concept-db especially — a down backend degrades
  `get_problems`' recall half and confounds every result that depends on it),
- circuit-breaker state,
- whether any *other* sidecar processes are alive against the same `~/.metabob/sidecar.db`.
  Long-running `npx` sidecars execute a **built** entrypoint, which may predate the
  source under test. Two processes on one DB with different code is a real confound;
  find it now, not in the judgement.

### 2. Index once, up front

Run `init_workspace` yourself before spawning any agent, and record file count, CPG
component count, and wall time. Then tell every agent **the workspace is already indexed;
do not run `init_workspace`.**

Why: indexing is not durable across processes and takes seconds. If agents index
ad hoc, tool-call counts stop being comparable and the CPG state differs between arms.

### 3. Choose the task corpus

Three tasks is the working minimum; see § Task corpus rules for what qualifies. Fix the
corpus before writing any prompt — choosing tasks after seeing what a tool is good at is
how an evaluation talks itself into a result.

For each task, write down the **ground truth** — root cause, `file:line` anchor, and a
list of 4–6 discrete facts a complete answer must contain — *before* the run. The rubric
is scored against this list, not against whichever answer sounds best afterwards.

### 4. Write symptom-only task text

The task text gives the agent what a user would actually have: the observed output, the
tool that produced it, and the question "why". It must not contain the cause, the file,
the function, or the mechanism.

Watch for **leakage through verbatim output.** Exact rendered strings and numbers are
excellent grep anchors. Including them hands the control arm a free index into the
source, and simultaneously removes the one job the metabob tool could have done —
producing the observable in the first place. Prefer paraphrased symptoms; if exact
strings are unavoidable, note it as a known bias toward the control.

### 5. Split the arms

For each task, spawn two agents with identical task text and identical rubric.

- **Arm A (treatment):** metabob tools available; instructed to use them where they fit,
  and to log every call.
- **Arm B (control):** instructed not to use any metabob tool, and to end its report with
  an explicit `used_metabob: false` attestation.

Load-bearing constraints in both prompts:

1. **Read-only.** No edits, no commits, no git state changes. (`record_finding` and
   `mark_complete` are writes to shared state — exclude them, or the arms mutate the
   corpus other tasks read.)
2. **Report format is fixed:** verdict, the numbered fact list, `file:line` anchors,
   and a complete tool-call log. Free-form reports cannot be scored.
3. **The verdict vocabulary is fixed and small** — e.g. `live-defect` /
   `legacy-data-only` / `not-a-defect`. An agent that hedges is unscorable.
4. **"The server is healthy; deviations are findings."** Without this, an agent primed
   for a broken environment routes around anomalies instead of reporting them.
5. **No full test suite.** Targeted single test files only — a suite run is minutes of
   noise and inflates the call count asymmetrically.

Run arms in parallel where possible so neither can read the other's output.

### 6. Run the cross-session durability probe

Separate from the task arms, and the only part of the protocol that tests the *system*
rather than the agent. It answers: which state survives a process boundary?

1. Spawn a **fresh** sidecar process on unused ports, against the same config, same
   sqlite DB, same concept-db, with the agent-resolver disabled so it cannot steal
   solicitations. Drive it over stdio JSON-RPC.
2. **Read from cold:** does the fresh process see findings written by the live session —
   both halves, local seed list *and* cross-agent recall, including the closed
   `[FIXED]`/`[RETRACTED]` section? Note which half is disk-sourced and which is fetched
   live per call; they have different failure modes.
3. **Write from cold, read from the live session:** have the fresh process record a
   nonce-tagged finding, kill it, then read it back from the long-running server that
   never restarted. This is the unfakeable direction — it proves durability across a
   process that no longer exists, and doubles as the two-concurrent-agents case.
4. **Establish what is *not* durable** and what it costs: CPG-dependent tools from cold,
   the discovery shape-set (Law 1 gating makes non-durability observable from the
   registry side), then boot→ready and re-index wall time.
5. **Clean up and account for it.** Kill every spawned process, confirm no orphans, list
   the ports closed. Probe artefacts are writes to shared state: prefix summaries with a
   nonce, list the seed ids for retirement, and state plainly that org-wide concepts are
   permanent by design.

Harness note worth inheriting: a malformed JSON-RPC envelope (e.g. harness metadata keys
inside the message object) is dropped **silently** — no error response, server logs look
healthy. If every request times out including `initialize`, suspect the driver.

### 7. Judge

One judge, all six reports, scored against the pre-written ground truth.

The judge does not take reports at face value. Two verification duties:

- **Independently check load-bearing claims.** A confident report can misattribute its
  own reproduction — e.g. asserting a branch fired when a one-caller check on the
  writer shows it cannot have. Spot-check the claims the verdict rests on.
- **Contamination check is tracing, not attestation.** For every arm-B fact, name a
  non-metabob source it could have come from. IDs that look like tool output often live
  in sqlite columns. Behavioural corroboration counts: a control that *declines* to
  confirm something and downgrades its confidence is showing arm discipline a
  contaminated run would not have.

Then produce: the per-task table (§ The rubric), an explicit "did metabob help" section
naming any **non-substitutable** contribution, the facts the control found that the
treatment missed, and the confounds.

---

## Task corpus rules

**A good task:**

- **Real.** Observed in the running system, not invented for the evaluation.
- **Small.** One mechanism, resolvable in tens of tool calls, not a subsystem review.
- **Verifiable.** A ground truth that exists *now* and can be confirmed from the repo —
  source, git history, sqlite, or a targeted test.
- **Read-only.** Answerable without mutating shared state.
- **Discriminating.** Plausibly easier with structural/graph/cross-agent context than
  without. A task that is pure `grep` measures nothing.
- **Independent of the other tasks.** Distinct root causes. Two tasks that bottom out in
  the same asymmetry are one question asked twice, and the cells are correlated — the
  effective sample is smaller than the table suggests.

**A bad task:**

- Invented, or seeded by the evaluator into the DB just before the run.
- Unfalsifiable — no fact would make the answer wrong.
- Mechanism stated in the prompt (see § Why a control arm).
- Requires edits, or writes that collide with another task's reads.
- Ground truth that has to be decided after reading the reports.

Mix verdict types on purpose. If every task's answer is "live defect", an agent that
always answers "live defect" scores perfectly. At least one task should resolve to
"legacy data, already fixed" or "not a defect".

---

## The rubric

Four fixed metrics per (task, arm) cell, plus one penalty:

| Metric | Definition | Why it is here |
|---|---|---|
| **Verdict correct?** | Boolean, against the fixed vocabulary. | The headline. Everything else is texture if this is wrong. |
| **Facts (n/N + bonus)** | How many of the pre-written ground-truth facts appear; `+1` per correct, load-bearing fact beyond the list. | Distinguishes a right answer from a right answer with the mechanism. Bonus facts are where the arms actually separate. |
| **Tool calls** | Total, including harness overhead (tool-schema lookups count — they are real cost). | The price of the answer. |
| **`file:line` right?** | Does it anchor at the true site, at line granularity? | Separates "named the file" from "found the code". A pre-fix anchor (`<sha>~1:file:line`) can be *sharper* than a HEAD anchor — credit it. |
| **Over-claim penalty** | Deduct for any asserted-as-verified claim that independent checking falsifies. | Confidence unbacked by evidence is worse than a gap. Without the penalty, the rubric rewards assertion. |

Also record, per run: the aggregate per-tool ranking across arm A (which tools were
essential, which were substitutable, which were net-negative, which were loaded and
never called), and the probe's durability answers plus rewarm cost.

**Fixed metrics are the only thing that makes runs accumulate.** A single sample per
cell is an anecdote — n=1 cannot separate tool effect from agent variance, and it never
will. The value is comparability over time: same rubric, same shape of corpus, numbers
you can put next to the last run's. If a later run changes the metrics, it starts a new
series; say so rather than comparing across the change.

---

## Known limitations

State these in every run's results. They do not invalidate the method; hiding them does.

- **Instruct-and-attest, not technical isolation.** Tool gating is process-level
  (`METABOB_TOOLS` and its kin are set for the server, not per agent), so the
  control arm's abstinence is enforced by instruction and self-report, not by the
  harness. Corroborate behaviourally (see § Judge) and say that you did.
- **n=1 per cell**, and correlated cells if the corpus rule on distinct root causes
  slipped. Report the effective number of independent questions, not just the task count.
- **Agent ability is confounded with arm.** Six runs, six draws of reasoning quality;
  at this sample size that is indistinguishable from a tool effect. Do not attribute a
  one-cell difference to the tools.
- **Symptom-text leakage biases toward the control.** Verbatim strings in the task text
  are grep anchors, and they remove the observable-gathering job the treatment tool
  would otherwise have done.
- **Tool-call counts are not clean cost.** They mix genuine investigation with harness
  tax (schema lookups) and with reproduction rigor. At small n, claim no cost advantage
  in either direction.
- **The judge is the same kind of system as the arms.** Independent verification of
  load-bearing claims is what keeps this from being self-assessment.

---

## Recording results

- **The method is checked in; results are not.** Write each run to an untracked, dated
  `RESULTS-YYYY-MM-DD.md` (repo root is fine for untracked files — note the pre-commit
  hook rejects *new tracked* markdown at the root, which is why this document lives in
  `docs/`). This document is frozen — § First run stays as written, and no later run's
  numbers are added to it. **The series lives in the results files:** each
  `RESULTS-YYYY-MM-DD.md` opens with the carry-forward table below, carrying every prior
  run's rows plus its own, so the newest results file is always the complete history.
- Record the environment at the top of every results file: server version/commit, PID
  and start time, substrate reachability, indexed file and component counts, and whether
  any second sidecar was alive on the same DB.

**Carry forward for comparison:**

1. Verdict-correct rate, per arm (x/N).
2. Facts matched per task, per arm, and bonus facts.
3. Tool calls per task, per arm, and the total.
4. The arm-A per-tool ranking (essential → net-negative), which is the most directly
   actionable output.
5. Facts the control found that the treatment missed — the counterfactual, in list form.
6. Probe results: which state survived each direction, and rewarm cost (boot→ready +
   re-index wall time).

---

## First run (baseline)

**One sample. Treat every number below as an anecdote with a date on it, not a result.**

Three tasks, two arms, plus the durability probe. Server healthy, substrate up
throughout, workspace pre-indexed (118 files, 1440 CPG components, 1.3s).

| | Arm A (metabob) | Arm B (control) |
|---|---|---|
| Verdicts correct | 3/3 | 3/3 |
| Facts (of 4/task) | 4, 4, 4 — one over-claim penalty | 4, 4, 4 — **+1 bonus each** |
| `file:line` correct | 3/3 | 3/3 (one anchor sharper: pre-fix `<sha>~1`) |
| Tool calls | 69 (14 / 28 / 27) | 78 (20 / 22 / 36) |

**Headline: all six verdicts correct; the control matched or beat the treatment on core
facts in all three tasks.**

- **Non-substitutable metabob contribution: one.** `concept_search` surfaced a verdict
  concept's write timestamp, provenance and author lines — data held only in concept-db,
  in no repo file or sqlite row. It upgraded certainty on one sub-claim; it did not
  change a verdict.
- `get_analysis_context` gave in-process CPG state that explained a count discrepancy —
  unavailable to grep, but derivable by inference from the emitted string.
- `get_problems` was the **observable, not an instrument**: the control reproduced its
  output, including exact counters and list positions, without it.
- `search_codebase` was net-negative (redundant with a one-second grep, a fabricated
  cache annotation, false-positive matches on two-character tokens); its value was
  becoming a finding.
- `analyze_impact` was loaded twice and called zero times.
- **Facts the control found and the treatment missed:** a dead per-file freshness branch
  and its sole writer; git provenance dating both mechanisms to the prior day's PRs; a
  stale built entrypoint still executing against the same DB; a schema-level gap leaving
  seeds with no durable grouping key. All from grep, git, and sqlite.
- **Probe:** findings survive a session boundary in **both** directions, including a
  write by a process that no longer exists read back by a server that never restarted;
  the local seed half is disk-sourced, the recall and closed sections are fetched live
  per call. The CPG does not survive — ~1.7s to full rewarm (0.3s boot + 1.3s re-index).
- **Incidental finding:** two tools reported contradictory ages for the same seed,
  because one derives freshness from a table with no rows in practice.

**Biggest correction for the next run:** the task text carried verbatim output strings.
They are grep anchors — they handed the control a free index into the source *and*
deleted the only job the treatment tool had. Paraphrase the symptom next time; the
headline result above is biased toward the control by an unknown amount because of it.
