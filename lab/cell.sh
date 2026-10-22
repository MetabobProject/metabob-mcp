#!/usr/bin/env bash
# cell.sh: the agent cell (lab/cell/): one ledger task worked by a headless harness with the MCP, in a container on the
# lab network that mounts nothing and holds no git credential. See lab/README.md, "Agent cell".
#
#   ./cell.sh build [<rev>]        build metabob-agent-cell from `git archive <rev>` (default HEAD): committed source only
#   ./cell.sh run --origin <url> [--fixture <dir>] [--skip-harness] [--discovery <url>]
#                                  create one cell, copy the fixture in, start it attached, copy /out to
#                                  results/<cell>/, remove the container. Refuses while another cell exists
#   ./cell.sh clean                remove every container labelled pilot-cell (this script's own label)
#
#   env: CELL_LABEL (network-fork), CELL_CPUS (2), CELL_MEM (4g), CELL_NETWORK (metabob-lab), LAB_KEYS_DIR (lab/keys),
#        CELL_MODEL, CELL_WALL_S, CELL_BUDGET_USD, CELL_CLAIM_MINUTES (passed to the cell; see cell/entrypoint.sh),
#        METABOB_EDIT_CHECK=off (passed through)
#
# Keys: the cell's env file holds METABOB_API_KEY (keys/mcp-rw.key) and ANTHROPIC_API_KEY (from the environment, else
# the substrate installer's providers.anthropic.apiKey). It is written 0600 in a private temp directory, read once by
# `create`, and deleted; neither key is printed or written anywhere else.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
LAB_DIR="$PWD"
REPO_ROOT="$(cd .. && pwd)"
IMAGE=metabob-agent-cell
LABEL="${CELL_LABEL:-network-fork}"
KEYS="${LAB_KEYS_DIR:-$LAB_DIR/keys}"
NETWORK="${CELL_NETWORK:-metabob-lab}"
if command -v podman >/dev/null 2>&1; then ENG=podman; else ENG=docker; fi
log() { echo "[cell] $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }
# Temp directories (the build context; the env file's directory) are removed on exit, whatever the outcome.
BUILD_CTX="" ENV_DIR=""
trap 'rm -rf "$BUILD_CTX" "$ENV_DIR"' EXIT

cmd_build() {
  local rev="${1:-HEAD}" sha ctx
  sha="$(git -C "$REPO_ROOT" rev-parse --verify "$rev^{commit}")" || fail "build: no commit $rev"
  BUILD_CTX="$(mktemp -d)"; ctx="$BUILD_CTX"
  mkdir -p "$ctx/src"
  git -C "$REPO_ROOT" archive "$sha" | tar -x -C "$ctx/src"
  # git archive leaves submodules empty: add each at the commit $sha pins (vendor/cpg-inference).
  local mode type sub path
  while read -r mode type sub path; do
    [ "$type" = commit ] || continue
    git -C "$REPO_ROOT/$path" cat-file -e "$sub^{commit}" 2>/dev/null || fail "build: submodule $path lacks $sub (git submodule update)"
    git -C "$REPO_ROOT/$path" archive "$sub" | tar -x -C "$ctx/src/$path"
  done < <(git -C "$REPO_ROOT" ls-tree -r "$sha")
  echo "$sha" > "$ctx/src/REVISION"
  cp cell/Containerfile cell/entrypoint.sh "$ctx/"
  log "building $IMAGE from $sha (committed source only)"
  "$ENG" build -q --build-arg "METABOB_REVISION=$sha" -t "$IMAGE:${sha:0:12}" -t "$IMAGE:latest" -f "$ctx/Containerfile" "$ctx" >/dev/null
  log "built $IMAGE:${sha:0:12}"
}

existing() { "$ENG" ps -a --filter "label=pilot-cell" --format '{{.Names}}'; }

anthropic_key() { # prints the key for the caller to capture; never logged
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then printf '%s' "$ANTHROPIC_API_KEY"; return 0; fi
  CFG="${SUBSTRATE_CONFIG_PATH:-$HOME/.substrate/config.json}" node -e '
    const c = JSON.parse(require("fs").readFileSync(process.env.CFG, "utf8"));
    const k = c && c.providers && c.providers.anthropic && c.providers.anthropic.apiKey;
    if (typeof k !== "string" || !k) process.exit(1);
    process.stdout.write(k);' 2>/dev/null
}

cmd_run() {
  local origin="" fixture="" skip="" discovery="" name tmp out rc
  while [ $# -gt 0 ]; do case "$1" in
    --origin) origin="$2"; shift 2 ;;
    --fixture) fixture="$2"; shift 2 ;;
    --skip-harness) skip=1; shift ;;
    --discovery) discovery="$2"; shift 2 ;;
    *) fail "run: unknown argument $1" ;;
  esac; done
  [ -n "$origin" ] || fail "run: --origin <url> is required"
  [ -z "$fixture" ] || [ -d "$fixture" ] || fail "run: --fixture $fixture is not a directory"
  [ -z "$(existing)" ] || fail "run: a cell exists already ($(existing | paste -sd' ' -)); one at a time (./cell.sh clean)"
  [ -s "$KEYS/mcp-rw.key" ] || fail "run: $KEYS/mcp-rw.key missing (./lab.sh up)"
  discovery="${discovery:-http://$(sed -n 's/^LAB_IP=//p' spoke.env | tail -1):8100}"   # the spoke, inside the lab network
  "$ENG" image exists "$IMAGE:latest" 2>/dev/null || "$ENG" image inspect "$IMAGE:latest" >/dev/null 2>&1 || fail "run: no $IMAGE image (./cell.sh build)"

  name="cell-$(date -u +%Y%m%dT%H%M%SZ)"
  ENV_DIR="$(mktemp -d)"; chmod 700 "$ENV_DIR"; tmp="$ENV_DIR"
  ( umask 077
    printf 'METABOB_API_KEY=%s\n' "$(cat "$KEYS/mcp-rw.key")"
    if [ -z "$skip" ]; then k="$(anthropic_key)" || { echo "no ANTHROPIC_API_KEY" >&2; exit 1; }; printf 'ANTHROPIC_API_KEY=%s\n' "$k"; fi
    printf 'DISCOVERY_ENDPOINT=%s\nCELL_ORIGIN=%s\n' "$discovery" "$origin"
    for v in CELL_MODEL CELL_WALL_S CELL_BUDGET_USD CELL_CLAIM_MINUTES METABOB_EDIT_CHECK; do
      [ -n "${!v:-}" ] && printf '%s=%s\n' "$v" "${!v}"
    done
    [ -n "$skip" ] && echo CELL_SKIP_HARNESS=1
  ) > "$tmp/cell.env" || fail "run: no provider key: set ANTHROPIC_API_KEY, or install one with the substrate installer"

  "$ENG" create --name "$name" --label "pilot-cell=$LABEL" --network "$NETWORK" \
    --cpus "${CELL_CPUS:-2}" --memory "${CELL_MEM:-4g}" --pids-limit 4096 --env-file "$tmp/cell.env" "$IMAGE:latest" >/dev/null
  rm -f "$tmp/cell.env"
  [ -z "$fixture" ] || "$ENG" cp "$fixture/." "$name:/cell/fixture"
  log "$name: origin $origin, discovery $discovery, cpus ${CELL_CPUS:-2}, memory ${CELL_MEM:-4g}, label pilot-cell=$LABEL${fixture:+, fixture $fixture}${skip:+, no harness}"
  rc=0; "$ENG" start -a "$name" >/dev/null || rc=$?
  out="$LAB_DIR/results/$name"; mkdir -p "$out"
  "$ENG" cp "$name:/out/." "$out/" || log "could not copy /out from $name"
  "$ENG" rm -f "$name" >/dev/null
  log "$name exited $rc; bundle: $out"
  [ -s "$out/cell.json" ] && cat "$out/cell.json" >&2
  return "$rc"
}

cmd_clean() {
  local n
  for n in $(existing); do "$ENG" rm -f "$n" >/dev/null && log "removed $n"; done
}

case "${1:-}" in
  build) shift; cmd_build "$@" ;;
  run) shift; cmd_run "$@" ;;
  clean) cmd_clean ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
