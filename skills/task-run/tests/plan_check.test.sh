#!/usr/bin/env bash
# Behaviour tests for plan_check.py — the gate task-run-implement.workflow.js runs between the
# scribe that writes a plan and the Codex review that challenges it.
#
#   bash skills/task-run/tests/plan_check.test.sh
#
# Everything here guards one failure shape: a confident wrong answer about a plan. Both directions
# are wrong in their own way and both are silent. A check that flags a sound plan produces a wall of
# findings nobody reads, and the run then pays an editor to "fix" text that was right — measured
# while building this: reading bare `rail.go:72` citations against the repo root alone called 2170
# of 3574 references across 48 real plans broken, and reading only `-` bullets found ZERO test
# entries in half of them. A check that passes an unsound plan is worse, because the expensive
# reviewer behind it was the thing being made cheaper. There is no CI, so this suite is the only
# thing checking either.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
SCRIPT="skills/task-run/scripts/plan_check.py"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# jq is not a dependency of the pack, so read the JSON with python.
q() { python3 -c 'import json,sys; print(json.dumps(eval(sys.argv[1], {"d": json.load(sys.stdin)})))' "$1"; }

# run <name> <expected-exit> <args...> — captures stdout into $OUT
run() {
  local name=$1 want=$2; shift 2
  OUT=$(python3 "$SCRIPT" "$@" 2>"$TMP/err"); local rc=$?
  if [[ $rc != "$want" ]]; then
    bad "$name" "exit $rc, wanted $want: $(head -c 300 "$TMP/err")"; return 1
  fi
  ok "$name"
}

# eq <name> <expr over d> <expected-json>
eq() {
  local got; got=$(printf '%s' "$OUT" | q "$2")
  [[ "$got" == "$3" ]] && ok "$1" || bad "$1" "$2 = $got, wanted $3"
}

# A throwaway repo the plans can cite. Real files with real lengths, because "does line 900 exist"
# is the question under test and a fixture that fakes it tests nothing.
REPO="$TMP/repo"
mkdir -p "$REPO/internal/ui" "$REPO/internal/store" "$REPO/cmd"
python3 - "$REPO" <<'PY'
import sys, pathlib
root = pathlib.Path(sys.argv[1])
for rel, n in (("internal/ui/rail.go", 200), ("internal/store/store.go", 300),
               ("internal/ui/table.go", 50), ("cmd/table.go", 50)):
    (root / rel).write_text("".join(f"line {i}\n" for i in range(1, n + 1)))
PY
git -C "$REPO" init -q -b main >/dev/null 2>&1
git -C "$REPO" add -A >/dev/null 2>&1

PLAN="$TMP/plan.md"

echo "== a sound plan is clean, and every section is found =="
cat > "$PLAN" <<'EOF'
status: reviewing
tier: full

## Context

Adds a rail. internal/ui/rail.go:10

## Files to change and the approach

1. **`internal/ui/rail.go`** — widen the rail. internal/ui/rail.go:42

## Reuse map

| Existing pattern | Evidence | How it is reused |
|---|---|---|
| Store locking | internal/store/store.go:125 | Same lock path. |

## Assumptions & risks

None.

## Alternatives considered

A second approach was weighed.

## TDD test plan

- [RED] `TestRailWidens`: assert the rail grows. The current rail has no width field. internal/ui/rail.go:42
- [GREEN] `TestRailStillDraws`: guards existing drawing. internal/ui/rail.go:10

## Verification steps

Run the suite.

## Coverage contract

| Criterion | Implemented in | Test | Verified by |
|---|---|---|---|
| AC-1 | `internal/ui/rail.go` | `TestRailWidens` | step 1 |
EOF
run "sound plan reports" 0 "$PLAN" --report --repo "$REPO" --criteria '["AC-1: the rail widens"]'
eq  "no section is missing"        'd["sections"]["missing"]' '[]'
eq  "every citation resolves"      'len(d["unresolved"])' '0'
# The exact set, not a count: it pins that Context is NOT scanned (a citation there is narrative,
# not a claim the plan rests on) and that the same line cited twice is ONE claim.
eq  "exactly the claim-bearing citations" 'sorted(c["where"] for c in d["citations"])' '["internal/store/store.go:125", "internal/ui/rail.go:10", "internal/ui/rail.go:42"]'
eq  "both test entries are read"   'len(d["tests"]["entries"])' '2'
eq  "nothing is untagged"          'd["tests"]["untagged"]' '[]'
eq  "the RED justified itself"     'd["tests"]["redUnjustified"]' '[]'
eq  "coverage matched on AC ids"   'd["coverage"]["mode"]' '"ac-ids"'
eq  "nothing uncovered"            'd["coverage"]["uncovered"]' '[]'
run "and --check exits 0 on it" 0 "$PLAN" --check --repo "$REPO" --criteria '["AC-1: the rail widens"]'
eq  "with no problems"             'd["problems"]' '[]'

echo
echo "== rule 1: a citation that does not resolve is a problem =="
cat > "$PLAN" <<'EOF'
## Context
c
## Files to change and the approach
Touches internal/ui/gone.go:12 and internal/ui/rail.go:900 and internal/ui/rail.go:42
## Reuse map
none
## Assumptions & risks
none
## Alternatives considered
none
## TDD test plan
- [GREEN] `TestX`: guards it.
## Verification steps
run it
## Coverage contract
| Criterion | Implemented in | Test | Verified by |
|---|---|---|---|
| AC-1 | `internal/ui/rail.go` | `TestX` | step 1 |
EOF
run "unresolved citations report" 0 "$PLAN" --report --repo "$REPO"
eq  "a missing file is caught"      '[c["where"] for c in d["unresolved"] if c["file"].endswith("gone.go")]' '["internal/ui/gone.go:12"]'
eq  "a line past EOF is caught"     '[c["why"] for c in d["unresolved"] if c["line"]==900]' '["internal/ui/rail.go has 200 line(s)"]'
eq  "and the good one is not"       'len([c for c in d["citations"] if c["line"]==42 and c["resolves"]])' '1'
run "--check fails on them" 1 "$PLAN" --check --repo "$REPO"

echo
echo "== a BARE BASENAME resolves when it names exactly one file, and is ambiguous when it names two =="
# The regression that mattered most: plans write `rail.go:72` because the prose already said which
# package. Reading those against the repo root alone is what called 61% of real citations broken.
cat > "$PLAN" <<'EOF'
## Context
c
## Files to change and the approach
Widen rail.go:72, then table.go:9, then internal/ui/rail.go:9
## Reuse map
none
## Assumptions & risks
none
## Alternatives considered
none
## TDD test plan
- [GREEN] `TestX`: guards it.
## Verification steps
run it
## Coverage contract
| Criterion | Implemented in | Test | Verified by |
|---|---|---|---|
| AC-1 | x | `TestX` | step 1 |
EOF
run "bare basenames report" 0 "$PLAN" --report --repo "$REPO"
eq  "a unique basename resolves"   '[c["resolvedAs"] for c in d["citations"] if c["where"]=="rail.go:72"]' '["internal/ui/rail.go"]'
eq  "and is not a problem"         '[c["resolves"] for c in d["citations"] if c["where"]=="rail.go:72"]' '[true]'
eq  "a basename naming two files is AMBIGUOUS" '[c["where"] for c in d["ambiguous"]]' '["table.go:9"]'
eq  "ambiguous is not unresolved"  '[c["where"] for c in d["unresolved"]]' '[]'
run "so --check passes it" 0 "$PLAN" --check --repo "$REPO"

echo
echo "== a FULL path that misses is a moved file, never re-pointed at a same-named sibling =="
cat > "$PLAN" <<'EOF'
## Context
c
## Files to change and the approach
See internal/store/table.go:9
## Reuse map
none
## Assumptions & risks
none
## Alternatives considered
none
## TDD test plan
- [GREEN] `TestX`: guards it.
## Verification steps
run it
## Coverage contract
| Criterion | Implemented in | Test | Verified by |
|---|---|---|---|
| AC-1 | x | `TestX` | step 1 |
EOF
run "a moved full path reports" 0 "$PLAN" --report --repo "$REPO"
eq  "it stays unresolved"          '[c["where"] for c in d["unresolved"]]' '["internal/store/table.go:9"]'
eq  "and was never re-pointed"     '[c["resolvedAs"] for c in d["citations"] if c["line"]==9]' '[""]'

echo
echo "== rule 2: a criterion with no row, or a row naming no test, is uncovered =="
cat > "$PLAN" <<'EOF'
## Context
c
## Files to change and the approach
internal/ui/rail.go:42
## Reuse map
none
## Assumptions & risks
none
## Alternatives considered
none
## TDD test plan
- [GREEN] `TestOne`: guards it.
## Verification steps
run it
## Coverage contract
| Criterion | Implemented in | Test | Verified by |
|---|---|---|---|
| AC-1 | `internal/ui/rail.go` | `TestOne` | step 1 |
| AC-2 | `internal/ui/rail.go` | proven by reading the page carefully | step 2 |
EOF
run "partial coverage reports" 0 "$PLAN" --report --repo "$REPO" --criteria '["AC-1: one","AC-2: two","AC-3: three"]'
eq  "a prose test cell is no test" 'd["coverage"]["uncovered"]' '["AC-2", "AC-3"]'
eq  "the named one is covered"     '[r["namesTest"] for r in d["coverage"]["rows"] if r["key"]=="AC-1"]' '[true]'
run "--check fails on it" 1 "$PLAN" --check --repo "$REPO" --criteria '["AC-1: one","AC-2: two","AC-3: three"]'

echo
echo "== rule 6: no --criteria SKIPS the coverage check and says so — never 'clean' =="
run "no criteria reports" 0 "$PLAN" --report --repo "$REPO"
eq  "mode is skipped"              'd["coverage"]["mode"]' '"skipped"'
eq  "and it is not silent"         '"skip, not a clean result" in d["coverage"]["note"]' 'true'
eq  "nothing is claimed covered"   'd["coverage"]["uncovered"]' '[]'
run "--check does not fail for it" 0 "$PLAN" --check --repo "$REPO"
eq  "and no problem blames coverage" '[p for p in d["problems"] if "coverage row" in p]' '[]'

echo
echo "== an EMPTY criteria array is an answer, not a skip =="
run "empty criteria reports" 0 "$PLAN" --report --repo "$REPO" --criteria '[]'
eq  "the check ran"                'd["coverage"]["mode"] != "skipped"' 'true'
eq  "with nothing to cover"        'd["coverage"]["uncovered"]' '[]'

echo
echo "== a paraphrase-keyed table falls back to counting, and SAYS it counted =="
cat > "$PLAN" <<'EOF'
## Context
c
## Files to change and the approach
internal/ui/rail.go:42
## Reuse map
none
## Assumptions & risks
none
## Alternatives considered
none
## TDD test plan
- [GREEN] `TestOne`: guards it.
## Verification steps
run it
## Coverage contract
| Acceptance criterion | Implemented in | Test | Verified by |
|---|---|---|---|
| The rail widens when asked | `internal/ui/rail.go` | `TestOne` | step 1 |
EOF
run "paraphrase table reports" 0 "$PLAN" --report --repo "$REPO" --criteria '["the rail widens","the rail narrows"]'
eq  "mode is positional"           'd["coverage"]["mode"]' '"positional"'
eq  "the missing row is caught"    'd["coverage"]["uncovered"]' '["AC-2"]'
eq  "and the weaker answer is named" '"misaligned one is not" in d["coverage"]["note"]' 'true'

echo
echo "== rules 3 and 4: tags and justifications =="
cat > "$PLAN" <<'EOF'
## Context
c
## Files to change and the approach
internal/ui/rail.go:42
## Reuse map
none
## Assumptions & risks
none
## Alternatives considered
none
## TDD test plan

1. **`TestJustifiedByProse`** **[RED]** — assert the rail widens. Fails today: the rail has no width field.
2. **`TestJustifiedByCitation`** **[RED — compile]** — assert the store locks. internal/store/store.go:125
3. **`TestBare`** **[RED]** — assert the rail widens to 40 columns.
4. **`TestNoTag`** — assert something else entirely.
   - (a) a lettered sub-step belonging to the entry above, with no tag of its own
   - (b) another sub-step

## Verification steps
run it
## Coverage contract
| Criterion | Implemented in | Test | Verified by |
|---|---|---|---|
| AC-1 | x | `TestBare` | step 1 |
EOF
run "tagging reports" 0 "$PLAN" --report --repo "$REPO"
eq  "numbered entries are read"        'len(d["tests"]["entries"])' '4'
eq  "a QUALIFIED tag still counts"     '[e["tag"] for e in d["tests"]["entries"]][1]' '"RED"'
eq  "prose justifies a RED"            '[e["justified"] for e in d["tests"]["entries"]][0]' 'true'
eq  "a citation justifies a RED"       '[e["justified"] for e in d["tests"]["entries"]][1]' 'true'
eq  "a bare RED is unjustified"        '[t.split("`")[1] for t in d["tests"]["redUnjustified"]]' '["TestBare"]'
eq  "an untagged entry is untagged"    'len(d["tests"]["untagged"])' '1'
eq  "and it is not read as GREEN"      '[e["tag"] for e in d["tests"]["entries"]][3]' 'null'
eq  "SUB-STEPS ARE NOT TEST ENTRIES"   '[t for t in d["tests"]["untagged"] if "sub-step" in t]' '[]'
run "--check fails on both" 1 "$PLAN" --check --repo "$REPO"
eq  "naming each"                      'len([p for p in d["problems"] if "[RED] entry" in p or "neither [RED]" in p])' '2'

echo
echo "== rule 5: a missing section is a problem, and a near-miss title is not =="
cat > "$PLAN" <<'EOF'
## Context
c
## Files to change and approach
internal/ui/rail.go:42
## Reuse map
none
## TDD test plan
- [GREEN] `TestOne`: guards it.
## Coverage contract
| Criterion | Implemented in | Test | Verified by |
|---|---|---|---|
| AC-1 | x | `TestOne` | step 1 |
EOF
run "a short plan reports" 0 "$PLAN" --report --repo "$REPO"
eq  "the near-miss title counts as present" '"files to change" in d["sections"]["present"]' 'true'
eq  "the genuinely absent one is named"     'd["sections"]["missing"]' '["verification steps"]'
run "at the light tier it owes less" 0 "$PLAN" --report --repo "$REPO" --tier light
eq  "so nothing is missing there"           'd["sections"]["missing"]' '[]'

echo
echo "== a fenced block is an example, never a claim =="
cat > "$PLAN" <<'EOF'
## Context
c
## Files to change and the approach
Run it like this:

```sh
grep -n x internal/ui/imaginary.go:1
```

Then edit internal/ui/rail.go:42
## Reuse map
none
## Assumptions & risks
none
## Alternatives considered
none
## TDD test plan
- [GREEN] `TestOne`: guards it.
## Verification steps
run it
## Coverage contract
| Criterion | Implemented in | Test | Verified by |
|---|---|---|---|
| AC-1 | x | `TestOne` | step 1 |
EOF
run "a fenced example reports" 0 "$PLAN" --report --repo "$REPO"
eq  "the fenced path is not cited"  '[c["where"] for c in d["citations"]]' '["internal/ui/rail.go:42"]'

echo
echo "== usage errors are never a silent pass =="
run "no arguments at all"          1
run "a missing plan file"          1 "$TMP/nope.md" --report
run "no mode"                      1 "$PLAN" --repo "$REPO"
run "an unknown tier"              1 "$PLAN" --report --tier bogus
run "--criteria that is not JSON"  1 "$PLAN" --report --criteria 'not json'
run "--criteria that is not a list" 1 "$PLAN" --report --criteria '{"a":1}'
run "--criteria with no value"     1 "$PLAN" --report --criteria
run "--tier with no value"         1 "$PLAN" --report --tier

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
