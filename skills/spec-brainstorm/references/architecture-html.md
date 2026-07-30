# Writing `architecture.html`

These are the `html-diagram` conventions, restated here in full. **That skill is user-invocable only
(`disable-model-invocation: true`) — never attempt to call it.** Its exemplar is bundled here as
`references/architecture-example.html`.

Optional at **small** depth: write it only if the system has more than one moving part worth drawing. A
one-process app with a database does not need a full-screen interactive stage.

## Contents

1. Read the exemplar — and where it's wrong
2. The contract
3. The palette
4. SVG structure
5. Flows and detail
6. Sizing
7. Failure checks

---

## 1. Read the exemplar — and where it's wrong

**Read `references/architecture-example.html` in full before writing.** It's a finished page in exactly this
style: full-screen SVG stage, clickable nodes, flow chips that light and animate request paths, dark mode with
a toggle. Copy its structure, class names, CSS variables and JS shape; swap in this project's nodes and flows.

It predates the rules below and deviates in three places. Follow this file, not the example, on these:

- Its `<svg>` uses `role="img" aria-label="…"` with `<defs>` as the first child and **no `<title>`**. Add a
  `<title id="arch-title">` as the first child and reference it with `aria-labelledby` — `role="img"` alone
  makes assistive tech skip every node label inside.
- It ships four `.badge` CSS rules with **no `.badge` markup anywhere**. Don't copy them.
- It defines `--gold` and `--blue` that are **never referenced**. Don't copy them either.

> Provenance: this example is a copy of the `html-diagram` skill's own reference. If that skill's examples
> change, re-sync — and re-check the three deviations above.

---

## 2. The contract

1. `docs/<topic>/architecture.html`, fully self-contained — inline CSS, inline `<svg>`, inline `<script>`.
2. **Apply-before-paint theme script first in `<head>`, before `<style>`**, unwrapped, no `defer`: read
   `localStorage.getItem('theme')`, else `matchMedia('(prefers-color-scheme: dark)')`, then
   `document.documentElement.classList.toggle('dark', dark)`. After `<style>`, or inside `DOMContentLoaded`,
   reintroduces the white flash it exists to prevent.
3. **Two variable blocks**, `:root` and `html.dark` (§3). Every colour from `var(--…)`. **Zero hard-coded hex
   between `<svg` and `</svg>`.**
4. **Theme toggle** in the top bar, persisting `'dark'`/`'light'` under the `'theme'` key.
5. **Full-screen stage:**
   ```css
   html, body { height: 100%; }
   body { display: flex; flex-direction: column; overflow: hidden; }
   .bar   { flex: none; }
   .stage { flex: 1; position: relative; min-height: 0; }
   .stage svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
   ```
   plus a `@media (max-width: 880px)` fallback restoring scrolling and un-floating the cards. Without
   `min-height: 0` the flex child refuses to shrink and the SVG overflows the viewport.
6. **One inline `<svg viewBox="0 0 1560 980" preserveAspectRatio="xMidYMid meet">`**, no `width`/`height`, with
   `<title id="arch-title">` as first child and `aria-labelledby="arch-title"`.
7. **Two arrowhead markers**, `#a-mut` and `#a-clay`, identical but for fill. A marker doesn't inherit paint
   from the element referencing it, so a second marker is the only way to recolour an arrowhead for the lit
   state. Fills written `style="fill: var(--muted)"` — **`fill="var(--muted)"` does not resolve.**
8. **Nodes** are `<g class="node" data-k="…">` with one `<rect>`, a `.t` title, and 1–4 `.m` meta lines.
   Modifiers: `.gate` (authorisation choke point), `.store` (persistence), `.do` (stateful singleton), `.ext`
   (third party), `.new` (added or changed by this feature — existing-codebase scope only).
9. **Edges** are `<path class="edge" id="e-…">` cubic Béziers, with `.dash` for out-of-band and `.ws` for
   persistent connections. Labels `<text class="elbl" data-e="e-…">`, only for non-obvious protocols.
10. **Flow chips**: an "Everything" chip plus one per primary journey.
11. **`FLOWS`** — `{name, edges[], nodes[], steps[]}` per chip, 3–5 steps each, naming real endpoints from the
    spec. **`DETAIL`** — one `{t, m, b}` entry per `data-k`, `b` being 1–3 opinionated sentences. A detail card
    that restates the node's own label is wasted space.
12. **Cards**: `#detail` bottom-right (always visible, ships with a placeholder that teaches the page's
    affordances) and `#flowcap` bottom-left (hidden until a flow is selected). `aria-live="polite"` on both.
13. **Keyboard**: `tabindex="0" role="button"` on each `.node`, a `keydown` handler for Enter and Space, and
    `.node:focus-visible rect { stroke: var(--clay); stroke-width: 2 }`. `aria-pressed` on the chips, kept in
    sync inside `setFlow`.

---

## 3. The palette

| Var | Light | Dark |
|---|---|---|
| `--bg` | `#FAF9F5` | `#141413` |
| `--surface` | `#FFFFFF` | `#1F1F1D` |
| `--surface2` | `#F0EEE6` | `#2A2A28` |
| `--ink` | `#141413` | `#FAF9F5` |
| `--body` | `#3D3D3A` | `#D1CFC5` |
| `--muted` | `#87867F` | `#87867F` |
| `--line` | `#D1CFC5` | `#3D3D3A` |
| `--line-soft` | `#E6E3DA` | `#2A2A28` |
| `--clay` | `#D97757` | `#E48A6E` |
| `--clay-soft` | `rgba(217,119,87,0.10)` | `rgba(228,138,110,0.14)` |
| `--olive` | `#788C5D` | `#9DB07C` |
| `--olive-soft` | `rgba(120,140,93,0.12)` | `rgba(157,176,124,0.16)` |
| `--zone` | `rgba(20,20,19,0.025)` | `rgba(250,249,245,0.03)` |
| `--zone-line` | `#D1CFC5` | `#3D3D3A` |

Plus `--serif`, `--sans`, `--mono`.

Rules the table encodes: accents get **lighter** in dark, not darker (`#D97757` on `#141413` is too dim); tint
alphas rise, because tints wash out on dark; `--muted` is the one colour shared by both themes.

**Dark mode is mandatory here and forbidden in `spec.html`.** Never bring `--ivory`/`--gray-*` names into this
file, and never carry `html.dark`, `#themeToggle` or the `localStorage` script back into the spec.

---

## 4. SVG structure

`<title>` is the first child. After it, document order is load-bearing because SVG has no `z-index`:
**`<defs>` → zones → edges → edge labels → nodes**. Nodes last, so their fills paint over incoming edge tails.

**Zones** are `<g class="zone">` with a dashed rect and an uppercase mono title, grouping related nodes.

**Node geometry** — follow the exemplar's rhythm rather than a table of offsets: the title baseline sits a
little below the rect top, meta lines stack at an even interval under it, and text starts a consistent inset
from the rect's left edge. Widths come in two or three sizes so columns align; heights grow with the number of
meta lines. Keep ≥55 units of vertical gap between stacked siblings and ~25 units of padding inside a zone
rect. `rx` is set in **CSS** (`.node rect { rx: 10 }`), not as an attribute.

No layout engine catches overlapping rects, and nothing catches a node hidden behind the always-visible
`#detail` card in the bottom-right. Keep that corner clear.

---

## 5. Flows and detail

Flows are **data, not markup** — no per-flow SVG. The chip handler dims everything and lights the path:

```css
.stage.flowing .edge { opacity: 0.13; }
.stage.flowing .elbl { opacity: 0.13; }
.stage.flowing .node { opacity: 0.30; }
.stage.flowing .zone { opacity: 0.45; }
.stage.flowing .edge.lit {
  opacity: 1; stroke: var(--clay); marker-end: url(#a-clay);
  stroke-dasharray: 7 5; animation: march 0.9s linear infinite;
}
.stage.flowing .elbl.lit      { opacity: 1; fill: var(--clay); }
.stage.flowing .node.lit      { opacity: 1; }
.stage.flowing .node.lit rect { stroke: var(--clay); }
@keyframes march { to { stroke-dashoffset: -12; } }
@media (prefers-reduced-motion: reduce) { .stage.flowing .edge.lit { animation: none; } }
```

**The marching-ants invariant: the `stroke-dashoffset` delta must equal dash + gap** — here `7 + 5 = 12`. Any
other number visibly stutters. This applies to the `.lit` rule only; zone borders and `.edge.dash` use their
own values and are unrelated.

Copy `setFlow(key)` from the exemplar verbatim, and add the hash deep-link so `spec.html` can point at one
journey:

```js
function applyHash() { const k = location.hash.slice(1); setFlow(FLOWS[k] ? k : 'all'); }
applyHash();
window.addEventListener('hashchange', applyHash);
// inside setFlow, after the chip toggle:
history.replaceState(null, '', key === 'all' ? location.pathname : '#' + key);
```

Add a link back in the bar: `<a class="chip ghost" href="spec.html">&larr; Spec</a>`.

---

## 6. Sizing

One axis: how much system there is to draw.

| | Nodes | Zones | Journey chips (plus "Everything") |
|---|---|---|---|
| A feature, or a small system | 6–12 | 2–3 | 2–4 |
| A normal service | 14–20 | 3–5 | 4–6 |
| A large platform | 20–28 | 4–6 | 5–7 |

Above about 12 nodes in one visual cluster the diagram stops being readable — split across zones. Don't target
a line count; the file is as long as the system needs.

---

## 7. Failure checks

`scripts/check_spec.py` catches the mechanical ones — run it. These are the failure modes behind those checks,
plus the two a script can't see:

1. **Flow/markup desync — the number one defect.** `setFlow` uses `getElementById(id)?`, so a stale id lights
   nothing, silently, with no console error.
2. `fill="var(--clay)"` on a marker path renders black or nothing. Must be `style="fill: …"`.
3. Hard-coded hex inside the `<svg>` — the diagram stays light while the page goes dark.
4. Theme script after `<style>`, or deferred — the white flash returns.
5. `stroke-dashoffset` ≠ dash + gap on the `.lit` rule.
6. Missing `min-height: 0` on `.stage` — the SVG overflows the viewport.
7. Nodes drawn before edges — edge tails paint over node fills.
8. Palette bleed in either direction.
9. **Overlapping rects, or a node under the `#detail` card.** No script sees this. Open the file and look.
10. **Labels clipped by their node's rect.** Same — open it and look.
