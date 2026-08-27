#!/usr/bin/env bash
# Behaviour tests for check_todo.py's graph layer — the edges, the derived waves, the
# same-wave collision check, the self-containment rule and the --slice preflight.
#
#   bash skills/spec-design/tests/check_todo.test.sh
#
# The graph layer is what /r:plan-run's concurrency preflight trusts, and a wrong answer there
# means two sessions building the same file at once. There is no CI, so this is the only thing
# standing between an edit here and that.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
CHECK="skills/spec-design/scripts/check_todo.py"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# Every fixture is a WHOLE plan, written out in full rather than patched from a base. A plan is
# 30 lines and the defect under test is one of them; a shared base with an override would make
# each case's actual input something the reader has to reconstruct. KISS > DRY in tests.
plan() { cat > "$TMP/todo.md"; }

# says <name> <pattern> — the checker reports it
says() {
  local out; out=$(python3 "$CHECK" "$TMP/todo.md" 2>&1)
  grep -qiE "$2" <<<"$out" && ok "$1" || bad "$1" "no match for /$2/ in:${out:0:400}"
}
# silent <name> <pattern> — the checker does NOT report it
silent() {
  local out; out=$(python3 "$CHECK" "$TMP/todo.md" 2>&1)
  grep -qiE "$2" <<<"$out" && bad "$1" "unexpected /$2/ in:${out:0:400}" || ok "$1"
}
# slice <name> <spec> <expected-exit>
slice() {
  local out; out=$(python3 "$CHECK" "$TMP/todo.md" --slice "$2" 2>&1); local rc=$?
  [[ $rc == "$3" ]] && ok "$1" || bad "$1" "exit $rc, wanted $3:${out:0:400}"
}

echo "== a clean two-wave plan =="
plan <<'EOF'
# Demo — Implementation Plan

## Milestone 1 — Core
**Design**
- Schema `thing(id uuid primary key, name text not null)`

### Phase 1 — Thing store
**Implements:** Store a thing
**Depends on:** —
**Files:** `db/V1__thing.sql` (new)
- [ ] `V1__thing.sql` creates `thing` with a primary key on `id`
**Done when:** `mvn test -Dtest=ThingRepositoryIT` is green.

### Phase 2 — Thing API
**Implements:** Read a thing
**Depends on:** Phase 1
**Files:** `web/ThingController.java` (new)
- [ ] `GET /things/{id}` returns `200` with the thing, `404` when absent
**Done when:** `curl -s localhost:8080/things/1` returns the thing.

### Phase 3 — Thing metrics
**Implements:** Store a thing
**Depends on:** Phase 1
**Files:** `web/ThingMetrics.java` (new)
- [ ] `ThingMetrics` counts writes, exposed at `/actuator/metrics`
**Done when:** `curl -s localhost:8080/actuator/metrics` lists the counter.
EOF
silent "clean plan reports no problems"          "problem\(s\) in"
says   "prints the derived wave table"           "waves \(derived"
says   "wave 1 holds the two independent leaves" "wave 1: Phase 2, Phase 3"
says   "names what can run concurrently"         "2 can run concurrently"
slice  "slice 2,3 is safe"                       "2,3" 1
slice  "slice 1 alone is safe"                   "1"   0

echo
echo "== a leaf with no Depends on line =="
plan <<'EOF'
### Phase 1 — Thing store
**Implements:** Store a thing
**Files:** `db/V1__thing.sql` (new)
- [ ] `V1__thing.sql` creates `thing`
**Done when:** `mvn test` is green.
EOF
says "missing edges are reported" "no 'Depends on' line"

echo
echo "== a forward dependency =="
plan <<'EOF'
### Phase 1 — A
**Implements:** S
**Depends on:** Phase 2
**Files:** `a.java` (new)
- [ ] does `a`
**Done when:** `mvn test` is green.

### Phase 2 — B
**Implements:** S
**Depends on:** —
**Files:** `b.java` (new)
- [ ] does `b`
**Done when:** `mvn test` is green.
EOF
says "a backward edge is reported" "comes AFTER it"

echo
echo "== a dependency cycle =="
plan <<'EOF'
### Phase 1 — A
**Implements:** S
**Depends on:** Phase 2
**Files:** `a.java` (new)
- [ ] does `a`
**Done when:** `mvn test` is green.

### Phase 2 — B
**Implements:** S
**Depends on:** Phase 1
**Files:** `b.java` (new)
- [ ] does `b`
**Done when:** `mvn test` is green.
EOF
says "a cycle is reported" "cycle"

echo
echo "== two leaves in one wave touching one file =="
plan <<'EOF'
### Phase 1 — A
**Implements:** S
**Depends on:** —
**Files:** `shared/Service.java` (modify)
- [ ] adds `a()` to `Service`
**Done when:** `mvn test` is green.

### Phase 2 — B
**Implements:** S
**Depends on:** —
**Files:** `shared/Service.java` (modify)
- [ ] adds `b()` to `Service`
**Done when:** `mvn test` is green.
EOF
says  "a same-wave collision is reported" "cannot run concurrently"
slice "the colliding slice is refused"    "1,2" 1

echo
echo "== the plan file itself is not a collision =="
plan <<'EOF'
### Phase 1 — A
**Implements:** S
**Depends on:** —
**Files:** `a.java` (new) · `todo.md` (modify)
- [ ] does `a`
**Done when:** `mvn test` is green.

### Phase 2 — B
**Implements:** S
**Depends on:** —
**Files:** `b.java` (new) · `todo.md` (modify)
- [ ] does `b`
**Done when:** `mvn test` is green.
EOF
silent "every leaf ticks the plan, so it is excluded" "cannot run concurrently"

echo
echo "== generated artefacts are not a collision, but source beside them still is =="
plan <<'EOF'
### Phase 1 — A
**Implements:** S
**Depends on:** —
**Files:** `a.java` (new) · `src/testdata/fix.json` · `ui/testdata/help.golden` · `.claude/skills/test-app/e2e/frames/00.txt`
- [ ] does `a`
**Done when:** `mvn test` is green.

### Phase 2 — B
**Implements:** S
**Depends on:** —
**Files:** `b.java` (new) · `src/testdata/fix.json` · `ui/testdata/help.golden` · `.claude/skills/test-app/e2e/frames/00.txt`
- [ ] does `b`
**Done when:** `mvn test` is green.
EOF
silent "a shared capture, golden and testdata fixture are not a collision" "cannot run concurrently"

plan <<'EOF'
### Phase 1 — A
**Implements:** S
**Depends on:** —
**Files:** `shared.java` (modify) · `.claude/skills/test-app/e2e/frames/00.txt`
- [ ] does `a`
**Done when:** `mvn test` is green.

### Phase 2 — B
**Implements:** S
**Depends on:** —
**Files:** `shared.java` (modify) · `.claude/skills/test-app/e2e/frames/00.txt`
- [ ] does `b`
**Done when:** `mvn test` is green.
EOF
says  "the source file among them is still reported" "shared\.java"
slice "and --slice refuses that pair"                "1,2" 1

echo
echo "== a leaf item that defers outside its block =="
plan <<'EOF'
### Phase 1 — A
**Implements:** S
**Depends on:** —
**Files:** `a.java` (new)
- [ ] build the endpoint per the milestone design above
**Done when:** `mvn test` is green.
EOF
says "a dangling contract pointer is reported" "defers outside its own block"

echo
echo "== a stale wave summary =="
plan <<'EOF'
## Waves
- Wave 0: Phase 1, Phase 2

### Phase 1 — A
**Implements:** S
**Depends on:** —
**Files:** `a.java` (new)
- [ ] does `a`
**Done when:** `mvn test` is green.

### Phase 2 — B
**Implements:** S
**Depends on:** Phase 1
**Files:** `b.java` (new)
- [ ] does `b`
**Done when:** `mvn test` is green.
EOF
says "a drifted summary is reported" "does not match the 'Depends on' edges"

echo
echo "== a partly-executed plan (what plan-run's preflight actually sees) =="
plan <<'EOF'
### Phase 1 — A
**Implements:** S
**Depends on:** —
**Files:** `a.java` (new)
- [x] does `a`
**Done when:** `mvn test` is green.

### Phase 2 — B
**Implements:** S
**Depends on:** Phase 1
**Files:** `b.java` (new)
- [ ] does `b`
**Done when:** `mvn test` is green.
EOF
silent "a finished leaf is not 'no checklist items'" "no checklist items"
slice  "its dependency is built, so the slice is safe" "2" 0

echo
echo "== a slice whose dependency is NOT built =="
plan <<'EOF'
### Phase 1 — A
**Implements:** S
**Depends on:** —
**Files:** `a.java` (new)
- [ ] does `a`
**Done when:** `mvn test` is green.

### Phase 2 — B
**Implements:** S
**Depends on:** Phase 1
**Files:** `b.java` (new)
- [ ] does `b`
**Done when:** `mvn test` is green.
EOF
slice "an unbuilt dependency refuses the slice" "2"   1
slice "and so does a slice holding both ends"   "1,2" 1

# ---------------------------------------------------------------------------------------------
# The rewrite layer: --against (a plan may be re-derived, but never over work that has landed)
# and --design (the spine and the contracts beside it are one document in two files).
# ---------------------------------------------------------------------------------------------

prev()   { cat > "$TMP/prev.md"; }
design() { cat > "$TMP/design.md"; }

# against <name> <pattern> — the rewrite check reports it
against() {
  local out; out=$(python3 "$CHECK" "$TMP/todo.md" --against "$TMP/prev.md" 2>&1)
  grep -qiE "$2" <<<"$out" && ok "$1" || bad "$1" "no match for /$2/ in:${out:0:400}"
}
# against_silent <name> <pattern>
against_silent() {
  local out; out=$(python3 "$CHECK" "$TMP/todo.md" --against "$TMP/prev.md" 2>&1)
  grep -qiE "$2" <<<"$out" && bad "$1" "unexpected /$2/ in:${out:0:400}" || ok "$1"
}
# designs <name> <pattern>
designs() {
  local out; out=$(python3 "$CHECK" "$TMP/todo.md" --design "$TMP/design.md" 2>&1)
  grep -qiE "$2" <<<"$out" && ok "$1" || bad "$1" "no match for /$2/ in:${out:0:400}"
}

# The plan every --against case is rewritten FROM: Phase 1 landed, Phase 2 never started.
executed_plan() {
  cat <<'EOF'
### Phase 1 — Ledger schema <!-- built: phase-ledger-schema -->
**Implements:** S
**Depends on:** —
**Files:** `a.java` (new)
- [x] `V1__ledger.sql` creates `ledger_entry`
**Done when:** `mvn test` is green.

### Phase 2 — Payout webhook
**Implements:** S
**Depends on:** Phase 1
**Files:** `b.java` (new)
- [ ] does `b`
**Done when:** `mvn test` is green.
EOF
}

echo
echo "== a rewrite that re-splits only UNBUILT work =="
prev < <(executed_plan)
plan <<'EOF'
### Phase 1 — Ledger schema <!-- built: phase-ledger-schema -->
**Implements:** S
**Depends on:** —
**Files:** `a.java` (new)
- [x] `V1__ledger.sql` creates `ledger_entry`
**Done when:** `mvn test` is green.

### Phase 2 — Payout webhook store
**Implements:** S
**Depends on:** Phase 1
**Files:** `b.java` (new)
- [ ] does `b`
**Done when:** `mvn test` is green.

### Phase 3 — Payout webhook endpoint
**Implements:** S
**Depends on:** Phase 2
**Files:** `c.java` (new)
- [ ] does `c`
**Done when:** `mvn test` is green.
EOF
against_silent "a re-split of unbuilt work is not reported" "frozen|landed work|renumbered"

echo
echo "== a rewrite that drops a leaf carrying landed work =="
prev < <(executed_plan)
plan <<'EOF'
### Phase 1 — Payout webhook
**Implements:** S
**Depends on:** —
**Files:** `b.java` (new)
- [ ] does `b`
**Done when:** `mvn test` is green.
EOF
against "a dropped frozen leaf is reported" "gone from the rewrite"

echo
echo "== a rewrite that renumbers a leaf carrying landed work =="
prev < <(executed_plan)
plan <<'EOF'
### Phase 1 — Payout webhook
**Implements:** S
**Depends on:** —
**Files:** `b.java` (new)
- [ ] does `b`
**Done when:** `mvn test` is green.

### Phase 2 — Ledger schema <!-- built: phase-ledger-schema -->
**Implements:** S
**Depends on:** —
**Files:** `a.java` (new)
- [x] `V1__ledger.sql` creates `ledger_entry`
**Done when:** `mvn test` is green.
EOF
against "a renumbered frozen leaf is reported" "renumbered to Phase 2"

echo
echo "== a rewrite that loses a tick =="
prev < <(executed_plan)
plan <<'EOF'
### Phase 1 — Ledger schema <!-- built: phase-ledger-schema -->
**Implements:** S
**Depends on:** —
**Files:** `a.java` (new)
- [ ] `V1__ledger.sql` creates `ledger_entry`
**Done when:** `mvn test` is green.

### Phase 2 — Payout webhook
**Implements:** S
**Depends on:** Phase 1
**Files:** `b.java` (new)
- [ ] does `b`
**Done when:** `mvn test` is green.
EOF
against "an un-ticked item is reported" "gone or un-ticked"

echo
echo "== a rewrite of an UNNUMBERED plan, where only the ticks can be preserved =="
prev <<'EOF'
## Sprint 2
- [x] ledger table lands
- [ ] do the webhook thing
EOF
plan <<'EOF'
### Phase 1 — Payout webhook
**Implements:** S
**Depends on:** —
**Files:** `b.java` (new)
- [ ] does `b`
**Done when:** `mvn test` is green.
EOF
against "a tick lost from a hand-written plan is reported" "ticked item from the previous plan is gone"

echo
echo "== the contracts file beside the plan =="
plan <<'EOF'
## Milestone 1 — Ledger

### Phase 1 — Ledger schema
**Implements:** S
**Depends on:** —
**Files:** `a.java` (new)
- [ ] `V1__ledger.sql` creates `ledger_entry`
**Done when:** `mvn test` is green.

## Milestone 2 — Payouts

### Phase 2 — Payout webhook
**Implements:** S
**Depends on:** Phase 1
**Files:** `b.java` (new)
- [ ] does `b`
**Done when:** `mvn test` is green.
EOF
design <<'EOF'
## Milestone 1 — Ledger
- Schema `ledger_entry` — `id uuid primary key`
EOF
designs "a milestone with no contracts section is reported" "no '## Milestone 2' section"

design <<'EOF'
## Milestone 1 — Ledger
- Schema `ledger_entry` — `id uuid primary key`

## Milestone 2 — Payouts
- API `POST /webhooks/payout` → `200`

## Milestone 3 — Reporting
- Schema `report`
EOF
designs "a contracts section with no milestone is reported" "no milestone in the plan"

echo
echo "== contracts left inline while a design file sits beside the plan =="
plan <<'EOF'
## Milestone 1 — Ledger
**Design**
- Schema `ledger_entry` — `id uuid primary key`

### Phase 1 — Ledger schema
**Implements:** S
**Depends on:** —
**Files:** `a.java` (new)
- [ ] `V1__ledger.sql` creates `ledger_entry`
**Done when:** `mvn test` is green.
EOF
design <<'EOF'
## Milestone 1 — Ledger
- Schema `ledger_entry` — `id uuid primary key`
EOF
designs "two copies of one contract are reported" "still carries an inline"

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ $fail == 0 ]]
