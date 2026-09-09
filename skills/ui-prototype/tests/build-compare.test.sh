#!/usr/bin/env bash
#
# build-compare.test.sh — the suite for build-compare.py, and the only one it gets.
#
# The script decides two things that fail by producing a page which looks right and lies: how
# many candidates the reader is actually comparing, and what colour a terminal will paint. A
# dropped column and an unquantized palette both render beautifully, so the page is not
# evidence and this suite is.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/build-compare.py"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n       %s\n' "$1" "$2"; fail=$((fail+1)); }

# Three token sets, in the shape `designmd.sh export --format css-vars` really emits.
cat > "$TMP/a.css" <<'EOF'
:root {
  --color-primary: #855300;
  --color-on-primary: #ffffff;
  --color-surface: #f9f9ff;
  --color-on-surface: #151c27;
}
EOF
cat > "$TMP/b.css" <<'EOF'
:root {
  --color-primary: #0058be;
  --color-on-primary: #fefcff;
  --color-surface: #101014;
  --color-on-surface: #e8e8ef;
}
EOF
cat > "$TMP/c.css" <<'EOF'
:root {
  --color-primary: #b8422e;
  --color-surface: #faf9f5;
  --color-on-surface: #141413;
}
EOF
: > "$TMP/empty.css"
printf '/* a comment and nothing else */\n' > "$TMP/novars.css"

go() { python3 "$SCRIPT" "$@" >"$TMP/out" 2>"$TMP/err"; echo $?; }

echo
echo "== every candidate asked for is rendered =="
rc=$(go --out "$TMP/p.html" --surface web \
        --variant "Ochre=$TMP/a.css" --variant "Cobalt=$TMP/b.css" --variant "Clay=$TMP/c.css")
[ "$rc" = 0 ] && ok "three variants build" || bad "three variants build" "rc=$rc $(cat "$TMP/err")"
n=$(grep -c '<section class="card' "$TMP/p.html")
[ "$n" = 3 ] && ok "three panels reach the page" || bad "three panels" "got $n"
for name in Ochre Cobalt Clay; do
  grep -q ">$name<" "$TMP/p.html" || bad "the name $name is on its panel" "missing"
done
ok "each panel carries its candidate's name"

echo
echo "== a candidate that cannot be rendered is an ERROR, not a dropped column =="
# Three asked for and two shown, presented as the answer, is a comparison with a hole nobody
# can see. Both ways a token set can be unusable are the same refusal.
rc=$(go --out "$TMP/q.html" --surface web --variant "A=$TMP/a.css" --variant "B=$TMP/nope.css")
[ "$rc" = 2 ] && ok "a missing token file exits 2" || bad "missing token file" "got $rc"
grep -qi 'never been asked for\|cannot be shown' "$TMP/err" \
  && ok "and says why dropping it would be worse" || bad "names the reason" "$(cat "$TMP/err")"

rc=$(go --out "$TMP/q.html" --surface web --variant "A=$TMP/a.css" --variant "B=$TMP/empty.css")
[ "$rc" = 2 ] && ok "an empty token file exits 2" || bad "empty token file" "got $rc"
rc=$(go --out "$TMP/q.html" --surface web --variant "A=$TMP/a.css" --variant "B=$TMP/novars.css")
[ "$rc" = 2 ] && ok "a file with no custom properties exits 2" || bad "no custom properties" "got $rc"
grep -qi 'identically' "$TMP/err" \
  && ok "and names what an empty set would render" || bad "names the render" "$(cat "$TMP/err")"

echo
echo "== a terminal palette is quantized to the DECLARED depth =="
# The load-bearing case. A truecolor hex the linter certified at 4.5:1 is painted as the
# nearest of 16 on a terminal without the depth, so showing the authored value sells a palette
# that cannot exist on the target.
go --out "$TMP/tc.html"  --surface tui --depth truecolor --variant "A=$TMP/a.css" >/dev/null
go --out "$TMP/q16.html" --surface tui --depth 16        --variant "A=$TMP/a.css" >/dev/null
grep -q '#855300' "$TMP/tc.html" \
  && ok "truecolor keeps the authored value" || bad "truecolor passthrough" "missing #855300"
grep -q '#855300' "$TMP/q16.html" \
  && bad "16-colour drops the authored value" "#855300 survived quantization" \
  || ok "16-colour does NOT show the authored value"
# Every colour on a 16-colour page must be IN the 16-colour palette; "fewer colours" is not
# the same claim as "colours this terminal has".
python3 - "$TMP/q16.html" <<'PY'
import re, sys
BASE16 = {(0,0,0),(128,0,0),(0,128,0),(128,128,0),(0,0,128),(128,0,128),(0,128,128),
          (192,192,192),(128,128,128),(255,0,0),(0,255,0),(255,255,0),(0,0,255),
          (255,0,255),(0,255,255),(255,255,255)}
page = open(sys.argv[1]).read()
# the page chrome is the pack's own palette and is not a candidate's colour; only the scoped
# panel block and the inline mock styles are quantized output.
block = page[page.index('.v0 {'):page.index('</style>')]
bad = [h for h in re.findall(r'#([0-9a-f]{6})', block)
       if tuple(int(h[i:i+2],16) for i in (0,2,4)) not in BASE16]
sys.exit(1 if bad else 0)
PY
[ $? = 0 ] && ok "and every panel colour is IN the 16-colour palette" \
           || bad "panel colours are in the palette" "found values outside BASE16"

go --out "$TMP/w.html" --surface web --depth 16 --variant "A=$TMP/a.css" >/dev/null
grep -q '#855300' "$TMP/w.html" \
  && ok "a WEB page is never quantized — the browser has the full range" \
  || bad "web unquantized" "#855300 was reduced on a web surface"

echo
echo "== the page is self-contained =="
# One property, two reasons: it must survive file:// and a published page cannot fetch anyway.
grep -qE '<link |src="http|@import|https?://' "$TMP/p.html" \
  && bad "no external references" "$(grep -oE '<link |src="http|@import|https?://' "$TMP/p.html" | head -3)" \
  || ok "no <link>, no @import, no external URL"

echo
echo "== the share marker is carried forward, so a republish updates the same page =="
# The id travels inside the page rather than in a sidecar, because a sidecar recording which
# URL a page belongs to can fall out of sync with the page it describes.
grep -q 'ui-prototype:share id= ' "$TMP/p.html" \
  || grep -q 'ui-prototype:share id=' "$TMP/p.html" \
  && ok "a fresh page carries an empty share marker" || bad "fresh marker" "$(grep -o 'ui-prototype:share[^>]*' "$TMP/p.html")"
python3 - "$TMP/p.html" <<'PY'
import re, sys, pathlib
p = pathlib.Path(sys.argv[1]); t = p.read_text()
p.write_text(re.sub(r'ui-prototype:share id=\S*', 'ui-prototype:share id=abc123', t, count=1))
PY
go --out "$TMP/p.html" --surface web \
   --variant "Ochre=$TMP/a.css" --variant "Cobalt=$TMP/b.css" --variant "Clay=$TMP/c.css" >/dev/null
grep -q 'ui-prototype:share id=abc123' "$TMP/p.html" \
  && ok "an existing id survives a rebuild" || bad "id carried forward" "$(grep -o 'ui-prototype:share[^>]*' "$TMP/p.html")"

echo
echo "== usage =="
rc=$(go --out "$TMP/z.html" --surface web --variant "noequals")
[ "$rc" = 64 ] && ok "a --variant without Name=path exits 64" || bad "bad variant spec" "got $rc"
rc=$(go --out "$TMP/z.html" --surface hologram --variant "A=$TMP/a.css")
[ "$rc" = 64 ] && ok "an unknown surface exits 64" || bad "unknown surface" "got $rc"
rc=$(go --out "$TMP/z.html" --surface tui --depth 42 --variant "A=$TMP/a.css")
[ "$rc" = 64 ] && ok "an unknown depth exits 64" || bad "unknown depth" "got $rc"

echo
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
