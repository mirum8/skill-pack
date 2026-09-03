---
description: >-
  Decompose written documentation into a three-level build plan: milestones grouping the work,
  the design contracts each milestone's units share (schema with real column types, endpoint
  signatures and status codes, the types introduced, module boundaries), and leaf phases whose
  checklists carry that contract concretely enough to implement from. Reads a spec
  (docs/<topic>/spec.html from /r:spec-brainstorm, a PRD, a design doc) plus any others you
  name; writes todo.md with the contracts beside it in design.md. Every leaf declares its
  dependencies, so the plan is a graph that says which units may be built at once and refuses a
  wave whose members collide on a file. One leaf is exactly one /r:task-run. An existing plan,
  in any shape including a hand-written checkbox backlog, is an input never overwritten: it is
  reformatted and re-derived against the documents with every leaf that already carries a tick frozen. Stack-agnostic;
  optional free text for what the documents cannot say (priorities, a deadline, what to defer).
  Asks where a design decision is genuinely open and would change the contracts or the split.
  The draft is challenged by the real Codex where installed - findings verified, major ones
  fixed, all three lists reported. Invoked deliberately as "/r:spec-design" - never routed to.
  --shallow gives the build order alone. NOT for writing the spec - that's /r:spec-brainstorm;
  NOT for building the plan - that's /r:plan-run or /r:task-run.
model: fable
effort: high
disable-model-invocation: true
---

# Documents to a build plan

Read the documentation, write `todo.md` and `design.md` beside it. The documents made the product
decisions — yours are the build order, the design contracts they imply, and the dependency graph.
If you find yourself inventing a story, stop and put it in Open questions instead.

**Three levels, two files, one addressable node.** A `## Milestone` groups work; the contracts its
members share live in `design.md` beside the plan. A `### Phase N` is the **leaf** — the only
executable node, and exactly one `/r:task-run`. Nothing else is addressable, which keeps
`/r:task-run`, `/r:plan-run` and `scripts/check_todo.py` each dealing with one kind of thing.

## The rule everything else hangs on

**A leaf's checklist items must be self-contained.** `/r:task-run` resolves `"todo.md / Phase 7"`
by locating *that block* and lifting *its* checklist into its acceptance criteria. It does not read
the milestone above it and follows no links out of the block.

So the contracts never reach the implementer. They exist for the human, and for **you** in pass 3 —
what the leaf items are derived *from*, not a place the items can point *at*. An item reading
"build the endpoint per the milestone design" arrives at the planner as a dangling pointer: the
contract it names is in another file. `check_todo.py` reports it. The contract *becomes* the
checklist, so it reaches the implementer through the path that already exists.

## Invocation

`/r:spec-design [<doc>...] ["<requirements>"] [--shallow] [--yes]`

- **`<doc>...`** — the documents to read. Several is normal. Omitted, they are discovered
  (Step 1). **A plan among them is the plan to rewrite** (Step 1.5), not a document to plan from —
  no flag, because a plan on disk is found either way and overwriting one is never right.
- **`"<requirements>"`** — optional free text for **what the documents cannot say**: what matters
  most, what to defer, a deadline, a constraint to respect, a part to leave alone.

  ```
  /r:spec-design docs/billing/spec.html "payouts first, we demo in two weeks; admin UI can wait"
  /r:spec-design docs/billing/spec.html "don't touch the legacy importer, and keep v1 to one module"
  ```

  **It steers, it never adds.** Ordering, the v1 line, what lands in a later milestone, how far to
  split — all fair game. Requirements the documents do not contain are not: a stated priority says
  what to build *first*, not a story you may invent. Free text naming work no document describes
  goes to Open questions with a note that it needs a spec, like any other gap.

  **If it contradicts the documents, that is an Open question too** — not a silent override. "Skip
  the admin UI" against a spec whose v1 line requires it is exactly the disagreement a human has to
  settle; quietly deferring a v1 story is how a plan ships something nobody agreed to.

- **`--shallow`** — stop after pass 1: the build order alone, no design contracts (Step 4). It
  writes no `design.md`, and says so rather than leaving a stale one beside a fresh plan.
- **`--yes`** — skip the gate (Step 8). It does not skip the questions in Step 3.5: an unresolved
  design choice is recorded in Open questions with the option taken and why, so the decision stays
  visible when nobody was there to make it.

## Step 1 — find and read the documents

In priority order: paths the user gave you · `docs/<topic>/spec.html` · `docs/*.md` (if several,
ask which) · `spec.md`, `PROJECT.md`, `DESIGN.md`, `README.md` at the repo root.

**Take more than one when more than one is offered.** Reading only the tidiest is how half the
requirements go missing. Say which documents you read and what you took from each.

**When two documents disagree, that is an Open question, never a silent pick.** One of them is out
of date, and only the user knows which.

If nothing exists, say so and point at `/r:spec-brainstorm` rather than inventing a spec to plan
against.

Pull out: **user stories, by name** (in a `/r:spec-brainstorm` spec these are the `<h3>` headings
inside User stories — carry them verbatim, they are the traceability spine); **the components and
the stack**, with versions, which you follow and never re-decide; **the domain model** — every
entity needs a migration somewhere; **the API** — every endpoint, command or screen needs a leaf
that builds it; **risks** whose mitigation is "investigate", which go to `## Resolve first`; and
**the v1 line**.

**A `/r:spec-brainstorm` spec also carries its decisions and what they were made for**, and both
change the plan. Its **Decisions** part holds one ADR per choice that had a live alternative, each
with the consequences it accepted — a consequence saying "held payouts accumulate and need a
queue" is a leaf somebody has to build, and re-opening a decision the ADR settled is the most
expensive thing a plan can do. Its **Architectural characteristics** part holds at most three
numbers the whole design is traded against; a leaf that would miss one needs its own verification
step, not a note. Read both before ordering anything.

**In an existing codebase, read the code too** before writing anything: build files for real
dependency versions, the migration folder for the real schema, the package layout, `CLAUDE.md`, and
two existing tests to copy their style.

## Step 1.5 — an existing plan is an input, never a casualty

Before pass 1, look for a plan already on disk: the output path first, then where `/r:plan-run`
looks — `docs/*/todo.md`, then `todo.md`, `PLAN.md`, `IMPLEMENTATION.md` at the root. A plan handed
to you among the `<doc>` paths counts too. **Nothing found → this is a fresh run; go to Step 2.**

Found one, the run is a **rewrite**: the same passes over an input that already exists. Name the
shape before touching it, because what carries over differs:

| shape | how you know | what carries over |
|---|---|---|
| `split` | `## Milestone` + `**Depends on:**`, `design.md` beside it | everything |
| `packed` | `## Milestone` with an inline `**Design**` | everything; contracts move to `design.md` |
| `flat` | `### Phase N` and `- [ ]`, no milestones, no edges | the leaves; milestones and edges are derived |
| `foreign` | headings and checkboxes and little else (`## Sprint 2`) | item text and tick state, nothing more |

### Freeze what has landed

**A leaf carrying at least one `- [x]` item, or a `<!-- built: … -->` marker on its heading, is
frozen.** Not only a fully-ticked one: a partly-ticked leaf has landed work too, and re-splitting it
orphans those ticks. Frozen means its **number, title, tick state and every ticked item's wording**
come through the rewrite unchanged. That number is what `--from N`, the branch and the PR body all
name; those ticks are what stop `/r:plan-run` rebuilding what already shipped.

Three things follow:

- **An unticked item inside a frozen leaf may still be rewritten**, and a frozen leaf **may gain** a
  missing `**Implements:**`, `**Depends on:**` or `**Done when:**` line. Those annotate what was
  built without changing it, and let a `foreign` plan become conformant without falsifying its
  history.
- **Everything unbuilt is free** — re-split, re-scope, renumber, drop it and rewire the edges. New
  leaves are numbered above the highest frozen one, so numeric order stays a valid build order and
  no edge points backwards.
- **A story the documents changed after a leaf shipped is new work**, never an edit to the frozen
  leaf. The plan is the record of what was built; rewriting it into the present tense destroys the
  only copy.

### What you may infer, and what you must label

A `flat` or `foreign` plan has no milestones, edges or story names, so you supply them. Where it
has no `### Phase N` numbering either, assign numbers **in document order** — the honest reading of
a list nobody ordered — and from that moment the numbers are identity.

**Every inferred field is named as inferred at the gate.** An inferred edge reads exactly like an
authored one — the same reason `file:LINE` references are banned from this document.

`**Done when:**` is the one field never invented. Derive a real command from the build files read
in Step 1, or leave the leaf without one and let the checker report it before the gate. Writing
`mvn test` to quiet a check is worse than the check failing.

### Draft to one side

Write the draft to a scratch directory — `todo.md` and `design.md` both — and check and gate it
there. Nothing reaches the real paths until Step 9, so a declined rewrite leaves the original
byte-identical.

## Step 2 — pass 1: milestones, leaves and the graph

Work backwards from the v1 line: what is the smallest run of leaves that delivers a usable
end-to-end result? Then order by dependency.

Prefer **vertical slices** that leave the project working and verifiable over horizontal layers
that don't run on their own. "Add the users table, the repository, the service and the endpoint,
with a test that hits it" is a leaf. "Add all the entities" is not.

**Size each leaf to one focused session: 5–12 checklist items, roughly ≤400 lines of new code, one
to three slices.** This is the size `/r:task-run` is built around; a deeper plan means richer
items, not more of them. A leaf that sprawls across many subsystems gets split; one trivial edit
gets folded into a neighbour.

**The story count sets the size, not a band you pick.** Roughly one to two leaves per story, plus
what the stories don't cover — the first schema, the deployment, the seams between modules.

**Group leaves under `## Milestone N — <name>`.** A milestone is a coherent area of the product,
usually 3–8 leaves. Numbering of *leaves* runs continuously across every milestone and starts at
1 — restarting inside a milestone makes "Phase 3" ambiguous and gets the wrong boxes ticked. Say
in the header which milestones deliver v1.

**Every leaf declares `**Depends on:**`** — the leaves it builds on, or `—` when it has none. Not
optional, not "only when the order isn't obvious": it is the graph, and the graph decides which
leaves may be built at the same time. A missing line is a reported defect.

**Number leaves so that every dependency is lower-numbered.** Numeric order then *is* a valid build
order, which lets `/r:plan-run` run the plan straight down the page and still respect every edge.
The checker enforces it.

## Step 3 — pass 2: the design contracts

For each milestone, write its contracts into `design.md` beside the plan — one
`## Milestone N — <name>` section each, holding the decisions its leaves **share**. Only now:
until the leaves exist you cannot tell shared from local.

- **Schema** — tables with real column types, nullability, defaults, indexes, unique constraints
  and foreign keys.
- **API** — each endpoint's method and path, request and response shape, and every status code it
  returns including the error ones.
- **Types** — the signatures introduced, and the invariants that matter (`DuplicateKey` is a
  replay, never a failure).
- **Boundaries** — which module owns what, and what may import what.

Write only what is shared. A contract used by exactly one leaf belongs in that leaf's items, not
in `design.md` — hoisting it adds a hop for the reader and reaches nobody extra.

**Two files, one document.** The plan is the spine — what runs, in what order. `design.md` is what a
human reads to decide whether the design is *right*; no tool reads it, which is why Step 7 checks
the two against each other. A milestone heading in the plan may carry one pointer line for the
reader — `Contracts: design.md#milestone-1-ledger`. **Never on a `- [ ]` line**: an item that
points out of its own block reaches the implementer as a dangling pointer.

**The ceiling is contracts, and it is deliberate.** Schema, signatures, endpoints, errors, test
names: the detail that survives being written before the code exists.

**Never write `file:LINE` references and never write a reuse map.** For a leaf six weeks out those
are imagined, and an imagined citation is worse than none — it reads exactly like a real one.
`/r:task-run`'s planner produces both for real at execution time, with the files open, and its
reuse map is explicitly "the evidence you explored rather than imagined". Approach prose,
algorithms and pseudocode are out for the same reason: a diff plan against a codebase that does
not exist yet.

## Step 3.5 — ask about the design choices you cannot settle

Pass 2 makes real decisions, and some the documents do not determine. **Where a choice is
genuinely open and the answer would change the plan, ask — do not pick one quietly.**

The bar is all three, together:

1. **The documents do not settle it.** Not "they are vague" — you have read them and the answer is
   absent. A decision the spec already made is not open, however much you would have chosen
   differently.
2. **Two or more options are defensible**, and reasonable engineers on this project would disagree.
3. **The choice changes the plan** — the contracts, how leaves split, the graph, or the v1 line.

What that looks like: sync call versus a queue between two modules · one table with a type column
versus separate tables · idempotency by unique constraint versus an outbox · soft delete versus
hard · whether an integration is stubbed in v1 or built for real · which module owns a shared
concept the spec names only once.

**What it is not.** Naming, column order, whether a helper is static, which test framework the repo
already uses, anything the code or `CLAUDE.md` answers by looking. If you would not put it in a
design review, do not ask about it — six questions per plan and the user stops reading.

**Ask them together, once, at the gate.** Carry each open choice into Step 8 and put it to the user
alongside the decomposition — one interruption for both, and they are related: an answer that
changes the contracts often changes the split too.

State each one as: the decision · the options · what each costs · which you would take and why.
**Give a recommendation.** A question with no lean makes the user do the analysis you just did.

**Never invent an answer to a question you decided was worth asking.** If the run is unattended
(`--yes`), or the user declines to choose, take your recommended option, build the plan on it, and
record it in Open questions: the decision, the alternative, and what would have to be true for the
alternative to win. A design choice nobody made is fine; one nobody can *find* is not.

## Step 4 — pass 3: the leaf checklists

Turn each milestone's contracts into its leaves' `- [ ]` items — the slice each leaf realizes, plus
whatever is local to it.

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
the items it produced is expected and correct, not duplication to factor out.

**`--shallow` stops after pass 1** — it skips Steps 3 and 3.5, not the rest. Milestones, leaves,
`Depends on:` and the checklist, with no design pass, no contracts in the items and no `design.md`:
the build order alone, for when the code will be designed at execution time and the plan only
orders the work. It still checks, gates, hands off and records (`mode: "shallow"`).

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
  them against the spec, so a paraphrase reads as a story with no leaf. This keeps the documents
  and the plan one artefact rather than two that drift.
- **Depends on** — required, `—` when there is none. The graph.
- **Done when** — required. A runnable command or an observable response. "The feature works" is
  not a check. If you can't write a command, the leaf is too vague to start.
- **Files** — required where the codebase exists. Also what the collision check reads: two leaves
  in one wave naming the same file cannot run concurrently.
- **Risk** — only when the leaf touches **auth, money, persistence, concurrency or security**,
  the surfaces `/r:task-run` escalates on; `/r:plan-run` forces the full review tier on a leaf
  that carries one. Omit it rather than writing "Risk: low" — a missing line means *no claim*, and
  the classifier reading real code then decides, which it does better.

The full document shape, the milestone template and the wave summary are in
[references/design-contracts.md](references/design-contracts.md).

## Step 6 — what is a leaf, and what isn't

**A numbered leaf is work a coding agent can build and verify.** Code, schema, config,
infrastructure — with a check you can run. That is the entire numbered list, because `/r:task-run`
executes one by branching, implementing test-first, building and opening a PR. Hand it anything
else and it will try to do all of that to a decision.

Two kinds of real work fail that test and must not be numbered:

- **Unknowns that need resolving before anyone builds** — "can Debezium read our RDS instance?".
  The output is a decision, not a diff.
- **Work that isn't engineering** — staffing a rota, signing a DPA, procuring a licence.

Both go in an unnumbered **`## Resolve first`** above the milestones, each with who owns it and
which leaf it blocks. Unnumbered keeps them out of `/r:task-run`'s reach — it looks for
`### Phase N` — while leaving them where the reader will see them.

**Write each one as a `- [ ]` checkbox**, with `Owner:`, `Blocks:`, `Timebox:` and `Output:` on the
line below. The checkbox is what makes the entry closable: `/r:plan-run` gates on unticked entries,
and one written as a plain bullet can never be flipped, so it stops the phases it names forever.
`Blocks:` is the only edge — an entry that names no phase blocks the entire run list, since nothing
can tell what it was guarding. The shape is in
[references/design-contracts.md](references/design-contracts.md), and `/r:plan-unblock` is what
closes these: it probes what the repo can answer, puts the rest to a person, and stamps each entry
with what settled it.

## Step 6.5 — Codex challenges the plan

The draft is complete and nothing is on disk. Before the user sees it, have the **real Codex**
challenge it — a second reader with no stake in the decomposition.

**Only if Codex is installed.** It is the pack's one optional prerequisite, so resolve it first and
treat absence as a **named skip**, never a failure and never a stand-in:

```sh
C="$HOME/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs"
[ -f "$C" ] || C="$(ls -1d "$HOME"/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null | sort -V | tail -n1)"
[ -n "$C" ] && [ -f "$C" ] && echo "codex: $C" || echo "codex: absent"
```

Absent → skip the step, say so at the gate and in the report, record `codexReview: "skipped"`, and
carry on. A skipped review reported as a review is worse than none.

**Review the plan DOCUMENT, not a diff.** Run `/codex:rescue` with the draft and the rubric below.
Do **not** reach for `/r:code-adversarial` or its `run.sh`: those review a git diff, there is no
diff here, and running one from a Codex-backed context makes Codex re-enter the wrapper that
launches Codex. If `/codex:rescue` cannot collect the run, call the companion directly —
`node "$C" task --background --write=false --effort medium "<the rubric prompt>"` — as `task-run`
does for the same job and reason. `--background` is not optional: it is the only flag that hands
the run to a detached worker, and without it the CLI is killed along with the Bash call that
launched it, about two minutes in, leaving a job record stuck at `"status":"running"`.

**The rubric — five questions, fixed.** A fixed list makes two runs comparable and stops the review
wandering into prose style:

1. **Coverage** — does every story in the documents reach a leaf, and does the v1 line actually ship
   something usable?
2. **The graph** — is any leaf buildable only after something numbered later? Does any edge claim a
   dependency that isn't real, forcing work to be serial that needn't be?
3. **The contracts** — do the milestone `Design` sections contradict each other, the documents, or
   the existing code? Is any schema, endpoint or signature wrong for what it has to do?
4. **Self-containment** — pick leaves at random: could an implementer build one from *its own block
   alone*? Anything that silently needs the milestone above it is a defect.
5. **Buildability and size** — is anything numbered that produces a decision rather than a diff? Is
   any leaf too large for one session, or so small it should fold into a neighbour?

**Verify every finding before acting on it.** Codex has read the plan, not always the project. Check
each against the documents and the real code, and classify:

- **major + relevant** → **fix it**, and re-check what the fix touched. A wrong dependency edge, a
  contract that contradicts the schema, a story with no leaf, an item that cannot be built from its
  own block — these change what gets built and are worth a rewrite now, while nothing is on disk.
- **minor, or a matter of taste** → note it, do not rewrite. A plan churned over style costs a pass
  and changes nothing an implementer would notice.
- **not real** → dismiss it, with the reason.

**Carry all three lists out.** Raised, applied, dismissed — into the gate and the report. Drop them
and "Codex raised three majors and every one was dismissed" reads exactly like "Codex found
nothing" — opposite facts about the plan.

**The rubric stays at five on a rewrite.** Don't add a sixth about what was frozen: the freeze rule
is checked mechanically by `check_todo.py --against` in Step 7, and a rubric that changes by mode
stops two runs being comparable.

**Re-review once, and only if the decomposition changed** — a leaf added, removed or re-split, or an
edge moved. That catches a fix that opened a fresh hole. One bounded pass, never a loop until the
plan is flawless; then the gate, where a human reads it anyway.

## Step 7 — check it

Run it on the **draft**, where Step 1.5 put it — not on the real paths, which nothing has written
to yet:

```sh
python3 "${CLAUDE_SKILL_DIR}/scripts/check_todo.py" <draft>/todo.md \
    --spec docs/<topic>/spec.html \
    --design <draft>/design.md \
    --against docs/<topic>/todo.md      # rewrite only — the plan this one replaces
python3 "${CLAUDE_PLUGIN_ROOT}/skills/plan-unblock/scripts/resolve_scope.py" <draft>/todo.md --check
```

The second one is the `## Resolve first` half, and it runs **unconditionally** — deciding whether
that section is empty is the parse it exists to do. It exits 1 on any finding: an entry with no
checkbox, no `Owner:`, no readable `Blocks:`, a `Blocks:` naming a phase this plan does not have,
or a tick with nothing recording what settled it.

Fix everything it reports, then re-run. It catches stories with no leaf, leaves with no story,
missing "done when", oversized leaves, numbering gaps, files referenced before they are created,
**and the graph**: a missing `Depends on`, a cycle, a dependency on a higher-numbered leaf, a leaf
item that defers outside its own block, two leaves sharing a file inside one wave, and a `##
Waves` summary that has drifted from the edges. It prints the derived wave table either way.

`--design` checks the two files are one document: a milestone whose contracts nobody can find, a
contracts section for a milestone that doesn't exist, a name changed on one side only, and
contracts left inline while `design.md` sits beside them. Omit it on `--shallow`, which writes none.

`--against` is the mechanical guard on the freeze rule, and on a rewrite it is not optional. It
reports a frozen leaf that vanished or was retitled, one that was renumbered, a tick that was lost
or un-ticked, and a dropped `<!-- built: -->` marker. Where the previous plan had no `### Phase N`
numbering, it checks the one thing that plan did carry: that every ticked item survived. **A
finding here is never fixed by loosening the check** — it means the rewrite took something it was
not allowed to take.

Then four judgments a script can't make (five on a rewrite — add: does every frozen leaf still say
what was actually built?):

1. **Order** — could someone actually build leaf 3 with only 1 and 2 finished?
2. **Slices** — does each leaf leave the project working and demonstrable?
3. **Honesty** — is any "done when" a check you couldn't run today?
4. **Self-containment** — pick two leaves at random and read *only* their blocks. Could you
   implement them? That is exactly what `/r:task-run` sees.

## Step 8 — the gate

**Before writing anything to disk, show the decomposition and wait.** Milestones, leaf titles,
the graph, the wave table, **what Codex raised and what you did about it (Step 6.5)** — **and the
open design choices from Step 3.5** — then stop for a yes. Say plainly when the Codex review was
skipped for want of the plugin; an unreviewed plan and a reviewed-and-clean one must not look
alike at the one moment a human is deciding.

Both go in the same interruption because they are the same decision seen twice: a design choice
that changes the contracts usually changes which leaves exist. Ask the design questions with
`AskUserQuestion` where the options are discrete; each one carries your recommendation and what it
costs.

Every later pass hangs off the decomposition, and this is the cheapest moment to fix it: a
re-split before writing costs one message; after writing, the whole document. One gate, here, and
none after it.

**If the user declines, write nothing and go straight to Step 10** with `mode: "declined"` and the
counts you had drafted. A rejected decomposition is the outcome this skill most needs to see later,
and it is invisible if a declined run simply ends.

**On a rewrite the gate also carries the migration**, before the decomposition, because it is the
part that can destroy something:

```
Rewriting docs/billing/todo.md — found shape: packed (inline Design, no design.md)

  frozen    4   Phases 1–4 — ticked, carried through unchanged
  re-split  3   Phase 5 → Phases 5–7        (unbuilt)
  added     2   Phases 8–9 — "Export a statement" had no leaf
  dropped   1   old Phase 8 — the spec's v1 line no longer includes it
  inferred  6   3 × Depends on, 2 × Implements, 1 × milestone grouping
```

Read the `inferred` line out, item by item, not as a count: those are the claims nobody authored,
and the gate is the only place a human can refuse one. `dropped` needs the same — a leaf removed
because the documents changed is the right call; one removed because you missed it is invisible
unless named here.

`--shallow` gates the same way. With `--yes`, skip it.

## Step 9 — hand off

Move the draft into place **beside the documents** — `docs/<topic>/todo.md` and
`docs/<topic>/design.md` when the spec is `docs/<topic>/spec.html`. Never write a root `todo.md`
when the spec lives in `docs/`: a second plan with independent numbering is a trap.

On a rewrite, both files are replaced together. If the plan is tracked, leave it as a working-tree
change and say so — `git diff` is the best record of what the rewrite moved.

Report the leaf count, where the v1 line falls, the wave table, and anything you had to assume.
**Lead with `## Resolve first` if it isn't empty** — those block real leaves and need a person, so
offer `/r:plan-unblock docs/<topic>/todo.md` beside `/r:plan-run`: nothing else closes them, and
`/r:plan-run` will stop on them. On a
rewrite, repeat the migration counts and say which phase numbers moved, since anyone holding an
earlier `--from N` has a stale one.

Then the next command — the whole plan:

```
/r:plan-run docs/<topic>/todo.md
```

or one leaf on its own:

```
/r:task-run "docs/<topic>/todo.md / Phase 1"
```

**Name what the graph found.** If any wave holds more than one unbuilt leaf, say so and that they
can be built concurrently, one `/r:plan-run` session each — the return on writing the edges;
`/r:plan-run --dry-run` prints the exact commands.

## Step 10 — record the run

One line into the pack-wide store — counts only, never a document path, a milestone name or a leaf
title. **Record even when the user declines at the gate**, with `mode: "declined"`: a rejected
decomposition is the most informative row this skill can write, and dropping it leaves a store
where every plan was a good one.

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:spec-design","mode":"full","docsRead":0,"hadRequirements":false,
 "milestones":0,"leaves":0,"waves":0,"maxWaveWidth":0,
 "designChoicesAsked":0,"designChoicesRecorded":0,"checkerProblems":0,"openQuestions":0,
 "codexReview":"ran","codexRaised":0,"codexApplied":0,"codexDismissed":0,
 "inputShape":"none","leavesFrozen":0,"leavesResplit":0,"leavesAdded":0,"leavesDropped":0,
 "fieldsInferred":0}
STATS_JSON
```

`mode` is `full` | `shallow` | `rewrite` | `declined`, and it keeps the other numbers comparable: a
`--shallow` plan has no design pass, so counting its zero `designChoicesAsked` alongside a full
one's would report the bar as stricter than it is. A `rewrite` is a full run over an existing plan
— every field a `full` run has, plus the migration counts.

**What every remaining field is for** — the rewrite counts, `maxWaveWidth`,
`designChoicesAsked`, `codexReview`, `checkerProblems`, and the cross-skill pair against
`/r:plan-run` — is in [references/stats-fields.md](references/stats-fields.md). Read it while
filling the line in: a field written without knowing what question it answers gets a plausible
number instead of a true one.

The script always exits `0` — a lost row is a lost row, never a failed run, and it must never change
what was written. Never retry it.

## The downstream contract

Three things are load-bearing for `/r:task-run` and `/r:plan-run` and must not drift:

- GitHub-flavoured `- [ ]` checkboxes. Nothing else marks a task.
- Stable `### Phase N — title` headings, starting at 1, gap-free, no repeats. **This is the leaf**,
  and its heading shape is what both tools locate. A milestone is `##`, never `###`.
- **Only buildable work carries a `### Phase` heading.**

Everything else is for the human and the implementer's head start, not for a parser. `design.md`
is read by no tool — which makes moving the contracts there safe, and makes the `--design` check
the only thing that will ever notice it drifting.

## Never do this

- Never invent a story the documents don't contain, and never reword one — including from the
  free-text requirements, which say what to build first, never what to build.
- Never overwrite an existing plan. It is an input (Step 1.5) — found, classified and rewritten,
  with the draft kept to one side until the gate passes.
- Never renumber, re-split, retitle or un-tick a frozen leaf, and never drop one. `--against`
  reports all five, and a report there means the rewrite took something it wasn't allowed to.
- Never present an inferred milestone, edge or `Implements:` name as though someone authored it —
  every one is named at the gate. Never invent a `Done when:` to satisfy the checker.
- Never fake the Codex review, substitute an imitation of it, or report a skipped one as done.
  Never point it at `/r:code-adversarial` or a `run.sh` — those review a diff and there is none.
- Never apply a Codex finding without verifying it against the documents and the real code, and
  never rewrite the plan for a minor or stylistic one.
- Never silently resolve a design choice that met the Step 3.5 bar. Ask, or record the decision and
  its alternative in Open questions. Never both silently decide and leave no trace.
- Never re-decide the stack. The documents chose it.
- Never write `file:LINE` or a reuse map — those are `/r:task-run`'s planner's, written against
  real code.
- Never let a leaf item point at the milestone. The implementer cannot see it.
- Never write a leaf whose "done when" nobody can run.
- Never number work that isn't buildable — a decision or a signature goes in `Resolve first`,
  as a `- [ ]` checkbox with a `Blocks:` line. An entry nobody can tick blocks its phases
  forever, and one that names no phase blocks the whole plan.
- Never omit `Depends on:`. Without the graph nothing can be built concurrently and nothing checks
  the order.
- Never renumber leaves per milestone, and never start at 0.
- Never hand-edit the `## Waves` summary — it is generated from the edges, and the checker compares
  them.
