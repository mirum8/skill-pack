# Writing `spec.html`

## Contents

1. The contract
2. Palette and type
3. Page shell
4. Which examples to open
5. The diagrams
6. Writing it without degrading

---

## 1. The contract

`docs/<topic>/spec.html` is a **self-contained, light-mode, static document**. Inline all CSS.
No external fonts, images or stylesheets. **No `<script>` at all** — not for a theme, not for
a toggle, not for anything. No `localStorage`, no dark-mode block.

It is one file. There is no companion page, no shared `style.css`, and nothing to cross-link
to. Everything the reader needs is in this document, and it must print.

That constraint is the point: a single file survives being emailed, dropped in a ticket,
opened from a USB stick two years later, and printed by someone who will annotate it in pen.

---

## 2. Palette and type

Put this on `:root` and drive everything, including the SVGs, from it.

```css
:root {
  --ivory:    #FAF9F5;   /* page background */
  --surface:  #FFFFFF;   /* cards, code blocks, diagram fills */
  --gray-150: #F0EEE6;   /* subtle fills, zone bands */
  --gray-300: #D1CFC5;   /* borders, diagram strokes */
  --gray-500: #87867F;   /* muted text, diagram edges */
  --gray-700: #3D3D3A;   /* body text */
  --slate:    #141413;   /* headings */
  --clay:     #D97757;   /* accent — pivotal events, the one highlighted path */
  --olive:    #788C5D;   /* positive / terminal-success states */
  --serif: ui-serif, Georgia, "Times New Roman", serif;
  --sans:  system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono:  ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
```

Body text in `--sans` on `--ivory`. Headings in `--serif` and `--slate`. Code, small labels,
state names and eyebrows in `--mono`. `--clay` is the single accent — used sparingly, or it
stops meaning anything.

---

## 3. Page shell

A scrolling document with a `max-width` reading measure, not a full-screen app. One
`<section>` per section, `<h2>`/`<h3>` headings, `<table>` for every matrix, `<pre><code>` for
request and response shapes.

Status ribbon in the header: title, status, owner, date, mode.

Give the risks table visual weight that matches its importance — it should look like it
matters, not like an appendix.

Under `--explain`, confidence tags (`[verified: …]`, `[unverified]`) get a small muted `.tag`
class in `--mono`, so they read as metadata rather than prose.

Two conventions worth holding, because they are what a reader scans for:

- **Entity names, state names, module names and API paths always in `--mono`**, everywhere
  they appear. The glossary's "maps to in code" column and the class names in the diagrams
  must match character for character.
- **Terminal states get `--olive` when they are a success and `--gray-500` when they are not.**
  A reader should be able to find the leaks — entities with no terminal state — by looking.
- **One `<h3>` per user story, and nothing else at that level inside that section.** The `<h3>`
  text *is* the story's handle: `scripts/check_spec.py` reads it, and `/r:spec-plan` carries it
  verbatim into every `Implements:` line. Sub-headings elsewhere in the document are fine; inside
  User stories an `<h3>` means "this is a story".

---

## 4. Which examples to open

Open **only** what you need. The gallery is 350 KB; scanning all of it is waste.

- `references/html-effectiveness/15-research-concept-explainer.html` and
  `14-research-feature-explainer.html` — prose-plus-structure explainers. This is the overall
  feel, and the closest match for an `--explain` run.
- `references/html-effectiveness/04-code-understanding.html` — architecture-and-flow write-ups.
- `references/html-effectiveness/13-flowchart-diagram.html` — static SVG conventions.
- `references/html-effectiveness/11-status-report.html` — dense tabular sections.
- `references/html-effectiveness/12-incident-report.html` — risk tables.

---

## 5. The diagrams

Static, inline `<svg>`, styled through CSS classes bound to the palette variables — never hex
scattered on individual shapes. Wrap each in `<figure class="svg-figure">` with a
`<figcaption>` that says what to notice, not what it is.

**Every run:**

- **Context / container** — what is inside the system, what is outside, what crosses the line.
  Boxes for modules, a dashed band for anything external, labelled arrows for what flows.
- **Entities and relationships** — one `<g>` per entity: a header rect with the name in
  `--mono`, then the two or three attributes that identify it. Relationship lines carry
  cardinality labels. **No column types** — this is a domain diagram, not a schema.
- **One primary sequence** — vertical lanes per actor or module with a dashed lifeline,
  horizontal labelled arrows, 6–10 steps. Draw the flow that best repays being drawn, usually
  the one with a failure branch. The other flows are step lists in prose.

**Under `--explain`, add:**

- **The event timeline** — a horizontal spine of past-tense events. Mark ★ pivotal events in
  `--clay`, hang unhappy endings below the spine as short branches, and show waiting points as
  a gap with a label saying what is being waited on. This is the single most useful picture in
  a domain document: it is where the module boundaries come from.
- **Entity lifecycles** — a small state diagram per core entity. Terminal states get a double
  border. Two or three of these; the rest as `a → b → c` lines in prose.

**Shared rules.** Use `viewBox` so the diagram scales, with no fixed `width`/`height` on the
`<svg>`. Define arrowhead markers once per `<svg>` in its own `<defs>` — ids do not reliably
resolve across separate inline SVGs. Label text at 13–14 units minimum. Fills from
`--surface`/`--gray-150`, strokes from `--gray-300`/`--gray-500`, one accent from `--clay`.

Omit any diagram whose subject doesn't exist. An empty box is worse than no diagram. Three
figures is a normal document; six is a lot for any.

---

## 6. Writing it without degrading

An `--explain` document runs long, and a single `Write` at that size loses quality toward the
end — the confidence tags and the `--mono` naming convention are the first things to go.

Write the shell plus the first three sections with `Write`, then append section by section
with `Edit`. Keep the section plan in front of you so the order doesn't drift, and re-read the
tagging rule in `research.md` §3 before writing any section that names a third-party product.

`scripts/check_spec.py` catches what degrades silently — an unversioned technology, a story
with no acceptance criteria, a dropped tag — so run it before showing the document, not after
the user finds the gap.
