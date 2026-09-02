# Demo script

Three beats, each one mechanism, each under a minute. Every claim here was
measured — see `COORDINATION-DEMONSTRATION.md`. Nothing in this script may imply
code intelligence or atomic claiming: both were falsified, and a demo resting on
either is a demo of a bug.

The framing that earns trust with a developer audience:

> **"We tested it against `grep` three times and lost. Here is the narrow thing
> it is actually good at."**

Lead with that. A viewer's first instinct is to replay your demo with `grep` —
saying it first is the only way that lands well.

---

## Setup (before recording)

```bash
cd ~/documents/work/metabob-mcp
git switch dev && git pull --ff-only          # 0fb6520 or later
bun run typecheck && bun test tests           # 377 pass / 0 fail
```

A running substrate is **not** required for any beat. All three run offline —
which is itself worth saying on camera, because the offline tier is the one most
viewers will have.

---

## Beat 1 — "Kill the agent, keep the work" (~30s)

The unfakeable one. Lead with it.

**Story:** an agent finds something, dies, and the finding is still there.

```bash
# 1. A short-lived agent records a finding, then is killed outright.
bun run scripts/demo/record-then-die.ts        # prints the agf_ id, then exits

# 2. Prove the process is gone.
ps aux | grep -c "[s]rc/cli.ts"

# 3. A NEW process — different pid, never restarted from the old one — sees it.
bun run scripts/demo/get-problems.ts | head -20
```

**What to point at on screen:** the pid in step 1, its absence in step 2, the same
`agf_` id in step 3. That is the whole beat.

**Say:** *"Nothing was handed between them. The second process read it off disk."*

---

## Beat 2 — "Your agents stop being handed finished work" (~45s)

**Story:** work that was completed stops being offered as open.

Live numbers as of this writing: **100 findings, 100 verdicts, 44 joined and
closed.** Before the verdict join, all 100 rendered as open forever — agents were
handed work already finished, one of them insisting a test did not exist that had
been written hours earlier.

The strongest version is a **real** before/after, because the old build is still
in the npx cache:

```bash
# BEFORE — the published 0.2.18, which has no verdict join
HOME=/tmp/demo-home npx -y -p @metabob/mcp metabob-mcp   # every finding renders open

# AFTER — this branch
bun run src/cli.ts                                        # closed findings under [FIXED]
```

> ### ⚠ Point 0.2.18 at a throwaway HOME, never your real one
>
> 0.2.18 carries the unfixed `walSize === 0` guard — it **deletes the sidecar
> database** when the `-wal` file is zero bytes, which is an ordinary
> post-checkpoint state. Your real `~/.metabob/sidecar.db` holds every recorded
> finding. `HOME=/tmp/demo-home` redirects `~/.metabob` wholesale; that is the
> safe form. Copying just the `.db` is **not** safe — the `-wal` and `-shm` files
> matter to the guard.
>
> Seed the throwaway home from a copy first:
> ```bash
> mkdir -p /tmp/demo-home/.metabob
> cp ~/.metabob/sidecar.db* /tmp/demo-home/.metabob/ 2>/dev/null
> cp ~/.metabob/config.json /tmp/demo-home/.metabob/
> ```

If that feels too sharp for a recording, the safe substitute is one process:
`get_problems` → `mark_complete` → `get_problems`, and point at the finding
moving into the `[FIXED]` section.

---

## Beat 3 — "Two agents, one repo, no collisions" (~60s)

**Story:** the briefs live in the ledger; the agents get IDs only.

Use **two** agents, not five. Five terminals is noise; two is legible.

1. On screen, show the two prompts. They contain a tranche ID and one line of
   title — **no file names, no scope.** This is the point of the beat and the
   camera has to see it.
2. Each agent calls `get_problems`, recalls its own brief — which files it owns,
   what is out of bounds, the test bar.
3. Both edit concurrently.
4. `git diff --stat` → disjoint files. `bun test tests` → green.

**Say:** *"The boundary that kept them apart was in the ledger, not in the
prompt. Copy the brief into both prompts instead and you have coupled them to an
orchestrator that has to stay alive."*

**Do not say** that the queue arbitrated this. It did not: ownership was stated
in the brief. Claiming is advisory — see below.

---

## Not on camera

| Excluded | Why |
|---|---|
| `pull_assigned_work` / `submit_resolution` | Claiming is advisory — three agents pulled the same five tasks and three answered the same four. And `submit_resolution` marks `delivered=1` on its terminal-**failure** branch. Filming these films two open findings. Fix first. |
| `search_codebase` | Loses to `grep`; returned false positives from 2-character token matching and a fabricated cache tag. |
| The goal plane (`run_goal*`, `goal_status`, …) | Never evaluated. Untested on camera is a liability. |
| Any "understands your code" framing | Falsified three times. |

---

## Beats by audience

**Agent-builders (primary).** Beats 1 and 3. Single mechanism each, under a
minute, and both true. "Kill the agent, keep the work" is the one people repeat.

**Engineering leadership.** The session arc, with public artifacts: an audit
producing 58 findings → agents recalling briefs from the ledger → four PRs merged
in a day (#3–#6) → a ledger that accurately shows the 38 that remain. The
argument is not that the tool found the bugs; it is that the *work stayed
organised across dozens of agents and several sessions*.

**Skeptical developers — and lead the written version here.** The three negatives.
`grep` beat it on investigation; planted "unrediscoverable" facts turned out to
be greppable because the session that found them also documented them; a
measurement recorded only in the ledger changed nobody's design. Then: here is
the narrow thing that survived. This inoculates against the viewer who replays
the demo with `grep`, and it is the framing `COORDINATION-DEMONSTRATION.md`
already uses.

---

## The one-sentence version

**Use it when there is more than one agent, or more than one session. Below that,
the ledger costs more than it saves.**
