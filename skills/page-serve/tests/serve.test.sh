#!/usr/bin/env bash
#
# serve.test.sh — the suite for serve.sh, and the only one it gets.
#
# Two decisions here fail by looking exactly like success. A URL printed for a server that never
# answered is indistinguishable from a working one until somebody taps it on another device; and
# a dotfile served over --lan looks like a page load. Neither shows up in the run's output, so a
# clean start is not evidence and this suite is.
#
# It runs with its own PAGE_SERVE_STATE, because `stop --all` against the real handle directory
# would kill a server the user is using -- and its own stub `pbcopy` on PATH, for the same
# reason one level over: a suite that clobbers the real clipboard costs the user whatever they
# had copied.
set -uo pipefail

SERVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/serve.sh"
TMP=$(mktemp -d)
export PAGE_SERVE_STATE="$TMP/state"
# A port of its own: the shipped default is 8000, and a suite that seized it would fight whatever
# the user is actually serving. The default itself is asserted separately, from the script.
export PAGE_SERVE_PORT=8399
cleanup() { bash "$SERVE" stop --all >/dev/null 2>&1; chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n       %s\n' "$1" "$2"; fail=$((fail+1)); }

mkdir -p "$TMP/site/.hidden" "$TMP/site/assets" "$TMP/outside"
printf '<h1>page</h1>\n' > "$TMP/site/index.html"
printf 'body{}\n'        > "$TMP/site/assets/app.css"
printf 'SECRET=1\n'      > "$TMP/site/.env"
printf 'deep\n'          > "$TMP/site/.hidden/x"
printf 'elsewhere\n'     > "$TMP/outside/other.html"
ln -sfn "$TMP/outside/other.html" "$TMP/site/escape.html"
mkdir -p "$TMP/bare"; printf 'no index here\n' > "$TMP/bare/a.txt"

# A stub clipboard, first on PATH, recording what it was handed. The real pbcopy is never run.
STUB="$TMP/bin"; mkdir -p "$STUB"
cat > "$STUB/pbcopy" <<EOF
#!/bin/sh
cat > "$TMP/clip"
EOF
chmod +x "$STUB/pbcopy"
NOCLIP="$TMP/noclip"; mkdir -p "$NOCLIP"
for c in bash sh python3 curl find grep sed awk wc tr head cat rm mkdir chmod kill sleep \
         nohup mktemp dirname basename route ipconfig; do
  q=$(command -v "$c" 2>/dev/null) && ln -sf "$q" "$NOCLIP/$c"
done

cd "$TMP" || exit 1
go() { PATH="$STUB:$PATH" bash "$SERVE" "$@" >"$TMP/out" 2>"$TMP/err"; echo $?; }
code() { curl -s --path-as-is -o /dev/null -w '%{http_code}' --max-time 3 "$1" 2>/dev/null; }
port_of() { sed -n 's|.*127\.0\.0\.1:\([0-9]*\)/.*|\1|p' "$TMP/out" | head -1; }
handle_field() {  # $1 field
  python3 - "$PAGE_SERVE_STATE" "$1" <<'PY'
import glob, json, sys
for f in sorted(glob.glob(sys.argv[1] + "/*.json")):
    print(json.load(open(f))[sys.argv[2]])
PY
}

echo
echo "== a start that answers prints a URL, and stop takes it down =="
rc=$(go start site/index.html)
[ "$rc" = 0 ] && ok "start exits 0" || bad "start" "rc=$rc $(cat "$TMP/err")"
P=$(port_of)
[ -n "$P" ] && ok "and prints a local URL" || bad "local URL" "$(cat "$TMP/out")"
[ "$(code "http://127.0.0.1:$P/index.html")" = 200 ] \
  && ok "the page is really served" || bad "page served" "not 200"
[ "$(code "http://127.0.0.1:$P/assets/app.css")" = 200 ] \
  && ok "and so is a relative asset beside it" || bad "asset served" "not 200"

echo
echo "== what the server refuses, which is the reason it is not \`python3 -m http.server\` =="
# On --lan these are offered to every device on the network, and a refusal that only exists in
# the prose is not a refusal.
[ "$(code "http://127.0.0.1:$P/.env")" = 404 ] \
  && ok "a dotfile in the root is refused" || bad "dotfile" "got $(code "http://127.0.0.1:$P/.env")"
[ "$(code "http://127.0.0.1:$P/.hidden/x")" = 404 ] \
  && ok "and so is a file inside a dot directory" || bad "dot directory" "reachable"
[ "$(code "http://127.0.0.1:$P/escape.html")" = 404 ] \
  && ok "a symlink out of the root is refused" || bad "symlink escape" "reachable"
[ "$(code "http://127.0.0.1:$P/../outside/other.html")" = 404 ] \
  && ok "and so is a .. that climbs out of it" || bad "dot-dot escape" "reachable"

rc=$(go stop "p$P")
[ "$rc" = 0 ] && ok "stop exits 0" || bad "stop" "rc=$rc"
[ "$(code "http://127.0.0.1:$P/index.html")" = 000 ] \
  && ok "and the port is dead afterwards" || bad "stop killed it" "still answering"

echo
echo "== a directory with no index still starts, and lists nothing =="
rc=$(go start bare)
[ "$rc" = 0 ] && ok "a directory target starts" || bad "directory target" "rc=$rc $(cat "$TMP/err")"
P=$(sed -n 's|.*127\.0\.0\.1:\([0-9]*\)/.*|\1|p' "$TMP/out" | head -1)
[ "$(code "http://127.0.0.1:$P/")" = 403 ] \
  && ok "and the index of it is off — a listing is a map of everything reachable" \
  || bad "directory listing" "got $(code "http://127.0.0.1:$P/")"
[ "$(code "http://127.0.0.1:$P/a.txt")" = 200 ] \
  && ok "while a named file under it is served" || bad "file under directory" "not 200"
go stop --all >/dev/null

echo
echo "== --lan is the only way onto the network, read from the handle rather than the message =="
# The printed line is what a person sees; the bind is what is true. Asserting the message would
# pass over a server that says lan and listens on loopback.
go start site/index.html >/dev/null
[ "$(handle_field bind)" = "127.0.0.1" ] \
  && ok "a bare start binds 127.0.0.1" || bad "default bind" "got $(handle_field bind)"
go stop --all >/dev/null
go start site/index.html --lan >/dev/null
[ "$(handle_field bind)" = "0.0.0.0" ] \
  && ok "--lan binds 0.0.0.0" || bad "lan bind" "got $(handle_field bind)"
grep -q '^  lan ' "$TMP/out" && ok "and the LAN URL is printed" || bad "lan URL" "$(cat "$TMP/out")"
go stop --all >/dev/null

echo
echo "== the URL goes on the clipboard, ready to paste =="
rm -f "$TMP/clip"
go start site/index.html >/dev/null
P=$(port_of)
[ "$(cat "$TMP/clip" 2>/dev/null)" = "http://127.0.0.1:$P/index.html" ] \
  && ok "a local start copies the loopback URL" || bad "clipboard local" "got $(cat "$TMP/clip" 2>/dev/null)"
grep -q '^  copied ' "$TMP/out" \
  && ok "and the run says what it copied" || bad "copied line" "$(cat "$TMP/out")"
go stop --all >/dev/null

# Under --lan the LAN URL is the one worth having: it works from this machine too, so copying
# loopback there would hand back the strictly less useful of the two.
rm -f "$TMP/clip"
go start site/index.html --lan >/dev/null
if grep -q '^  lan      http' "$TMP/out"; then
  grep -q '^http://127\.0\.0\.1:' "$TMP/clip" \
    && bad "--lan copies the LAN URL" "it copied loopback: $(cat "$TMP/clip")" \
    || ok "--lan copies the LAN URL, not loopback"
else
  ok "--lan on a machine with no LAN address (skipped: nothing to copy but loopback)"
fi
go stop --all >/dev/null

rm -f "$TMP/clip"
go start site/index.html --no-copy >/dev/null
[ -e "$TMP/clip" ] \
  && bad "--no-copy leaves the clipboard alone" "it wrote anyway" \
  || ok "--no-copy does not touch the clipboard"
go stop --all >/dev/null

# A machine with no clipboard tool still gets a served page. Failing a working server over a
# missing pbcopy would be the tail wagging the dog.
PATH="$NOCLIP" bash "$SERVE" start site/index.html >"$TMP/out" 2>"$TMP/err"; rc=$?
[ "$rc" = 0 ] && ok "no clipboard tool is not a failure" \
              || bad "clipboard fail-open" "got $rc: $(head -2 "$TMP/err")"
grep -qi 'no clipboard tool' "$TMP/out" \
  && ok "and the run names the gap instead of implying a copy" || bad "names the gap" "$(cat "$TMP/out")"
PATH="$NOCLIP" bash "$SERVE" stop --all >/dev/null 2>&1

echo
echo "== a server that never answers exits 5 and prints NO url =="
# The case the poll exists for. With the state directory unwritable the handler cannot be
# written, so python3 exits at once -- a spawned pid that serves nothing, which is what a lost
# bind and a handler that raises on import both look like from here.
chmod 500 "$PAGE_SERVE_STATE"
rc=$(PAGE_SERVE_POLL_TRIES=2 go start site/index.html)
chmod 700 "$PAGE_SERVE_STATE"
[ "$rc" = 5 ] && ok "a dead server exits 5" || bad "dead server" "got $rc: $(cat "$TMP/err" | head -2)"
grep -q 'http://' "$TMP/out" \
  && bad "no URL for a dead server" "it printed one anyway: $(cat "$TMP/out")" \
  || ok "and prints no URL at all"

echo
echo "== list prunes what is gone, so stop never reports success over nothing =="
go start site/index.html >/dev/null
P=$(port_of)
go list >/dev/null
grep -q "p$P" "$TMP/out" && ok "a live server is listed" || bad "list live" "$(cat "$TMP/out")"
kill "$(handle_field pid)" 2>/dev/null; sleep 0.4
go list >/dev/null
grep -qi 'nothing is being served' "$TMP/out" \
  && ok "a dead one is pruned rather than listed" || bad "list prune" "$(cat "$TMP/out")"
rc=$(go stop --all)
grep -qi 'nothing was running' "$TMP/out" \
  && ok "and stop says so instead of claiming a kill" || bad "stop honesty" "$(cat "$TMP/out")"

echo
echo "== a target the run should not serve is refused before anything binds =="
rc=$(go start site/missing.html)
[ "$rc" = 2 ] && ok "a missing target exits 2" || bad "missing target" "got $rc"
rc=$(go start ../)
[ "$rc" = 2 ] && ok "a directory above the working directory exits 2" || bad "escape target" "got $rc"
rc=$(go start site/.env)
[ "$rc" = 2 ] && ok "a dotfile target exits 2" || bad "dotfile target" "got $rc"

echo
echo "== the port is fixed, so a firewall rule written once keeps matching =="
# A server that drifts to the next free port lands outside the rule that was opened for it and is
# dropped with nothing to read, which is why a busy port is an error rather than a quiet move.
grep -q 'PAGE_SERVE_PORT:-8000' "$SERVE" \
  && ok "the shipped default is 8000" || bad "default port" "$(grep -n DEFAULT_PORT= "$SERVE")"
go start site/index.html >/dev/null
[ "$(port_of)" = 8399 ] && ok "and a start uses it rather than scanning" || bad "fixed port" "got $(port_of)"
rc=$(go start site/index.html)
[ "$rc" = 3 ] \
  && ok "a second start on it exits 3 instead of moving to the next one" || bad "second start" "got $rc"
grep -qi 'already serving' "$TMP/err" \
  && ok "and names the process holding it" || bad "names the holder" "$(cat "$TMP/err")"
go stop --all >/dev/null

# The restart loop is the common one: edit the page, stop, start. Without SO_REUSEADDR the socket
# left in TIME_WAIT reads as "in use" and the second start fails on a port that is genuinely free.
fails=0
for i in 1 2 3; do
  rc=$(go start site/index.html); [ "$rc" = 0 ] || fails=$((fails+1))
  go stop --all >/dev/null
done
[ "$fails" = 0 ] && ok "and stop/start cycles on it keep working (TIME_WAIT does not block a rebind)" \
                 || bad "restart cycle" "$fails of 3 starts failed"

echo
echo "== usage =="
rc=$(go frobnicate)
[ "$rc" = 64 ] && ok "an unknown subcommand exits 64" || bad "unknown subcommand" "got $rc"
rc=$(go start)
[ "$rc" = 64 ] && ok "start with no target exits 64" || bad "no target" "got $rc"
rc=$(go --help)
[ "$rc" = 64 ] && ok "--help exits 64 and prints the contract" || bad "help" "got $rc"
grep -q 'Exit codes are the whole contract' "$TMP/out" \
  && ok "and the contract is what it prints" || bad "help text" "$(head -3 "$TMP/out")"


echo
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
