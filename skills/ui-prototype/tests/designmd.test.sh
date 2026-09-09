#!/usr/bin/env bash
#
# designmd.test.sh — the suite for designmd.sh, and the only one it gets.
#
# Every case here guards the same failure shape: the wrapper returning a confident wrong
# answer about whether the DESIGN.md CLI ran. A missing linter reported as a clean file, an
# empty response read as "no findings", an empty export that renders every candidate
# identically — each leaves a green run behind it, so a passing pipeline is not evidence and
# this suite is.
#
# The CLI is stubbed on PATH: a fake `design.md` whose stdout, stderr and exit code each case
# controls, plus a fake `npx` that records its argv so the version pin can be asserted. That
# is the same technique the Codex wrapper's suite uses, one tool over.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/designmd.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
STUB="$TMP/bin"; mkdir -p "$STUB"
pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n       %s\n' "$1" "$2"; fail=$((fail+1)); }

# cli <<'EOF' — install a stub `design.md` on PATH from a heredoc body.
cli() { cat > "$STUB/design.md"; chmod +x "$STUB/design.md"; }
# npx_stub <<'EOF' — install a stub `npx` (and a `node`, since the wrapper requires both).
npx_stub() {
  cat > "$STUB/npx"; chmod +x "$STUB/npx"
  printf '#!/bin/sh\nexit 0\n' > "$STUB/node"; chmod +x "$STUB/node"
}
no_tools() { rm -f "$STUB/design.md" "$STUB/designmd" "$STUB/npx" "$STUB/node"; }

# A PATH with the coreutils the wrapper needs and DELIBERATELY no node/npx. Stripping the real
# /usr/bin is the only way to test the skip: leave it on PATH and the wrapper finds the machine's
# own npx and runs the real CLI, which is exactly what happened the first time this was written.
MINI="$TMP/mini"; mkdir -p "$MINI"
for c in bash sh mktemp grep python3 sed cat head rm ls touch; do
  p=$(command -v "$c" 2>/dev/null) && ln -sf "$p" "$MINI/$c"
done

# go <args...> — run the wrapper with ONLY the stub dir plus coreutils on PATH.
# Returns its exit code; stdout in $TMP/out, stderr in $TMP/err.
go() {
  ( cd "$TMP" && PATH="$STUB:${GO_PATH:-/usr/bin:/bin}" bash "$SCRIPT" "$@" ) >"$TMP/out" 2>"$TMP/err"
  echo $?
}
out() { cat "$TMP/out"; }
err() { cat "$TMP/err"; }

echo
echo "== the skip: no CLI at all =="
# A missing tool must be impossible to mistake for a clean file. It exits NON-ZERO (unlike the
# Codex wrapper's optional-plugin skip) because there is no degraded path here: without the
# linter nothing has checked the file, and a caller must not be able to walk past that.
no_tools
rc=$(GO_PATH="$MINI" go lint some.md --format json)
[ "$rc" = 4 ] && ok "no node/npx exits 4" || bad "no node/npx exits 4" "got $rc"
head -1 "$TMP/out" | grep -q '^DESIGNMD SKIPPED:' \
  && ok "and the marker is the FIRST stdout line" \
  || bad "marker is first stdout line" "got: $(head -1 "$TMP/out")"
grep -qi 'unlinted' "$TMP/err" \
  && ok "and it says what to report instead of clean" || bad "names UNLINTED" "$(err)"

echo
echo "== the skip: npx present but the package cannot be fetched =="
# npm's resolution failure and a real CLI failure are both a non-zero exit with nothing on
# stdout. Only the stderr text tells them apart, which is why the marker exists at all.
npx_stub <<'EOF'
#!/bin/sh
echo "npm error code ENOTFOUND" >&2
echo "npm error network request to https://registry.npmjs.org failed" >&2
exit 1
EOF
rc=$(go lint some.md --format json)
[ "$rc" = 4 ] && ok "an unfetchable package exits 4, not a lint verdict" || bad "unfetchable exits 4" "got $rc"
head -1 "$TMP/out" | grep -q '^DESIGNMD SKIPPED:' && ok "with the marker" || bad "marker" "$(head -1 "$TMP/out")"

echo
echo "== the version pin =="
# The format is "alpha" and the CLI is 0.x. Unpinned, today's clean file fails tomorrow with
# no edit, and it reads as the palette getting worse rather than the tool changing.
# The stub reads the path from the environment rather than being rewritten in place: `sed -i`
# takes a mandatory backup suffix on BSD, so the rewrite silently did nothing here and the
# assertion below passed over an argv file that was never written.
export ARGV_OUT="$TMP/argv"
npx_stub <<'EOF'
#!/bin/sh
echo "$@" > "$ARGV_OUT"
echo '{"findings":[],"summary":{"errors":0,"warnings":0,"infos":0}}'
exit 0
EOF
rc=$(go lint some.md --format json)
grep -q '@google/design.md@0\.4\.0' "$TMP/argv" \
  && ok "npx is invoked with the pinned version" || bad "version pin" "argv: $(cat "$TMP/argv" 2>/dev/null)"

echo
echo "== lint: a real report passes through =="
rm -f "$STUB/npx" "$STUB/node"
cli <<'EOF'
#!/bin/sh
echo '{"findings":[{"severity":"info","message":"ok","rule":"token-summary"}],"summary":{"errors":0,"warnings":0,"infos":1}}'
exit 0
EOF
rc=$(go lint some.md --format json)
[ "$rc" = 0 ] && ok "a clean file exits 0" || bad "clean exits 0" "got $rc: $(err)"
python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d["summary"]["infos"]==1 else 1)' <"$TMP/out" \
  && ok "and the report reaches stdout unmodified" || bad "report passthrough" "$(out)"

echo
echo "== lint: real errors are a RESULT, not a wrapper failure =="
cli <<'EOF'
#!/bin/sh
echo '{"findings":[{"severity":"error","message":"contrast 2.1:1","rule":"contrast-ratio"}],"summary":{"errors":1,"warnings":0,"infos":0}}'
exit 1
EOF
rc=$(go lint some.md --format json)
[ "$rc" = 1 ] && ok "a file with lint errors exits 1" || bad "errors exit 1" "got $rc"
grep -q 'contrast-ratio' "$TMP/out" \
  && ok "and the findings are still on stdout, verbatim" || bad "findings preserved" "$(out)"

echo
echo "== lint: exit 0 with nothing to show is NOT a clean file =="
# THE core case. An empty response under a zero exit has the exact shape of "no findings", so
# an invalid DESIGN.md would be banked as clean and then rendered, picked and committed.
cli <<'EOF'
#!/bin/sh
exit 0
EOF
rc=$(go lint some.md --format json)
[ "$rc" != 0 ] && ok "empty stdout under exit 0 is refused" || bad "empty stdout refused" "got 0"
grep -qi 'NOT a clean file' "$TMP/err" \
  && ok "and says so in those words" || bad "names it" "$(err)"

echo
echo "== lint: garbage under --format json is refused the same way =="
cli <<'EOF'
#!/bin/sh
echo "Usage: design.md lint <file>"
exit 0
EOF
rc=$(go lint some.md --format json)
[ "$rc" != 0 ] && ok "non-JSON output is refused" || bad "non-JSON refused" "got 0"

echo
echo "== lint: JSON without a summary object is refused =="
# Parsing as JSON is not evidence the linter ran; the summary is.
cli <<'EOF'
#!/bin/sh
echo '{"findings":[]}'
exit 0
EOF
rc=$(go lint some.md --format json)
[ "$rc" != 0 ] && ok "JSON with no summary is refused" || bad "no-summary refused" "got 0"

echo
echo "== an unreadable file keeps its own code =="
# 2 must stay distinguishable from "clean": a missing file and a file with no problems are
# opposite results.
cli <<'EOF'
#!/bin/sh
echo 'Error: "x.md" not found.' >&2
exit 2
EOF
rc=$(go lint x.md --format json)
[ "$rc" = 2 ] && ok "an unreadable file exits 2" || bad "unreadable exits 2" "got $rc"

echo
echo "== export: an empty token set is refused =="
# An empty export becomes a blank <style> block, and every candidate on the comparison page
# then renders identically — a page that shows three of the same thing and calls them choices.
cli <<'EOF'
#!/bin/sh
exit 0
EOF
rc=$(go export some.md --format css-vars)
[ "$rc" != 0 ] && ok "an empty export is refused" || bad "empty export refused" "got 0"

cli <<'EOF'
#!/bin/sh
printf ':root {\n  --color-primary: #112233;\n}\n'
exit 0
EOF
rc=$(go export some.md --format css-vars)
[ "$rc" = 0 ] && ok "a real token set passes" || bad "real export passes" "got $rc: $(err)"
grep -q -- '--color-primary' "$TMP/out" && ok "and reaches stdout" || bad "export passthrough" "$(out)"

echo
echo "== the wrapper's own edges =="
# Probing must never start a package fetch, and a typo must never become free text the CLI
# tries to interpret.
cli <<'EOF'
#!/bin/sh
touch "$1.INVOKED"
exit 0
EOF
rc=$(go --help)
[ "$rc" = 64 ] && ok "--help exits 64" || bad "--help exits 64" "got $rc"
grep -q 'Exit codes are the whole contract' "$TMP/out" \
  && ok "and prints the exit-code contract" || bad "help prints contract" "$(head -3 "$TMP/out")"
ls "$TMP"/*.INVOKED >/dev/null 2>&1 && bad "--help does not invoke the CLI" "it ran" || ok "--help does not invoke the CLI"

rc=$(go frobnicate some.md)
[ "$rc" = 64 ] && ok "an unknown subcommand exits 64" || bad "unknown subcommand" "got $rc"
ls "$TMP"/*.INVOKED >/dev/null 2>&1 && bad "and never reaches the CLI" "it ran" || ok "and never reaches the CLI"

echo
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
