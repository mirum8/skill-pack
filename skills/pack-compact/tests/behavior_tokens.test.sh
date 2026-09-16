#!/usr/bin/env bash
# Behaviour tests for behavior_tokens.py — the mechanical half of /r:pack-compact's gate.
#
#   bash skills/pack-compact/tests/behavior_tokens.test.sh
#
# The whole point of this script is that it disagrees when a rewrite lost something. So the suite
# has to prove BOTH directions on every rule: that a faithful reword passes, and that a lossy one
# fails. A checker that only ever says yes is indistinguishable from no checker at all, and it is
# the shape that ships green — /r:pack-compact would report a clean compaction over a file missing
# a flag, and nothing downstream re-reads the prose to notice.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
BT="skills/pack-compact/scripts/behavior_tokens.py"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# want <name> <expected-exit> <args...> — runs the script, captures stdout in $OUT
want() {
  local name=$1 code=$2; shift 2
  OUT=$(python3 "$BT" "$@" 2>&1); local rc=$?
  [[ $rc == "$code" ]] && ok "$name" || bad "$name" "exit $rc, wanted $code: $(head -c 300 <<<"$OUT")"
}

# names <name> <needle> — the failure report must name what was lost, or it cannot be acted on
names() {
  grep -q -- "$2" <<<"$OUT" && ok "$1" || bad "$1" "report never mentions '$2'"
}

echo "== tokens: a faithful reword keeps every hard token =="
cat > "$TMP/old.md" <<'EOF'
Use `--herdr` to fan out, capped by `steps.fanout.maxUnits` (default 3).
Run `${CLAUDE_PLUGIN_ROOT}/skills/plan-run/scripts/fanout.sh`.
Measured over 52 real runs, `standard` was chosen zero times. IMPL_RUN is the fallback.
The payload carries `blockedReason` and `tracksDrifted`. Dispatch r:bug-hunter-pattern.
EOF
cat > "$TMP/reworded.md" <<'EOF'
`--herdr` fans out, capped by `steps.fanout.maxUnits` (default 3); invoke
`${CLAUDE_PLUGIN_ROOT}/skills/plan-run/scripts/fanout.sh`. Over 52 real runs `standard`
was chosen zero times; IMPL_RUN is the fallback. Payload: `blockedReason`, `tracksDrifted`.
Dispatches r:bug-hunter-pattern.
EOF
want "reworded file passes" 0 tokens --before "$TMP/old.md" --after "$TMP/reworded.md"

echo "== tokens: each kind of loss is caught and named =="
for kind in flag path number const key skill; do
  case $kind in
    flag)   sed 's/`--herdr`/the herd flag/'                       ;;
    path)   sed 's|`${CLAUDE_PLUGIN_ROOT}/skills/plan-run/scripts/fanout.sh`|the fanout script|' ;;
    number) sed 's/over 52 real runs/rarely/i'                     ;;
    const)  sed 's/IMPL_RUN/the constant/'                         ;;
    key)    sed 's/`tracksDrifted`/the drift field/'               ;;
    skill)  sed 's/r:bug-hunter-pattern/the pattern hunter/'       ;;
  esac < "$TMP/reworded.md" > "$TMP/lossy.md"
  want "losing a $kind fails" 1 tokens --before "$TMP/old.md" --after "$TMP/lossy.md"
done
sed 's/`--herdr`/the herd flag/' < "$TMP/reworded.md" > "$TMP/lossy.md"
want "a lost flag is reported, not just counted" 1 tokens --before "$TMP/old.md" --after "$TMP/lossy.md"
names "the report names the lost flag" -- "--herdr"

echo "== tokens: extraction is not loss — the union of the new files is what counts =="
head -2 "$TMP/reworded.md" > "$TMP/split-a.md"
tail -2 "$TMP/reworded.md" > "$TMP/split-b.md"
want "one half alone fails"  1 tokens --before "$TMP/old.md" --after "$TMP/split-a.md"
want "both halves together pass" 0 tokens --before "$TMP/old.md" --after "$TMP/split-a.md" "$TMP/split-b.md"

echo "== code-identical: comments may change, code may not =="
cat > "$TMP/old.js" <<'EOF'
// A long explanation nobody needs twice.
// Observed on wf_0df046aa-cde: build green over a tree nobody built.
export const meta = { name: 'run-task-implement' }
const cap = 3        // trailing comments count as CODE to this gate
function go() {
  return cap
}
EOF
cat > "$TMP/rewritten.js" <<'EOF'
// A `build: green` handoff can describe a tree nobody built.
export const meta = { name: 'run-task-implement' }
const cap = 3        // trailing comments count as CODE to this gate
function go() {
  return cap
}
EOF
want "a comment-only rewrite passes" 0 code-identical --before "$TMP/old.js" --after "$TMP/rewritten.js"

sed 's/const cap = 3/const cap = 4/' "$TMP/rewritten.js" > "$TMP/changed.js"
want "changing one literal fails" 1 code-identical --before "$TMP/old.js" --after "$TMP/changed.js"
names "the report shows the changed line" "cap = 4"

sed "s/name: 'run-task-implement'/name: 'task-run-implement'/" "$TMP/rewritten.js" > "$TMP/renamed.js"
want "renaming the guarded meta.name fails" 1 code-identical --before "$TMP/old.js" --after "$TMP/renamed.js"

sed 's|const cap = 3        // trailing.*|const cap = 3|' "$TMP/rewritten.js" > "$TMP/trailing.js"
want "dropping a TRAILING comment fails, by design" 1 code-identical --before "$TMP/old.js" --after "$TMP/trailing.js"

printf 'export const meta = { name: %s }\n' "'run-task-implement'" > "$TMP/stripped.js"
want "deleting code with the comments fails" 1 code-identical --before "$TMP/old.js" --after "$TMP/stripped.js"

echo "== the real pipelines are comment-only against themselves =="
for wf in skills/task-run/task-run-implement.workflow.js skills/task-review/task-review.workflow.js; do
  want "$(basename "$wf") is identical to itself" 0 code-identical --before "$wf" --after "$wf"
done

echo "== a check that could not run is a failure, never a pass =="
want "a missing --before file exits non-zero" 1 tokens --before "$TMP/absent.md" --after "$TMP/old.md"

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ $fail == 0 ]]
