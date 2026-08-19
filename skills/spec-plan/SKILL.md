---
description: >-
  Turn an existing written specification into a phased implementation plan (todo.md) that
  /r:task-run can execute one phase per session. Reads a spec — docs/<topic>/spec.html from
  /r:spec-brainstorm, or any spec markdown or design doc you point at — extracts its user stories,
  structure and risks, and writes phases with stable numbering, real file paths, and a runnable "done
  when" check. Stack-agnostic: it follows whatever the spec already decided. Use when the user
  says "turn this spec into a plan", "phase this out", "break the spec into tasks", "make a todo
  from the spec", "what's the build order", "/r:spec-plan", or right after /r:spec-brainstorm
  produces a spec. NOT for writing the spec itself - that's /r:spec-brainstorm; NOT for
  implementing the work - that's /r:task-run.
model: opus
effort: high
---

# Spec to todo

Read a specification, write `todo.md` next to it. The spec already made the decisions — your job is build
order, not design. If you find yourself inventing a story, stop and put it in Open questions instead.

## Step 1 — find and read the spec

In priority order: a path the user gave you · `docs/<topic>/spec.html` · `docs/*.md` (if several, ask which) ·
`spec.md`, `PROJECT.md`, `DESIGN.md` at the repo root.

If nothing exists, say so and point at `/r:spec-brainstorm` rather than inventing a spec to plan against.

Read it in full and pull out:

- **User stories, by name.** In a spec from `/r:spec-brainstorm` these are the `<h3>` headings inside the User
  stories section, and the name is the handle — carry it verbatim. In some other document they may be numbered
  requirements or a capability list; take whatever that document uses as its unit of scope and say which. These
  become the traceability spine.
- **The modules and the stack**, with versions. You follow them; you don't re-decide them.
- **The domain model** — every entity needs a migration somewhere in the plan.
- **The API** — every endpoint, command or screen needs a phase that builds it.
- **Risks** — any whose mitigation is "investigate" goes to `## Resolve first`, not a phase.
- **The v1 line** — which stories ship first and which are deferred.

**In an existing codebase, read the code too** before writing any phase: build files for real dependency
versions, the migration folder for the real schema, the package layout, `CLAUDE.md`, and two existing tests to
copy their style. A phase that names a file that doesn't exist, or invents a module that contradicts the
layout, costs the implementer more than it saves.

## Step 2 — build the phase list

Work backwards from the v1 line: what is the smallest run of phases that delivers a usable end-to-end result?
Then order by dependency — a phase only relies on what earlier phases produced.

Prefer **vertical slices** that leave the project working and verifiable over horizontal layers that don't run
on their own. "Add the users table, the repository, the service and the endpoint, with a test that hits it" is
a phase. "Add all the entities" is not.

Size each phase to one focused session: **5–12 checklist items, roughly ≤400 lines of new code, one to three
slices.** A session has finite context; a phase that overflows it loses the thread and ends half-done. If a
phase sprawls across many subsystems, split it. If it's one trivial edit, fold it into a neighbour.

**The story count sets the size, not a band you pick.** Roughly one to two phases per story, plus what the
stories don't cover on their own — the first schema, the deployment, the seams between modules. Past about 20
phases, group them under named milestones so the list stays readable.

If v1 comes out much larger than the rest of the plan, say so in one line and name the phase you'd push to v2.
Don't silently oversize phases to make a count work, and don't overrule what the spec says the user confirmed.

## Step 3 — write the phases

```markdown
### Phase 4 — Idempotent payout webhook
**Implements:** Accept a payout webhook · Replay a payout safely
**Files:** `payments/src/main/java/.../PayoutWebhookController.java` (new) ·
          `.../PayoutService.java` (modify) · `db/migration/V7__payout_idempotency.sql` (new)
**Risk:** money + persistence → run with `--full`
- [ ] `payout_idempotency` table with a unique index on `(merchant_id, idempotency_key)`
- [ ] Controller returns `200` plus the original id on replay
- [ ] `PayoutWebhookIT` covers first call, replay, and concurrent double-post
**Done when:** `mvn -pl payments test -Dtest=PayoutWebhookIT` is green and a repeated
`curl -X POST /webhooks/payout -H 'Idempotency-Key: k1'` returns the same `payoutId`.
```

- **Implements** — required, and **story names verbatim**, separated by ` · `. Every story in the spec maps to at
  least one phase, and every phase names at least one story. Exact strings: `check_todo.py` matches them against
  the spec, so a paraphrased or reworded name reads as a story with no phase. This is what keeps the spec and
  the plan one artefact instead of two that drift.
- **Done when** — required. A runnable command or an observable response. "The feature works" is not a check.
  If you can't write a command, the phase is too vague to start.
- **Files** — required when the codebase already exists, where real paths save the implementer its first ten
  minutes. Optional for greenfield, where the files don't exist yet.
- **Risk** — include only when the phase touches **auth, money, persistence, concurrency or security**, because
  those are the surfaces `/r:task-run` escalates on. Omit it rather than writing "Risk: low".
- **Depends on** — only when the order isn't obvious from the numbering.

Tasks name real files, components and endpoints from the spec — never "set up the thing", never "implement the
service".

## Step 4 — what is a phase, and what isn't

**A numbered phase is work a coding agent can build and verify.** Code, schema, config, infrastructure — with
a check you can run. That is the entire contents of the phase list, because `/r:task-run` executes a phase by
branching, implementing test-first, building, and opening a PR. Hand it anything else and it will try to do
all of that to a decision.

Two kinds of real work fail that test and must not be numbered:

- **Unknowns that need resolving before anyone builds** — "can Debezium read our RDS instance?", "does the
  vendor's API support partial refunds?" The output is a decision, not a diff.
- **Work that isn't engineering** — staffing an on-call rota, signing a data-processing agreement, procuring a
  licence. Real, blocking, and not a pull request.

Both go in an unnumbered **`## Resolve first`** section above the phase list, each with who owns it and which
phase it blocks. Unnumbered keeps them out of `/r:task-run`'s reach — it looks for `### Phase N` — while leaving
them where the person reading the plan will see them. An unknown that appears nowhere is how a plan silently
fails; an unknown disguised as a build phase is how an agent wastes a session.

```markdown
## Resolve first
- **Debezium against RDS** — can it read our instance, or do we need a polling fallback?
  Owner: platform. Blocks: Phase 4. Timebox: one afternoon. Output: a line in the spec's Risks & assumptions.
```

Then group the phases under two headings: **v1 (MVP)** is the smallest run delivering a usable end-to-end
result; **Advanced** holds everything deferred. Numbering starts at 1 and runs continuously across both —
restarting at the Advanced heading makes "Phase 3" ambiguous and gets the wrong boxes ticked.

## Step 5 — check it

```
python3 <this skill>/scripts/check_todo.py docs/<topic>/todo.md --spec docs/<topic>/spec.html
```

Fix everything it reports, then re-run. It catches stories with no phase, phases with no story, missing "done
when", oversized phases, numbering gaps, and files referenced before they're created.

Then four judgments a script can't make:

1. **Order** — could someone actually do phase 3 with only phases 1 and 2 finished?
2. **Slices** — does each phase leave the project in a working, demonstrable state?
3. **Honesty** — is any "done when" a check you couldn't actually run today?
4. **Buildability** — is every numbered phase something a coding agent can branch, implement and open a PR
   for? Anything answered by a decision, a conversation or a signature belongs in `## Resolve first`.

## Step 6 — hand off

Write to `todo.md` **beside the spec** — `docs/<topic>/todo.md` when the spec is `docs/<topic>/spec.html`.
Never write a root `todo.md` — a second plan with independent numbering is a real trap.

Report the phase count, where the v1 line falls, the total in sessions, and anything you had to assume.

**Lead with `## Resolve first` if it isn't empty** — those block real phases, and they need a human, not an
agent. Say which phase each one blocks.

Then the next command:

```
/r:task-run "docs/<topic>/todo.md / Phase 1"
```

noting that phases flagged money, auth, persistence, concurrency or security should run with `--full`. Only
numbered phases go to `/r:task-run`; nothing under `Resolve first` does.

For the whole plan rather than one phase, name `/r:plan-run docs/<topic>/todo.md` instead: it runs every
unticked phase in the order you numbered them, reads each phase's `Risk:` for the review tier and runs its
`Done when:` after the review, and stops at the first phase that fails rather than building the next one on
top of it. That is what makes the three required fields above worth writing — `Risk:`, `Done when:` and the
`- [ ]` checklist are read straight off the page by the runner, not re-derived.

## The downstream contract

`/r:task-run` locates a phase, takes its checklist as acceptance criteria, and ticks the boxes it verified. Three
things are load-bearing for that and must not drift:

- GitHub-flavoured `- [ ]` checkboxes. Nothing else marks a task.
- Stable `### Phase N — title` headings, starting at 1, gap-free, no repeats.
- **Only buildable work carries a `### Phase` heading.** That heading is what makes `/r:task-run` pick something
  up, so it is also the line between "an agent can do this" and "a person must".

Everything else in the template is for the human and the implementer's head start, not for a parser.

## Full shape

```markdown
# [Project/Feature Name] — Implementation Plan

Spec: `spec.html` · Status: draft
Each phase is scoped to roughly one Claude Code session. Phases 1–7 deliver v1.
Everything under "Resolve first" needs a person, not `/r:task-run`.

## Resolve first
- **[the unknown or the non-engineering task]** — [what answering it settles]
  Owner: [who]. Blocks: Phase [n]. Output: [where the answer lands]

## v1 (MVP)

### Phase 1 — [short goal]
**Implements:** [story name] · [story name]
- [ ] [concrete task]
**Done when:** [runnable check]

## Advanced

### Phase 8 — …
```

## Never do this

- Never invent a story the spec doesn't contain, and never reword one. Put anything missing in Open questions
  and say so.
- Never re-decide the stack. The spec chose it.
- Never write a root `todo.md`.
- Never write a phase whose "done when" nobody can run.
- Never number work that isn't buildable — a decision, a conversation or a signature goes in `Resolve first`.
  `/r:task-run` will branch, write tests and open a PR for whatever carries a `### Phase` heading.
- Never name a file that neither exists nor is created by an earlier phase.
- Never restart phase numbering at the Advanced heading, and never start it at 0.
