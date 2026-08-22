---
description: >-
  The short pipeline for a small change, run start to finish in this one thread — implement it
  test-first, have the REAL Codex reviewer read the finished diff, verify every finding it raises
  against the actual code, and fix only the ones that hold and belong to this change. No planning
  phase, no subagents, no Workflow, no feature branch, no PR, no commit, and none of
  `/r:task-run`'s fan-out (no explorers, no plan review, no bug hunters, no `/r:code-scan`, no UI
  pass). Use whenever the user says "/r:task-quick", "quick fix: …", "just fix this and review
  it", "small change, skip the whole pipeline", or hands over a one-or-two-file change they want
  built, built green and read by a real reviewer rather than shipped through the long routine —
  even if they don't name the skill. It opens with a scope check: a task that needs a design
  decision, touches auth, money, persistence, concurrency or security, needs a migration, or spans
  more than about five files goes back to `/r:task-run` before any code is written. NOT for: work
  you want planned and reviewed in depth or shipped behind a PR (`/r:task-run`), reviewing a diff
  that already exists (`/r:task-review`), a whole backlog (`/r:issues-fix`), or a phased plan
  (`/r:plan-run`).
effort: high
disable-model-invocation: true
---

# task-quick

The short path from "fix this" to a reviewed, building change: **implement → review → verify →
fix**. Everything that makes `/r:task-run` long is gone, including the planning phase — at this
size, writing the plan and writing the code are the same act. What is kept is the one thing that
makes a change trustworthy: the review is the **real Codex reviewer** reading the real diff, never
your own re-reading of code you just wrote.

`/r:task-quick <what to fix>` — free text ("the export button posts twice on a double click") or a
GitHub issue ref (`#42`, an issue URL) you read with `gh issue view`.

## Run it in this thread

Do every step yourself, here. No `Workflow`, no subagents, no background dispatch. That is what
makes this skill cheap: there is no fan-out to lose, so spawning would buy nothing and cost a round
trip and a context re-read per step. It also keeps the whole run visible to the user as it happens,
which is what they are choosing when they ask for the quick path instead of `/r:task-run`.

The cost of running inline is that everything you read stays in your context, so keep the reading
targeted — grep for the symbol, read the file that owns it, read its test. That discipline is what
the skill runs on, not an afterthought.

One consequence is worth knowing: because it spawns nothing, this skill runs correctly anywhere —
including inside a subagent, where `/r:task-run` and `/r:task-review` cannot run at all (a subagent
has no `Agent` and no `Workflow` tool, so their fan-out would silently collapse to one context and
still report success). Every step here is Bash, edits and your own reading, so nothing collapses.

## Step 0 — Is this a quick fix at all?

Before touching anything, answer one question: does this task need a design decision about what the
user sees, touch auth, money, persistence, concurrency or security, need a migration, span more
than roughly five files, or rest on an approach worth arguing about?

If yes, **stop and say so.** Tell the user it wants `/r:task-run` — its explorers, its
Codex-reviewed plan, and the full `/r:task-review` afterwards — and name which condition it hit.
One sentence of judgement is cheap; an unreviewed change to something that matters is not. Do not
reword the task and continue.

This is a check, not a planning phase. It costs a couple of greps and the reading you need for
Step 1 anyway.

## Step 1 — Implement, test-first, and get the build green

Note the branch (`git rev-parse --abbrev-ref HEAD`) and the build tool (`pom.xml` → Maven,
`build.gradle[.kts]` → Gradle, neither → none). This pipeline works on the branch the repo is
already on; if that is `main`/`master`, say so once — the user may want to branch first — and carry
on if they don't object.

Load `/r:tests-write` before writing tests so they match house style. Then:

1. **Write the tests first** and **run them before touching production code.** Record what you
   saw, one line per test: `<test> — before: RED (<the assertion that failed>) — after: GREEN`.
   Red-before-green is something you observe, not something you can assume. A test you expected to
   fail that passes on unmodified code is a signal: usually it is too weak to reach the bug
   (strengthen it), occasionally the behaviour already exists (say so, and treat it as a guard).
2. **Implement until they pass.** Reuse what the project already has — the existing helper,
   pattern or sibling test — rather than inventing a second shape for it. Match the surrounding
   code: no new comments or Javadocs, `@Builder` on data classes with more than three fields. Stay
   inside what was asked; no scope creep.
3. **Build with the tests**: `mvn -q test` or `./gradlew test`. Tests are what certify a change of
   this size; the clean packaging build `/r:task-run` runs is most of what makes it slow. A project
   with neither build file gets its own test command if it has one — and if nothing runs, say so
   rather than letting the report imply a build that never happened.

A red build gets **one** surgical repair, then stop. Split the failures first: failures in code
this run changed are yours; failures that were already there are not — never weaken or "fix" an
unrelated test to get green, and surface pre-existing breakage to the user instead. Still red after
that one repair means the task was misjudged: hand it back and suggest `/r:task-run`.

Leave everything **uncommitted**. This pipeline never commits.

## Step 2 — Review: run the actual reviewer

```sh
"${CLAUDE_PLUGIN_ROOT}/skills/code-adversarial/scripts/run.sh" --mode review --wait
```

That is Codex's built-in reviewer over the working tree. It takes no focus text. It runs for
minutes — wait for it; do not background it or give up early. Exit codes: `0` with a first line of
`CODEX SKIPPED:` (or exit `3`) means the Codex plugin is not installed; `4` means Codex could not
inspect the diff after three attempts, which is **not** a clean review.

**A review that did not run is reported as a gap, never as a clean review**, and your own reading of
the diff is not a substitute for it — you wrote the code, so you are the one reader whose opinion of
it carries no independent information. Say plainly that the change is unreviewed, tell the user how
to install the plugin (`/plugin install codex@openai-codex`), and finish the run.

The trailing provenance block (what Codex examined, whether the diff was embedded) is provenance,
not findings. Leave it out.

## Step 3 — Verify every finding before you touch anything

Codex is a strong reviewer and is sometimes wrong, so take each finding and **check it against the
code**: open the file and lines it cites and work out whether the failure it describes can actually
happen. Then give it one verdict with a one-line reason you would be willing to defend to the user:

- **confirmed** — the defect is real *and* it belongs to this change: code this run wrote or
  touched, or behaviour this change altered.
- **dismissed** — it misreads the code, the behaviour is deliberate, it is a style preference, it
  asks for work beyond what was asked, or it is about code this change never touched.

Both verdicts fail in opposite directions and both are easy. Rubber-stamping the whole list turns a
quick fix into an unplanned refactor of somebody else's code; dismissing whatever is inconvenient
turns the review into theatre. The test for a dismissal is whether the reason survives being read
out loud — "Codex misread the null check, `orderId` is validated at line 41" survives; "seems minor"
does not.

Two cases resolve to neither and are **deferred**: a confirmed defect whose fix lands outside this
change's surface, and a confirmed defect whose fix needs a design decision. Report those with the
finding intact rather than fixing them — a quick fix that quietly rewrites a neighbouring module is
exactly what the user opted out of.

## Step 4 — Fix only what you confirmed

Fix each confirmed finding surgically, fix the cause rather than the messenger — no suppression
comments, no weakened assertions, no test deleted to make a finding go away — and change nothing
else. Do not re-run Codex afterwards: this pipeline reviews once, and the next reader is the user
looking at the diff.

If anything was fixed and there is a build tool, **run the build once more** to check the fixes did
not break it. That is a verification pass, not a second repair loop: if it goes red, report it
plainly and leave the diff for the user.

## Report

Tell the user, in this order:

1. **What changed** — the summary and the files.
2. **The test evidence** — the before/after line per test, as you observed it. A test that was
   green before the change is a regression guard, not proof the fix works; say which is which.
3. **The build** — green, red, or no build tool. Never imply a build that did not run.
4. **The review** — that Codex ran (or did not), how many findings it raised, what you fixed, what
   you **dismissed and why**, and anything **deferred**. The dismissals matter most: they are the
   user's to overrule, and they cannot overrule what they never see.
5. **What is left** — the diff is uncommitted on `<branch>`. Offer `/r:git-commit`, or
   `/r:task-review` over the same diff if they want it reviewed harder before it lands.

## Record the run

One line of bookkeeping, from the repo root. It can never fail the run — if it errors, mention it
and move on; never retry it.

```sh
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:task-quick","kind":"quick","buildTool":"maven|gradle|none","buildGreen":true,
 "reviewRan":true,"reviewSkipped":false,"blockedReason":"","raised":3,"deferred":1,
 "findings":[{"track":"quick-codex","severity":"blocker|critical|major|minor","file":"src/Foo.java","line":88,
              "verdict":"confirmed|dismissed","fixed":true,"description":"one short line"}]}
STATS_JSON
```

`verdict` is the point of the row, and it is your Step 3 judgement rather than Codex's claim: a
reviewer whose findings never survive verification scores the same as one that finds nothing until
the dismissals are recorded too. `fixed` is true only for findings you actually fixed, so a deferred
one is `confirmed` with `fixed: false`. Findings live under their own `quick-codex` track — same
tool as `/r:task-review`'s `codex` track, but a different mode and a much smaller change under it,
and merging them would make neither readable. A review that never ran records `reviewRan: false` and
**no findings at all**: a blockage is not a finding, and writing one in makes a tool that could not
run look like a tool that found something.

## Non-negotiables

- **The review is Codex, or it is nothing.** Never substitute your own read of the diff, an LLM
  imitation, or a summary of "what a reviewer would say". A skipped review is named as skipped.
- **Verify before you fix, and record both verdicts.** Fixing everything Codex says and fixing
  nothing are both failures; the reasons are what make the difference visible.
- **Scope holds to the end.** No hunters, no static analysis, no UI verification, no refactor
  beyond the findings. If a run seems to need those, it needed `/r:task-run`.
- **Nothing is committed here**, no branch is created, and no test is weakened to make a build or a
  finding go away.
