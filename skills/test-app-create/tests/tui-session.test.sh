#!/usr/bin/env bash
# Behaviour tests for tui-session.sh — the three things it decides that nothing else re-checks.
#
#   bash skills/test-app-create/tests/tui-session.test.sh
#
# It decides whether the app is on screen at all, whether a program is a TUI or a CLI, and
# whether a wait terminated. All three fail in the same direction, towards a confident wrong
# answer. An empty capture reads as a clean screen and passes the render check. A finished app
# reads as one that is ignoring your keys. A CLI misread as a TUI picks the wrong template pair
# for the user's whole generated skill. A wait with no deadline hangs the review's longest serial
# block. There is no CI, so this is the only thing standing between an edit and any of that.
#
# The fixtures are POSIX sh — no compiler, no framework, no network. What makes them enough is
# that fake-tui.sh renders its OWN size into the frame, so a geometry assertion reads what the
# app sees rather than what tmux reports about itself.
#
# Cases that need a real tmux are SKIPPED and counted when it is absent, and the suite still
# exits 0: validate.sh has no tmux mandate and must not start failing on a machine that never
# had one. The skip count is on the summary line because validate.sh prints only that line — a
# skip nobody can see is the same instrument-never-fired failure as a green sweep over nothing.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
TUI="$PWD/skills/test-app-create/scripts/tui-session.sh"
TMP=$(mktemp -d); pass=0; fail=0; skip=0; notmux=0

cleanup() {
  # Never leave a session behind: this suite starts real ones, and an escaped tmux
  # server is invisible in a way a stray container is not.
  [[ -n ${HANDLES:-} ]] && for h in $HANDLES; do tmux -L "$h" kill-server >/dev/null 2>&1; done
  rm -rf "$TMP" "${TMPDIR:-/tmp}"/test-app-tui-ta-* 2>/dev/null
}
trap cleanup EXIT
HANDLES=""

ok()   { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }
skipc(){ skip=$((skip + 1)); printf '  skip %s\n' "$1"; }

# ---------------------------------------------------------------- fixtures

FIX="$TMP/fix"; mkdir -p "$FIX"

# Raw mode is load-bearing, not decoration: without it the terminal echoes the key and
# buffers until newline, so every send/wait-for assertion would measure the terminal
# rather than the app. SIGWINCH is trapped so the resize case reads the app's own view.
cat > "$FIX/fake-tui.sh" <<'EOF'
#!/bin/sh
stty raw -echo 2>/dev/null
printf '\033[?1049h'
draw() {
  printf '\033[H\033[2J'
  printf '+-- WIDGETS ---------+\r\n'
  printf '| size %sx%s\r\n' "$(tput cols)" "$(tput lines)"
  printf '| key  %s\r\n' "${K:-none}"
  printf '+--------------------+\r\n'
}
trap 'draw' 28
draw
while :; do
  K=$(dd bs=1 count=1 2>/dev/null)
  if [ "$K" = "q" ]; then printf '\033[?1049l'; stty sane 2>/dev/null; exit 0; fi
  draw
done
EOF
printf '#!/bin/sh\necho "out line"\necho "err line" >&2\nexit 3\n'                  > "$FIX/fake-cli.sh"
printf '#!/bin/sh\necho "started"\nexec sleep 3600\n'                              > "$FIX/fake-hang.sh"
printf '#!/bin/sh\nprintf "\\033[?1049h"\nprintf "dirty\\r\\n"\nsleep 0.5\nexit 0\n' > "$FIX/fake-dirty.sh"
printf '#!/bin/sh\nexec sleep 3600\n'                                              > "$FIX/fake-blank.sh"
printf '#!/bin/sh\nprintf "hello\\r\\n"\nsleep 0.4\nprintf "\\033[2J\\033[H"\nexec sleep 3600\n' > "$FIX/fake-goesblank.sh"
printf '#!/bin/sh\ntouch "$XDG_CONFIG_HOME/marker"\necho seeded\nexec sleep 3600\n' > "$FIX/fake-marker.sh"
chmod +x "$FIX"/*.sh

REPO="$TMP/repo"; mkdir -p "$REPO"
( cd "$REPO" && git init -q -b main && git config user.email t@example.com && git config user.name test \
  && cp "$FIX"/*.sh . && git add -A && git commit -qm base ) >/dev/null

start() {  # start <fixture> [driver opts...] -> echoes the handle, records it for cleanup
  local fx=$1; shift
  local h; h=$(cd "$REPO" && bash "$TUI" start --ttl 120 "$@" -- "./$fx" 2>"$TMP/starterr") || return 1
  HANDLES="$HANDLES $h"; echo "$h"
}

# ---------------------------------------------------------------- no tmux at all
#
# These run everywhere, and the 127 assertion is what the whole "record it as not run,
# never as a pass" contract rests on — so it is asserted as EXACTLY 127 and as distinct
# from every other code in the table.

echo "== with tmux masked off PATH =="
NOTMUX="$TMP/notmux"; mkdir -p "$NOTMUX"
printf '#!/bin/sh\nexit 0\n' > "$NOTMUX/git-shim"; chmod +x "$NOTMUX/git-shim"
GITBIN=$(command -v git)
ln -sf "$GITBIN" "$NOTMUX/git"

out=$(cd "$REPO" && PATH="$NOTMUX:/usr/bin:/bin" bash "$TUI" start -- ./fake-tui.sh 2>&1); rc=$?
[[ $rc == 127 ]] && ok "start exits exactly 127 when tmux is absent" \
                 || bad "start exits exactly 127 when tmux is absent" "exit $rc: $out"
grep -qi 'tmux' <<<"$out" && grep -qi 'never report a TUI as verified' <<<"$out" \
  && ok "and names tmux and refuses to be read as a pass" \
  || bad "and names tmux and refuses to be read as a pass" "$out"

out=$(cd "$REPO" && PATH="$NOTMUX:/usr/bin:/bin" bash "$TUI" stop ta-deadbeef 2>&1); rc=$?
[[ $rc == 127 ]] && ok "so does stop — everything that touches a pane fails closed, not just start" \
                 || bad "so does stop — everything that touches a pane fails closed, not just start" "exit $rc"

# ...but `mode` answers from git alone, so it must keep answering. The failure this locks out is
# worktree-deploy.sh's: a require_bin ahead of the subcommand makes a machine without the tool
# unable to say even where it is, and a caller retrying that burns agents on a no-op.
got=$(cd "$REPO" && PATH="$NOTMUX:/usr/bin:/bin" bash "$TUI" mode 2>&1); rc=$?
[[ $rc == 0 && "$got" == main ]] && ok "but mode still answers without tmux — it only needs git" \
                                 || bad "but mode still answers without tmux — it only needs git" "exit $rc: $got"

echo
echo "== the location decision, and usage =="
got=$(cd "$REPO" && bash "$TUI" mode 2>&1)
[[ "$got" == "main" ]] && ok "the primary working tree reports mode 'main'" \
                       || bad "the primary working tree reports mode 'main'" "got: $got"
( cd "$REPO" && git worktree add -q --detach "$TMP/wt" HEAD ) >/dev/null 2>&1
got=$(cd "$TMP/wt" && bash "$TUI" mode 2>&1)
[[ "$got" == "worktree" ]] && ok "a linked worktree reports mode 'worktree'" \
                           || bad "a linked worktree reports mode 'worktree'" "got: $got"
got=$(cd "$TMP" && bash "$TUI" mode 2>&1); rc=$?
[[ $rc == 2 ]] && ok "outside a git repo it exits 2 rather than guessing" \
               || bad "outside a git repo it exits 2 rather than guessing" "exit $rc: $got"
out=$(cd "$REPO" && bash "$TUI" nonsense 2>&1); rc=$?
[[ $rc == 64 && "$out" == usage:* ]] && ok "an unknown subcommand exits 64 and prints usage" \
                                     || bad "an unknown subcommand exits 64 and prints usage" "exit $rc: $out"

# ---------------------------------------------------------------- the live cases

if ! command -v tmux >/dev/null 2>&1; then
  notmux=1
  echo
  echo "== live session cases =="
  for t in "start prints exactly one handle line" \
           "capture returns the drawn frame" \
           "capture of a gone session exits 4" \
           "capture of a pane that painted nothing exits 5" \
           "send to a finished app exits 3" \
           "send actually changes the frame" \
           "wait-for matches" \
           "wait-for's deadline is real, in wall time" \
           "wait-for on a finished app exits 3, not 6" \
           "resize is verified, not assumed" \
           "the status bar does not steal a row" \
           "the user's ~/.tmux.conf cannot change a frame" \
           "probe tells a TUI from a CLI from neither" \
           "run-tty returns the command's exit code" \
           "stop is idempotent" \
           "stop --expect-exited catches a dirty exit" \
           "state stays in the throwaway dir" \
           "two suffixes are two independent apps" \
           "a handle prefix cannot resolve another session"; do skipc "$t (tmux absent)"; done
else
echo
echo "== start, and the handle contract =="
H=$(start fake-tui.sh --geometry 100x30) && rc=0 || rc=1
if [[ $rc == 0 ]]; then
  [[ "$H" =~ ^[A-Za-z0-9_-]+$ ]] && ok "start prints exactly one handle line, shell-safe" \
                                 || bad "start prints exactly one handle line, shell-safe" "got: [$H]"
  [[ $(printf '%s' "$H" | wc -l | tr -d ' ') -eq 0 ]] \
    && ok "and nothing else rode along on stdout" \
    || bad "and nothing else rode along on stdout" "[$H]"
else
  bad "start prints exactly one handle line, shell-safe" "$(cat "$TMP/starterr")"
fi

got=$(cd "$REPO" && bash "$TUI" status "$H")
[[ $got == running* && $got == *alt=1* ]] && ok "status sees it running on the alternate screen" \
                                          || bad "status sees it running on the alternate screen" "got: $got"

echo
echo "== capture fails closed, in both of its two directions =="
F=$(cd "$REPO" && bash "$TUI" capture "$H") && grep -q WIDGETS "$F" \
  && ok "capture returns the drawn frame, as a file" \
  || bad "capture returns the drawn frame, as a file" "got: $F"

out=$(cd "$REPO" && bash "$TUI" capture ta-nosuchsession 2>&1); rc=$?
[[ $rc == 4 && -z "$(grep -v '^tui-session:' <<<"$out")" ]] \
  && ok "capture of a gone session exits 4 and prints no frame" \
  || bad "capture of a gone session exits 4 and prints no frame" "exit $rc: $out"

# An app that never draws is refused at start, one layer earlier than capture: reporting a
# handle for a pane with nothing on it would hand the caller a session to assert against.
out=$(cd "$REPO" && TUI_SESSION_SUFFIX=blank TUI_START_TIMEOUT=3 bash "$TUI" start --ttl 30 -- ./fake-blank.sh 2>&1); rc=$?
[[ $rc == 1 ]] && grep -qi 'drew nothing' <<<"$out" \
  && ok "start refuses an app that draws nothing, rather than handing back a handle" \
  || bad "start refuses an app that draws nothing, rather than handing back a handle" "exit $rc: $out"

B=$(TUI_SESSION_SUFFIX=blank start fake-goesblank.sh) && {
  sleep 1
  out=$(cd "$REPO" && TUI_SESSION_SUFFIX=blank bash "$TUI" capture "$B" 2>&1); rc=$?
  [[ $rc == 5 ]] && ok "a pane that has gone blank exits 5, never '' with exit 0" \
                 || bad "a pane that has gone blank exits 5, never '' with exit 0" "exit $rc: $out"
  cd "$REPO" && TUI_SESSION_SUFFIX=blank bash "$TUI" stop "$B" >/dev/null 2>&1
} || skipc "a pane that has gone blank exits 5 (fixture would not start)"

echo
echo "== send, and the finished-app trap =="
before=$(cat "$(cd "$REPO" && bash "$TUI" capture "$H")")
(cd "$REPO" && bash "$TUI" send "$H" -l "x") && sleep 0.6
after=$(cat "$(cd "$REPO" && bash "$TUI" capture "$H")")
[[ "$before" != "$after" ]] && ok "send actually changes the frame (a wrong target is a silent no-op)" \
                            || bad "send actually changes the frame (a wrong target is a silent no-op)" "unchanged"

(cd "$REPO" && bash "$TUI" wait-for "$H" 'key  x' --timeout 5) >/dev/null 2>&1 \
  && ok "wait-for matches what the app drew" || bad "wait-for matches what the app drew" "no match"

t0=$(date +%s)
out=$(cd "$REPO" && bash "$TUI" wait-for "$H" 'NEVERAPPEARS' --timeout 3 2>&1); rc=$?
t1=$(date +%s); el=$(( t1 - t0 ))
# The clock, not only the code: the bug guarded here is "no deadline", and an exit 6
# that arrives after ten minutes is the same outage as one that never arrives.
[[ $rc == 6 && $el -lt 8 ]] && ok "wait-for's deadline is real, in wall time (${el}s)" \
                            || bad "wait-for's deadline is real, in wall time" "exit $rc after ${el}s"

echo
echo "== geometry is verified, never assumed =="
geom=$(cd "$REPO" && bash "$TUI" status "$H")
[[ $geom == *geom=100x30* ]] && ok "the status bar does not steal a row (asked 30, got 30)" \
                             || bad "the status bar does not steal a row (asked 30, got 30)" "got: $geom"
(cd "$REPO" && bash "$TUI" resize "$H" 80x24) && rc=0 || rc=1
(cd "$REPO" && bash "$TUI" send "$H" -l "z") ; sleep 0.6
F=$(cd "$REPO" && bash "$TUI" capture "$H")
[[ $rc == 0 ]] && grep -q '80x24' "$F" \
  && ok "resize reaches the APP, not just tmux (its own tput reads 80x24)" \
  || bad "resize reaches the APP, not just tmux (its own tput reads 80x24)" "$(cat "$F")"

echo
echo "== isolation: the private server, the state dir, and exact handle matching =="
HOSTILE="$TMP/hostile"; mkdir -p "$HOSTILE"
printf 'set -g status on\nset -g status-position top\n' > "$HOSTILE/.tmux.conf"
G=$(HOME="$HOSTILE" TUI_SESSION_SUFFIX=hostile start fake-tui.sh --geometry 100x30) && {
  got=$(cd "$REPO" && HOME="$HOSTILE" TUI_SESSION_SUFFIX=hostile bash "$TUI" status "$G")
  [[ $got == *geom=100x30* ]] && ok "the user's ~/.tmux.conf cannot change a captured frame" \
                              || bad "the user's ~/.tmux.conf cannot change a captured frame" "got: $got"
  cd "$REPO" && HOME="$HOSTILE" TUI_SESSION_SUFFIX=hostile bash "$TUI" stop "$G" >/dev/null 2>&1
} || skipc "the user's ~/.tmux.conf cannot change a captured frame (fixture would not start)"

M=$(TUI_SESSION_SUFFIX=mark start fake-marker.sh) && {
  # The app's own config landed in the throwaway dir, and the real one was untouched.
  found=$(find "${TMPDIR:-/tmp}" -maxdepth 3 -path '*test-app-tui-*' -name marker 2>/dev/null | head -1)
  [[ -n $found ]] && ok "the app's state lands in the throwaway dir, not the real one" \
                  || bad "the app's state lands in the throwaway dir, not the real one" "no marker found"
  cd "$REPO" && TUI_SESSION_SUFFIX=mark bash "$TUI" stop "$M" >/dev/null 2>&1
} || skipc "the app's state lands in the throwaway dir (fixture would not start)"

A=$(TUI_SESSION_SUFFIX=a start fake-tui.sh) && B2=$(TUI_SESSION_SUFFIX=b start fake-tui.sh) && {
  [[ "$A" != "$B2" ]] && ok "two suffixes are two independent apps, not one shared pane" \
                      || bad "two suffixes are two independent apps, not one shared pane" "$A == $B2"
  (cd "$REPO" && TUI_SESSION_SUFFIX=a bash "$TUI" stop "$A") >/dev/null 2>&1
  got=$(cd "$REPO" && TUI_SESSION_SUFFIX=b bash "$TUI" status "$B2")
  [[ $got == running* ]] && ok "and killing one leaves the other alive" \
                         || bad "and killing one leaves the other alive" "got: $got"
  (cd "$REPO" && TUI_SESSION_SUFFIX=b bash "$TUI" stop "$B2") >/dev/null 2>&1
} || skipc "two suffixes are two independent apps (fixtures would not start)"

# A handle nobody started must read as absent, not as an empty session that is fine. Inside a
# socket that is what has-session -t "=id" enforces: without the '=', 'ta-abc' resolves
# 'ta-abcdef' and the driver reads a neighbouring pane while reporting success.
out=$(cd "$REPO" && bash "$TUI" status ta-neverstarted)
[[ $out == absent* ]] && ok "a handle nobody started reads as absent, not as an empty session" \
                      || bad "a handle nobody started reads as absent, not as an empty session" "got: $out"

echo
echo "== probe: the discriminator that picks the template pair =="
got=$(cd "$REPO" && bash "$TUI" probe --timeout 6 -- ./fake-tui.sh 2>/dev/null)
[[ "$got" == tui ]] && ok "probe reads an alternate-screen app as 'tui'" \
                    || bad "probe reads an alternate-screen app as 'tui'" "got: $got"
got=$(cd "$REPO" && bash "$TUI" probe --timeout 6 -- ./fake-cli.sh 2>/dev/null)
[[ "$got" == cli ]] && ok "probe reads a program that exits on its own as 'cli'" \
                    || bad "probe reads a program that exits on its own as 'cli'" "got: $got"
got=$(cd "$REPO" && bash "$TUI" probe --timeout 4 -- ./fake-hang.sh 2>/dev/null); rc=$?
[[ "$got" == unknown && $rc == 9 ]] && ok "and says 'unknown' with exit 9 rather than guessing" \
                                    || bad "and says 'unknown' with exit 9 rather than guessing" "got: $got (exit $rc)"

echo
echo "== run-tty: the pty the CLI catalog needs, and only for two of its checks =="
OUT=$(cd "$REPO" && bash "$TUI" run-tty --geometry 40x10 -- ./fake-cli.sh); rc=$?
# The exit code has to come back untouched. run-tty exists so --help wrapping and the
# isatty branch can be checked on a real terminal; a wrapper that swallowed the status
# would make every exit-code assertion in the CLI catalog assert about the wrapper.
[[ $rc == 3 ]] && ok "run-tty returns the COMMAND's exit code, not its own" \
               || bad "run-tty returns the COMMAND's exit code, not its own" "got $rc, wanted 3"
[[ -f "$OUT" ]] && grep -q 'out line' "$OUT" && grep -q 'err line' "$OUT" \
  && ok "and the captured pty output survives the session it was captured from" \
  || bad "and the captured pty output survives the session it was captured from" "$OUT"
rm -f "$OUT"

echo
echo "== stop: idempotent, and the terminal-restoration check =="
(cd "$REPO" && bash "$TUI" stop ta-nosuchsession) >/dev/null 2>&1; rc=$?
[[ $rc == 0 ]] && ok "stop on a session that was never started exits 0" \
               || bad "stop on a session that was never started exits 0" "exit $rc"

(cd "$REPO" && bash "$TUI" send "$H" -l q) >/dev/null 2>&1; sleep 0.8
out=$(cd "$REPO" && bash "$TUI" send "$H" -l "y" 2>&1); rc=$?
[[ $rc == 3 ]] && ok "send to a FINISHED app exits 3 (it is not ignoring your keys)" \
               || bad "send to a FINISHED app exits 3 (it is not ignoring your keys)" "exit $rc: $out"
out=$(cd "$REPO" && bash "$TUI" wait-for "$H" 'anything' --timeout 5 2>&1); rc=$?
[[ $rc == 3 ]] && ok "wait-for on a finished app exits 3, not 6 — a crash is not a slow start" \
               || bad "wait-for on a finished app exits 3, not 6 — a crash is not a slow start" "exit $rc"
(cd "$REPO" && bash "$TUI" stop "$H" --expect-exited) >/dev/null 2>&1; rc=$?
[[ $rc == 0 ]] && ok "a clean quit passes --expect-exited" || bad "a clean quit passes --expect-exited" "exit $rc"

D=$(TUI_SESSION_SUFFIX=dirty start fake-dirty.sh) && {
  sleep 1.2
  out=$(cd "$REPO" && TUI_SESSION_SUFFIX=dirty bash "$TUI" stop "$D" --expect-exited 2>&1); rc=$?
  [[ $rc == 8 ]] && grep -qi 'alternate screen' <<<"$out" \
    && ok "an app that exits with the alternate screen still on exits 8, and says so" \
    || bad "an app that exits with the alternate screen still on exits 8, and says so" "exit $rc: $out"
} || skipc "an app that exits with the alternate screen still on exits 8 (fixture would not start)"
fi

( cd "$REPO" && git worktree remove --force "$TMP/wt" ) >/dev/null 2>&1

echo
if (( skip )); then
  printf '  %d passed, %d failed, %d skipped%s\n' "$pass" "$fail" "$skip" \
    "$( ((notmux)) && printf ' (tmux absent)' )"
else
  printf '  %d passed, %d failed\n' "$pass" "$fail"
fi
[[ $fail == 0 ]]
