---
description: >-
  Decompose written documentation into a build plan with three levels of depth: milestones that
  group the work, the design contracts each milestone's units share — schema with real column
  types and indexes, endpoint signatures and status codes, the types introduced, module
  boundaries — and then leaf phases whose checklists carry that contract concretely enough to
  implement from. Reads a spec (docs/<topic>/spec.html from /r:spec-brainstorm, a PRD, a design
  doc) plus any other documents you point at, and writes one todo.md. Every leaf declares what it
  depends on, so the plan is a graph: it says which units may be built at the same time, and
  refuses a wave whose members would collide on a file. One leaf is exactly one /r:task-run.
  Stack-agnostic — it follows whatever the documents already decided, and takes an optional
  free-text argument for what the documents cannot say: priorities, a deadline, what to defer,
  constraints to respect. Where a design decision is genuinely open and would change the
  contracts or the split, it asks rather than picking one quietly. Use on "/r:spec-design",
  "turn this spec into a plan", "break these docs into phases", "what's the build order", "plan
  this out with the design detail", "which parts can we build in parallel". Add --shallow for the
  build order alone, with no design pass. NOT for writing the spec — that's /r:spec-brainstorm;
  NOT for building the plan — that's /r:plan-run or /r:task-run.
model: opus
effort: xhigh
disable-model-invocation: true
---

# Documents to a build plan

Read the documentation, write `todo.md` beside it. The documents already made the product
decisions — yours are the build order, the design contracts they imply, and the dependency graph.
If you find yourself inventing a story, stop and put it in Open questions instead.

**Three levels, one file, one addressable node.** A `## Milestone` groups work and carries the
contracts its members share. A `### Phase N` is the **leaf** — the only executable node, and
exactly one `/r:task-run`. Nothing else is addressable, which is what keeps `/r:task-run`,
`/r:plan-run` and `scripts/check_todo.py` each dealing with one kind of thing.

## The rule everything else hangs on

**A leaf's checklist items must be self-contained.** `/r:task-run` resolves `"todo.md / Phase 7"`
by locating *that block* and lifting *its* checklist into its acceptance criteria. It does not read
the milestone above it and it follows no links out of the block.

So the milestone's `**Design**` section never reaches the implementer. It exists for the human, and
for **you** in pass 3 — it is what the leaf items are derived *from*, not a place they can point
*at*. An item reading "build the endpoint per the milestone design" arrives at the planner as a
dangling pointer: the contract it names is simply absent. `check_todo.py` reports it.

This is also what makes the design pass worth running at all: the contract *becomes* the checklist,
so it reaches the implementer through the path that already exists. Nothing needs wiring.

## Invocation

`/r:spec-design [<doc>...] ["<requirements>"] [--shallow] [--yes]`

- **`<doc>...`** — the documents to read. Several is normal and expected. Omitted, they are
  discovered (Step 1).
- **`"<requirements>"`** — optional free text for **what the documents cannot say**: what matters
  most, what to defer, a deadline, a constraint to respect, a part to leave alone.

  ```
  /r:spec-design docs/billing/spec.html "payouts first, we demo in two weeks; admin UI can wait"
  /r:spec-design docs/billing/spec.html "don't touch the legacy importer, and keep v1 to one module"
  ```

  **It steers, it never adds.** Ordering, the v1 line, what lands in a later milestone, how far to
  split — all fair game. Requirements the documents do not contain are not: a stated priority is
  the user telling you what to build *first*, not a story you may invent to build. If the free text
  names work no document describes, it goes to Open questions with a note that it needs a spec,
  the same as any other gap.

  **If it contradicts the documents, that is an Open question too** — not a silent override. "Skip
  the admin UI" against a spec whose v1 line requires it is exactly the disagreement a human has to
  settle, and quietly deferring a v1 story is how a plan ships something nobody agreed to.

- **`--shallow`** — stop after pass 1: the build order alone, no design contracts (Step 4).
- **`--yes`** — skip the gate (Step 8). It does not skip the questions in Step 3.5: an unresolved
  design choice is recorded in Open questions with the option taken and why, so the decision is
  visible even when nobody was there to make it.

## Step 1 — find and read the documents

In priority order: paths the user gave you · `docs/<topic>/spec.html` · `docs/*.md` (if several,
ask which) · `spec.md`, `PROJECT.md`, `DESIGN.md`, `README.md` at the repo root.

**Take more than one when more than one is offered.** A spec plus a PRD plus a page of notes is the
normal shape, and reading only the tidiest of them is how half the requirements go missing. Say
which documents you read and what you took from each.

**When two documents disagree, that is an Open question, never a silent pick.** The disagreement is
information — one of them is out of date, and only the user knows which. Resolving it quietly puts
a decision nobody made into a plan everybody builds from.

If nothing exists, say so and point at `/r:spec-brainstorm` rather than inventing a spec to plan
against.

Pull out: **user stories, by name** (in a `/r:spec-brainstorm` spec these are the `<h3>` headings
inside User stories — carry them verbatim, they are the traceability spine); **the modules and the
stack**, with versions, which you follow and never re-decide; **the domain model** — every entity
needs a migration somewhere; **the API** — every endpoint, command or screen needs a leaf that
builds it; **risks** whose mitigation is "investigate", which go to `## Resolve first`; and **the
v1 line**.

**In an existing codebase, read the code too** before writing anything: build files for real
dependency versions, the migration folder for the real schema, the package layout, `CLAUDE.md`, and
two existing tests to copy their style. A plan that names a file that doesn't exist, or invents a
module contradicting the layout, costs the implementer more than it saves.

## Step 2 — pass 1: milestones, leaves and the graph

Work backwards from the v1 line: what is the smallest run of leaves that delivers a usable
end-to-end result? Then order by dependency.

Prefer **vertical slices** that leave the project working and verifiable over horizontal layers
that don't run on their own. "Add the users table, the repository, the service and the endpoint,
with a test that hits it" is a leaf. "Add all the entities" is not.

**Size each leaf to one focused session: 5–12 checklist items, roughly ≤400 lines of new code, one
to three slices.** This is the size `/r:task-run` is built around and it does not change because
the plan got deeper — a deeper plan means richer items, not more of them. A leaf that sprawls
across many subsystems gets split; a leaf that is one trivial edit gets folded into a neighbour.

**The story count sets the size, not a band you pick.** Roughly one to two leaves per story, plus
what the stories don't cover on their own — the first schema, the deployment, the seams between
modules.

**Group leaves under `## Milestone N — <name>`.** A milestone is the high-level decomposition: a
coherent area of the product, usually 3–8 leaves. Numbering of *leaves* runs continuously across
every milestone and starts at 1 — restarting inside a milestone makes "Phase 3" ambiguous and gets
the wrong boxes ticked. Say in the header which milestones deliver v1.

**Every leaf declares `**Depends on:**`** — the leaves it builds on, or `—` when it has none. This
is not optional and not "only when the order isn't obvious": it is the graph, and the graph is what
decides which leaves may be built at the same time. A missing line is a reported defect.

**Number leaves so that every dependency is lower-numbered.** Numeric order then *is* a valid build
order, which is what lets `/r:plan-run` run the plan straight down the page and still respect every
edge. The checker enforces it.

## Step 3 — pass 2: the design contracts

For each milestone, write the `**Design**` section: the decisions its leaves **share**. You can
only write this now, because until the leaves exist you cannot tell what is shared from what is
local.

- **Schema** — tables with real column types, nullability, defaults, indexes, unique constraints
  and foreign keys.
- **API** — each endpoint's method and path, request and response shape, and every status code it
  returns including the error ones.
- **Types** — the signatures introduced, and the invariants that matter (`DuplicateKey` is a
  replay, never a failure).
- **Boundaries** — which module owns what, and what may import what.

Write only what is genuinely shared. A contract used by exactly one leaf belongs in that leaf's
items, not up here — hoisting it adds a hop for the reader and reaches nobody extra.

**The ceiling is contracts, and it is deliberate.** Schema, signatures, endpoints, errors, test
names: the detail that survives being written before the code exists.

**Never write `file:LINE` references and never write a reuse map.** For a leaf six weeks out those
are imagined, and an imagined citation is worse than none — it reads exactly like a real one.
`/r:task-run`'s planner produces both for real at execution time, with the files open, and its
reuse map is explicitly "the evidence you explored rather than imagined". This document must not
counterfeit that. Approach prose, algorithms and pseudocode are out for the same reason: they are a
diff plan against a codebase that does not exist yet.

## Step 3.5 — ask about the design choices you cannot settle

Pass 2 makes real decisions, and some of them the documents do not determine. **Where a choice is
genuinely open and the answer would change the plan, ask — do not pick one quietly.**

The bar is all three, together:

1. **The documents do not settle it.** Not "they are vague" — you have read them and the answer is
   genuinely absent. A decision the spec already made is not open, however much you would have
   chosen differently.
2. **Two or more options are defensible**, and reasonable engineers on this project would disagree.
3. **The choice changes the plan** — the contracts, how leaves split, the graph, or the v1 line.

What that looks like: sync call versus a queue between two modules · one table with a type column
versus separate tables · idempotency by unique constraint versus an outbox · soft delete versus
hard · whether an integration is stubbed in v1 or built for real · which module owns a shared
concept the spec names only once.

**What it is not.** Naming, column order, whether a helper is static, which test framework the repo
already uses, anything the code or `CLAUDE.md` answers by looking. If you would not put it in a
design review, do not ask about it. A skill that asks six questions to write one plan spends the
user's attention on things it should have decided, and the next thing they do is stop reading.

**Ask them together, once, at the gate.** Carry each open choice into Step 8 and put it to the user
alongside the decomposition — that is one interruption for both, and the two are related: an
answer that changes the contracts often changes the split too, and nothing is on disk yet, so
redoing a pass costs a message.

State each one as: the decision · the options · what each costs · which you would take and why.
**Give a recommendation.** A question with no lean makes the user do the analysis you just did, and
you are the one who has read the documents and the code.

**Never invent an answer to a question you decided was worth asking.** If the run is unattended
(`--yes`), or the user declines to choose, take your recommended option, build the plan on it, and
record it in Open questions: the decision, the alternative, and what would have to be true for the
alternative to win. A design choice nobody made is fine; one nobody can *find* is not — the leaves
below it were shaped by it, and a later reader needs to know which.

## Step 4 — pass 3: the leaf checklists

Turn each milestone's contracts into its leaves' `- [ ]` items — the slice each leaf realizes, plus
whatever is local to it. This is where the plan becomes implementable.

An item names the concrete thing: the DDL, the endpoint and its responses, the signature, the named
test. Compare:

```
- [ ] add idempotency to the payout webhook          <- unbuildable; the planner re-derives everything
- [ ] `V7__payout_idempotency.sql` creates `payout_idempotency` with `UNIQUE (merchant_id, idempotency_key)`
- [ ] `POST /webhooks/payout` returns `200 {payoutId}` on replay, `409` when the key is reused with a different body
- [ ] `PayoutWebhookIT` covers first call, replay, and concurrent double-post
```

**Every item stands alone.** Repeat the part of the contract the item needs rather than pointing at
the milestone — the implementer never sees that section. Repetition between the `**Design**` and
the items it produced is expected and correct; it is not duplication to factor out.

**`--shallow` stops after pass 1** — it skips Steps 3 and 3.5, not the rest. Milestones, leaves,
`Depends on:` and the checklist, with no design pass and no contracts in the items: the build order
alone. Use it when the code will be designed at execution time and the plan is only there to order
the work. It still checks, still gates, still hands off, and still records (`mode: "shallow"`).

## Step 5 — write the leaf

```markdown
### Phase 7 — Payout idempotency store
**Implements:** Replay a payout safely
**Depends on:** Phase 6
**Files:** `db/migration/V7__payout_idempotency.sql` (new) · `.../PayoutRepository.java` (new)
**Risk:** money + persistence
- [ ] `V7__payout_idempotency.sql` creates `payout_idempotency` with `UNIQUE (merchant_id, idempotency_key)`
- [ ] `PayoutRepository.findByMerchantAndKey` returns the stored `payout_id` or empty
- [ ] `PayoutRepositoryIT` proves the unique constraint rejects a second insert of the same pair
**Done when:** `mvn -pl payments test -Dtest=PayoutRepositoryIT` is green.
```

- **Implements** — required, **story names verbatim**, separated by ` · `. `check_todo.py` matches
  them against the spec, so a paraphrase reads as a story with no leaf. This is what keeps the
  documents and the plan one artefact rather than two that drift.
- **Depends on** — required, `—` when there is none. The graph.
- **Done when** — required. A runnable command or an observable response. "The feature works" is
  not a check. If you can't write a command, the leaf is too vague to start.
- **Files** — required where the codebase exists. Also what the collision check reads: two leaves
  in one wave naming the same file cannot run concurrently.
- **Risk** — only when the leaf touches **auth, money, persistence, concurrency or security**,
  because those are the surfaces `/r:task-run` escalates on, and `/r:plan-run` forces the full
  review tier on a leaf that carries one. Omit it rather than writing "Risk: low" — a missing line
  means *no claim*, and the classifier reading real code then decides, which it does better.

The full document shape, the milestone template and the wave summary are in
[references/design-contracts.md](references/design-contracts.md).

## Step 6 — what is a leaf, and what isn't

**A numbered leaf is work a coding agent can build and verify.** Code, schema, config,
infrastructure — with a check you can run. That is the entire contents of the numbered list,
because `/r:task-run` executes one by branching, implementing test-first, building and opening a
PR. Hand it anything else and it will try to do all of that to a decision.

Two kinds of real work fail that test and must not be numbered:

- **Unknowns that need resolving before anyone builds** — "can Debezium read our RDS instance?".
  The output is a decision, not a diff.
- **Work that isn't engineering** — staffing a rota, signing a DPA, procuring a licence.

Both go in an unnumbered **`## Resolve first`** above the milestones, each with who owns it and
which leaf it blocks. Unnumbered keeps them out of `/r:task-run`'s reach — it looks for
`### Phase N` — while leaving them where the person reading the plan will see them.

## Step 7 — check it

```sh
python3 "${CLAUDE_SKILL_DIR}/scripts/check_todo.py" docs/<topic>/todo.md --spec docs/<topic>/spec.html
```

Fix everything it reports, then re-run. It catches stories with no leaf, leaves with no story,
missing "done when", oversized leaves, numbering gaps, files referenced before they are created,
**and the graph**: a missing `Depends on`, a cycle, a dependency on a higher-numbered leaf, a leaf
item that defers outside its own block, two leaves sharing a file inside one wave, and a `##
Waves` summary that has drifted from the edges. It prints the derived wave table either way.

Then four judgments a script can't make:

1. **Order** — could someone actually build leaf 3 with only 1 and 2 finished?
2. **Slices** — does each leaf leave the project working and demonstrable?
3. **Honesty** — is any "done when" a check you couldn't run today?
4. **Self-containment** — pick two leaves at random and read *only* their blocks. Could you
   implement them? That is exactly what `/r:task-run` sees.

## Step 8 — the gate

**Before writing anything to disk, show the decomposition and wait.** Milestones, leaf titles,
the graph, the wave table — **and the open design choices from Step 3.5** — then stop for a yes.

Both go in the same interruption, because they are the same decision seen twice: a design choice
that changes the contracts usually changes which leaves exist, so answering it and approving the
split are one act. Ask the design questions with `AskUserQuestion` where the options are discrete;
each one carries your recommendation and what it costs.

The decomposition is what every later pass hangs off: contracts are written per milestone and items
are derived from contracts, so a wrong split makes both passes wrong together. It is also the
cheapest possible moment to fix — a re-split before writing costs one message; after writing it
costs the whole document. One gate, here, and none after it.

**If the user declines, write nothing and go straight to Step 10** with `mode: "declined"` and the
counts you had drafted. A rejected decomposition is the one outcome this skill most needs to be
able to see later, and it is invisible if a declined run simply ends.

`--shallow` gates the same way. With `--yes`, skip it.

## Step 9 — hand off

Write `todo.md` **beside the documents** — `docs/<topic>/todo.md` when the spec is
`docs/<topic>/spec.html`. Never write a root `todo.md` when the spec lives in `docs/`: a second
plan with independent numbering is a real trap.

Report the leaf count, where the v1 line falls, the wave table, and anything you had to assume.
**Lead with `## Resolve first` if it isn't empty** — those block real leaves and need a person.

Then the next command — the whole plan:

```
/r:plan-run docs/<topic>/todo.md
```

or one leaf on its own:

```
/r:task-run "docs/<topic>/todo.md / Phase 1"
```

**Name what the graph found.** If any wave holds more than one unbuilt leaf, say so and say they
can be built concurrently, one `/r:plan-run` session each — that is the return on writing the
edges, and `/r:plan-run --dry-run` prints the exact commands.

## Step 10 — record the run

One line into the pack-wide store — counts only, never a document path, a milestone name or a leaf
title. **Record even when the user declines at the gate**, with `mode: "declined"`: a decomposition
that was proposed and rejected is the most informative row this skill can write, and dropping it
leaves a store where every plan was a good one.

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:spec-design","mode":"full","docsRead":0,"hadRequirements":false,
 "milestones":0,"leaves":0,"waves":0,"maxWaveWidth":0,
 "designChoicesAsked":0,"designChoicesRecorded":0,"checkerProblems":0,"openQuestions":0}
STATS_JSON
```

`mode` is `full` | `shallow` | `declined`, and it is what keeps the other numbers comparable: a
`--shallow` plan has no design pass, so counting its zero `designChoicesAsked` alongside a full
one's would report the bar as stricter than it is.

**`maxWaveWidth` is the number that judges the graph.** Writing a `Depends on:` line on every leaf
costs something on every plan, and it buys exactly one thing: leaves that can be built at the same
time. If the widest wave is 1 across many plans, the edges are being written and nothing is using
them — either the decomposition is too linear or this project's work genuinely is, and both are
worth knowing. `waves` beside it says whether that is a long chain or a wide one.

**`designChoicesAsked` calibrates the Step 3.5 bar, and it is the field most likely to be read
angrily.** The bar is meant to be narrow. Several questions per plan means it is too low and the
skill is spending attention it should be spending deciding; zero across many plans means it is too
high and choices are being made silently that a human would have wanted. `designChoicesRecorded`
counts the ones that went to Open questions instead of being answered — under `--yes`, or when the
user declined to choose.

**`checkerProblems` is what `scripts/check_todo.py` reported on the first run**, before fixing.
Consistently zero means the checker is not earning its place in Step 7; consistently high means
this skill is producing plans it already knows how to check.

**The cross-skill pair is `leaves` here against `phasesInPlan` in `/r:plan-run`'s rows.** That is
the only way to see whether plans get written and then actually executed — a store full of plans
with no runs is the failure neither skill can detect on its own.

The script always exits `0` — a lost row is a lost row, never a failed run, and it must never change
what was written. Never retry it.

## The downstream contract

Three things are load-bearing for `/r:task-run` and `/r:plan-run` and must not drift:

- GitHub-flavoured `- [ ]` checkboxes. Nothing else marks a task.
- Stable `### Phase N — title` headings, starting at 1, gap-free, no repeats. **This is the leaf**,
  and its heading shape is what both tools locate. A milestone is `##`, never `###`.
- **Only buildable work carries a `### Phase` heading.**

Everything else is for the human and the implementer's head start, not for a parser.

## Never do this

- Never invent a story the documents don't contain, and never reword one — including from the
  free-text requirements, which say what to build first, never what to build.
- Never silently resolve a design choice that met the Step 3.5 bar. Ask, or record the decision and
  its alternative in Open questions. Never both silently decide and leave no trace.
- Never re-decide the stack. The documents chose it.
- Never write `file:LINE` or a reuse map — those are `/r:task-run`'s planner's, written against
  real code.
- Never let a leaf item point at the milestone. The implementer cannot see it.
- Never write a leaf whose "done when" nobody can run.
- Never number work that isn't buildable — a decision or a signature goes in `Resolve first`.
- Never omit `Depends on:`. Without the graph nothing can be built concurrently and nothing checks
  the order.
- Never renumber leaves per milestone, and never start at 0.
- Never hand-edit the `## Waves` summary — it is generated from the edges, and the checker compares
  them.
