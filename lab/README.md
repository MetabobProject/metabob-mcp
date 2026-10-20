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
| `lab/lab.sh up` | Starts the hub, waits for `seeded`, issues the spoke's join key from the hub, starts the spoke, waits for `served` on both nodes makes sure the spoke's workspace (`WORKSPACE_ROOT`, where local-tools runs commands) exists — creating it after a short grace period, since the light lab masks the unit that clones it — and issues the test keys. Asks the registry for a tag on every `up`, since a local copy of a mutable tag can be any age (a pull of an unchanged tag moves no layers); a digest (`name@sha256:…`) is pulled only when missing. It logs the image's revision, and `check` logs the revision the running nodes use. When both nodes are already running and healthy with their keys present, it says so and returns at once; after a partial failure it picks up where the lab stands |
| `lab/lab.sh check` | Proves the lab serves the MCP: writes a temporary MCP config (mode 0600, in a temporary directory removed on exit) from `keys/mcp-rw.key`, the spoke's discovery and the hub's identity; runs `metabob-mcp attach --check` with the repository's `dist/cli.js` (built first when it is missing or older than `src/`); then, through the MCP over stdio (`lab/check-goal.ts`), dispatches the LLM-free goal *How many vessels are currently registered in the discovery registry?* with `run_goal_async` and polls `goal_status` until `reached: yes`. Prints one verdict line; exits nonzero on any failure |
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
`git-push-setup` masked, `status` reports per-vessel revisions as unknown.

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

## Time and cost

The first `up` takes several minutes: the image pull, then the waits for `seeded` and `served`,
each bounded by `LAB_WAIT_S`. `up` against a healthy lab returns in about a second. `down` takes seconds,
and `up` after `down` skips the pull and reuses the volumes. `check` takes the time of one `attach --check`
plus one goal walk, bounded by `LAB_CHECK_TIMEOUT_S`. The lab makes no model calls of its own; the session trials are billed model runs (`tests/claude-sessions/README.md`).
