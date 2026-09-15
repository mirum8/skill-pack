#!/usr/bin/env bash
# Behaviour tests for wave-simulate.sh — the dry merge --land runs before merging any of a wave.
#
#   bash skills/plan-run/tests/wave-simulate.test.sh
#
# Both wrong answers are confident ones: a false conflict stops a clean wave with nothing merged,
# and a false clean merges half a wave onto a base the rest never cleared. There is no CI, so this
# suite is the only thing checking which one the script returns.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
SIM="$PWD/skills/plan-run/scripts/wave-simulate.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# repo <name> — a fresh repo on main with one committed file.
repo() {
  R="$TMP/$1"; mkdir -p "$R"
  git -C "$R" init -q -b main
  git -C "$R" config user.email t@t; git -C "$R" config user.name t
  printf 'base\n' > "$R/shared.txt"
  git -C "$R" add -A && git -C "$R" commit -qm base
}

# branch <name> <from> <file> <content> — a branch cut from <from> that writes one file.
branch() {
  git -C "$R" checkout -q -b "$1" "$2"
  printf '%s\n' "$4" > "$R/$3"
  git -C "$R" add -A && git -C "$R" commit -qm "$1"
  git -C "$R" checkout -q main
}

untouched() {
  local head=$1
  [[ $(git -C "$R" rev-parse main) == "$head" ]] \
    && [[ -z $(git -C "$R" status --porcelain) ]] \
    && [[ ! -e "$R/.git/MERGE_HEAD" ]] \
    && ok "$2: main, the index and the tree are untouched" \
    || bad "$2: main, the index and the tree are untouched" "$(git -C "$R" status --porcelain)"
}

run() { (cd "$R" && "$SIM" "$@" 2>&1); }

echo "== two disjoint branches: the second merges onto the first's simulation =="
repo two
branch phase-a main a.txt a
branch phase-b main b.txt b
head=$(git -C "$R" rev-parse main)
out=$(run main phase-a phase-b); rc=$?
[[ $rc == 0 ]] && ok "a clean wave of two exits 0" || bad "a clean wave of two exits 0" "exit $rc: $out"
grep -q CONFLICT <<<"$out" && bad "and reports no conflict" "$out" || ok "and reports no conflict"
untouched "$head" "two"

echo "== three disjoint branches =="
repo three
branch phase-a main a.txt a
branch phase-b main b.txt b
branch phase-c main c.txt c
out=$(run main phase-a phase-b phase-c); rc=$?
[[ $rc == 0 ]] && ok "a clean wave of three exits 0" || bad "a clean wave of three exits 0" "exit $rc: $out"

echo "== each merges onto main alone, but the second conflicts with the first =="
repo pair
branch phase-a main shared.txt from-a
branch phase-b main shared.txt from-b
head=$(git -C "$R" rev-parse main)
out=$(run main phase-a phase-b); rc=$?
[[ $rc == 2 ]] && ok "a conflict between wave-mates exits 2" || bad "a conflict between wave-mates exits 2" "exit $rc: $out"
grep -q "CONFLICT.*phase-b" <<<"$out" && ok "and names the branch that hit it" || bad "and names the branch that hit it" "$out"
grep -q "shared.txt" <<<"$out" && ok "and names the conflicted file" || bad "and names the conflicted file" "$out"
untouched "$head" "pair"

echo "== a wave branch cut from another wave branch =="
repo stacked
branch phase-a main a.txt a
branch phase-b phase-a b.txt b
out=$(run main phase-a phase-b); rc=$?
[[ $rc == 0 ]] && ok "a branch stacked on its wave-mate simulates clean" \
               || bad "a branch stacked on its wave-mate simulates clean" "exit $rc: $out"

echo "== a simulation that cannot run is an error, never a conflict =="
repo broken
branch phase-a main a.txt a
head=$(git -C "$R" rev-parse main)
out=$(run main phase-a phase-missing); rc=$?
[[ $rc == 1 ]] && ok "an unknown branch exits 1" || bad "an unknown branch exits 1" "exit $rc: $out"
grep -q CONFLICT <<<"$out" && bad "and is not reported as a conflict" "$out" || ok "and is not reported as a conflict"
grep -q "phase-missing" <<<"$out" && ok "and names what git could not read" || bad "and names what git could not read" "$out"
untouched "$head" "broken"

out=$(run main); rc=$?
[[ $rc == 1 ]] && ok "no branches is a usage error" || bad "no branches is a usage error" "exit $rc: $out"
out=$(run nope phase-a); rc=$?
[[ $rc == 1 ]] && ok "an unknown base exits 1" || bad "an unknown base exits 1" "exit $rc: $out"

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[[ $fail == 0 ]]
