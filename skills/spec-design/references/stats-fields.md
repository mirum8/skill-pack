# What each field in the stats line means

`SKILL.md` Step 10 carries the command and the `mode` vocabulary. This file is the rest: what each
remaining field is for, and what reading it is supposed to settle. Read it while filling the line
in — a field written without knowing what question it answers is a field that gets a plausible
number instead of a true one.

## Contents

1. The rewrite fields
2. `maxWaveWidth`
3. `designChoicesAsked`
4. `codexReview`
5. `checkerProblems`
6. The cross-skill pair

**The rewrite fields say whether Step 1.5 is doing anything.** `inputShape` is
`none` | `split` | `packed` | `flat` | `foreign` — `none` on a fresh run, which is what separates
"no plan was there" from "a plan was there and nothing was frozen". `leavesFrozen` against
`leavesResplit` is the pair to read: a rewrite that freezes nothing ran over a plan nobody had
started, and one that re-splits nothing did no work — both are fine individually and both being
common means this mode is not earning its complexity. `fieldsInferred` counts what the skill
supplied that no author wrote, which is the number to watch first if an inferred edge ever turns
out to be wrong: it is the only measure of how much of a `foreign` plan was guessed.

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

**`codexReview` is `ran` | `skipped` | `blocked`, and it is the field that stops a missing plugin
reading as a clean plan.** `skipped` means Codex is not installed; `blocked` means it is and the
review still could not produce a critique — a different problem with a different fix, and averaging
them together hides both. `codexRaised` against `codexApplied` is the one that says whether this
step earns its cost: a reviewer whose findings are all dismissed is costing a pass per plan and
changing nothing, and a reviewer whose findings are all applied is one nobody is verifying.

**`checkerProblems` is what `scripts/check_todo.py` reported on the first run**, before fixing.
Consistently zero means the checker is not earning its place in Step 7; consistently high means
this skill is producing plans it already knows how to check.

**The cross-skill pair is `leaves` here against `phasesInPlan` in `/r:plan-run`'s rows.** That is
the only way to see whether plans get written and then actually executed — a store full of plans
with no runs is the failure neither skill can detect on its own.
