#!/usr/bin/env bash
# lab.sh: a two-node substrate network (hub + spoke) for metabob-mcp network and functionality testing.
#
#   ANTHROPIC_API_KEY=… ./lab.sh up   pull the current image, write its launch manifest, start the hub, issue the
#                                     spoke's join key from the hub, start the spoke, issue the test keys
#   ./lab.sh status                   each node's substrate-status verdict (live/seeded/served)
#   ./lab.sh keys                     (re)issue the test keys into keys/ (0600, never printed)
#   ./lab.sh down                     stop both nodes (volumes kept)
#   ./lab.sh destroy                  stop both nodes and DELETE their volumes and keys
#
# Both nodes run the substrate image's OWN launch manifest unmodified (manifest.yml, regenerated from the image on every
# `up`), each as its own compose project with its own env file. lab-net.yml only adds the private lab network with fixed
# addresses, so the spoke joins the hub without any host-specific address. Any provider key the manifest knows
# (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, …) is passed through from your environment to the hub only and
# never written here; the image persists it in the hub's own volume.
#
# Host view (what the MCP uses):
#   spoke discovery  http://127.0.0.1:25100      (the anchor: attach the MCP here)
#   hub discovery    http://127.0.0.1:24100
#   hub identity     http://127.0.0.1:24101      (the spoke has no identity of its own; it uses the hub's)
# keys/: lab-spoke.key (the spoke's join key), mcp-read.key, mcp-rw.key (hub-issued), mcp-foreign.key (a key from a
# different identity namespace: a throwaway standalone-issued key is not available, so it is left to the operator).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
IMAGE="${SUBSTRATE_IMAGE:-ghcr.io/avigopal/substrate:dev}"
NET=metabob-lab; SUBNET=10.89.77.0/24
if command -v podman >/dev/null 2>&1; then ENG=podman; else ENG=docker; fi
compose() { "$ENG" compose "$@"; }
node() { compose -p "$1" --env-file "$1.env" -f manifest.yml -f lab-net.yml "${@:2}"; }   # $1 = hub|spoke
c() { echo "lab-$1-live"; }
log() { echo "[lab] $*" >&2; }
wait_level() { # $1 node $2 level $3 timeout_s
  "$ENG" exec "$(c "$1")" substrate-status --wait "$2" --timeout "${3:-900}" >/dev/null 2>&1 \
    || { log "lab-$1 did not reach '$2'; see: $ENG exec $(c "$1") substrate-status"; return 1; }
  log "lab-$1 reached '$2'"
}
issue_key() { # $1 name $2 scopes $3 file: issued by the hub, written 0600, never printed
  ( umask 077; "$ENG" exec "$(c hub)" substrate-key issue "$1" "$2" > "keys/$3.tmp" 2>/dev/null ) \
    && [ -s "keys/$3.tmp" ] && mv -f "keys/$3.tmp" "keys/$3" && log "issued $1 [$2] -> keys/$3" \
    || { rm -f "keys/$3.tmp"; log "could not issue $1"; return 1; }
}
provider_set() { env | grep -qE '^(ANTHROPIC|OPENAI|OPENROUTER|GROQ|MISTRAL|GOOGLE|CHUTES)_API_KEY=.' ; }

case "${1:-}" in
  up)
    provider_set || { log "set a provider key in your environment (e.g. ANTHROPIC_API_KEY=… ./lab.sh up); the hub needs one to reach 'usable'"; exit 2; }
    mkdir -p keys; chmod 700 keys
    log "pulling $IMAGE"; "$ENG" pull -q "$IMAGE" >/dev/null
    "$ENG" run --rm --entrypoint substrate-manifest "$IMAGE" > manifest.yml.new && mv -f manifest.yml.new manifest.yml
    log "manifest.yml written from the image ($(sha256sum manifest.yml | cut -c1-12))"
    "$ENG" network exists "$NET" 2>/dev/null || "$ENG" network inspect "$NET" >/dev/null 2>&1 \
      || { "$ENG" network create --subnet "$SUBNET" "$NET" >/dev/null && log "created network $NET ($SUBNET)"; }
    SUBSTRATE_IMAGE="$IMAGE" node hub up -d
    wait_level hub seeded 900
    [ -s keys/lab-spoke.key ] || issue_key lab-spoke read,write lab-spoke.key
    METABOB_API_KEY="$(cat keys/lab-spoke.key)" SUBSTRATE_IMAGE="$IMAGE" node spoke up -d
    wait_level spoke served 900 || true
    wait_level hub usable 900 || true
    [ -s keys/mcp-read.key ] || issue_key mcp-read read mcp-read.key || true
    [ -s keys/mcp-rw.key ]   || issue_key mcp-rw read,write mcp-rw.key || true
    log "up. Anchor for the MCP: http://127.0.0.1:25100 (hub identity http://127.0.0.1:24101). Verdicts: ./lab.sh status"
    ;;
  keys)
    mkdir -p keys; chmod 700 keys
    issue_key mcp-read read mcp-read.key; issue_key mcp-rw read,write mcp-rw.key ;;
  status)
    for n in hub spoke; do echo "== lab-$n"; "$ENG" exec "$(c "$n")" substrate-status --level served 2>&1 | grep -E '^substrate-status|^  (live|seeded|served) ' || echo "  not running"; done ;;
  down)
    for n in spoke hub; do node "$n" down || true; done ;;
  destroy)
    for n in spoke hub; do node "$n" down -v || true; done
    rm -rf keys manifest.yml; "$ENG" network rm "$NET" >/dev/null 2>&1 || true; log "destroyed (volumes, keys, network)" ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
