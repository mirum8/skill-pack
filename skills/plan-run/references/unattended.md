# Running unattended

The `--unattended` contract: which failures still stop a run nobody is watching, which ones it works
around, what it does with a question, and what is allowed to interrupt the user. **Read it when
`--unattended` was passed** — by hand or through a `--herdr` wave that will take hours.

The reasoning for the flag lives here with the rules rather than in `SKILL.md`: every row below is a
judgement about whether the next phase's premise is still true, and the judgement and its reason are
only readable together.

`--unattended` is for a run nobody is watching: a twelve-phase plan started before dinner, or a
`--herdr` wave that will take hours. It changes one thing only — **what counts as a reason to stop**
— and does not touch what counts as a reason to fail.

**The rule it must not weaken.** Phase 5 is written against what Phase 4 produced, so a phase that
genuinely failed still halts the run. Autonomy means not stopping over a premise that is fine, never
building on one that is not true. This is the list of which is which:

| what happened | premise broken | unattended |
|---|---|---|
| implement returned `{ stopped: … }` | yes | **halt** |
| `Done when:` failed | yes | **halt** |
| the per-phase re-check came back `blocked` | yes | **halt** |
| the `Workflow` tool is unavailable | yes | **halt** — nothing can run at all |
| the review came back **red** | yes | one retry, then halt |
| the review came back **blocked** — a track did not run | not yet | one retry, then halt. **Never** banked as clean |
| a merge conflict | no | `--auto-resolve`, then build + full tests; halt on what it refuses |
| the base tree is dirty | no | snapshot to `refs/wip/pre-phase-<n>`, clean, continue |
| `.git/MERGE_HEAD` — another session holds the repo | no | wait one poll, retry, then halt |
| `--slice` refused the slice | no | run that wave **one unit at a time**, landed between |
| `footprint-warn` returned 2 under `--herdr` | no | run that wave **one unit at a time**, landed between |

The last two are the ones that pay for the flag: both are facts about *scheduling* with an obvious
local response, and stopping a four-hour run over one is the pipeline refusing to do what a person
would have done in a second.

### The one-unit-at-a-time degrade

Both scheduling rows above mean the same thing, and this table is where it is stated in full — every
other place that reaches this degrade points here.

**A `--slice` refusal degrades rather than stops.** Run that wave's leaves **one unit at a time**, in
numeric order — under `--herdr` still one spawned workspace each, landed before the next is cut — and
name the refusal in the report. The refusal is about *concurrency* only, and every leaf is still
buildable. What degrades is the schedule, never where the work happens. **A missing checker is still
a stop, unattended or not**: not knowing whether the slice is safe is a different thing from knowing
it is not.

**A `footprint-warn` exit 2 under `--herdr` degrades the same way.** Serially it is printed and the
run carries on — the cost of being wrong there is one merge conflict. Under `--herdr` it is a stop,
because the cost is the whole wave, built over hours before anything discovers it; under
`--herdr --unattended` that stop becomes the same one-unit-at-a-time schedule — a workspace each,
landed between — and it is named.

### Answer nothing, queue everything

A question is not a halt. Where an attended run stops for input, an unattended one **collects the
question, builds everything that does not depend on the answer, and reports the queue at the end**:

- **`## Resolve first` blockers** (Step 1) — drop the phases they block out of the run list, build
  the rest, and name them. Never dispatch `/r:plan-unblock`: it closes entries by asking a person,
  and there is nobody here to ask.
- **Two candidate plans with nothing to choose between them** (Step 0) — take the first by the
  documented order and say which.
- **An ambiguous item mid-run** — queue it and carry on.

### What reaches the user, and what does not

`PushNotification` pulls attention off whatever they are doing, so it fires on exactly three
things:

- **The run stopped and cannot continue** — the phase, the reason, the `--from N` that resumes.
- **A person is needed** — a spec-pinned test failed, or a decision nothing in the plan can settle.
- **The run finished** — phases built, phases skipped, questions queued.

One line, under 200 characters, leading with what they would act on: `plan-run halted at Phase 7:
done-when red. resume: --from 7` says more than "run failed". Nothing else notifies — not a phase
completing, a wave landing, a conflict auto-resolved or a degrade to one-at-a-time. Those are the report.

### Every workaround is named

The report carries a line per degrade — "wave 13 ran one unit at a time: footprint-warn flagged
`internal/ui`", "Phase 9's review was blocked and passed on retry", "base was dirty at Phase 4;
snapshotted to `refs/wip/pre-phase-4`" — and the stats line carries `degraded` (how many) and
`questionsQueued`. A degrade nobody hears about is indistinguishable from nothing having gone
wrong.

**Unattended never softens these**: a blocked review is not a pass, an auto-resolved merge still runs
the full test suite and is discarded on red, and a halted phase is never ticked and never merged.
