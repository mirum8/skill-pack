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
PACK=$PWD          # the pack root; $REPO below is a throwaway git repo, not this one
FAN="$PACK/skills/plan-run/scripts/cmux-fanout.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# A cmux that answers ping and hands back a fresh workspace ref per create, recording every call so
# the tests can assert what was actually asked of it.
STUB="$TMP/stub"; mkdir -p "$STUB"
# The stub RUNS the child command line (see `workspace create` below) so that a line broken by bad
# quoting fails here exactly as it fails for real. That command ends in `exec claude ...`, and a
# real `claude` is on PATH in a developer's shell -- so it is shadowed here. Without this the suite
# launches live interactive sessions.
# It records its ARGV, one argument per line, because that is the only thing that can tell correct
# quoting from a prompt that merely appears somewhere in the command string: a broken quote splits
# the prompt across several argv entries (or never reaches claude at all), while the raw text still
# shows up in a log of the command line either way.
cat > "$STUB/claude" <<'CLAUDE_EOF'
#!/bin/sh
: > "${CMUX_CLAUDE_ARGV:-/dev/null}"
for a in "$@"; do printf '%s\n' "$a" >> "${CMUX_CLAUDE_ARGV:-/dev/null}"; done
exit 0
CLAUDE_EOF
chmod +x "$STUB/claude"
cat > "$STUB/cmux" <<'STUB_EOF'
#!/bin/sh
echo "$@" >> "$CMUX_STUB_LOG"
case "$1 $2" in
  "ping "*)              [ "${CMUX_STUB_PING:-0}" = 0 ] || exit 1; echo pong; exit 0 ;;
  "workspace create")    n=$(( $(cat "$CMUX_STUB_SEQ" 2>/dev/null || echo 0) + 1 ))
                         echo "$n" > "$CMUX_STUB_SEQ"
                         # The real child writes its start marker and then execs claude. The stub
                         # RUNS the --command through a shell so the marker appears exactly when a
                         # real one would -- which means a command line broken by bad quoting fails
                         # here the same way it fails for real, and the suite can tell them apart.
                         [ "${CMUX_STUB_NO_START:-0}" = 0 ] && {
                           for a in "$@"; do
                             case $prev in --command) sh -c "$a" >/dev/null 2>&1 || true ;; esac
                             prev=$a
                           done
                         }
                         [ "${CMUX_STUB_CREATE_SILENT:-0}" = 0 ] || exit 0
                         echo "OK workspace:$n"; exit 0 ;;
  "workspace list")      [ "${CMUX_STUB_LIST_FAIL:-0}" = 0 ] || exit 1
                         [ "${CMUX_STUB_LIST_EMPTY:-0}" = 0 ] || exit 0
                         n=$(cat "$CMUX_STUB_SEQ" 2>/dev/null || echo 0); i=1
                         while [ "$i" -le "$n" ]; do
                           [ "$i" = "${CMUX_STUB_LIST_SKIP:-}" ] || \
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
P1_PROMPT='/r:plan-run todo.md --phases 1 --no-merge --yes'
out=$("$FAN" spawn --id p1 --dir "$TMP/wt-p1" --base main \
        --prompt "$P1_PROMPT" \
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
# Without this the unit reaches its implement step and is refused the canonical pipeline, because
# the Workflow tool only accepts a scriptPath under the cwd or a directory the session was given.
# It fails late and quietly: the worktree is clean, so the wave looks merely unproductive.
grep -q -- "--add-dir '$PACK'" "$CMUX_STUB_LOG" \
  && ok "and is given the pack root, so it can run the canonical pipelines" \
  || bad "and is given the pack root, so it can run the canonical pipelines" "$(cat "$CMUX_STUB_LOG")"
# Presence is not enough, which is the whole reason this assertion is separate: `--add-dir` takes a
# variadic list, so a prompt placed after it is swallowed as one more directory and the session
# comes up empty — with the flag still present, spelled exactly as the check above wants it. Such a
# unit runs no skill, so it never halts, never sentinels, and `wait` calls it live for four hours.
cmd_line=$(grep -F -- "--add-dir" "$CMUX_STUB_LOG" | head -1)
before_dirs=${cmd_line%%--add-dir*}
[[ "$before_dirs" == *"'$P1_PROMPT'"* ]] \
  && ok "with the prompt AHEAD of them — a variadic --add-dir would eat it" \
  || bad "with the prompt AHEAD of them — a variadic --add-dir would eat it" "$cmd_line"
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

# A pack reached through a symlink — the shipped layout, where ~/.claude is one — passes the tool's
# pre-resolution check under the name it was called by and fails the post-resolution one under its
# real path. So both spellings go across, and the link is built here rather than assumed: this repo
# is not itself behind one, and a case that only fires on someone else's machine tests nothing.
: > "$CMUX_STUB_LOG"
ln -s "$PACK" "$TMP/packlink"
"$TMP/packlink/skills/plan-run/scripts/cmux-fanout.sh" \
  spawn --id plink --dir "$TMP/wt-plink" --base main --prompt x >/dev/null 2>&1
PACK_REAL=$(cd "$PACK" && pwd -P)
grep -q -- "--add-dir '$TMP/packlink'" "$CMUX_STUB_LOG" \
  && ok "a pack reached through a symlink sends the path it was called by" \
  || bad "a pack reached through a symlink sends the path it was called by" "$(cat "$CMUX_STUB_LOG")"
grep -q -- "--add-dir '$PACK_REAL'" "$CMUX_STUB_LOG" \
  && ok "and its resolved path too — the tool re-checks after resolving" \
  || bad "and its resolved path too — the tool re-checks after resolving" "$(cat "$CMUX_STUB_LOG")"
# Two flags is where the variadic bite is worst, so the ordering is asserted here as well as on the
# single-flag spawn above.
link_line=$(grep -F -- "--add-dir" "$CMUX_STUB_LOG" | head -1)
[[ "${link_line%%--add-dir*}" == *"'x'"* ]] \
  && ok "and the prompt still leads, with two directories trailing it" \
  || bad "and the prompt still leads, with two directories trailing it" "$link_line"
"$FAN" cleanup --id plink >/dev/null 2>&1


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
# The cap is a SETTING now (`steps.fanout.maxUnits`), so the spawn counts below are only meaningful
# if this checkout resolves the shipped 3. Say so rather than failing four cases with an off-by-one
# that reads like a broken script.
CAP=$(cd "$PACK" && python3 lib/read-config.py --step fanout --field maxUnits 2>/dev/null)
[[ $CAP == 3 ]] && ok "this checkout resolves the shipped cap of 3" \
                || bad "this checkout resolves the shipped cap of 3" \
                       "resolved '$CAP' — a .config/skill-pack.yaml in this repo would do that, and the counts below assume 3"
"$FAN" spawn --id p2 --dir "$TMP/wt-p2" --base main --prompt x \
       --marker-file todo.md --marker-prefix 'built: ' >/dev/null 2>&1
"$FAN" spawn --id p3 --dir "$TMP/wt-p3" --base main --prompt x \
       --marker-file todo.md --marker-prefix 'built: ' >/dev/null 2>&1
out=$("$FAN" spawn --id p4 --dir "$TMP/wt-p4" --base main --prompt x 2>&1); rc=$?
[[ $rc != 0 ]] && ok "a fourth live unit is refused" || bad "a fourth live unit is refused" "exit 0"
grep -q "the cap is $CAP" <<<"$out" && ok "and the message names the cap" \
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
echo "== a marker git cannot read is dropped at spawn, not failed at wait =="
# The repro: a repo that gitignores its backlog directory. `unit_verdict` reads the
# marker with `git show "<branch>:<file>"`, which for an untracked path fails on every
# branch -- so without the guard a unit that fixed, reviewed and committed its group
# cleanly comes back `no-marker`, reading as a broken fix rather than a missing file.
( cd "$REPO" && printf '/issues/\n' > .gitignore && mkdir -p issues \
  && printf -- '- [ ] a\n' > issues/backlog.md \
  && git add .gitignore && git commit -qm ignore-issues ) >/dev/null 2>&1
cd "$REPO"
git cat-file -e "main:issues/backlog.md" 2>/dev/null \
  && bad "the fixture's backlog really is untracked" "git can read it" \
  || ok "the fixture's backlog really is untracked"

out=$("$FAN" spawn --id pu --dir "$TMP/wt-pu" --base main --prompt x \
        --marker-file issues/backlog.md --marker-prefix 'built: ' 2>&1); rc=$?
[[ $rc == 0 ]] && ok "spawn still exits 0 — an untracked backlog is not a stop" \
               || bad "spawn still exits 0 — an untracked backlog is not a stop" "exit $rc: $out"
grep -q "not tracked" <<<"$out" \
  && ok "and names the weakened gate rather than dropping it silently" \
  || bad "and names the weakened gate rather than dropping it silently" "$out"
grep -q "^marker_file=$" "$TMP"/cmux-fanout-*/pu.rec \
  && ok "and records no marker file for the unit" \
  || bad "and records no marker file for the unit" "$(cat "$TMP"/cmux-fanout-*/pu.rec)"

finish_unit pu "$TMP/wt-pu" untracked-backlog ok no-marker
out=$("$FAN" wait --id pu --timeout 5 2>&1); rc=$?
[[ $rc == 0 ]] && ok "a clean unit under an untracked backlog lands on its sentinel and branch" \
               || bad "a clean unit under an untracked backlog lands on its sentinel and branch" "exit $rc: $out"
grep -q "^pu ok untracked-backlog" <<<"$out" && ok "and names the branch to land" \
                                             || bad "and names the branch to land" "$out"
"$FAN" cleanup --id pu >/dev/null 2>&1

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
echo "== a unit whose session died is not waited out =="
# p6 is still live and still has no sentinel. Its workspace is the last one the stub created,
# so dropping that row from the listing is exactly "the session went away".
seq=$(cat "$CMUX_STUB_SEQ")
out=$(CMUX_STUB_LIST_SKIP="$seq" "$FAN" wait --id p6 --timeout 60 2>&1); rc=$?
[[ $rc == 1 ]] && ok "a vanished workspace fails fast instead of timing out" \
               || bad "a vanished workspace fails fast instead of timing out" "exit $rc: $out"
grep -q "workspace gone" <<<"$out" && ok "and says the session died rather than stalled" \
                                  || bad "and says the session died rather than stalled" "$out"
[[ -d "$TMP/wt-p6" ]] && ok "and its worktree survives, holding whatever it committed" \
                      || bad "and its worktree survives, holding whatever it committed" "removed"

# The two ways the answer is "cannot tell". Both must keep waiting: declaring every live unit
# dead because cmux hiccuped is the confident wrong answer, and it would abandon a whole wave.
out=$(CMUX_STUB_LIST_FAIL=1 "$FAN" wait --id p6 --timeout 2 2>&1); rc=$?
[[ $rc == 3 ]] && ok "cmux unreachable is 'cannot tell', so the wait stands" \
               || bad "cmux unreachable is 'cannot tell', so the wait stands" "exit $rc: $out"
out=$(CMUX_STUB_LIST_EMPTY=1 "$FAN" wait --id p6 --timeout 2 2>&1); rc=$?
[[ $rc == 3 ]] && ok "an empty listing is 'cannot tell' too" \
               || bad "an empty listing is 'cannot tell' too" "exit $rc: $out"

echo
echo "== --any rolls the window instead of waiting on the slowest =="
# A wave is a rolling window only if the caller can be told about the FIRST unit back rather than
# the last. Bare `wait` blocks until every unit in the set has a sentinel, which is batches waiting
# on the slowest; `--any` is what lets the freed slot admit the next queued leaf while the rest are
# still working. It cannot be built from the other subcommands: the alternative is polling `status`
# on a timer, which is deciding "is it done yet" by re-reading a report — exactly the shape this
# script exists to keep away from the caller.
while IFS= read -r line; do
  case $line in *workspace=*) "$FAN" cleanup --id "${line%% *}" >/dev/null 2>&1 ;; esac
done < <("$FAN" status 2>/dev/null)
for u in a1 a2 a3; do
  "$FAN" spawn --id "$u" --dir "$TMP/wt-$u" --base main --prompt x \
         --marker-file todo.md --marker-prefix 'built: ' >/dev/null 2>&1
done

finish_unit a2 "$TMP/wt-a2" phase-a2 ok
out=$("$FAN" wait --any --timeout 3 2>&1); rc=$?
[[ $rc == 0 ]] && ok "--any returns on the first unit back, with two still working" \
               || bad "--any returns on the first unit back, with two still working" "exit $rc: $out"
grep -q "^a2 ok phase-a2" <<<"$out" && ok "and names exactly that unit, ready to land and cleanup" \
                                    || bad "and names exactly that unit, ready to land and cleanup" "$out"
grep -qE "^(a1|a3) " <<<"$out" && bad "and says nothing about the units still working" "$out" \
                               || ok "and says nothing about the units still working"

out=$("$FAN" wait --timeout 2 2>&1); rc=$?
[[ $rc == 3 ]] && ok "bare wait over the same set still blocks on the slowest — the two shapes differ" \
               || bad "bare wait over the same set still blocks on the slowest — the two shapes differ" "exit $rc: $out"
out=$("$FAN" wait --any --id a1 --id a3 --timeout 2 2>&1); rc=$?
[[ $rc == 3 ]] && ok "--any honours an explicit --id set rather than always scanning every live unit" \
               || bad "--any honours an explicit --id set rather than always scanning every live unit" "exit $rc: $out"

# The trap the once-only rule exists for. A failed unit is REQUIRED to be left standing — workspace
# open, worktree in place, since that state is the only evidence of what went wrong — so it keeps
# its rec and stays live. Handed back on every later call, it would starve its wave-mates forever:
# a loop that never ends and never says why.
finish_unit a1 "$TMP/wt-a1" phase-a1 halted
out=$("$FAN" wait --any --timeout 3 2>&1); rc=$?
[[ $rc == 1 ]] && ok "a failed unit comes back through --any as failed, not as ok" \
               || bad "a failed unit comes back through --any as failed, not as ok" "exit $rc: $out"
grep -q "^a1 failed" <<<"$out" && ok "and is named" || bad "and is named" "$out"
out=$("$FAN" wait --any --timeout 2 2>&1); rc=$?
[[ $rc == 3 ]] && ok "and is not handed back twice — the wait moves on to the unit still working" \
               || bad "and is not handed back twice — the wait moves on to the unit still working" "exit $rc: $out"
grep -q "a3" <<<"$out" && ok "naming that one, while the failed unit stays standing" \
                       || bad "naming that one, while the failed unit stays standing" "$out"
[[ -d "$TMP/wt-a1" ]] && ok "a reported failure is still left standing for a human" \
                      || bad "a reported failure is still left standing for a human" "removed"

# What the whole flag is for: cleanup the unit --any named, and the slot it frees takes the next.
"$FAN" cleanup --id a2 >/dev/null 2>&1
out=$("$FAN" spawn --id a4 --dir "$TMP/wt-a4" --base main --prompt x 2>&1); rc=$?
[[ $rc == 0 ]] && ok "the slot freed by cleaning up that unit admits the next while the rest work" \
               || bad "the slot freed by cleaning up that unit admits the next while the rest work" "exit $rc: $out"

# Nothing pending and nothing unreported is not a wait, it is an answer. Blocking four hours over
# units that cannot change would be indistinguishable from a stall.
finish_unit a3 "$TMP/wt-a3" phase-a3 ok
finish_unit a4 "$TMP/wt-a4" phase-a4 ok
out=$("$FAN" wait --any --timeout 5 2>&1); rc=$?
grep -q "^a3 " <<<"$out" && grep -q "^a4 " <<<"$out" \
  && ok "two units back in one tick are both handed over, not one and a re-wait" \
  || bad "two units back in one tick are both handed over, not one and a re-wait" "$out"
out=$("$FAN" wait --any --timeout 5 2>&1); rc=$?
[[ $rc == 0 ]] && ok "with everything already handed back, --any returns instead of blocking" \
               || bad "with everything already handed back, --any returns instead of blocking" "exit $rc: $out"
grep -q "no unreported units" <<<"$out" \
  && ok "and says why, so a caller that lost its place reads status rather than hanging" \
  || bad "and says why, so a caller that lost its place reads status rather than hanging" "$out"

# The mark is the unit's, not the id's: cleanup takes it away with everything else, so an id reused
# later is a new unit rather than a silently pre-reported one.
"$FAN" cleanup --id a3 >/dev/null 2>&1
"$FAN" spawn --id a3 --dir "$TMP/wt-a3" --base main --prompt x >/dev/null 2>&1
finish_unit a3 "$TMP/wt-a3" phase-a3-again ok
out=$("$FAN" wait --any --id a3 --timeout 3 2>&1); rc=$?
grep -q "^a3 ok phase-a3-again" <<<"$out" \
  && ok "cleanup clears the once-only mark, so a reused id reports again" \
  || bad "cleanup clears the once-only mark, so a reused id reports again" "exit $rc: $out"

for u in a1 a3 a4; do "$FAN" cleanup --id "$u" >/dev/null 2>&1; done

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

echo
echo "== the cap comes from the config, and a bad one never becomes no cap =="
# The script compares with `-ge`, so an empty cap would let every spawn through and cap nothing.
# That is the failure this block exists for — a cap that reads as "unlimited" looks like a working
# fan-out right up until the machine thrashes.
CAPREPO="$TMP/caprepo"; mkdir -p "$CAPREPO/.config"
git -C "$CAPREPO" init -q 2>/dev/null
capof() { (cd "$CAPREPO" && "$FAN" status 2>/dev/null | sed -n 's|.*/\([0-9]*\) slots in use|\1|p'); }
printf 'steps:\n  fanout:\n    maxUnits: 5\n' > "$CAPREPO/.config/skill-pack.yaml"
[[ $(capof) == 5 ]] && ok "a project config raises the cap" \
                    || bad "a project config raises the cap" "got '$(capof)'"
printf 'steps:\n  fanout:\n    maxUnits: 1\n' > "$CAPREPO/.config/skill-pack.yaml"
[[ $(capof) == 1 ]] && ok "and can lower it to a serial wave" \
                    || bad "and can lower it to a serial wave" "got '$(capof)'"
for junk in '' 'many' '0' '-2' '400'; do
  printf 'steps:\n  fanout:\n    maxUnits: %s\n' "$junk" > "$CAPREPO/.config/skill-pack.yaml"
  [[ $(capof) == 3 ]] && ok "a cap of '${junk:-<empty>}' falls back to the shipped 3" \
                      || bad "a cap of '${junk:-<empty>}' falls back to the shipped 3" "got '$(capof)'"
done
rm -f "$CAPREPO/.config/skill-pack.yaml"
[[ $(capof) == 3 ]] && ok "and no project file at all resolves the shipped cap" \
                    || bad "and no project file at all resolves the shipped cap" "got '$(capof)'"

echo
echo "== a unit's tree gets the test-app fixtures, and only the fixtures =="
# `git worktree add` checks out TRACKED files only, and the generated /test-app skill keeps what it
# needs to reach a live target on gitignored paths -- `r:test-app-create` writes test_creds.txt and
# gitignores it itself. Without the copy, the unit holds the skill and not what the skill reads, so
# its UI verification blocks on every unit of every credentialed project and subtracts from the
# merge gate without ever looking like a fan-out problem.
#
# The other half is what must NOT be copied: the same directory accumulates that skill's own
# captured frames, and handing a unit a predecessor's screen to read as this run's evidence is the
# confident-wrong-answer this script exists to stop. So both directions are asserted here -- a test
# that only checked the fixture arrived would pass a script that copied all 172 files.
FX="$TMP/fxrepo"; mkdir -p "$FX/.claude/skills/test-app/cluster" "$FX/.claude/skills/test-app/e2e/frames"
git -C "$FX" init -q; git -C "$FX" config user.email t@t; git -C "$FX" config user.name t
printf 'kubeconfig at cluster/kubeconfig.yaml, creds at test_creds.txt\n' > "$FX/.claude/skills/test-app/SKILL.md"
printf 'apiVersion: v1\n'  > "$FX/.claude/skills/test-app/cluster/kubeconfig.yaml"
printf 'u=admin\n'         > "$FX/.claude/skills/test-app/test_creds.txt"
printf 'stale screen\n'    > "$FX/.claude/skills/test-app/e2e/frames/geom-80x24.txt"
printf '.claude/skills/test-app/cluster/\n.claude/skills/test-app/test_creds.txt\n.claude/skills/test-app/e2e/frames/\n' > "$FX/.gitignore"
printf 'a\n' > "$FX/todo.md"
git -C "$FX" add -A >/dev/null; git -C "$FX" commit -qm base
FXBASE=$(git -C "$FX" rev-parse HEAD)
trust_repo "$FX"

out=$(cd "$FX" && PATH="$STUB:$PATH" "$FAN" spawn \
        --id fx --dir "$TMP/wt-fx" --base "$FXBASE" --prompt 'go' 2>&1)

[ -f "$TMP/wt-fx/.claude/skills/test-app/cluster/kubeconfig.yaml" ] \
  && ok "the gitignored kubeconfig the skill names is in the unit tree" \
  || bad "the gitignored kubeconfig the skill names is in the unit tree" "$out"
[ -f "$TMP/wt-fx/.claude/skills/test-app/test_creds.txt" ] \
  && ok "and so is the credentials file" \
  || bad "and so is the credentials file" "$out"
[ -f "$TMP/wt-fx/.claude/skills/test-app/e2e/frames/geom-80x24.txt" ] \
  && bad "a previous run's captured frame is NOT copied" "geom-80x24.txt was copied into the unit tree" \
  || ok "a previous run's captured frame is NOT copied"
grep -q "copied test-app fixture '.claude/skills/test-app/test_creds.txt'" <<<"$out" \
  && ok "and every copied fixture is named out loud" \
  || bad "and every copied fixture is named out loud" "$out"

cd "$FX" && git worktree remove --force "$TMP/wt-fx" >/dev/null 2>&1
cd "$REPO"

echo
echo "== a prompt is passed to the child intact, apostrophes and all =="
# The prompt is a DOCUMENTED input and callers are told to compose free prose; prose about a
# checklist quotes the checklist. Interpolated raw into "... '"'"'$prompt'"'"' ...", one apostrophe closes
# the quoting and the rest is parsed as shell -- an observed spawn hit `<port>`, zsh read it as an
# input redirection, and the child sat at a `quote>` prompt forever. Nothing caught it: a shell WAS
# running, so `status` said live for twenty minutes and `wait` would have blocked on a sentinel
# nobody was going to write. So both halves are asserted here -- that the prompt survives, and that
# a child which never reaches `claude` is refused rather than reported as spawned.
QREPO="$TMP/qrepo"; mkdir -p "$QREPO"
git -C "$QREPO" init -q -b main; git -C "$QREPO" config user.email t@t; git -C "$QREPO" config user.name t
printf 'a\n' > "$QREPO/todo.md"; git -C "$QREPO" add -A >/dev/null; git -C "$QREPO" commit -qm base
QBASE=$(git -C "$QREPO" rev-parse HEAD); trust_repo "$QREPO"

NASTY=$(cat <<'NASTY_EOF'
don't drop this: open <port> and check "the box" — it's Phase 33
NASTY_EOF
)
ARGV="$TMP/claude-argv"; export CMUX_CLAUDE_ARGV="$ARGV"; rm -f "$ARGV"
out=$(cd "$QREPO" && PATH="$STUB:$PATH" "$FAN" spawn \
        --id q1 --dir "$TMP/wt-q1" --base "$QBASE" --prompt "$NASTY" 2>&1); rc=$?

[ "$rc" = 0 ] && ok "a prompt full of quotes and angle brackets spawns cleanly" \
              || bad "a prompt full of quotes and angle brackets spawns cleanly" "rc=$rc $out"
# The stub runs the --command through `sh -c`, so a command line broken by bad quoting fails there
# exactly as it fails for real -- which is what makes this assertion discriminate.
# ONE argv entry, byte-identical. A prompt that merely appears in the command string proves
# nothing: that is true of the broken version too, which is what the observed failure looked like.
got=$(grep -cFx "$NASTY" "$ARGV" 2>/dev/null || echo 0)
[ "$got" = 1 ] \
  && ok "and claude receives the prompt as ONE argument, byte for byte" \
  || bad "and claude receives the prompt as ONE argument, byte for byte" "matched $got line(s) in $(wc -l < "$ARGV" 2>/dev/null || echo 0)-line argv"
grep -qx -- '--permission-mode' "$ARGV" \
  && ok "and the flags before it are still their own arguments" \
  || bad "and the flags before it are still their own arguments" "$(cat "$ARGV" 2>/dev/null)"
[ -f "$TMP"/cmux-fanout-*/q1.started ] \
  && ok "and the child recorded that it actually started" \
  || bad "and the child recorded that it actually started" "no start marker"

echo
echo "== a child that never reaches claude is NOT reported as spawned =="
# The second defect, independent of the quoting: a workspace that CREATED is not a session that
# STARTED, and every failure shape here (bad command line, missing binary, a shell at a continuation
# prompt) leaves a live shell behind that `status` cannot tell from a working unit.
out=$(cd "$QREPO" && CMUX_STUB_NO_START=1 PATH="$STUB:$PATH" "$FAN" spawn \
        --id q2 --dir "$TMP/wt-q2" --base "$QBASE" --prompt 'plain' 2>&1); rc=$?
[ "$rc" != 0 ] && ok "spawn fails when the child never started" \
               || bad "spawn fails when the child never started" "rc=$rc $out"
grep -q "never started" <<<"$out" \
  && ok "and says so, rather than a generic error" \
  || bad "and says so, rather than a generic error" "$out"
[ -e "$TMP/wt-q2" ] \
  && bad "and the worktree is cleaned up, not left behind" "$TMP/wt-q2 still exists" \
  || ok "and the worktree is cleaned up, not left behind"
[ -e "$(ls -d "$TMP"/cmux-fanout-*/q2.rec 2>/dev/null)" ] \
  && bad "and no unit record is written for a unit that never ran" "q2.rec exists" \
  || ok "and no unit record is written for a unit that never ran"

cd "$QREPO" && git worktree remove --force "$TMP/wt-q1" >/dev/null 2>&1
cd "$REPO"

cd "$REPO" && git worktree remove --force "$TMP/wt-p6" >/dev/null 2>&1
cd "$REPO" && git worktree remove --force "$TMP/wt-p1" >/dev/null 2>&1

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ $fail == 0 ]]
