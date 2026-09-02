---
description: >-
  Write the implementation report for one finished milestone of a build plan: a single
  self-contained HTML page carrying what the milestone delivers, the design AS BUILT with every
  divergence from the plan's contracts named, 2–4 hand-drawn SVG diagrams of the shape it took, and
  the cited code snippets that hold its decisions. Scope comes from the plan itself — a
  `## Milestone N` heading and the `### Phase N` leaves under it — and each phase's changeset from
  the single commit that landed it, so the document reports what was built rather than what was
  planned. Lands in `docs/<topic>/reports/milestone-<N>-<slug>.html` beside the plan. Use on
  "/r:plan-report", "write up milestone 2", "document what we built in this milestone", "report on
  the milestone we just finished", "milestone write-up with diagrams". **Invoked deliberately, or by
  `/r:plan-run` when a milestone's last phase merges — never on its own** after an ordinary code
  change or at the end of a session. NOT for: running the plan (`/r:plan-run`), writing or phasing
  one (`/r:spec-design`), specifying what to build (`/r:spec-brainstorm`), or reviewing a diff
  (`/r:task-review`).
model: opus
effort: high
---

# plan-report

One milestone, one HTML page: what it delivers, the design as built, the diagrams that show its
shape, and the code that carries its decisions.

**This routine is not automatic.** Invoke it when the user asks, or when `/r:plan-run` reaches a
milestone boundary. Never after an ordinary code change and never at the end of a session — the
rule lives here and in the description rather than in frontmatter, because
`disable-model-invocation: true` blocks the Skill tool outright and cannot tell an auto-load from a
deliberate call, so it would also block `/r:plan-run`'s boundary step. The same reasoning, and the
same resolution, as `/r:task-review`.

Three things shape the design:

- **The plan decides the scope, and a script reads the plan.** Which phases a milestone contains and
  whether it is finished are answered by `milestone_scope.py`, never by reading the markdown and
  counting. Both failures are silent: a report scoped to the wrong phases still renders, and a
  milestone called complete one phase early still produces a document that reads as authoritative.
- **The report describes what was BUILT.** `design.md` holds contracts written before the code
  existed; the code is what happened. Where they diverge, the divergence is the most valuable line
  in the document — a report that quietly prints the plan's version is the one a reader will trust
  over the code.
- **It is read once, by someone who was not here.** So it is comprehensive in what it covers and
  short in how it says it. Every decision the milestone made is in it; each is stated once. The
  register, and the test for it, are in
  [references/output-format.md](references/output-format.md).

## Invocation

```
/r:plan-report [<plan>] [<milestone>] [--partial] [--no-commit] [--dry-run]
```

- **`<plan>`** — the plan file. With no argument, look for one and **name what you found before
  using it**: `docs/*/todo.md` first (where `/r:spec-design` writes), then `todo.md`, `PLAN.md` or
  `IMPLEMENTATION.md` at the repo root.
- **`<milestone>`** — the number. With no argument, take the highest-numbered **complete** milestone
  that has no report yet, and say which one you took. If several are unreported, list them and ask
  rather than guessing which one the user means.
- **`--partial`** — write the report over an unfinished milestone's ticked phases only. Without it,
  an incomplete milestone stops the run.
- **`--no-commit`** — write the file and stop; do not stage or commit. `/r:plan-run` passes this,
  because the caller owns the repo's state.
- **`--dry-run`** — print the scope, the sections and the diagrams you would draw, and write
  nothing.

## Read these before you act

| Before you… | Read | It owns |
|---|---|---|
| write a single tag | `${CLAUDE_SKILL_DIR}/references/output-format.md` | the sections, the register, the diagram catalogue, the snippet rules, how each gap is named |
| write the page shell | `${CLAUDE_PLUGIN_ROOT}/skills/spec-brainstorm/references/html.md` §1–3 and §6's mechanics | the self-contained contract, the `:root` palette, the two-column shell, the shared SVG rules |

`html.md`'s §5 example list and §6 diagram *catalogue* are a specification's, not a report's — the
output-format reference says what to take and what to leave.

## Step 0 — Resolve the plan, the milestone and the scope

```sh
python3 "${CLAUDE_SKILL_DIR}/scripts/milestone_scope.py" <plan> --milestone <n> --repo <repo-root>
```

It returns the milestone (name, `Contracts:` pointer, phase numbers, tick counts, the report path)
and, per phase, its title, checklist with ticks, `Done when:`, the plan's declared `Files:`, its
**landing commit** and the files that commit changed.

Stop here, without writing, when:

- **the plan has no `## Milestone N` headings** (`hasMilestones: false`) — there is nothing to report
  on. Say so and name the flat shape; do not invent a grouping.
- **the milestone is not complete** and `--partial` was not passed. Say which phases are outstanding.
  A report that implies completeness over unfinished work is the one failure here that misleads
  rather than merely disappoints.

`unresolvedCommits` above zero is **not** a stop. Those phases are described from the plan and the
current tree instead of from their diff, and the header's coverage line says so.

## Step 1 — Read the intent

The milestone's contracts from `design.md` at the `Contracts:` pointer, and each phase's block from
the plan. This is the **claim** — hold it separately from what you are about to read in the code, or
the two blur and the divergences vanish.

A `--shallow` plan has no `design.md`. That is not a defect: report the design from the code alone
and say there was nothing to compare it against.

## Step 2 — Read the code that landed

**Targeted, from the scope.** Each phase's `changedFiles` and its commit are the reading list:

```sh
git show <commit> -- <path>          # what this phase did to this file
git log --format=%H <base>..HEAD     # only if you need the ordering
```

Then read the **current** state of the files that matter — a later phase may have moved what an
earlier one wrote, and the report describes the code as it stands, not as each phase left it.

Never sweep the repository. The scope names the files; anything outside it is context you did not
need, and reading it is how a report about one milestone turns into a tour of the codebase.

## Step 3 — Decide the diagrams and the snippets

From the catalogue in the output-format reference: 2–4 figures, drawn only where the subject exists
in *this* milestone, with names taken character for character from the code. Then 3–6 snippets, each
one a decision rather than a sample, each cited `path:LINE` and copied from the file.

Say what you chose and why before you draw it. A figure you cannot justify in a sentence is one the
reader will not be able to read either.

## Step 4 — Write the page

`docs/<topic>/reports/milestone-<N>-<slug>.html`, at the path the script returned. Create the
`reports/` directory if it does not exist.

**Incrementally**: `Write` the shell plus the header and section 1, then one `Edit` per section
after it. A single `Write` at this size loses quality toward the end — the last sections come out
thin, which is exactly where the code snippets and the open gaps live.

If a report already exists at that path, read it first and update it in place. Never mint a
`-2` beside it.

## Step 5 — Check what you wrote

Mechanical, then editorial. Both matter; the second is the one that decides whether the file gets
read twice.

- **No `<script>` anywhere.** No external font, stylesheet or image. Every `href` is an `https:` URL
  or an in-page `#anchor`.
- **Every `<svg>` has a `viewBox`** and no fixed `width`/`height`; every arrowhead marker is defined
  inside its own `<svg>`'s `<defs>`; every colour comes from a palette variable.
- **Every snippet citation resolves** in the tree as written. Drop the ones that do not and name them
  in the coverage line.
- **The register check: name the decision each section carries.** A section that cannot name one is
  empty, not concise — cut it or give it its decision back. Then go the other way: list the
  decisions this milestone made and confirm each one appears. A decision dropped for brevity is the
  failure this document exists to prevent.
- **Every gap is in the FILE**, not only in the terminal: unresolved commits, a missing `design.md`,
  a `--partial` scope, a dropped snippet.

## Step 6 — Commit, unless told not to

Under `--no-commit` or `--dry-run`, stop and return the path.

Otherwise stage that one file and commit it alone — `docs: milestone <N> report`. On its own commit,
never folded into someone else's: the report is written after the milestone's code has already
landed, so there is no commit of the milestone's left to join.

## Step 7 — Report, then record the run

Tell the user the path, the phases covered, the diagrams drawn, the snippets cited, and **every gap
by name**. Then one line into the pack-wide store — counts only, never a milestone name, a plan path
or a snippet:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:plan-report","kind":"report","milestone":0,"phases":0,"diagrams":0,"snippets":0,
 "snippetsDropped":0,"partial":false,"unresolvedCommits":0,"hadContracts":false,
 "divergences":0,"blocked":null}
STATS_JSON
```

**`divergences` is the field worth having.** It counts the places the code and `design.md` disagreed
— the thing this report exists to surface. A run with contracts to compare against and zero
divergences means the plan predicted the build exactly, which is either excellent planning or a
report that did not look; across many runs, a `divergences` that is always zero while
`hadContracts` is true is the signal that section 2 has degraded into printing the plan back.

**`blocked`** is the reason nothing was written — `no-milestones`, `incomplete`, `no-such-milestone`
— and null on a run that produced a file. A blocked run still records: a stop is a result, and a
store that holds only the runs that wrote something cannot be asked how often this is reached and
cannot answer.

The script always exits `0`; a lost row is never a failed run. Never retry it.

## Non-negotiables

- **Never fire on your own.** A user's `/r:plan-report`, or `/r:plan-run`'s milestone boundary.
  Not after a code change, not at the end of a session, not because a milestone happens to look
  finished.
- **The scope comes from the script.** Never decide which phases a milestone contains, or whether it
  is done, by reading the markdown yourself. Both wrong answers are confident and silent.
- **An incomplete milestone stops** unless `--partial`, and a `--partial` report says so in the
  document, not only in the terminal.
- **Report the design as BUILT, and name every divergence.** `design.md` is the claim; the code is
  the fact. Printing the claim as though it were the fact makes this document actively harmful — it
  is the version a reader will trust over the code.
- **Snippets are copied, never retyped**, and always carry `path:LINE`. A citation that does not
  resolve is dropped and named, never silently replaced.
- **Draw only diagrams whose subject exists in this milestone**, with names taken character for
  character from the code. An empty box, or a box labelled with a class that is not there, is worse
  than no figure.
- **Comprehensive in what it covers, short in how it says it.** No decision dropped to keep the page
  short; no paragraph that only narrates the code beneath it.
- **Every gap is written into the file.** The terminal ends with the session; the report does not.
- **One file, no `<script>`, nothing external.** A report that needs a server to render is a report
  nobody opens from an email.
- **`--dry-run` writes nothing, ever**, and `--no-commit` writes the file and touches no git state.
