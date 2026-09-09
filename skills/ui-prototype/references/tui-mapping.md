# A `DESIGN.md` for a terminal

The format was written for the web, and a terminal has no fonts to choose, no pixels to measure and
no corners to round. It still fits — every accommodation below is something the format already
supports, not a bend in it. What follows is forced by the surface rather than chosen.

## Typography and rounding are declared omitted, with reasons

`omitted:` is the format's own mechanism for a section that does not apply, and it takes a reason:

```yaml
omitted:
  - section: typography
    reason: "the terminal owns the font; only weight, inverse and dim are ours"
  - section: rounded
    reason: "cells have no radius"
```

**Declare them rather than leaving them out.** An absent section and a section that does not apply
look identical on disk, and the linter warns about the first. The reason is what tells the next
reader — and the next agent — that nobody forgot.

What *is* still ours on the type axis: weight (bold), inverse, dim, and underline where the terminal
supports it. Those belong in `## Typography` as prose under the omission, or in `components` as
per-state tokens.

## Spacing is in cells

The schema is `map<string, Dimension | number>` and admits a unitless number — the spec's own
example is "column counts or ratios". A terminal grid is exactly that:

```yaml
spacing:
  gutter: 2        # cells between columns
  pad: 1           # cells inside a bordered box
  margin: 4
```

Never write `16px` here. A pixel value in a terminal document is a number nothing can act on, and
it invites a renderer to divide by a cell width nobody declared.

## The colour depth is declared, and it is load-bearing

```yaml
terminal:
  colorDepth: 256      # 16 | 256 | truecolor
```

`terminal` is a custom top-level key. The format is **intentionally extensible** — the `unknown-key`
rule only warns on keys within edit distance 2 of a schema key, and `terminal` is nowhere near any
of them — so this lints clean and stays machine-readable. Prose could not be: `build-compare.py`
reads this value to decide what to paint.

**Why it cannot be optional.** The linter computes WCAG contrast on the values as written. A
truecolor pair certified at 4.5:1 is painted as the nearest of the 16 system colours on a terminal
that has only those, and the nearest of 16 to two nearly-identical hexes is frequently *the same
colour*. The contrast that passed is then not the contrast on screen, and the document says
otherwise. So:

- Declare the depth of the **least capable terminal you intend to support**, not the one you develop
  in.
- Author the palette, then check it *after* quantization — `build-compare.py --depth 16` shows what
  the terminal actually paints.
- On `16`, do not rely on hue to carry meaning. There are eight usable colours and their bright
  variants; state (selected, error, disabled) is carried by inverse, bold and dim at least as much
  as by colour.

## Components are states, not shapes

A terminal component has no padding-and-radius to specify. What it has is states, and those map onto
the format's component-variant convention cleanly:

```yaml
components:
  row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
  row-selected:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
  row-error:
    textColor: "{colors.error}"
  border:
    textColor: "{colors.outline}"
```

Name the box-drawing set in `## Shapes` prose — single-line, double-line, heavy, or ASCII-only for
terminals without the glyphs. That is the terminal's answer to a corner radius, and a project that
ships to unknown terminals should say so there.

## What the comparison page shows, and what it does not

The mock is a `<pre>` grid of styled cells, quantized to the declared depth, and there are three of
them: a single pane, a sidebar and a three-pane split, switchable against any candidate. It is good
enough to choose between three palettes, to catch an unreadable one, and to see whether the palette
survives being cut into panes — a two-colour scheme that reads cleanly on one full-width table can
lose every boundary once there are three.

A frame is plain text, and `@` toggles the accent span. That is why the highlight can cover one
pane of a line rather than the whole row, which is what a selected item in a sidebar actually looks
like; an unpaired `@` is refused, because it would paint the rest of the frame as selected.

It is **not** proof. It cannot tell you the frame fits at 80 columns, that the app's renderer emits
those attributes, or that the box-drawing characters align in the user's font. Only
`tui-session.sh` at real geometries can, which is why Step 7 exists and why an empty capture
(exit 5) or an unapplied geometry (exit 7) fails the certification rather than passing.
