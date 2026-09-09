---
description: >-
  Propose three candidate visual identities as real `DESIGN.md` files in the
  google-labs-code/design.md token format, lint each with the REAL CLI, render each from its own
  exported tokens into a local comparison page, and land the pick as the project's root
  `DESIGN.md`. Covers a web GUI and a terminal UI: on a TUI, typography and corner-rounding are
  declared omitted (the terminal owns the font; cells have no radius), spacing is in cells, and a
  required 16/256/truecolor depth quantizes the mock so it never shows a palette the terminal
  cannot paint. Use on "/r:ui-prototype", "give me some visual directions to choose from", "propose
  a few looks for this UI", "I need a DESIGN.md", or when someone wants token candidates to compare
  before committing to one, on either surface. Writes `docs/design/variants/compare.html` and
  nothing leaves the machine; `--share` additionally publishes that same page as a private Artifact
  and republishes in place rather than minting a second link. A candidate that does not lint clean
  is never shown, and the pick is certified with a REAL render — never an HTML mock standing in for
  one. NOT for the product spec (`/r:spec-brainstorm`), the build plan (`/r:spec-design`), or
  scaffolding a project's `/test-app` (`/r:test-app-create`).
disable-model-invocation: true
---

# UI prototype — candidate identities, rendered and picked

Three candidate `DESIGN.md` files, each rendered from its own tokens so the choice is informed,
then one of them lands at the repo root. The deliverable is a **linted document**, not a picture:
the picture exists so a person can choose, and is thrown away.

**Not automatic.** This skill writes a root `DESIGN.md` and a directory of rejected candidates, and
neither is something anyone wants arrived at by inference. Invoke it deliberately or not at all.

## Three documents that look alike and share nothing

A project can hold all three at once, and confusing them is the failure this skill is most likely
to cause:

| file | authoritative for | written by |
|---|---|---|
| root `DESIGN.md` | the **visual identity** — colour, type, spacing, component state | this skill |
| `docs/<topic>/tech-design.md` | the **build contracts** — schema, endpoints, types, boundaries | `/r:spec-design` |
| `ui-design.md` | a project's own design-system write-up, where it keeps one | the project |

Never merge them, and never cite one as evidence about another. `/r:spec-design` Step 1 reads a
root `DESIGN.md` as a **requirements document** for projects that keep one; a token file is not
that, and it says so.

## Step 0 — the surface, and what already exists

**Decide `web` or `tui` before anything else.** The discriminator is whether the program takes over
the terminal — an alternate-screen switch (`?1049h`), `EnterAlternateScreen`, `curses.wrapper(`,
`full_screen=True`, `tea.WithAltScreen()` — at the **call site**, never a dependency in the
manifest. `ratatui` sits in dev-dependencies, `rich` prints coloured tables from a plain CLI, and
`prompt_toolkit`'s default `PromptSession` is a readline replacement. The full probe ladder is
`${CLAUDE_PLUGIN_ROOT}/skills/test-app-create/references/detection-guide.md` Stage B — read it
there rather than copying it here, so the two cannot drift.

A **command-line tool with no full-screen UI has no visual identity to design.** Say so and stop;
there is nothing here for it.

**Then look for tokens that already exist.** CSS custom properties at the top of a stylesheet, a
`theme.*` file, a Tailwind config, an existing `ui-design.md`. If you find them, **one of the three
candidates is what the project already has, made explicit** — often the right answer, and never the
one a generator proposes unprompted.

**Read the spec if there is one.** `docs/<topic>/spec.html` carries the audience and the
architectural characteristics, which is the same material the Overview section wants. Derive it
from there rather than re-asking: two interviews produce two answers to one question and nothing
reconciles them.

## Step 1 — direction

A short interview — product, audience, mood, hard brand constraints, any reference. Questions and
their order: `references/interview-questions.md`. **Short is the point.** This is not
`/r:spec-brainstorm`, and it must never grow toward it.

## Step 2 — write three candidates

One directory each under `docs/design/variants/`, each holding a full `DESIGN.md`. Section order is
fixed: Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components, Do's and
Don'ts. At minimum a `primary` colour must exist. Frontmatter schema, token paths, `{path.to.token}`
references and Dimension syntax: `references/format-spec.md`.

**Make them genuinely different.** Three variations on one hue is not a choice. Vary the thing the
Overview section is about — the register — and let colour follow from it.

On a **terminal** surface, read `references/tui-mapping.md` first: `omitted:` for typography and
rounding with real reasons, spacing in cells, and a required `terminal.colorDepth`.

## Step 3 — lint every candidate with the real CLI

```bash
"${CLAUDE_SKILL_DIR}/scripts/designmd.sh" lint docs/design/variants/<name>/DESIGN.md --format json
```

**A candidate with lint errors is never shown.** Fix it or replace it. Warnings are surfaced with
the candidate rather than hidden — a contrast warning is exactly what a person choosing a palette
needs to see.

The wrapper's exit codes are its contract: `0` ran clean · `1` the file has errors · `2` unreadable
· `4` the CLI could not run, with `DESIGNMD SKIPPED:` as the first stdout line · `64` usage ·
anything else is the wrapper itself failing, and its stdout is not a report.

**Exit 4 is a named skip, and it does not stop the run** — write the documents anyway. But report
every one of them as **UNLINTED**, say why, and never call one clean. Nothing checked them. Do not
substitute your own read of the tokens for the linter's: it computes WCAG contrast ratios, and you
cannot.

## Step 4 — render each candidate from its own tokens

```bash
"${CLAUDE_SKILL_DIR}/scripts/designmd.sh" export docs/design/variants/<name>/DESIGN.md \
    --format css-vars > docs/design/variants/<name>/vars.css

python3 "${CLAUDE_SKILL_DIR}/scripts/build-compare.py" \
    --out docs/design/variants/compare.html --surface web|tui [--depth 16|256|truecolor] \
    --variant "<Name>=docs/design/variants/<name>/vars.css"   # once per candidate
```

**The CSS is generated, never hand-written.** That is what makes the page and the documents unable
to disagree — one is produced from the other. A mock you style by hand drifts from the tokens the
moment either is edited, and nothing downstream re-reads the page to catch it.

Both surfaces render as HTML here: a terminal frame is a grid of styled cells in a `<pre>`, so
**choosing** needs no tmux and no browser. On a terminal surface pass `--depth` matching the
document's `terminal.colorDepth` — the script quantizes to it, because a truecolor palette the
linter certified at 4.5:1 is painted as the nearest of 16 on a terminal that lacks the depth.

## Step 5 — present the comparison

Give the path. `docs/design/variants/compare.html` opens from `file://` with no network, and
nothing has left the machine.

**`--share`** publishes that same file as a private Artifact and hands back the URL. Three rules:
the page is built once and published as-is, never regenerated for the shared path; the id lives in
the page's own `<!-- ui-prototype:share id=… -->` marker, so a later `--share` updates that Artifact
instead of minting a second link; and **the flag is the consent** — state as a fact, in one line
before publishing, that the content is going to claude.ai, then publish. Do not ask a question the
user already answered by typing the flag.

Bare `/r:ui-prototype --share` with a `compare.html` already on disk republishes it and skips Steps
0–4.

Then **ask which one**, and take a blend as a fourth candidate through the same gate rather than
hand-merging two winners.

## Step 6 — land the pick

Copy the winner to the repo root as `DESIGN.md` and lint it once more. Leave the losers in
`docs/design/variants/` — they are the record of what was turned down. Then:

```bash
"${CLAUDE_SKILL_DIR}/scripts/designmd.sh" diff DESIGN.md docs/design/variants/<runner-up>/DESIGN.md
```

and report that delta. A decision recorded as a difference outlives one recorded as a preference.

## Step 7 — certify the pick with a REAL render

The HTML comparison decided the direction. **It cannot certify it** — it is a simulation, and it
looks right whether or not the real thing does.

- **web** — the `agent-browser` skill against the running app or a static render of the page, at
  three viewports.
- **tui** — the real terminal, at three geometries:

  ```bash
  H=$("${CLAUDE_PLUGIN_ROOT}/skills/test-app-create/scripts/tui-session.sh" start --geometry 120x40 -- <cmd>)
  "${CLAUDE_PLUGIN_ROOT}/skills/test-app-create/scripts/tui-session.sh" capture "$H" --ansi
  "${CLAUDE_PLUGIN_ROOT}/skills/test-app-create/scripts/tui-session.sh" resize "$H" 80x24
  "${CLAUDE_PLUGIN_ROOT}/skills/test-app-create/scripts/tui-session.sh" stop "$H"
  ```

  Exit `5` (empty capture) and exit `7` (geometry not applied) **fail the certification**. An empty
  frame reads as a clean screen and one geometry measured three times reads as a passing sweep.
  Exit `127` is tmux missing: record it as not run, and name it.

**A pick with nothing to render against yet** — a greenfield project with no app — is reported as
**uncertified**, which is honest and expected. What must never happen is the comparison mock being
described as the certifying render.

## What this skill does not do

- **No product decisions.** `/r:spec-brainstorm` decides what to build; this decides what it looks
  like, and reads that spec rather than replacing it.
- **No test skill, no deploys.** It borrows `/r:test-app-create`'s detection guide and terminal
  driver as instruments and generates nothing of theirs.
- **No canvas.** The bundled `design` skill drafts multi-artboard `.dc.html` canvases with a visual
  editor. This emits a linted token document and a static page; `--share` publishes a plain page,
  not a canvas.
- **Not the user's separate ui-design-doc skill**, which documents a design system that already
  exists in code. This proposes one before the code does — opposite directions.
- **It never writes application code**, never restyles existing components and never edits the
  project's CSS. Building against the document is `/r:task-run`'s job.

## Record the run

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:ui-prototype","outcome":"picked|unlinted|uncertified|skipped|blocked",
 "surface":"web|tui","candidates":3,"linted":true,"certified":true,"shared":false}
STATS_JSON
```

`outcome` is what makes the store readable later: a run that landed a linted, certified pick and one
that landed the same document with no linter available both produce a root `DESIGN.md`, and only
this tells them apart.
