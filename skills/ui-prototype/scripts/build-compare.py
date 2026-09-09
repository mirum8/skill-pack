#!/usr/bin/env python3
"""Build the comparison page from the candidates' OWN exported tokens.

    python3 build-compare.py --out docs/design/variants/compare.html --surface web|tui \\
        --variant "Name=path/to/vars.css" --variant ... [--depth 16|256|truecolor]

The page shows every candidate side by side so a person can pick one. What makes it worth
trusting is that each panel is styled from that candidate's `designmd.sh export --format
css-vars` output and nothing else -- the picture and the DESIGN.md cannot disagree, because
one is generated from the other. A hand-written mock would drift from the tokens the moment
either was edited, and nothing downstream re-reads the page to notice.

Two things fail CLOSED, because both otherwise produce a page that looks right and lies:

  * A variant whose token file is missing or carries no custom properties is an ERROR, never
    a dropped column. Three candidates asked for and two rendered, presented as the answer,
    is a comparison nobody can see the hole in.

  * On a terminal surface every colour is QUANTIZED to the declared depth before it reaches
    the page. A truecolor hex the linter certified at 4.5:1 renders as the nearest of 16 on
    a terminal that lacks the depth, so the contrast that passed is not the contrast on
    screen. Showing the original would sell a palette that cannot exist.

The page is self-contained -- inlined CSS, no <link>, no external font or image, no fetch.
That is one property with two reasons rather than two rules: it has to survive being opened
from file://, and a published artifact cannot load external resources anyway.

The share marker (`<!-- ui-prototype:share id=... -->`) is READ BACK from the file being
overwritten and carried forward, so a later publish updates the page it already made instead
of minting a second link. It travels inside the page for the same reason: a sidecar file
recording which URL a page belongs to can fall out of sync with the page.

Exit codes:
  0   the page was written
  2   a variant's token file is missing, unreadable, or carries no custom properties
  64  usage
"""
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

E_VARIANT = 2
E_USAGE = 64

VAR_RE = re.compile(r"^\s*(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);", re.M)
SHARE_RE = re.compile(r"<!--\s*ui-prototype:share\s+id=([^\s>]*)\s+[^>]*-->")

# The xterm palette. Quantization needs the real ramp, not an approximation of it: the whole
# point is to show what the terminal will actually paint.
BASE16 = [
    (0, 0, 0), (128, 0, 0), (0, 128, 0), (128, 128, 0),
    (0, 0, 128), (128, 0, 128), (0, 128, 128), (192, 192, 192),
    (128, 128, 128), (255, 0, 0), (0, 255, 0), (255, 255, 0),
    (0, 0, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
]
_CUBE = [0, 95, 135, 175, 215, 255]


def xterm256():
    """The 256-colour palette: 16 system colours, a 6x6x6 cube, then a 24-step grey ramp."""
    pal = list(BASE16)
    for r in _CUBE:
        for g in _CUBE:
            for b in _CUBE:
                pal.append((r, g, b))
    for i in range(24):
        v = 8 + i * 10
        pal.append((v, v, v))
    return pal


def parse_hex(value):
    """A CSS colour this script can quantize, or None when it cannot be reduced.

    Only hex is reduced. A named or functional colour is left exactly as written rather than
    guessed at -- a wrong quantization is worse than an unquantized one, because it claims
    to be what the terminal shows.
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


def read_tokens(path):
    """The custom properties of one candidate, in file order."""
    p = Path(path)
    if not p.is_file():
        raise SystemExit(f"build-compare: no token file at {path} — a candidate cannot be "
                         f"shown without its own exported tokens, and dropping its column "
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


def scope(tokens, cls, depth):
    """One candidate's tokens, scoped to its own panel so three palettes cannot bleed."""
    lines = [f"  {k}: {quantize(v, depth)};" for k, v in tokens]
    return f".{cls} {{\n" + "\n".join(lines) + "\n}"


def web_panel(tokens):
    bg = pick(tokens, "surface", "background", "neutral", default="#ffffff")
    fg = pick(tokens, "on-surface", "text", "foreground", default="#111111")
    accent = pick(tokens, "primary", default="#3355ff")
    on_accent = pick(tokens, "on-primary", default="#ffffff")
    return f"""
      <div class="mock" style="background:{bg};color:{fg}">
        <div class="mock-bar" style="border-color:{accent}">
          <span class="mock-dot" style="background:{accent}"></span>
          <strong>Ledger</strong><span class="mock-nav">Entries · Payouts · Reports</span>
        </div>
        <h4 style="color:{fg}">Account balance</h4>
        <p style="color:{fg};opacity:.75">Every entry is stored in minor units. Nothing here
        rounds until it is displayed.</p>
        <div class="mock-card" style="border-color:{accent}33">
          <span class="mock-amt" style="color:{fg}">£12,480.00</span>
          <span class="mock-meta" style="color:{fg};opacity:.6">updated just now</span>
        </div>
        <button class="mock-btn" style="background:{accent};color:{on_accent}">Add entry</button>
      </div>"""


# One terminal frame, drawn as text so the mock is a grid of cells rather than a picture of one.
TUI_FRAME = [
    "┌─ ledger ──────────────────────────────┐",
    "│ ID    ACCOUNT      AMOUNT      STATUS │",
    "│ 0a1c  acme-ltd     12,480.00   ok     │",
    "@ 0a1d  brightsea      -940.00   held   @",
    "│ 0a1e  northwind     3,200.00   ok     │",
    "│                                       │",
    "└ ^n new  ^f filter  ^q quit ───────────┘",
]


def tui_panel(tokens, depth):
    bg = quantize(pick(tokens, "surface", "background", default="#101010"), depth)
    fg = quantize(pick(tokens, "on-surface", "text", default="#e0e0e0"), depth)
    accent = quantize(pick(tokens, "primary", default="#66ccff"), depth)
    sel_bg = accent
    sel_fg = quantize(pick(tokens, "on-primary", default="#000000"), depth)
    rows = []
    for line in TUI_FRAME:
        if line.startswith("@"):
            # the selected row: the one place the accent carries meaning rather than decoration
            rows.append(f'<span class="sel" style="background:{sel_bg};color:{sel_fg}">'
                        f'{line[1:-1]}</span>')
        else:
            rows.append(f'<span style="color:{fg}">{line}</span>')
    body = "\n".join(rows)
    return (f'<pre class="mock tui" style="background:{bg};color:{fg};'
            f'border-color:{accent}">{body}</pre>')


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
  --gray-500:#87867F; --gray-700:#3D3D3A; --slate:#141413; --clay:#D97757;
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
.grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(330px,1fr));
  gap:26px; padding:30px 32px; align-items:start; }}
.card {{ border:1.5px solid var(--gray-300); border-radius:6px; background:var(--surface);
  overflow:hidden; }}
.card > h2 {{ font-family:var(--serif); font-size:19px; color:var(--slate);
  padding:16px 18px 4px; }}
.card > .why {{ padding:0 18px 14px; font-size:14px; color:var(--gray-500); }}
.mock {{ padding:20px; min-height:250px; }}
.mock-bar {{ display:flex; align-items:center; gap:10px; font-size:13px;
  border-bottom:1.5px solid; padding-bottom:10px; margin-bottom:16px; }}
.mock-dot {{ width:10px; height:10px; border-radius:50%; display:inline-block; }}
.mock-nav {{ margin-left:auto; opacity:.6; font-size:12px; }}
.mock h4 {{ font-size:17px; margin-bottom:6px; }}
.mock p {{ font-size:13px; margin-bottom:14px; }}
.mock-card {{ border:1.5px solid; border-radius:5px; padding:12px 14px; margin-bottom:14px;
  display:flex; flex-direction:column; gap:3px; }}
.mock-amt {{ font-size:22px; font-weight:600; }}
.mock-meta {{ font-size:11px; }}
.mock-btn {{ border:0; border-radius:4px; padding:9px 16px; font-size:13px;
  font-family:inherit; cursor:pointer; }}
pre.tui {{ font-family:var(--mono); font-size:12.5px; line-height:1.45; padding:16px;
  border:1.5px solid; overflow-x:auto; min-height:250px; }}
pre.tui span {{ display:block; white-space:pre; }}
.tokens {{ border-top:1px solid var(--gray-300); padding:12px 18px; background:var(--gray-150); }}
.tokens summary {{ font-family:var(--mono); font-size:11px; color:var(--gray-500);
  cursor:pointer; text-transform:uppercase; letter-spacing:.06em; }}
.swatches {{ display:flex; flex-wrap:wrap; gap:5px; margin-top:10px; }}
.sw {{ width:22px; height:22px; border-radius:3px; border:1px solid var(--gray-300); }}
footer {{ padding:0 32px; font-size:13px; color:var(--gray-500); max-width:70ch; }}
footer code {{ font-family:var(--mono); font-size:12px; }}
{panels}
</style>
</head>
<body>
{marker}
<header>
  <div class="sub">{eyebrow}</div>
  <h1>{heading}</h1>
  <p class="lede">Each panel is rendered from that candidate's own exported tokens, so what you
  see is what its <code>DESIGN.md</code> says. Pick one; the others stay on disk as the record
  of what was turned down.</p>
</header>
<div class="grid">
{cards}
</div>
<footer><p>{footnote}</p></footer>
</body>
</html>
"""


def main(argv):
    out = None
    surface = "web"
    depth = "truecolor"
    variants = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--out" and i + 1 < len(argv):
            out = argv[i + 1]; i += 2
        elif a == "--surface" and i + 1 < len(argv):
            surface = argv[i + 1]; i += 2
        elif a == "--depth" and i + 1 < len(argv):
            depth = argv[i + 1]; i += 2
        elif a == "--variant" and i + 1 < len(argv):
            spec = argv[i + 1]
            if "=" not in spec:
                raise SystemExit(f"build-compare: --variant wants Name=path, got {spec!r}"
                                 f"\n(exit {E_USAGE})")
            name, path = spec.split("=", 1)
            variants.append((name, path)); i += 2
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

    out_p = Path(out)
    prior = out_p.read_text(encoding="utf-8", errors="replace") if out_p.is_file() else ""
    m = SHARE_RE.search(prior)
    share_id = m.group(1) if m else ""

    panels, cards = [], []
    for n, (name, path) in enumerate(variants):
        tokens = read_tokens(path)
        cls = f"v{n}"
        panels.append(scope(tokens, cls, eff_depth))
        mock = tui_panel(tokens, eff_depth) if surface == "tui" else web_panel(tokens)
        swatches = "".join(
            f'<span class="sw" style="background:{quantize(v, eff_depth)}"></span>'
            for k, v in tokens if parse_hex(v))
        cards.append(
            f'<section class="card {cls}">\n  <h2>{name}</h2>\n'
            f'  <p class="why">{len(tokens)} tokens</p>\n{mock}\n'
            f'  <details class="tokens"><summary>palette</summary>'
            f'<div class="swatches">{swatches}</div></details>\n</section>')

    note = ("Colours are quantized to the declared %s-colour depth, so this is what the terminal "
            "paints — not the authored values." % depth) if surface == "tui" else \
           ("Rendered at the browser's full colour range.")
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    html = PAGE.format(
        title=f"{len(variants)} directions",
        eyebrow=f"{surface} · {len(variants)} candidates",
        heading=f"{len(variants)} visual directions",
        panels="\n".join(panels),
        cards="\n".join(cards),
        marker=f"<!-- ui-prototype:share id={share_id} generated={stamp} -->",
        footnote=note)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    out_p.write_text(html, encoding="utf-8")
    print(out_p)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except SystemExit as e:
        if isinstance(e.code, str):
            sys.stderr.write(e.code + "\n")
            sys.exit(E_VARIANT if f"exit {E_VARIANT}" in e.code else E_USAGE)
        raise
