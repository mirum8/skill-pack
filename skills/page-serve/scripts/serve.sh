#!/usr/bin/env bash
#
# serve.sh — put one local page on http, on this machine or on the LAN.
#
#   serve.sh start <file|dir> [--lan] [--port N] [--no-copy]
#   serve.sh stop <handle> | --all
#   serve.sh list
#
# It serves the target's DIRECTORY, so a page's relative assets resolve, through a handler that
# refuses every dotfile and every symlink resolving outside that directory. `python3 -m
# http.server` would hand `.git`, `.env` and `.ssh` to whoever asks, which on --lan is everyone
# on the network. There is no flag to turn that off: the refusal is why this is a script rather
# than a one-line shell-out.
#
# --local (the default) binds 127.0.0.1. --lan binds 0.0.0.0 and is the ONLY way to be reachable
# from another device. The flag is the consent.
#
# The URL also goes on the clipboard, ready to paste into a browser. Under --lan it is the LAN
# URL that is copied, not the loopback one: a LAN address works from this machine too, so it is
# strictly the more useful of the two once --lan has been asked for. --no-copy leaves the
# clipboard alone. A machine with no clipboard tool is NAMED and the start still succeeds --
# the page is served either way, and failing a working server over a missing pbcopy would be
# the tail wagging the dog.
#
# It FAILS CLOSED on the one thing it exists to report. After spawning, it polls until the
# server answers the target path with a 200 and prints a URL only then. A URL nothing is
# listening on is indistinguishable from a working one until somebody taps it, which is exactly
# the confident wrong answer this pack writes scripts to prevent.
#
# Handles live in ~/.claude/page-serve/<handle>.json (pid, port, root, bind, page, started),
# so `stop` works from a session that did not start the server. `list` prunes dead ones.
# PAGE_SERVE_STATE moves that directory.
#
# Exit codes are the whole contract:
#   0   serving, and it answered
#   2   the target is missing, unreadable, or resolves outside the working directory
#   3   no port could be bound
#   5   the server started but never answered — nothing is printed as a URL
#   64  usage
#
# python3 is a mandatory prerequisite of this pack, so there is no skip path here and no exit 4:
# an absent interpreter is the machine being broken, not a coverage gap to name.
set -uo pipefail

E_TARGET=2
E_PORT=3
E_DEAD=5
E_USAGE=64

# PAGE_SERVE_STATE exists so a run can be given its own handle directory. Without it a suite --
# or a second checkout -- shares the user's real one, where `stop --all` would kill a server they
# are actually using.
STATE="${PAGE_SERVE_STATE:-${HOME}/.claude/page-serve}"
POLL_TRIES=${PAGE_SERVE_POLL_TRIES:-40}   # x 0.25s = 10s
PORT_LO=8100
PORT_HI=8199

# The header block IS the help, delimited by `set -uo pipefail` rather than by a line number:
# a hardcoded range silently truncates the moment the header grows, and the part it cuts is the
# exit-code contract at the bottom.
usage() { sed -n '3,/^set -uo pipefail/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit $E_USAGE; }

for a in "$@"; do
  case "$a" in -h|--help|help) usage ;; esac
done
[ $# -ge 1 ] || usage

# The handler. Kept in one heredoc so the whole refusal lives beside the server it belongs to.
handler_py() {
  cat <<'PY'
import os, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

ROOT = os.path.realpath(sys.argv[1])
BIND, PORT = sys.argv[2], int(sys.argv[3])
# A refusal answers 404, not 403: 403 confirms the file is there, which is half of what the
# refusal was protecting. The path is one that cannot exist, so the base class does the rest.
REFUSED = os.path.join(ROOT, "..page-serve-refused..")


class Guarded(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Resolve ourselves rather than trusting the base class: it normalises, but it does not
        # care about dotfiles, and it follows a symlink straight out of the root.
        rel = unquote(urlparse(path).path).lstrip("/")
        if any(seg.startswith(".") for seg in rel.split("/") if seg):
            return REFUSED
        full = os.path.realpath(os.path.join(ROOT, rel))
        if full != ROOT and not full.startswith(ROOT + os.sep):
            return REFUSED
        return full

    def list_directory(self, path):
        # An index of the directory is a map of everything reachable. Serving one over the LAN
        # is a different offer from serving the page that was asked for.
        self.send_error(403, "Directory listing is off")
        return None

    def log_message(self, *_):
        pass


ThreadingHTTPServer.allow_reuse_address = False
ThreadingHTTPServer((BIND, PORT), lambda *a: Guarded(*a, directory=ROOT)).serve_forever()
PY
}

# The address the OTHER device should type. A machine with a VPN, a container bridge and a few
# virtual interfaces answers on all of them, and a list of eight is not an answer -- so the
# default route's address goes first and the rest are counted, not enumerated.
primary_ip() {
  local dev
  if command -v route >/dev/null 2>&1; then
    dev=$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')
    [ -n "$dev" ] && command -v ipconfig >/dev/null 2>&1 && ipconfig getifaddr "$dev" 2>/dev/null
  fi
  if command -v ip >/dev/null 2>&1; then
    ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src") print $(i+1)}'
  fi
}

lan_ips() {
  {
    if command -v ipconfig >/dev/null 2>&1; then
      for i in $(ipconfig getiflist 2>/dev/null); do ipconfig getifaddr "$i" 2>/dev/null; done
    fi
    if command -v ip >/dev/null 2>&1; then
      ip -4 -o addr show scope global 2>/dev/null | awk '{split($4,a,"/"); print a[1]}'
    elif command -v ifconfig >/dev/null 2>&1; then
      ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -v '^127\.'
    fi
  } | awk 'NF && !seen[$0]++'
}

# Ordered by what the platform actually ships: pbcopy on macOS, wl-copy under Wayland, then the
# two X11 tools. Prints the tool it used, so the caller can say which one wrote the clipboard.
copy_to_clipboard() {
  local text=$1
  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$text" | pbcopy 2>/dev/null && { echo pbcopy; return 0; }
  elif command -v wl-copy >/dev/null 2>&1; then
    printf '%s' "$text" | wl-copy 2>/dev/null && { echo wl-copy; return 0; }
  elif command -v xclip >/dev/null 2>&1; then
    printf '%s' "$text" | xclip -selection clipboard 2>/dev/null && { echo xclip; return 0; }
  elif command -v xsel >/dev/null 2>&1; then
    printf '%s' "$text" | xsel --clipboard --input 2>/dev/null && { echo xsel; return 0; }
  fi
  return 1
}

free_port() {
  python3 - "$1" "$PORT_LO" "$PORT_HI" <<'PY'
import socket, sys
want, lo, hi = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
cands = [int(want)] if want else list(range(lo, hi + 1))
for p in cands:
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p)); s.close(); print(p); sys.exit(0)
    except OSError:
        s.close()
sys.exit(1)
PY
}

cmd_start() {
  local target="" bind="127.0.0.1" want="" lan=0 copy=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --lan)     lan=1; bind="0.0.0.0"; shift ;;
      --no-copy) copy=0; shift ;;
      --local)   lan=0; bind="127.0.0.1"; shift ;;
      --port)    [ $# -ge 2 ] || usage; want="$2"; shift 2 ;;
      -*)        usage ;;
      *)         [ -z "$target" ] || usage; target="$1"; shift ;;
    esac
  done
  [ -n "$target" ] || usage

  if [ ! -e "$target" ]; then
    echo "page-serve: no such file or directory: $target" >&2
    exit $E_TARGET
  fi
  local abs root page
  abs=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$target")
  if [ -d "$abs" ]; then root="$abs"; page=""; else root=$(dirname "$abs"); page=$(basename "$abs"); fi
  # The root is the directory the whole world gets. Serving from above the working directory is
  # never what "serve this page" meant, and on --lan it is a different offer entirely.
  local cwd; cwd=$(python3 -c 'import os; print(os.path.realpath(os.getcwd()))')
  case "$root" in
    "$cwd"|"$cwd"/*) : ;;
    *) echo "page-serve: $root is outside $cwd — refusing to serve a directory the run was not" \
            "asked for. Serve a path inside the working directory." >&2; exit $E_TARGET ;;
  esac
  if [ -n "$page" ] && [ ! -r "$abs" ]; then
    echo "page-serve: $abs is not readable" >&2; exit $E_TARGET
  fi
  case "$page" in .*) echo "page-serve: $page is a dotfile and this server refuses those" >&2
                      exit $E_TARGET ;; esac

  local port; port=$(free_port "$want") || {
    if [ -n "$want" ]; then echo "page-serve: port $want is already in use" >&2
    else echo "page-serve: no free port in $PORT_LO-$PORT_HI" >&2; fi
    exit $E_PORT; }

  mkdir -p "$STATE"
  local handle="p$port"
  handler_py > "$STATE/$handle.py"
  nohup python3 "$STATE/$handle.py" "$root" "$bind" "$port" >"$STATE/$handle.log" 2>&1 &
  local pid=$!

  # Fail closed. A spawned pid is not a served page: the bind can lose a race, the handler can
  # raise on import, and either way the process is alive and answering nothing.
  # A named page must come back 200 -- that is the claim the printed URL makes. A directory
  # target only has to produce a real status line, since with listings off there is no single
  # response that means "up"; 000 is curl saying nothing answered at all, which is the case
  # this check exists for.
  local probe="http://127.0.0.1:$port/${page}" code="" i=0 want200=0
  [ -n "$page" ] && want200=1
  while [ "$i" -lt "$POLL_TRIES" ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$probe" 2>/dev/null)
    if [ "$want200" = 1 ]; then [ "$code" = "200" ] && break
    else [ -n "$code" ] && [ "$code" != "000" ] && break; fi
    kill -0 "$pid" 2>/dev/null || break
    i=$((i + 1)); sleep 0.25
  done
  if { [ "$want200" = 1 ] && [ "$code" != "200" ]; } || [ -z "$code" ] || [ "$code" = "000" ]; then
    kill "$pid" 2>/dev/null
    rm -f "$STATE/$handle.py"
    echo "page-serve: the server did not answer $probe (last status ${code:-none}). Nothing is" \
         "being served, so no URL is printed." >&2
    sed -n '1,5p' "$STATE/$handle.log" >&2
    exit $E_DEAD
  fi

  python3 - "$STATE/$handle.json" "$pid" "$port" "$root" "$bind" "$page" <<'PY'
import json, sys, time
out, pid, port, root, bind, page = sys.argv[1:7]
json.dump({"pid": int(pid), "port": int(port), "root": root, "bind": bind, "page": page,
           "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
          open(out, "w"), indent=2)
PY

  local n; n=$(find "$root" -maxdepth 1 -type f ! -name '.*' | wc -l | tr -d ' ')
  local main="" others="" others_n=0 paste="http://127.0.0.1:$port/$page"
  echo "  serving  $root  ($n files, dotfiles unreachable)"
  echo "  local    http://127.0.0.1:$port/$page"
  if [ "$lan" = 1 ]; then
    main=$(primary_ip | head -1)
    others=$(lan_ips | grep -vx "${main:-__none__}")
    others_n=$(printf '%s' "$others" | grep -c . )
    if [ -n "$main" ]; then
      echo "  lan      http://$main:$port/$page"
      paste="http://$main:$port/$page"
      [ "$others_n" -gt 0 ] &&
        echo "           (also on $others_n other interface(s): $(echo $others))"
    elif [ "$others_n" -gt 0 ]; then
      for ip in $others; do echo "  lan      http://$ip:$port/$page"; done
      paste="http://$(echo "$others" | head -1):$port/$page"
    else
      echo "  lan      bound to 0.0.0.0 — no LAN address found on this machine"
    fi
  fi
  if [ "$copy" = 1 ]; then
    local tool
    if tool=$(copy_to_clipboard "$paste"); then
      echo "  copied   $paste  (clipboard, via $tool)"
    else
      echo "  copied   nothing — no clipboard tool here (pbcopy, wl-copy, xclip, xsel)."
      echo "           The URL above is the one to paste."
    fi
  fi
  echo "  stop     serve.sh stop $handle"
}

cmd_stop() {
  [ $# -ge 1 ] || usage
  local handles=()
  if [ "$1" = "--all" ]; then
    for f in "$STATE"/*.json; do [ -e "$f" ] && handles+=("$(basename "${f%.json}")"); done
  else
    handles=("$1")
  fi
  local stopped=0
  for h in ${handles+"${handles[@]}"}; do
    local f="$STATE/$h.json"
    if [ ! -f "$f" ]; then echo "page-serve: no such handle: $h" >&2; continue; fi
    local pid; pid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$f")
    kill "$pid" 2>/dev/null && stopped=$((stopped + 1))
    rm -f "$f" "$STATE/$h.py" "$STATE/$h.log"
    echo "  stopped  $h (pid $pid)"
  done
  [ "$stopped" -gt 0 ] || echo "  nothing was running"
}

cmd_list() {
  local any=0
  for f in "$STATE"/*.json; do
    [ -e "$f" ] || continue
    local h; h=$(basename "${f%.json}")
    local pid; pid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$f")
    if kill -0 "$pid" 2>/dev/null; then
      python3 - "$f" "$h" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("  %-8s pid %-7s %s  http://%s:%d/%s" % (
    sys.argv[2], d["pid"], d["root"],
    "127.0.0.1" if d["bind"] == "127.0.0.1" else d["bind"], d["port"], d["page"]))
PY
      any=1
    else
      # A dead pid with a live handle file would let `stop` report success over nothing.
      rm -f "$f" "$STATE/$h.py" "$STATE/$h.log"
    fi
  done
  [ "$any" = 1 ] || echo "  nothing is being served"
}

SUB="$1"; shift
case "$SUB" in
  start) cmd_start "$@" ;;
  stop)  cmd_stop "$@" ;;
  list)  cmd_list "$@" ;;
  *)     echo "serve.sh: unknown subcommand '$SUB'" >&2; usage ;;
esac
