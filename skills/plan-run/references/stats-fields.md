# What each field in the stats line means

`SKILL.md` Step 4 carries the command and the `mode` vocabulary — the field that makes every other
number readable. This file is the rest: what each remaining field is for, and what reading it is
supposed to settle. Read it while filling the line in — a field written without knowing what
question it answers is a field that gets a plausible number instead of a true one.

## Contents

1. Count what this run did, leave the rest at zero
2. Reading the concurrent flow across rows
3. `haltReason`
4. `doneCheckFailed`

**Count what this run actually did, and leave the rest at zero.** A `no-merge` session sets
`phasesInRun` and `merged: 0`; a `land` pass sets `landed` and leaves `phasesInRun: 0`, because it
builds nothing. A `dry-run` sets `phasesInPlan` and nothing else.

**So read the concurrent flow across rows, never within one.** A wave built in three sessions and
landed from the primary tree is *four* rows — three `no-merge` and one `land` — and no single one of
them holds both halves. A `cmux` row is that same shape seen from the orchestrator: it spawned the
sessions and landed what they built, so it sets `landed` and leaves `phasesInRun` at zero, and the
three units it spawned write their own `no-merge` rows through the hook. Counting the orchestrator's
wave *and* its units would double every phase in it. The question "how far does a plan survive contact with the code" is
`phasesInRun` against `merged + landed` **summed over a plan's rows**; asked of one row it reads as
a string of failures. This is the one metric here that a naive per-row average gets backwards.

**`haltReason` is why, where `haltedAt` is only which phase.** A closed vocabulary, so it can be
counted: `implement-stopped` | `review-blocked` | `tracks-blocked` | `build-red` | `done-when-failed`
| `merge-conflict` | `dirty-base` | `recheck-blocked` | `slice-refused` | `workflow-unavailable`.
The one worth separating from all the others is `review-blocked` — a review that ran and left part of
the diff unread is a different failure from a build that went red, and it is the one that would
otherwise have merged.

**`doneCheckFailed` is the point of having a `Done when:` at all.** `doneCheckRan` says the command
executed; only `doneCheckFailed` records the case the step exists for — a phase whose review passed
and whose own check did not. If that number stays zero across many runs, the check is costing a
command per phase and catching nothing; if it does not, it is catching what no reviewer could.
`alreadyDone` justifies the per-phase re-check the same way.
