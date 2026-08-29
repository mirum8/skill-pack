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

# An eval sweep redirects CLAUDE_SKILL_STATS_DB so its synthetic runs never touch the real store.
# The hook honours it; so must the sink, or a sweep is isolated for `invoke` rows and writes its
# `result` rows straight into the store every convention here says to read before deciding anything.
E="$TMP/redirected.db"
echo '{"skill":"r:code-quality","findings":[]}' \
  | CLAUDE_SKILL_STATS_DB="$E" python3 "$SINK" >/dev/null 2>&1
ok "the sink honours CLAUDE_SKILL_STATS_DB" "$(q "$E" "select skill from runs")" r:code-quality
echo '{"skill":"r:code-scan","findings":[]}' \
  | CLAUDE_SKILL_STATS_DB=/nonexistent-root/x/s.db python3 "$SINK" --db "$E" >/dev/null 2>&1
ok "--db still wins over the env var"      "$(q "$E" "select count(*) from runs")" 2

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

hook '{"hook_event_name":"UserPromptSubmit","prompt":"just a normal message"}'
hook '{"hook_event_name":"UserPromptSubmit","prompt":"tell me about /r:code-bugs"}'
hook '{"hook_event_name":"PostToolUse","tool_name":"Skill","tool_input":{"skill":"security-review"}}'
hook '{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}'
ok "an ordinary prompt records nothing"    "$(q "$H" "select count(*) from runs")" 2
hook 'garbage'; ok "garbage input still exits 0" "$?" 0
hook '{"hook_event_name":"PostToolUse"}'; ok "a payload with no tool_input exits 0" "$?" 0
ok "nothing was written by any of those"   "$(q "$H" "select count(*) from runs")" 2

# --- the Workflow route -----------------------------------------------------
# `/r:issues-fix` runs both pipelines by scriptPath and explicitly forbids the Skill route, so
# without this route the pack's two most expensive skills have no invoke row on their primary path.
W="$TMP/wf.db"
wf() { echo "$1" | CLAUDE_SKILL_STATS_DB="$W" python3 "$HOOK" 2>/dev/null; }
wf '{"hook_event_name":"PostToolUse","tool_name":"Workflow","tool_input":{"scriptPath":"/any/pack/skills/task-review/task-review.workflow.js"},"session_id":"s1"}'
ok "a pipeline scriptPath is recorded"     "$(q "$W" "select skill from runs")" r:task-review
ok "its route is named separately"         "$(q "$W" "select via from runs")" workflow
wf '{"hook_event_name":"PostToolUse","tool_name":"Workflow","tool_input":{"name":"run-task-implement"},"session_id":"s2"}'
ok "so is the workflow name form"          "$(q "$W" "select skill from runs where session_id='s2'")" r:task-run
# Only the two pipelines. Any other workflow on the machine is not this pack's to count.
wf '{"hook_event_name":"PostToolUse","tool_name":"Workflow","tool_input":{"scriptPath":"/x/some-other.workflow.js"},"session_id":"s3"}'
wf '{"hook_event_name":"PostToolUse","tool_name":"Workflow","tool_input":{"name":"something-else"},"session_id":"s3"}'
ok "a foreign workflow records nothing"    "$(q "$W" "select count(*) from runs")" 2

# --- de-duplication across routes -------------------------------------------
# The routes chain: a typed `/r:x` also produces a Skill call, and a Skill call on either pipeline
# is followed by that skill's markdown dispatching its own Workflow. Each chain is ONE invocation
# seen twice, and counting both inflates the only number this store exists to produce.
D2="$TMP/dedup.db"
dd() { echo "$1" | CLAUDE_SKILL_STATS_DB="$D2" python3 "$HOOK" 2>/dev/null; }
dd '{"hook_event_name":"UserPromptSubmit","prompt":"/r:task-review","session_id":"z1"}'
dd '{"hook_event_name":"PostToolUse","tool_name":"Skill","tool_input":{"skill":"r:task-review"},"session_id":"z1"}'
dd '{"hook_event_name":"PostToolUse","tool_name":"Workflow","tool_input":{"scriptPath":"/p/skills/task-review/task-review.workflow.js"},"session_id":"z1"}'
ok "one invocation down the chain is 1 row" "$(q "$D2" "select count(*) from runs")" 1
ok "and it keeps the route it arrived by"   "$(q "$D2" "select via from runs")" slash
# Two sightings by the SAME route are two real invocations — the model called it twice.
dd '{"hook_event_name":"PostToolUse","tool_name":"Skill","tool_input":{"skill":"r:tests-write"},"session_id":"z1"}'
dd '{"hook_event_name":"PostToolUse","tool_name":"Skill","tool_input":{"skill":"r:tests-write"},"session_id":"z1"}'
ok "same route twice stays two rows"        "$(q "$D2" "select count(*) from runs where skill='r:tests-write'")" 2
# A different session is a different run, however close together the two arrive.
dd '{"hook_event_name":"PostToolUse","tool_name":"Workflow","tool_input":{"scriptPath":"/p/skills/task-review/task-review.workflow.js"},"session_id":"z2"}'
ok "another session is not a duplicate"     "$(q "$D2" "select count(*) from runs where skill='r:task-review'")" 2
# Without a session id the routes cannot be correlated at all, so the row is kept: a duplicate is
# a number that can still be corrected, a dropped row is gone (there is no fallback store).
dd '{"hook_event_name":"UserPromptSubmit","prompt":"/r:code-scan"}'
dd '{"hook_event_name":"PostToolUse","tool_name":"Skill","tool_input":{"skill":"r:code-scan"}}'
ok "no session id means record, not guess"  "$(q "$D2" "select count(*) from runs where skill='r:code-scan'")" 2

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

# --- classifying a workflow item's step -------------------------------------
# Claude Code persists an agentType but not the workflow label, so without this every cost number
# rolls up per agent type — and `general-purpose` alone spans the codex pass, triage, local-scan
# and the sink, which averages the expensive steps into the cheap ones.
cls() { python3 - "$1" <<'PY'
import importlib.util, sys, glob, os
spec = importlib.util.spec_from_file_location("ss", "lib/skill-stats.py")
ss = importlib.util.module_from_spec(spec); spec.loader.exec_module(ss)
sigs = ss.label_signatures(sorted(glob.glob("skills/*/*.workflow.js")))
print(ss.classify(sys.argv[1], sigs) or "<none>")
PY
}
STATS_PROMPT='Record one line of review statistics. This is bookkeeping - if anything goes wrong, say so
   and return; do NOT retry, do NOT fix anything, and do NOT treat it as a failure of the review.'
ok "a stats prompt classifies as the sink step"      "$(cls "$STATS_PROMPT")" stats

SCAN_PROMPT='Run /r:code-scan over the classes this BRANCH changed. First compute the list yourself;
   do NOT use any list you were handed.'
ok "a scan prompt classifies as its own step"        "$(cls "$SCAN_PROMPT")" local-scan
# The same step under its PRE-PACK skill name. Without the alias every run recorded before the
# rename classifies as nothing, and a step that cost 80M tokens reads as a step that never ran.
# The old name is ASSEMBLED, never written whole: a flat skill name sitting in a shipped file is
# one the model would try to invoke and fail to reach, and validate.py refuses it on sight.
OLD_SCAN="/local""-scan"
ok "and so does its pre-pack spelling"               "$(cls "${SCAN_PROMPT/\/r:code-scan/$OLD_SCAN}")" local-scan
# An unrecognised prompt must stay unlabelled: a confidently wrong step name is worse than a gap,
# because the gap is counted and reported while the wrong name is quietly averaged in.
ok "an unrecognised prompt stays unlabelled" "$(cls 'do something entirely unrelated')" '<none>'

# A prompt reaches its agent in three shapes, and one the classifier cannot read costs every run of
# that step: those rows roll up under `general-purpose` beside the sink and the explorers, which is
# the averaging this whole scheme exists to undo.
BUILD_PROMPT='Run the build `mvn clean package` via the r:maven-build-runner agent.
   green=true ONLY on a fully clean success (exit 0, zero failures). The green bar is
   NEVER relaxed. If red, CLASSIFY every failure:'
ok "an inline code span does not truncate a prompt"  "$(cls "$BUILD_PROMPT")" build

BRANCH_PROMPT='Put the repo on the feature branch item-x, based on main.
       Commit nothing, and do not touch any file — another agent may be writing the plan while you
       run.'
ok "a label picked by a ternary still names its step" "$(cls "$BRANCH_PROMPT")" branch

# The prompt handed over by name (`agent(implBrief(a), { label })`): its literal lives under the
# builder, a dispatch away from the label that names it.
IMPL_PROMPT='Implement your slice of the plan at .task-plans/issue-1-x.md. READ THAT FILE FIRST — it holds
   the Context, the acceptance criteria, and the TDD test plan, so you build what the plan intends
   rather than your own reinterpretation.'
ok "a prompt built by a named builder is its step"   "$(cls "$IMPL_PROMPT")" implement

# And the pairing the other way round: a table of tracks carries `label:` beside the `prompt:` it
# dispatches, so the label sits BEFORE the literal rather than after it.
UI_PROMPT='You are the VISUAL half of the UI verification. A functional half runs in PARALLEL with you
       and owns API, flow and log checks — do not repeat them, and do not wait for it.'
ok "a track table pairs its prompt with its label"   "$(cls "$UI_PROMPT")" ui-visual

# Two steps sharing a chunk name NEITHER of them. Awarding it to whichever sorted first would put
# one step's cost under the other's name, and nothing in the report would show that it happened.
FIXTURE="$TMP/two-steps.workflow.js"
cat > "$FIXTURE" <<'JS'
export const meta = { name: 'fixture' }
await agent(`Re-run the suite and report what it printed, verbatim and in full.`,
  { label: 'alpha', phase: 'A' })
await agent(`Re-run the suite and report what it printed, verbatim and in full.`,
  { label: 'beta', phase: 'B' })
await agent(`Take the screenshots at three viewports and say what each one shows.`,
  { label: 'gamma', phase: 'C' })
JS
in_fixture() { python3 - "$FIXTURE" "$1" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ss", "lib/skill-stats.py")
ss = importlib.util.module_from_spec(spec); spec.loader.exec_module(ss)
print(ss.classify(sys.argv[2], ss.label_signatures([sys.argv[1]])) or "<none>")
PY
}
ok "a chunk two steps share names neither" \
   "$(in_fixture 'Re-run the suite and report what it printed, verbatim and in full.')" '<none>'
ok "a chunk only one step uses still names it" \
   "$(in_fixture 'Take the screenshots at three viewports and say what each one shows.')" gamma

# --- reading the fixes-by-source table honestly ------------------------------
# The two ways this table lies about a track that is behaving correctly. Both end in the same
# place: a name on the retirement list, which is the one line here anybody acts on.
R="$TMP/review.db"
for i in 1 2 3 4 5 6; do
  echo "{\"kind\":\"review\",\"profile\":\"full\",\"pipeline\":2,\"origin\":\"live\",\"n\":$i,
         \"fixedBySource\":{\"logic\":1},\"docDriftCount\":3,\"tracksSkipped\":[\"security\"]}" \
    | python3 "$SINK" --db "$R" >/dev/null 2>&1
done
rep=$(python3 "$REPORT" --db "$R" --review 2>&1)

# A per-DIFF gate (the security hunter's `securitySurface`) closes on a run the TIER still lists as
# dispatching that track. Counted as an opportunity, every such run divides the track's yield by a
# diff it never saw — and drives it toward a retirement it did not earn.
ok "a skipped track gets no opportunity"   "$(grep -cE '^  security +0 +0' <<<"$rep")" 1
ok "a track that ran keeps its own"        "$(grep -cE '^  logic +6 +6 +1\.00' <<<"$rep")" 1

# A BLOCKED track is a different claim from a skipped one — nobody's fault versus a tool that
# failed — and they stay reported apart. To a denominator they are the same: the track never ran,
# so the run was not an opportunity it had and missed.
B="$TMP/blocked.db"
for i in 1 2 3 4 5 6; do
  echo "{\"kind\":\"review\",\"profile\":\"full\",\"pipeline\":2,\"origin\":\"live\",\"n\":$i,
         \"fixedBySource\":{\"logic\":1},\"tracksSkipped\":[],\"tracksBlocked\":[\"codex\"]}" \
    | python3 "$SINK" --db "$B" >/dev/null 2>&1
done
rep=$(python3 "$REPORT" --db "$B" --review 2>&1)
ok "a blocked track gets no opportunity either" "$(grep -cE '^  codex +0 +0' <<<"$rep")" 1
ok "and it is still reported as blocked"   "$(grep -cE '^  codex +6' <<<"$rep")" 1

# The case a naive union of the two lists silently misses. A review names a dead track for its
# CALLER, and the hunter fan-out reports under one name while the tier scores its members
# separately. Unexpanded, the subtraction covers `codex` and `docs` and quietly skips the whole
# scan — the most expensive thing that can fail in the pipeline.
A2="$TMP/alias.db"
for i in 1 2 3 4 5 6; do
  echo "{\"kind\":\"review\",\"profile\":\"full\",\"pipeline\":2,\"origin\":\"live\",\"n\":$i,
         \"fixedBySource\":{\"codex\":1},\"tracksSkipped\":[],\"tracksBlocked\":[\"find-bugs\"]}" \
    | python3 "$SINK" --db "$A2" >/dev/null 2>&1
done
rep=$(python3 "$REPORT" --db "$A2" --review 2>&1)
for t in logic runtime-and-failures security; do
  ok "a blocked scan subtracts from $t"    "$(grep -cE "^  $t +0 +0" <<<"$rep")" 1
done
ok "the track that DID run is untouched"   "$(grep -cE '^  codex +6 +6 +1\.00' <<<"$rep")" 1
# The alias is intersected with the tier, never applied whole: at standard the fan-out never
# dispatched `logic` at all, so there is nothing there to subtract from and no row to invent.
echo '{"kind":"review","profile":"standard","pipeline":2,"origin":"live","fixedBySource":{},
       "tracksSkipped":[],"tracksBlocked":["security hunter"]}' \
  | python3 "$SINK" --db "$TMP/std.db" >/dev/null 2>&1
rep=$(python3 "$REPORT" --db "$TMP/std.db" --review 2>&1)
ok "an alias never invents a track off-tier" "$(grep -cE '^  logic ' <<<"$rep")" 0
ok "and it still subtracts the one on-tier"  "$(grep -cE '^  security +0 +0' <<<"$rep")" 1

# Back to the first store: the fixtures above each rebound `rep`.
rep=$(python3 "$REPORT" --db "$R" --review 2>&1)

# `docs` produces findings the pipeline hands to the USER and never fixes (update-doc /
# update-code / confirm-intent is nobody else's call), so it cannot appear in fixedBySource at all.
# Its zero is structural. Reading it as a dead track measures the metric, not the tool.
ok "a surfaced-only track is not a retirement candidate" \
   "$(grep 'never produced a fix' <<<"$rep" | grep -c docs)" 0
ok "what it surfaced is reported instead"  "$(grep -c 'docs: 18 item(s) surfaced over 6 run(s)' <<<"$rep")" 1
ok "and its fixes/run reads n/a, not 0.00" "$(grep -cE '^  docs +0 +6 +n/a' <<<"$rep")" 1
# The list must still fire, or the exemption above has quietly disabled it.
ok "a genuinely dark track is still named" \
   "$(grep 'never produced a fix' <<<"$rep" | grep -c runtime-and-failures)" 1

# A run written before the pipeline reported what did NOT run counts every tier track as an
# opportunity, closed gates and failed tools included. That is an upper bound, and saying so is the
# difference between a number somebody acts on and a number somebody acts on wrongly.
echo '{"kind":"review","profile":"full","pipeline":2,"origin":"live","fixedBySource":{}}' \
  | python3 "$SINK" --db "$R" >/dev/null 2>&1
ok "an unverifiable denominator says so"   \
   "$(python3 "$REPORT" --db "$R" --review 2>&1 | grep -c 'predate the record of')" 1

# The alias map holds strings PRODUCED by another file. A rename there and the subtraction above
# silently stops happening — no error, no empty column, just a denominator quietly too large again.
# So the keys are checked against the script that emits them.
aliases=$(python3 - <<'PYA'
import importlib.util
spec = importlib.util.spec_from_file_location("ss", "lib/skill-stats.py")
ss = importlib.util.module_from_spec(spec); spec.loader.exec_module(ss)
src = open("skills/task-review/task-review.workflow.js", encoding="utf-8").read()
print(sum(1 for k in ss.HUNTER_ALIASES if f"'{k}'" not in src))
PYA
)
ok "every alias key is a name the review emits" "$aliases" 0

# --- whose unlabelled items are they -----------------------------------------
# One total buries the only number worth acting on. An unlabelled item beside a LABELLED one is a
# prompt shape this classifier cannot read — and a shape that goes unread costs its step on every
# run it ever made. An unlabelled item in a run with no pipeline step at all is somebody else's
# workflow, put through the same tool into the same store, and was never ours to label.
I2="$TMP/items.db"
echo '{"kind":"review","origin":"live"}' | python3 "$SINK" --db "$I2" >/dev/null 2>&1
sqlite3 "$I2" "INSERT INTO items(wf_run_id,agent_id,label,tokens_in,tokens_out,tokens_cache) VALUES
  ('wf_ours','a1','implement',1,1,1), ('wf_ours','a2',NULL,1,1,1),
  ('wf_theirs','b1',NULL,1,1,1), ('wf_theirs','b2',NULL,1,1,1), ('wf_theirs','b3',NULL,1,1,1);"
rep=$(python3 "$REPORT" --db "$I2" 2>&1)
ok "the unlabelled total is still reported" "$(grep -c '4 item(s) carry no step label' <<<"$rep")" 1
ok "the ones in a pipeline run are singled out" "$(grep -c '1 of them sit in a workflow run' <<<"$rep")" 1
ok "the foreign ones are counted apart"     "$(grep -c '3 come from workflow runs with no pipeline step' <<<"$rep")" 1

# The cost table carries the EFFORT each step ran at, because that is the only place a re-tiered
# step is visible: tokens and seconds average the old depth into the new one, so a step whose pin
# just moved looks unchanged until its new runs outnumber months of old ones.
sqlite3 "$I2" "INSERT INTO items(wf_run_id,agent_id,label,effort,tokens_in,tokens_out,tokens_cache)
  VALUES ('wf_ours','a3','fix-correctness','high',1,1,1), ('wf_ours','a4','fix-correctness','medium',1,1,1),
         ('wf_ours','a5','fix-correctness','medium',1,1,1);"
rep=$(python3 "$REPORT" --db "$I2" 2>&1)
ok "the cost table names the effort mix"    "$(grep -cE '^  fix-correctness .*medium 2 . high 1$' <<<"$rep")" 1
# A step whose items never recorded an effort must read as unknown, not as the session default —
# guessing one would invent the number this column exists to show.
ok "an unrecorded effort is a dash"         "$(grep -cE '^  implement .* —$' <<<"$rep")" 1

# --- implement depth ---------------------------------------------------------
# The depth table is the instrument behind the implementers' pinned effort: it buckets each
# implement run by the effort mined off its items and prints what the review found afterwards. It
# has three ways to lie and each is fixed here — bucketing a build-fix as a sample of the depth
# rather than an outcome of it, pairing a review that reviewed a different run, and pairing a
# DIRECT review, which is a re-review of an already-fixed diff and would credit the run with a
# second pass's findings.
P="$TMP/depth.db"
mk() { python3 "$SINK" --db "$P" >/dev/null 2>&1; }
echo '{"kind":"implement","run_id":"imp-med","ts":"2026-08-01T10:00:00+00:00","repo":"acme","profile":"full"}' | mk
echo '{"kind":"review","run_id":"rev-med","ts":"2026-08-01T11:00:00+00:00","repo":"acme","invokedBy":"run-task",
       "fixedCorrectness":3,"fixedReadability":1,"endVerify":"passed"}' | mk
echo '{"kind":"implement","run_id":"imp-high","ts":"2026-08-02T10:00:00+00:00","repo":"acme","profile":"standard"}' | mk
echo '{"kind":"review","run_id":"rev-direct","ts":"2026-08-02T11:00:00+00:00","repo":"acme","invokedBy":"direct",
       "fixedCorrectness":9,"endVerify":"passed"}' | mk
sqlite3 "$P" "INSERT INTO items(wf_run_id,agent_id,label,effort,run_id,tokens_in,tokens_out,duration_ms) VALUES
  ('wf_m','m1','implement','medium','imp-med',1000,1000,60000),
  ('wf_m','m2','build-fix','medium','imp-med',10,10,1000),
  ('wf_h','h1','implement','high','imp-high',1000,1000,60000),
  ('wf_x','x1','implement','high',NULL,1,1,1000),
  ('wf_x','x2','implement','medium',NULL,1,1,1000);"
rep=$(python3 "$REPORT" --db "$P" --review 2>&1)
ok "the depth table is printed"            "$(grep -c 'implement depth' <<<"$rep")" 1
ok "one run per workflow, one agent in it" "$(grep -cE '^  medium +1 +1 ' <<<"$rep")" 1
ok "a build-fix counts as an outcome"      "$(grep -cE '^  medium +1 +1 +[0-9.]+ +[0-9]+ +1\.00 ' <<<"$rep")" 1
ok "two efforts in one run read as mixed"  "$(grep -cE '^  mixed +1 +2 ' <<<"$rep")" 1
ok "the tier is carried across"            "$(grep -cE '^  medium +1 +1 .*full 1$' <<<"$rep")" 1
ok "the review that followed is paired"    "$(grep -cE '^  medium +1 +3\.00 +1\.00 +1/1' <<<"$rep")" 1
# The direct review sits one hour after imp-high and matches on repo and window — only invokedBy
# keeps it out, which is the whole reason the field is read.
ok "a direct review is never paired"       "$(grep -cE '^  high +0 ' <<<"$rep")" 1
ok "unpaired runs are counted out loud"    "$(grep -c '2 of 3 implement run(s) have no review' <<<"$rep")" 1
ok "a thin sample says so"                 "$(grep -c 'Thin sample' <<<"$rep")" 1

# A review beyond the window belongs to some later run, and pairing it would attribute its
# findings to code it never read.
echo '{"kind":"implement","run_id":"imp-old","ts":"2026-07-01T10:00:00+00:00","repo":"acme","profile":"full"}' | mk
echo '{"kind":"review","run_id":"rev-late","ts":"2026-07-03T10:00:00+00:00","repo":"acme","invokedBy":"run-task",
       "fixedCorrectness":7,"endVerify":"passed"}' | mk
sqlite3 "$P" "INSERT INTO items(wf_run_id,agent_id,label,effort,run_id,tokens_in,tokens_out,duration_ms)
  VALUES ('wf_o','o1','implement','high','imp-old',1,1,1000);"
rep=$(python3 "$REPORT" --db "$P" --review 2>&1)
ok "a review outside the window is not paired" "$(grep -cE '^  high +0 ' <<<"$rep")" 1

# --- plan depth and the two triage lanes ------------------------------------
# The planning half costs more per run than the implementation it feeds, and it is triaged by two
# instruments two orders of magnitude apart in cost. Both facts are only readable if the reporter
# buckets on the row the run RECORDED — the items report the tier a subagent resolved to, which is
# not the tier it was dispatched with.
Q="$TMP/plan.db"
mkq() { python3 "$SINK" --db "$Q" >/dev/null 2>&1; }
echo '{"kind":"implement","run_id":"p-hi","ts":"2026-08-10T10:00:00+00:00","repo":"acme","profile":"full",
       "planModel":"opus","planEffort":"high","judgeModel":"opus","judgeEffort":"high","findings":[
       {"track":"grounding","category":"citation","verdict":"confirmed"},
       {"track":"grounding","category":"citation","verdict":"dismissed"},
       {"track":"coverage","category":"judge","verdict":"confirmed"},
       {"track":"risk","verdict":"confirmed"}]}' | mkq
echo '{"kind":"review","run_id":"p-rev","ts":"2026-08-10T11:00:00+00:00","repo":"acme","invokedBy":"r:task-run",
       "fixedCorrectness":2,"fixedReadability":3,"endVerify":"passed"}' | mkq
# A second run with no recorded row at all — the shape every run made before the field existed.
echo '{"kind":"implement","run_id":"p-old","ts":"2026-08-11T10:00:00+00:00","repo":"acme","profile":"full"}' | mkq
sqlite3 "$Q" "INSERT INTO items(wf_run_id,agent_id,label,effort,run_id,tokens_in,tokens_out,tokens_cache,duration_ms) VALUES
  ('wf_p','p1','planner','xhigh','p-hi',10,10,1000000,100000),
  ('wf_p','p2','explore#1:x','medium','p-hi',10,10,500000,50000),
  ('wf_p','p3','cite#1.1:src/A.java','low','p-hi',10,10,100,1000),
  ('wf_p','p4','judge#1.2:src/A.java','high','p-hi',10,10,100,1000),
  ('wf_p','p5','implement','high','p-hi',10,10,100,1000),
  ('wf_q','q1','planner','xhigh','p-old',10,10,10,1000);"
rep=$(python3 "$REPORT" --db "$Q" --review 2>&1)
ok "the plan depth table is printed"       "$(grep -c 'plan depth' <<<"$rep")" 1
# Bucketed on the RECORDED row, never on the item — the planner item above says xhigh and the row
# says high. Bucketing on the item would report a tier nobody chose.
ok "it buckets on the recorded row"        "$(grep -cE '^  opus/high +1 +1\.5 ' <<<"$rep")" 1
ok "and not on the item's own effort"      "$(grep -cE '^  opus/xhigh ' <<<"$rep")" 0
ok "a run with no recorded row is apart"   "$(grep -cE '^  unrecorded +1 ' <<<"$rep")" 1
# implement is NOT a planning label: folding it in would price the planning half at the whole run.
# 1.5M is the planning labels alone. The implement item in the same workflow run carries its
# own tokens and must not be in it: folding it in would price planning at the whole run.
ok "only planning labels are costed"       "$(grep -cE '^  opus/high +1 +1\.5 +152 ' <<<"$rep")" 1
ok "both triage lanes count as batches"    "$(grep -cE '^  opus/high +1 +[0-9.]+ +[0-9]+ +2\.0 +50%' <<<"$rep")" 1
ok "the paired review is carried across"   "$(grep -cE '^  opus/high +1 +2\.00 +3\.00' <<<"$rep")" 1
ok "the judges are named beside the plan"  "$(grep -cE '^  opus/high .*opus/high 1$' <<<"$rep")" 1

# The lane split. One precision number over two instruments describes neither.
rep=$(python3 "$REPORT" --db "$Q" 2>&1)
ok "the lane table is printed"             "$(grep -c 'plan triage by lane' <<<"$rep")" 1
ok "the citation lane is read apart"       "$(grep -cE '^  grounding +citation +1 +1 +50%' <<<"$rep")" 1
ok "so is the judge lane"                  "$(grep -cE '^  coverage +judge +1 +0 +100%' <<<"$rep")" 1
# A finding written before the lanes existed was judged, but counting it as such would make the
# judge lane look larger than it has been measured.
ok "a pre-lane finding joins neither"      "$(grep -cE '^  risk +<pre-lane> ' <<<"$rep")" 1
# And with nothing but pre-lane rows there is no split to show — a table of one column is noise.
N="$TMP/nolane.db"
echo '{"kind":"implement","run_id":"n1","repo":"acme","findings":[{"track":"coverage","verdict":"confirmed"}]}' \
  | python3 "$SINK" --db "$N" >/dev/null 2>&1
ok "no lanes recorded, no lane table"      "$(python3 "$REPORT" --db "$N" 2>&1 | grep -c 'plan triage by lane')" 0

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
