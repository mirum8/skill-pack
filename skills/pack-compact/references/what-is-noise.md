# What is noise here, and what only looks like it

The pack's prose is the product, and most of what makes it long is deliberate. The register tells
you what must survive; this tells you what may move, and — more useful — what reads as removable
and is not.

## The one test

For any paragraph, ask: **if this were gone, would a run do something different, or would only a
future editor be worse informed?**

The first is behaviour. It has a register entry, it stays, and it stays *somewhere the run will
read it*.

The second is a reason. Reasons stay too — they are what stop a future editor deleting a rule they
do not understand — but a reason earns **one** statement, in the place the rule lives. The third
restatement of a reason is the thing you are here to remove.

Neither is ever "true, therefore keep". Almost all of this is true.

## The five moves

### 1. Re-home

The default failure of fix-after-fix editing: a rule lands where the editor was standing.

> Step 2.6 says "at most three groups run at once by default … the cap is
> `steps.fanout.maxUnits` in the config, resolved by the fan-out script **rather than restated
> here**" — with the 3 restated in the sentence before it.

The rule is fine. Its two halves are in the wrong relationship. Re-homing puts the cap where caps
are documented and leaves one pointer at the step.

Signals: a `## Non-negotiables` bullet that also appears mid-body; a flag documented three
sections from the flag list; a step whose preconditions arrive after it; an appendix that grew
into a second body.

### 2. Say once

A constraint stated twice in the **same** loaded context becomes one statement the other site
points at.

The clearest instance in the pack: the stats-row invariant, written eighteen different ways across
twenty-two files — "a lost row is a lost row, never a failed run", "…never a failed commit",
"…not a failed scan", "…not a failed review". Same rule, re-argued from scratch each time.

The word *same* is doing the work. See the carve-outs.

### 3. De-narrate

An incident becomes the present-tense failure mode it taught. The evidence is load-bearing; the
anecdote is not.

> **Before** — `// A caller merges on that field. Observed on wf_0df046aa-cde: build: "green" and
> endVerify: "passed" over a tree where the build failed 1 of 959 tests, because an end-verify fix
> put a checkbox group back into a SHARED fragment and broke a sibling page's pinned test.`
>
> **After** — `// A caller merges on this field, so it must describe a tree that was actually
> built. An end-verify fix can break a sibling of the file it touched — a shared fragment has more
> than one page pinned to it — which turns a green build into a stale claim rather than a false
> one.`

The run id, the date, "observed on", "on the real occurrence" all go. The mechanism, the specific
wrong reading, and the number where it is doing work all stay. Same for a version delta: *2.1.216
had the `Agent` tool and 2.1.217 removed it* is a changelog; *subagents have no `Agent` tool, so a
fan-out nested inside one collapses to a single context and still reports success* is the rule.

### 4. Extract

Material a run reads only sometimes moves to `references/`, behind a pointer that says **when** to
follow it. This is the only move that cannot lose anything, so when a section is long and the call
is unclear, extract rather than agonise.

A pointer that does not say when to follow it is a deletion with extra steps.

### 5. Refresh

Re-derive every measured number from `python3 lib/skill-stats.py`, or date it as a baseline. A
stale number is worse than no number: it is what holds a rule up, and when a future editor checks
it and finds it wrong, the rule goes with it.

Two readings that are not evidence, and must not be written as if they were: a skill with no rows
was never **observed**, not never useful; and a track scores zero on every run whose tier never
dispatched it.

## The carve-outs

### A measured number in a separately-loaded file is not duplication

`~93k tokens` and `~49 turns` appear in both `skills/task-review/SKILL.md` and
`agents/bug-hunter-pattern.md`. The `~77k` batching figure appears in six agent files. **An agent
file is loaded without its calling skill.** Collapsing those strips the justification from the
only context that will ever read it. The same goes for a rule a generated skill needs when nothing
that generated it is in context.

Ask where the reader is standing, not how many times the string occurs.

### "regression", "no longer" and "the old" are usually vocabulary

About fifty sites in the pack use these words to describe what the tool does **now**: *a
regression guard, not proof the fix works*; *findings that cite code no longer in the file*; *it
falls back to the old emptiness test when the runner did not report*. Pattern-matching these is
the single biggest false-positive risk in the corpus. Read the sentence.

### Some names look stale and are load-bearing

The two pipelines' `meta.name` values are still the pre-rename names — post-task-review and
run-task-implement — although the files live under `skills/task-review/` and `skills/task-run/`.
`hooks/guard-workflow.py` matches on those exact strings. "Fixing" them disarms the immutability
guard on both pipelines, and nothing downstream notices. The register's `README.md` keeps the
running list; read it before you tidy a name.

### Never drop the forecloses-clause

The house sentence has four parts:

> **rule** → the **mechanism** that makes it true → the specific **wrong reading** it forecloses →
> what the **opposite case** looks like

> **A run that could not mine anything records `blockedReason` and NO findings.** `no-corpus`,
> zero plans, or a script that failed is an absence of judgement, not a judgement that nothing
> qualified — zero candidates would put "this project has no shared patterns" into the store on
> the strength of a directory that was never there. `changed: false` is the opposite case and a
> real result: the candidates were judged, the index already said so, and `wrote` is `false`.

Cutting the third clause shortens it by a third and destroys it. That clause is the entire reason
the rule survives contact with the next editor. If a paragraph looks bloated, check whether what
you are reading is the third clause before you decide.

### Shorter is not the goal

A rewrite that ends the same length but says each thing once, in the section that owns it, has
done the job. A rewrite that is 40% shorter and vaguer has not. Report bytes because they are
measurable, not because they are the objective.

## The proposal

Five lists, one per move, each vetoable on its own, and size before/after in both lines and
characters. Per item: the exact before and after text for a rewrite; the destination and the
pointer text for an extraction; the surviving statement for a collapse; the old and new figure for
a refresh.

Anything you are unsure about goes in the report as a question, not in the rewrite as a decision.
