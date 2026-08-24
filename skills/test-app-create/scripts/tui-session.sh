#!/usr/bin/env bash
#
# tui-session.sh — a real terminal for /test-app's TUI verification.
#
# Behaviour is decided by WHERE it runs, never by who calls it: the session id and
# the throwaway state dir are derived from the checkout root, so two worktrees
# testing the same app never share a pane, a config file or a history. That is the
# same rule worktree-deploy.sh applies to ports and compose projects.
#
# Every tmux call goes through a PRIVATE server (-L) with the user's config ignored
# (-f /dev/null). Both are load-bearing, not hygiene: a shared server lets this
# script resize or kill the user's own sessions, and an unignored ~/.tmux.conf
# changes what the pane shows and what keys do, which makes every captured frame
# machine-specific and every comparison between two of them worthless.
#
# Subcommands:
#
#   mode                        prints main | worktree
#   start [opts] -- CMD...      starts the app detached, prints ONE line: the handle
#   send HANDLE [-l|-H] KEYS... sends keys; refuses once the app has exited
#   capture HANDLE [--ansi]     writes the screen to a file, prints its path
#   wait-for HANDLE REGEX [--timeout S]   polls until it matches, bounded
#   resize HANDLE WxH           resizes, then verifies the resize took
#   probe [--timeout S] -- CMD  prints tui | cli | unknown — the surface discriminator
#   status HANDLE               one line: running|exited|absent exit=N geom=WxH alt=0|1
#   stop HANDLE [--expect-exited]         idempotent; --expect-exited checks the exit was clean
#   run-tty [opts] -- CMD...    runs a command on a pty and returns ITS exit code
#
# Exit codes are the whole contract. Each one exists because the failure it names
# otherwise returns a confident wrong answer:
#
#   0    ok
#   1    the app failed to start, or died before drawing anything
#   2    not inside a git repo
#   3    the app has exited — send/wait-for against a stopped app
#   4    no such session
#   5    the capture is empty (reads as "a clean screen with no errors on it")
#   6    wait-for deadline exceeded
#   7    geometry was not applied (turns a 3-size sweep into one size measured thrice)
#   8    unclean exit — still running, alternate screen still on, or non-zero status
#   9    probe inconclusive
#   64   usage
#   127  tmux is missing — the ONLY code that means "record it as not run, and name it"
#
set -uo pipefail

E_START=1 E_NOREPO=2 E_EXITED=3 E_NOSESSION=4 E_EMPTY=5 E_TIMEOUT=6
E_GEOM=7 E_UNCLEAN=8 E_INCONCLUSIVE=9 E_USAGE=64 E_NOTMUX=127

die()   { echo "tui-session: $2" >&2; exit "$1"; }
usage() { echo "usage: tui-session.sh {mode|start|send|capture|wait-for|resize|probe|status|stop|run-tty} ..." >&2; exit $E_USAGE; }

# 127 is reserved for tmux alone, because a caller reads it as "record the checks as
# NOT RUN and name the reason". A missing git is not that — it is a broken machine.
command -v git >/dev/null 2>&1 || die $E_NOREPO "required command not found: git"

# Checked per subcommand, not once at load. worktree-deploy.sh require_bin's docker before it
# reads its subcommand, so on a machine without docker even `teardown` and `mode` exit 127 —
# and a caller that wraps teardown in a retry then burns three agents tearing down a stack that
# was never built. `mode` answers from git alone and must keep answering here; everything that
# actually touches a pane fails closed.
need_tmux() {
  command -v tmux >/dev/null 2>&1 || die $E_NOTMUX \
  "tmux not found — the TUI checks cannot run on this machine. Install it (brew install tmux, apt-get install tmux), or record them as NOT RUN and name tmux as the reason. Never report a TUI as verified without it."
}

# ---------------------------------------------------------------- identity

root=$(git rev-parse --show-toplevel 2>/dev/null) || die $E_NOREPO "not inside a git repo"
gdir=$(git rev-parse --git-dir 2>/dev/null) && gdir=$(cd "$gdir" && pwd)
gcom=$(git rev-parse --git-common-dir 2>/dev/null) && gcom=$(cd "$gcom" && pwd)
if [[ $gdir == "$gcom" ]]; then MODE=main; else MODE=worktree; fi

# The checkout root, not the repo name: two worktrees of one repo must not collide,
# which is the whole reason this is derived rather than passed in.
root_hash=$(printf '%s' "$root" | shasum 2>/dev/null | cut -c1-8)
[[ -n $root_hash ]] || root_hash=$(printf '%s' "$root" | cksum | cut -d' ' -f1)
BASE_ID="ta-${root_hash}${TUI_SESSION_SUFFIX:+-${TUI_SESSION_SUFFIX}}"

state_of() { printf '%s/test-app-tui-%s' "${TMPDIR:-/tmp}" "$1"; }
tm()       { tmux -L "$SOCK" "$@"; }

# A handle is interpolated into shell commands by callers, so it is deliberately
# narrow: no ':' (tmux target syntax), no '.' (tmux pane syntax), no metacharacters.
valid_handle() { [[ $1 =~ ^[A-Za-z0-9_-]+$ ]]; }

bind_handle() {
  valid_handle "$1" || die $E_USAGE "not a valid handle: $1"
  ID=$1; SOCK=$1; STATE=$(state_of "$1")
}

# has-session -t "=$id" — the '=' forces an exact match. Without it 'ta-abc' matches
# 'ta-abcdef', and the driver reads ANOTHER worktree's pane while reporting success.
session_exists() { tm has-session -t "=$ID" 2>/dev/null; }

# The app's own exit is recorded by the shim as a file, not inferred from the pane:
# the shim keeps the pane alive on purpose, so pane liveness answers a different
# question than "has the app finished".
app_exited() { [[ -f "$STATE/exitcode" ]]; }
app_status() { cat "$STATE/exitcode" 2>/dev/null || echo ""; }

raw_capture() { tm capture-pane -p -J -t "$ID:0.0" 2>/dev/null; }

# ---------------------------------------------------------------- start

cmd_start() {
  local cols=120 rows=40 term=${TUI_TERM:-xterm-256color} ttl=${TUI_TTL:-3600} suffix=""
  while [[ $# -gt 0 ]]; do
    case $1 in
      --geometry) cols=${2%%x*}; rows=${2##*x}; shift 2 ;;
      --term)     term=$2; shift 2 ;;
      --ttl)      ttl=$2; shift 2 ;;
      --suffix)   suffix=$2; shift 2 ;;
      --)         shift; break ;;
      -*)         die $E_USAGE "unknown start option: $1" ;;
      *)          suffix=$1; shift ;;
    esac
  done
  [[ $# -gt 0 ]] || die $E_USAGE "start needs a command after --"
  [[ $cols =~ ^[0-9]+$ && $rows =~ ^[0-9]+$ ]] || die $E_USAGE "geometry must be COLSxROWS"

  local handle="$BASE_ID${suffix:+-$suffix}"
  valid_handle "$handle" || die $E_USAGE "suffix makes an invalid handle: $handle"
  bind_handle "$handle"

  # Reclaim rather than fail. A previous run that was killed leaves a session behind;
  # failing here would make every subsequent run in this worktree fail too, which is
  # the collision worktree-deploy.sh avoids with a per-worktree project name.
  cmd_stop_quiet
  mkdir -p "$STATE/frames" "$STATE/xdg-config" "$STATE/xdg-data" "$STATE/xdg-state" "$STATE/xdg-cache"

  # The shim is a file, not an inline `sh -c`, for two reasons: it makes the pane's
  # survival independent of remain-on-exit (whose option scope has moved across the
  # tmux 3.x line), and it turns the app's exit status into a file rather than a
  # format string that has to be read before the pane is reused.
  #
  # HOME is NOT overridden here. Only the XDG vars are. Overriding HOME would also
  # hide ~/.cargo, ~/.npm and ~/go from the launch command, and the build failure
  # that follows reads as an app failure. TUI_ISOLATE_HOME=1 opts in when the app
  # itself writes straight to $HOME.
  {
    echo '#!/bin/sh'
    echo "export XDG_CONFIG_HOME='$STATE/xdg-config' XDG_DATA_HOME='$STATE/xdg-data'"
    echo "export XDG_STATE_HOME='$STATE/xdg-state' XDG_CACHE_HOME='$STATE/xdg-cache'"
    echo "export TERM='$term'"
    [[ ${TUI_ISOLATE_HOME:-0} == 1 ]] && echo "export HOME='$STATE/home'" && mkdir -p "$STATE/home"
    [[ ${TUI_NO_COLOR:-0} == 1 ]] && echo "export NO_COLOR=1"
    printf '('
    local a; for a in "$@"; do printf '%q ' "$a"; done
    printf ')\n'
    echo "printf '%s' \"\$?\" > '$STATE/exitcode.tmp'"
    echo "mv '$STATE/exitcode.tmp' '$STATE/exitcode'"
    echo 'exec sleep 2147483647'
  } > "$STATE/shim"
  chmod +x "$STATE/shim"

  # status off BEFORE the session exists: the status bar steals a ROW, so a pane asked
  # for 40 rows would be 39 and every cramped-geometry check would test the wrong size
  # forever. history-limit likewise applies at pane creation, which is why both are set
  # on the server before new-session rather than on the session after it.
  tm -f /dev/null start-server 2>/dev/null
  tm set-option -g status off          >/dev/null 2>&1
  tm set-option -g history-limit 20000 >/dev/null 2>&1
  tm set-option -g remain-on-exit on   >/dev/null 2>&1
  tm new-session -d -s "$ID" -x "$cols" -y "$rows" -n app "$STATE/shim" >/dev/null 2>&1 \
    || die $E_START "tmux could not create session $ID"
  # window-size manual, or a resize with no client attached is silently ignored and the
  # geometry sweep measures one size three times while reporting three.
  tm set-option -t "$ID" -w window-size manual >/dev/null 2>&1

  local got; got=$(tm display-message -p -t "$ID:0.0" '#{pane_width}x#{pane_height}' 2>/dev/null)
  if [[ $got != "${cols}x${rows}" ]]; then
    cmd_stop_quiet
    die $E_GEOM "asked for ${cols}x${rows}, got ${got:-nothing} — refusing to test a size nobody chose"
  fi

  # A detached watchdog. If the whole review is SIGKILLed no trap and no `finally`
  # runs, and a tmux session is worse than a container about it: invisible, and one
  # per abandoned run. This is the only backstop for that, so the TTL is not optional.
  if [[ $ttl =~ ^[0-9]+$ && $ttl -gt 0 ]]; then
    nohup sh -c "sleep $ttl; tmux -L '$SOCK' kill-server >/dev/null 2>&1; rm -rf '$STATE'" \
      >/dev/null 2>&1 &
    echo $! > "$STATE/watchdog"
  fi

  local deadline=$(( $(date +%s) + ${TUI_START_TIMEOUT:-20} ))
  while :; do
    if app_exited; then break; fi
    [[ -n "$(raw_capture | tr -d '[:space:]')" ]] && break
    if [[ $(date +%s) -ge $deadline ]]; then
      cmd_stop_quiet
      die $E_START "the app drew nothing and did not exit within ${TUI_START_TIMEOUT:-20}s"
    fi
    sleep 0.25
  done
  # run-tty and probe set TUI_ALLOW_EXIT: for them the app finishing IS the result. On the
  # verification path it is not — handing back a handle to a program that already exited
  # gives the caller a session to assert against that will never draw anything again.
  if app_exited && [[ ${TUI_ALLOW_EXIT:-0} != 1 ]] && [[ "$(app_status)" != 0 ]]; then
    local frame; frame=$(raw_capture)
    cmd_stop_quiet
    printf 'tui-session: its last frame was:\n%s\n' "$(printf '%s' "$frame" | tail -5)" >&2
    die $E_START "the app exited with status $(app_status) before it could be tested"
  fi

  # Exactly one line on stdout, and it is the handle. Everything else goes to stderr:
  # the caller captures stdout AS the handle, so one stray line becomes part of it and
  # every later -t lookup fails in a way indistinguishable from "the session is gone".
  echo "$ID"
}

# ---------------------------------------------------------------- send

cmd_send() {
  bind_handle "${1:?handle}"; shift
  session_exists || die $E_NOSESSION "no such session: $ID"
  # send-keys into a finished app SUCCEEDS in tmux. The next capture then returns the
  # last painted frame, and the reader concludes the app is running and ignoring input.
  app_exited && die $E_EXITED "the app has already exited (status $(app_status)) — it is not ignoring your keys"
  local mode=()
  case ${1:-} in -l) mode=(-l); shift ;; -H) mode=(-H); shift ;; esac
  [[ $# -gt 0 ]] || die $E_USAGE "send needs at least one key"
  tm send-keys -t "$ID:0.0" ${mode[@]+"${mode[@]}"} -- "$@" || die $E_NOSESSION "send-keys failed on $ID"
}

# ---------------------------------------------------------------- capture

cmd_capture() {
  bind_handle "${1:?handle}"; shift
  local ansi=() scroll=() out=""  # expanded with the ${a[@]+...} guard below
  while [[ $# -gt 0 ]]; do
    case $1 in
      --ansi)       ansi=(-e); shift ;;
      --scrollback) scroll=(-S "-$2"); shift 2 ;;
      --file)       out=$2; shift 2 ;;
      *)            die $E_USAGE "unknown capture option: $1" ;;
    esac
  done
  session_exists || die $E_NOSESSION "no such session: $ID"
  local frame; frame=$(tm capture-pane -p -J ${ansi[@]+"${ansi[@]}"} ${scroll[@]+"${scroll[@]}"} -t "$ID:0.0" 2>/dev/null)
  # An empty capture is the most dangerous success-shaped failure on this surface: a
  # reader handed "" concludes "no error text on screen" and passes the render check.
  [[ -n "$(printf '%s' "$frame" | tr -d '[:space:]')" ]] \
    || die $E_EMPTY "the capture is empty — the pane painted nothing, which is not the same as a clean screen"
  if [[ -z $out ]]; then
    local n; n=$(( $(cat "$STATE/frame-seq" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$STATE/frame-seq"
    out="$STATE/frames/frame-$n.txt"
  fi
  mkdir -p "$(dirname "$out")"
  printf '%s\n' "$frame" > "$out"
  echo "$out"
}

# ---------------------------------------------------------------- wait-for

cmd_wait_for() {
  bind_handle "${1:?handle}"; shift
  local re=${1:?regex}; shift
  local secs=${TUI_WAIT_TIMEOUT:-15}
  while [[ $# -gt 0 ]]; do
    case $1 in --timeout) secs=$2; shift 2 ;; *) die $E_USAGE "unknown wait-for option: $1" ;; esac
  done
  [[ $secs =~ ^[0-9]+$ ]] || die $E_USAGE "--timeout takes seconds"
  # Capped, and there is no flag that removes the cap. The UI track is already the
  # review's longest serial block; a driver that can block forever can hang the review.
  (( secs > 120 )) && secs=120
  session_exists || die $E_NOSESSION "no such session: $ID"
  local deadline=$(( $(date +%s) + secs ))
  while :; do
    raw_capture | grep -qE -- "$re" && return 0
    # A dead app is not "still loading". Conflating them turns a crash into a timeout
    # report, and the reader then goes looking for a slow start that never happened.
    app_exited && die $E_EXITED "the app exited (status $(app_status)) while waiting for /$re/"
    session_exists || die $E_NOSESSION "the session disappeared while waiting for /$re/"
    if [[ $(date +%s) -ge $deadline ]]; then
      echo "tui-session: final frame was:" >&2; raw_capture >&2
      die $E_TIMEOUT "/$re/ did not appear within ${secs}s"
    fi
    sleep 0.25
  done
}

# ---------------------------------------------------------------- resize

cmd_resize() {
  bind_handle "${1:?handle}"; shift
  local geom=${1:?WxH} cols rows; cols=${geom%%x*}; rows=${geom##*x}
  [[ $cols =~ ^[0-9]+$ && $rows =~ ^[0-9]+$ ]] || die $E_USAGE "resize takes COLSxROWS"
  session_exists || die $E_NOSESSION "no such session: $ID"
  tm resize-window -t "$ID:0" -x "$cols" -y "$rows" >/dev/null 2>&1
  local deadline=$(( $(date +%s) + 3 ))
  while :; do
    [[ "$(tm display-message -p -t "$ID:0.0" '#{pane_width}x#{pane_height}' 2>/dev/null)" == "${cols}x${rows}" ]] && return 0
    [[ $(date +%s) -ge $deadline ]] && die $E_GEOM "resize to ${cols}x${rows} was not applied"
    sleep 0.2
  done
}

# ---------------------------------------------------------------- status

cmd_status() {
  bind_handle "${1:?handle}"
  if ! session_exists; then echo "absent exit= geom= alt="; return 0; fi
  local geom alt st
  geom=$(tm display-message -p -t "$ID:0.0" '#{pane_width}x#{pane_height}' 2>/dev/null)
  alt=$(tm display-message -p -t "$ID:0.0" '#{alternate_on}' 2>/dev/null)
  if app_exited; then st="exited"; else st="running"; fi
  echo "$st exit=$(app_status) geom=$geom alt=$alt"
}

# ---------------------------------------------------------------- probe

cmd_probe() {
  local secs=8; local -a args=()
  while [[ $# -gt 0 ]]; do
    case $1 in
      --timeout) secs=$2; shift 2 ;;
      --)        shift; args=("$@"); break ;;
      *)         die $E_USAGE "unknown probe option: $1" ;;
    esac
  done
  [[ ${#args[@]} -gt 0 ]] || die $E_USAGE "probe needs a command after --"

  # TUI_ALLOW_EXIT, because a program that runs and exits is the 'cli' answer, and
  # TUI_KEEP_STATE so the exitcode it left behind survives to be that evidence.
  local handle; handle=$(TUI_ALLOW_EXIT=1 TUI_KEEP_STATE=1 TUI_TTL=120 TUI_START_TIMEOUT=$secs \
    cmd_start --suffix probe -- "${args[@]}" 2>/dev/null) || {
    # A program that exits non-zero on its own with no arguments is still a CLI —
    # start refuses it, and refusing to answer here would send the caller to the
    # web template for a binary that plainly is not a web app.
    bind_handle "$BASE_ID-probe"
    if app_exited; then echo cli; cmd_stop_quiet; return 0; fi
    cmd_stop_quiet; echo unknown; return $E_INCONCLUSIVE
  }
  bind_handle "$handle"

  local deadline=$(( $(date +%s) + secs )) alt=0
  while [[ $(date +%s) -lt $deadline ]]; do
    # 1. tmux's own per-pane flag for "the client is on the alternate screen".
    #    Definitive, and the one signal that is language- and framework-agnostic.
    alt=$(tm display-message -p -t "$ID:0.0" '#{alternate_on}' 2>/dev/null)
    [[ $alt == 1 ]] && { echo tui; cmd_stop_quiet; return 0; }
    # 2. It finished without being given any input. Definitive the other way.
    app_exited && { echo cli; cmd_stop_quiet; return 0; }
    sleep 0.25
  done

  # 3. Alive, no alternate screen. An inline TUI (bubbletea without WithAltScreen,
  #    ink's default render) repaints in place: the frame changes and no line is
  #    appended. A REPL waiting on stdin does neither.
  local before after; before=$(raw_capture)
  tm send-keys -t "$ID:0.0" -- Down >/dev/null 2>&1
  sleep 1
  after=$(raw_capture)
  if [[ "$before" != "$after" ]] && [[ "$(printf '%s' "$before" | wc -l)" == "$(printf '%s' "$after" | wc -l)" ]]; then
    echo tui; cmd_stop_quiet; return 0
  fi
  # 4. A prompt on the last line is a REPL, which is a CLI wearing a loop.
  if printf '%s' "$after" | tail -1 | grep -qE '(^|[^-])(>>>|\$|>|#) *$'; then
    echo cli; cmd_stop_quiet; return 0
  fi
  # 5. Never guess. The caller must be unable to mistake this for an answer.
  cmd_stop_quiet; echo unknown; return $E_INCONCLUSIVE
}

# ---------------------------------------------------------------- run-tty

# The ONLY place the CLI catalog touches tmux, and it is why a missing tmux costs
# two CLI checks rather than the CLI track: argv, exit codes, stdout/stderr
# separation, piping and signals are all plain shell and deterministic without it.
# Only --help wrapping and the isatty branch need a real terminal.
cmd_run_tty() {
  local cols=80 rows=24; local -a args=()
  while [[ $# -gt 0 ]]; do
    case $1 in
      --geometry) cols=${2%%x*}; rows=${2##*x}; shift 2 ;;
      --)         shift; args=("$@"); break ;;
      *)          die $E_USAGE "unknown run-tty option: $1" ;;
    esac
  done
  [[ ${#args[@]} -gt 0 ]] || die $E_USAGE "run-tty needs a command after --"
  local handle; handle=$(TUI_ALLOW_EXIT=1 cmd_start --suffix tty \
    --geometry "${cols}x${rows}" --ttl 300 -- "${args[@]}") || return $?
  bind_handle "$handle"
  local deadline=$(( $(date +%s) + ${TUI_TTY_TIMEOUT:-60} ))
  while ! app_exited; do
    [[ $(date +%s) -ge $deadline ]] && { cmd_stop_quiet; die $E_TIMEOUT "the command did not exit within ${TUI_TTY_TIMEOUT:-60}s on a pty"; }
    sleep 0.25
  done
  local rc; rc=$(app_status)
  local out="$STATE/frames/tty.txt"
  mkdir -p "$STATE/frames"; raw_capture > "$out"
  # Copied out before stop removes the state dir — the caller needs the file to survive.
  local keep="${TMPDIR:-/tmp}/tui-run-tty-$$.txt"; cp "$out" "$keep"
  cmd_stop_quiet
  echo "$keep"
  return "$rc"
}

# ---------------------------------------------------------------- stop

cmd_stop_quiet() {
  [[ -n ${ID:-} ]] || return 0
  [[ -f "$STATE/watchdog" ]] && kill "$(cat "$STATE/watchdog")" 2>/dev/null
  tm kill-session -t "=$ID" >/dev/null 2>&1
  tm kill-server >/dev/null 2>&1
  [[ ${TUI_KEEP_STATE:-0} == 1 ]] || rm -rf "$STATE"
  return 0
}

cmd_stop() {
  bind_handle "${1:?handle}"; shift
  local expect=0
  while [[ $# -gt 0 ]]; do
    case $1 in --expect-exited) expect=1; shift ;; *) die $E_USAGE "unknown stop option: $1" ;; esac
  done
  # Idempotent by contract, and that is what lets a caller's teardown run on EVERY
  # exit path — including one where the deploy died before it started anything.
  if ! session_exists; then cmd_stop_quiet; return 0; fi

  if (( expect )); then
    # The terminal-restoration check, and the TUI analogue of "no leaked container".
    # An app that quits but leaves the alternate screen on is the defect users
    # actually report, and no in-process test harness can see it.
    local why="" alt st
    alt=$(tm display-message -p -t "$ID:0.0" '#{alternate_on}' 2>/dev/null)
    st=$(app_status)
    if ! app_exited;      then why="the app is still running — it did not quit"
    elif [[ $alt == 1 ]]; then why="the app exited with the ALTERNATE SCREEN still on — the terminal was not restored"
    elif [[ $st != 0 ]];  then why="the app exited with status $st"
    fi
    if [[ -n $why ]]; then cmd_stop_quiet; die $E_UNCLEAN "$why"; fi
  fi
  cmd_stop_quiet
}

# ---------------------------------------------------------------- dispatch

[[ $# -gt 0 ]] || usage
sub=$1; shift
# The name is checked before tmux is: a typo is a usage error on any machine, and answering
# it with 127 would tell the caller to install tmux to fix a misspelling.
case $sub in
  mode)                                              echo "$MODE"; exit 0 ;;
  start|send|capture|wait-for|resize|probe|status|stop|run-tty) ;;
  *)                                                 usage ;;
esac
need_tmux
case $sub in
  start)    cmd_start "$@" ;;
  send)     cmd_send "$@" ;;
  capture)  cmd_capture "$@" ;;
  wait-for) cmd_wait_for "$@" ;;
  resize)   cmd_resize "$@" ;;
  probe)    cmd_probe "$@" ;;
  status)   cmd_status "$@" ;;
  stop)     cmd_stop "$@" ;;
  run-tty)  cmd_run_tty "$@" ;;
  *)        usage ;;
esac
