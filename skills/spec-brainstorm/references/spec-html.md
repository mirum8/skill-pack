# Writing `spec.html`

## Contents

1. The contract
2. Palette and type
3. Page shell
4. Which examples to open
5. Diagrams that live here
6. Cross-links
7. Writing it without degrading

---

## 1. The contract

`docs/<topic>/spec.html` is a **self-contained, light-mode, static document**. Inline all CSS. No external
fonts, images or stylesheets. **No `<script>` at all** — not for a theme, not for a toggle, not for anything.
No `html.dark`, no `localStorage`.

Interactivity lives in `architecture.html`. This file is the readable document, and it must print.

Self-containment is **per file**. Never factor a shared `docs/<topic>/style.css` — that silently breaks the
standalone promise for both files. Each inlines its own stylesheet; the palette is copy-pasted, not linked.

---

## 2. Palette and type

Put this on `:root` and drive everything, including the SVGs, from it.

```css
:root {
  --ivory:    #FAF9F5;   /* page background */
  --surface:  #FFFFFF;   /* cards, code blocks, diagram fills */
  --gray-150: #F0EEE6;   /* subtle fills */
  --gray-300: #D1CFC5;   /* borders */
  --gray-500: #87867F;   /* muted text, diagram edges */
  --gray-700: #3D3D3A;   /* body text */
  --slate:    #141413;   /* headings */
  --clay:     #D97757;   /* accent */
  --olive:    #788C5D;   /* positive */
  --serif: ui-serif, Georgia, "Times New Roman", serif;
  --sans:  system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono:  ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
```

Body text in `--sans` on `--ivory`. Headings in `--serif` and `--slate`. Code, small labels and eyebrows in
`--mono`. `--clay` is the single accent — used sparingly, or it stops meaning anything.

---

## 3. Page shell

A scrolling document with a `max-width` reading measure, not a full-screen app. One `<section>` per spec
section, `<h2>`/`<h3>` headings, `<table>` for interfaces and every other matrix, `<pre><code>` for payload
shapes.

Status ribbon in the header: title, status, owner, date, depth, cross-links.

Give the risk and decision tables visual weight that matches their importance — Recommendations & risks sits
second and should look like it matters, not like an appendix.

Confidence tags (`[verified: …]`, `[unverified]`) get a small muted `.tag` class in `--mono`, so they read as
metadata rather than prose. The candidates table's `Confidence` column uses the same class.

---

## 4. Which examples to open

Open **only** what you need. The gallery is 350 KB; scanning all of it is waste.

- `references/html-effectiveness/14-research-feature-explainer.html` and `15-research-concept-explainer.html` —
  prose-plus-structure explainers. This is the overall feel.
- `references/html-effectiveness/04-code-understanding.html` — architecture-and-flow write-ups.
- `references/html-effectiveness/11-status-report.html` — dense tabular sections.
- `references/html-effectiveness/12-incident-report.html` — risk and decision tables.
- `references/html-effectiveness/13-flowchart-diagram.html` — static SVG conventions.

---

## 5. Diagrams that live here

Static, inline `<svg>`, styled through CSS classes bound to the palette variables — never hex scattered on
individual shapes. Wrap each in `<figure class="svg-figure">` with a `<figcaption>`.

Which diagrams belong in this file:

- **Context / container** — printable, sits next to the prose.
- **Entity relationship** — one `<g>` per entity: a header rect with the name, then stacked `name : type` rows,
  foreign keys explicit (`user_id : uuid (FK)`). Relationship lines carry cardinality labels.
- **One primary sequence** — vertical lanes per actor with a dashed lifeline, horizontal labelled arrows, 6–10
  steps. The other flows are step lists in prose; drawing all of them is not worth the tokens.

**Deployment topology and the explorable system diagram live only in `architecture.html`.** Drawing the same
architecture in both files guarantees they drift.

Shared rules: use `viewBox` so the diagram scales, no fixed `width`/`height` on the `<svg>`; define arrowhead
markers once per `<svg>` in its own `<defs>` (ids do not reliably resolve across separate inline SVGs); label
text at 13–14 units minimum; fills from `--surface`/`--gray-150`, strokes from `--gray-300`/`--gray-500`, one
accent from `--clay`.

Omit any diagram whose subject doesn't exist. An empty box is worse than no diagram. Two figures is a normal
small spec; four is a lot for any spec.

---

## 6. Cross-links

Bare relative filenames — `href="architecture.html"`, never `./`, `../`, or an absolute path. The files are
siblings.

Link the diagram twice, so it's reachable without scrolling *and* in context: once in the header meta line
under the title, once in the architecture figcaption ("open the interactive version →"). Style the links with
one `.xlink` class — `--clay` text, a `--gray-300` bottom border that turns `--clay` on hover.

In the runtime-flows section, deep-link individual journeys:
`<a class="xlink" href="architecture.html#checkout">watch this path light up &rarr;</a>`. Only link flow keys
that exist in that file's `FLOWS` object.

Do not link `todo.md`. That file is written later by `/r:spec-plan`, and shipping a deliverable with a link
to a file that doesn't exist yet is worse than shipping no link.

---

## 7. Writing it without degrading

An enterprise `spec.html` runs to a couple of thousand lines, and a single `Write` at that size loses quality
toward the end — the honesty tags are the first thing to go.

Write the shell plus the first four sections with `Write`, then append section by section with `Edit`. Keep the
section plan in front of you so the order doesn't drift, and re-read the tagging rule before writing any
section that cites a third-party product.

The tags are the first thing to go because they are a convention rather than a slot. Where a section can carry
them as a **column** instead — the candidates table does, `spec-sections.md` §8 — use the column; it fails
loudly and empty, where a dropped convention fails silently. `scripts/check_spec.py` counts the tags, so a
section that quietly stopped carrying them is caught at step 4 rather than by a reader six months later.
