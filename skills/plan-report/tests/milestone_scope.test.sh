#!/usr/bin/env bash
# Behaviour tests for milestone_scope.py — the scope resolver behind /r:plan-report and the
# milestone boundary in /r:plan-run.
#
#   bash skills/plan-report/tests/milestone_scope.test.sh
#
# Everything here guards one failure shape: a confident wrong answer. This script decides WHICH
# phases a report is about and WHETHER a milestone is finished, and both fail silently — a report
# scoped to the wrong phases still renders, and a milestone called complete one phase early still
# produces a document that reads as authoritative. There is no CI, so this suite is the only thing
# checking either.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
SCOPE="skills/plan-report/scripts/milestone_scope.py"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# jq is not a dependency of the pack, so read the JSON with python.
q() { python3 -c 'import json,sys; print(json.dumps(eval(sys.argv[1], {"d": json.load(sys.stdin)})))' "$1"; }

# run <name> <expected-exit> <args...> — captures stdout into $OUT
run() {
  local name=$1 want=$2; shift 2
  OUT=$(python3 "$SCOPE" "$@" 2>"$TMP/err"); local rc=$?
  if [[ $rc != "$want" ]]; then
    bad "$name" "exit $rc, wanted $want: $(head -c 300 "$TMP/err")"; return 1
  fi
  ok "$name"
}

# eq <name> <expr> <expected-json>
eq() {
  local got; got=$(printf '%s' "$OUT" | q "$2")
  [[ "$got" == "$3" ]] && ok "$1" || bad "$1" "$2 = $got, wanted $3"
}

echo "== a plan with milestones =="
PLAN="$TMP/todo.md"
cat > "$PLAN" <<'EOF'
# Billing — Implementation Plan

## Milestone 1 — Ledger
Contracts: `design.md#milestone-1-ledger`

### Phase 1 — Ledger schema <!-- built: phase-ledger-schema -->
**Implements:** Record a ledger entry
**Files:** `db/V1__ledger.sql` (new)
**Risk:** money + persistence
- [x] `ledger_entry` table with an index
**Done when:** `mvn test -Dtest=LedgerSchemaIT` is green.

### Phase 2 — Ledger API <!-- built: phase-ledger-api -->
**Files:** `web/Api.java` (new)
- [x] endpoint returns 200
- [x] 404 on unknown account

## Milestone 2 - Payouts

### Phase 3 — Payout store
**Files:** `db/V2__payout.sql` (new)
- [x] table created
- [ ] index still missing
EOF

run "a complete milestone is reported complete" 0 "$PLAN" --complete
eq  "only milestone 1 comes back" 'd["milestones"][0]["n"]' '1'
eq  "and it is the only one" 'len(d["milestones"])' '1'
eq  "its phases are 1 and 2" 'd["milestones"][0]["phases"]' '[1, 2]'
eq  "it has no report yet" 'd["unreported"]' '[1]'

run "the full list carries both" 0 "$PLAN" --list
eq  "two milestones" 'len(d["milestones"])' '2'
eq  "a half-ticked milestone is NOT complete" 'd["milestones"][1]["complete"]' 'false'
eq  "and its progress is visible" 'd["milestones"][1]["ticked"]' '1'

# A hyphen is the other dash the plan format allows, and a heading the resolver cannot see is a
# phase that silently belongs to no milestone — the report would then be scoped to nothing.
eq  "a hyphen heading is a milestone too" 'd["milestones"][1]["name"]' '"Payouts"'
eq  "the contracts pointer is carried" 'd["milestones"][0]["contracts"]' '"`design.md#milestone-1-ledger`"'

echo
echo "== a report that already exists is not offered again =="
mkdir -p "$TMP/reports"
cp /dev/null "$TMP/reports/milestone-1-ledger.html"
run "reportExists flips" 0 "$PLAN" --complete
eq  "the milestone is still complete" 'd["milestones"][0]["complete"]' 'true'
eq  "but nothing is unreported" 'd["unreported"]' '[]'
rm -rf "$TMP/reports"

echo
echo "== a flat plan has no milestones, and that is an ANSWER =="
FLAT="$TMP/flat.md"
cat > "$FLAT" <<'EOF'
### Phase 1 — Do a thing
- [x] done
### Phase 2 — Do another
- [ ] pending
EOF
run "a flat plan exits 0, not 1" 0 "$FLAT" --list
eq  "hasMilestones is false" 'd["hasMilestones"]' 'false'
eq  "the list is empty, never invented" 'd["milestones"]' '[]'
eq  "its phases are named as unassigned" 'd["unassignedPhases"]' '[1, 2]'
run "--complete on a flat plan is also an answer" 0 "$FLAT" --complete
eq  "nothing is complete" 'd["milestones"]' '[]'

echo
echo "== an empty milestone heading is not a complete one =="
EMPTY="$TMP/empty.md"
cat > "$EMPTY" <<'EOF'
## Milestone 1 — Nothing here yet

## Milestone 2 — Real work
### Phase 1 — A leaf
- [x] done
EOF
run "an empty heading parses" 0 "$EMPTY" --complete
eq  "only the milestone with phases is complete" '[m["n"] for m in d["milestones"]]' '[2]'

echo
echo "== a phase with no checkboxes cannot be complete =="
NOITEMS="$TMP/noitems.md"
cat > "$NOITEMS" <<'EOF'
## Milestone 1 — Prose only
### Phase 1 — A leaf with no checklist
**Files:** `a.txt` (new)
EOF
run "it parses" 0 "$NOITEMS" --complete
eq  "and is not complete — no items is not all items ticked" 'd["milestones"]' '[]'

echo
echo "== landing commits, in a real repo =="
REPO="$TMP/repo"; mkdir -p "$REPO/docs/billing"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email t@t; git -C "$REPO" config user.name t
RPLAN="$REPO/docs/billing/todo.md"
cat > "$RPLAN" <<'EOF'
## Milestone 1 — Ledger
### Phase 1 — Ledger schema
- [ ] table
### Phase 2 — Ledger API
- [ ] endpoint
EOF
git -C "$REPO" add -A >/dev/null; git -C "$REPO" commit -qm "plan"

# Phase 1 lands the way /r:plan-run lands one: code, ticks and the marker in ONE commit.
echo "create table ledger_entry();" > "$REPO/docs/billing/../../V1.sql"
sed -i.bak 's|### Phase 1 — Ledger schema|### Phase 1 — Ledger schema <!-- built: phase-ledger-schema -->|; s|- \[ \] table|- [x] table|' "$RPLAN"
rm -f "$RPLAN.bak"
git -C "$REPO" add -A >/dev/null; git -C "$REPO" commit -qm "Phase 1"
SHA1=$(git -C "$REPO" rev-parse HEAD)

# An unrelated commit afterwards must not be mistaken for the phase's.
echo "noise" > "$REPO/noise.txt"; git -C "$REPO" add -A >/dev/null; git -C "$REPO" commit -qm noise

run "a milestone resolves inside a repo" 0 "$RPLAN" --milestone 1 --repo "$REPO"
eq  "phase 1's landing commit is its own commit" 'd["phases"][0]["commit"]' "\"$SHA1\""
eq  "and its changed files come from that commit" '"V1.sql" in d["phases"][0]["changedFiles"]' 'true'
eq  "the noise commit is not attributed to it" '"noise.txt" in d["phases"][0]["changedFiles"]' 'false'

# Phase 2 never landed, so nothing names its commit — and that gap must be SAID, not left null.
eq  "an unbuilt phase has no commit" 'd["phases"][1]["commit"]' 'null'
eq  "and the reason is named" 'd["phases"][1]["commitNote"] is not None' 'true'
eq  "unresolved commits are counted" 'd["unresolvedCommits"]' '1'

echo
echo "== a plan outside any repo names the gap rather than guessing =="
run "it still answers" 0 "$PLAN" --milestone 1 --repo "$TMP"
eq  "no commit" 'd["phases"][0]["commit"]' 'null'
eq  "with a reason" 'd["phases"][0]["commitNote"] is not None' 'true'

echo
echo "== usage errors are never a silent pass =="
run "a missing plan exits 1" 1 "$TMP/nosuch.md" --list
run "no mode at all exits 1" 1 "$PLAN"
run "a milestone the plan does not have exits 1" 1 "$PLAN" --milestone 99
run "--milestone with no number exits 1" 1 "$PLAN" --milestone

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
