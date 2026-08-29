# What each field in the stats line means

`SKILL.md` Step 4 carries the command and the `mode` vocabulary — the field that makes every other
number readable. This file is the rest: what each remaining field is for, and what reading it is
supposed to settle. Read it while filling the line in — a field written without knowing its
question gets a plausible number instead of a true one.

## Contents

1. Count what this run did, leave the rest at zero
2. Reading the concurrent flow across rows
3. `haltReason`
4. `degraded` and `questionsQueued`
5. `doneCheckFailed`

**Count what this run actually did, and leave the rest at zero.** A `no-merge` session sets
`phasesInRun` and `merged: 0`; a `land` pass sets `landed` and leaves `phasesInRun: 0`, since it
builds nothing; a `dry-run` sets `phasesInPlan` and nothing else.

**So read the concurrent flow across rows, never within one.** A wave built in three sessions and
landed from the primary tree is *four* rows — three `no-merge` and one `land` — and no single one of
them holds both halves. A `cmux` row is that same shape seen from the orchestrator: it spawned the
sessions and landed what they built, so it sets `landed` and leaves `phasesInRun` at zero, while
the units write their own `no-merge` rows through the hook; counting the orchestrator's wave *and*
its units would double every phase in it. The question "how far does a plan survive contact with
the code" is `phasesInRun` against `merged + landed` **summed over a plan's rows**; asked of one
row it reads as a string of failures — the one metric here a naive per-row average gets backwards.

**`haltReason` is why, where `haltedAt` is only which phase.** A closed vocabulary, so it can be
counted: `implement-stopped` | `review-blocked` | `tracks-blocked` | `build-red` | `done-when-failed`
| `merge-conflict` | `dirty-base` | `recheck-blocked` | `slice-refused` | `workflow-unavailable`.
The one worth separating from the others is `review-blocked` — a review that ran and left part of
the diff unread is a different failure from a red build, and the one that would otherwise have
merged.

**`degraded` and `questionsQueued` are what `--unattended` costs.** `degraded` counts the
workarounds it took — a dirty base snapshotted, a conflict auto-resolved, a wave built serially
because the preflight refused it — and `questionsQueued` the things it declined to stop for. Read
them against `merged`: five phases merged with one degrade is the flag working; six degrades is a
plan or a repo that needs attention rather than more autonomy.
`unattended` is the boolean that makes the pair readable, because zero means "nothing to work
around" in an unattended run and "the flag was never passed" in every other one.

A degrade is never a halt, so `haltReason` stays null when the run finished: what a `--unattended`
run works around is precisely what it does not halt on.

**`doneCheckFailed` is the point of having a `Done when:` at all.** `doneCheckRan` says the command
executed; only `doneCheckFailed` records the case the step exists for — a phase whose review passed
and whose own check did not. Zero across many runs means the check costs a command per phase and
catches nothing; otherwise it is catching what no reviewer could. `alreadyDone` justifies the
per-phase re-check the same way.
