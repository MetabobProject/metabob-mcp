# The two-node lab

A private substrate network on one host — a **hub** and a **spoke** — for testing metabob-mcp against a
real substrate: attaching through a spoke, identity on the hub, capability from both nodes. `lab/lab.sh`
brings it up and down in one command each and proves it serves the MCP; the Claude Code session trials
(`tests/claude-sessions/`) drive the same commands before they run.

Both nodes run the substrate image's own launch manifest unmodified: `lab.sh up` writes `manifest.yml`
from the image (`substrate-manifest`) and starts each node as its own compose project with its own env
file (`hub.env`, `spoke.env`). `lab-net.yml` is a compose override that adds one thing, the private lab
network `metabob-lab` (`10.89.77.0/24`) with a fixed address per node (`LAB_IP`), so the spoke joins the
hub at an address that does not depend on the host. The engine is podman when it is installed, docker
otherwise.

## Commands

| command | what it does |
|---|---|
| `lab/lab.sh capacity` | Prints whether this host can hold the lab, with the numbers (§ Capacity), and exits 0 when it fits; starts nothing. Run it before `up` on a shared host |
| `lab/lab.sh up` | First checks the host can hold the lab (§ Capacity), then starts the hub, waits for `seeded`, issues the spoke's join key from the hub, starts the spoke, waits for `served` on both nodes makes sure the spoke's workspace (`WORKSPACE_ROOT`, where local-tools runs commands) exists — creating it after a short grace period, since the light lab masks the unit that clones it — and issues the test keys. Asks the registry for a tag on every `up`, since a local copy of a mutable tag can be any age (a pull of an unchanged tag moves no layers); a digest (`name@sha256:…`) is pulled only when missing. It logs the image's revision, and `check` logs the revision the running nodes use. When both nodes are already running and healthy with their keys present, it says so and returns at once; after a partial failure it picks up where the lab stands |
| `lab/lab.sh check` | Proves the lab serves the MCP: writes a temporary MCP config (mode 0600, in a temporary directory removed on exit) from `keys/mcp-rw.key`, the spoke's discovery and the hub's identity; runs `metabob-mcp attach --check` with the repository's `dist/cli.js` (built first when it is missing or older than `src/`); then, through the MCP over stdio (`lab/check-goal.ts`), dispatches the LLM-free goal *How many vessels are currently registered in the discovery registry?* with `run_goal_async` and polls `goal_status` until `reached: yes`. Prints one verdict line; exits nonzero on any failure, and `3` when goal-host's spend-rate policy refuses the identical check goal (attach verified, the reach not re-proven), so a gate keyed on the exit code never passes a reach it did not see. `check --attach-only` stops after `attach --check` |
| `lab/lab.sh cycle` | `destroy`, `up`, `check`: the from-scratch proof |
| `lab/lab.sh status` | Each node's `substrate-status` verdict at the `live`, `seeded` and `served` levels |
| `lab/lab.sh keys` | Reissues `mcp-read.key` and `mcp-rw.key` from the running hub |
| `lab/lab.sh down` | Stops and removes both nodes' containers. Volumes and keys stay, so the next `up` reuses the hub's identity and the nodes' state |
| `lab/lab.sh destroy` | Removes both containers, their volumes, the `metabob-lab` network, each node's compose default network (`hub_default`, `spoke_default`), `keys/` and `manifest.yml`, then verifies nothing is left. It works without `manifest.yml`, by the names the env files give |

`-q` / `--quiet` keeps only warnings, failures and verdicts. The engine's own output (podman-compose
banners, pull progress, the commands compose runs) goes to `lab/lab.log`, with any `…API_KEY=`, `…SECRET=` or
`…TOKEN=` value redacted; a failure prints its last lines.

| variable | default | |
|---|---|---|
| `LAB_WAIT_S` | `900` | Limit for each readiness wait in `up` |
| `LAB_CHECK_TIMEOUT_S` | `300` | Limit for `check`'s goal to reach |
| `LAB_LOG` | `lab/lab.log` | Where the engine's output goes |
| `LAB_KEYS_DIR` | `lab/keys` | The key directory. The lab's containers, volumes and network are one per host, so another checkout of the repository (a worktree) points here to share the lab's keys |
| `LAB_PULL` | `1` | `0` keeps a local copy of a tag instead of asking the registry (offline runs) |
| `SUBSTRATE_IMAGE` | `ghcr.io/avigopal/substrate:dev` | The image both nodes run |
| `SUBSTRATE_CONFIG_PATH` | `~/.substrate/config.json` | The installer's config, read for a provider key |

## Provider key

The hub needs a provider key for LLM-backed goals. `up` passes through whichever provider key is in the
environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`,
`MISTRAL_API_KEY`, `GOOGLE_API_KEY`, `CHUTES_API_KEY`). With none set, it reads the substrate installer's
stored key, `providers.<name>.apiKey` in `~/.substrate/config.json` (or `SUBSTRATE_CONFIG_PATH`), into its
own environment under the matching name (`anthropic` → `ANTHROPIC_API_KEY`). The log names the variable
and its source, never the value; the key is written nowhere by the lab, and the image keeps it in the
hub's volume. With neither, `up` exits 2 and says how to provide one. A key without quota is enough
for the lab: readiness is `served` on both nodes, and `check`'s goal needs no model. The hub's `usable`
verdict needs a real LLM completion, so `up` does not wait for it.

## Light lab

Each node runs only what metabob-mcp touches, plus the infrastructure their readiness needs. The selection
lives in the node's env file: the hub runs `PROFILE=hub-minimal` (no autonomy or compute; goals run on the
spoke) with `DISABLED_VESSELS` masking the rest, keeping surrealdb, valkey, identity, activity-api,
discovery, concept-db, llm-resolver, the seeders, `substrate-ready` and self-recovery. The spoke keeps
discovery, goal-host, local-tools (the deterministic `shellResult` satisfier `check` relies on), the
seeders, `substrate-ready` and self-recovery. The image's own inventory step masks the units at boot, so the
manifest stays unmodified, and `live`/`served` judge only the selected units. Masked timers and services
include `substrate-pull-sync`, so the lab runs the code baked into the image that `up` pulls; with
`git-push-setup` masked, `status` reports per-vessel revisions as unknown, and the spoke's `WORKSPACE_ROOT` is the empty directory `up` creates rather than a super-repo clone: goals that read or edit the super-repo (`feature_compose`, file counts) fail or answer about an empty tree on this lab.

## Capacity

Each node is capped from creation, boot included, by `lab-net.yml`: `LAB_CPUS` (default `2`) CPUs and
`LAB_MEM` (default `6g`) of memory, with no swap beyond it. Before starting any node, `up` checks the host:
the nodes it would start, at `LAB_MEM` each, plus a headroom must fit in the host's available memory, and
the 1- and 5-minute load must be under `LAB_MAX_LOAD` (default `10`), and less than `LAB_MAX_SWAP_PCT` (default `50`) percent of swap may be in use: a host already swapping heavily is under pressure however much memory reads as available. Available memory is a snapshot, so the
headroom is what the host's other containers can still grow into: each capped co-tenant's limit minus its
use, plus, when any co-tenant has no memory limit, one reserve for all of them together, `LAB_UNBOUNDED_RESERVE_MB` (default `8192`) or half the largest one's current use if that is more, and never less
than `LAB_HEADROOM_MB` (default `2048`). Otherwise it
refuses and says why; on a host with no swap the reason says so, since the kernel would kill a process to
make room, most likely the largest, which on a fleet host is its live substrate. Lower the caps, free the
host, or run the lab elsewhere; `LAB_FORCE=1` overrides the check and logs that it did. With swap capped at the memory limit,
a node that needs more than `LAB_MEM` is killed inside its own container rather than pushing the host: an
out-of-memory kill in a node means the lab is too small, not broken.

## Host view

| | URL | |
|---|---|---|
| spoke discovery | `http://127.0.0.1:25100` | The anchor: attach the MCP here |
| hub discovery | `http://127.0.0.1:24100` | |
| hub identity | `http://127.0.0.1:24101` | Pass it as `identityEndpoint`: the spoke's `/bootstrap` advertises the hub's lab-network address (`10.89.77.10:8101`), which the host cannot dial |

Host ports bind `127.0.0.1` only (`SUBSTRATE_PUBLISH_IP`); the nodes talk to each other on the lab
network. An MCP config for the lab is
`{ "metabob": { "apiKey": "<keys/mcp-rw.key>", "discoveryEndpoint": "http://127.0.0.1:25100", "identityEndpoint": "http://127.0.0.1:24101" } }`.

## Keys

`keys/` (mode 0700, every file 0600, ignored by git) holds keys the hub issues with `substrate-key issue`:
`lab-spoke.key` (the spoke's join key, read+write), `mcp-read.key` (read) and `mcp-rw.key` (read+write,
what `check` and the trials use). `lab.sh` never prints a key: it reads one only into the environment or
a 0600 file. When `up` finds no hub volume, the hub starts with a new identity, so `up` removes keys an
earlier hub issued before it issues new ones. A key `check` reports as rejected was issued by an earlier
hub: `lab.sh keys` replaces it.

## Trials

`bun tests/claude-sessions/run.ts --target lab` runs the Claude Code session scenarios against this lab
with no environment: the target defaults to the spoke's discovery, the hub's identity, `keys/mcp-rw.key`
and the nodes `hub,spoke` (`LAB_DISCOVERY`, `LAB_IDENTITY`, `LAB_KEY_FILE`, `LAB_NODES` point it at a
different lab, and then the lifecycle does not apply). Before any scenario, the runner drives the
lifecycle with `--lab-lifecycle`:

| mode | before the scenarios | after |
|---|---|---|
| `reuse` (default) | `check`; when it fails, `up`, then `check` | the lab keeps running |
| `fresh` | `destroy`, `up`, `check` | `down`: the volumes stay, so the next `up` is faster |
| `keep` | as `reuse` | the lab keeps running |

Each step's duration and verdict goes into the run's JSON report under `lab`, with the teardown. A failed
step fails the run before any scenario starts, with the line `LAB LIFECYCLE FAILED at lab.sh <step>`,
distinct from a scenario failure.

CI does not run the lab (no rootless container fleet, and the image pull is slow); `tests/unit/lab-tooling.test.ts`
holds the tooling to its contract instead: the script parses and handles every documented subcommand,
`lab-net.yml` and the env files agree, `.gitignore` covers the keys, and the script prints no key.

## Agent cell

`lab/cell.sh` runs one ledger task in a container on the lab network: `task pull` claims it, a headless harness
works it with the MCP, the cell commits with a `Fixes-Finding:` trailer, and it leaves a result bundle. The
cell mounts nothing and holds no git credential, so it never pushes; its work is judged outside it.

```bash
./cell.sh build [<rev>]                               # metabob-agent-cell from git archive <rev> (default HEAD)
./cell.sh run --origin <url> [--fixture <dir>]        # one cell, attached; the bundle lands in results/<cell>/
./cell.sh clean                                       # remove every container labelled pilot-cell
./cell/smoke.sh                                       # the recipe end to end, with no lab and no model
```

**The image** (`lab/cell/Containerfile`) is built from `git archive` of a metabob-mcp commit and its submodules,
recipe included, so it holds that commit's source and recipe only, recorded as its `org.opencontainers.image.revision`. It has git, bun, the
MCP built as the npm package is, and Claude Code at a pinned version, which speaks the Anthropic provider
key natively. The plugin is installed as users have it (the skills and the edit check) without its
`.mcp.json`; the cell's own MCP config starts the built server under the name the edit check matches. It
runs as the non-root user `cell`.

**What goes in.** The env file holds `METABOB_API_KEY` (`keys/mcp-rw.key`), `ANTHROPIC_API_KEY` (from the
environment, else the installer's `providers.anthropic.apiKey`), `DISCOVERY_ENDPOINT` (the spoke's address
inside the lab network) and `CELL_ORIGIN`, plus any `CELL_*` cap that is set. It is written 0600 in a
private temp directory, read once by `create` and deleted. A fixture directory, laid out as in the
repository, is copied into the created container (`podman cp`); nothing is mounted. The container is
labelled `pilot-cell=<CELL_LABEL>`, capped by `CELL_CPUS` and `CELL_MEM`, and `run` refuses while another
cell exists. `metabob-lab` is a bridge network with outbound NAT, so the cell reaches any host: the provider
API and the origin, and anywhere else. `run` records the network's driver and flags in `cell.json` (`egress`).

**The entrypoint** (`lab/cell/entrypoint.sh`):
1. `task pull` with a claim of `CELL_CLAIM_MINUTES` (45), under the cell's one identity: `VESSEL_ID` is
   `CELL_VESSEL_ID`, else `metabob-cell-<container hostname>`, and the harness's MCP server gets the same, so the
   agent reads the claim as its own. Any non-zero exit ends the cell with that code (1 a failure, 2 not attached or a
   missing input, 3 no open task, 4 tasks held by others or a claim not settled).
2. A `pin: <40-hex sha>` line in the task's details makes `/work` a one-commit fetch of that commit, so history
   after it (a reference fix) is not in the clone. The fixture, when given, is committed onto it, and the base
   is that commit, so the diff is the work alone.
3. The harness: `claude -p` in `/work` with `CELL_MODEL` (`claude-sonnet-5`), `--max-budget-usd CELL_BUDGET_USD`
   (5) and a wall time of `CELL_WALL_S` (1800), web tools disallowed. The MCP reads its key from a private
   0600 file, and the harness's environment does not carry it.
4. Changes the harness left uncommitted are committed with the trailer; commits without one get it in an empty
   commit. `cell.json` says which. The push URL is disabled, and a push attempt is recorded as refused.
5. `/out`: `task.json`, `context.md`, `task-pull.json`, `diff.patch`, `names.txt` (what the V1 scorer reads),
   `commits.txt`, `transcript.jsonl`, `calls.jsonl` (`METABOB_CALL_LOG`) and `cell.json`. `cell.json` holds
   the origin, model, harness and MCP revisions, edit check, caps, base, pin, fixture, every exit code, cost
   and turns, how the commit was made, the push probe, the number of commits in the clone and, with a pin, how many it holds beyond the
   pin, the fixture's and the work's (`clone_beyond_base`: above 0, the clone fetched more), and how often the
   transcript fetches git. Before the cell exits, any key value in `/out` is redacted and the files counted
   (`secret_files_redacted`).

`run` copies `/out` to `results/<cell>/` (ignored by git) and removes the container.

## Time and cost

The first `up` takes several minutes: the image pull, then the waits for `seeded` and `served`,
each bounded by `LAB_WAIT_S`. `up` against a healthy lab returns in about a second. `down` takes seconds,
and `up` after `down` skips the pull and reuses the volumes. `check` takes the time of one `attach --check`
plus one goal walk, bounded by `LAB_CHECK_TIMEOUT_S`. The lab makes no model calls of its own; the session trials are billed model runs (`tests/claude-sessions/README.md`).
