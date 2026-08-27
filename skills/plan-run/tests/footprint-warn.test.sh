#!/usr/bin/env bash
# Behaviour tests for footprint-warn.py — the history check the concurrency preflight runs after
# check_todo.py --slice has cleared a slice.
#
#   bash skills/plan-run/tests/footprint-warn.test.sh
#
# It decides whether a wave is safe to spawn, from a measurement rather than from the plan's own
# claim. Both directions of a wrong answer are expensive and neither is visible at the time: a
# missed collision is a wave that builds for hours and will not merge, and a false one refuses
# parallelism that was fine. There is no CI, so this suite is the only thing checking either.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
WARN="skills/plan-run/scripts/footprint-warn.py"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# warn <name> <slice> <expected-exit> [pattern] — run it against $REPO and $PLAN
warn() {
  local out rc; out=$(python3 "$WARN" "$PLAN" --slice "$2" --base main --repo "$REPO" 2>&1); rc=$?
  if [[ $rc != "$3" ]]; then bad "$1" "exit $rc, wanted $3:${out:0:400}"; return; fi
  if [[ -n "${4:-}" ]] && ! grep -qiE "$4" <<<"$out"; then
    bad "$1" "no match for /$4/ in:${out:0:400}"; return
  fi
  ok "$1"
}

# A repo whose history says internal/ui is wired together in app.go: every commit touches it, and
# nothing in the plan's Files: lines admits that. This is the shape the real failure had.
REPO="$TMP/repo"; mkdir -p "$REPO/internal/ui" "$REPO/internal/stream" "$REPO/internal/ops"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email t@t; git -C "$REPO" config user.name t
for i in 1 2 3 4 5; do
  echo "v$i" > "$REPO/internal/ui/app.go"
  echo "v$i" > "$REPO/internal/ui/table.go"
  echo "v$i" > "$REPO/internal/ui/feature$i.go"
  echo "v$i" > "$REPO/internal/stream/logs.go"
  git -C "$REPO" add -A >/dev/null; git -C "$REPO" commit -qm "phase $i"
done

PLAN="$TMP/todo.md"
cat > "$PLAN" <<'EOF'
### Phase 1 — Built already <!-- built: phase-one -->
**Depends on:** —
**Files:** `internal/ui/feature1.go` (new)
- [x] done

### Phase 2 — A UI leaf
**Depends on:** —
**Files:** `internal/ui/selection.go` (new) · `internal/ui/selection_test.go` (new)
- [ ] does a

### Phase 3 — Another UI leaf
**Depends on:** —
**Files:** `internal/ui/events.go` (new) · `internal/ui/events_test.go` (new)
- [ ] does b

### Phase 4 — A stream leaf
**Depends on:** —
**Files:** `internal/stream/save.go` (new) · `internal/stream/save_test.go` (new)
- [ ] does c

### Phase 5 — An ops leaf, in a package with no history
**Depends on:** —
**Files:** `internal/ops/scale.go` (new)
- [ ] does d
EOF

echo "== two leaves in one package, cleared by the plan and refused by history =="
warn "a shared package is reported"            "2,3" 2 "history disagrees"
warn "and names the package"                   "2,3" 2 "internal/ui is claimed by Phase 2, Phase 3"
warn "and names its hub file with a count"     "2,3" 2 "app\.go \(5\)"
warn "and says neither leaf declared it"       "2,3" 2 "not declared by any of them"

echo
echo "== leaves in different packages are left alone =="
warn "disjoint packages pass"                  "2,4" 0 "history agrees with the plan"

echo
echo "== a package with no history cannot be judged, and does not become a refusal =="
warn "an unwritten package is silent"          "4,5" 0 "history agrees with the plan"

echo
echo "== a built leaf is not running, so it is not compared =="
warn "one unbuilt leaf beside a built one"     "1,2" 0 "nothing to compare"
warn "a slice of one is nothing to compare"    "2"   0 "nothing to compare"

echo
echo "== not enough history is a named skip, never a refusal =="
EMPTY="$TMP/empty"; mkdir -p "$EMPTY"; git -C "$EMPTY" init -q -b main
out=$(python3 "$WARN" "$PLAN" --slice 2,3 --base main --repo "$EMPTY" 2>&1); rc=$?
[[ $rc == 0 ]] && ok "a repo with no commits exits 0" || bad "a repo with no commits exits 0" "exit $rc: $out"
grep -q "skipped" <<<"$out" && ok "and says it skipped rather than passing" \
                            || bad "and says it skipped rather than passing" "$out"

out=$(python3 "$WARN" "$PLAN" --slice 2,3 --base nosuchbranch --repo "$REPO" 2>&1); rc=$?
[[ $rc == 0 ]] && ok "an unreadable base exits 0" || bad "an unreadable base exits 0" "exit $rc: $out"
grep -q "skipped" <<<"$out" && ok "and names that too" || bad "and names that too" "$out"

echo
echo "== generated artefacts never make a collision, and never make a hub =="
mkdir -p "$REPO/.claude/skills/test-app/e2e" "$REPO/internal/ui/testdata"
for i in 1 2 3 4 5; do
  echo "f$i" > "$REPO/.claude/skills/test-app/e2e/frame.txt"
  echo "g$i" > "$REPO/internal/ui/testdata/help.golden"
  git -C "$REPO" add -A >/dev/null; git -C "$REPO" commit -qm "capture $i"
done
out=$(python3 "$WARN" "$PLAN" --slice 2,3 --base main --repo "$REPO" 2>&1)
grep -qE 'frame\.txt|help\.golden' <<<"$out" \
  && bad "a capture is never named as a hub file" "$out" \
  || ok "a capture is never named as a hub file"

echo
echo "== usage errors are never a silent pass =="
out=$(python3 "$WARN" "$TMP/nosuch.md" --slice 2,3 --repo "$REPO" 2>&1); rc=$?
[[ $rc == 1 ]] && ok "a missing plan exits 1" || bad "a missing plan exits 1" "exit $rc: $out"
out=$(python3 "$WARN" "$PLAN" --slice 2,99 --repo "$REPO" 2>&1); rc=$?
[[ $rc == 1 ]] && ok "a phase not in the plan exits 1" || bad "a phase not in the plan exits 1" "exit $rc: $out"
out=$(python3 "$WARN" "$PLAN" --repo "$REPO" 2>&1); rc=$?
[[ $rc == 1 ]] && ok "no --slice at all exits 1" || bad "no --slice at all exits 1" "exit $rc: $out"

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
