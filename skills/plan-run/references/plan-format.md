# The plan format — what this skill reads, and what it writes back

`/r:plan-run` executes a plan file. `/r:spec-design` writes the canonical shape, but a plan written by
hand or by another tool is executable too, and the difference between them is entirely how much a
phase block states versus how much has to be classified. This file is the whole of that contract.

## The phase block

```markdown
### Phase 4 — Idempotent payout webhook
**Implements:** Accept a payout webhook · Replay a payout safely
**Files:** `payments/.../PayoutWebhookController.java` (new) · `.../PayoutService.java` (modify)
**Risk:** money + persistence
**Depends on:** Phase 3
- [ ] `payout_idempotency` table with a unique index on `(merchant_id, idempotency_key)`
- [ ] Controller returns `200` plus the original id on replay
- [ ] `PayoutWebhookIT` covers first call, replay, and concurrent double-post
**Done when:** `mvn -pl payments test -Dtest=PayoutWebhookIT` is green.
```

| field | required | what this skill does with it |
|---|---|---|
| `### Phase N — title` | **yes** | the unit of work, and `N` is the handoff string's identity |
| `- [ ]` items | **yes** | acceptance criteria — the implement Workflow lifts them itself |
| `**Done when:**` | no | run it after the review (Step 3.5); prose with no command is a named skip |
| `**Risk:**` | no | present → `profile: "full"`; **absent → omit `profile`**, never "low" |
| `**Files:**` | no | context for the re-check, and what `--slice` compares; never a constraint on where the change may land, and **rewritten from the diff** when the phase commits |
| `**Implements:**` | no | carried into the task intent, so a later fixer doesn't undo it |
| `**Depends on:**` | no | read it, but the numbering is what orders the run |

**Only a `### Phase N` heading makes something buildable.** That is the line between "an agent can do
this" and "a person must", and `/r:spec-design` puts everything on the wrong side of it under
`## Resolve first`. Never promote an unnumbered entry into the run list, and never number one
yourself.

**`## v1 (MVP)` and `## Advanced` are readability headings, not scopes.** Numbering runs continuously
across both, so `Phase 8` is unambiguous whichever heading it sits under. Use `--to` to stop at the
v1 line; never renumber and never restart a count at a heading.

## What counts as done

- **A phase is done when every one of its `- [ ]` items is ticked.** A partly-ticked phase is a phase
  an earlier run left half-finished, and it goes back in the run list — the implement Workflow reads
  the whole block, so a resumed phase re-reads criteria that are already satisfied and the code
  already proves it.
- A ticked phase **heading** (`### Phase 4 — … ✅`, `- [x]`-style markers, `~~struck through~~`) is
  respected too, but the items are what decide. A heading marked done over unticked items is a
  disagreement — trust the items and say so in the report.
- `--from N` overrides all of this in **one** direction: it may re-run a phase whose items are ticked,
  because the user asked for exactly that. It never resurrects a phase before `N`.

## Handing a phase to the implement Workflow

`task-run-implement.workflow.js` resolves a source string. For a phase it is:

```
<path> / Phase <n>
```

```
docs/billing/todo.md / Phase 4
```

The workflow reads the file, locates the block, and lifts the checklist into `criteria[]` and the
heading into the task intent, `kind: "todo"`, branch `phase-<slug>`. **Hand it that string, never the
phase body** — a body pasted in as free text is read as `kind: "text"`, whose entire contract is that
criteria are left empty for the planner to derive. Everything the plan author wrote down is lost in
exactly the case where the most was written down.

The shape matters for a second reason: `<path> / <something>` is also how a *list item* is handed
over, and the workflow disambiguates the two. `Phase <n>` is what makes it read the block rather than
one checklist line, so keep the literal word `Phase`.

The workflow never ticks anything. The caller owns write-back, because only the caller knows whether
the review passed, the done-check ran and the merge landed.

## Writing back

After the review returns, the `Done when:` check has run and the branch is confirmed, before staging:

- Flip **only the items that were implemented and verified**, `- [ ]` → `- [x]`. A phase that
  half-landed leaves half its boxes ticked, and that is the honest record — never tick an item to
  make a phase look finished.
- When every item is ticked, mark the heading too, and append the branch so the plan says where the
  change went:

  ```markdown
  ### Phase 4 — Idempotent payout webhook <!-- built: phase-idempotent-payout-webhook -->
  ```

- **Replace the `Files:` line with what the phase actually touched**, from the branch rather than
  from memory:

  ```sh
  git diff --name-only "$base...$pb"
  ```

  Drop generated artefacts — anything under `.claude/` or a `testdata/` segment, and any `.golden`
  file — the same paths the collision check ignores, for the same reason: a captured frame is
  rewritten wholesale by whichever run touched it last, so two phases sharing one have no conflict,
  and the volume of them buries the source files that do.

  This is a **measurement replacing a guess**, which is why it overwrites rather than appends.
  `Files:` was written before any of this code existed, so it names the files a feature *carries* —
  the new ones a planner can foresee — and never the ones it must touch to be wired in. Those are
  unknowable until there is an app to wire into. The gap is not small: one phase declared three files
  and changed eleven, and the eight it did not declare were the hub files every other phase in that
  package also reaches.

  It is corrected here because **nothing else can**. The line is what `check_todo.py --slice` reads
  to decide whether two phases may run at once, and a slice cleared from an understated line is a
  wave that builds for hours and then will not merge. A phase that has just built is the only thing
  in the pipeline that knows the true answer, and this is the only moment it is still holding it.

  A phase whose plan carried **no** `Files:` line gains one. A phase that halted writes nothing —
  a partial footprint is worse than none, because it reads as measured.

- **Idempotent**: an item already ticked, or a heading already carrying the marker, is left exactly
  as it is. The `Files:` line is the one exception: it is rewritten from the diff every time the
  phase commits, since a re-run that changed the footprint has changed the answer.
- Re-locate every item by its **verbatim text**, never by a line number read at parse time — the
  number stops being true the moment anything edits the file. If the text is gone because someone
  edited the plan mid-run, **do not guess**: leave the file alone and report the phase as
  built-but-unticked, naming it.
- Never restructure the document. No reflowing, no moving a phase under a different heading, no
  renumbering, no tidying a checklist someone wrote by hand.
- The ticks are staged into the phase's single commit, so "built" and "done" revert together. When
  the plan lives **outside the repo, or untracked**, there is no commit to fold them into: edit it in
  place and say so in the report, because that is the one case where reverting the phase leaves the
  plan claiming the work is still there.
- `--dry-run` writes nothing, ever. A halted phase writes nothing either.

## A hand-written plan

A plan that is only headings and checkboxes still runs. What it loses is specific and worth naming to
the user once, at the gate, rather than discovering per phase:

- **No `Risk:` anywhere** → every phase is classified from the code by the implement Workflow. That is
  the normal path, not a degradation — the classifier reads more than a plan line does.
- **No `Done when:`** → the review is the only gate. It certifies the diff is sound; nothing checks
  the phase delivered what it was for. Record every phase as *done-check skipped* so the report says
  which certainty the run actually bought.
- **No `Files:`** → the per-phase re-check has less to compare against and answers "already done?" on
  weaker evidence. Still worth running; just believe an `already-done` verdict a little less.
- **Numbering gaps or repeats** → a hard stop, because `Phase <n>` is the handoff string and an
  ambiguous `n` sends the implementer at the wrong block. This is one of the two things
  `check_todo.py` reports that this skill refuses to run through.
