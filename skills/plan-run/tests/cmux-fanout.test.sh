#!/usr/bin/env bash
# Behaviour tests for cmux-fanout.sh — the decisions nothing downstream re-checks.
#
#   bash skills/plan-run/tests/cmux-fanout.test.sh
#
# No cmux app is started and no agent is run: cmux is stubbed on PATH, because what is under test is
# not the fan-out itself but the three judgements the script exists to make, each of which fails by
# returning a confident wrong answer.
#
#   1. Is the tooling actually there. --cmux is typed deliberately, so a missing or unreachable cmux
#      that quietly degraded to a serial run would hand back a different thing than was asked for,
#      with nothing in the report saying so.
#   2. Is a unit finished. An interactive session never exits, so completion is reported rather than
#      observed — and a wave read as finished while one session sits on a prompt lands a branch
#      nobody built. That is why a sentinel alone is not enough and the marker on the branch is
#      checked too.
#   3. How many units are live. The cap is what keeps a wide wave from thrashing, and a caller that
#      forgot it would only find out by watching the machine.
#
# And one thing that is not a judgement but is fatal without it: a worktree is a new path, so Claude
# Code's per-path workspace trust does not follow it. A session started there opens on the trust
# dialog and never reads its prompt, so every unit would stall — which is why the trust cases below
# matter as much as the rest. CLAUDE_CONFIG_DIR points at a throwaway config throughout; the user's
# own ~/.claude.json is never read or written by this suite.
#
# There is no CI, so this suite is the only thing standing between an edit and any of that.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
FAN="$PWD/skills/plan-run/scripts/cmux-fanout.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# A cmux that answers ping and hands back a fresh workspace ref per create, recording every call so
# the tests can assert what was actually asked of it.
STUB="$TMP/stub"; mkdir -p "$STUB"
cat > "$STUB/cmux" <<'STUB_EOF'
#!/bin/sh
echo "$@" >> "$CMUX_STUB_LOG"
case "$1 $2" in
  "ping "*)              [ "${CMUX_STUB_PING:-0}" = 0 ] || exit 1; echo pong; exit 0 ;;
  "workspace create")    n=$(( $(cat "$CMUX_STUB_SEQ" 2>/dev/null || echo 0) + 1 ))
                         echo "$n" > "$CMUX_STUB_SEQ"
                         [ "${CMUX_STUB_CREATE_SILENT:-0}" = 0 ] || exit 0
                         echo "OK workspace:$n"; exit 0 ;;
  "workspace list")      n=$(cat "$CMUX_STUB_SEQ" 2>/dev/null || echo 0); i=1
                         while [ "$i" -le "$n" ]; do
                           echo "  workspace:$i 0000000$i-0000-0000-0000-00000000000$i  unit-$i"
                           i=$((i + 1))
                         done
                         exit 0 ;;
  "workspace close")     echo "OK $3"; exit 0 ;;
esac
exit 0
STUB_EOF
chmod +x "$STUB/cmux"
export PATH="$STUB:$PATH"
export CMUX_STUB_LOG="$TMP/cmux.log" CMUX_STUB_SEQ="$TMP/cmux.seq"
export CMUX_FANOUT_POLL=1

# A private state root per test file, so a developer's real fan-out is never touched and a rerun
# never inherits the last run's units.
export TMPDIR="$TMP"

# A throwaway Claude config, so the trust plumbing is exercised without touching the user's.
export CLAUDE_CONFIG_DIR="$TMP/cfg"; mkdir -p "$CLAUDE_CONFIG_DIR"
trust_repo() { python3 -c "
import json,sys,os
p=os.path.join(os.environ['CLAUDE_CONFIG_DIR'],'.claude.json')
d=json.load(open(p)) if os.path.exists(p) else {}
d.setdefault('projects',{}).setdefault(os.path.realpath(sys.argv[1]),{})['hasTrustDialogAccepted']=bool(int(sys.argv[2]))
json.dump(d,open(p,'w'))" "$1" "${2:-1}"; }
trusted() { python3 -c "
import json,sys,os
p=os.path.join(os.environ['CLAUDE_CONFIG_DIR'],'.claude.json')
d=json.load(open(p))
sys.exit(0 if d.get('projects',{}).get(os.path.realpath(sys.argv[1]),{}).get('hasTrustDialogAccepted') else 1)" "$1"; }

REPO="$TMP/repo"
mkdir -p "$REPO" && cd "$REPO"
git init -q -b main
git config user.email t@example.com; git config user.name test
printf 'a\n' > todo.md && git add -A && git commit -qm base

# The child's half of the contract, faked: land a commit on a branch, then write the sentinel the
# way plan-run's --no-merge step will. Nothing here runs claude.
finish_unit() {   # finish_unit <id> <dir> <branch> <status> [--no-marker]
  local id=$1 dir=$2 br=$3 st=$4 marker=${5:-marker}
  ( cd "$dir" && git checkout -q -b "$br"
    if [ "$marker" = marker ]; then printf 'a\n<!-- built: %s -->\n' "$br" > todo.md
    else printf 'a\nno marker here\n' > todo.md; fi
    git add -A && git commit -qm "$br" ) >/dev/null 2>&1
  local s; s=$(sed -n 's/^sentinel=//p' "$TMP"/cmux-fanout-*/"$id".rec)
  { printf 'status=%s\n' "$st"; printf 'branch=%s\n' "$br"; } > "$s"
}

echo "== preflight refuses rather than degrading to serial =="
cd "$REPO"
out=$("$FAN" preflight 2>&1); rc=$?
[[ $rc != 0 ]] && ok "an untrusted repo refuses — its units would stall on the trust dialog" \
               || bad "an untrusted repo refuses — its units would stall on the trust dialog" "exit 0"
grep -q "trust dialog" <<<"$out" && ok "and says so, rather than inventing trust the user never gave" \
                                 || bad "and says so, rather than inventing trust the user never gave" "$out"

trust_repo "$REPO"
out=$("$FAN" preflight 2>&1); rc=$?
[[ $rc == 0 ]] && ok "a clean primary tree with cmux reachable passes preflight" \
               || bad "a clean primary tree with cmux reachable passes preflight" "exit $rc: $out"

# A PATH holding neither the stub nor a real installation — the machine running this suite may
# well have cmux, and the case under test is a machine that does not.
out=$(PATH="/usr/bin:/bin" "$FAN" preflight 2>&1); rc=$?
[[ $rc != 0 ]] && ok "cmux absent exits non-zero" || bad "cmux absent exits non-zero" "exit 0"
grep -q "not on PATH" <<<"$out" && ok "and says cmux is missing rather than falling back" \
                                || bad "and says cmux is missing rather than falling back" "$out"

out=$(CMUX_STUB_PING=1 "$FAN" preflight 2>&1); rc=$?
[[ $rc != 0 ]] && ok "cmux installed but unreachable exits non-zero" \
               || bad "cmux installed but unreachable exits non-zero" "exit 0"
grep -q "not reachable" <<<"$out" && ok "and distinguishes unreachable from missing" \
                                  || bad "and distinguishes unreachable from missing" "$out"

git worktree add -q --detach "$TMP/probe" HEAD
out=$(cd "$TMP/probe" && "$FAN" preflight 2>&1); rc=$?
[[ $rc != 0 ]] && ok "a linked worktree cannot orchestrate — preflight refuses" \
               || bad "a linked worktree cannot orchestrate — preflight refuses" "exit 0"
git worktree remove --force "$TMP/probe" >/dev/null 2>&1

printf 'dirty\n' > scratch.txt
out=$("$FAN" preflight 2>&1); rc=$?
[[ $rc != 0 ]] && ok "a dirty tree refuses — units would branch off uncommitted work" \
               || bad "a dirty tree refuses — units would branch off uncommitted work" "exit 0"
rm -f scratch.txt

echo
echo "== spawn builds the worktree and a watchable interactive session =="
out=$("$FAN" spawn --id p1 --dir "$TMP/wt-p1" --base main \
        --prompt '/r:plan-run todo.md --phases 1 --no-merge --yes' \
        --marker-file todo.md --marker-prefix 'built: ' --orchestrator 'orch-99' 2>&1); rc=$?
[[ $rc == 0 ]] && ok "spawn exits 0" || bad "spawn exits 0" "exit $rc: $out"
[[ -d "$TMP/wt-p1" ]] && ok "and creates the detached worktree" \
                      || bad "and creates the detached worktree" "$TMP/wt-p1 missing"
grep -q "workspace=workspace:" <<<"$out" && ok "and reports the workspace ref it got back" \
                                         || bad "and reports the workspace ref it got back" "$out"
grep -q -- "--permission-mode auto" "$CMUX_STUB_LOG" \
  && ok "the session runs under --permission-mode auto" \
  || bad "the session runs under --permission-mode auto" "$(cat "$CMUX_STUB_LOG")"
grep -q -- "-p " "$CMUX_STUB_LOG" \
  && bad "the session is an interactive TUI, never headless -p" "$(cat "$CMUX_STUB_LOG")" \
  || ok "the session is an interactive TUI, never headless -p"
grep -q "CMUX_FANOUT_SENTINEL=" "$CMUX_STUB_LOG" \
  && ok "and is handed the sentinel path it must write" \
  || bad "and is handed the sentinel path it must write" "$(cat "$CMUX_STUB_LOG")"
trusted "$TMP/wt-p1" && ok "the new worktree inherits the repo's workspace trust" \
                     || bad "the new worktree inherits the repo's workspace trust" "not marked trusted"
# The unit is told who spawned it, so an alarm goes UPWARDS to a known address. Downwards would need
# discovery against every session on the machine, which is why only this direction is wired.
grep -q "CMUX_FANOUT_ORCHESTRATOR=orch-99" "$CMUX_STUB_LOG" \
  && ok "and is told the orchestrator's name, so it can raise an alarm upwards" \
  || bad "and is told the orchestrator's name, so it can raise an alarm upwards" "$(cat "$CMUX_STUB_LOG")"
: > "$CMUX_STUB_LOG"
"$FAN" spawn --id pnoorch --dir "$TMP/wt-pnoorch" --base main --prompt x >/dev/null 2>&1
grep -q "CMUX_FANOUT_ORCHESTRATOR" "$CMUX_STUB_LOG" \
  && bad "omitting --orchestrator leaves the variable unset, never empty" "$(cat "$CMUX_STUB_LOG")" \
  || ok "omitting --orchestrator leaves the variable unset, never empty"
"$FAN" cleanup --id pnoorch >/dev/null 2>&1


out=$("$FAN" spawn --id p1 --dir "$TMP/wt-dup" --base main --prompt x 2>&1); rc=$?
[[ $rc != 0 ]] && ok "a duplicate id is refused rather than overwriting a live unit" \
               || bad "a duplicate id is refused rather than overwriting a live unit" "exit 0"

: > "$CMUX_STUB_LOG"
out=$(CMUX_STUB_CREATE_SILENT=1 "$FAN" spawn --id px --dir "$TMP/wt-px" --base main --prompt x 2>&1); rc=$?
[[ $rc != 0 ]] && ok "a create that returns no ref is a failure, not a unit with no workspace" \
               || bad "a create that returns no ref is a failure, not a unit with no workspace" "exit 0"
[[ ! -d "$TMP/wt-px" ]] && ok "and its half-made worktree is rolled back" \
                        || bad "and its half-made worktree is rolled back" "$TMP/wt-px survived"

echo
echo "== the cap is enforced where a caller cannot forget it =="
"$FAN" spawn --id p2 --dir "$TMP/wt-p2" --base main --prompt x \
       --marker-file todo.md --marker-prefix 'built: ' >/dev/null 2>&1
"$FAN" spawn --id p3 --dir "$TMP/wt-p3" --base main --prompt x \
       --marker-file todo.md --marker-prefix 'built: ' >/dev/null 2>&1
out=$("$FAN" spawn --id p4 --dir "$TMP/wt-p4" --base main --prompt x 2>&1); rc=$?
[[ $rc != 0 ]] && ok "a fourth live unit is refused" || bad "a fourth live unit is refused" "exit 0"
grep -q "the cap is 3" <<<"$out" && ok "and the message names the cap" \
                                 || bad "and the message names the cap" "$out"
[[ ! -d "$TMP/wt-p4" ]] && ok "and no worktree is left behind by the refusal" \
                        || bad "and no worktree is left behind by the refusal" "$TMP/wt-p4 exists"

echo
echo "== a finished unit is taken down, and that is what frees the slot =="
finish_unit p3 "$TMP/wt-p3" phase-three ok
out=$("$FAN" cleanup --id p3 2>&1); rc=$?
[[ $rc == 0 ]] && ok "cleanup on a finished unit exits 0" || bad "cleanup on a finished unit exits 0" "$out"
[[ ! -d "$TMP/wt-p3" ]] && ok "and removes its worktree" || bad "and removes its worktree" "still there"
grep -q "workspace close" "$CMUX_STUB_LOG" && ok "and closes its workspace" \
                                           || bad "and closes its workspace" "$(cat "$CMUX_STUB_LOG")"
# By UUID, not by the ref create handed back: cleanup runs long after spawn, and a ref is the one
# handle that could have come to mean a different workspace by then.
grep -qE "workspace close 0000000[0-9]-" "$CMUX_STUB_LOG" \
  && ok "closing it by UUID, never by the ref it was created with" \
  || bad "closing it by UUID, never by the ref it was created with" "$(cat "$CMUX_STUB_LOG")"
out=$("$FAN" spawn --id p4 --dir "$TMP/wt-p4" --base main --prompt x \
        --marker-file todo.md --marker-prefix 'built: ' 2>&1); rc=$?
[[ $rc == 0 ]] && ok "the freed slot admits exactly one more unit" \
               || bad "the freed slot admits exactly one more unit" "exit $rc: $out"
out=$("$FAN" spawn --id p5 --dir "$TMP/wt-p5" --base main --prompt x 2>&1); rc=$?
[[ $rc != 0 ]] && ok "and only one — the fifth is still refused" \
               || bad "and only one — the fifth is still refused" "exit 0"

printf 'uncommitted\n' > "$TMP/wt-p4/scratch.txt"
out=$("$FAN" cleanup --id p4 2>&1); rc=$?
[[ $rc != 0 ]] && ok "cleanup refuses a worktree with uncommitted changes" \
               || bad "cleanup refuses a worktree with uncommitted changes" "exit 0"
[[ -d "$TMP/wt-p4" ]] && ok "and leaves the evidence in place" \
                      || bad "and leaves the evidence in place" "removed anyway"
rm -f "$TMP/wt-p4/scratch.txt"
"$FAN" cleanup --id p4 >/dev/null 2>&1

echo
echo "== a unit is finished only when its report AND the repo agree =="
finish_unit p1 "$TMP/wt-p1" phase-one ok
out=$("$FAN" wait --id p1 --timeout 5 2>&1); rc=$?
[[ $rc == 0 ]] && ok "a success sentinel on a marked branch reports ok" \
               || bad "a success sentinel on a marked branch reports ok" "exit $rc: $out"
grep -q "^p1 ok phase-one" <<<"$out" && ok "and names the branch to land" \
                                     || bad "and names the branch to land" "$out"

finish_unit p2 "$TMP/wt-p2" phase-two ok no-marker
out=$("$FAN" wait --id p2 --timeout 5 2>&1); rc=$?
[[ $rc == 1 ]] && ok "a success sentinel on an UNMARKED branch is not landable" \
               || bad "a success sentinel on an UNMARKED branch is not landable" "exit $rc: $out"
grep -q "no-marker" <<<"$out" && ok "and says the marker is what is missing" \
                              || bad "and says the marker is what is missing" "$out"

sfile=$(sed -n 's/^sentinel=//p' "$TMP"/cmux-fanout-*/p2.rec)
{ printf 'status=halted\n'; printf 'branch=phase-two\n'; printf 'reason=build red\n'; } > "$sfile"
out=$("$FAN" wait --id p2 --timeout 5 2>&1); rc=$?
[[ $rc == 1 ]] && ok "a failure sentinel reports failed" || bad "a failure sentinel reports failed" "exit $rc: $out"
grep -q "build red" <<<"$out" && ok "and carries the child's own reason through" \
                              || bad "and carries the child's own reason through" "$out"

{ printf 'status=ok\n'; } > "$sfile"
out=$("$FAN" wait --id p2 --timeout 5 2>&1); rc=$?
[[ $rc == 1 ]] && ok "a success sentinel naming no branch is failed, not assumed" \
               || bad "a success sentinel naming no branch is failed, not assumed" "exit $rc: $out"

echo
echo "== a missing sentinel times out; it never reads as done =="
"$FAN" cleanup --id p2 >/dev/null 2>&1
"$FAN" spawn --id p6 --dir "$TMP/wt-p6" --base main --prompt x \
       --marker-file todo.md --marker-prefix 'built: ' >/dev/null 2>&1
: > "$CMUX_STUB_LOG"
out=$("$FAN" wait --id p6 --timeout 2 2>&1); rc=$?
[[ $rc == 3 ]] && ok "a unit that never reports times out with exit 3" \
               || bad "a unit that never reports times out with exit 3" "exit $rc: $out"
grep -q "p6" <<<"$out" && ok "and names the stalled unit" || bad "and names the stalled unit" "$out"
grep -q "workspace close" "$CMUX_STUB_LOG" \
  && bad "a stalled unit's workspace is left open for a human" "$(cat "$CMUX_STUB_LOG")" \
  || ok "a stalled unit's workspace is left open for a human"
[[ -d "$TMP/wt-p6" ]] && ok "and its worktree survives the timeout" \
                      || bad "and its worktree survives the timeout" "removed"

out=$("$FAN" status 2>&1)
grep -q "^p6 live" <<<"$out" && ok "status reports it live rather than finished" \
                             || bad "status reports it live rather than finished" "$out"

echo
echo "== usage errors are never a silent success =="
out=$("$FAN" nonsense 2>&1); rc=$?
[[ $rc != 0 ]] && ok "an unknown subcommand exits non-zero" \
               || bad "an unknown subcommand exits non-zero" "exit 0"
out=$("$FAN" spawn --id only 2>&1); rc=$?
[[ $rc != 0 ]] && ok "spawn without its required arguments exits non-zero" \
               || bad "spawn without its required arguments exits non-zero" "exit 0"
out=$("$FAN" wait --id nosuch --timeout 2 2>&1); rc=$?
[[ $rc != 0 ]] && ok "waiting on a unit that was never spawned exits non-zero" \
               || bad "waiting on a unit that was never spawned exits non-zero" "exit 0"
out=$("$FAN" cleanup --id nosuch 2>&1); rc=$?
[[ $rc != 0 ]] && ok "cleaning up a unit that was never spawned exits non-zero" \
               || bad "cleaning up a unit that was never spawned exits non-zero" "exit 0"

cd "$REPO" && git worktree remove --force "$TMP/wt-p6" >/dev/null 2>&1
cd "$REPO" && git worktree remove --force "$TMP/wt-p1" >/dev/null 2>&1

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ $fail == 0 ]]
