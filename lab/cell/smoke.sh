#!/usr/bin/env bash
# smoke.sh: the cell recipe end to end with no lab and no model (lab/README.md, "Agent cell"). The real entrypoint runs in
# the real image, with no network; `task pull` and the harness are stubbed by scripts first on PATH:
#   - an origin whose main has a "fix" commit after the pinned base: the clone must hold the base alone;
#   - a fixture committed onto the base, kept out of the diff;
#   - a harness that edits and does not commit: the cell commits with the trailer;
#   - the harness sees no METABOB_API_KEY; a key the stubs print is redacted from the bundle;
#   - a push is refused.
# Exit 0 when every check holds. Needs `./cell.sh build` first.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if command -v podman >/dev/null 2>&1; then ENG=podman; else ENG=docker; fi
T="$(mktemp -d)"; trap 'rm -rf "$T"; "$ENG" rm -f cell-smoke >/dev/null 2>&1 || true' EXIT
g() { git -C "$1" -c user.name=s -c user.email=s@example.invalid "${@:2}"; }

# The origin: base, then a fix on main the cell must not see.
git init -q -b main "$T/src"
mkdir -p "$T/src/lib"; echo 'export const f = () => 1;' > "$T/src/lib/f.ts"; g "$T/src" add -A; g "$T/src" commit -qm base
PIN="$(g "$T/src" rev-parse HEAD)"
echo 'export const f = () => 2; // the reference fix' > "$T/src/lib/f.ts"; g "$T/src" commit -qam "the fix"
FIX="$(g "$T/src" rev-parse HEAD)"
git clone -q --bare "$T/src" "$T/smoke/origin.git"

cat > "$T/smoke/task.json" <<EOF
{ "task_id": "agf_smoke", "details": "make f return 2\npin: $PIN\npush_to: task\nintegrate: review", "base": "$FIX" }
EOF
echo "# smoke task" > "$T/smoke/context.md"
mkdir -p "$T/fixture/test"; echo 'test("f is 2", () => {});' > "$T/fixture/test/f.test.ts"

mkdir -p "$T/bin"
cat > "$T/bin/node" <<'EOF'
#!/bin/bash
# task pull, stubbed: what the real one leaves behind (task.json, context.md, a full clone).
if [ "${2:-}" = task ] && [ "${3:-}" = pull ]; then
  while [ $# -gt 0 ]; do case "$1" in --task-dir) td="$2"; shift ;; --work-dir) wd="$2"; shift ;; esac; shift; done
  git config --global safe.directory '*'
  mkdir -p "$td"; cp /cell/smoke/task.json /cell/smoke/context.md "$td/"
  git clone -q "$CELL_ORIGIN" "$wd" || exit 1
  echo "stub task pull; a leaked key for the scan: $(sed -n 's/.*"apiKey":"\([^"]*\)".*/\1/p' "$METABOB_CONFIG_PATH")" >&2
  echo '{"code":0}'; exit 0
fi
exec /usr/local/bin/node "$@"
EOF
cat > "$T/bin/claude" <<'EOF'
#!/bin/bash
# The harness, stubbed: edits without committing, says whether it can see the MCP key, prints the provider key.
[ "${1:-}" = --version ] && { echo "0.0.0 (stub)"; exit 0; }
echo 'export const f = () => 2;' > lib/f.ts
echo "{\"type\":\"system\",\"mcp_key_in_env\":\"${METABOB_API_KEY:+yes}\",\"leak\":\"$ANTHROPIC_API_KEY\"}"
echo '{"type":"result","subtype":"success","total_cost_usd":0.01,"num_turns":1}'
EOF
chmod 755 "$T/bin/node" "$T/bin/claude"

# Made-up key values: the bundle scan must find and redact them.
FAKE_MCP_KEY=smoke-mcp-key-0123456789            # gitleaks:allow
FAKE_PROVIDER_KEY=smoke-provider-key-0123456789  # gitleaks:allow
"$ENG" create --name cell-smoke --network none \
  -e METABOB_API_KEY="$FAKE_MCP_KEY" -e ANTHROPIC_API_KEY="$FAKE_PROVIDER_KEY" \
  -e DISCOVERY_ENDPOINT=http://discovery.invalid:8100 -e CELL_ORIGIN=file:///cell/smoke/origin.git \
  -e PATH=/cell/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin metabob-agent-cell:latest >/dev/null
"$ENG" cp "$T/smoke" cell-smoke:/cell/smoke
"$ENG" cp "$T/bin" cell-smoke:/cell/bin
"$ENG" cp "$T/fixture" cell-smoke:/cell/fixture
rc=0; "$ENG" start -a cell-smoke >"$T/run.log" 2>&1 || rc=$?
mkdir -p "$T/out"; "$ENG" cp cell-smoke:/out/. "$T/out/"

fails=0
check() { if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1"; fails=$((fails + 1)); fi; }
j() { jq -r "$1" "$T/out/cell.json"; }
check "the cell exits 0"                          '[ "$rc" = 0 ]'
check "the base is the pin plus the fixture"      '[ "$(j .pin)" = "$PIN" ] && [ "$(j .fixture)" = test/f.test.ts ]'
check "the reference fix is not in the clone"     '[ "$(j .clone_commits)" = 3 ] && ! grep -q "$FIX" "$T/out/commits.txt" && [ "$(j .task_pull_base)" = "$FIX" ]'
check "the diff is the harness edit alone"        '[ "$(cat "$T/out/names.txt")" = lib/f.ts ]'
check "the cell committed with the trailer"       'grep -q "^Fixes-Finding: agf_smoke$" "$T/out/commits.txt" && [ "$(j .commit)" = "cell committed the harness'"'"'s uncommitted changes" ]'
check "a push is refused"                         '[ "$(j .push_probe)" = refused ]'
check "the harness has no METABOB_API_KEY"        'grep -q "\"mcp_key_in_env\":\"\"" "$T/out/transcript.jsonl"'
check "no key value is in the bundle"             '! grep -rqF -e "$FAKE_MCP_KEY" -e "$FAKE_PROVIDER_KEY" "$T/out"'
check "both leaks were found and redacted"        '[ "$(j .secret_files_redacted)" = 2 ]'
check "cost and turns are read from the result"   '[ "$(j .cost_usd)" = 0.01 ] && [ "$(j .turns)" = 1 ]'
check "the bundle has every file"                 '( for f in task.json context.md diff.patch names.txt commits.txt transcript.jsonl calls.jsonl cell.json; do [ -e "$T/out/$f" ] || exit 1; done )'
[ "$fails" = 0 ] || { echo "--- run log"; cat "$T/run.log"; echo "--- cell.json"; cat "$T/out/cell.json"; }
echo "smoke: $fails failure(s)"
exit "$([ "$fails" = 0 ] && echo 0 || echo 1)"
