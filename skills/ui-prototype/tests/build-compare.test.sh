#!/usr/bin/env bash
#
# build-compare.test.sh — the suite for build-compare.py, and the only one it gets.
#
# The script decides three things that fail by producing a page which looks right and lies: how
# many candidates the reader is actually comparing, how many arrangements they were offered,
# and what colour a terminal will paint. A dropped option and an unquantized palette both
# render beautifully, so the page is not evidence and this suite is.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/build-compare.py"
LAYOUTS="$ROOT/scripts/layouts"
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
n=$(grep -c 'name="design"' "$TMP/p.html")
[ "$n" = 3 ] && ok "three designs are offered" || bad "three designs offered" "got $n"
for name in Ochre Cobalt Clay; do
  grep -q ">$name<" "$TMP/p.html" || bad "the name $name is on its label" "missing"
done
ok "each design carries its candidate's name"
# The readout is what tells the picker which file they just chose; a page that shows a palette
# without naming its document leaves Step 6 guessing which candidate won.
n=$(grep -o 'class="rd rd-d' "$TMP/p.html" | wc -l | tr -d ' ')
[ "$n" = 3 ] && ok "each design names its own DESIGN.md" || bad "readout paths" "got $n"

echo
echo "== a candidate that cannot be rendered is an ERROR, not a dropped option =="
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
echo "== the layout axis: shipped by default, overridable, and every pair reachable =="
# A page that renders but can only reach three of nine combinations looks perfectly fine, so
# the count of switch rules is the assertion rather than the fact that a page came out.
for surf in web tui; do
  rc=$(go --out "$TMP/$surf.html" --surface "$surf" \
          --variant "A=$TMP/a.css" --variant "B=$TMP/b.css" --variant "C=$TMP/c.css")
  [ "$rc" = 0 ] || bad "$surf builds with the shipped layouts" "rc=$rc $(cat "$TMP/err")"
  n=$(grep -c 'class="layout layout-l' "$TMP/$surf.html")
  [ "$n" = 3 ] && ok "$surf ships three layouts" || bad "$surf shipped layouts" "got $n"
  n=$(grep -c 'body:has(#l[0-9]*:checked) .stage' "$TMP/$surf.html")
  [ "$n" = 3 ] && ok "$surf: every layout is selectable" || bad "$surf layout rules" "got $n"
  n=$(grep -c 'body:has(#d[0-9]*:checked) .stage {' "$TMP/$surf.html")
  [ "$n" = 3 ] && ok "$surf: every design paints the stage" || bad "$surf design rules" "got $n"
done
# 3 layouts x 3 designs is 9 pairs, and the page reaches them because the two axes are
# independent selectors over one stage rather than nine pre-rendered panels.

printf '<style>.lay-x { display:block; }</style>\n<div class="lay-x">only me</div>\n' > "$TMP/one.html"
rc=$(go --out "$TMP/l1.html" --surface web --variant "A=$TMP/a.css" --layout "Only=$TMP/one.html")
[ "$rc" = 0 ] && ok "--layout replaces the shipped set" || bad "--layout override" "rc=$rc $(cat "$TMP/err")"
n=$(grep -c 'class="layout layout-l' "$TMP/l1.html")
[ "$n" = 1 ] && ok "and only the named layout is on the page" || bad "override count" "got $n"

rc=$(go --out "$TMP/l2.html" --surface web --variant "A=$TMP/a.css" --layout "Gone=$TMP/nope.html")
[ "$rc" = 2 ] && ok "a missing layout exits 2, never a quiet three-of-four" || bad "missing layout" "got $rc"
grep -qi 'nobody was given the option' "$TMP/err" \
  && ok "and says why a dropped arrangement is worse" || bad "names the reason" "$(cat "$TMP/err")"
: > "$TMP/blank.html"
rc=$(go --out "$TMP/l3.html" --surface web --variant "A=$TMP/a.css" --layout "Blank=$TMP/blank.html")
[ "$rc" = 2 ] && ok "an empty layout exits 2" || bad "empty layout" "got $rc"
printf '@ unpaired sentinel\n' > "$TMP/odd.txt"
rc=$(go --out "$TMP/l4.html" --surface tui --variant "A=$TMP/a.css" --layout "Odd=$TMP/odd.txt")
[ "$rc" = 2 ] && ok "an unpaired @ in a frame exits 2" || bad "odd sentinel" "got $rc"

echo
echo "== a shipped skeleton names no colour of its own =="
# This is the rule that makes the design picker mean anything. A fallback IS a hardcoded
# colour — the one the picker cannot override — so the skeletons carry none and the script
# guarantees every --_* alias instead.
hits=$(grep -rniE '#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(' "$LAYOUTS" | head -5)
[ -z "$hits" ] && ok "no shipped skeleton carries a colour literal" \
                || bad "skeletons are colour-free" "$hits"
# and a layout that DOES hardcode one is named rather than silently shipped
printf '<style>.lay-y { color:#ff0000; }</style>\n<div class="lay-y">x</div>\n' > "$TMP/hard.html"
go --out "$TMP/l5.html" --surface web --variant "A=$TMP/a.css" --layout "Hard=$TMP/hard.html" >/dev/null
grep -qi 'hardcodes a colour' "$TMP/l5.html" \
  && ok "a layout that hardcodes a colour is named on the page" \
  || bad "hardcoded layout named" "the page says nothing"

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
# Every colour the stage is painted with must be IN the 16-colour palette; "fewer colours" is
# not the same claim as "colours this terminal has". The derived border is inside this block
# too, which is why it is built from the quantized accent rather than the authored one.
python3 - "$TMP/q16.html" <<'PY'
import re, sys
BASE16 = {(0,0,0),(128,0,0),(0,128,0),(128,128,0),(0,0,128),(128,0,128),(0,128,128),
          (192,192,192),(128,128,128),(255,0,0),(0,255,0),(255,255,0),(0,0,255),
          (255,0,255),(0,255,255),(255,255,255)}
page = open(sys.argv[1]).read()
# the page chrome is the pack's own palette and is not a candidate's colour; only the scoped
# design blocks and the swatches are quantized output.
block = page[page.index('body:has(#d0:checked) .stage {'):page.index('</style>')]
bad = [h for h in re.findall(r'#([0-9a-f]{6})', block)
       if tuple(int(h[i:i+2],16) for i in (0,2,4)) not in BASE16]
sys.exit(1 if bad else 0)
PY
[ $? = 0 ] && ok "and every stage colour is IN the 16-colour palette" \
           || bad "stage colours are in the palette" "found values outside BASE16"

go --out "$TMP/w.html" --surface web --depth 16 --variant "A=$TMP/a.css" >/dev/null
grep -q '#855300' "$TMP/w.html" \
  && ok "a WEB page is never quantized — the browser has the full range" \
  || bad "web unquantized" "#855300 was reduced on a web surface"

echo
echo "== a colour quantization cannot reduce is NAMED, not silently kept =="
# Only hex is reduced. The format also blesses oklch(), color-mix() and keywords, and those
# reach the page as authored — which is fine, and a lie if the page still claims a depth.
cat > "$TMP/odd.css" <<'EOF'
:root {
  --color-primary: oklch(0.62 0.19 32);
  --color-surface: #ffffff;
}
EOF
go --out "$TMP/odd.html" --surface tui --depth 16 --variant "Odd=$TMP/odd.css" >/dev/null
grep -q 'NOT quantized' "$TMP/odd.html" \
  && ok "the page names the token it could not reduce" \
  || bad "unreduced named on the page" "the footnote claims a clean quantization"
grep -q -- '--color-primary' "$TMP/err" \
  && ok "and stderr names it too, for a caller reading the run" \
  || bad "unreduced named on stderr" "$(cat "$TMP/err")"
go --out "$TMP/ok16.html" --surface tui --depth 16 --variant "A=$TMP/a.css" >/dev/null
grep -q 'NOT quantized' "$TMP/ok16.html" \
  && bad "an all-hex palette says nothing about gaps" "warned with nothing to warn about" \
  || ok "an all-hex palette carries no warning"

echo
echo "== the page is self-contained, and has no behaviour to break =="
# One property, two reasons: it must survive file:// and a published page cannot fetch anyway.
grep -qE '<link |src="http|@import|https?://' "$TMP/p.html" \
  && bad "no external references" "$(grep -oE '<link |src="http|@import|https?://' "$TMP/p.html" | head -3)" \
  || ok "no <link>, no @import, no external URL"
grep -qi '<script' "$TMP/p.html" \
  && bad "switching is CSS only" "the page carries a <script>" \
  || ok "no <script> — both axes switch through :has()"

echo
echo "== the share marker is carried forward, so a republish updates the same page =="
# The id travels inside the page rather than in a sidecar, because a sidecar recording which
# URL a page belongs to can fall out of sync with the page it describes.
grep -q 'ui-prototype:share id= ' "$TMP/p.html" \
  && ok "a fresh page carries an empty share marker" \
  || bad "fresh marker" "$(grep -o 'ui-prototype:share[^>]*' "$TMP/p.html")"
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
rc=$(go --out "$TMP/z.html" --surface web --variant "A=$TMP/a.css" --layout "noequals")
[ "$rc" = 64 ] && ok "a --layout without Name=path exits 64" || bad "bad layout spec" "got $rc"
rc=$(go --out "$TMP/z.html" --surface hologram --variant "A=$TMP/a.css")
[ "$rc" = 64 ] && ok "an unknown surface exits 64" || bad "unknown surface" "got $rc"
rc=$(go --out "$TMP/z.html" --surface tui --depth 42 --variant "A=$TMP/a.css")
[ "$rc" = 64 ] && ok "an unknown depth exits 64" || bad "unknown depth" "got $rc"

echo
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
