#!/usr/bin/env bash
# lab.sh: a two-node substrate network (hub + spoke) for metabob-mcp network and functionality testing.
#
#   ./lab.sh up        bring both nodes up: pull the image when it is not local, write its launch manifest, start the
#                      hub, issue the spoke's join key from the hub, start the spoke, issue the test keys. Returns at
#                      once when both nodes are already up and healthy; safe to re-run after a partial failure
#   ./lab.sh check     prove the lab serves the MCP: `attach --check` with keys/mcp-rw.key, then an LLM-free goal
#                      dispatched through the MCP over stdio until it reaches. Exit 0 = the lab serves
#   ./lab.sh cycle     destroy, up, check: the from-scratch proof
#   ./lab.sh status    each node's substrate-status verdict (live/seeded/served)
#   ./lab.sh keys      (re)issue the test keys into keys/ (0600, never printed)
#   ./lab.sh down      stop both nodes (volumes and keys kept, so the next `up` is fast)
#   ./lab.sh destroy   stop both nodes and remove their containers, volumes, the lab network, keys/ and manifest.yml
#
#   options: -q|--quiet (only warnings, failures and verdicts)
#   env:     LAB_WAIT_S (900) per readiness wait; LAB_CHECK_TIMEOUT_S (300) for check's goal; LAB_LOG (lab/lab.log)
#            receives the engine's own output; LAB_KEYS_DIR (lab/keys); LAB_PULL=0 keeps a local copy of a tag
#            instead of asking the registry (a digest, name@sha256:…, is pulled only when missing); SUBSTRATE_IMAGE
#
# Both nodes run the substrate image's OWN launch manifest unmodified (manifest.yml, regenerated from the image on every
# `up` that starts a node), each as its own compose project with its own env file. lab-net.yml only adds the private lab
# network with fixed addresses, so the spoke joins the hub without any host-specific address.
#
# Provider key: `up` passes any provider key the manifest knows (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) through from
# your environment. Without one, it reads the substrate installer's stored key, providers.<name>.apiKey in
# ${SUBSTRATE_CONFIG_PATH:-~/.substrate/config.json}, into its own environment. Either way the key is never printed and
# never written here; the image persists it in the hub's own volume.
#
# Host view (what the MCP uses):
#   spoke discovery  http://127.0.0.1:25100      (the anchor: attach the MCP here)
#   hub discovery    http://127.0.0.1:24100
#   hub identity     http://127.0.0.1:24101      (pass it as identityEndpoint: the spoke's /bootstrap advertises the hub's
#                                                 lab-network address, which the host cannot dial)
# keys/: lab-spoke.key (the spoke's join key), mcp-read.key, mcp-rw.key (hub-issued). See README.md.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
LAB_DIR="$PWD"
REPO_ROOT="$(cd .. && pwd)"
IMAGE="${SUBSTRATE_IMAGE:-ghcr.io/avigopal/substrate:dev}"
NET=metabob-lab; SUBNET=10.89.77.0/24
WAIT_S="${LAB_WAIT_S:-900}"
CHECK_TIMEOUT_S="${LAB_CHECK_TIMEOUT_S:-300}"
LOG="${LAB_LOG:-$LAB_DIR/lab.log}"
KEYS="${LAB_KEYS_DIR:-$LAB_DIR/keys}"   # one lab, one key set: point other checkouts of the repo at it
SPOKE_DISCOVERY=http://127.0.0.1:25100
HUB_IDENTITY=http://127.0.0.1:24101
PROVIDERS="ANTHROPIC OPENAI OPENROUTER GROQ MISTRAL GOOGLE CHUTES"
QUIET=0
args=()
for a in "$@"; do case "$a" in -q|--quiet) QUIET=1 ;; *) args+=("$a") ;; esac; done
set -- "${args[@]+"${args[@]}"}"

if command -v podman >/dev/null 2>&1; then ENG=podman; else ENG=docker; fi
info() { [ "$QUIET" = 1 ] || echo "[lab] $*" >&2; }
log()  { echo "[lab] $*" >&2; }                  # warnings, failures and verdicts: shown even with --quiet
fail() { log "FAIL: $*"; [ -s "$LOG" ] && { log "last lines of $LOG:"; tail -n 15 "$LOG" | sed 's/^/      /' >&2; }; exit 1; }
# The engine's own output (podman-compose banners, the commands it runs) goes to LOG, with any key it echoes redacted.
redact() { sed -E 's/((API_KEY|SECRET|TOKEN)[A-Z_]*=)[^ ,]+/\1<redacted>/g' >>"$LOG"; }
quietly() { { echo "+ $*"; "$@" 2>&1; } | redact; }   # pipefail: the command's status
env_get() { sed -n "s/^$2=//p" "$1.env" | tail -n 1; }   # $1 hub|spoke $2 variable
c() { echo "$(env_get "$1" SUBSTRATE_NAME)-live"; }
compose_node() { quietly "$ENG" compose -p "$1" --env-file "$1.env" -f manifest.yml -f lab-net.yml "${@:2}"; }   # $1 hub|spoke
running() { [ "$("$ENG" inspect --format '{{.State.Running}}' "$(c "$1")" 2>/dev/null)" = true ]; }
healthy() { [ "$("$ENG" inspect --format '{{.State.Health.Status}}' "$(c "$1")" 2>/dev/null)" = healthy ]; }
net_exists() { "$ENG" network inspect "$NET" >/dev/null 2>&1; }
keys_present() { [ -s "$KEYS/lab-spoke.key" ] && [ -s "$KEYS/mcp-read.key" ] && [ -s "$KEYS/mcp-rw.key" ]; }
elapsed() { echo "$(( $(date +%s) - $1 ))s"; }

wait_level() { # $1 node $2 level: waits up to LAB_WAIT_S
  local t0; t0=$(date +%s)
  if "$ENG" exec "$(c "$1")" substrate-status --wait "$2" --timeout "$WAIT_S" >>"$LOG" 2>&1; then
    info "lab-$1 reached '$2' ($(elapsed "$t0"))"
  else
    log "lab-$1 did not reach '$2' within ${WAIT_S}s; see: $ENG exec $(c "$1") substrate-status"; return 1
  fi
}
wait_workspace() { # $1 node: waits up to LAB_WAIT_S for the node's WORKSPACE_ROOT to exist
  # `served` does not wait for seeding to create the workspace that local-tools spawns its
  # shell in; a goal dispatched before it exists fails with ENOENT (posix_spawn 'bash').
  local t0; t0=$(date +%s)
  while ! "$ENG" exec "$(c "$1")" sh -c 'd=$(sed -n "s/^WORKSPACE_ROOT=//p" /etc/substrate/env | tr -d "\"'"'"'"); [ -n "$d" ] && [ -d "$d" ]' >/dev/null 2>&1; do
    if [ $(( $(date +%s) - t0 )) -ge "$WAIT_S" ]; then
      log "lab-$1's WORKSPACE_ROOT did not appear within ${WAIT_S}s"; return 1
    fi
    sleep 2
  done
  info "lab-$1 workspace ready ($(elapsed "$t0"))"
}
issue_key() { # $1 name $2 scopes $3 file: issued by the hub, written 0600, never printed
  ( umask 077; "$ENG" exec "$(c hub)" substrate-key issue "$1" "$2" > "$KEYS/$3.tmp" 2>>"$LOG" ) \
    && [ -s "$KEYS/$3.tmp" ] && mv -f "$KEYS/$3.tmp" "$KEYS/$3" && info "issued $1 [$2] -> $KEYS/$3" \
    || { rm -f "$KEYS/$3.tmp"; log "could not issue $1"; return 1; }
}
issue_test_keys() { mkdir -p "$KEYS"; chmod 700 "$KEYS"; issue_key mcp-read read mcp-read.key && issue_key mcp-rw read,write mcp-rw.key; }

provider_set() { local p; for p in $PROVIDERS; do [ -n "$(printenv "${p}_API_KEY" || true)" ] && { echo "${p}_API_KEY"; return 0; }; done; return 1; }
# The installer's stored key: providers.<name>.apiKey in its config. Prints "<name> <key>" for the caller to capture;
# the caller only ever logs the name.
provider_from_config() {
  local cfg="${SUBSTRATE_CONFIG_PATH:-$HOME/.substrate/config.json}"
  [ -r "$cfg" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  CFG="$cfg" KNOWN="$PROVIDERS" node -e '
    const c = JSON.parse(require("fs").readFileSync(process.env.CFG, "utf8"));
    const known = process.env.KNOWN.toLowerCase().split(" ");
    for (const [name, p] of Object.entries((c && c.providers) || {})) {
      if (known.includes(name.toLowerCase()) && p && typeof p.apiKey === "string" && p.apiKey) { console.log(name, p.apiKey); process.exit(0); }
    }
    process.exit(1);' 2>/dev/null
}
ensure_provider() {
  local name
  if name=$(provider_set); then info "provider key: $name from the environment"; return 0; fi
  local cfg="${SUBSTRATE_CONFIG_PATH:-$HOME/.substrate/config.json}" found pname pkey
  if found=$(provider_from_config); then
    pname="${found%% *}"; pkey="${found#* }"
    name="$(echo "$pname" | tr '[:lower:]' '[:upper:]')_API_KEY"
    export "$name=$pkey"; unset found pkey
    info "provider key: $name from the installer's config ($cfg, providers.$pname.apiKey)"; return 0
  fi
  log "set a provider key in your environment (e.g. ANTHROPIC_API_KEY=… ./lab.sh up), or install one with the substrate installer ($cfg); the hub needs one for LLM-backed goals"
  exit 2
}
image_revision() { # $1 image: its OCI revision label, else its id prefix
  local r; r=$("$ENG" image inspect --format '{{ index .Labels "org.opencontainers.image.revision" }}' "$1" 2>/dev/null)
  [ -n "$r" ] && [ "$r" != "<no value>" ] && { echo "$r"; return; }
  "$ENG" image inspect --format '{{.Id}}' "$1" 2>/dev/null | cut -c1-19
}
ensure_manifest() {
  # A tag is mutable: a local copy can be any age, so the registry is asked every time (a pull of an
  # unchanged tag moves no layers). A digest (name@sha256:…) is immutable and is pulled only when
  # missing. LAB_PULL=0 keeps whatever is local, for offline runs.
  local local_copy=0
  "$ENG" image exists "$IMAGE" 2>/dev/null || "$ENG" image inspect "$IMAGE" >/dev/null 2>&1 && local_copy=1
  if [ "$local_copy" = 0 ] || { [ "${LAB_PULL:-1}" != 0 ] && [ "${IMAGE#*@sha256:}" = "$IMAGE" ]; }; then
    info "pulling $IMAGE"; quietly "$ENG" pull "$IMAGE" || fail "could not pull $IMAGE"
  fi
  log "image: $IMAGE revision $(image_revision "$IMAGE")"
  "$ENG" run --rm --entrypoint substrate-manifest "$IMAGE" > manifest.yml.new 2>>"$LOG" && mv -f manifest.yml.new manifest.yml \
    || { rm -f manifest.yml.new; fail "could not write manifest.yml from $IMAGE"; }
  info "manifest.yml written from the image ($(sha256sum manifest.yml | cut -c1-12))"
}

cmd_up() {
  local t0; t0=$(date +%s)
  if running hub && running spoke && healthy hub && healthy spoke && net_exists && keys_present; then
    log "already up: lab-hub and lab-spoke are running and healthy, keys present ($(elapsed "$t0")). Prove it serves: ./lab.sh check"
    return 0
  fi
  ensure_provider
  mkdir -p "$KEYS"; chmod 700 "$KEYS"
  # A hub without its volume is a new identity: keys issued by an earlier hub would be rejected, so they go.
  if ! "$ENG" volume inspect "$(env_get hub SUBSTRATE_NAME)-surreal" >/dev/null 2>&1; then rm -f "$KEYS"/*.key; fi
  ensure_manifest
  net_exists || { quietly "$ENG" network create --subnet "$SUBNET" "$NET" && info "created network $NET ($SUBNET)"; } \
    || fail "could not create network $NET"
  SUBSTRATE_IMAGE="$IMAGE" compose_node hub up -d || fail "could not start lab-hub"
  wait_level hub seeded || fail "lab-hub not seeded"
  [ -s "$KEYS/lab-spoke.key" ] || issue_key lab-spoke read,write lab-spoke.key || fail "could not issue the spoke's join key"
  METABOB_API_KEY="$(cat "$KEYS/lab-spoke.key")" SUBSTRATE_IMAGE="$IMAGE" compose_node spoke up -d || fail "could not start lab-spoke"
  wait_level spoke served || fail "lab-spoke not served"
  wait_workspace spoke || fail "lab-spoke workspace not ready"
  # Not 'usable': that verdict needs a real LLM completion, which a no-quota provider key never gives. 'served'
  # on both nodes is readiness; `lab.sh check` (an LLM-free goal through the MCP) is the functional proof.
  wait_level hub served || fail "lab-hub not served"
  [ -s "$KEYS/mcp-read.key" ] || issue_key mcp-read read mcp-read.key || fail "could not issue mcp-read"
  [ -s "$KEYS/mcp-rw.key" ]   || issue_key mcp-rw read,write mcp-rw.key || fail "could not issue mcp-rw"
  log "up ($(elapsed "$t0")). Anchor for the MCP: $SPOKE_DISCOVERY (hub identity $HUB_IDENTITY). Prove it: ./lab.sh check"
}

cmd_down() {
  local t0 n; t0=$(date +%s)
  for n in spoke hub; do
    if [ -s manifest.yml ]; then compose_node "$n" down || true; fi
    { "$ENG" stop -t 10 "$(c "$n")"; "$ENG" rm -f "$(c "$n")"; } >>"$LOG" 2>&1 || true   # also when manifest.yml is gone
  done
  log "down ($(elapsed "$t0")): both nodes stopped; volumes and keys kept"
}

cmd_destroy() {
  local t0 n name; t0=$(date +%s)
  for n in spoke hub; do
    if [ -s manifest.yml ]; then compose_node "$n" down -v || true; fi
    { "$ENG" stop -t 10 "$(c "$n")"; "$ENG" rm -f "$(c "$n")"; } >>"$LOG" 2>&1 || true
    name="$(env_get "$n" SUBSTRATE_NAME)"
    "$ENG" volume rm -f "$name-workspace" "$name-surreal" >>"$LOG" 2>&1 || true
  done
  # The lab network, and each compose project's own default network (lab-net.yml declares it).
  for n in "$NET" spoke_default hub_default; do "$ENG" network rm "$n" >>"$LOG" 2>&1 || true; done
  rm -rf "$KEYS" manifest.yml manifest.yml.new
  local left=""
  for n in spoke hub; do
    name="$(env_get "$n" SUBSTRATE_NAME)"
    "$ENG" container inspect "$(c "$n")" >/dev/null 2>&1 && left+=" container:$(c "$n")"
    for v in workspace surreal; do "$ENG" volume inspect "$name-$v" >/dev/null 2>&1 && left+=" volume:$name-$v"; done
  done
  for n in "$NET" spoke_default hub_default; do "$ENG" network inspect "$n" >/dev/null 2>&1 && left+=" network:$n"; done
  [ -z "$left" ] || fail "destroy left behind:$left"
  log "destroyed ($(elapsed "$t0")): containers, volumes, network, keys and manifest removed"
}

cmd_check() {
  local t0 cli rc; t0=$(date +%s)
  [ -s "$KEYS/mcp-rw.key" ] || fail "check: $KEYS/mcp-rw.key missing (./lab.sh up, or ./lab.sh keys when the lab is up)"
  command -v node >/dev/null 2>&1 || fail "check: node is required"
  command -v bun >/dev/null 2>&1 || fail "check: bun is required"
  cli="$REPO_ROOT/dist/cli.js"
  if [ ! -f "$cli" ] || [ -n "$(find "$REPO_ROOT/src" -newer "$cli" -print -quit 2>/dev/null)" ]; then
    info "building dist/cli.js (missing or older than src/)"
    ( cd "$REPO_ROOT" && quietly bun run build ) || fail "check: bun run build failed"
  fi
  # Global, not local: the EXIT trap runs after this function returns.
  LAB_CHECK_TMP="$(mktemp -d)"; tmp="$LAB_CHECK_TMP"; trap 'rm -rf "${LAB_CHECK_TMP:-}"' EXIT
  # The MCP config: the key file's contents go into a 0600 file in a 0700 temp dir, removed on exit. Never printed.
  ( umask 077; KEY_FILE="$KEYS/mcp-rw.key" DISC="$SPOKE_DISCOVERY" ID="$HUB_IDENTITY" node -e '
      const fs = require("fs");
      const apiKey = fs.readFileSync(process.env.KEY_FILE, "utf8").trim();
      process.stdout.write(JSON.stringify({ metabob: { apiKey, discoveryEndpoint: process.env.DISC, identityEndpoint: process.env.ID } }));
    ' > "$tmp/config.json" ) || fail "check: could not write the MCP config"
  local rev_hub rev_spoke
  rev_hub=$("$ENG" inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$(c hub)" 2>/dev/null || echo unknown)
  rev_spoke=$("$ENG" inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$(c spoke)" 2>/dev/null || echo unknown)
  log "running image revision: hub ${rev_hub:-unknown}, spoke ${rev_spoke:-unknown}"
  info "attach --check against $SPOKE_DISCOVERY (identity $HUB_IDENTITY)"
  rc=0; HOME="$tmp" METABOB_CONFIG_PATH="$tmp/config.json" METABOB_TELEMETRY=off METABOB_NO_SYSTEM_CA=1 \
    node "$cli" attach --check >"$tmp/attach.out" 2>&1 || rc=$?
  cat "$tmp/attach.out" >>"$LOG"
  if [ "$rc" != 0 ]; then
    [ "$QUIET" = 1 ] || sed 's/^/      /' "$tmp/attach.out" >&2
    grep -qi 'key_rejected\|rejected' "$tmp/attach.out" && log "the key was rejected: the hub may have been recreated since its keys were issued; run ./lab.sh keys"
    fail "check: attach --check exited $rc"
  fi
  info "attach --check: attached"
  if [ "${1:-}" = "--attach-only" ]; then
    log "check: PASS ($(elapsed "$t0")): attached at $SPOKE_DISCOVERY (attach only: no goal dispatched)"
    return 0
  fi
  rc=0; LAB_MCP_CONFIG="$tmp/config.json" LAB_CHECK_TIMEOUT_S="$CHECK_TIMEOUT_S" bun "$LAB_DIR/check-goal.ts" 2>>"$LOG" || rc=$?
  if [ "$rc" = 3 ]; then
    log "check: ATTACHED, goal check THROTTLED ($(elapsed "$t0")): goal-host's spend-rate policy refused the identical check goal this hour; attach is verified, the reach is not re-proven"
    return 0
  fi
  [ "$rc" = 0 ] || fail "check: the goal did not reach through the MCP"
  log "check: PASS ($(elapsed "$t0")): attached at $SPOKE_DISCOVERY, and an LLM-free goal reached through the MCP"
}

: >>"$LOG"
case "${1:-}" in
  up) cmd_up ;;
  check) cmd_check "${2:-}" ;;
  cycle)
    t_all=$(date +%s)
    cmd_destroy; cmd_up; cmd_check
    log "cycle: PASS ($(elapsed "$t_all")): destroyed, brought up from scratch, and serving" ;;
  keys)
    running hub || fail "keys: lab-hub is not running (./lab.sh up)"
    issue_test_keys || fail "keys: could not issue" ;;
  status)
    for n in hub spoke; do echo "== lab-$n"; "$ENG" exec "$(c "$n")" substrate-status --level served 2>&1 | grep -E '^substrate-status|^  (live|seeded|served) ' || echo "  not running"; done ;;
  down) cmd_down ;;
  destroy) cmd_destroy ;;
  *) sed -n '2,18p' "$0"; exit 2 ;;
esac
