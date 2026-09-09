#!/usr/bin/env python3
"""Build the prototype page: every layout against every candidate's OWN exported tokens.

    python3 build-compare.py --out docs/design/variants/compare.html --surface web|tui \\
        --variant "Name=path/to/vars.css" --variant ... \\
        [--layout "Name=path/to/skeleton"] [--depth 16|256|truecolor]

One page, two independent choices. A layout picker says how the screen is arranged; a design
picker says what it looks like. Every pair is reachable, so the arrangement can be judged
without the palette deciding it and the palette without the arrangement deciding it.

What makes it worth trusting is that a design is nothing but that candidate's `designmd.sh
export --format css-vars` output, applied to the stage as custom properties the layouts read
with var(). The picture and the DESIGN.md cannot disagree, because one IS the other. A mock
styled by hand would drift from the tokens the moment either was edited, and nothing
downstream re-reads the page to notice.

That is also why a layout skeleton names no colour, size or font of its own -- every value it
paints with comes from the selected design through the `--_*` aliases below. A skeleton that
hardcodes a colour is a panel the design picker cannot repaint, so the build says so.

Switching is CSS only -- `:has()` over two radio groups, no script anywhere on the page. The
page has to survive `file://` and a published artifact, and a comparison with behaviour in it
is a comparison that can break.

Three things fail CLOSED, because each otherwise produces a page that looks right and lies:

  * A variant whose token file is missing or carries no custom properties is an ERROR, never
    a dropped column. Three candidates asked for and two rendered, presented as the answer,
    is a comparison nobody can see the hole in. A layout that cannot be read is the same
    error for the same reason: a silently dropped option is a choice nobody was offered.

  * On a terminal surface every colour is QUANTIZED to the declared depth before it reaches
    the page. A truecolor hex the linter certified at 4.5:1 renders as the nearest of 16 on
    a terminal that lacks the depth, so the contrast that passed is not the contrast on
    screen. Showing the original would sell a palette that cannot exist.

  * Only hex is quantized. A colour written as oklch(), color-mix() or a keyword reaches the
    page unreduced, so on a quantized build the page is NAMED as partly unquantized rather
    than claiming a depth it did not apply to everything.

The page is self-contained -- inlined CSS, no <link>, no external font or image, no fetch.
That is one property with two reasons rather than two rules: it has to survive being opened
from file://, and a published artifact cannot load external resources anyway.

The share marker (`<!-- ui-prototype:share id=... -->`) is READ BACK from the file being
overwritten and carried forward, so a later publish updates the page it already made instead
of minting a second link. It travels inside the page for the same reason: a sidecar file
recording which URL a page belongs to can fall out of sync with the page.

Exit codes:
  0   the page was written
  2   a variant's token file or a layout skeleton is missing, unreadable, or unusable
  64  usage
"""
import html
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

E_VARIANT = 2
E_USAGE = 64

VAR_RE = re.compile(r"^\s*(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);", re.M)
SHARE_RE = re.compile(r"<!--\s*ui-prototype:share\s+id=([^\s>]*)\s+[^>]*-->")
STYLE_RE = re.compile(r"<style[^>]*>(.*?)</style>", re.S | re.I)
DIM_RE = re.compile(r"^\d+(\.\d+)?(px|rem|em)$")
# A value that is trying to be a colour. Used only to decide whether an unquantizable token is
# worth naming -- a font stack that cannot be quantized is not a gap, a palette entry is.
COLOURISH = re.compile(r"^(#|rgba?\(|hsla?\(|hwb\(|oklch\(|oklab\(|lab\(|lch\(|color-mix\()", re.I)
HEX_LITERAL = re.compile(r"#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(")

# The shipped skeletons, in the order they are offered. Structure only: each reads the design's
# tokens through the --_* aliases and names no colour of its own.
SHIPPED = {
    "web": (("Sidebar", "sidebar.html"), ("Top nav", "topnav.html"), ("Split", "split.html")),
    "tui": (("Single pane", "single.txt"), ("Sidebar", "sidebar.txt"),
            ("Three pane", "three-pane.txt")),
}

# The xterm palette. Quantization needs the real ramp, not an approximation of it: the whole
# point is to show what the terminal will actually paint.
BASE16 = [
    (0, 0, 0), (128, 0, 0), (0, 128, 0), (128, 128, 0),
    (0, 0, 128), (128, 0, 128), (0, 128, 128), (192, 192, 192),
    (128, 128, 128), (255, 0, 0), (0, 255, 0), (255, 255, 0),
    (0, 0, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
]
_CUBE = [0, 95, 135, 175, 215, 255]
_XTERM = None


def xterm256():
    """The 256-colour palette: 16 system colours, a 6x6x6 cube, then a 24-step grey ramp."""
    global _XTERM
    if _XTERM is None:
        pal = list(BASE16)
        for r in _CUBE:
            for g in _CUBE:
                for b in _CUBE:
                    pal.append((r, g, b))
        for i in range(24):
            v = 8 + i * 10
            pal.append((v, v, v))
        _XTERM = pal
    return _XTERM


def parse_hex(value):
    """A CSS colour this script can quantize, or None when it cannot be reduced.

    Only hex is reduced. A named or functional colour is left exactly as written rather than
    guessed at -- a wrong quantization is worse than an unquantized one, because it claims
    to be what the terminal shows. What stops that from being a silent hole is that the build
    counts what it could not reduce and names it on the page.
    """
    v = value.strip()
    m = re.fullmatch(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})", v)
    if not m:
        return None
    h = m.group(1)
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def quantize(value, depth):
    """Snap a colour to what `depth` can actually paint. truecolor is a no-op by definition."""
    if depth == "truecolor":
        return value
    rgb = parse_hex(value)
    if rgb is None:
        return value
    palette = BASE16 if depth == "16" else xterm256()
    best = min(palette, key=lambda p: sum((a - b) ** 2 for a, b in zip(rgb, p)))
    return "#%02x%02x%02x" % best


def unquantized(tokens, depth):
    """The colour tokens `depth` was asked to reduce and could not. Named, never swallowed."""
    if depth == "truecolor":
        return []
    return [k for k, v in tokens
            if parse_hex(v) is None
            and (COLOURISH.match(v.strip()) or "colo" in k.lower())]


def read_tokens(path):
    """The custom properties of one candidate, in file order."""
    p = Path(path)
    if not p.is_file():
        raise SystemExit(f"build-compare: no token file at {path} — a candidate cannot be "
                         f"shown without its own exported tokens, and dropping it "
                         f"would present {path!r} as though it had never been asked for."
                         f"\n(exit {E_VARIANT})")
    text = p.read_text(encoding="utf-8", errors="replace")
    pairs = VAR_RE.findall(text)
    if not pairs:
        raise SystemExit(f"build-compare: {path} carries no custom properties. An empty token "
                         f"set renders this candidate identically to every other one, which "
                         f"is a page showing three of the same thing and calling them choices."
                         f"\n(exit {E_VARIANT})")
    return [(k, v.strip()) for k, v in pairs]


def pick(tokens, *names, default="#888888"):
    """The first token whose name ends in one of `names` -- naming conventions vary."""
    d = dict(tokens)
    for n in names:
        for k, v in tokens:
            if k == f"--{n}" or k.endswith(f"-{n}"):
                return v
    return d.get("--color-primary", default)


def pick_dim(tokens, *names, default="16px"):
    """A length token, or the default. Never falls back to a colour the way pick() does.

    A terminal candidate writes spacing in CELLS -- bare numbers, per tui-mapping.md -- which
    is not a CSS length. Those fall to the default rather than being pasted into a padding
    rule, where `2` would silently mean nothing at all.
    """
    for n in names:
        for k, v in tokens:
            if (k == f"--{n}" or k.endswith(f"-{n}")) and DIM_RE.match(v.strip()):
                return v.strip()
    return default


def aliases(tokens, surface, depth):
    """The contract every skeleton paints through.

    A skeleton cannot know whether this candidate called it `--color-primary`, `--color-brand`
    or `--primary`, and must not carry a fallback of its own -- a fallback IS a hardcoded
    colour, and the one the design picker cannot override. So the resolution happens here,
    once, and every alias is always emitted.
    """
    tui = surface == "tui"
    bg = pick(tokens, "surface", "background", "neutral", default="#101010" if tui else "#ffffff")
    fg = pick(tokens, "on-surface", "text", "foreground",
              default="#e0e0e0" if tui else "#111111")
    accent = pick(tokens, "primary", default="#66ccff" if tui else "#3355ff")
    on_accent = pick(tokens, "on-primary", default="#000000" if tui else "#ffffff")
    out = [(k, quantize(v, depth)) for k, v in
           (("--_surface", bg), ("--_text", fg), ("--_primary", accent),
            ("--_on-primary", on_accent))]
    # The derived border is built from the QUANTIZED accent, not the authored one. Alpha-hex
    # is not itself reducible, so deriving it first would smuggle an unquantized colour onto a
    # page that says every colour on it is one the terminal can paint.
    q_accent = out[2][1]
    out.append(("--_border", quantize(pick(tokens, "border", "outline", "divider",
                                           default=("%s33" % q_accent) if parse_hex(q_accent)
                                           else q_accent), depth)))
    # Cells have no radius, which is why tui-mapping.md has `rounded` in `omitted:`.
    out.append(("--_radius", "0" if tui else pick_dim(tokens, "radius", "rounded", default="6px")))
    out.append(("--_gap", pick_dim(tokens, "gutter", "gap", "spacing", "md", default="14px")))
    out.append(("--_pad", pick_dim(tokens, "pad", "padding", "lg", default="18px")))
    return out


def scope(tokens, n, surface, depth):
    """One candidate's tokens, applied to the stage when its radio is checked.

    The stage is where the layouts live, so this is what paints them -- the exported tokens
    are the page, rather than a listing beside it.
    """
    lines = [f"  {k}: {quantize(v, depth)};" for k, v in tokens]
    lines += [f"  {k}: {v};" for k, v in aliases(tokens, surface, depth)]
    return "body:has(#d%d:checked) .stage {\n%s\n}" % (n, "\n".join(lines))


def read_layout(name, path, surface):
    """One skeleton: (its own CSS, its markup). A skeleton that cannot be read is an error."""
    p = Path(path)
    if not p.is_file():
        raise SystemExit(f"build-compare: no layout skeleton at {path} — {name!r} was offered "
                         f"as a choice and cannot be drawn, and showing the page without it "
                         f"presents an arrangement nobody was given the option of."
                         f"\n(exit {E_VARIANT})")
    text = p.read_text(encoding="utf-8", errors="replace")
    if not text.strip():
        raise SystemExit(f"build-compare: layout skeleton {path} is empty."
                         f"\n(exit {E_VARIANT})")
    if surface == "tui":
        return "", tui_markup(name, path, text)
    css = "\n".join(m.group(1).strip() for m in STYLE_RE.finditer(text))
    markup = STYLE_RE.sub("", text).strip()
    if not markup:
        raise SystemExit(f"build-compare: layout skeleton {path} carries CSS but no markup."
                         f"\n(exit {E_VARIANT})")
    return css, markup


def tui_markup(name, path, text):
    """A terminal frame as a grid of cells. `@` toggles the accent span, so a highlight can
    cover one pane of a line rather than the whole row."""
    rows = []
    for i, line in enumerate(text.splitlines(), 1):
        if line.count("@") % 2:
            raise SystemExit(f"build-compare: {path} line {i} has an odd number of `@`. The "
                             f"sentinel toggles the accent span, so an unpaired one paints "
                             f"the rest of the frame as selected."
                             f"\n(exit {E_VARIANT})")
        parts = [html.escape(s) for s in line.split("@")]
        cells = "".join(f'<span class="sel">{s}</span>' if n % 2 else s
                        for n, s in enumerate(parts))
        rows.append(f'<span class="row">{cells}</span>')
    return '<pre class="tui">' + "\n".join(rows) + "</pre>"


PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<style>
/* The page's own chrome uses the pack's document palette, never a candidate's. Style the frame
   in one of the palettes it is showing and the page competes with the thing being judged. */
:root {{
  --ivory:#FAF9F5; --surface:#FFFFFF; --gray-150:#F0EEE6; --gray-300:#D1CFC5;
  --gray-500:#87867F; --gray-700:#3D3D3A; --slate:#141413;
  --serif: ui-serif, Georgia, "Times New Roman", serif;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}}
* {{ margin:0; padding:0; box-sizing:border-box; }}
body {{ font-family:var(--sans); background:var(--ivory); color:var(--gray-700);
  line-height:1.55; padding:0 0 96px; }}
header {{ padding:38px 32px 20px; border-bottom:1.5px solid var(--gray-300); }}
h1 {{ font-family:var(--serif); color:var(--slate); font-size:30px; font-weight:600; }}
.sub {{ font-family:var(--mono); font-size:12px; color:var(--gray-500);
  text-transform:uppercase; letter-spacing:.08em; margin-bottom:10px; }}
.lede {{ max-width:64ch; margin-top:10px; color:var(--gray-700); }}

/* The two axes. Switching is `:has()` over radio groups -- no script, so nothing here can
   break in a way a static page cannot recover from. */
.axes {{ display:flex; flex-wrap:wrap; gap:26px; margin-top:22px; }}
.axis {{ border:0; display:flex; flex-wrap:wrap; align-items:center; gap:7px; }}
.axis > .lbl {{ font-family:var(--mono); font-size:11px; color:var(--gray-500);
  text-transform:uppercase; letter-spacing:.07em; margin-right:4px; min-width:52px; }}
.pick {{ position:absolute; width:1px; height:1px; opacity:0; }}
.pick + label {{ border:1.5px solid var(--gray-300); border-radius:5px; padding:6px 13px;
  font-size:13px; cursor:pointer; background:var(--surface); }}
.pick:checked + label {{ background:var(--slate); border-color:var(--slate); color:var(--ivory); }}
.pick:focus-visible + label {{ outline:2px solid var(--slate); outline-offset:2px; }}

.stage {{ margin:30px 32px 0; border:1.5px solid var(--gray-300); border-radius:6px;
  background:var(--_surface); color:var(--_text); overflow:hidden; }}
.stage > .layout {{ display:none; }}
{visible}

/* Components. Every value comes from the selected design, which is what lets one skeleton be
   painted by any candidate -- and why a skeleton carries no colour of its own. */
.ui-brand {{ display:flex; align-items:center; gap:8px; font-weight:600; font-size:14px; }}
.ui-dot {{ width:10px; height:10px; border-radius:50%; background:var(--_primary);
  display:inline-block; flex:none; }}
.ui-nav a {{ display:block; padding:7px 10px; border-radius:var(--_radius); font-size:13px;
  opacity:.7; }}
.ui-nav a.on {{ background:var(--_primary); color:var(--_on-primary); opacity:1; }}
.ui-bar {{ display:flex; align-items:center; gap:var(--_gap); border-bottom:1.5px solid
  var(--_border); padding-bottom:10px; }}
.ui-bar > .ui-btn {{ margin-left:auto; }}
.ui-h {{ font-size:17px; font-weight:600; }}
.ui-lede {{ font-size:13px; opacity:.75; max-width:60ch; }}
.ui-btn {{ border:0; border-radius:var(--_radius); padding:9px 16px; font:inherit;
  font-size:13px; background:var(--_primary); color:var(--_on-primary); cursor:pointer; }}
.ui-card {{ border:1.5px solid var(--_border); border-radius:var(--_radius);
  padding:var(--_pad); display:flex; flex-direction:column; gap:3px; }}
.ui-amt {{ font-size:22px; font-weight:600; }}
.ui-meta {{ font-size:11px; opacity:.6; }}
.ui-table {{ width:100%; border-collapse:collapse; font-size:13px; }}
.ui-table th {{ text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.06em;
  opacity:.55; padding:6px 10px 6px 0; border-bottom:1.5px solid var(--_border); }}
.ui-table td {{ padding:8px 10px 8px 0; border-bottom:1px solid var(--_border); }}
.ui-table tr.on td {{ background:var(--_primary); color:var(--_on-primary); }}
/* A terminal's cells are flush. line-height above 1 opens gaps between the vertical rules of
   a box-drawn frame, which reads as a broken frame rather than as a mock. */
pre.tui {{ font-family:var(--mono); font-size:13px; line-height:1; padding:18px;
  overflow-x:auto; }}
pre.tui .row {{ display:block; white-space:pre; }}
pre.tui .sel {{ background:var(--_primary); color:var(--_on-primary); }}
{layoutcss}

.readout {{ margin:16px 32px 0; font-size:13px; color:var(--gray-500); }}
.readout code {{ font-family:var(--mono); font-size:12px; color:var(--gray-700); }}
.readout .rd {{ display:none; }}
.palettes {{ margin:14px 32px 0; }}
.palettes .pal {{ display:none; flex-wrap:wrap; gap:5px; }}
.sw {{ width:22px; height:22px; border-radius:3px; border:1px solid var(--gray-300); }}
footer {{ padding:22px 32px 0; font-size:13px; color:var(--gray-500); max-width:70ch; }}
footer code {{ font-family:var(--mono); font-size:12px; }}
{scopes}
</style>
</head>
<body>
{marker}
<header>
  <div class="sub">{eyebrow}</div>
  <h1>{heading}</h1>
  <p class="lede">Two independent choices. The arrangement comes from a layout skeleton; every
  colour, radius and space in it comes from that candidate's own exported tokens, so what you
  see is what its <code>DESIGN.md</code> says. Pick one of each.</p>
  <div class="axes">
    <fieldset class="axis"><span class="lbl">Layout</span>
{layoutpicks}
    </fieldset>
    <fieldset class="axis"><span class="lbl">Design</span>
{designpicks}
    </fieldset>
  </div>
</header>
<main class="stage">
{stage}
</main>
<div class="readout">{readout}</div>
<div class="palettes">{palettes}</div>
<footer><p>{footnote}</p></footer>
</body>
</html>
"""


def main(argv):
    out = None
    surface = "web"
    depth = "truecolor"
    variants = []
    layouts = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--out" and i + 1 < len(argv):
            out = argv[i + 1]; i += 2
        elif a == "--surface" and i + 1 < len(argv):
            surface = argv[i + 1]; i += 2
        elif a == "--depth" and i + 1 < len(argv):
            depth = argv[i + 1]; i += 2
        elif a in ("--variant", "--layout") and i + 1 < len(argv):
            spec = argv[i + 1]
            if "=" not in spec:
                raise SystemExit(f"build-compare: {a} wants Name=path, got {spec!r}"
                                 f"\n(exit {E_USAGE})")
            name, path = spec.split("=", 1)
            (variants if a == "--variant" else layouts).append((name, path)); i += 2
        else:
            raise SystemExit(__doc__ + f"\n(exit {E_USAGE})")
    if not out or not variants:
        raise SystemExit(__doc__ + f"\n(exit {E_USAGE})")
    if surface not in ("web", "tui"):
        raise SystemExit(f"build-compare: --surface is web or tui, got {surface!r}"
                         f"\n(exit {E_USAGE})")
    if depth not in ("16", "256", "truecolor"):
        raise SystemExit(f"build-compare: --depth is 16, 256 or truecolor, got {depth!r}"
                         f"\n(exit {E_USAGE})")
    # A web page is never quantized: the browser has the full range.
    eff_depth = depth if surface == "tui" else "truecolor"
    if not layouts:
        base = Path(__file__).resolve().parent / "layouts" / surface
        layouts = [(name, str(base / f)) for name, f in SHIPPED[surface]]

    out_p = Path(out)
    prior = out_p.read_text(encoding="utf-8", errors="replace") if out_p.is_file() else ""
    m = SHARE_RE.search(prior)
    share_id = m.group(1) if m else ""

    layoutcss, stage, layoutpicks, visible, opaque = [], [], [], [], []
    for n, (name, path) in enumerate(layouts):
        css, markup = read_layout(name, path, surface)
        if css:
            layoutcss.append(css)
        if HEX_LITERAL.search(css) or HEX_LITERAL.search(markup):
            opaque.append(name)
        stage.append(f'<div class="layout layout-l{n}">\n{markup}\n</div>')
        checked = " checked" if n == 0 else ""
        layoutpicks.append(f'      <input class="pick" type="radio" name="layout" '
                           f'id="l{n}"{checked}><label for="l{n}">{html.escape(name)}</label>')
        visible.append(f"body:has(#l{n}:checked) .stage > .layout-l{n} {{ display:block; }}")

    scopes, designpicks, readout, palettes, unreduced = [], [], [], [], []
    for n, (name, path) in enumerate(variants):
        tokens = read_tokens(path)
        scopes.append(scope(tokens, n, surface, eff_depth))
        unreduced += unquantized(tokens, eff_depth)
        checked = " checked" if n == 0 else ""
        designpicks.append(f'      <input class="pick" type="radio" name="design" '
                           f'id="d{n}"{checked}><label for="d{n}">{html.escape(name)}</label>')
        visible.append(f"body:has(#d{n}:checked) .rd-d{n} {{ display:inline; }}")
        visible.append(f"body:has(#d{n}:checked) .pal-d{n} {{ display:flex; }}")
        doc = Path(path).parent / "DESIGN.md"
        readout.append(f'<span class="rd rd-d{n}">{html.escape(name)} — '
                       f'<code>{html.escape(str(doc))}</code>, {len(tokens)} tokens</span>')
        sw = "".join(f'<span class="sw" style="background:{quantize(v, eff_depth)}"></span>'
                     for k, v in tokens if parse_hex(v))
        palettes.append(f'<div class="pal pal-d{n}">{sw}</div>')

    note = ("Colours are quantized to the declared %s-colour depth, so this is what the terminal "
            "paints — not the authored values." % depth) if surface == "tui" else \
           ("Rendered at the browser's full colour range.")
    if unreduced:
        note += (" NOT quantized, because only hex is reduced: %s. Those render here as authored "
                 "and will not on a %s-colour terminal — rewrite them as hex to see the truth."
                 % (", ".join(sorted(set(unreduced))), depth))
    if opaque:
        note += (" Layout %s hardcodes a colour, so the design picker cannot repaint it."
                 % ", ".join(sorted(set(opaque))))
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    html_out = PAGE.format(
        title=f"{len(variants)} designs, {len(layouts)} layouts",
        eyebrow=f"{surface} · {len(variants)} designs × {len(layouts)} layouts",
        heading="Pick a layout and a design",
        visible="\n".join(visible),
        layoutcss="\n".join(layoutcss),
        scopes="\n".join(scopes),
        stage="\n".join(stage),
        layoutpicks="\n".join(layoutpicks),
        designpicks="\n".join(designpicks),
        readout="\n".join(readout),
        palettes="\n".join(palettes),
        marker=f"<!-- ui-prototype:share id={share_id} generated={stamp} -->",
        footnote=note)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    out_p.write_text(html_out, encoding="utf-8")
    print(out_p)
    for name in sorted(set(unreduced)):
        print(f"build-compare: {name} could not be quantized to {depth} — it is not hex",
              file=sys.stderr)
    for name in sorted(set(opaque)):
        print(f"build-compare: layout {name} hardcodes a colour the design picker cannot "
              f"override", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except SystemExit as e:
        if isinstance(e.code, str):
            sys.stderr.write(e.code + "\n")
            sys.exit(E_VARIANT if f"exit {E_VARIANT}" in e.code else E_USAGE)
        raise
