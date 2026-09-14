#!/usr/bin/env bash
# Behaviour tests for plan-ledger.py — the resume ledger in a task's plan file.
#
#   bash skills/task-run/tests/plan-ledger.test.sh
#
# The script decides what a resumed run may skip, and every way that goes wrong is a confident wrong
# answer: a slice called done over files that changed since builds the rest of the task on work that
# is no longer there, and a tree whose changes nobody claimed read as clean builds on code that no
# step of the pipeline wrote or checked. So the cases below are about the match, the claim and the
# lock — never about formatting for its own sake.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
LEDGER="$PWD/skills/task-run/scripts/plan-ledger.py"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

q() { python3 -c '
import json,sys
d = json.load(sys.stdin)
S = lambda label: [s for s in d["slices"] if s["label"] == label][0]
print(json.dumps(eval(sys.argv[1], {"d": d, "S": S})))' "$1"; }
eq() {
  local got; got=$(printf '%s' "$OUT" | q "$2" 2>/dev/null)
  [[ "$got" == "$3" ]] && ok "$1" || bad "$1" "$2 = $got, wanted $3 (out: $(printf '%s' "$OUT" | head -c 300))"
}
L() { OUT=$(cd "$REPO" && python3 "$LEDGER" "$@" 2>"$TMP/err"); RC=$?; }

REPO="$TMP/repo"; mkdir -p "$REPO" && cd "$REPO"
git init -q -b main && git config user.email t@example.com && git config user.name test
printf 'base\n' > Existing.java && git add -A && git commit -qm base
git checkout -q -b phase-x
mkdir -p .task-plans
BODY=$'## Context\nbuild it\n\n## Coverage contract\ncriterion -> test'
printf 'status: implementing   # reviewing -> implementing -> done\ntier: full\nsource: todo.md / Phase 1\nbase: main\n\n%s\n' "$BODY" > .task-plans/p.md
cd - >/dev/null
body() { sed -n '/^$/,$p' "$REPO/.task-plans/p.md" | tail -n +2 | head -5; }

echo "== a plan with no ledger =="
L read --plan .task-plans/p.md --base main
[[ $RC == 0 ]] && ok "read exits 0" || bad "read exits 0" "rc=$RC $(cat "$TMP/err")"
eq "the status comes off the header, comment stripped" 'd["planStatus"]' '"implementing"'
eq "no review stamp" 'd["reviewed"]' '""'
eq "no slices" 'd["slices"]' '[]'
eq "no build line" 'd["build"]' '{"recorded": false, "matches": false}'
eq "no error" 'd["error"]' '""'
eq "a clean tree lists nothing — the plan file itself is never part of it" 'd["tree"]' '[]'

echo "== the tree a resume has to account for =="
printf 'new\n' > "$REPO/Service.java"
printf 'changed\n' > "$REPO/Existing.java"
L read --plan .task-plans/p.md --base main
eq "untracked and modified files both count" 'd["tree"]' '["Existing.java", "Service.java"]'
eq "and with nothing recorded, every one is unclaimed" 'd["unclaimed"]' '["Existing.java", "Service.java"]'
(cd "$REPO" && git add Existing.java && git commit -qm wip)
L read --plan .task-plans/p.md --base main
eq "a change already committed on the branch still counts against base" 'd["tree"]' '["Existing.java", "Service.java"]'

echo "== mark keeps the plan and records one line per key =="
L mark --plan .task-plans/p.md --base main --key reviewed --note "codex · 2 passes · 5 raised · 3 applied"
eq "a mark reports it wrote" 'd["written"]' 'true'
L mark --plan .task-plans/p.md --base main --key reviewed --note "codex · 1 pass · 0 raised · 0 applied"
L read --plan .task-plans/p.md --base main
eq "a second stamp replaces the first rather than stacking" 'd["reviewed"].split(" · ")[:2]' '["codex", "1 pass"]'
[[ $(grep -c '^reviewed:' "$REPO/.task-plans/p.md") == 1 ]] && ok "exactly one reviewed line" || bad "exactly one reviewed line" "$(cat "$REPO/.task-plans/p.md")"
[[ "$(body)" == "$BODY" ]] && ok "the plan body is byte-for-byte untouched" || bad "the plan body is byte-for-byte untouched" "$(body)"
sed -n '1,/^$/p' "$REPO/.task-plans/p.md" | grep -q '^reviewed:' \
  && ok "the stamp lands inside the header, above the first blank line" \
  || bad "the stamp lands inside the header, above the first blank line" "$(cat "$REPO/.task-plans/p.md")"
[[ $(head -1 "$REPO/.task-plans/p.md") == status:* ]] && ok "status stays the first line" || bad "status stays the first line" "$(head -1 "$REPO/.task-plans/p.md")"

echo "== a slice claims the files it wrote, by their content =="
L mark --plan .task-plans/p.md --base main --key slice:backend --files Service.java
L read --plan .task-plans/p.md --base main
eq "the slice is recorded with its files" 'S("backend")["files"]' '["Service.java"]'
eq "and matches while the files are unchanged" 'S("backend")["matches"]' 'true'
eq "its file is no longer unclaimed; the other still is" 'd["unclaimed"]' '["Existing.java"]'
printf 'edited after the slice\n' > "$REPO/Service.java"
L read --plan .task-plans/p.md --base main
eq "an edit after the mark breaks the match" 'S("backend")["matches"]' 'false'
eq "but the file stays claimed — its slice re-runs, it is not somebody else's work" 'd["unclaimed"]' '["Existing.java"]'
L mark --plan .task-plans/p.md --base main --key slice:backend --files Service.java
rm "$REPO/Service.java"
L read --plan .task-plans/p.md --base main
eq "a claimed file deleted after the mark breaks the match too" 'S("backend")["matches"]' 'false'
printf 'new\n' > "$REPO/Service.java"
mkdir -p "$REPO/src/web" && printf 'nested\n' > "$REPO/src/web/Page.java"
L mark --plan .task-plans/p.md --base main --key slice:frontend --files Page.java
L read --plan .task-plans/p.md --base main
eq "a bare file name is claimed as the one tree path it can only mean" 'S("frontend")["files"]' '["src/web/Page.java"]'
L mark --plan .task-plans/p.md --base main --key slice:frontend --files "$REPO/src/web/Page.java"
L read --plan .task-plans/p.md --base main
eq "and so is an absolute path inside the repo" 'S("frontend")["files"]' '["src/web/Page.java"]'

echo "== a build or review line vouches for the whole tree =="
L mark --plan .task-plans/p.md --base main --key slice:backend --files Service.java
L mark --plan .task-plans/p.md --base main --key build
L read --plan .task-plans/p.md --base main
eq "a build over an unchanged tree matches" 'd["build"]["matches"]' 'true'
eq "and claims what no slice did — a build fixer's edits were built with the rest" 'd["unclaimed"]' '[]'
printf 'stray\n' > "$REPO/Stray.java"
L read --plan .task-plans/p.md --base main
eq "a file added after the build breaks it" 'd["build"]["matches"]' 'false'
eq "and then every file no slice claimed is unclaimed again" 'd["unclaimed"]' '["Existing.java", "Stray.java"]'
rm "$REPO/Stray.java"
printf 'edited plan\n' >> "$REPO/.task-plans/p.md"
L read --plan .task-plans/p.md --base main
eq "editing the plan itself never breaks a match" 'd["build"]["matches"]' 'true'
L mark --plan .task-plans/p.md --base main --key review
L read --plan .task-plans/p.md --base main
eq "the review line is read the same way" 'd["review"]' '{"recorded": true, "matches": true}'

echo "== failures are reported, never guessed =="
L read --plan .task-plans/missing.md --base main
eq "a missing plan reads as no plan" 'd["planStatus"]' '"none"'
L mark --plan .task-plans/missing.md --base main --key build
eq "and cannot be marked" 'd["written"]' 'false'
[[ $RC == 0 ]] && ok "a failed mark still exits 0 — bookkeeping never fails the caller" || bad "a failed mark still exits 0" "rc=$RC"
mkdir -p "$TMP/notgit/.task-plans" && cp "$REPO/.task-plans/p.md" "$TMP/notgit/.task-plans/p.md"
OUT=$(cd "$TMP/notgit" && python3 "$LEDGER" read --plan .task-plans/p.md --base main 2>/dev/null); RC=$?
eq "outside a git repo the tree cannot be read, and says so" 'bool(d["error"])' 'true'
[[ $RC == 0 ]] && ok "and still exits 0" || bad "and still exits 0" "rc=$RC"
L read --plan .task-plans/p.md --base no-such-ref
eq "an unknown base is an error, not an empty tree" 'bool(d["error"])' 'true'
L mark --plan .task-plans/p.md --base main --key "slice:bad label" --files Service.java
eq "a slice label outside [A-Za-z0-9_.-] is refused" 'd["written"]' 'false'
OUT=$(cd "$REPO" && python3 "$LEDGER" mark --plan .task-plans/p.md --base main --key nonsense 2>/dev/null); RC=$?
[[ $RC == 2 ]] && ok "an unknown key is a usage error" || bad "an unknown key is a usage error" "rc=$RC"

echo "== slices finish in parallel =="
(cd "$REPO" && for i in 1 2 3 4 5 6; do python3 "$LEDGER" mark --plan .task-plans/p.md --base main --key "slice:s$i" --files Service.java >/dev/null & done; wait)
L read --plan .task-plans/p.md --base main
eq "six concurrent marks all land" 'sorted(s["label"] for s in d["slices"] if s["label"].startswith("s"))' '["s1", "s2", "s3", "s4", "s5", "s6"]'
[[ "$(body)" == "$BODY" ]] && ok "and the body survives them" || bad "and the body survives them" "$(body)"

printf '\n  %d passed, %d failed\n' "$pass" "$fail"
[[ $fail == 0 ]]
