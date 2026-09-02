# The report — what it is, what goes in it, and what stays out

Read this before writing anything. `SKILL.md` carries the steps; this file carries the document.

## Contents

1. The file, and where the HTML contract comes from
2. The register — concise but comprehensive
3. The sections
4. The diagrams
5. The snippets
6. What stays out
7. Degradations, and how each is named

---

## 1. The file, and where the HTML contract comes from

```
docs/<topic>/reports/milestone-<N>-<slug>.html
```

Beside the plan's own `todo.md` and `design.md`, in a `reports/` directory the skill creates. `<N>`
is the milestone's number and `<slug>` its kebab-cased name — both from `milestone_scope.py`, never
retyped, so a re-run updates the report it wrote last time instead of minting a second one beside
it.

**The page shell is not designed here.** Read
`${CLAUDE_PLUGIN_ROOT}/skills/spec-brainstorm/references/html.md` and take four things from it
verbatim:

- **§1 The contract** — one self-contained, light-mode, static file. Inline all CSS. No external
  fonts, images or stylesheets. **No `<script>` at all.** One file survives being emailed, dropped
  in a ticket, opened from a USB stick two years later, and printed.
- **§2 Palette and type** — the exact `:root` block. Everything, the SVGs included, is driven from
  those variables.
- **§3 Page shell** — the sticky contents sidebar and the single reading-measure column.
- **§6's shared mechanics paragraph** — `viewBox` with no fixed `width`/`height`, arrowhead markers
  defined once per `<svg>` in its own `<defs>` (ids do not reliably resolve across separate inline
  SVGs), label text at 13–14 units minimum, fills from the palette variables rather than hex
  scattered on shapes.

**Take nothing else from it.** §5's example list and §6's *catalogue* of which diagram belongs to
which part describe a seven-part specification of a system that does not exist yet. This document
is the opposite: a short report on code that does. A writer who reads that catalogue draws a spec's
four figures — context, container, ER, component — for a milestone that added one endpoint.
Section 4 below is this document's catalogue.

Of the vendored gallery, `11-status-report.html`, `17-pr-writeup.html` and
`04-code-understanding.html` are the three worth opening, and `13-flowchart-diagram.html` for the
SVG conventions. Open only what you need; the gallery is 350 KB.

---

## 2. The register — concise but comprehensive

These pull against each other, and holding both is the whole difficulty of the document.

**Comprehensive means no decision is missing.** Every choice the milestone made that a reader would
otherwise have to reconstruct from the diff is in here: why the boundary fell where it did, why the
column is nullable, why the retry is at the caller and not the service. Dropping one to keep the
page short is the failure this document exists to prevent — the reconstruction cost lands on
whoever opens the code next, and by then nobody remembers.

**Concise means each is said once, in as few words as it takes to be unambiguous.** Not summarised
into vagueness — *shortened*. "Amounts are minor units so no float ever reaches the ledger" is one
sentence and complete; three paragraphs building to it are the same sentence with a runway.

Two rules that make the difference operational:

- **Prose must say something its diagram and its snippet cannot.** A paragraph that narrates the
  code beneath it is cut. A paragraph that restates its own heading is cut. What survives is the
  part a reader could not have got from looking: the reason, the alternative rejected, the
  constraint that forced it.
- **A reader who was not here finishes it in one sitting and can then say why the code is shaped
  this way.** That is the test. Both failure modes fail it — a summary so short a decision is
  missing, and a walkthrough so long nobody reaches the end.

The self-check in Step 5 makes this mechanical: name the decision each section carries. A section
that cannot name one is not short enough, it is empty.

---

## 3. The sections

Six, in this order. A section with nothing true to say is **omitted**, not padded — except
*What is not done yet*, which prints "nothing" rather than vanishing, since its absence and its
emptiness read identically and only one of them is information.

### Header

Milestone number and name, the plan it came from, the phases it contains with their numbers and
titles, and the date. When any phase's landing commit did not resolve, say so here — the report's
own coverage belongs at the top, not in a footnote.

### 1 · What this milestone delivers

What the product can do now that it could not before, in the user's terms rather than the code's.
Two to five sentences. The plan's `Implements:` lines are the raw material; the section is not a
list of them.

### 2 · The design as built

The load-bearing section, and the reason the report is worth writing.

`design.md`'s contracts are the **claim** — schema, endpoints, types, boundaries, written before
any code existed. The code is the **fact**. This section reports the fact, and **names every place
the two diverge**: the column that ended up nullable, the endpoint that returned 409 instead of
400, the module boundary that moved.

A divergence is not a defect to apologise for — it is what the milestone learned. But a report that
silently prints `design.md`'s version is worse than no report at all, because it is the document a
reader will trust over the code. Where the plan carried no contracts (a `--shallow` plan has no
`design.md`), say the design is reported from the code alone and there was nothing to compare it
against.

### 3 · How it fits together

The diagrams, with a `<figcaption>` on each saying what to notice — not what it is. Section 4.

### 4 · The code that carries it

The snippets. Section 5.

### 5 · What changed from the plan

Only what a reader needs to trust the plan going forward: phases whose `Files:` line was rewritten
to something materially wider than it declared, an item ticked with a caveat, a `Done when:` that
was skipped as prose. Where nothing moved, omit the section.

### 6 · What is not done yet

Known gaps this milestone leaves for a later one, and the phases in *this* milestone that landed
partially. Prints "nothing" when there is nothing.

---

## 4. The diagrams

**Two to four.** Fewer than two and the report is prose that could have been an email; more than
four and they stop being read. Draw only the ones whose subject exists in this milestone — an empty
box is worse than no diagram.

| draw | when this milestone | shows |
|---|---|---|
| **The component cut** | added or moved a module, service or boundary | the pieces it introduced, what each owns, and the arrows between them — **only** the ones this milestone touched, greyed context around them |
| **One primary flow** | added a request path, a job or a protocol | a sequence with the real names from the code, including the failure branch that matters |
| **The data-model delta** | touched persistence | the tables and columns it added, with types and indexes; existing tables greyed, so what is new reads at a glance |
| **A lifecycle** | introduced states an entity moves through | the states and transitions, terminal states marked |

Every diagram uses names taken **character for character** from the code — a box labelled with a
class that does not exist is a diagram that will be trusted and is wrong. Where the milestone is
one endpoint and one table, two figures is the honest number.

---

## 5. The snippets

**Cited, verbatim, and short.**

- Every snippet carries `path:LINE` and is **copied from the file**, never retyped from memory.
  A near-miss reproduction is the one error in this document nobody catches by reading it.
- **6–12 lines.** A snippet that needs a scrollbar is an architecture problem being smuggled in as
  an excerpt — if the interesting part is that long, the interesting part is the shape, and it
  belongs in a diagram.
- **Three to six for a milestone.** They are the *decisions*, not a tour: the invariant that is
  enforced in one place, the boundary that is held, the failure path that is handled. The CRUD
  around them is not a snippet.
- **Each one is introduced by what to look at** — one line above it, saying what the reader should
  see and why it is that way. A snippet with no such line is decoration.
- A citation that no longer resolves — the file moved, the symbol went — is **dropped and named**
  in the coverage line, never quietly replaced with a guess.

---

## 6. What stays out

Each of these is a real temptation, and each makes the document longer and less used:

- **The plan's checklists repeated back.** They are in `todo.md`, ticked, and this report is not a
  second copy of them.
- **Per-phase narration.** "Phase 4 then added…" turns the report into the git log with worse
  formatting. The milestone is the unit; the phases are how it was built, not what it is.
- **Anything `git log` already says** — commit messages, branch names, who did what when.
- **Test counts and coverage numbers.** They belong to the review, which already recorded them.
- **Praise.** "A clean, well-structured implementation" tells the reader nothing they can act on.

---

## 7. Degradations, and how each is named

Every one of these is written into the document, not just said in the terminal — the report is what
survives the session.

| what is missing | the report says |
|---|---|
| a phase's landing commit did not resolve | that phase's changes are described from the plan and the current tree, not from its diff — named in the header's coverage line |
| the plan has no `design.md` | the design is reported from the code alone; there was no contract to compare it against |
| `--partial` over an unfinished milestone | which phases are covered and which are not, at the top, in the document itself |
| a snippet's citation no longer resolves | the snippet is dropped, and the coverage line names it |

A degradation that appears only in the terminal is a degradation the reader of the file never learns
about, and this file outlives the terminal by design.
