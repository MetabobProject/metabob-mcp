# What question does each tool answer?

A tool earns its place by answering a question an agent actually has, better than
the cheapest alternative. For a coding agent the cheapest alternative is almost
always `grep`, `git`, `sqlite3`, and reading the file — all of which are fast,
free, and already available.

So each tool below is stated as: **the question**, the **cheapest alternative**
that also answers it, and a **verdict** on whether the tool is the better answer.
A tool with no question of its own, or whose question `grep` answers as well, is
surface area rather than capability.

Evidence levels are marked because they are not equal:

| Mark | Meaning |
|---|---|
| **measured** | Observed in a controlled run — see `METABOB-EVALUATION-PROTOCOL.md` |
| **exercised** | Used in real work and the outcome checked, but not against a control |
| **asserted** | Derived from the code and its description; nobody has tested it |

`asserted` is the honest default for most of the surface. It is also the backlog:
each one is a task for the next protocol run.

---

## Plane 1 — Structure (the local CPG)

Questions about how this codebase is shaped. All local, no network.

| Tool | The question | Cheapest alternative | Verdict |
|---|---|---|---|
| `init_workspace` | *(none — it is an actuator)* Make the map exist. | — | **Precondition, not an oracle.** Judge it on cost: 118 files / 1440 components in 1.3s. **measured** |
| `analyze_impact` | "If I change this file, what else can break — including transitively, and which tests?" | `grep` for importers, one hop only | **Distinct.** Transitive closure with depth, and it surfaces affected *tests*. It named `agent-coordination-store.test.ts` as reachable from `local-store.ts` when co-change did not. **exercised** |
| `predict_cochanges` | "What has historically moved together with this file?" | `git log --name-only` plus counting | **Half distinct.** The git-history half answers a real question cheaply. The GCN half answers nothing: uniform 99.8–99.9% across unrelated nodes, including two `<anonymous>` entries scored on an empty string. **measured** |
| `assign_git_changes` | "My diff touches these files — which components is that, and what did I forget?" | `analyze_impact` + `predict_cochanges` on the diff | **Composite.** No question of its own; it is a convenience over two tools that each have one. **asserted** |
| `search_codebase` | "Where is this concept mentioned in code or problems?" | `grep -rn` | **Not distinct — worse.** Token matching on 2-character fragments produced three false positives, and it rendered a fabricated `[cache: 0s old]` over 23-hour-old data. `grep` is faster and correct. **measured** |

## Plane 2 — Findings (attribution and recall)

Questions about what is known-wrong here. The value is entirely in *who else*
knew it — anything you could have found yourself is answered by reading the code.

| Tool | The question | Cheapest alternative | Verdict |
|---|---|---|---|
| `record_finding` | *(actuator)* "Make this observation survive me." | A comment, a TODO, an issue | **Distinct in kind.** A comment reaches whoever opens that file; this reaches whoever asks about the repo, from another process. **measured** (durability probe) |
| `get_problems` | "What is known-wrong here that I did **not** find myself?" | Reading the code; `sqlite3` on the sidecar DB | **Distinct only for the cross-agent half.** In a controlled run it was the *observable under test*, not an instrument: the control arm reproduced its entire output — exact strings, exact ordering — without calling it. Its value is the recall section, not the seed list. **measured** |
| `mark_complete` | *(actuator)* "Record that this is settled, so nobody re-does it." | — | **Distinct.** Nothing else closes the loop, and until the verdict join existed this write went nowhere a reader could see. **measured** |
| `annotate_component` | "Explain this recorded finding and suggest a fix." | Ask the model you already are | **Not distinct.** It renders a local finding through templates; there is no server-side analysis behind it, and the agent reading the finding explains it at least as well. **asserted** |
| `get_analysis_context` | "I just arrived — what is the state of this codebase?" | Three other calls | **Composite, useful once.** Substitutable by inference: its own output reveals what it would have told you. **measured** |

## Plane 3 — Concept graph (memory that is not in the repo)

This is the only plane whose questions are structurally unanswerable by reading
the repository, because the answers were never written into it.

| Tool | The question | Cheapest alternative | Verdict |
|---|---|---|---|
| `concept_search` | "What did someone already learn about this that is **not** in the code?" | None | **The strongest tool on the surface.** In a controlled A/B it was metabob's *only* non-substitutable contribution: a verdict concept's write timestamp, `origin`, and author exist in no file and no local table. Caveat: no repo or finding-id filter, ~9k tokens to extract four lines. **measured** |
| `concept_neighbors` | "What else is connected to this idea, and how?" | None | **Distinct.** Edge traversal of memory; a keyword search cannot follow a typed edge. **exercised** |
| `concept_sequence` | "What concepts have co-occurred with this one in *successful* traces?" | None | **Distinct in principle.** Requires accumulated execution history to mean anything. Untried here. **asserted** |
| `concept_usage_stats` | "Is this concept actually trusted, or merely present?" | None | **Distinct.** Relevance is a Bayesian posterior over outcomes — nothing in a repo encodes it. **asserted** |
| `concept_create` | *(actuator)* "Make this learning findable by someone who does not know it exists." | A doc file | **Distinct in reach**, same caveat as `record_finding`. **exercised** |
| `concept_link` | *(actuator)* "Attach this to the neighbourhood so it is reachable, not just searchable." | — | **Distinct.** An unlinked concept is findable only by semantic search. **asserted** |
| `concept_record_usage` | *(actuator)* "This concept helped / misled me." | — | **Distinct.** The only deliberate write into relevance; without it, quality never improves. **asserted** |

## Plane 4 — Goals (dispatch into the substrate)

| Tool | The question | Cheapest alternative | Verdict |
|---|---|---|---|
| `run_goal` / `run_goal_async` | "Can the substrate do this for me?" | Do it yourself | **Distinct only where the goal-host mounts the repo.** On an arbitrary codebase the agent is the actuator and these do not apply. `learning_mode: "observe"` dispatches a probe that teaches the substrate nothing (by effect: dispatch cb6b2d6d logged `learningMode=observe`). **exercised** |
| `goal_status` | "Did it actually *reach* the goal, and what did the walk teach?" | — | **Distinct, and the distinction is the point:** `reached` ≠ `status`; a satisfier reach can be `failed` yet `reached:true`. Its `learning:` line reports goal-host's recorded consequences rather than the mode requested. **exercised** |
| `goal_reasoning` | "*Why* did it reach, or fall short?" | — | **Distinct.** Reconstructs the walk's decision log. Thin for satisfier-only reaches, and it says so. **asserted** |
| `provide_feedback` | *(actuator)* "That verdict was wrong / right." | — | **Distinct.** Writes the agent's verdict into the oracle corpus as an `automated` label; it is not ground truth, and goal-host does not overwrite a reach verdict with it. A person's verdict goes through the human surface. **asserted** |

## Plane 5 — Inspection (replacing shell access)

These answer questions you could answer with `docker exec` and `curl` — *if you
have host access*. Their value is conditional on not having it.

| Tool | The question | Cheapest alternative | Verdict |
|---|---|---|---|
| `registry_query` | "What shapes exist, and who serves them?" | `curl discovery/registry/shapes` | **Distinct without host access.** **asserted** |
| `execution_trace` | "What actually happened in that execution?" | `curl activity-api` | **Distinct without host access.** **asserted** |
| `resolve_impulse` | "Can I reach a shape no dedicated tool covers?" | `curl /v2/impulses/resolve` | **Escape hatch.** Prefer the dedicated tool when one fits. **asserted** |
| `get_metrics` | "How much is known-wrong here, by severity and source?" | `get_problems` and counting | **Composite.** A local count over the findings store and the code index; it makes no request. **asserted** |

## Plane 6 — Inbound coordination

| Tool | The question | Cheapest alternative | Verdict |
|---|---|---|---|
| `pull_assigned_work` | "Has anything been assigned **to me**?" | None | **Unavailable by design.** The server is a client of the substrate and advertises nothing, so no task can be dispatched to it; the tool says so (CONFORMANCE §c11). It becomes an inbound channel only when the substrate offers a reachability probe for host-run clients. **asserted** |
| `submit_resolution` | *(actuator)* "Here is my answer; unblock the walk." | None | **Unavailable by design**, same reasoning: it answers only tasks already in the local queue. **asserted** |

---

## What the mapping implies

**Two questions are structurally unanswerable without this surface.** What
someone else already learned (`concept_search`), and whether a finding is settled
(`mark_complete` + verdict-aware recall). These survive the `grep` test by construction, because the
answers were never written into the repository.

**One question is answered better here than by the alternative.** Transitive
impact with test reachability (`analyze_impact`). A one-hop `grep` genuinely does
not answer it.

**One tool answers a question `grep` answers better.** `search_codebase`.

**Several tools are composites** — `assign_git_changes`, `get_analysis_context` —
which is fine for ergonomics but means they should never be evaluated as though
they had questions of their own.

**Most of the surface is `asserted`.** Fourteen of the entries above have never
been tested against a control. That is not a criticism of the tools; it is a
statement about the evidence, and it defines the corpus for the next evaluation
run. The planes to test first are the ones whose questions look strongest on
paper and have the least evidence: the goal plane beyond the deterministic
reaches, and the concept graph's sequence and usage reads.

**The read/write asymmetry is the real finding.** Every tool that survives the
`grep` test is either a *write* (making something durable or shared) or a read of
something *another agent wrote*. No tool that merely re-reads the current
repository has survived comparison. That is a coherent design position, and it is
a sharper claim than "code intelligence": the value is memory across boundaries,
not analysis of what is in front of you.
