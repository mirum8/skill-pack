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

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ $fail == 0 ]]
