---
description: >-
  Work an implementation plan to completion, one phase at a time — read the `todo.md`, run every
  unticked `### Phase N` in its written order through the implement and review Workflows, merge
  each, tick its boxes, and halt the moment a phase fails rather than building the next one on top
  of it. The plan is the grouping and the ordering: a phase already carries its own `Files:`,
  `Risk:` and runnable `Done when:`, so nothing is re-derived and phases are never reordered or
  folded together. Each phase is re-checked against the current code just before it runs — an
  earlier phase may already have delivered it — then implemented test-first, reviewed at the depth
  its `Risk:` line asks for, and merged into the base as one commit carrying its ticks. Where the
  plan's dependency graph says two phases share no dependency and no file, they can be built at the
  same time in separate sessions — `--no-merge` in a detached worktree each, then `--land` to merge
  them in order. Use on "/r:plan-run", "work through todo.md", "build the whole plan", "run all the
  remaining phases", "implement the plan end to end", "carry on with the plan from phase 4",
  "build these phases in parallel". NOT for: a single phase
  run on its own (`/r:task-run "todo.md / Phase 3"`), a flat backlog of issues or bugs with no
  ordering between them (`/r:issues-fix`), writing the plan in the first place (`/r:spec-design`),
  or reviewing a diff (`/r:task-review`).
disable-model-invocation: true
---

# plan-run

Take a phased implementation plan and build it, phase by phase, until the plan is done or a phase
stops you. Each phase is implemented by the `task-run-implement` Workflow, reviewed by the
`task-review` Workflow, checked against its own `Done when:` command, then merged into the base
branch as one commit that carries the phase's ticks.

Everything uses a **real tool** — a real read and a real write of the plan file, the two real
Workflows, the plan's own `Done when:` command actually executed. Never imitate a phase, a review
or a done-check with a prose summary. If a required tool can't run, stop and tell the user.

Four things shape the whole design:

- **The plan is the grouping, and the ordering, and the tiering.** A `### Phase N` block already
  carries `Files:` (where the change lands), `Risk:` (how deep it cuts) and a runnable `Done when:`.
  Those are exactly the three fields `/r:issues-fix` spends a parallel verification fan-out
  deriving, because a bug tracker has none of them. Here they are written down by whoever planned
  the work, so **derive nothing and re-group nothing**: run the phases as numbered, one per fix.
- **Order is a dependency chain, not a preference.** Phase 5 is written to build on what Phase 4
  produced. So phases are never reordered, never merged, and never run in parallel — and a plan is
  the one backlog shape where "fix the cheap ones first" is wrong.
- **A failed phase halts the run.** This is the rule that most separates this skill from
  `/r:issues-fix`, where one group's failure is explicitly *not* the loop's. Here, building Phase 5
  on a Phase 4 that failed its build, its review or its `Done when:` is how a plan ends up half
  applied with nothing recording which half. Stop, say which phase, and hand back the `--from N`
  that resumes.
- **Two Workflows and a finish, all in *your* main thread.** Both halves are deterministic
  **Workflows**, and the `Workflow` tool exists only in the main thread. Since Claude Code 2.1.217
  the `Agent` tool does too, so a subagent can neither run a Workflow nor spawn the fan-out each
  half depends on. Keeping both here costs almost nothing: a Workflow holds its entire fan-out in
  its own agents and hands back a summary, so your context stays a clean per-phase ledger across a
  twelve-phase plan.

## Invocation

`/r:plan-run [<plan>] [--from <n>] [--to <n>] [--phases <n,n>] [--no-merge] [--land] [--yes] [--dry-run]`

**`<plan>`** is the path to the plan file. Strip a leading `@` and any trailing `/` (Claude Code's
`@todo.md` arrives verbatim). With no argument, look for one and **name what you found before using
it**: `docs/*/todo.md` first (where `/r:spec-design` writes, beside the spec), then `todo.md`,
`PLAN.md` or `IMPLEMENTATION.md` at the repo root. Nothing found, or two candidates with nothing to
choose between them: **ask**. This is the one place the run stops for input that isn't the gate.

- **`--from <phase>`** → start at this phase, skipping every earlier one whatever its checkboxes say.
  This is the resume: a halted run reports the `--from N` that continues it, and it is also how you
  step past a phase you have decided to defer or do by hand.
- **`--to <phase>`** → stop after this phase. `--from 4 --to 6` runs exactly three. Use it to take a
  plan's `v1 (MVP)` block in one sitting and leave `Advanced` for later.
- **`--phases <n,n>`** → run exactly these phases, whatever their position. The primitive `--from`
  and `--to` are sugar over; it is also how one session takes a single leaf out of a wave so the
  rest of that wave runs beside it in other sessions.
- **`--no-merge`** → build, review, run `Done when:`, tick and commit on the phase branch — then
  stop, leaving it unmerged. This is the concurrent-session mode; see
  [Running phases concurrently](#running-phases-concurrently). It changes nothing before the merge.
- **`--land`** → merge the phase branches finished by concurrent sessions into the base, in phase
  order. Runs only from the primary working tree, and does no building of its own.
- **`--yes`** → skip the approval gate and run every phase in the list. It does **not** disable the
  halt: a failed phase still stops the run.
- **`--dry-run`** → read the plan, run the plan check, print the run list **and the wave table with
  the commands that would run its phases concurrently**, then **stop**. Never touches git and never
  edits a character of the plan file. This is the safe preview.

Phase identifiers are the numbers (`--from 4`). Accept a title too when the user gives one, but
resolve it to a number before anything else uses it — the number is what the handoff string carries.

**For a long plan, run it in two passes: `--dry-run` first, then `--yes`.** Reading the plan is
cheap and read-only, so paying for it twice costs almost nothing, and it puts the whole run list and
the plan check in front of the user while nothing is at stake. A `--yes` run whose phases the user
has already read is a very different thing from a `--yes` run nobody looked at.

## Step 0 — Preconditions, the plan, and the base branch

- **Resolve the plan file first**, by the order above, and say which file you are about to execute.
  Silently picking one of three markdown files is how a run builds against a document nobody meant
  to hand you.
- **No `gh`, no GitHub remote, no network.** A plan is a local file and every phase is a local
  branch; don't gate this run on a tool it never calls. (`/r:task-review` may reach for its own
  tools inside its own pipeline — that is its business, and it names its own skips.)
- **Record the base branch.** Note the current branch (usually `main`): every phase branches off it
  and merges back into it, and every phase starts from that same clean base.
- **Require a clean working tree** (`git status --porcelain` empty). The implement Workflow leaves
  work uncommitted until a single final commit, so pre-existing changes would be swept into a
  phase's commit and into its reviewed diff. This covers the plan file itself, which is usually
  tracked right here — a half-edited plan is exactly the change that must not ride along.
- **Run the plan check** — `/r:spec-design` ships the checker that reads a plan the way this skill
  executes one:

  ```sh
  python3 "${CLAUDE_PLUGIN_ROOT}/skills/spec-design/scripts/check_todo.py" <plan>
  ```

  It reports numbering gaps and repeats, phases with no `Done when:`, oversized phases, vague tasks,
  files referenced before they are created, and work that produces a decision rather than a diff.
  **Treat it as advisory and show it at the gate — with two exceptions that are hard stops**:
  *duplicate or missing phase numbers*, because `"<plan> / Phase N"` is the handoff string and an
  ambiguous N sends the implementer at the wrong block; and *a phase with no `- [ ]` items at all*,
  because the checklist is where the acceptance criteria come from and a phase without one hands the
  planner nothing to plan against. Everything else the checker says is a judgement about plan
  quality, and a hand-written plan will fail plenty of it while still being perfectly buildable.
  If the script is missing, say so and continue — a missing checker is a named skip, not a stop.

## Step 1 — Read the plan

Read the file once and parse it. What a phase block is, which lines count as items, what marks one
done, and how a hand-written plan degrades are all in
[references/plan-format.md](references/plan-format.md) — read it before touching this step or the
write-back in Step 3.6.

Take every `### Phase N` block, in **numeric order**, and keep per phase:
`{ n, title, implements, files[], risk, dependsOn, items[], doneWhen, done }`.

- **`done`** is true when every `- [ ]` item in the block is ticked. A partly-ticked phase is **not**
  done — it is a phase an earlier run left half-finished, and it goes back in the list.
- **Filter to the run list**: drop phases already `done`, then apply `--from` / `--to`. `--from`
  overrides the checkboxes in one direction only — it may re-run a phase marked done (the user asked
  for it), and it never resurrects a phase before it.

**`## Resolve first` is a gate, not a phase.** Anything unticked under that heading is work that
needs a *person* — an unknown to settle, a contract to sign, a decision to make — and `/r:spec-design`
puts it there precisely to keep it out of an agent's reach. If it holds unticked entries, **list
them with the phase each one says it blocks, and stop for the user**, unless every blocked phase
falls outside the run list. Never treat one as buildable and never number it yourself.

If the run list is empty, say why — "every phase in `docs/billing/todo.md` is ticked", "`--from 9`
is past the last phase" — and stop.

## Step 2 — The run list and the approval gate

Show the user what this run will build. Name the plan file in the heading, because which document is
about to be executed is the one thing the table cannot show and the user cannot undo afterwards:

```
Plan: docs/billing/todo.md — 9 phases, 4 already done, running 3–7 (5 phases)

Phase  Title                        Tier      Files (from the plan)             Done when
3      Payout persistence           full      PayoutService · V7__payouts.sql   mvn -pl payments test
4      Idempotent payout webhook    full      PayoutWebhookController · V8__…   curl … returns same id
5      Payout admin list page       standard  PayoutAdminController + template  page renders 20 rows
6      CSV export of payouts        standard  ExportService + its template      exported file is UTF-8
7      Retry failed payouts         full      PayoutRetryJob · V9__retry.sql    mvn -pl payments test

Plan check: 2 notes (Phase 6 has no Files: line; Phase 7 is 14 items, over the 12 guideline)
Resolve first: none outstanding
```

- **Tier** is `full` where the phase carries a `**Risk:**` line and blank otherwise (Step 3.3
  explains why a blank means *classified*, not *low*).
- **`--dry-run`** → print this, **record the run** (Step 4's stats line, `mode: "dry-run"`, with
  `phasesInPlan` set and every other count zero), and **stop**. Nothing is built; no branch, no
  commit, and not a character of the plan file.
- **Otherwise** → present the run list and **pause for approval**, unless `--yes` was passed. At the
  gate the user can drop phases off either end, or stop to fix the plan first — which is the cheap
  moment to do it, since every note the checker raised is about a phase nobody has started yet.
- **State the cost plainly** — "5 phases, 5 implement + 5 review passes". That number is the run's
  price and this is the only place the user can change it. Each phase is a full `/r:task-run`-grade
  pass, and the review is the slow half.
- **Say what happens without you.** Once the gate clears, Step 3 runs to the end with no further
  questions — but it **stops at the first phase that fails**, and reports the `--from N` to resume.
  Saying both halves is what makes it safe for the user to walk away.

## Step 3 — Run the phases in order

Work the run list **one phase at a time, in numeric order — never in parallel, never reordered**.
Each phase is a re-check, two Workflow calls, a done-check and a finish, all in **your** (main)
thread, because the `Workflow` tool exists only there and, since 2.1.217, so does the `Agent` tool.
For each phase:

1. **Start from a clean base.** `git checkout <base>` and confirm `git status --porcelain` is empty.
   If a previous phase left the tree dirty, **do not plow ahead** — that is a halt (Step 3.7), not
   something to clean up and carry on through.

   Under **`--no-merge`** this is `git checkout --detach <base>` instead: the run is in a linked
   worktree, where `<base>` cannot be claimed by name while the primary tree holds it. Detaching
   gives the same clean tree at the same commit, and the implement Workflow branches off it exactly
   as it would anywhere else.

2. **Re-check the phase against the code — now, not up front.** Spawn **one** read-only `Explore`
   agent with the phase block and ask it three questions:

   ```
   { status: "build" | "already-done" | "blocked",
     note: "<1–2 lines: what the code already has, or what is missing>",
     filesActual: ["<where the change really lands, if the plan's paths have moved>"] }
   ```

   - **`already-done`** — an earlier phase, or work done outside this plan, already delivered it.
     Tick its boxes (Step 3.6's write-back, marker and all), record it as *already done*, and move to
     the next phase **without building anything**. On a plan that has been sitting a while this is
     the common skip, and it is the reason this check is worth one agent per phase.
   - **`blocked`** — the phase's premise is gone: what it builds on does not exist, or an earlier
     phase built it so differently that the block no longer describes buildable work. That is a
     **halt** (Step 3.7). A plan whose premises have moved needs a person or a re-plan, not an
     implementer guessing.
   - **`build`** — carry `note` and `filesActual` into the next step as context. Paths drifting is
     normal and is **not** `blocked`: `/r:spec-design` writes `Files:` before the code exists.

   **This check belongs here, per phase, and cannot be hoisted into one parallel sweep at the start.**
   Phase 5's premises do not exist until Phase 4 has landed, so a sweep run before the loop would be
   answering about a repository that no longer exists by the time it matters.

3. **Implement — the deterministic implement Workflow, no review yet.**

   ```
   Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/task-run/task-run-implement.workflow.js",
              args: { packRoot: "${CLAUDE_PLUGIN_ROOT}", source: "<plan> / Phase <n>",
                      base: "<base>", profile: "full" } })   // profile ONLY when the phase has a Risk: line
   ```

   `"<plan> / Phase <n>"` is the **todo-phase** source shape. The workflow re-reads the plan itself,
   locates the block, and lifts its checklist into `criteria[]` and its heading into the task intent —
   which is exactly what pasting the phase body in as free text would throw away, since free text is
   defined as the arm with no written criteria to lift. Branch: `phase-<slug>`. **Hand it the
   reference, never the body.**

   **Pass `profile: "full"` when and only when the phase carries a `**Risk:**` line.** `/r:spec-design`
   writes that line only for auth, money, persistence, concurrency and security — the surfaces
   `/r:task-run` escalates on — and omits it rather than writing "Risk: low". So a phase without one
   is a phase the planner made **no** claim about, and forcing a tier there would override a
   classifier that has read the code with a silence that has not. Let it classify.

   The workflow maps the code, runs the UI/UX design phase if anything renders differently, plans on
   Opus, has the **real Codex** challenge the plan, implements test-first through domain subagents
   and drives the build green — then stops, leaving the uncommitted diff on that branch and returning
   the handoff:

   ```
   { branch, base, profile, profileReason, profileForced, uiTouched, uiVisualChange, designIntent,
     taskIntent, criteria, planPath, buildGreen: true | "n/a",   // "n/a" = no build ran, NOT a pass
     planReview: { ran, passes, raised, applied, dropped } }
   ```

   or `{ stopped: <reason>, … }` when it can't honestly continue — which is a **halt** (Step 3.7).

   **Why a Workflow and not a subagent.** Handing this to a `general-purpose` subagent does not work:
   2.1.217 removed the `Agent` tool from subagents, and this pipeline *is* its subagents — the
   explorers, the designer, the planner, the Codex plan reviewer, the implementers, the build runner.
   Nested that way it spawns none of them, collapses to a single context, and still reports success.
   And don't "simplify" it by invoking `/r:task-run` through the Skill tool instead — that works, but
   it loads a whole run into your context, and by the fourth phase this loop would be compacting
   mid-run.

4. **Review — the deterministic Workflow, with a self-check.** The implement half left the working
   tree on the phase's branch with the uncommitted diff, already in front of you:

   ```
   Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/task-review/task-review.workflow.js",
              args: { packRoot: "${CLAUDE_PLUGIN_ROOT}", deferCommit: true, taskIntent,
                      baselineBuilt: <handoff.buildGreen === true> } })  // + profile, uiTouched only if profileForced
   ```

   **`taskIntent`** comes from the handoff; when `designIntent` is non-empty, append it as one clause
   (`… Design intent: <designIntent>`) so the UI verifier judges the pages against the bar the design
   phase set rather than generic taste. `deferCommit` so the review's fixes fold into the single final
   commit.

   **`baselineBuilt` — pass `true` only when the handoff says `buildGreen: true`, never on `"n/a"` or
   `false`.** The implement half has just run a clean, fully green build on this branch in this tree;
   without the flag the review opens by running a second clean build minutes later over a diff that
   has changed only by its own fix phase. On a multi-module JVM project that duplicate is the most
   expensive step in the loop, and a plan pays it once per phase. `"n/a"` means no build ran at all,
   so passing it there would skip the run's only clean build.

   **Pass `profile`/`uiTouched` only when the handoff says `profileForced: true`.** Otherwise leave
   both out: the review classifies from the diff it is about to read, which is strictly better
   evidence than a `Risk:` line written before the code existed.

   **Self-check — the review MUST have run as the Workflow, not prose.** A real run returns a **Run
   ID (`wf_…`)** and a structured result — **record the `wf_…` as proof.** If the `Workflow` tool is
   **unavailable** here, you are **not in a main thread** — this whole `/r:plan-run` has been nested
   inside a subagent — and `/r:task-review` would silently degrade to its prose pipeline. **Halt and
   warn the user loudly** to re-run from a top-level session. Never merge a phase whose review
   couldn't run as the Workflow.

   **Then read the verdict — a Workflow that RETURNS is not a review that PASSED.** The `wf_…` proves
   the pipeline ran; it says nothing about what it found or which steps came back empty-handed. Check
   the result for:
   - `endVerify: "blocked"` — the mandatory Codex pass over the **final** diff did not run, so
     everything the review's own fixers changed is unreviewed.
   - `tracksBlocked` non-empty — a track died; whatever it covers had no reader.
   - `build` or `localScan` not green.

   Any of these means the change has a surface nothing looked at. **Do not merge** — either re-run the
   blocked step until it genuinely runs, or halt.

5. **Run the phase's own `Done when:` check.** The plan wrote a runnable command or an observable
   response for exactly this moment; run it and record its output.

   **A green review is not a green `Done when:`.** The review certifies the *diff* — that it builds,
   that its tests pass, that nothing it touched regressed. `Done when:` is the plan author's claim
   about what the phase was *for*, and it is the only check in this loop that can catch a phase that
   was implemented cleanly and still didn't deliver what the plan asked. A failing `Done when:` after
   a passing review is a **halt**, and an unusually informative one — say both results, because
   "review green, done-when red" is what tells the user the phase's criteria and its plan disagree.

   If `Done when:` is prose with no runnable command in it, say so and record the phase as
   **merged, done-check skipped** — a named skip, never a silent pass.

6. **Finish.** With the review done and its fixes folded into the working tree (still uncommitted on
   the phase branch `<pb>`):
   - **Confirm you are on `<pb>`**: `git rev-parse --abbrev-ref HEAD`. It should never be `<base>`
     (the implement Workflow halts rather than hand back a run that stayed on base), and this is a
     two-second check that stops a whole phase landing on `main`.
   - **Tick the phase, now — after the review and the done-check, before staging.** Flip only the
     items that were actually implemented **and** verified, `- [ ]` → `- [x]`, and tick the phase
     heading itself when the whole phase is done. Re-locate every item by its **verbatim text**,
     never by a line number you read in Step 1. The rules are in
     [references/plan-format.md](references/plan-format.md). A partial phase leaves an honest record.

     The order is the point. **After** the review, so the reviewer's diff is the code change and not
     a bookkeeping edit its doc-consistency hunter has to rule on; **before** the commit, so "built"
     and "ticked" land together and revert together. A tick committed separately, or not at all, is
     how the next run offers the same phase again.
   - **One commit** on `<pb>`: stage everything — implementation, the review's fixes, the ticks — and
     commit once, naming the phase. **Write the message to a file and use `git commit -F <file>`,
     never inline `-m`.** These messages carry phase titles, backticks and quotes straight from the
     plan, and a single stray double-quote breaks the shell mid-commit.
   - **Idempotent merge into base:** if `git merge-base --is-ancestor <pb> <base>` it is already
     merged — skip. Otherwise `git checkout <base> && git merge --no-ff <pb>`, then delete the
     branch. **If the merge conflicts, stop and surface it — never force it.** That is a halt.

     **Under `--no-merge`, stop here instead** — no merge, no branch deletion — and report the
     branch name. The commit carrying the code and the ticks is already on it; `--land` merges it
     from the primary tree later. Nothing earlier in this step changes: the phase is still reviewed,
     still done-checked, still ticked, still one commit.
   - **A plan file outside the repo, or untracked, has no commit to ride in.** Tick it anyway and
     **say so in the report**: that is the one case where reverting a phase leaves the plan still
     claiming the work is done.

7. **Halt, or continue.** On success, record the phase and move to the next one. On any halt —
   `{ stopped: … }` from the implement half, an unavailable `Workflow` tool, a blocked or red review,
   a failed `Done when:`, a merge conflict, a dirty base, a `blocked` re-check, a refused `--slice`
   preflight — **stop the whole run**:
   - Restore a clean base branch. Leave the failed phase's branch in place, unmerged, so the user can
     look at it; name the branch in the report.
   - **Never tick a phase that halted**, and never tick past it.
   - Report which phase stopped it, why, and the exact resume command:
     `/r:plan-run <plan> --from <n>`.
   - **Then go to Step 4 and record the run** — a halt is a result, not a reason to skip the report.
     `haltedAt` is the phase, `haltReason` the cause from the closed list there. A halted run that
     records nothing is how the store comes to hold only successes.'

   **This is deliberately the opposite of `/r:issues-fix`, and the reason is the ordering.** There,
   items are independent, so one failure is one item's failure and the loop continues. Here Phase 5
   is written against what Phase 4 produced, so carrying on past a failure builds real code on a
   premise that isn't true — and it does it silently, because everything after the break still
   compiles and still merges.

## Running phases concurrently

Leaves in the same wave have no dependency between them and share no file, so they can be built at
the same time — one `/r:plan-run` session each. What makes that safe is entirely mechanical, and it
is worth knowing why before using it.

**The git constraint that decides the shape.** A linked worktree cannot check out `<base>` by name
while the primary tree holds it — git refuses with *"'main' is already used by worktree at …"*. So
Step 3.6's `git checkout <base> && git merge --no-ff` **cannot run from a concurrent session at
all**. What is allowed is *detaching*: `git worktree add --detach <path> <base>` gives a clean tree
at base without claiming the ref, and the implement Workflow then branches off it normally.

That single fact settles everything else: concurrent sessions build and commit, they never merge,
and a separate `--land` pass merges from the primary tree.

**One session, one worktree, always.** Two sessions in one working directory destroy each other
immediately — each checks out branches and leaves an uncommitted tree the other is about to stage.
It is also the first thing anyone will try, so it is a preflight refusal rather than a warning.

### Preflight — whenever `--no-merge` is passed

1. **Refuse from the primary working tree.** Detect it:

   ```sh
   [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ]   # true => linked worktree
   ```

   In the primary tree, **stop** and print the `git worktree add --detach` command instead of
   running. A `--no-merge` run there would leave the user's own checkout sitting on a phase branch
   with a finished commit and no merge — recoverable, but exactly the confusion this mode exists to
   avoid.

2. **Verify the slice against the graph**, using the same checker:

   ```sh
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/spec-design/scripts/check_todo.py" <plan> --slice <n,n>
   ```

   It answers only the concurrency question — a dependency not built yet, a dependency inside the
   same slice, a shared file — and stays quiet about plan quality, because refusing to start over a
   missing `Implements:` line would be noise at the worst moment. A non-zero exit is a **stop**: a
   slice that ignores the graph is precisely the failure this whole mode exists to prevent. If the
   checker is missing, say so and **stop anyway** — this is the one place a named skip is not good
   enough, because nothing else checks it.

### What changes inside the loop

Only two steps, and only under `--no-merge`:

- **Step 3.1** becomes `git checkout --detach <base>` rather than a branch checkout, since the
  branch name is unavailable in a worktree. The tree must still be clean.
- **Step 3.6** stops after the commit: no merge, no branch deletion. Report the branch name.

Everything between them — the re-check, both Workflows, the `Done when:` check, the tick, the
single commit — is unchanged. A concurrent session is not a lesser run.

### The commands, which `--dry-run` prints

```
Wave 3 — 3 leaves, none sharing a file. Run concurrently, one session each:

  git worktree add --detach ../billing-p5 main
  cd ../billing-p5 && /r:plan-run docs/billing/todo.md --phases 5 --no-merge

  git worktree add --detach ../billing-p6 main
  cd ../billing-p6 && /r:plan-run docs/billing/todo.md --phases 6 --no-merge

  git worktree add --detach ../billing-p9 main
  cd ../billing-p9 && /r:plan-run docs/billing/todo.md --phases 9 --no-merge

Then, from the primary tree:
  /r:plan-run docs/billing/todo.md --land
```

Print these only for a wave with **more than one unbuilt leaf**. A wave of one is the common case
and the honest answer there is that there is nothing to parallelise; a table of hopeful commands
over single-leaf waves buries the waves where it actually pays.

## `--land` — merging what the concurrent sessions built

Runs **from the primary working tree only** (the same detection, inverted: refuse from a linked
worktree, since base cannot be checked out there). It builds nothing.

1. **Find the finished branches.** `git branch --list 'phase-*'`, keeping those where
   `git merge-base --is-ancestor <branch> <base>` is false.
2. **Map each branch to its phase.** Branches are named `phase-<slug>`, not `phase-<n>`, so read
   the marker the run already wrote (Step 3.6): `git show <branch>:<plan>` and find the heading
   carrying `<!-- built: <branch> -->`. Its number is the phase.

   **A branch with no marker is not a finished phase — skip it and say so.** It is a run that
   halted, or someone else's branch that happens to match the glob. Guessing which phase it was
   would merge unreviewed work.
3. **Merge in ascending phase order**, one at a time: `git merge --no-ff <branch>`, then delete the
   branch. Ascending order is a valid dependency order, because the plan's numbering is a
   topological sort of the graph.
4. **On a conflict, stop and surface it — never force it.** Report which branch, leave it in place
   and unmerged, and name the ones already landed so a re-run continues rather than repeats. The
   merge is idempotent (step 1 skips anything already an ancestor), so re-running after a manual
   resolution is safe.

Then **record the run** — Step 4's stats line with `mode: "land"`, `landed` set to what merged, and
`phasesInRun: 0`, because a landing pass builds nothing. A conflict that stopped it is
`haltReason: "merge-conflict"` with the phase in `haltedAt`.

**About the plan file.** Every phase ticks it, so it is the one file every branch touches — which is
why the wave collision check excludes it. In practice git merges the ticks cleanly, because separate
phases occupy separate regions of the document. When two phases sit adjacent enough to conflict, the
resolution is always **both sides' ticks**: each branch ticked what it genuinely built, and neither
tick invalidates the other.

## Step 4 — Report

Close with a summary of the whole run. Include each phase's **review tier** — the `profile` the
review Workflow returned, which is the depth its diff actually got, not the `Risk:` line's guess.
Across a plan that column is the one thing that shows where the effort went, and both Workflows log
their tier only to the `/workflows` view, so it reaches the user nowhere else.

```
Plan: docs/billing/todo.md — 9 phases, 4 already done, ran 3–7.

Built, reviewed & merged:
  Phase 3  Payout persistence          full      merged phase-payout-persistence → main, 6/6 ticked, done-when green
  Phase 4  Idempotent payout webhook   full      merged phase-idempotent-payout-webhook → main, 5/5 ticked, done-when green
  Phase 5  Payout admin list page      standard  already delivered by Phase 3 — ticked, nothing built

Halted:
  Phase 6  CSV export of payouts       review returned endVerify: "blocked" — the final Codex pass
                                       never ran, so the review's own fixes are unreviewed.
                                       Branch phase-csv-export-of-payouts left in place, unmerged.

Not reached: Phase 7 (Retry failed payouts).
Resume with: /r:plan-run docs/billing/todo.md --from 6
```

Name every phase that was built, which branch merged into base, every phase the re-check found
already done, the phase that halted and why, and the phases never reached. **Say plainly what was
written back and what wasn't** — a phase merged with no tick is a phase the next run will offer
again.

Then record one line into the pack-wide store — counts only, never phase titles or plan paths.
**Every run records, including a halt, a `--dry-run` and a `--land`:**

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:plan-run","mode":"serial","phasesInPlan":0,"phasesInRun":0,"merged":0,"landed":0,
 "alreadyDone":0,"doneCheckRan":0,"doneCheckFailed":0,"haltedAt":null,"haltReason":null}
STATS_JSON
```

**`mode` is what makes every other number readable**, and it is `serial` | `no-merge` | `land` |
`dry-run`. Without it a `--no-merge` session records `merged: 0` — because it is *supposed* not to
merge — and that is indistinguishable from a run whose merge failed. Same trap as a track that
scores zero because its tier never dispatched it: absence of an action is not a failed action, and
only the row itself can say which this was.

**Count what this run actually did, and leave the rest at zero.** A `no-merge` session sets
`phasesInRun` and `merged: 0`; a `land` pass sets `landed` and leaves `phasesInRun: 0`, because it
builds nothing. A `dry-run` sets `phasesInPlan` and nothing else.

**So read the concurrent flow across rows, never within one.** A wave built in three sessions and
landed from the primary tree is *four* rows — three `no-merge` and one `land` — and no single one of
them holds both halves. The question "how far does a plan survive contact with the code" is
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

The script always exits `0` — a lost row is a lost row, never a failed run, and it must never change
what was merged, landed or ticked. Never retry it.

## Non-negotiables

- **The plan's order is the run's order.** Within a session, phases run one at a time, in numeric
  order, never reordered and never folded together. A phase is written against what the earlier ones
  produced, so grouping two phases into one change — the thing `/r:issues-fix` exists to do — is
  here a way to build a commit you cannot revert by halves against premises you never checked.
- **Concurrency is across sessions, never inside one, and only where the graph allows it.** Two
  leaves may be built at the same time when the plan says they share no dependency and no file —
  each in its own detached worktree, with `--no-merge`, verified by the checker's `--slice`
  preflight first. The reason for the original prohibition is unchanged: two runs sharing a working
  tree or a base ref destroy each other. What changed is that the preflight now enforces it instead
  of a blanket ban — a slice run in one directory, or one the graph refuses, is a **stop**.
- **A failed phase halts the whole run.** Not the phase's failure, the run's. Restore a clean base,
  leave the failed branch unmerged, never tick it, and report the `--from N` that resumes. Building
  Phase 5 on a Phase 4 that failed its build, its review or its `Done when:` is the single worst
  outcome this skill can produce, because everything after the break still compiles.
- **Derive nothing the plan already states.** `Files:`, `Risk:` and `Done when:` are the plan
  author's, and there is no verification fan-out here to second-guess them. The one thing that *is*
  checked per phase is whether the code has moved underneath the plan — one read-only agent,
  immediately before that phase runs, never a sweep at the start.
- **Both halves are Workflows, run from your main thread.** `task-run-implement.workflow.js`, then
  `task-review.workflow.js`. Each isolates its own fan-out and returns a summary, so neither floods
  your context and neither can silently degrade. Never hand either to a subagent — since 2.1.217 a
  subagent has no `Agent` tool, so the implement half can't spawn its planner, its Codex reviewer or
  its implementers, and the review half can't reach the `Workflow` tool at all. Both failures are
  silent: the work still returns something that looks like success.
- **The review runs as the Workflow — verify it, never accept a silent prose fallback.** Confirm the
  `wf_…` Run ID. If the `Workflow` tool isn't available, `/r:plan-run` is not in a real main thread
  — **halt and tell the user** to re-run from a top-level session.
- **A returned Workflow is not a passed review.** Read the result: `endVerify: "blocked"`,
  a non-empty `tracksBlocked`, or a red `build`/`localScan` each mean part of the diff had no reader.
  Do not merge on any of them.
- **Run the phase's `Done when:`, or name the skip.** It is the only check that asks whether the
  phase delivered what it was for, rather than whether the diff is sound. Prose with no runnable
  command is recorded as *done-check skipped*, never as a pass.
- **Hand the implement Workflow a reference, never a body.** `"<plan> / Phase <n>"` — it re-reads
  the plan for the checklist and the intent. A phase body pasted as free text arrives with no
  criteria at all.
- **Force the tier only where the plan does.** `profile: "full"` when the phase carries a `Risk:`
  line; omit `profile` entirely when it doesn't. A missing `Risk:` line means the planner made no
  claim, not that the phase is low risk — and the classifier reading the actual code knows more than
  the plan did.
- **`## Resolve first` is never buildable.** Unticked entries there block the phases they name and
  need a person. List them and stop; never number one, never hand one to the implement Workflow.
- **Tick only what was built and verified, after the review and before the commit.** A partial phase
  leaves partial ticks — that is an honest record, not a defect. A phase ticked before its review, or
  ticked after its commit, is a phase whose "built" and "done" no longer revert together.
- **Clean base between phases.** Every phase starts from a clean checkout of the recorded base. Never
  sweep an unrelated dirty tree into a phase's commit; if the merge conflicts, surface it and halt —
  never force it.
- **Honor the approval gate unless `--yes`.** `--dry-run` never mutates anything, and `--yes` skips
  the gate but never the halt.
