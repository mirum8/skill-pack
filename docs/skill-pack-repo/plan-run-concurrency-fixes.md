# Proposed: make a `--cmux` wave run and land by itself

Changes to `/r:plan-run` — four in `--land` and Step 3.6, plus the alarm channel between the
orchestrator and its units. Nothing here is applied.

Measured against two failures in `mirum8/fyl`, recorded in that repo's `docs/incidents/`:

- **Phase 28** — two units built off one base, each stayed inside its own checklist, and the
  branches would not merge. The preflight had cleared the slice.
- **Phases 21 and 31** — no file collided, both branches built alone, the merged tree did not
  compile. Both had added `type Ref = store.Ref`, in different files.

## 1. Dry-merge the wave before landing it

`--land` discovers a conflict by hitting it, after the wave has already built for hours. The
branches exist by then, so the question is answerable in seconds without touching anything:

```sh
git merge-tree --write-tree --name-only "$base" "$branch"   # exit 1 = conflicts, and it names them
```

Run it per branch in ascending phase order against the simulated base, so it models the real
sequence rather than pairwise. On a conflict, report and merge nothing.

This answers the incident's open question — it belongs in `--land`, not in `cmux-fanout.sh wait`,
because `--no-merge` without `--cmux` has no `wait` and would otherwise be uncovered.

## 2. Build between merges

`--land` builds nothing today. That is what let the `Ref` redeclaration through: no file collided,
so no file-level check could see it. **The checker reasons about files; the language reasons about
packages.** After each merge, run the build; on red, halt with that branch named rather than
merging the next one onto a broken base.

## 3. Let each phase correct its own `Files:` line

`todo.md` is written before any code exists, so `Files:` names the files that *carry* a feature —
never the ones it must touch to be wired in. Phase 28 declared 3 and changed 11. `--slice` compared
the 3 honestly and said "safe".

Step 3.6 already rewrites `todo.md` (the ticks, the `built:` marker) and commits that edit. Write
the real footprint in the same place:

```sh
git diff --name-only "$base...$pb"    # production source only; see 5
```

`check_todo.py` needs no change — it stops being fed a guess. Phases 12, 13 and 14 already carry
hand-corrected `Files:` lines with a note each; the convention exists and was dropped after Phase
14. A habit fails, a step in Step 3.6 does not.

Limit: this protects phases that run *after* something has built. Two never-built phases in one
wave are still blind, which is what 1 covers.

## 4. Resolve the minor conflicts automatically

Turn the base on (`merge.conflictStyle=zdiff3`), then ask one question of each hunk:

> does every base line still exist on **both** sides, ignoring whitespace?

Yes means neither side deleted anything — both only added — so the union of both sides is provably
correct. No means a side rewrote or removed shared code, and a human takes it.

Whitespace matters as much as the base: gofmt realigns a struct block when a longer field name
arrives, so every line changes and a strict comparison reads a pure addition as a rewrite.

Measured on Phase 28's real conflict, 7 hunks:

| file | hunks | auto-resolvable |
|---|---|---|
| `internal/app/clusters.go` | 3 | 3 |
| `internal/ui/app.go` | 2 | 2 |
| `internal/ui/errors.go` | 1 | 1 |
| `internal/app/run.go` | 1 | **0** |

The single refusal is `cfg.Activate, cfg.Visit = cs.activate, cs.visit` — the one hunk where both
sides rewrote a base line. Resolving it by picking a side drops `cfg.Apply`, **compiles clean**, and
fails only in the tests. The rule caught the dangerous hunk and nothing else.

Rules that make it safe rather than reckless:

- **Never pick a side.** `-X ours` / `-X theirs` is the obvious shortcut and is exactly this trap:
  it drops one side silently, it compiles, and a test or a user finds out.
- **Never union a golden file, `testdata/`, or a frame capture.** A union of two screenshots is
  nonsense.
- **The plan file is the exception with a written answer.** `--land` already says a tick collision
  resolves to *both* sides' ticks — each branch ticked what it really built. Automate that.
- **Format, build, run the full tests, and only then accept.** Red throws the whole merge away and
  hands it over. Change 2 is what makes this one safe.
- **Turn on `rerere`.** A hunk a human resolves once replays itself in the next wave, and hub files
  conflict over and over.
- **Say what happened.** The report names every hunk resolved automatically and every one handed
  over. Silent auto-resolution is how a Phase 28 looks fine.

## 5. Supporting rules

- **Every footprint comparison reads production source only.** The 140 terminal captures under
  `.claude/skills/test-app/e2e/` are 594 KB against an 8.4 MB `.git` — the cost is signal, not size.
  They turn an 11-file phase into a 48-file one and make comparison useless. Filter by extension in
  `check_todo.py` and in anything added by 1 or 3.
- **One hub phase per wave, until 1–3 exist.** Free, no code, and it would have prevented both
  failures. Commits per file across `fyl`'s `main`: `internal/ui/app.go` 28, `internal/app/run.go`
  21, `internal/ui/table.go` 15, `internal/ui/statusline.go` 15. Every wave confined to leaf
  packages merged clean; both failures involved shared surface. The pack's own stats agree from the
  other side — `internal/ui/app.go` is the top finding hotspot at 41 findings, `table.go` second.
- **Refuse to run where another session is holding the repo.** Check for `.git/MERGE_HEAD` and
  re-check that base has not moved, in Step 3.6 and in `--land`. A second session merged Phase 28
  mid-investigation; nothing noticed.

## 6. The alarm channel — what it does not catch

A unit holding `CMUX_FANOUT_ORCHESTRATOR` can `SendMessage` up in three cases: the slice is wrong,
it is blocked on something the plan answers, it is halting. Three rules guard it — a message never
closes a unit, ask never drive, don't poll. It fired in neither incident.

**A test you did not write is a fourth case.** Phase 22's unit hit `TestKeymapCoversSpecKeys`, a
test pinning a `spec.html` decision, read it as its own change needing adjustment, experimented, and
destroyed 137 minutes of uncommitted work with `git checkout --`. `incident-protocol.md` carries
this as prevention rule 4; the unit-side list does not carry it as an alarm. It needs no judgement:

> the failing test's file is not in your diff → it is not yours → send and stop

**Make the first case mechanical.** It reads *"you need a file your phase's `Files:` does not
name"*, which is a judgement, so Phase 28's unit wrote eight undeclared files in silence — each one
required by a checklist item it was given. It was in scope and out of declaration, and those are
different things. The trigger is *about to write a file not in `Files:`*, and it fires every time.

The orchestrator's answer is then **not** a halt for the wave. Phase 28's work was legitimate; a
halt there would refuse correct work. It is "recorded — continue", unless it collides.

**Then the channel carries footprint, not only alarms.** The orchestrator is the only party that can
see every unit's real file set while the wave is still running. Hold the union of what the units
report; a second unit naming a file another already claimed **is** the collision, on a live wave,
minutes in rather than hours later at the merge. That is 3 arriving a wave earlier, and it is the
only one of these that works on a wave where nothing has built yet.

**Downward messaging is available.** `spawn` runs `cmux workspace create --name "$id"`, and a cmux
workspace name is the session name `SendMessage` addresses — `ListAgents` from a session inside a
workspace lists its peers as `fyl-db`, `avtoportal-fd`, `homelab-26`. The orchestrator chose the id,
so it can reach the unit; the stated obstacle, prefix-matching an unpredictable name, does not apply
to a name it picked. Names repeat across projects, so disambiguate by `[ref]`.

Downward carries exactly two things — **stop**, and the answer to a question the unit asked. Never
work. "Ask, never drive" is unchanged: a message that changes what a unit builds makes its run
something other than the `--no-merge` loop everything downstream assumes.

Worth the wiring for one message only: *stop, another unit owns this file.* Without it the
orchestrator can detect a collision and then do nothing but wait out the timeout.

**A dead unit and a thinking unit look identical.** A session that crashes, is killed, or sleeps
writes no sentinel and sends nothing, and `wait` defaults to a 14400s timeout — four hours to learn
a unit died in its first minute. `wait` already polls every 10s; have it also check the session
still exists and fail fast when it does not.

**A session nobody spawned has no channel at all.** One merged Phase 28 into `main` mid-
investigation, and neither side could have been told. Between unspawned sessions the only channel
is a lock on disk, which is the `.git/MERGE_HEAD` and base-moved check in 5.

## 7. Warn about a slice before it spawns

3 corrects a phase's `Files:` line *after* it builds, so it protects the waves that come later and
never the one in front of you. The gap it leaves is the whole of an unbuilt tail: `--slice` clears
`[23, 24, 34, 36, 37]` as five leaves with no shared file, when all five land in `internal/ui` and
most will reach the message loop. That is Phase 28 at five times the scale, and the preflight says
it is safe.

Close it in the preflight that already runs `check_todo.py --slice`.

**Tier 1 runs every time and uses no model.** Every merged phase's real footprint is a fact in git,
so the hub set is measured rather than guessed. Compare each unbuilt phase's declared `Files:`
against what phases in the same package have always touched, and report the mismatch:

```
Phase 34 declares internal/ui/app.go · execview.go · stream/exec.go
  phases touching internal/ui have ALSO touched:
    internal/ui/app.go        28 of 30      internal/ui/table.go      15
    internal/ui/statusline.go 15            internal/app/run.go       21
  Phases 23, 24, 36, 37 in this slice are likely to touch the same files.
  Declared files say this slice is safe. History says it is not.
```

Deterministic and cheap, which is why it is the tier allowed to run unasked.

**Tier 2 runs on request** — a short explore agent per phase reads the checklist against the code
and proposes a corrected `Files:` line. It is a prediction, not a measurement, and it is priced
accordingly.

**Writing anything back obeys three rules.** Only unbuilt phases — a built phase's footprint is
measured from git and never predicted. An inferred line is **labelled inferred**, the rule
`/r:spec-design` already carries: the plan must not counterfeit a claim nobody made, and Phases
12–14 show the shape with an italic note each. And the user approves at the Step 2 gate that already
exists, so nothing edits a plan silently.

**Warn on a plain run, refuse under `--cmux`.** Being wrong serially costs a merge conflict; being
wrong across a wave costs the wave, which is the bill Phase 28 actually paid.

### What a warning is worth

Three answers, cheapest first, and the first is the usual one:

- **Split the wave.** Run those phases one at a time. The warning is about scheduling, not about the
  plan being wrong. No edit, no cost.
- **Correct the `Files:` lines.** A few lines. The checker then refuses that slice on its own rather
  than relying on anyone remembering.
- **Rewrite with `/r:spec-design`.** Only when the spec moved, or the unbuilt tail is structured
  wrong. Built leaves freeze, the draft goes to a scratch directory, and `check_todo.py --against`
  proves nothing frozen moved. It renumbers, so anyone holding a `--from N` is holding a stale
  number.

A warning about *who runs together* is the first. A warning that keeps returning is the second. A
warning that the plan describes work nobody wants any more is the third.

## 8. `--unattended` — what may stop a run nobody is watching

Applied. The four changes above remove failures; this one changes what a *remaining* failure costs
when the user has walked away. It moves one thing only — **what counts as a reason to stop** — and
nothing about what counts as a reason to fail.

Most of what stops a run is not a broken premise. Of the eight halts Step 3.7 listed, four are
scheduling or environment problems a person would work around without thinking:

| worked around | halt |
|---|---|
| a merge conflict → `--auto-resolve`, then build + full tests | implement returned `{ stopped: … }` |
| a dirty base → snapshot to `refs/wip/pre-phase-<n>`, clean | `Done when:` failed |
| `--slice` refused, or `footprint-warn` returned 2 → build that wave serially | the re-check came back `blocked` |
| a busy repo or a merely-blocked review → one retry | the `Workflow` tool is unavailable |

The slice refusal is the one that pays for the flag. It is a fact about *concurrency* — every leaf
in that wave is still buildable, just not at the same time — so stopping a four-hour run over it
refuses work that was never in question.

**A question is not a halt either.** A `## Resolve first` blocker drops the phases it blocks and
builds the rest; an ambiguous item is queued and the run carries on. A run that dies at minute
twenty over one unclear checklist line has spent the whole night doing nothing.

**Three things reach the user, through `PushNotification`** — which skips itself when they are at
the terminal, so it costs nothing when they have not actually left. The run stopped and cannot
continue; a person is needed; the run finished. Not a phase completing, not a wave landing, not a
conflict resolved, not a degrade. Those are the report, and a notification nobody needed is
expensive in a way that accumulates over a pipeline measured in hours.

**Every workaround is named**, in a `Worked around:` section printed even when empty, and counted in
`degraded` beside `questionsQueued` in the stats line. A workaround nobody hears about is
indistinguishable from nothing having gone wrong, which is the state a wave was in the last time
this went badly.

Unattended never softens the three that matter: a blocked review is not a pass, an auto-resolved
merge still runs the full suite and is discarded on red, and a halted phase is never ticked and
never merged.
