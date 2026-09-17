# `--ask <session>` — reporting a defect in the pack

The maintainer channel: where a defect in the *tooling* goes, what belongs there and what does not,
and the five rules that keep a report from turning into a halt. **Read it when `--ask <session>` was
passed** — by a serial run or by a `--herdr` unit, which carries the same flag on its own command
line.

`--ask <session>` means a pack maintainer session is watching the **tooling** at that address:
report defects in the pack there and keep working. It works with or without `--herdr` — a serial run
hits pack defects too — and it changes nothing else about the run.

**What belongs there is a defect in the TOOLING, never in the project being built.** Three
addresses, three different things, and mixing them is what makes each of them useless:

- a bug in the code this plan is producing → the plan, or the project's own backlog;
- a question about the *work* — a contradictory `Done when:`, a phase that reads as already built →
  the **orchestrator** ([the alarm channel](concurrent-sessions.md#the-alarm-channel));
- a step of the *pipeline* that is wrong → **here**. A step that cannot run, a bundled script
  returning a confident wrong answer, a handoff field a caller cannot read, an instruction in a
  skill that contradicts what the tool actually does.

Five rules, and the first is what makes this safe to switch on:

- **A report is never a halt, and never a question.** Send it and carry on with the same run you
  would have had. Never wait for a reply and never poll for one. When a reply does arrive, apply the
  workaround it gives only where it changes **how a pack step is run** — a flag, a command, a step
  to skip and name — and never what this run builds; name it in your report like any other
  workaround. If the defect genuinely stops the work, that is a halt on its own terms and the halt
  rules apply unchanged; the report is extra, not instead.
- **Never work around a pack defect silently.** Working around it is usually right — report it *and*
  keep going — but the workaround goes in this run's own report to the user as well, in the words of
  what was done instead ([every workaround is named](unattended.md#every-workaround-is-named)). A
  workaround nobody hears about is how a defect survives twenty runs.
- **Send evidence, not a conclusion.** The exact error string, the run id, `file:line`, what you
  already ruled out, and what you did instead. The maintainer verifies every claim against the pack
  before changing anything, so a report that hands over a verdict with nothing under it costs more
  to check than the defect costs to find — and a confident wrong diagnosis is worse than a raw
  observation. Say plainly which parts you observed and which you inferred.
- **An expectation the pack contradicts is a report too.** Some of what looks broken is designed — a
  field empty because a tier does not fill it, a step that runs only at one profile. Report it in the
  same shape and let the maintainer say which it is: "this looked like a malfunction and was not" is
  a real finding about the tooling's legibility, and it is cheap to answer.
- **The maintainer does not touch this repo.** It replies with how to get past the defect in this
  run, files major ones for its user, and changes the pack only when its user says so. Nothing it
  does lands in this working tree, so nothing about `--ask` can change this run's diff.

## Under `--herdr`, every unit carries it

**Pass `--ask <session>` through to every unit's own command line, verbatim**, exactly as the spawn
prompt already carries `--phases` and `--no-merge`. The unit is the first thing that touches the
pipeline, so it is where a pack defect is seen first, and a report relayed through the orchestrator
loses the detail that made it actionable.

`fanout.sh` needs no change and no new environment variable: the address rides in the child's
own command line, which is also why it works on serial runs. `FANOUT_ORCHESTRATOR` stays what
it is — a different address for a different kind of message.
