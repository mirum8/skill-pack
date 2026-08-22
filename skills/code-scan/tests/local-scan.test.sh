#!/usr/bin/env bash
# Behaviour tests for local-scan.py's scoping and its fail-closed contract.
#
#   bash skills/code-scan/tests/local-scan.test.sh
#
# The analyzers themselves are not exercised — pmd/spotbugs/semgrep may not be installed, and when
# they are they are the thing under test somewhere else. What IS tested is everything the SKILL.md
# tells the model to trust without re-deriving: which files each invocation shape resolves to, and
# the status/exit-code contract that separates "clean" from "did not run". Those are exactly the
# two ways this script can lie — a scan that read the wrong files and a scan that read none
# reporting the same "no issues found". There is no CI, so this is the only thing standing
# between an edit and that.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
SCAN="$PWD/skills/code-scan/scripts/local-scan.py"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# One throwaway git repo, built once and then driven through every invocation shape. Unlike the
# other suites here a fresh fixture per case would mean a fresh `git init` per case, and the thing
# under test is precisely how the shapes differ over ONE history.
REPO="$TMP/repo"
mkdir -p "$REPO/src/main/java/app" "$REPO/src/main/resources" "$REPO/target/classes/app"
cd "$REPO"
git init -q -b main
git config user.email t@example.com; git config user.name test
cat > src/main/java/app/Committed.java <<'EOF'
package app;
public class Committed { public void a() {} }
EOF
echo "irrelevant" > src/main/resources/notes.txt
git add -A && git commit -qm "base"

cat > src/main/java/app/Second.java <<'EOF'
package app;
public class Second { public void b() {} }
EOF
git add -A && git commit -qm "second"

# Uncommitted: one tracked edit, one brand-new untracked file. Both are "my changes".
echo "// edited" >> src/main/java/app/Committed.java
cat > src/main/java/app/Untracked.java <<'EOF'
package app;
public class Untracked { public void c() {} }
EOF
# Build output must never be scanned as source, whatever the scope says.
echo "class Stale {}" > target/classes/app/Stale.java

OUT="$TMP/findings.json"
scan() { python3 "$SCAN" -o "$OUT" "$@" >"$TMP/stdout" 2>"$TMP/stderr"; echo $?; }

# scope <name> <python-expression over the scoped file list `f`> <expected>
scope_is() {
  local name="$1" expr="$2" want="$3"; shift 3
  scan "$@" >/dev/null
  local got; got=$(python3 - "$OUT" "$expr" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
f = sorted({x["file"] for x in d["findings"]})
label = d["scope"]
print(eval(sys.argv[2]))
PY
)
  [[ "$got" == "$want" ]] && ok "$name" || bad "$name" "$expr = $got, wanted $want"
}

# The scoped file list is not in findings.json (only findings are), so read it from the script's
# own "Scope: … (N source files)" note — the same line the skill tells the user.
count_for() {
  scan "$@" >/dev/null
  sed -n 's/.*(\([0-9]*\) source files).*/\1/p' "$TMP/stderr" "$TMP/stdout" | head -1
}
names_for() {
  scan "$@" >/dev/null
  python3 -c "import json,sys;print(json.load(open('$OUT'))['scope'])"
}

echo "== the default scope is the branch diff plus uncommitted and untracked work =="
n=$(count_for)
[[ "$n" == "3" ]] && ok "diff scope covers the committed change, the edit and the untracked file" \
                  || bad "diff scope covers the committed change, the edit and the untracked file" \
                         "got $n source files, wanted 3"
[[ "$(names_for)" == "git diff" ]] && ok "and labels itself 'git diff'" \
                                   || bad "and labels itself 'git diff'" "$(names_for)"

echo
echo "== non-source files never enter the scope, whatever git says changed =="
grep -q "notes.txt" "$OUT" && bad "a changed .txt is excluded" "notes.txt reached findings.json" \
                           || ok "a changed .txt is excluded"

echo
echo "== --files takes an explicit list, and drops what is not source =="
n=$(count_for --files src/main/java/app/Second.java src/main/resources/notes.txt)
[[ "$n" == "1" ]] && ok "an explicit list keeps only the source file" \
                  || bad "an explicit list keeps only the source file" "got $n, wanted 1"
[[ "$(names_for --files src/main/java/app/Second.java)" == "explicit list" ]] \
  && ok "and labels itself 'explicit list'" || bad "and labels itself 'explicit list'" ""

echo
echo "== --filter resolves a directory, a file, or a bare class name =="
n=$(count_for --filter src/main/java/app)
[[ "$n" == "3" ]] && ok "a directory resolves to every source file under it" \
                  || bad "a directory resolves to every source file under it" "got $n, wanted 3"
n=$(count_for --filter Second)
[[ "$n" == "1" ]] && ok "a bare class name resolves to its source file" \
                  || bad "a bare class name resolves to its source file" "got $n, wanted 1"

echo "-- and a filter that resolves to nothing exits 2 rather than scanning everything"
rc=$(scan --filter NoSuchClass)
[[ "$rc" == "2" ]] && ok "an unresolvable filter exits 2" \
                   || bad "an unresolvable filter exits 2" "exit $rc"

echo
echo "== build output is never source, even when it sits under a scanned directory =="
# A .java under target/ is compiler output, not code anyone wrote. Scanning it reports findings
# against a file the user cannot edit, and a fix loop pointed there silently rewrites build output.
rc=$(scan --filter target)
[[ "$rc" == "2" ]] && ok "a directory holding only build output resolves to nothing and exits 2" \
                   || bad "a directory holding only build output resolves to nothing and exits 2" \
                          "exit $rc"
grep -q "Stale.java" "$OUT" 2>/dev/null \
  && bad "and no build-output file ever reaches findings.json" "Stale.java is in $OUT" \
  || ok "and no build-output file ever reaches findings.json"

echo
echo "== --commit and --range read git history, and refuse a ref that is not one =="
n=$(count_for --commit HEAD)
[[ "$n" == "1" ]] && ok "--commit HEAD scopes to that commit's source files" \
                  || bad "--commit HEAD scopes to that commit's source files" "got $n, wanted 1"
n=$(count_for --range HEAD~1..HEAD)
[[ "$n" == "1" ]] && ok "--range scopes to the range's source files" \
                  || bad "--range scopes to the range's source files" "got $n, wanted 1"
rc=$(scan --commit nope-not-a-ref)
[[ "$rc" == "2" ]] && ok "an invalid --commit exits 2" || bad "an invalid --commit exits 2" "exit $rc"
rc=$(scan --range "nope..alsonope")
[[ "$rc" == "2" ]] && ok "an invalid --range exits 2"  || bad "an invalid --range exits 2" "exit $rc"

echo
echo "== an empty scope is 'ok' and writes a real report — nothing to scan is not a failure =="
scan --files src/main/resources/notes.txt >/dev/null
st=$(python3 -c "import json;print(json.load(open('$OUT'))['status'])")
[[ "$st" == "ok" ]] && ok "an empty scope reports status ok" \
                    || bad "an empty scope reports status ok" "status $st"
grep -q "Nothing to scan" "$TMP/stdout" && ok "and says so plainly" || bad "and says so plainly" ""

echo
echo "== fail closed: no analyzer available is exit 3, NOT a clean result =="
# The whole point of the contract. An empty findings[] means "clean" only when at least one tool
# ran, so the run with no tools on PATH must be distinguishable from the run that found nothing.
# A PATH holding python3 and git and nothing else — removing PATH entirely would only prove that
# python3 is unreachable, which is a different failure from the one under test.
BARE="$TMP/bare-path"; mkdir -p "$BARE"
ln -sf "$(command -v python3)" "$BARE/python3"
ln -sf "$(command -v git)" "$BARE/git"
ln -sf "$(command -v bash)" "$BARE/bash"   # have() probes through `bash -lc command -v`
rc=$(env PATH="$BARE" python3 "$SCAN" -o "$OUT" \
      --files src/main/java/app/Second.java >"$TMP/stdout" 2>"$TMP/stderr"; echo $?)
if [[ "$rc" == "3" ]]; then
  ok "a run with no analyzers on PATH exits 3"
  st=$(python3 -c "import json;print(json.load(open('$OUT'))['status'])")
  [[ "$st" == "error" ]] && ok "and writes status: error" || bad "and writes status: error" "status $st"
  grep -q "NOT a clean result" "$TMP/stdout" \
    && ok "and says NOT a clean result rather than 'no issues found'" \
    || bad "and says NOT a clean result rather than 'no issues found'" "$(cat "$TMP/stdout")"
  python3 -c "
import json,sys
d=json.load(open('$OUT'))
sys.exit(0 if any('no analyzers ran' in e for e in d['errors']) else 1)" \
    && ok "and names the reason in errors[]" || bad "and names the reason in errors[]" ""
else
  bad "a run with no analyzers on PATH exits 3" "exit $rc"
fi

echo
echo "== check-tools.sh agrees with the scan about what counts as usable =="
# The skill runs this FIRST and tells the user what is covered based on its answer. If it says the
# environment is fine while local-scan.py then exits 3 for want of an analyzer, the user is told a
# subset ran when nothing did — so the two must draw the line in the same place: python3 plus at
# least one analyzer.
CT="$OLDPWD/skills/code-scan/scripts/check-tools.sh"
[[ -f "$CT" ]] || CT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/check-tools.sh"

ANAL="$TMP/analyzers"; mkdir -p "$ANAL"
ln -sf "$(command -v bash)" "$ANAL/bash"
ln -sf "$(command -v python3)" "$ANAL/python3"

env PATH="$ANAL" bash "$CT" >"$TMP/ct" 2>&1; rc=$?
[[ "$rc" == "1" ]] && ok "python3 but no analyzer at all exits 1" \
                   || bad "python3 but no analyzer at all exits 1" "exit $rc: $(cat "$TMP/ct")"
grep -q "No analyzers installed" "$TMP/ct" && ok "and says so, with the install command" \
                                            || bad "and says so, with the install command" "$(cat "$TMP/ct")"

printf '#!/bin/sh\necho "pmd 7.0.0"\n' > "$ANAL/pmd"; chmod +x "$ANAL/pmd"
env PATH="$ANAL" bash "$CT" >"$TMP/ct" 2>&1; rc=$?
[[ "$rc" == "0" ]] && ok "one analyzer is enough to proceed — partial coverage beats no scan" \
                   || bad "one analyzer is enough to proceed — partial coverage beats no scan" "exit $rc"
grep -q "running with a subset" "$TMP/ct" \
  && ok "and the coverage gap is named rather than left implicit" \
  || bad "and the coverage gap is named rather than left implicit" "$(cat "$TMP/ct")"
grep -q "spotbugs.*missing" "$TMP/ct" && ok "naming each absent tool and how to install it" \
                                      || bad "naming each absent tool and how to install it" "$(cat "$TMP/ct")"

NOPY="$TMP/nopy"; mkdir -p "$NOPY"; ln -sf "$(command -v bash)" "$NOPY/bash"
env PATH="$NOPY" bash "$CT" >"$TMP/ct" 2>&1; rc=$?
[[ "$rc" == "1" ]] && ok "no python3 exits 1 — the orchestrator cannot run at all" \
                   || bad "no python3 exits 1 — the orchestrator cannot run at all" "exit $rc"

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ $fail == 0 ]]
