# Shape-aware recall — scope

## The problem in one line

concept-db already holds the vocabulary for organising a project. metabob-mcp
reads two shapes of it.

| Shape | In concept-db | Read by metabob-mcp |
|---|---|---|
| `code_finding` | 170 | yes |
| `finding_verdict` | 145 | yes |
| `work_lease` | 177 | **no** |
| `work_assignment` | 16 | **no** |
| `design_decision` | 10 | **no** |
| `design_constraint` | 4 | **no** |
| `repo_anchor`, `session_summary`, `gotcha`, `failure_mode_taxonomy` | 1 each | **no** |

`concept_create` can write any of them; nothing surfaces them. They are
write-only, and the counts show what that does to behaviour: 170 findings
against 10 decisions. **The surface shapes what gets recorded.**

## What the existing corpus already tells us

Four things, read off the real concepts rather than assumed.

**1. Structure exists only where a tool imposed it.** `code_finding` bodies
carry disciplined headers — `repo:`, `workspace:`, `files:`, `severity:`,
`finding_ids:` — because `record_finding` writes them. Two of the four
`design_decision` concepts inspected have *no* header lines at all: freeform
prose from `concept_create`. Recall cannot filter, scope, or render what has no
structure. Any read path is therefore blocked on a write path that imposes one.

**2. The cross-repo case is real, and current scoping breaks it.** A
`design_constraint` about work-leasing carries `repo: metabob-dashboard` while
being a proposal about *metabob-mcp*. Repo-scoped recall — the fix that took
finding precision from 10.6% to 100% — makes it **invisible from the repo it
constrains**. Scoping decisions the way we scope findings would hide exactly the
concepts whose whole purpose is to bind more than one repository.

**3. Lifecycle vocabulary is already in use, informally.** One constraint body
reads `status: PROPOSAL — nothing implemented in metabob-mcp`. Another opens
`MEASURED: …` and closes `VERDICT: the assumption is HALF FALSE`. People are
recording validation state by hand because there is nowhere to put it.

**4. A good `repo_anchor` for this repo already exists** — root path, language,
scale, version, "structure worth knowing before editing" — and nothing has ever
read it.

## Organising principle: sort by *when the agent needs it*

Not by what the concept is. Shape is a storage detail; the agent's question is
always *"what do I need to know before I do this?"* Four moments, four
treatments:

| Moment | Shapes | Why then | Where |
|---|---|---|---|
| **Session start** | `repo_anchor`, `session_summary` | orientation, once | `get_analysis_context` |
| **Before editing** | `design_constraint`, `gotcha` | **prescriptive** — changes what you build | `analyze_impact`, `predict_cochanges` |
| **Before re-deciding** | `design_decision` | **explanatory** — stops re-litigating a settled call | `analyze_impact`, and on demand |
| **Choosing work** | `code_finding` | actionable | `get_problems` (already) |

The important pairing is *constraints with blast radius*. A constraint is only
useful before the edit it constrains, and `analyze_impact` is the one call an
agent already makes at exactly that moment. Attaching them there costs the agent
no extra call and no extra discipline — which is the only way it gets used.

Decisions attach to the same moment but answer a different question: not *what
must I respect* but *what has already been tried here*. The line that matters is
the **rejected alternative**, because that is the one an agent is about to
re-propose.

## Scoping rules — different per shape, deliberately

This is the crux. One rule cannot serve both.

- **Findings** stay exactly as they are: `repo:` exact match. Precision is the
  whole value and it was expensive to get.
- **Constraints and decisions** scope on a `binds:` list — the repositories a
  concept governs — falling back to `repo:` when absent. A constraint written in
  repo A about repo B must surface in B. Without this the feature is worse than
  useless: it would hide precisely the cross-repo knowledge it exists to carry.
- **Anchors** scope on `repo:` and are limited to one.
- **Gotchas** scope on `files:` as well as `repo:`, so they surface with the code
  they trap rather than on every call.

## Lifecycle: decisions need supersession, for the same reason findings needed verdicts

A reversed decision that reads as current is worse than no decision — the same
failure the verdict join fixed for findings, where every finding ever recorded
rendered as open forever. Reuse the mechanism rather than inventing one:
a `design_decision` carries `status:` (`proposed` | `accepted` | `superseded`)
and an optional `superseded_by:`; recall renders superseded ones in a trailing
section or omits them, never in the live list.

Validation state gets the same treatment, because the corpus shows people
already writing it by hand: `evidence:` (`measured` | `asserted`) and
`verified_at:`. An asserted claim and a measured one must not render alike —
that distinction is the entire content of the tool-questions document.

## Budget: the constraint that decides whether this is used or ignored

Recall that costs more than it saves gets ignored, and today's evidence is
unambiguous: `concept_search` spent ~9k tokens to yield four useful lines, and
`renderFindingsSection` prints only a summary and an id, so the stored detail —
which for a decision *is* the value — never reaches the agent.

So:
- **Compact by default.** One line per concept: the summary, plus for a decision
  the rejected alternative. Nothing else.
- **Expandable by id**, never by default.
- **Hard caps per section**, with an honest "N more" rather than silent
  truncation.
- **Zero concepts renders nothing** — no empty headers.

## The write path is not optional

170 findings against 10 decisions is the measurement that matters: `record_finding`
exists and `record_decision` does not. A read path over an empty, unstructured
corpus demonstrates nothing.

`record_decision` — decision, alternative rejected, why, `binds:` repos,
`status:`, `evidence:` — imposing the same header discipline `record_finding`
imposes today. Everything above depends on it.

## Staging

1. **`record_decision`** + header discipline. Without structure there is nothing
   to read.
2. **Widen recall to `design_constraint` and `design_decision`** with the
   `binds:` scoping rule. `scanConceptShape` is already shape-parameterised, so
   the read is small; the scoping rule is the work.
3. **Attach constraints to `analyze_impact`.** The highest-value surfacing
   moment, and it needs no new agent habit.
4. **`repo_anchor` in `get_analysis_context`.** One concept, session start.
5. **Supersession and evidence rendering.**
6. **`work_lease`** — deliberately last, but it is the mechanism the assignment
   queue needs: claiming is currently an unconditional last-writer-wins `UPDATE`
   with no exclusion, while the substrate has a lease shape used 177 times.

## Failure modes, and the guard for each

| Failure | Guard |
|---|---|
| Recall becomes a wall of text; agents skip it | compact-by-default, hard caps, expand by id |
| Stale decisions outnumber live ones | supersession; superseded never in the live list |
| Cross-repo constraints invisible | `binds:` scoping, not `repo:` |
| Noise regression, as findings had at 10.6% precision | measure precision per shape before and after, same method as the findings fix |
| Nothing gets written, so recall stays empty | ship the write path first |
| Asserted claims read as established | `evidence:` rendered inline, never omitted |

## How we would know it worked

Through the evaluation protocol, not by inspection — the same discipline that
turned two confident claims about this tool into measured negatives.

The discriminating task is one where an agent is about to **re-propose a
rejected approach**, or **violate a constraint recorded in another repository**.
Both are unrediscoverable by `grep`: the road not taken leaves no trace in the
code that survived, and a constraint held in another repo is not in this one's
text at all. That is a sharper test than the fact-recall task that failed, where
the planted facts turned out to be greppable in-tree because the session that
recorded them also documented them properly.

Prediction, stated in advance so it can fail: **the isolated arm re-proposes the
rejected approach.** If it does not — if reading the code is enough to infer what
was already tried — then this is documentation with extra steps, and should be
reported as such.
