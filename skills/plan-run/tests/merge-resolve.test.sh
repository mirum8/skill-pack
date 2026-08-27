#!/usr/bin/env bash
# Behaviour tests for merge-resolve.py — the auto-resolver --land runs under --auto-resolve.
#
#   bash skills/plan-run/tests/merge-resolve.test.sh
#
# It decides whether a conflict is safe to resolve without a person, and a wrong yes is invisible:
# a union that dropped a line still compiles and fails somewhere else, later. The caller's build and
# test run is the second net, but it only fires on what this script chose to touch. There is no CI,
# so this suite is the only thing checking what it chooses.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
RESOLVE="$PWD/skills/plan-run/scripts/merge-resolve.py"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# scenario <name> — a fresh repo whose `main` and `side` both changed one file from a common base.
# Three heredocs on stdin, separated by a line of four dashes: base, main's version, side's version.
scenario() {
  R="$TMP/$1"; mkdir -p "$R"
  git -C "$R" init -q -b main
  git -C "$R" config user.email t@t; git -C "$R" config user.name t
  local part=0 line
  : > "$R/.base"; : > "$R/.ours"; : > "$R/.theirs"
  while IFS= read -r line; do
    [[ $line == "----" ]] && { part=$((part + 1)); continue; }
    case $part in 0) echo "$line" >> "$R/.base" ;;
                  1) echo "$line" >> "$R/.ours" ;;
                  2) echo "$line" >> "$R/.theirs" ;; esac
  done
  mkdir -p "$R/$(dirname "$FILE")"
  cp "$R/.base" "$R/$FILE"; git -C "$R" add -A >/dev/null; git -C "$R" commit -qm base
  git -C "$R" checkout -qb side
  cp "$R/.theirs" "$R/$FILE"; git -C "$R" commit -qam side
  git -C "$R" checkout -q main
  cp "$R/.ours" "$R/$FILE"; git -C "$R" commit -qam main
  git -C "$R" merge side >/dev/null 2>&1
  rm -f "$R/.base" "$R/.ours" "$R/.theirs"
}

run() { python3 "$RESOLVE" --repo "$R" ${PLAN:+--plan "$PLAN"} "$@" 2>&1; }

echo "== both sides only ADD, with nothing in the base =="
FILE=pkg/errors.go
scenario add-add <<'EOF'
const Base = 1
----
const Base = 1
const Ours = 2
----
const Base = 1
const Theirs = 3
EOF
out=$(run); rc=$?
[[ $rc == 0 ]] && ok "an add/add conflict resolves" || bad "an add/add conflict resolves" "exit $rc: $out"
grep -q "resolved  pkg/errors.go" <<<"$out" && ok "and names the file" || bad "and names the file" "$out"
grep -q "const Ours" "$R/$FILE" && grep -q "const Theirs" "$R/$FILE" \
  && ok "both sides survive" || bad "both sides survive" "$(cat "$R/$FILE")"
grep -qE '^(<<<<<<<|>>>>>>>|\|\|\|\|\|\|\|)' "$R/$FILE" \
  && bad "no markers are left behind" "$(cat "$R/$FILE")" || ok "no markers are left behind"
[[ -z $(git -C "$R" diff --name-only --diff-filter=U) ]] \
  && ok "and it is staged, so the merge can be committed" \
  || bad "and it is staged, so the merge can be committed" "still unmerged"

echo
echo "== a formatter realigned the whole block, so every base line 'changed' =="
FILE=pkg/app.go
scenario realign <<'EOF'
type App struct {
	focus focus
	table Table
}
----
type App struct {
	focus   focus
	table   Table
	confirm confirm
}
----
type App struct {
	focus     focus
	table     Table
	usageLive bool
}
EOF
out=$(run); rc=$?
[[ $rc == 0 ]] && ok "whitespace-only changes to base lines still count as additive" \
               || bad "whitespace-only changes to base lines still count as additive" "exit $rc: $out"
grep -q "confirm confirm" "$R/$FILE" && grep -q "usageLive bool" "$R/$FILE" \
  && ok "and both sides' new fields survive" || bad "and both sides' new fields survive" "$(cat "$R/$FILE")"

echo
echo "== a base line is missing from one side — the case that compiles and fails in tests =="
FILE=pkg/run.go
scenario rewrote <<'EOF'
cfg.Activate, cfg.Visit = cs.activate, cs.visit
----
cfg.Activate, cfg.Visit, cfg.Apply = cs.activate, cs.visit, cs.apply
----
cfg.Activate, cfg.Visit = cs.activate, cs.visit
cfg.SampleUsage = cs.sampleUsage
EOF
out=$(run); rc=$?
[[ $rc == 2 ]] && ok "a rewritten base line is REFUSED" || bad "a rewritten base line is REFUSED" "exit $rc: $out"
grep -q "REFUSED   pkg/run.go" <<<"$out" && ok "and the file is named" || bad "and the file is named" "$out"
grep -q "rewrote shared code" <<<"$out" && ok "with the reason it was refused" \
                                        || bad "with the reason it was refused" "$out"
[[ -n $(git -C "$R" diff --name-only --diff-filter=U) ]] \
  && ok "and it is left unmerged for a person" || bad "and it is left unmerged for a person" "staged anyway"
grep -q "ours/theirs" <<<"$out" && ok "and the report warns off -X ours/theirs" \
                                || bad "and the report warns off -X ours/theirs" "$out"

echo
echo "== a generated artefact is refused whatever shape its conflict has =="
for f in ui/testdata/help.golden ui/testdata/frame.txt .claude/skills/test-app/e2e/frame.txt; do
  FILE=$f
  scenario "gen-$(echo "$f" | tr '/.' '--')" <<'EOF'
line one
----
line one
ours
----
line one
theirs
EOF
  out=$(run); rc=$?
  [[ $rc == 2 ]] && ok "$f is refused" || bad "$f is refused" "exit $rc: $out"
done

echo
echo "== the plan file's ticks are the written exception: keep BOTH sides' =="
FILE=docs/x/todo.md
scenario plan <<'EOF'
### Phase 1 — A
- [ ] does a
- [ ] does b
----
### Phase 1 — A
- [x] does a
- [ ] does b
----
### Phase 1 — A
- [ ] does a
- [x] does b
EOF
PLAN=docs/x/todo.md
out=$(run); rc=$?
[[ $rc == 0 ]] && ok "colliding ticks resolve" || bad "colliding ticks resolve" "exit $rc: $out"
grep -q -- "- \[x\] does a" "$R/$FILE" && grep -q -- "- \[x\] does b" "$R/$FILE" \
  && ok "and NEITHER side's tick is lost" || bad "and NEITHER side's tick is lost" "$(cat "$R/$FILE")"

FILE=docs/x/todo.md
scenario plan-marker <<'EOF'
### Phase 1 — A
- [ ] does a
### Phase 2 — B
- [ ] does b
----
### Phase 1 — A <!-- built: phase-a -->
- [x] does a
### Phase 2 — B
- [ ] does b
----
### Phase 1 — A
- [ ] does a
### Phase 2 — B <!-- built: phase-b -->
- [x] does b
EOF
PLAN=docs/x/todo.md
out=$(run); rc=$?
[[ $rc == 0 ]] && ok "colliding headings resolve too" || bad "colliding headings resolve too" "exit $rc: $out"
grep -q "built: phase-a" "$R/$FILE" && grep -q "built: phase-b" "$R/$FILE" \
  && ok "and BOTH built markers survive — --land maps a branch to a phase by them" \
  || bad "and BOTH built markers survive" "$(cat "$R/$FILE")"

# The same file, without --plan: it is source like anything else and the rule refuses it.
PLAN=""
scenario plan-unnamed <<'EOF'
### Phase 1 — A
- [ ] does a
- [ ] does b
----
### Phase 1 — A
- [x] does a
- [ ] does b
----
### Phase 1 — A
- [ ] does a
- [x] does b
EOF
out=$(run); rc=$?
[[ $rc == 2 ]] && ok "and the exception applies ONLY to the plan the caller named" \
               || bad "and the exception applies ONLY to the plan the caller named" "exit $rc: $out"

echo
echo "== --dry-run decides without writing =="
PLAN=""
FILE=pkg/errors.go
scenario dry <<'EOF'
const Base = 1
----
const Base = 1
const Ours = 2
----
const Base = 1
const Theirs = 3
EOF
before=$(md5 -q "$R/$FILE" 2>/dev/null || md5sum "$R/$FILE" | cut -d' ' -f1)
out=$(run --dry-run); rc=$?
after=$(md5 -q "$R/$FILE" 2>/dev/null || md5sum "$R/$FILE" | cut -d' ' -f1)
[[ $rc == 0 ]] && ok "--dry-run reports the same verdict" || bad "--dry-run reports the same verdict" "exit $rc: $out"
[[ $before == "$after" ]] && ok "and changes nothing on disk" || bad "and changes nothing on disk" "file rewritten"
[[ -n $(git -C "$R" diff --name-only --diff-filter=U) ]] \
  && ok "and stages nothing" || bad "and stages nothing" "staged anyway"

echo
echo "== no merge in progress is an error, never a silent success =="
R="$TMP/clean"; mkdir -p "$R"; git -C "$R" init -q -b main
git -C "$R" config user.email t@t; git -C "$R" config user.name t
echo x > "$R/f"; git -C "$R" add -A >/dev/null; git -C "$R" commit -qm one
out=$(run); rc=$?
[[ $rc == 1 ]] && ok "running outside a merge exits 1" || bad "running outside a merge exits 1" "exit $rc: $out"

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
