---
description: >-
  Walk a phased build plan unit by unit — a phase, a few related phases, or a milestone — and for
  each one look for a simpler way to deliver it, or a reason it is not needed at all. Every item
  must trace to the spec, and every safeguard (retry, circuit breaker, rate limit, idempotency,
  cache, edge-case branch) must name the concrete trigger in this system that justifies it; "best
  practice" alone is not one. Asks one AskUserQuestion per unit — simplify, delete or keep — then
  shows the whole changed plan and writes it only after a yes. An unbuilt unit is rewritten or
  deleted (deletions go to a `## Deferred` list); a built one is never edited — a new phase
  simplifies or removes it. Reads todo.md + tech-design.md from /r:spec-design; runs inside
  /r:spec-design before its Codex challenge, and deliberately as "/r:plan-simplify". NOT for
  writing the plan (/r:spec-design), building it (/r:plan-run) or refactoring code now
  (/r:code-refactor).
model: opus
effort: high
disable-model-invocation: true
---

# plan-simplify

**The goal: the simplest plan that fully and correctly implements the spec.** Not the safest-looking
one, not the most complete one — the minimum that delivers every story, built well. Two failures sit
on either side of it, and both are defects:

- **Over-engineering** — a phase, a retry, a breaker, an extra status code, an edge-case branch, a
  config flag that nothing in this system needs. It costs build time, review time and a larger
  surface for bugs, and it is what a plan drafted from a spec drifts toward.
- **Under-building** — a cut that takes a story, a test, a named error or a safeguard this system
  does need. A smaller plan that ships a bug is not simpler, it is wrong.

So the burden of proof is on the plan: **every phase has to show why it is there, and why it is not
simpler.** The user decides every change, one unit at a time.

## Invocation

`/r:plan-simplify [<plan>] [<doc>...] [--yes]`

- **`<plan>`** — the `todo.md` to review. Omitted, it is found where `/r:plan-run` looks:
  `docs/*/todo.md` (several → ask which), then `todo.md`, `PLAN.md` at the root.
- **`<doc>...`** — the documents the plan was derived from. Omitted, the `spec.html` beside the plan
  plus any document the plan's header names.
- **`--yes`** — take every recommendation without asking (Steps 4 and 6). Every deletion still lands
  in `## Deferred`, so nothing is lost and every decision stays visible.

**Embedded** — `/r:spec-design` reads this file and follows it over its draft before its Codex
challenge. The caller hands over the draft directory, the documents and the requirement inputs it
already extracted. Steps 1–3 and 5 run as written; **Step 4 runs silently**. A fresh plan has
nothing built, every change is free to undo, and the user already answered the design questions —
so a question per unit would be a second interview about a draft nobody has seen. Apply the
recommendation for every **clear** unit yourself: one that traces to no ledger entry, or a safeguard
with no trigger. Ask with `AskUserQuestion` only the **unclear** ones — the documents half-ask for
it, a whole milestone would go, or the readers disagree. The final review (Step 6) folds into the
caller's gate, where the user sees every change with its reason and can bring any of them back; the
checker, the write and the stats row are the caller's. Return the decisions per unit with their
reasons, which were applied silently and which were asked, the kept units, the dismissed findings and
the questions.

## Step 1 — read the plan, the documents and the code

Read `todo.md`, the `tech-design.md` (or `design.md`) beside it, and every document. No documents at
all → the plan's own checklist items stand in for the requirements, and the final review says so.

**Mark what is built.** A phase is built when it carries a `- [x]` item, a `<!-- built: … -->`
marker, or is already under way: a `.task-plans/*.md` plan whose source names that phase and whose
`status:` is not `done`. A started phase counts because its branch is building what the plan says
now. A built phase keeps its number, title, ticks and ticked wording exactly — it is the record of
what shipped.

**Build the requirements ledger before judging anything** — while nothing argues for a cut yet:

- every user story by name, and what its acceptance asks;
- every explicit "must" in the documents — a validation rule, an error response, a security or
  privacy rule, a limit;
- every ADR consequence the spec accepted;
- the architectural characteristics and the number each one sets;
- every external system the product talks to, and what its documentation says it does (retries a
  webhook, returns 429, can hang);
- the v1 line.

The ledger separates **what the spec asks for** from **what the plan added**. Only the second is
open to a cut here; disagreement with the first is a question, never a cut.

**In an existing codebase, find the reuse index** — the doc `/r:reuse-index` writes, linked from the
root `CLAUDE.md` or under `docs/` — and pass it to the explorer.

## Step 2 — group the plan into units

A **unit** is what one question is about: usually one phase; a few phases that only make sense
together (a schema, the service on it and the endpoint over it); or a whole milestone when the
question is whether that area is needed at all. Group by what a single decision covers — never mix
built and unbuilt phases in one unit, since the two take different actions.

## Step 3 — two fresh readers, in parallel

Dispatch both in **one message** with the `Agent` tool, `subagent_type: "general-purpose"`, each
handed the ledger, the units, the built list and the absolute path of
[references/rubric.md](references/rubric.md) (`${CLAUDE_SKILL_DIR}/references/rubric.md`), told to
follow its section for that role:

- **Plan reviewer** — for every unit: does it trace to the ledger, does every safeguard in it have
  a trigger, and what is the simplest shape that still meets what it traces to.
- **Code explorer** — only when the repo has code. For an unbuilt unit, what existing code already
  does part of it; for a built unit, whether the code it landed is over-built.

They are separate readers because the context that wrote a plan defends its own decomposition, and
because exploring code fills a context the plan judgement does not need.

**No `Agent` tool → stop with `blocked: no-agent`** and say so. Reviewing inline in the same context
is the single-reader run this step exists to avoid. Embedded, return the block to the caller.

A reader that returns nothing is a **named gap**, never "no findings".

**Verify before asking.** The readers propose; you check each proposal against the ledger, the
documents and the code. Drop what is not real — a misread, a reuse candidate whose semantics differ,
code that does not exist — and keep the reason for the final review. A proposal that would cut what
the documents ask for is not a cut but a **question** for the spec, recorded in Open questions.

**The trigger test is the heart of it.** A safeguard is justified by a fact about *this* system, not
by being good practice in general: a circuit breaker on a user-facing call to an external service
that can hang has one; on an internal call it does not. Rate limiting on a public endpoint has one;
on an admin endpoint behind auth it does not. The rubric has the table. A trigger you cannot point at
— in the ledger, an external system's documentation, or the code — does not exist.

**Never proposed for removal:** a story's main path and anything its acceptance names; an error,
validation or limit the documents name; authentication and access checks; data integrity where data
or money could be lost; a safeguard whose trigger holds; a test for behaviour that stays — tests go
only with the behaviour they covered. A rare case with no trigger **fails loudly** instead of being
handled: a clear error, never a silent continue on bad data.

## Step 4 — one question per unit

For every unit with a verified proposal — only the unclear ones when embedded — ask with
`AskUserQuestion` — up to four units per call, in
plan order, as many calls as it takes. A unit with nothing to propose is not asked; it appears in the
final review as unchanged.

**Print a brief before each call.** One opening line: what this pass checked, how many units, and
what it already applied or will apply. Then one short block per unit the call asks about: what the
unit is in plain words — explain every code, column or class name ("`mpOperCode` is the bank's
code for the type of payment") — what the plan does today, what the readers found, and which
option you would take and why. A bare question with a code name in its header cannot be answered;
the brief gives the premise, and the call carries the choice.

Each question names the unit in plain words and says in one or two short sentences what the readers
found, so it still makes sense after the brief scrolls away. The options, recommended first and
labelled `(Recommended)`:

- **Simplify** — the description says what the simpler shape is and what goes.
- **Delete** — only when the unit traces to nothing the spec asks for.
- **Keep as is.**

Offer only the options the readers' findings support: a unit that traces to a story has no Delete; a
unit that is justified but over-built has Simplify and Keep. Each `description` says what that
option does and what it costs, in one or two short sentences on one line — what a v1 user sees
after it where that is the point, e.g. "a clear 502 instead of a silent retry". The current plan is
described once, in the brief, never repeated inside every option. No `Now:` / `Change:` labels and
no line breaks: the tool shows one as a broken character. Use `preview` when the choice is between
two shapes of the same contract.

Write in plain English at B2 level: sentences of 15 words or fewer, the real names kept, no plan
shorthand without its meaning. A question the user has to read twice gets "whatever you think", and
the decision is then made by nobody.

## Step 5 — draft the decisions

Work on a draft: the caller's directory when embedded, otherwise copies of `todo.md` and
`tech-design.md` in a scratch directory. The real files stay byte-identical until Step 7.

**An unbuilt unit:**

- **Simplify** → rewrite its phases in place: items, `**Files:**`, `**Depends on:**`, the contracts
  in `tech-design.md`. A rewritten phase stays inside 5–12 items and one session's work; phases left
  too thin merge into a neighbour. Reuse is written by type or module name, never `file:LINE`.
- **Delete** → remove its phases and their contracts, rewire every edge that pointed at them, and add
  one plain bullet per phase to **`## Deferred`** — what it was and why it went. The section sits
  above the first `## Milestone`, beside `## Resolve first`, in plain bullets, never `- [ ]`: nothing
  under it is work, and a checkbox would read as a task. It is how a deletion stays recoverable.

**A built unit is never edited.** **Simplify** or **Delete** becomes a **new phase** that does it:

```markdown
### Phase 14 — Simplify payout retry handling
**Implements:** Replay a payout safely
**Depends on:** Phase 6 · Phase 7
**Files:** `.../PayoutRetryPolicy.java` (delete) · `.../PayoutService.java`
**Risk:** money + persistence
- [ ] `PayoutService` retries through the existing `RetryTemplate` bean; `PayoutRetryPolicy` and its factory are deleted
- [ ] `PayoutRepositoryIT` and `PayoutWebhookIT` stay green with no change to their assertions
**Done when:** `mvn -pl payments test` is green.
```

- **Implements** — the story names of the built phases it changes, verbatim.
- **Simplify keeps behaviour** — the landed tests stay green with their assertions unchanged, except
  tests of an internal mechanism the phase removes. **Delete** removes the feature, its tests and its
  migrations forward (a new migration, never an edited one).
- **Placed at the end of the plan**, in the last milestone that still has unbuilt phases, or a new
  `## Milestone N — Simplification` when every milestone is built. **Except** when an unbuilt phase
  builds on that code: then the new phase goes just before it, and that phase depends on it — so it
  is not first built on the complex code and simplified a second time.
- Never placed in a fully built milestone: that reopens a milestone `/r:plan-report` may already
  have written up.

**Renumber unbuilt phases only**, above the highest built one, keeping every dependency
lower-numbered. Keep an old → new map for the final review.

Then check the draft — standalone only; embedded, the caller checks the same draft:

```sh
python3 "${CLAUDE_PLUGIN_ROOT}/skills/spec-design/scripts/check_todo.py" <draft>/todo.md \
    --spec <spec> --tech-design <draft>/tech-design.md --against <the original todo.md>
python3 "${CLAUDE_PLUGIN_ROOT}/skills/plan-unblock/scripts/resolve_scope.py" <draft>/todo.md --check
```

`--against` guards the built phases and `--spec` the coverage. **A finding is never fixed by
loosening a check** — it means a decision took something it was not allowed to; undo that change and
tell the user which answer it was.

## Step 6 — the final review

Show the whole changed plan in one message:

- **deleted** — each unbuilt phase, now in `## Deferred`, with its reason;
- **rewritten** — each simplified phase, what went and what stayed;
- **added** — each new phase for a built unit, and where it sits;
- **kept** — each unit you asked about and the user kept, and each one a reader flagged that turned
  out justified, with the trace or trigger;
- **dismissed** — each reader finding dropped in verification, with its reason;
- **questions** — the trades only a change to the spec can make;
- **renumbered** — the old → new map, and the phase count before and after.

Then ask with `AskUserQuestion`: **Apply** (recommended) · **Change an answer** · **Cancel**. Change
an answer re-asks those units, re-drafts and comes back here. Cancel writes nothing and goes to Step 8
with `mode: "declined"`. `--yes` skips the question.

## Step 7 — write

Replace `todo.md` and `tech-design.md` together, add the questions to the plan's Open questions, and
leave both as working-tree changes — `git diff` is the record of what changed. Then say which phase
numbers moved — an earlier `--from N`, or a `/r:plan-run` already running on this plan, holds stale
numbers and has to be restarted — and give the next command, `/r:plan-run <plan>`.

## Step 8 — record the run

Counts only, never a path or a title. Always, including a cancel or a block:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:plan-simplify","mode":"applied","phasesBefore":0,"phasesAfter":0,"phasesBuilt":0,
 "units":0,"unitsAsked":0,"simplified":0,"deleted":0,"keptByUser":0,"phasesAdded":0,
 "dismissed":0,"questions":0,"checkerProblems":0,"readers":2}
STATS_JSON
```

`mode` is `applied` | `declined` | `blocked`. Read `keptByUser` against `unitsAsked`: a user who keeps
most units is being asked about things with real reasons the readers missed, and the rubric is too
aggressive; one who accepts everything while the plans still feel heavy means the readers are too
timid. The script always exits 0; never retry it.

## Never do this

- Never change a unit the user has not answered for, except under `--yes`, and never write before
  the final Apply.
- Never edit, renumber, retitle or un-tick a built phase — a new phase does the change.
- Never offer Delete for a unit that traces to a story, and never cut what the documents ask for —
  that is a question for the spec.
- Never keep a safeguard on "best practice" alone, and never cut one whose trigger holds.
- Never drop a test while the behaviour it covers stays, a named error, an access check or a
  data-integrity guard.
- Never lose a deleted phase — it goes to `## Deferred`.
- Never cite `file:LINE`, and never accept a reuse proposal nobody verified in the code.
- Never review in the caller's context when the `Agent` tool is missing — stop and say so.
