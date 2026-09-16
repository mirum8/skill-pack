---
description: >-
  Restructure this skill pack's own prose against its frozen behaviour register — close the seams
  that fix-after-fix editing leaves, without changing a single behaviour. Re-homes a rule appended
  wherever the last fix landed into the section that owns it, collapses a constraint stated twice
  in one loaded context, turns an incident story into the present-tense failure mode it taught,
  extracts what a run reads only sometimes into `references/`, and refreshes every measured number
  from the stats store. Each file is rewritten from scratch against
  `docs/skill-pack-repo/behaviour/<target>.md` and then proved against it: a register entry the
  rewrite can no longer state means the file is restored, not patched. Use on "/r:pack-compact",
  "/r:pack-compact plan-run", "compact the pack", "tidy up the skills", "the prose has accreted,
  reorganise it". Runs only in this repo, only from a clean tree, and refuses a target that has no
  register file. NOT for: a project's own CLAUDE.md (`/r:claudemd-compact`), taking defect reports
  about the tooling (`/r:pack-maintain`), or changing what a skill does — it never drops a
  behaviour, only moves where one is stated.
effort: high
disable-model-invocation: true
---

# pack-compact

This pack is edited fix by fix, and each fix lands where the editor was standing: a rule appended
at the bottom rather than merged into the section that owns it, a second statement of a constraint
already made three screens up, the story of the run that exposed the bug, a number that has since
moved. None of it is wrong. It is just no longer organised, and the seams are paid for on every
load — `skills/plan-run/SKILL.md` alone is 82 KB that enters context whole the moment the skill
triggers.

**The behaviour does not change. Nothing here is worth one lost rule.** What you are moving is
where a thing is said and how many times, never what is said.

## Invocation

```
/r:pack-compact                    survey every target and rank what is worth doing — writes nothing
/r:pack-compact plan-run           one skill, with its references/
/r:pack-compact agent:bug-hunter-ui
/r:pack-compact skills/task-review/task-review.workflow.js
```

**A rewrite always names its target.** With no argument the run is a **survey**: Steps 0–2 over
every target, read-only, reporting which ones actually have something to compact and how much,
ranked. It never rewrites. The alternative — sweeping all 34 targets and stopping at each
proposal — is 34 approvals in a row, which nobody gives one at a time, and the pressure that
creates is to wave them through in a batch. That is the unattended mode this skill does not have,
arrived at by exhaustion. Survey first, then name a target.

## Step 0 — refuse what you cannot undo

Four preconditions, all of them cheap and all of them fatal:

- **This repo.** `.claude-plugin/plugin.json` must name `r`. Run anywhere else and you are
  rewriting somebody's project.
- **A clean working tree.** `git status --porcelain` must be empty. The revert in Step 4 is
  `git checkout -- <file>`, and it is only unambiguous when the diff is yours alone.
- **A register for the target.** `docs/skill-pack-repo/behaviour/<target>.md` must exist. No
  register, no rewrite — without one there is no statement of what the prose has to keep saying,
  and a rewrite checked against the file it replaces only ever proves it copied itself.
- **Not the vendored tree.** `skills/spec-brainstorm/references/html-effectiveness/` is
  third-party; its `LICENSE`, `CODE_OF_CONDUCT.md` and `SECURITY.md` stay byte-for-byte.

Read `python3 lib/skill-stats.py` once at the start. Move 5 needs it, and a skill with no rows was
never observed rather than never useful — never let a quiet skill look like a dead one.

## Step 1 — read the register, not the prose

`docs/skill-pack-repo/behaviour/<target>.md` is ground truth: one entry per behaviour, each with
the file that states it, the code that enforces it and the suite that covers it. Entries with
neither enforcement nor a test are listed under `## Prose-only behaviours` — those are the ones a
rewrite can lose in silence, so carry them into the brief by name.

Read `docs/skill-pack-repo/behaviour/contradictions.md` beside it. It lists the places two files
in the pack disagree — a rule copied between two skills that drifted, a comment describing a tier
nothing runs at, a check the prose says a script holds and the script does not. **Nothing listed
there is silently harmonised.** Picking a winner is a decision, and a sweep that made two files
agree by rewriting one of them would make it by accident, in the direction that happened to be
easier to phrase. Where a compaction would touch one, say so in the report and leave both alone.

**The register is invariant.** You never propose dropping a behaviour. If one looks dead, say so
in the report and leave it in place: retiring a rule is a decision made outside this skill. The
one register field you may change is *States it:*, when text legitimately moves to `references/` —
that changes where a behaviour is written down, not what it is.

## Step 2 — propose, then wait

Five lists, one per move, each vetoable on its own, with size before and after in **both lines and
characters**. Read `${CLAUDE_SKILL_DIR}/references/what-is-noise.md` for the worked before/afters
and the judgement calls; the moves in brief:

1. **Re-home** — a rule goes to the section that owns it. Steps read in order, a flag is
   documented where the flags are, a non-negotiable sits under Non-negotiables and not also
   mid-body. This is the point of the exercise; the rest follow from it.
2. **Say once** — a constraint stated twice in the *same* loaded context becomes one statement the
   other site points at.
3. **De-narrate** — an incident becomes the present-tense failure mode it taught. The evidence
   stays; the anecdote goes.
4. **Extract** — material a run reads only sometimes moves to `references/`, behind a pointer that
   says *when* to follow it. It is the one move that cannot lose anything, so when a section is
   long and the call is unclear, extract rather than agonise.
5. **Refresh** — every measured number re-derived from `lib/skill-stats.py`, or dated as a
   baseline. A stale number is worse than none: it is what holds a rule up, and when it is wrong
   the rule gets deleted for the wrong reason.

Then stop and show it. There is no unattended mode: nothing in the pack invokes this skill, so an
approval nobody has to give would only be a way of skipping one.

**Five empty lists is a result, and reporting it is the whole job that run had.** Say plainly that
the target is already organised, name what you checked, and stop. Do not go looking for a smaller
thing to change so the invocation has something to show for itself — a file that is already
compact is the outcome this skill is for, and the pressure runs the other way: the user has just
invoked it and is waiting. A rewrite that exists to justify a run is the one kind of change here
that cannot be worth its risk, because the risk is a lost rule and the reward is nothing. Shorter
is not the goal; each thing said once, where it belongs, is, and a file can already be there.

## Step 3 — rewrite from scratch

Dispatch a subagent with the register entries, the file's own order and the approved lists, and
have it **write the file fresh** rather than edit it. An edit pass preserves the shape that
accreted, which is the thing being fixed.

A subagent, because an 82 KB file read into this thread leaves no room to judge the result. This
skill runs in the main thread and does its own dispatching — a subagent has no `Agent` tool, so a
fan-out nested one level down collapses to a single context and still reports success. **If you
cannot reach the `Agent` tool, stop and say so**; do not rewrite the file here and call it done.

On an executable file — `.workflow.js`, `.py`, `.sh`, `.yaml` — **rewrite whole comment lines
only**. Not the code, and not trailing comments either: the gate in Step 4 treats a trailing
comment as code, deliberately, because a stripper that mistook code for a comment would stop being
able to see that code change.

## Step 4 — prove it, or put it back

In this order, cheapest and least persuadable first:

```sh
git show HEAD:<path> > "$TMP/before"
python3 "${CLAUDE_SKILL_DIR}/scripts/behavior_tokens.py" tokens \
        --before "$TMP/before" --after <path> [<extracted references...>]
# executable files additionally:
python3 "${CLAUDE_SKILL_DIR}/scripts/behavior_tokens.py" code-identical \
        --before "$TMP/before" --after <path>
```

Every flag, path, `r:` name, constant, payload key and measured number in the old file must appear
somewhere in the new set. Extraction is not loss, which is why several `--after` files are
allowed. A non-zero exit is a verdict, including exit 2: a check that did not run is not a check
that passed.

Then two readers, both dispatched from here:

- **A fresh reader** that is given only the new file and the register, never the original, and
  reports which entries it can find. Anything it cannot find is either lost or no longer legible,
  and both are failures.
- **An adversarial diff** that reads old and new side by side and reports anything the new file no
  longer says, or says more weakly.

**Any entry the fresh reader cannot find, or the adversarial reader flags, means the run is put
back and the loss reported.** Not a patch. A patched rewrite is how a file ends up half-organised
and short a rule, and nothing downstream re-reads the prose to catch it.

Putting it back means **every file the run wrote**, not just the rewritten one:

```sh
git checkout -- <path>                 # the rewritten file
rm -f <references the run created>     # an UNTRACKED file survives a checkout
```

The second line is the one that is easy to miss. An extraction creates a new `references/` file,
`git checkout` has nothing to say about a path git has never seen, and the revert then reports
success over a half-extracted target — the target restored and the fragment it was extracted into
still sitting beside it.

**The register is updated last, after every check above has passed.** A run may change an entry's
*States it:* when text moves to `references/`, and doing that before the gate would put the
register into the same failure: the rewrite reverts, the register keeps pointing at a file that no
longer exists, and this run reports a clean revert while the next run fails
`check_behaviour_register()` on a dead path. Touch it only once there is something true to point
at, and it never needs reverting.

Finally run `./validate.sh`. If a frontmatter `description` changed, that is routing and only a
model run can prove it: `python3 tools/run-evals.py --skill <target>`, and the always-on listing
cost must not rise — there are about 50 characters of headroom in the whole pack. A description
change is its own proposal and gets its own yes; it never rides along with a body rewrite.

## Step 5 — report, and commit nothing

Per file: bytes and lines before and after, what each move did, the register entries checked, and
anything restored. Then the row:

```sh
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{ "skill": "r:pack-compact", "kind": "result",
  "target": "<name>", "mode": "survey|target", "filesProcessed": 0,
  "bytesBefore": 0, "bytesAfter": 0, "registryEntries": 0,
  "movesProposed": 0,
  "sectionsRehomed": 0, "duplicatesCollapsed": 0, "narrativesConverted": 0,
  "bytesExtracted": 0, "numbersRefreshed": 0,
  "descriptionChanged": false, "filesReverted": 0,
  "wrote": true, "blockedReason": null,
  "findings": [] }
STATS_JSON
```

`bytesBefore` against `bytesAfter`, read beside `filesReverted`, is the only pair that says
whether this did its job — shrinking while reverting nothing is the result; shrinking while
reverting is churn.

**`movesProposed` is what separates the three ways a run writes nothing**, and they need opposite
responses:

| | reading | what it asks for |
|---|---|---|
| `movesProposed: 0`, `wrote: false`, no `blockedReason` | the target is already organised | nothing — a real result |
| `movesProposed: N`, `wrote: false`, no `blockedReason` | proposed and declined | read the proposal; the judgement was wrong or the timing was |
| any, `blockedReason` set | the run could not reach a check | make it run — this is an absence of judgement, not a judgement of zero |

Without the count the first two are the same row, and a pack whose prose is in good order reads
exactly like a skill nobody agrees with. A survey run records `mode: "survey"`, `wrote: false` and
the `movesProposed` it would have made across every target, so the sweep is measurable without
having written anything.

`findings` records **both sides** of the Step 4 adjudication: `verdict: "confirmed"` for an entry
that was really lost, `verdict: "dismissed"` for one the reader missed and the file kept. Logging
only the losses is what makes a verifier read as never wrong. A run that could not finish writes
`blockedReason` and **no findings at all** — a blockage filed as a finding gets picked up
downstream as work.

The script always exits `0`. A lost row is a lost row, never a failed run, and it must never
change what was written. Never retry it.

## Non-negotiables

- **The register is invariant.** Never drop a behaviour, with or without approval.
- **A lost entry means revert, never patch.** Every file the run wrote goes back — including any
  `references/` it created, which a checkout will not touch — and the run says so.
- **An empty proposal is reported, never filled.** A target that is already organised is the
  result, not a run that failed to find work.
- **Real checks only.** `behavior_tokens.py`, a genuinely fresh reader that never saw the
  original, `./validate.sh`, and `run-evals.py` for any description change. Never a summary of
  what a check would have said.
- **Comments only in executable files**, and whole comment lines at that.
- **Clean tree in, no commit out.** The diff is the deliverable; the user decides what lands.
- **Some things look stale and are not** — see `## What must not be "cleaned up"` in the
  register's `README.md`. It starts with the two pipelines' live `meta.name` strings, which are
  still the pre-rename names (post-task-review, run-task-implement) because
  `hooks/guard-workflow.py` matches on those exact strings. Renaming them to match their
  directories disarms the immutability guard on both pipelines, and nothing notices.
