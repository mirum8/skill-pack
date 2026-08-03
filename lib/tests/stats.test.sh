#!/usr/bin/env bash
# Behaviour tests for the pack-wide stats store — the sink, the hook that feeds it, and the
# reporter that reads it back.
#
#   bash lib/tests/stats.test.sh
#
# What these exist to protect is the sink's one hard promise: it can never fail its caller.
# Every skill in the pack calls it as the last thing it does, best-effort by contract, so a
# sink that starts exiting non-zero would take down runs while looking like a review failure.
# The other half is the hook, which runs on EVERY user prompt — a hook that prints on stdout
# injects text into the conversation, and a hook that exits non-zero blocks the prompt.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

SINK=lib/record-run.py
HOOK=hooks/record-skill-run.py
REPORT=lib/skill-stats.py
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok() {
  if [[ "$2" == "$3" ]]; then
    pass=$((pass + 1)); printf '  ok   %-58s %s\n' "$1" "$2"
  else
    fail=$((fail + 1)); printf '  FAIL %-58s %s, wanted %s\n' "$1" "$2" "$3"
  fi
}

field() { python3 -c "import json,sys;print(json.loads(sys.stdin.readlines()[$2])$1)" ; }

# --- the sink ---------------------------------------------------------------
S="$TMP/store.jsonl"
echo '{"skill":"r:code-bugs","findings":3}' | python3 "$SINK" --path "$S" >/dev/null 2>&1
ok "a record is appended"            "$(wc -l < "$S" | tr -d ' ')" 1
ok "the row is one line of JSON"     "$(field "['findings']" 0 < "$S")" 3
ok "ts is stamped"                   "$(field "['ts'][:2]" 0 < "$S")" 20
ok "repo is stamped"                 "$(field "['repo']" 0 < "$S")" skill-pack
ok "origin defaults to live"         "$(field "['origin']" 0 < "$S")" live
ok "event defaults to result"        "$(field "['event']" 0 < "$S")" result

# `pipeline` names a generation of the REVIEW track set. On a scan or a commit row it would be
# an answer to a question that row cannot be asked, which is how a store starts lying.
ok "no pipeline rev on a non-review row" \
   "$(python3 -c "import json,sys;print('pipeline' in json.loads(sys.stdin.readline()))" < "$S")" False
echo '{"kind":"review","profile":"full"}' | python3 "$SINK" --path "$S" >/dev/null 2>&1
ok "a review row carries the pipeline rev" "$(field "['pipeline']" 1 < "$S")" 2
ok "a review row infers its skill"         "$(field "['skill']" 1 < "$S")" r:task-review

# The promise every caller leans on. Each of these is a real shape a subagent has produced.
for bad in 'not json at all' '[1,2,3]' '' 'null'; do
  printf '%s' "$bad" | python3 "$SINK" --path "$S" >/dev/null 2>&1
  ok "malformed input (${bad:-<empty>}) still exits 0" "$?" 0
done
ok "malformed input wrote nothing"   "$(wc -l < "$S" | tr -d ' ')" 2
python3 "$SINK" --path /nonexistent-root/x/store.jsonl </dev/null >/dev/null 2>&1
ok "an unwritable store still exits 0" "$?" 0

# Over the cap the row is TRUNCATED rather than written long: a single os.write() is atomic only
# under PIPE_BUF, and parallel worktree reviews append to one file. An interleaved line would
# corrupt every reader downstream, which is worse than a lost field.
python3 -c "import json;print(json.dumps({'kind':'review','docDrift':['x'*200]*40}))" \
  | python3 "$SINK" --path "$S" >/dev/null 2>&1
ok "an oversized row is capped"      "$(awk 'END{print (length($0) < 4001)}' "$S")" 1
ok "still exactly one line per row"  "$(wc -l < "$S" | tr -d ' ')" 3

# --- the hook ---------------------------------------------------------------
S="$TMP/hook.jsonl"
hook() { echo "$1" | CLAUDE_SKILL_STATS_PATH="$S" python3 "$HOOK" 2>/dev/null; }

out=$(hook '{"hook_event_name":"PostToolUse","tool_name":"Skill","tool_input":{"skill":"r:code-bugs"}}')
ok "a Skill tool call is recorded"   "$(field "['via']" 0 < "$S")" tool
ok "the hook prints nothing on stdout" "${#out}" 0

out=$(hook '{"hook_event_name":"UserPromptSubmit","prompt":"/r:code-quality check the diff"}')
ok "a typed /r: command is recorded" "$(field "['via']" 1 < "$S")" slash
ok "it is an invoke row, not a result" "$(field "['event']" 1 < "$S")" invoke
ok "still nothing on stdout"         "${#out}" 0

# The two events are DISJOINT in the transcript — a typed command produces no tool call at all —
# so both registrations are load-bearing and neither needs de-duplicating against the other.
hook '{"hook_event_name":"UserPromptSubmit","prompt":"just a normal message"}'
hook '{"hook_event_name":"UserPromptSubmit","prompt":"tell me about /r:code-bugs"}'
hook '{"hook_event_name":"PostToolUse","tool_name":"Skill","tool_input":{"skill":"security-review"}}'
hook '{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}'
ok "an ordinary prompt records nothing"      "$(wc -l < "$S" | tr -d ' ')" 2
hook 'garbage'; ok "garbage input still exits 0" "$?" 0
hook '{"hook_event_name":"PostToolUse"}'; ok "a payload with no tool_input exits 0" "$?" 0
ok "nothing was written by any of those"     "$(wc -l < "$S" | tr -d ' ')" 2

# --- the reporter -----------------------------------------------------------
# It must read a store it has never seen a legacy file for, and one with no invoke rows at all,
# without either being mistaken for the other. A skill with no invoke row was never OBSERVED,
# which the report has to say in those words rather than as a zero.
rep=$(python3 "$REPORT" --path "$S" --legacy-path /dev/null 2>&1)
ok "the reporter counts invocations"  "$(grep -c 'SKILL INVOCATIONS  2' <<<"$rep")" 1
ok "it names the never-observed skills" "$(grep -c 'never observed' <<<"$rep")" 1
ok "runs and outcomes are not mixed"  "$(grep -c 'outcome row(s) alongside' <<<"$rep")" 1
rep=$(python3 "$REPORT" --path /dev/null --legacy-path /dev/null 2>&1)
ok "an empty store is not an error"   "$(grep -c 'no records yet' <<<"$rep")" 1

# A skill that wrote an OUTCOME plainly ran, even with no invoke row — calling it unobserved is
# the false zero this store exists to prevent, and it reads as "nobody uses this, retire it".
O="$TMP/outcome.jsonl"
echo '{"skill":"r:code-bugs","event":"result","findings":2}' > "$O"
rep=$(python3 "$REPORT" --path "$O" --legacy-path /dev/null 2>&1)
ok "a skill with an outcome is not 'never observed'" \
   "$(grep 'never observed' <<<"$rep" | grep -c 'r:code-bugs')" 0
ok "it is reported as ran-without-a-run-count" \
   "$(grep -c 'ran, but with no invocation recorded: r:code-bugs' <<<"$rep")" 1
ok "a skill with no row at all is still called out" \
   "$(grep 'never observed' <<<"$rep" | grep -c 'r:spec-plan')" 1

# --- importing the pre-pack-wide store --------------------------------------
# The copy has to be safe to re-run and must not leave the same run countable from both files.
L="$TMP/legacy.jsonl"; N="$TMP/new.jsonl"
printf '%s\n' \
  '{"kind":"review","profile":"full","origin":"live","fixedBySource":{"codex":2},"endVerify":"passed"}' \
  '{"kind":"implement","profile":"full","origin":"live","planApplied":3}' > "$L"
python3 "$REPORT" --path "$N" --legacy-path "$L" --import-legacy >/dev/null 2>&1
ok "legacy rows are copied in"        "$(wc -l < "$N" | tr -d ' ')" 2
ok "a copied row is normalised"       "$(field "['skill']" 0 < "$N")" r:task-review
ok "and marked as an outcome, not a run" "$(field "['event']" 0 < "$N")" result
python3 "$REPORT" --path "$N" --legacy-path "$L" --import-legacy >/dev/null 2>&1
ok "a second import copies nothing"   "$(wc -l < "$N" | tr -d ' ')" 2
ok "the legacy file is left untouched" "$(wc -l < "$L" | tr -d ' ')" 2
# The failure this guards: reading both stores after an import counts every historical run twice.
rep=$(python3 "$REPORT" --path "$N" --legacy-path "$L" --review 2>&1)
ok "imported rows are not double-counted" "$(grep -c 'REVIEW RUNS  1 ' <<<"$rep")" 1
ok "and the report says the legacy file is dropped" "$(grep -c 'no longer read' <<<"$rep")" 1

printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
