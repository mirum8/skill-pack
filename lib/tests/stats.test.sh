#!/usr/bin/env bash
# Behaviour tests for the pack-wide stats store — the sink, the hook that feeds it, and the
# reporter that reads it back.
#
#   bash lib/tests/stats.test.sh
#
# What these exist to protect is the sink's one hard promise: it can never fail its caller. Every
# skill in the pack calls it as the last thing it does, best-effort by contract, so a sink that
# starts exiting non-zero would take down runs while looking like a review failure. There is no
# fallback store behind it, which makes the concurrency case below load-bearing rather than
# theoretical: a locked database that dropped writes would lose rows silently.
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
q() { sqlite3 "$1" "$2"; }

# --- the sink ---------------------------------------------------------------
D="$TMP/store.db"
echo '{"skill":"r:code-bugs","scope":"diff","findings":[
  {"track":"logic","category":"concurrency","severity":"high","file":"src/Foo.java","line":88,
   "verdict":"confirmed","fixed":true,"description":"double-checked locking without volatile"},
  {"track":"security","verdict":"dismissed","description":"validated upstream"}]}' \
  | python3 "$SINK" --db "$D" >/dev/null 2>&1
ok "the schema is created on first write"  "$(q "$D" "select value from meta where key='schema_version'")" 1
ok "one run row is written"                "$(q "$D" "select count(*) from runs")" 1
ok "findings are exploded into rows"       "$(q "$D" "select count(*) from findings")" 2
ok "a verdict round-trips"                 "$(q "$D" "select verdict from findings where track='security'")" dismissed
ok "so does the file/line it points at"    "$(q "$D" "select file||':'||line from findings where track='logic'")" src/Foo.java:88
ok "ts is stamped"                         "$(q "$D" "select substr(ts,1,2) from runs")" 20
ok "repo is stamped"                       "$(q "$D" "select repo from runs")" skill-pack
ok "event defaults to result"              "$(q "$D" "select event from runs")" result
ok "a run_id is generated"                 "$(q "$D" "select length(run_id) from runs")" 36
# The payload is kept verbatim so a field with no column of its own is still queryable — that is
# what lets a skill add one without a migration, and what makes the report readable at all.
ok "the caller's payload is queryable"     "$(q "$D" "select json_extract(payload,'\$.scope') from runs")" diff

# The promise every caller leans on. Each of these is a real shape a subagent has produced.
for bad in 'not json at all' '[1,2,3]' '' 'null'; do
  printf '%s' "$bad" | python3 "$SINK" --db "$D" >/dev/null 2>&1
  ok "malformed input (${bad:-<empty>}) still exits 0" "$?" 0
done
ok "malformed input wrote nothing"         "$(q "$D" "select count(*) from runs")" 1
python3 "$SINK" --db /nonexistent-root/x/s.db </dev/null >/dev/null 2>&1
ok "an unwritable store still exits 0"     "$?" 0

# A finding with no verdict is UNRESOLVED — nobody judged it. Defaulting it to either confirmed or
# dismissed would invent the judgement that is missing, which is the failure this table exists to
# make impossible.
echo '{"skill":"r:code-adversarial","findings":[{"track":"codex","description":"unjudged"}]}' \
  | python3 "$SINK" --db "$D" >/dev/null 2>&1
ok "a finding with no verdict is unresolved" "$(q "$D" "select verdict from findings where track='codex'")" unresolved

# Parallel worktree reviews write at the same moment and there is no fallback store to catch a
# dropped row, so this is the case that decides whether the design is safe at all.
for i in 1 2 3 4 5 6 7 8; do
  ( for j in 1 2 3 4 5; do
      echo "{\"skill\":\"r:code-scan\",\"w\":$i,\"n\":$j}" | python3 "$SINK" --db "$D" >/dev/null 2>&1
    done ) &
done
wait
ok "8 concurrent writers lose nothing"     "$(q "$D" "select count(*) from runs where skill='r:code-scan'")" 40

# --- the hook ---------------------------------------------------------------
H="$TMP/hook.db"
hook() { echo "$1" | CLAUDE_SKILL_STATS_DB="$H" python3 "$HOOK" 2>/dev/null; }

out=$(hook '{"hook_event_name":"PostToolUse","tool_name":"Skill","tool_input":{"skill":"r:code-bugs"},"session_id":"abc-123"}')
ok "a Skill tool call is recorded"         "$(q "$H" "select via from runs")" tool
ok "it is an invoke row, not a result"     "$(q "$H" "select event from runs")" invoke
# The join key: without it, an invocation and the outcome it produced correlate only by guesswork.
ok "the session id is carried through"     "$(q "$H" "select session_id from runs")" abc-123
ok "the hook prints nothing on stdout"     "${#out}" 0

out=$(hook '{"hook_event_name":"UserPromptSubmit","prompt":"/r:code-quality check the diff"}')
ok "a typed /r: command is recorded"       "$(q "$H" "select via from runs where skill='r:code-quality'")" slash
ok "still nothing on stdout"               "${#out}" 0

# The two events are DISJOINT in the transcript — a typed command produces no tool call at all —
# so both registrations are load-bearing and neither needs de-duplicating against the other.
hook '{"hook_event_name":"UserPromptSubmit","prompt":"just a normal message"}'
hook '{"hook_event_name":"UserPromptSubmit","prompt":"tell me about /r:code-bugs"}'
hook '{"hook_event_name":"PostToolUse","tool_name":"Skill","tool_input":{"skill":"security-review"}}'
hook '{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}'
ok "an ordinary prompt records nothing"    "$(q "$H" "select count(*) from runs")" 2
hook 'garbage'; ok "garbage input still exits 0" "$?" 0
hook '{"hook_event_name":"PostToolUse"}'; ok "a payload with no tool_input exits 0" "$?" 0
ok "nothing was written by any of those"   "$(q "$H" "select count(*) from runs")" 2

# --- the reporter -----------------------------------------------------------
rep=$(python3 "$REPORT" --db "$H" 2>&1)
ok "the reporter counts invocations"       "$(grep -c 'SKILL INVOCATIONS  2' <<<"$rep")" 1
ok "it names the never-observed skills"    "$(grep -c 'never observed' <<<"$rep")" 1
rep=$(python3 "$REPORT" --db "$TMP/empty.db" 2>&1)
ok "an empty store is not an error"        "$(grep -c 'no records yet' <<<"$rep")" 1

# Precision is the number `fixes by source` cannot produce: a track whose findings are all
# rejected scores the same zero there as a track that found nothing.
rep=$(python3 "$REPORT" --db "$D" 2>&1)
ok "precision by track is reported"        "$(grep -c 'precision by track' <<<"$rep")" 1
ok "and it separates confirmed from dismissed" "$(grep -cE '^  security +0 +1' <<<"$rep")" 1

# A skill that wrote an OUTCOME plainly ran, even with no invoke row — calling it unobserved is
# the false zero this store exists to prevent, and it reads as "nobody uses this, retire it".
ok "a skill with an outcome is not 'never observed'" \
   "$(grep 'never observed' <<<"$rep" | grep -c 'r:code-bugs')" 0
ok "it is reported as ran-without-a-run-count" \
   "$(grep -c 'ran, but with no invocation recorded' <<<"$rep")" 1

# --- importing the pre-SQLite archive ---------------------------------------
A="$TMP/archive.jsonl"; I="$TMP/imported.db"
printf '%s\n' \
  '{"kind":"review","profile":"full","origin":"live","fixedBySource":{"codex":2},"endVerify":"passed","ts":"2026-01-01T00:00:00+00:00"}' \
  '{"skill":"r:code-bugs","event":"invoke","via":"slash","ts":"2026-01-01T00:00:01+00:00"}' > "$A"
python3 "$REPORT" --db "$I" --jsonl-path "$A" --import-jsonl >/dev/null 2>&1
ok "archived rows are copied in"           "$(q "$I" "select count(*) from runs")" 2
ok "a copied row is normalised"            "$(q "$I" "select skill from runs where kind='review'")" r:task-review
# The archive spans the arrival of the hook, so it holds real invoke rows; flattening them to
# results would erase the only invocations recorded before the db existed.
ok "an archived invoke row stays an invoke" "$(q "$I" "select event from runs where skill='r:code-bugs'")" invoke
python3 "$REPORT" --db "$I" --jsonl-path "$A" --import-jsonl >/dev/null 2>&1
ok "a second import copies nothing"        "$(q "$I" "select count(*) from runs")" 2
ok "the archive is left untouched"         "$(wc -l < "$A" | tr -d ' ')" 2

printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
