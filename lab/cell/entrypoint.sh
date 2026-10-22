#!/usr/bin/env bash
# The agent cell's entrypoint: pull one task from the ledger, work it with a headless harness and the MCP, commit,
# never push, and leave a result bundle in /out. See lab/README.md, "Agent cell".
#
#   1. task pull: claim a `task` finding on CELL_ORIGIN's ledger; /task/task.json, /task/context.md, /work cloned
#   2. base: a `pin: <40-hex sha>` line in the task's details makes /work a one-commit fetch of that commit, so later
#      history (a reference fix) is not in the clone; /cell/fixture, when present, is committed onto it
#   3. the harness in /work, capped by CELL_WALL_S and CELL_BUDGET_USD
#   4. a commit carrying `Fixes-Finding: <task id>`; no push (the cell has no git credential and a disabled push URL)
#   5. /out: task.json, context.md, diff.patch, names.txt, commits.txt, transcript.jsonl, calls.jsonl, cell.json
#
# env (from the 0600 env file): METABOB_API_KEY, ANTHROPIC_API_KEY, DISCOVERY_ENDPOINT, CELL_ORIGIN
#      optional: CELL_MODEL (claude-sonnet-5), CELL_WALL_S (1800), CELL_BUDGET_USD (5), CELL_CLAIM_MINUTES (45),
#                CELL_SKIP_HARNESS=1 (everything but the harness: the recipe's smoke test)
# exit: the harness's code, or task pull's (2 not attached, 3 no open task, 4 tasks held by others)
set -uo pipefail

OUT=/out TASK=/task WORK=/work
MODEL="${CELL_MODEL:-claude-sonnet-5}"
WALL_S="${CELL_WALL_S:-1800}"
BUDGET="${CELL_BUDGET_USD:-5}"
CLAIM_MIN="${CELL_CLAIM_MINUTES:-45}"
MCP=/opt/metabob-mcp/dist/cli.js
PRIVATE="$(mktemp -d)"   # the MCP config with the key: never under /out
chmod 700 "$PRIVATE"
STARTED="$(date -u +%FT%TZ)"
declare -A meta=()
note() { echo "[cell] $*" >&2; }

finish() { # $1 exit code: write cell.json, scan /out for the keys, exit
  local rc="$1" k v hits=0 n
  meta[exit]="$rc"; meta[started]="$STARTED"; meta[ended]="$(date -u +%FT%TZ)"
  { echo '{'; local first=1; for k in "${!meta[@]}"; do
      [ $first = 1 ] || echo ','; first=0; printf '  %s: %s' "$(jq -Rn --arg s "$k" '$s')" "$(jq -Rn --arg s "${meta[$k]}" '$s')"
    done; echo; echo '}'; } > "$OUT/cell.json"
  # No key value leaves in the bundle: redact any occurrence and count it, so the leak is visible, not silent.
  for v in "${METABOB_API_KEY:-}" "${ANTHROPIC_API_KEY:-}"; do
    [ ${#v} -ge 12 ] || continue
    n=$(grep -rlF -- "$v" "$OUT" 2>/dev/null | wc -l)
    if [ "$n" -gt 0 ]; then
      hits=$((hits + n))
      grep -rlF -- "$v" "$OUT" | while read -r f; do V="$v" perl -0pi -e 's/\Q$ENV{V}\E/<redacted>/g' "$f"; done
    fi
  done
  jq --arg h "$hits" '. + {secret_files_redacted: $h}' "$OUT/cell.json" > "$PRIVATE/c.json" && cp "$PRIVATE/c.json" "$OUT/cell.json"
  rm -rf "$PRIVATE"
  note "done: exit $rc (bundle in $OUT; $hits file(s) had a key redacted)"
  exit "$rc"
}

for v in METABOB_API_KEY DISCOVERY_ENDPOINT CELL_ORIGIN; do
  [ -n "${!v:-}" ] || { note "missing $v"; meta[error]="missing $v"; finish 2; }
done
[ -n "${CELL_SKIP_HARNESS:-}" ] || [ -n "${ANTHROPIC_API_KEY:-}" ] || { note "missing ANTHROPIC_API_KEY"; meta[error]="missing ANTHROPIC_API_KEY"; finish 2; }

# No git credential, and nothing that could prompt for one.
export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false
git config --global credential.helper ''
git config --global user.name "metabob agent cell"
git config --global user.email "cell@metabob.invalid"
git config --global init.defaultBranch main

( umask 077; node -e 'process.stdout.write(JSON.stringify({ metabob: { apiKey: process.env.METABOB_API_KEY, discoveryEndpoint: process.env.DISCOVERY_ENDPOINT } }))' > "$PRIVATE/config.json" )
export METABOB_CONFIG_PATH="$PRIVATE/config.json"
unset METABOB_ENDPOINT SUBSTRATE_ENDPOINT
# The MCP and task pull read the key from that file; the harness's environment does not carry it (kept unexported
# here only for the bundle's redaction scan).
export -n METABOB_API_KEY
meta[origin]="$CELL_ORIGIN"; meta[model]="$MODEL"; meta[metabob_revision]="$(cat /opt/metabob-mcp/REVISION 2>/dev/null || echo unknown)"
meta[harness]="claude-code $(claude --version 2>/dev/null | head -1)"; meta[edit_check]="${METABOB_EDIT_CHECK:-on}"
meta[wall_s]="$WALL_S"; meta[budget_usd]="$BUDGET"

# 1. task pull
SESSION_ID="cell-$(cat /proc/sys/kernel/random/uuid)"; export SESSION_ID
node "$MCP" task pull --origin "$CELL_ORIGIN" --task-dir "$TASK" --work-dir "$WORK" --minutes "$CLAIM_MIN" --json > "$OUT/task-pull.json" 2> "$OUT/task-pull.log"
rc=$?
meta[task_pull_exit]="$rc"
[ "$rc" = 0 ] || { note "task pull exited $rc"; finish "$rc"; }
cp "$TASK/task.json" "$TASK/context.md" "$OUT/"
TASK_ID="$(jq -r '.task_id // empty' "$TASK/task.json")"
DETAILS="$(jq -r '.details // ""' "$TASK/task.json")"
[ -n "$TASK_ID" ] || { meta[error]="task.json names no task id"; finish 1; }
meta[task_id]="$TASK_ID"; meta[task_pull_base]="$(jq -r '.base // ""' "$TASK/task.json")"

# 2. base: the pinned commit alone, then the fixture
PIN="$(printf '%s\n' "$DETAILS" | sed -n 's/^pin:[[:space:]]*\([0-9a-f]\{40\}\)[[:space:]]*$/\1/p' | head -1)"
if [ -n "$PIN" ]; then
  find "$WORK" -mindepth 1 -delete
  git -C "$WORK" init -q && git -C "$WORK" remote add origin "$CELL_ORIGIN" \
    && git -C "$WORK" fetch -q --depth 1 origin "$PIN" && git -C "$WORK" checkout -q --detach FETCH_HEAD \
    || { meta[error]="could not fetch pin $PIN"; finish 1; }
  meta[pin]="$PIN"
fi
git -C "$WORK" remote set-url --push origin no-push://the-cell-does-not-push
git -C "$WORK" switch -q -c "task/$TASK_ID" 2>/dev/null || git -C "$WORK" switch -q "task/$TASK_ID"
if [ -d /cell/fixture ] && [ -n "$(ls -A /cell/fixture)" ]; then
  cp -R /cell/fixture/. "$WORK/"
  git -C "$WORK" add -A && git -C "$WORK" commit -q -m "check: the task's check, added before the work" \
    || { meta[error]="could not commit the fixture"; finish 1; }
  meta[fixture]="$(cd /cell/fixture && find . -type f | sed 's|^\./||' | sort | paste -sd, -)"
fi
BASE="$(git -C "$WORK" rev-parse HEAD)"
meta[base]="$BASE"

# 3. the harness
cat > "$PRIVATE/mcp.json" <<EOF
{ "mcpServers": { "metabob": { "command": "node", "args": ["$MCP"],
  "env": { "METABOB_CONFIG_PATH": "$PRIVATE/config.json", "METABOB_CALL_LOG": "$OUT/calls.jsonl", "SESSION_ID": "$SESSION_ID" } } } }
EOF
PROMPT="You are an agent cell working one task from a shared ledger, in this repository (/work).
The task and its context: /task/task.json and /task/context.md. Read them first. The task's finding id is $TASK_ID.
Do the task. Commit your change on this branch with a message whose last line is: Fixes-Finding: $TASK_ID
You cannot push, and nothing outside /work and /task is yours to change."
meta[prompt_sha256]="$(printf '%s' "$PROMPT" | sha256sum | cut -c1-16)"
if [ -n "${CELL_SKIP_HARNESS:-}" ]; then
  note "CELL_SKIP_HARNESS: no harness run"; meta[harness_exit]=skipped; : > "$OUT/transcript.jsonl"
  hrc=0
else
  ( cd "$WORK" && timeout --kill-after=30 "$WALL_S" claude -p "$PROMPT" --model "$MODEL" --output-format stream-json --verbose \
      --max-budget-usd "$BUDGET" --permission-mode bypassPermissions --disallowedTools WebFetch,WebSearch \
      --strict-mcp-config --mcp-config "$PRIVATE/mcp.json" --plugin-dir /opt/metabob-plugin ) \
    > "$OUT/transcript.jsonl" 2> "$OUT/harness.log"
  hrc=$?
  meta[harness_exit]="$hrc"; [ "$hrc" = 124 ] && meta[harness_stopped]="wall time ($WALL_S s)"
  r="$(grep '"type":"result"' "$OUT/transcript.jsonl" | tail -1)"
  [ -n "$r" ] && { meta[cost_usd]="$(jq -r '.total_cost_usd // ""' <<<"$r")"; meta[turns]="$(jq -r '.num_turns // ""' <<<"$r")"; meta[result_subtype]="$(jq -r '.subtype // ""' <<<"$r")"; }
fi

# 4. the commit: the agent's own, else the cell's; a trailer in base..HEAD either way
if [ -n "$(git -C "$WORK" status --porcelain)" ]; then
  git -C "$WORK" add -A && git -C "$WORK" commit -q -m "task $TASK_ID: changes the harness left uncommitted

Fixes-Finding: $TASK_ID" && meta[commit]="cell committed the harness's uncommitted changes"
fi
if git -C "$WORK" log --format=%B "$BASE..HEAD" | grep -q "^Fixes-Finding: $TASK_ID\$"; then
  meta[commit]="${meta[commit]:-agent committed with the trailer}"
elif [ -n "$(git -C "$WORK" rev-list "$BASE..HEAD")" ]; then
  git -C "$WORK" commit -q --allow-empty -m "task $TASK_ID

Fixes-Finding: $TASK_ID" && meta[commit]="agent committed without the trailer; cell added it in an empty commit"
else
  meta[commit]="no change"
fi
# The push URL is disabled: an attempt is recorded, and it fails.
if git -C "$WORK" push -q origin HEAD 2>/dev/null; then meta[push_probe]="SUCCEEDED (must not)"; else meta[push_probe]="refused"; fi

# 5. the bundle
# Every commit the clone holds: with a pin, the base, the fixture's and the work's commits, and nothing after the base.
meta[clone_commits]="$(git -C "$WORK" rev-list --all --count)"
git -C "$WORK" diff "$BASE..HEAD" > "$OUT/diff.patch"
git -C "$WORK" diff --name-only "$BASE..HEAD" > "$OUT/names.txt"
git -C "$WORK" log --format='%H%n%B%n--' "$BASE..HEAD" > "$OUT/commits.txt"
[ -f "$OUT/calls.jsonl" ] || : > "$OUT/calls.jsonl"
# Signs the agent looked for the answer outside the pinned base: recorded, judged outside the cell.
meta[transcript_git_fetch]="$(grep -c 'git fetch\|git pull\|ls-remote\|--unshallow' "$OUT/transcript.jsonl" || true)"
finish "$hrc"
