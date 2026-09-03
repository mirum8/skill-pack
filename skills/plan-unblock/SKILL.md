---
description: >-
  Settle the blockers a build plan lists under `## Resolve first` — the unknowns that need a
  decision and the paperwork that needs a person — so the phases they hold up can be built.
  Probes the repo where a timeboxed read answers one, asks the rest with a recommendation, ticks
  each with what settled it, and names the phases the answers reshaped. Use on "/r:plan-unblock",
  "settle the open questions in this plan", "work through the Resolve first list", "what's still
  blocking Phase 7?", or when `/r:plan-run` halts on an unresolved entry. **Invoked deliberately,
  or offered by `/r:plan-run`'s gate — never on its own.** NOT for: building the plan
  (`/r:plan-run`), writing or re-phasing one (`/r:spec-design`), or resolving a merge conflict
  (`/r:plan-run --auto-resolve`).
model: opus
effort: high
---

# plan-unblock

`## Resolve first` is where `/r:spec-design` puts the work no coding agent may touch: an unknown
whose output is a decision, and work that is not engineering at all. `/r:plan-run` stops on it.
This is the skill that closes it — and it is the only thing in the pack that writes into that
section, because it is the only one that can put the question to a person.

**This is not automatic.** A user's `/r:plan-unblock`, or `/r:plan-run`'s Step 1 gate offering it.
Not after a code change, not because a plan happens to have an open entry, not at the end of a
session. The section exists to keep an agent's hands off decisions nobody delegated —
`/r:task-run` is forbidden by name from writing a bullet into it — so a skill that fires itself
here would be the same failure one step later. It carries no `disable-model-invocation` flag for
one reason only: the flag blocks the Skill tool outright, and the gate that most needs to reach
this skill reaches it that way.

**Three things shape everything below.**

- **An entry ends as a decision or as a person's job**, and the two differ in who may close them.
  A timeboxed read of the repo is a *prefix* to a decision, never an outcome of its own — it
  narrows the question, and the answer is still somebody's to give.
- **The sort is derived, not judged.** `scripts/resolve_scope.py` classifies each entry from the
  same patterns `check_todo.py` uses to keep this work out of a numbered phase. A model re-sorting
  the section every run would produce numbers nobody can average and a fence nobody can trust.
- **One entry at a time, in order, each opening with why it blocks and what the options are.** A
  batch of questions is answered as a list; a blocker briefed on its own is answered on its merits,
  and an answer to one often changes the next.
- **Silence is not consent.** The one thing this skill must never do is tick an entry nobody
  answered.

## Invocation

```
/r:plan-unblock [<plan>] [--entry <n>] [--no-commit] [--dry-run] [--yes]
```

- **`<plan>`** — the `todo.md` to work on. Omitted, discover it: a plan named in the conversation,
  else `docs/*/todo.md`, else a root `todo.md`. Several candidates and no steer → list them and ask;
  never pick one silently, because the wrong plan gets edited and committed.
- **`--entry <n>`** — work one entry, by the `R<n>` label the report gives it (`--entry 3` or
  `--entry R3`). Everything else is left alone.
- **`--no-commit`** — write the file and touch no git state, for a caller that owns the index.
- **`--dry-run`** — report the sort and stop. Writes nothing, ever, and still records the run.
- **`--yes`** — take the recommendation on every decision rather than asking. It does **not** reach
  the `person` entries: nothing closes those but a person saying so.

## Read these before you act

| Before you… | Read | It owns |
|---|---|---|
| write a `Resolved:` line | `${CLAUDE_SKILL_DIR}/references/resolution-format.md` | the entry shape, the stamp, the legacy migration, what each outcome records |
| ask the first question | `${CLAUDE_PLUGIN_ROOT}/skills/spec-brainstorm/references/interview.md` §1–3, §8, §9 | the three rules, question style by reversibility, pushing back once, what "I don't know" means |

## Step 0 — preconditions, then the block

This skill writes to the plan and commits it, so it runs where that is safe: **on base, in the
primary tree**. Refuse, naming which one, when `.git/MERGE_HEAD` exists, when the plan file is
already dirty, or when this is a linked worktree (`git rev-parse --git-common-dir` differs from
`--git-dir`). Record `blocked` and stop.

Then ask the script, never the markdown:

```sh
python3 "${CLAUDE_SKILL_DIR}/scripts/resolve_scope.py" <plan> --outstanding
```

`hasSection: false`, or an empty `outstanding` → say so, record the run, stop. That is an answer,
not a failure.

## Step 1 — report the sort before acting on it

Lead with the two things that need no work at all:

- **`blockedPhasesBuilt`** — an entry blocking a phase that is already built. It is moot: say so,
  and offer to close it with that as the resolution.
- **`malformed`** and **`unknownPhaseRefs`** — an entry with no readable `Blocks:` line stops the
  whole run list, and one naming a phase the plan does not have guards nothing. Both need the
  user's eye before anything else.

Then the entries themselves, each as `decision` or `person`, with the phase it blocks and its
timebox. `unclassified` is listed **as a person's** — that is the fail-closed direction — and said
out loud, so the user can correct a real decision that no pattern matched.

## Step 2 — migrate the legacy shape

An entry in `legacyShape` has no checkbox, so nothing can ever close it. Rewrite those into the
checkbox form in the same edit that resolves anything else, and say how many. This is the one
change this skill makes to entries it did not resolve, and it is what makes the section closable
at all.

## Step 3 — probe, where a probe helps

Some questions the repo already answers, and asking the user to go and look is the interview
quitting early with extra steps. Send **one** read-only `Explore` agent over the whole section — a
realistic block is one to three entries, and one agent per entry buys nothing — briefed with each
entry's question and its own `Timebox:`. It returns, per entry, what it found, what it could not
settle, and a recommendation.

It never decides and never edits. A probe that blocks or comes back empty is named, and its entry
is asked cold — a question you could not narrow is still a question.

Skip the probe entirely for `person` entries. No amount of reading tells you whether a contract
was signed.

## Step 4 — walk the entries in order, one at a time

**One entry, fully, before the next one is raised.** Not one message carrying every question. These
are not interview rounds sweeping a topic — each is a discrete blocker with its own consequence,
and five of them in one message forces the user to hold five contexts at once and answer them in a
list, which is how the cheap ones get a real answer and the expensive one gets a shrug. Sequential
also lets an answer inform what comes next: R2 is sometimes moot once R1 is settled, and you can
only see that from inside the walk.

Work in **document order** and label each `R1`, `R2`, … by its position in the section, so the user
can refer back to one and `--entry` names something they have seen.

Each entry opens with a brief — **why this blocks, then what the options are** — before you ask
anything about it. The template is in `${CLAUDE_SKILL_DIR}/references/resolution-format.md` §4.
Write it in Simplified Technical English, in the plan's own nouns: one idea per sentence, active
voice, and the class and entity names the phase block and `design.md` already use.

Read the blocked phase's own items, `Files:` and `Done when:` first, so "why this blocks" names
what cannot be built or verified. Asserting that something is blocked is not a reason.

**Shorter and clearer, never shorter and blunter.** The brief supplies the premise the reader is
missing; that is the half worth its lines. What you cut is the part that repeats the entry, and the
part that shows your work.

Then, by kind:

- **A `decision`** — put the question and **wait**. Style follows reversibility
  (`interview.md` §1 Rule 2): genuinely open where the answer reshapes the plan, a forced trade-off
  where every option sounds free, propose-then-correct where a section gets rewritten,
  default-and-veto where it is one line to change later. Give a recommendation with its reason — a
  question with no lean makes the user do the analysis you just did.

  Push back **once** on an answer that is expensive to reverse, using §8's four beats: name the
  mechanism, the alternative with its cost, the reversibility, then hand it back. Never twice.

  **"I don't know" is an answer.** Take the recommendation, record it as the resolution with the
  alternative beside it, and move on (§9). Never re-ask, never block.

- **A `person`** — brief it in its place in the walk, then say plainly that nothing here can close
  it and move on. No question, no recommendation, no probe: no amount of reading tells you whether
  a contract was signed. It closes only when the user says it is done, and the stamp records that
  they said so. `unclassified` is treated as one of these.

**Under `--yes`**, print each brief and take the recommendation without asking. The briefs still
appear — they are the record of what was decided on the user's behalf. `--yes` reaches no `person`
entry.

**Silence is not an answer.** If there is no human in this session to answer — an unattended run, a
container, a piped prompt — record `blocked: "no-human"`, tick nothing, and stop. The whole reason
this section exists is that somebody has to decide; a default taken on nobody's behalf and written
into the plan as settled is exactly the lie it was built to prevent.

**Carry the walk forward.** When an answer moots or reshapes a later entry, say so when you reach
it rather than asking a question that no longer stands.

## Step 5 — write back, then commit alone

Tick each resolved entry and add its `Resolved:` line — the format is in
`references/resolution-format.md`. Then:

- **Where the entry's `Output:` names a file this skill does not own**, name it as outstanding and
  **do not edit it**. "A line in the spec's Risks" belongs to `/r:spec-brainstorm`, whose ADR ids
  are a shared space; an unrequested edit to `spec.html` is a second writer of a document with one.
- **Touch nothing else in the plan.** Not a `### Phase N` block, not a phase item, not `## Waves`,
  not the numbering. A `- [ ]` outside the `## Resolve first` section belongs to `/r:plan-run`,
  which ticks it after a review that verified it.
- **One commit, this file alone** — `docs: resolve <n> plan blockers` — on base, in the primary
  tree. Left uncommitted it breaks both ways: an attended `/r:plan-run` halts on the dirty tree, and
  an unattended one snapshots it to `refs/wip/` and cleans it, reverting the answers while the gate
  it already passed says everything is settled. `--no-commit` opts out; `--dry-run` writes nothing.

## Step 6 — re-check

```sh
python3 "${CLAUDE_SKILL_DIR}/scripts/resolve_scope.py" <plan> --check
python3 "${CLAUDE_PLUGIN_ROOT}/skills/spec-design/scripts/check_todo.py" <plan>
```

Report what they say. `--check` exits 1 on any finding, which is the point of it.

## Step 7 — name what has to be re-planned

For each resolved entry, say whether the answer changed the **shape** of the phase it blocked — a
different approach, a different file, a criterion that no longer holds. That is all this step owns:
it names them and stops.

It does **not** re-plan, renumber, regenerate `## Waves` or re-match `Implements:`. That graph is
`/r:spec-design`'s, and a second writer of it is a lockstep tax nobody is paying attention to. If a
rewrite is genuinely wanted, say what it costs: `/r:spec-design <the documents>` replaces `todo.md`
and `design.md` together, with `--against` freezing what is already built.

## Step 8 — report, then record the run

Tell the user what closed, what stayed open and why, what is outstanding elsewhere (the `Output:`
files), and which phases now need re-planning. Then one line into the pack-wide store — counts
only, never an entry's text, a plan path or a decision:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:plan-unblock","entries":0,"outstandingBefore":0,"resolvedNow":0,
 "decisions":0,"person":0,"unclassified":0,"probed":0,"probesBlocked":0,
 "legacyMigrated":0,"declined":0,"mootEntries":0,"replanNeeded":[],
 "checkerProblems":0,"blocked":null}
STATS_JSON
```

**Every bucket comes from what the file carries**, which is what makes them comparable between
runs — a model-judged sort would be recomputed differently each time and could not be averaged.

**`probed` against `decisions` calibrates Step 3.** Probing every entry means the skill is
answering things only the user could have; probing none means it is asking questions the repo
already answers, which is the interview quitting early.

**`unclassified` is the one to watch.** It is the fail-closed bucket, and a count that stays
non-zero means the derivation is too narrow and real decisions are being filed as somebody's
paperwork — a fence that over-fires stops being read.

`blocked` is the reason nothing was written — `no-section`, `nothing-outstanding`, `no-human`,
`dirty-tree`, `not-primary-tree` — and null on a run that resolved something. A blocked run still
records: a stop is a result, and a store holding only the runs that wrote something cannot be asked
how often this is reached. The script always exits `0`; a lost row is never a failed run. Never
retry it.

## Non-negotiables

- **Never fire on your own.** A user's `/r:plan-unblock`, or `/r:plan-run`'s Step 1 gate. This skill
  writes into the one section of a plan an agent is forbidden to touch, and it does it by asking a
  person; a run nobody asked for has nobody to ask.
- **Never tick an entry nobody answered.** "I don't know" is an answer and takes the
  recommendation. No human at all is not, and stops the run with `no-human`.
- **Brief every entry before asking anything about it, and never raise two at once.** The brief
  names what cannot be built without the answer — read from the blocked phase, not asserted — and
  at least two options with what each costs. An entry with one option is a default, not a decision;
  say so rather than staging a choice.
- **A `person` entry is closed by a person saying so, and by nothing else.** Not by `--yes`, not by
  a probe, not by an inference from the repo. An `unclassified` entry is treated as one of these.
- **The sort comes from the script.** Never decide by reading the markdown which entries are open,
  what they block, or who may close them. All three wrong answers are confident and silent.
- **Write inside `## Resolve first` and nowhere else in the plan.** No phase block, no phase item,
  no `## Waves`, no renumbering. Anything you want to say about a phase goes in the report.
- **Never edit a file the entry's `Output:` names.** Name it as outstanding instead; `spec.html`
  and `design.md` have their own owners.
- **One commit, the plan file alone, on base in the primary tree** — or `--no-commit` and no git at
  all. Never sweep another change into it, and never write from a worktree.
- **`--dry-run` writes nothing, ever**, and still records the run.
