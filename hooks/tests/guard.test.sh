#!/usr/bin/env bash
# Behaviour tests for the packed workflow-immutability guard (FR-20).
#
#   bash hooks/tests/guard.test.sh
#
# Two of these cover the exact reasons the pack ships its own guard rather than
# relying on the one registered globally: the flat originals must stay runnable
# (FR-14's permanent dual-run), and prose that merely quotes a guarded pipeline
# name must not be blocked (the over-match observed while the pack was specified).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
export CLAUDE_PLUGIN_ROOT="$PWD"

GUARD=hooks/guard-workflow.py
CANON="$PWD/skills/task-review/task-review.workflow.js"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

# $1 name  $2 python expression producing the hook payload  $3 expected exit
check() {
  local rc
  python3 -c "$2" | python3 "$GUARD" >/dev/null 2>&1; rc=$?
  if [[ "$rc" == "$3" ]]; then
    pass=$((pass + 1)); printf '  ok   %-58s exit %s\n' "$1" "$rc"
  else
    fail=$((fail + 1)); printf '  FAIL %-58s exit %s, wanted %s\n' "$1" "$rc" "$3"
  fi
}

J="import json,sys"
cp "$CANON" "$TMP/forked.workflow.js"

check "the packed canonical workflow runs" \
  "$J;print(json.dumps({'tool_name':'Workflow','tool_input':{'scriptPath':'$CANON'}}))" 0
check "the flat original still runs (FR-14)" \
  "$J;print(json.dumps({'tool_name':'Workflow','tool_input':{'scriptPath':'~/.claude/skills/post-task-review/post-task-review.workflow.js'}}))" 0
check "a fork run from elsewhere is refused" \
  "$J;print(json.dumps({'tool_name':'Workflow','tool_input':{'scriptPath':'$TMP/forked.workflow.js'}}))" 2
check "writing a fork to a new path is refused" \
  "$J;print(json.dumps({'tool_name':'Write','tool_input':{'file_path':'$TMP/copy.workflow.js','content':open('$CANON').read()}}))" 2
check "an inline fork is refused" \
  "$J;print(json.dumps({'tool_name':'Workflow','tool_input':{'script':open('$CANON').read()}}))" 2
check "prose quoting a guarded name is allowed" \
  "$J;print(json.dumps({'tool_name':'Edit','tool_input':{'file_path':'$TMP/notes.md','new_string':chr(34)+'name: '+chr(39)+'post-task-review'+chr(39)+chr(34)}}))" 0
check "an unrelated workflow is allowed" \
  "$J;print(json.dumps({'tool_name':'Workflow','tool_input':{'script':'export const meta = {name: '+chr(39)+'other'+chr(39)+'}'}}))" 0

printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
