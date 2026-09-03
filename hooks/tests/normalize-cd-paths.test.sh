#!/usr/bin/env bash
# Behaviour tests for the packed cd-path normalizer.
#
#   bash hooks/tests/normalize-cd-paths.test.sh
#
# The hook rewrites a command the permission analyzer would otherwise refuse to
# resolve, so both directions are load-bearing and neither is optional. A missed
# rewrite costs a permission prompt — the behaviour without the hook, visible and
# harmless. A WRONG rewrite silently changes which files a command reads, and
# nothing downstream re-reads the command to catch it. So every case that cannot
# be vouched for must come back untouched, and the pattern operand of a grep must
# never be mistaken for a path.
#
# The `.ssh/` case is the security property rather than a convenience: absolutizing
# it is what lets a Read(**/.ssh/**) rule MATCH, turning a vague "cannot be
# determined" ask into a real deny.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

HOOK=hooks/normalize-cd-paths.py
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
BASE=$(cd "$TMP" && pwd -P)
mkdir -p "$BASE/internal/ui" "$BASE/docs" "$BASE/.ssh"
printf 'Unbuilt\n' > "$BASE/internal/ui/yank.go"
printf 'x\n' > "$BASE/docs/a.md"
printf 'KEY\n' > "$BASE/.ssh/id_rsa"
pass=0; fail=0

# $1 name  $2 command handed to the Bash tool  $3 expected command out, or the
# literal UNCHANGED when the hook must emit nothing at all.
check() {
  local got
  got=$(python3 -c "
import json,sys
print(json.dumps({'tool_name':'Bash','tool_input':{'command':sys.argv[1]}}))" "$2" \
    | python3 "$HOOK" \
    | python3 -c "
import json,sys
raw=sys.stdin.read()
print(json.loads(raw)['hookSpecificOutput']['updatedInput']['command'] if raw else 'UNCHANGED')")
  if [[ "$got" == "$3" ]]; then
    pass=$((pass + 1)); printf '  ok   %s\n' "$1"
  else
    fail=$((fail + 1)); printf '  FAIL %s\n         got:    %s\n         wanted: %s\n' "$1" "$got" "$3"
  fi
}

echo "rewrites (the analyzer gets a resolvable target):"
check "the relative operand behind a cd is absolutized" \
  "cd $BASE; grep -rn \"Unbuilt\" internal/ | head -30" \
  "cd $BASE; grep -rn \"Unbuilt\" $BASE/internal/ | head -30"
check "a grep pattern that names a real directory stays the pattern" \
  "cd $BASE; grep -rn docs internal/" \
  "cd $BASE; grep -rn docs $BASE/internal/"
check "-e supplies the pattern, so the first bare operand is a path" \
  "cd $BASE; rg -e Unbuilt internal/" \
  "cd $BASE; rg -e Unbuilt $BASE/internal/"
check "a flag's value is not mistaken for a path" \
  "cd $BASE; grep -rn -A 3 Unbuilt internal/" \
  "cd $BASE; grep -rn -A 3 Unbuilt $BASE/internal/"
check "every operand of a two-path command is rewritten" \
  "cd $BASE; diff internal/ui/yank.go docs/a.md" \
  "cd $BASE; diff $BASE/internal/ui/yank.go $BASE/docs/a.md"
check "a denied directory is absolutized so the deny rule can match it" \
  "cd $BASE; grep -rn KEY .ssh/" \
  "cd $BASE; grep -rn KEY $BASE/.ssh/"

echo "left alone (a prompt is the correct cost of not being sure):"
check "no cd, nothing to resolve" \
  "grep -rn Unbuilt internal/" UNCHANGED
check "already absolute" \
  "cd $BASE; grep -rn Unbuilt $BASE/internal/" UNCHANGED
check "an operand escaping the base via .." \
  "cd $BASE; grep -rn x ../outside/" UNCHANGED
check "an operand that is not on disk" \
  "cd $BASE; grep -rn x nosuchdir/" UNCHANGED
check "command substitution in the remainder" \
  "cd $BASE; grep -rn \$(cat p) internal/" UNCHANGED
check "a redirect in the remainder" \
  "cd $BASE; grep -rn x internal/ > out.txt" UNCHANGED
check "a second cd, after which the base no longer holds" \
  "cd $BASE; cd internal; grep -rn x ui/" UNCHANGED
check "a relative cd target, which resolves to nothing knowable" \
  "cd ../elsewhere; grep -rn x internal/" UNCHANGED
check "a cd target that is not a directory" \
  "cd $BASE/internal/ui/yank.go; grep -rn x internal/" UNCHANGED

echo "fails open (a hook that fails closed wedges every Bash call):"
for payload in 'not json at all' '{}' '{"tool_name":"Read","tool_input":{"file_path":"/x"}}' \
               '{"tool_name":"Bash","tool_input":{}}' '{"tool_name":"Bash"}'; do
  out=$(printf '%s' "$payload" | python3 "$HOOK" 2>/dev/null); rc=$?
  if [[ $rc -eq 0 && -z "$out" ]]; then
    pass=$((pass + 1)); printf '  ok   exit 0 and no output for %s\n' "$payload"
  else
    fail=$((fail + 1)); printf '  FAIL %s -> exit %s, output %q\n' "$payload" "$rc" "$out"
  fi
done

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
