# Writing `spec.html`

## Contents

1. The contract
2. Palette and type
3. Page shell — parts, sections and ids
4. Navigation — the map at the top
5. Which examples to open
6. The diagrams
7. Writing it without degrading

---

## 1. The contract

`docs/<topic>/spec.html` is a **self-contained, light-mode, static document**. Inline all CSS.
No external fonts, images or stylesheets. **No `<script>` at all** — not for a theme, not for
a toggle, not for anything. No `localStorage`, no dark-mode block.

It is one file — no companion page, no shared `style.css`, no second document to link to.
Every `href` in it is an external `https:` URL or an in-page `#anchor`. A single file survives
being emailed, dropped in a ticket, opened from a USB stick two years later, and printed by
someone who will annotate it in pen.

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
  --clay:     #D97757;   /* accent — part numbers, pivotal events, the one highlighted path */
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

## 3. Page shell — parts, sections and ids

Two columns: a sticky contents sidebar and one column of text at a `max-width` reading measure.
The shell is a grid, and the header spans both columns:

```css
.wrap    { max-width: 70rem; margin: 0 auto; padding: 0 2rem;
           display: grid; grid-template-columns: 15rem minmax(0, 1fr); gap: 3.5rem; }
header   { grid-column: 1 / -1; }
```

Nothing else about the page is a layout — it is a document that scrolls, not an application.

**Three heading levels, and each one means exactly one thing:**

| Element | Is | Count |
|---|---|---|
| `<h1>` | the document title | 1 |
| `<h2 class="part" id="p3">` | a **part** — one of the seven in `sections.md` §1 | 7 |
| `<h2 id="characteristics-driving">` | a **section** inside the current part | as many as have something to say |
| `<h3>` | a user story, or an ADR | — |

`<h3>` carries two contracts and no others. Inside the **User stories** section it is a story
name — one per story, nothing else at that level, because `scripts/check_spec.py` and
`/r:spec-design` both read that text verbatim as the story's handle. Inside **Part 6** it is
`ADR-<n> — <title>`. Sub-headings anywhere else are `<h4>`.

**Every `<h2>` carries an `id`**, part or section, and every id is kebab-case and stable across
a `--continue`. A renamed id breaks every anchor pointing at it, and this document's only links
are anchors.

### The part header

A part is a divider the eye can find while scrolling, not another heading:

```html
<h2 class="part" id="p3"><span class="pnum">Part 3</span> Architectural characteristics</h2>
<p class="lede">Three numbers the whole design is being traded against, and the four things
we are deliberately spending to get them. Everything below this point is checkable against
this part.</p>
```

Give `.part` a rule above it and clearly more weight than a section heading — a reader
scrolling fast should count seven of them. `.pnum` is `--mono` and `--clay`.

Every part's lede is `<p class="lede">` immediately after its `<h2 class="part">`.

### Two conventions a reader scans for

- **Entity names, state names, component names and API paths always in `--mono`**, everywhere
  they appear. The glossary's "maps to in code" column, the `Owns` column in Part 4 and the
  class names in the diagrams must match character for character.
- **Terminal states get `--olive` when they are a success and `--gray-500` when they are not.**
  A reader should be able to find the leaks — entities with no terminal state — by looking.

Under `--explain`, confidence tags (`[verified: …]`, `[unverified]`) get a small muted `.tag`
class in `--mono`, so they read as metadata rather than prose.

### The tables that carry markup contracts

Three tables have classes the checker reads — cheap to write, and what turns a prose rule into
something a script can hold:

- **Part 3, driving characteristics** — `<tr class="driving">` on each driving row. The checker
  counts them and reports more than three.
- **Part 4, components** — a header cell whose text contains `Owns`. The checker collects the
  `<code>` entity names in that column and reports any entity owned by two components.
- **Part 7, technologies** — nothing special, but the last cell is either one clause or a single
  `<a href="#adr-4">ADR-4</a>`, never both.

### ADR cards

Give Part 6's `<h3>` blocks a card treatment — a left border in `--clay`, the six field labels
in `--mono` and small — so an ADR reads as a unit rather than as six loose paragraphs. The `id`
is `adr-<n>`, lowercase, so `<a href="#adr-4">ADR-4</a>` resolves from anywhere in the document.

The risks table gets visual weight that matches its importance — it should look like it matters,
not like an appendix.

---

## 4. Navigation — the sidebar and the glance card

A specification runs to several thousand words and is read by people looking for one thing.
Two cheap elements do almost all of that work.

### The contents sidebar

**One list, in `<nav class="sidenav">`, and it is the document's only contents list.** Two levels:
the seven parts, each with its surviving sections nested under it, every entry an `<a href="#…">`.
Keep the `class="toc"` on the list itself — `scripts/check_spec.py` reads it, and it reports a
missing sidebar, an entry that is not a link, and any `#anchor` resolving to no `id`.

```css
.sidenav      { position: sticky; top: 0; align-self: start;
                max-height: 100vh; overflow-y: auto; padding: 2rem 0; font-size: 13px; }
.sidenav ol   { list-style: none; margin: 0; padding: 0; }
.sidenav a    { display: block; padding: .18rem 0; text-decoration: none; line-height: 1.35; }
.sidenav a:hover      { color: var(--clay); }
.sidenav li.p         { margin-top: .9rem; }
.sidenav li.p > a     { font-family: var(--mono); font-size: 11px; letter-spacing: .04em;
                        text-transform: uppercase; color: var(--slate); }
.sidenav li.s a       { color: var(--gray-500); padding-left: .9rem; }

@media (max-width: 900px) {
  .wrap    { display: block; }
  .sidenav { position: static; max-height: none; overflow: visible;
             border-bottom: 1px solid var(--gray-300); margin-bottom: 2rem; }
}
@media print {
  .wrap    { display: block; }
  .sidenav { position: static; max-height: none; overflow: visible; break-after: page; }
  .sidenav a { color: var(--gray-700); }
}
```

Those two media blocks are what let the sidebar exist at all. Un-stuck, the same markup is a
contents page on paper and a contents block on a phone — one list in the file, correct in every
medium, nothing to drift out of sync. A sidebar fixed in print, or a narrow column on a 400px
screen, costs the document the property it was built for: surviving being emailed, printed and
annotated in pen.

**There is no active-section highlight.** Scroll-spy needs a script and this document has none;
faking it with `:target` marks only the section last clicked, which goes stale the moment the
reader scrolls. What `:target` *is* worth is one line of arrival feedback —
`section:target > h2 { color: var(--clay); }` — so a click visibly lands.

### At a glance

A card at the top of the content column, directly under the status ribbon. Six lines, no prose:

```html
<dl class="glance">
  <dt>What it is</dt><dd>A terminal Kubernetes client — Lens's layout, k9s's speed.</dd>
  <dt>Driving characteristics</dt><dd>startup under 1 s · repaint under 16 ms · runs over SSH</dd>
  <dt>Style</dt><dd>Client with a local cache — one static binary, no server side</dd>
  <dt>Components</dt><dd>6 — <code>Kubeconfig</code>, <code>Cache</code>, <code>Watch</code>, …</dd>
  <dt>Stack</dt><dd>Go 1.23 · client-go 0.31 · Bubble Tea 1.1</dd>
  <dt>v1</dt><dd>9 of 16 stories; port-forwarding and usage charts deferred</dd>
</dl>
```

Someone who reads only this card and the seven part ledes should be able to describe the system
correctly. That is the test for both.

Nothing else is navigation. No sticky header, no back-to-top links, no breadcrumb — the sidebar
already answers "where am I and what else is there", and each of those costs print fidelity.

---

## 5. Which examples to open

Open **only** what you need. The gallery is 350 KB; scanning all of it is waste.

- `references/html-effectiveness/15-research-concept-explainer.html` and
  `14-research-feature-explainer.html` — prose-plus-structure explainers. This is the overall
  feel, and the closest match for an `--explain` run.
- `references/html-effectiveness/04-code-understanding.html` — architecture-and-flow write-ups.
- `references/html-effectiveness/13-flowchart-diagram.html` — static SVG conventions.
- `references/html-effectiveness/11-status-report.html` — dense tabular sections.
- `references/html-effectiveness/12-incident-report.html` — risk tables.

---

## 6. The diagrams

Static, inline `<svg>`, styled through CSS classes bound to the palette variables — never hex
scattered on individual shapes. Wrap each in `<figure class="svg-figure">` with a
`<figcaption>` that says what to notice, not what it is.

Each diagram belongs to exactly one part, and the part decides what may appear in it. Drawing
the same thing twice at two altitudes is the most expensive mistake here.

**Every run:**

- **Entities and relationships** — *Part 2.* One `<g>` per entity: a header rect with the name in
  `--mono`, then the two or three attributes that identify it. Relationship lines carry
  cardinality labels. **No column types** — this is a domain diagram, not a schema.
- **One primary sequence** — *Part 2, with the key flows.* Vertical lanes per **actor or domain
  step** with a dashed lifeline, horizontal labelled arrows, 6–10 steps. Draw the flow that best
  repays it, usually the one with a failure branch. The other flows are step lists in prose.
- **Components** — *Part 4.* A box per component with the entities it owns listed inside it, and
  arrows for what calls what. No processes, containers or network — this picture is true
  whatever the deployment turns out to be.
- **Context / container** — *Part 5.* What is inside the system, what is outside, what crosses
  the line. Boxes for deployables, a dashed band for anything external, labelled arrows for what
  flows. This is where the network appears.

**Under `--explain`, add:**

- **The event timeline** — *Part 2.* A horizontal spine of past-tense events. Mark ★ pivotal
  events in `--clay`, hang unhappy endings below the spine as short branches, and show waiting
  points as a gap labelled with what is being waited on. The single most useful picture in a
  domain document: it is where Part 4's component boundaries come from.
- **Entity lifecycles** — *Part 2.* A small state diagram per core entity. Terminal states get a
  double border. Two or three of these; the rest as `a → b → c` lines in prose.

**Shared rules.** Use `viewBox` so the diagram scales, with no fixed `width`/`height` on the
`<svg>`. Define arrowhead markers once per `<svg>` in its own `<defs>` — ids do not reliably
resolve across separate inline SVGs. Label text at 13–14 units minimum. Fills from
`--surface`/`--gray-150`, strokes from `--gray-300`/`--gray-500`, one accent from `--clay`.

Omit any diagram whose subject doesn't exist — a single-binary tool with no external systems has
no context diagram worth drawing, and an empty box is worse than none. Four figures is a normal
document; seven is a lot for any.

---

## 7. Writing it without degrading

The document runs long, and a single `Write` at that size loses quality toward the end — the
confidence tags, the `--mono` naming convention and the `id` attributes go first.

**Write it part by part.** Start with `Write` for the shell and its CSS, the header, the
At-a-glance card, a sidebar carrying the seven part links, and Part 1. Then append one part at a
time with `Edit`. Two things are written **last**, when the parts they describe exist and cannot
drift from them:

1. **The section links nested under each part** in the sidebar — you now know which sections
   survived, and a link to a section you cut is a dead anchor.
2. **The seven part ledes** — written from what each part says, then read alone as a summary of
   the document.

Keep the part-and-section plan in front of you so the order doesn't drift, and re-read the
tagging rule in `research.md` §3 before writing any section that names a third-party product.

`scripts/check_spec.py` catches what degrades silently — a missing part, a missing sidebar, a
dead anchor, an unversioned technology, a story with no acceptance criteria, an ADR referenced but
never written — so run it before showing the document, not after the user finds the gap.
