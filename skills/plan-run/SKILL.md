---
description: >-
  Work an implementation plan to completion, one phase at a time: read the `todo.md`, run every
  unticked `### Phase N` in its written order through the implement and review Workflows, merge
  each, tick its boxes, and halt the moment a phase fails rather than building the next on top of
  it. The plan is the grouping and the ordering — a phase carries its own `Files:`, `Risk:` and
  runnable `Done when:`, so nothing is re-derived and phases are never reordered or folded. Each
  phase is re-checked against the current code just before it runs, implemented test-first,
  reviewed at the depth its `Risk:` line asks for, and merged into the base as one commit carrying
  its ticks. Phases the dependency graph puts in one wave (no shared dependency, no shared file) can
  be built at the same time in separate sessions — `--no-merge` in a detached worktree each, then
  `--land` to merge them in order — by hand, or driven with `--cmux`, one interactive session per
  leaf in its own cmux workspace. Use on "/r:plan-run", "work through todo.md", "build the whole
  plan", "run all the remaining phases", "implement the plan end to end", "carry on with the plan
  from phase 4", "build these phases in parallel". NOT for: a single phase on its own
  (`/r:task-run "todo.md / Phase 3"`), a flat backlog of issues or bugs with no ordering between
  them (`/r:issues-fix`), writing the plan in the first place (`/r:spec-design`), or reviewing a
  diff (`/r:task-review`).
disable-model-invocation: true
---

# plan-run

Build a phased implementation plan, phase by phase, until the plan is done or a phase stops you.
Each phase is implemented by the implement workflow (`task-run-implement.workflow.js`), reviewed by
the `task-review` Workflow, checked against its own `Done when:` command, then merged into the base
branch as one commit that carries the phase's ticks.

Everything uses a **real tool** — a real read and write of the plan file, the two real Workflows,
the plan's own `Done when:` command actually executed. Never imitate a phase, a review or a
done-check with a prose summary; if a required tool can't run, stop and say so.

Four things shape the design:

- **The plan is the grouping, the ordering and the tiering.** A `### Phase N` block already carries
  `Files:`, `Risk:` and a runnable `Done when:` — the three fields `/r:issues-fix` spends a parallel
  verification fan-out deriving. Here the planner wrote them down, so **derive nothing and re-group
  nothing**: run the phases as numbered, one per fix.
- **Order is a dependency chain, not a preference.** Phase 5 is written to build on what Phase 4
  produced, so phases are never reordered, never merged, never run in parallel — a plan is the one
  backlog shape where "fix the cheap ones first" is wrong.
- **A failed phase halts the run** — unlike `/r:issues-fix`, where one group's failure is explicitly
  *not* the loop's. Building Phase 5 on a failed Phase 4 leaves a plan half applied with nothing
  recording which half. Stop, say which phase, and hand back the `--from N` that resumes.
- **Two Workflows and a finish, all in *your* main thread.** Only the main thread can run a Workflow
  or spawn the fan-out each depends on (Step 3 states the rule); a Workflow holds its fan-out in its
  own agents and hands back a summary, so your context stays a per-phase ledger.

## Invocation

`/r:plan-run [<plan>] [--from <n>] [--to <n>] [--phases <n,n>] [--cmux] [--no-merge] [--land] [--auto-resolve] [--unattended] [--ask <session>] [--yes] [--dry-run]`

**`<plan>`** is the path to the plan file. Strip a leading `@` and any trailing `/` (Claude Code's
`@todo.md` arrives verbatim). With no argument, look for one and **name what you found before using
it**: `docs/*/todo.md` first (where `/r:spec-design` writes), then `todo.md`, `PLAN.md` or
`IMPLEMENTATION.md` at the repo root. Nothing found, or two candidates with nothing to choose
between them: **ask** — the one place the run stops for input that isn't the gate. Under
`--unattended` a tie takes the first by that order and says which.

- **`--from <phase>`** → start here, skipping every earlier phase whatever its checkboxes say. This
  is the resume a halted run reports, and how you step past a phase you deferred or did by hand.
- **`--to <phase>`** → stop after this phase. `--from 4 --to 6` runs exactly three; use it to take a
  plan's `v1 (MVP)` block and leave `Advanced` for later.
- **`--phases <n,n>`** → run exactly these phases, whatever their position — the primitive `--from`
  and `--to` are sugar over, and how one session takes a single leaf out of a wave.
- **`--cmux`** → run each wave's leaves at the same time: a detached worktree and a cmux workspace
  per leaf, each holding a real interactive `claude` session, then land the wave from here — the
  executor for the command block `--dry-run` prints ([Running phases
  concurrently](#running-phases-concurrently)). **Without it nothing about this skill changes**:
  the run is the serial one below, and no worktree is created. `--cmux` with `--no-merge` or
  `--land` is a contradiction — those two *are* the halves it drives — so refuse and name which one
  clashed.
- **`--no-merge`** → build, review, run `Done when:`, tick and commit on the phase branch — then
  stop, leaving it unmerged. This is the concurrent-session mode ([Running phases
  concurrently](#running-phases-concurrently)) — read [Being a unit](#being-a-unit) when
  `CMUX_FANOUT_ORCHESTRATOR` is set. It changes nothing before the merge.
- **`--land`** → merge the phase branches finished by concurrent sessions into the base, in phase
  order. Runs only from the primary working tree; it builds after each merge and nothing else.
- **`--auto-resolve`** → with `--land`, resolve the conflicts that are **provably** additive instead
  of stopping on them, then build and run the full test suite before accepting. Off by default;
  everything it cannot prove is still handed to you.
- **`--unattended`** → run without a person watching: work around everything that can be worked
  around, notify only when the run cannot continue. Implies `--yes` and `--auto-resolve`. It does
  **not** loosen what counts as a real failure — see [Running unattended](#running-unattended).
- **`--ask <session>`** → the address of a pack maintainer session watching the tooling: report
  defects **in the pack** there and keep going ([`--ask <session>`](#--ask-session--reporting-a-defect-in-the-pack)).
  It changes nothing about the run — a report is never a halt and never a question. **Pair it with
  `--unattended`**, which otherwise works around a pack defect and leaves nobody able to fix it any
  the wiser.
- **`--yes`** → skip the approval gate and run every phase in the list. It does **not** disable the
  halt: a failed phase still stops the run.
- **`--dry-run`** → read the plan, run the plan check, print the run list **and the wave table with
  the commands that would run its phases concurrently**, then **stop**. Never touches git and never
  edits a character of the plan file.

Phase identifiers are the numbers (`--from 4`). Accept a title too, but resolve it to a number
first — the number is what the handoff string carries.

**For a long plan, run it in two passes: `--dry-run` first, then `--yes`.** Reading the plan is
cheap, and a `--yes` run whose phases the user has read is a different thing from one nobody looked
at.

## Step 0 — Preconditions, the plan, and the base branch

- **Resolve the plan file first**, by the order above, and say which file you are about to execute —
  silently picking one of three markdown files is how a run builds against a document nobody meant
  to hand you.
- **No `gh`, no GitHub remote, no network.** A plan is a local file and every phase is a local
  branch; don't gate this run on a tool it never calls. (`/r:task-review` may reach for its own
  tools inside its pipeline and names its own skips.)
- **Record the base branch** (usually `main`): every phase branches off it, merges back into it, and
  starts from that same clean base.
- **Require a clean working tree** (`git status --porcelain` empty). The implement Workflow leaves
  work uncommitted until a single final commit, so pre-existing changes would be swept into a
  phase's commit and its reviewed diff — the plan file itself included.
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
  because the checklist is where the acceptance criteria come from. Everything else is a judgement
  about plan quality a hand-written plan can fail while still being buildable. A missing script is a
  named skip, not a stop: say so and continue.

## Step 1 — Read the plan

Read the file once and parse it. What a phase block is, which lines count as items, what marks one
done, and how a hand-written plan degrades are in
[references/plan-format.md](references/plan-format.md) — read it before this step or the write-back
in Step 3.6.

Take every `### Phase N` block, in **numeric order**, and keep per phase:
`{ n, title, implements, files[], risk, dependsOn, items[], doneWhen, done }`.

- **`done`** is true when every `- [ ]` item in the block is ticked. A partly-ticked phase is **not**
  done — it goes back in the list.
- **Filter to the run list**: drop phases already `done`, then apply `--from` / `--to`. `--from`
  overrides the checkboxes in one direction only — it may re-run a phase marked done (the user asked
  for it), and it never resurrects a phase before it.

**`## Resolve first` is a gate, not a phase.** Anything unticked under that heading needs a
*person* — an unknown to settle, a contract to sign, a decision to make — and `/r:spec-design` puts
it there to keep it out of an agent's reach. If it holds unticked entries, **list them with the
phase each one says it blocks, and stop for the user**, unless every blocked phase falls outside
the run list. Never treat one as buildable and never number it yourself.

**Under `--unattended`, drop the blocked phases from the run list and build the rest**, naming both
halves in the report. The blocker still needs a person and no blocked phase is built — one
unresolved question stops one phase, not the night.

If the run list is empty, say why — "every phase in `docs/billing/todo.md` is ticked", "`--from 9`
is past the last phase" — and stop.

## Step 2 — The run list and the approval gate

Show the user what this run will build, naming the plan file in the heading:

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
  `phasesInPlan` set and every other count zero), and **stop**. No branch, no commit, and not a
  character of the plan file.
- **Otherwise** → present the run list and **pause for approval**, unless `--yes` or `--unattended`
  was passed. Here the user can drop phases off either end, or stop to fix the plan first — the
  cheap moment, since every checker note is about a phase nobody has started.
- **State the cost plainly** — "5 phases, 5 implement + 5 review passes". That is the run's price
  and this is the only place the user can change it; the review is the slow half.
- **Say what happens without you.** Once the gate clears, Step 3 runs to the end with no further
  questions — but it **stops at the first phase that fails**, and reports the `--from N` to resume.
  Saying both halves is what makes it safe for the user to walk away.
- **Under `--unattended`, say that instead**: the run works around a dirty base, a conflict it can
  prove additive, and a wave the preflight refuses (that one goes serial); it stops on a failed
  phase, and notifies only then. Print the table's halt column from [Running
  unattended](#running-unattended) in one sentence — what will and will not fetch them back is what
  they need before walking away.
- **Under `--cmux` only**, add the wave as a column — from the `check_todo.py` run Step 0 made,
  nothing new is computed — and say how many leaves will be built at once and how many at a time
  (the cap is three).

## Step 3 — Run the phases in order

Work the run list **one phase at a time, in numeric order — never in parallel, never reordered**.
Each phase is a re-check, two Workflow calls, a done-check and a finish, all in **your** (main)
thread. Subagents have no `Agent` tool; only the main thread — and a `Workflow` script, which runs
there — can spawn. Check, don't assume: `ToolSearch` cannot answer it (only deferred tools are
indexed) and only a real call is evidence; nested spawning may return in a later release. If you
can reach neither `Workflow` nor `Agent`, you are nested inside a subagent: stop and tell the user
to re-run from a top-level session. Never re-run the fan-out inline and report success.

This is the whole of Step 3 unless `--cmux` was passed. With it, a wave's leaves are handed to
sessions of their own and you orchestrate rather than build — [`--cmux`, the driven
form](#--cmux--the-driven-form) — but every phase still runs exactly the loop below. For each phase:

1. **Start from a clean base.** `git checkout <base>` and confirm `git status --porcelain` is empty.
   If a previous phase left the tree dirty, **do not plow ahead** — that is a halt (Step 3.7), not
   something to clean up and carry on through.

   Under **`--no-merge`** this is `git checkout --detach <base>` instead — the run is in a linked
   worktree, where `<base>` cannot be claimed by name while the primary tree holds it.

2. **Re-check the phase against the code — now, not up front.** Spawn **one** read-only `Explore`
   agent with the phase block and ask it:

   ```
   { status: "build" | "already-done" | "blocked",
     note: "<1–2 lines: what the code already has, or what is missing>",
     filesActual: ["<where the change really lands, if the plan's paths have moved>"] }
   ```

   - **`already-done`** — an earlier phase, or work outside this plan, already delivered it. Tick
     its boxes (Step 3.6's write-back, marker and all), record it as *already done*, and move to the
     next phase **without building anything**.
   - **`blocked`** — the phase's premise is gone: what it builds on does not exist, or an earlier
     phase built it so differently that the block no longer describes buildable work. That is a
     **halt** (Step 3.7); moved premises need a person or a re-plan, not a guessing implementer.
   - **`build`** — carry `note` and `filesActual` into the next step as context. Paths drifting is
     normal and is **not** `blocked`: `/r:spec-design` writes `Files:` before the code exists.

   **This check belongs here, per phase, and cannot be hoisted into one parallel sweep at the start**:
   Phase 5's premises do not exist until Phase 4 has landed.

3. **Implement — the deterministic implement Workflow, no review yet.**

   ```
   Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/task-run/task-run-implement.workflow.js",
              args: { packRoot: "${CLAUDE_PLUGIN_ROOT}", source: "<plan> / Phase <n>",
                      base: "<base>", profile: "full" } })   // profile ONLY when the phase has a Risk: line
   ```

   `"<plan> / Phase <n>"` is the **todo-phase** source shape. The workflow re-reads the plan itself,
   locates the block, and lifts its checklist into `criteria[]` and its heading into the task intent —
   exactly what pasting the body in as free text throws away, since free text has no written
   criteria to lift. Branch: `phase-<slug>`. **Hand it the reference, never the body.**

   **Pass `profile: "full"` when and only when the phase carries a `**Risk:**` line.** `/r:spec-design`
   writes that line only for auth, money, persistence, concurrency and security, and omits it rather
   than writing "Risk: low". A phase without one is one the planner made **no** claim about, and
   forcing a tier there overrides a classifier that has read the code with a silence that has not.
   Let it classify.

   The workflow maps the code, runs the UI/UX design phase if anything renders differently, plans on
   Opus, has the **real Codex** challenge the plan, implements test-first through domain subagents
   and drives the build green — then stops, leaving the uncommitted diff on the branch and returning
   the handoff:

   ```
   { branch, base, profile, profileReason, profileForced, uiTouched, uiVisualChange, designIntent,
     taskIntent, criteria, planPath, buildGreen: true | "n/a",   // "n/a" = no build ran, NOT a pass
     planReview: { ran, passes, raised, applied, dropped } }
   ```

   or `{ stopped: <reason>, … }` when it can't honestly continue — a **halt** (Step 3.7).

   **Why a Workflow and not a subagent.** This pipeline *is* its subagents — explorers, designer,
   planner, Codex plan reviewer, implementers, build runner — and a subagent cannot spawn any of
   them; nested there it collapses to a single context and still reports success. Don't "simplify"
   it by invoking `/r:task-run` through the Skill tool either — that loads a whole run into your
   context, and by the fourth phase this loop would be compacting.

4. **Review — the deterministic Workflow, with a self-check.** The implement half left the working
   tree on the phase's branch with the uncommitted diff:

   ```
   Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/task-review/task-review.workflow.js",
              args: { packRoot: "${CLAUDE_PLUGIN_ROOT}", deferCommit: true, taskIntent,
                      baselineBuilt: <handoff.buildGreen === true> } })  // + profile, uiTouched only if profileForced
   ```

   **`taskIntent`** comes from the handoff; when `designIntent` is non-empty, append it as one clause
   (`… Design intent: <designIntent>`) so the UI verifier judges the pages against the design phase's
   bar rather than generic taste. `deferCommit` so the review's fixes fold into the single final
   commit.

   **`baselineBuilt` — pass `true` only when the handoff says `buildGreen: true`, never on `"n/a"` or
   `false`.** The implement half has just run a clean, fully green build on this branch in this tree;
   without the flag the review repeats it — on a multi-module JVM project the most expensive step in
   the loop, paid once per phase. `"n/a"` means no build ran at all, so passing it there would skip
   the run's only clean build.

   **Pass `profile`/`uiTouched` only when the handoff says `profileForced: true`.** Otherwise leave
   both out: the review classifies from the diff it is about to read, better evidence than a `Risk:`
   line written before the code existed.

   **Self-check — the review MUST have run as the Workflow, not prose.** A real run returns a **Run
   ID (`wf_…`)** and a structured result — **record the `wf_…` as proof.** If the `Workflow` tool is
   **unavailable** here, you are **not in a main thread** — this whole `/r:plan-run` is nested inside
   a subagent — and `/r:task-review` would silently degrade to its prose pipeline. **Halt and warn
   the user loudly** to re-run from a top-level session. Never merge a phase whose review couldn't
   run as the Workflow.

   **Then read the verdict — a Workflow that RETURNS is not a review that PASSED.** The `wf_…` proves
   the pipeline ran, not what it found. Check the result for:
   - `endVerify: "blocked"` — the mandatory Codex pass over the **final** diff did not run, so
     everything the review's own fixers changed is unreviewed.
   - `tracksBlocked` non-empty — a track died; whatever it covers had no reader.
   - `build` or `localScan` not green.

   Any of these means part of the change had no reader. **Do not merge** — re-run the blocked step
   until it genuinely runs, or halt.

5. **Run the phase's own `Done when:` check** — the runnable command or observable response the plan
   wrote for exactly this moment — and record its output.

   **A green review is not a green `Done when:`.** The review certifies the *diff*; `Done when:` is
   the plan author's claim about what the phase was *for*, and the only check that catches a phase
   implemented cleanly that still didn't deliver. A failing `Done when:` after a passing review is a
   **halt** — say both results, because "review green, done-when red" tells the user the phase's
   criteria and its plan disagree.

   If `Done when:` is prose with no runnable command, say so and record the phase as **merged,
   done-check skipped** — a named skip, never a silent pass.

6. **Finish.** With the review's fixes folded into the working tree, still uncommitted on the phase
   branch `<pb>`:
   - **Confirm you are on `<pb>`**: `git rev-parse --abbrev-ref HEAD`. It should never be `<base>`
     (the implement Workflow halts if it never *left* base, and re-reads HEAD at its handoff, so a
     HEAD that moved afterwards arrives as `branchDrifted: true` with the real branch — but this
     check is the one that runs after the review, and a review that halted never reached it);
     this check stops a whole phase landing on `main`.
   - **Confirm nobody else is holding the repo**, before the merge into base: `.git/MERGE_HEAD`
     present is an unfinished merge, and `<base>` at a different commit than Step 0 read is a session
     that landed something meanwhile. Either is a **halt** — merging over it sweeps another run's
     work into this phase's commit, or resolves against a base nobody reviewed. Report which one,
     and leave `<pb>` in place: it holds a finished commit and `--land` merges it later.
   - **Tick the phase, now — after the review and the done-check, before staging.** Flip only the
     items that were actually implemented **and** verified, `- [ ]` → `- [x]`, and tick the phase
     heading itself when the whole phase is done. Re-locate every item by its **verbatim text**,
     never by a line number read in Step 1; the rules are in
     [references/plan-format.md](references/plan-format.md). A partial phase leaves an honest record.

     The order is the point. **After** the review, so the reviewer's diff is the code change and not
     a bookkeeping edit its doc-consistency hunter has to rule on; **before** the commit, so "built"
     and "ticked" land together and revert together.
   - **Rewrite the phase's `Files:` line from the diff**, in the same edit as the ticks:
     `git diff --name-only <base>...<pb>`, minus generated artefacts. The plan's line is written
     before the code exists, so it names what the feature *carries* and never what it must touch to
     be wired in — and that line is what `--slice` compares to decide whether two phases may run at
     once. The exact rule, and what to drop, is in
     [references/plan-format.md](references/plan-format.md).
   - **One commit** on `<pb>`: stage everything — implementation, the review's fixes, the ticks — and
     commit once, naming the phase. **Write the message to a file and use `git commit -F <file>`,
     never inline `-m`**: these messages carry phase titles, backticks and quotes straight from the
     plan, and a single stray double-quote breaks the shell mid-commit.
   - **Idempotent merge into base:** if `git merge-base --is-ancestor <pb> <base>` it is already
     merged — skip. Otherwise `git checkout <base> && git merge --no-ff <pb>`, then delete the
     branch. **If the merge conflicts, stop and surface it — never force it.** That is a halt.

     **Under `--no-merge`, stop here instead** — no merge, no branch deletion — and report the
     branch name; `--land` merges it from the primary tree later. Nothing earlier in this step
     changes: the phase is still reviewed, still done-checked, still ticked, still one commit.
   - **If `CMUX_FANOUT_SENTINEL` is set in the environment, write the outcome there as the very last
     thing you do** — two lines, `status=ok` and `branch=<pb>`. That variable means this session is
     one unit of a `--cmux` fan-out; an interactive session never exits and yields no status, so this
     file is the only way the orchestrator learns the run ended rather than stalled. It is the *last*
     action because a sentinel written before the commit would announce work not yet on the branch.
   - **A plan file outside the repo, or untracked, has no commit to ride in.** Tick it anyway and
     **say so in the report**: reverting the phase would leave the plan still claiming the work.

7. **Halt, or continue.** On success, record the phase and move to the next one. On any halt —
   `{ stopped: … }` from the implement half, an unavailable `Workflow` tool, a blocked or red review,
   a failed `Done when:`, a merge conflict, a dirty base, a `blocked` re-check, a refused `--slice`
   preflight — **stop the whole run**:
   - Restore a clean base branch. Leave the failed phase's branch in place, unmerged, and name it in
     the report.

   **Under `--unattended`, four of those are worked around instead** — a conflict, a dirty base, a
   refused slice, and a review or repo that was merely busy. The other four are still halts, because
   they mean the next phase's premise is untrue. [Running unattended](#running-unattended) has the
   table, and every workaround is named in the report and counted in `degraded`.
   - **Never tick a phase that halted**, and never tick past it.
   - Report which phase stopped it, why, and the exact resume command:
     `/r:plan-run <plan> --from <n>`.
   - **If `CMUX_FANOUT_SENTINEL` is set, write a failure sentinel there** — `status=halted`, the
     branch if there is one, and `reason=<the halt>`. A halt that writes nothing is
     indistinguishable from a session still thinking, and the orchestrator would sit on it until the
     timeout.
   - **Then go to Step 4 and record the run** — a halt is a result, not a reason to skip the report.
     `haltedAt` is the phase, `haltReason` the cause from the closed list there; a halted run that
     records nothing is how the store comes to hold only successes.

   **This is deliberately the opposite of `/r:issues-fix`, where items are independent and one
   failure is one item's.** Here carrying on past a failure builds real code on a premise that isn't
   true — silently, because everything after the break still compiles and merges.

## Running phases concurrently

Leaves in the same wave have no dependency between them and share no file, so they can be built at
the same time — one `/r:plan-run` session each. What makes that safe is entirely mechanical, and
[references/concurrent-sessions.md](references/concurrent-sessions.md) is the mechanics: the exact
`git worktree` commands, the tree-detection test, the checker's three refusals and the loop `--land`
uses to read a branch's marker. **Read it before running either `--no-merge` or `--land`** — here
is why each rule exists, not what to type.

**The git constraint that decides the shape.** A linked worktree cannot check out `<base>` by name
while the primary tree holds it — git refuses with *"'main' is already used by worktree at …"* — so
Step 3.6's `git checkout <base> && git merge --no-ff` **cannot run from a concurrent session at
all**. *Detaching* is allowed: `git worktree add --detach <path> <base>` gives a clean tree at base
without claiming the ref. That settles the shape: concurrent sessions build and commit, they never
merge, and a separate `--land` pass merges from the primary tree.

**One session, one worktree, always.** Two sessions in one working directory destroy each other —
each leaves an uncommitted tree the other is about to stage — and it is the first thing anyone will
try, so it is a preflight refusal rather than a warning.

### Preflight — whenever `--no-merge` is passed

1. **Refuse from the primary working tree.** A `--no-merge` run there would strand the user's own
   checkout on a phase branch with a finished commit and no merge. Stop and print the
   `git worktree add --detach` command instead.

2. **Verify the slice against the graph** with `check_todo.py --slice <n,n>`. It answers only the
   concurrency question — a dependency not built yet, a dependency inside the same slice, a shared
   file — and stays quiet about plan quality, since refusing to start over a missing `Implements:`
   line would be noise at the worst moment. A non-zero exit is a **stop**. If the checker is
   missing, say so and **stop anyway** — nothing else checks the slice, so a named skip is not good
   enough here.

   **Under `--unattended` a refusal degrades rather than stops**: build that wave's leaves serially,
   in numeric order, and name the refusal in the report — the refusal is about *concurrency* only,
   and every leaf is still buildable. A missing checker is still a stop, unattended or not: not
   knowing whether the slice is safe is a different thing from knowing it is not.

3. **Ask history what the plan cannot know**, once the checker has cleared the slice:

   ```sh
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/plan-run/scripts/footprint-warn.py" <plan> \
           --slice <n,n> --base <base>
   ```

   The checker compares declared `Files:` lines, written before the code exists, so a slice can be
   cleared honestly and still not merge. This reads what every earlier phase actually touched in the
   packages these land in: a fact in git rather than a prediction.

   **Exit 2 is a risk, not an error.** Serially, print it and carry on: the cost of being wrong is
   one merge conflict. Under `--cmux`, **stop** — there the cost is the whole wave, built over hours
   before anything discovers it. Under `--cmux --unattended`, build that wave serially instead of
   stopping, and name it. Exit 0 covers both "looks clean" and "not enough history to judge", and it
   says which; exit 1 is usage or git trouble and is a named skip, because this check improves the
   preflight rather than being it.

   The two answers to a risk are in the report: run one leaf per package at a time, or correct the
   `Files:` lines from the code that now exists and re-run. Step 3.6 does the second for every phase from here
   on, so this warning shrinks as the plan builds out.

### What changes inside the loop

Only two steps, and only under `--no-merge`:

- **Step 3.1** becomes `git checkout --detach <base>`, since the branch name is unavailable in a
  worktree. The tree must still be clean.
- **Step 3.6** stops after the commit: no merge, no branch deletion. Report the branch name.

Everything between them — the re-check, both Workflows, the `Done when:` check, the tick, the
single commit — is unchanged. A concurrent session is not a lesser run.

### What `--dry-run` prints

The worktree/`--no-merge`/`--land` command block from the reference, filled in for the wave — but
only for a wave with **more than one unbuilt leaf**. A wave of one has nothing to parallelise, and a
table of hopeful commands over single-leaf waves buries the waves where it pays.

Under `--dry-run --cmux`, print the same block as the `spawn` calls that would be made instead, and
**stop**: no worktree, no workspace, nothing on screen.

### `--cmux` — the driven form

`--cmux` runs the block above instead of printing it. Everything that makes concurrency *safe* is
unchanged — the waves, the `--slice` preflight, `--no-merge` in a detached worktree, `--land` from
the primary tree.

Each leaf gets a **full interactive `claude` session**, not a headless one — the point of routing
this through cmux: the work is visible in a workspace the user can open, answer a question in, or
take over, none of which a `-p` run allows.

You are the orchestrator and you **build nothing yourself while a wave is in flight** — you hold the
primary tree, the only tree that can check out `<base>` to land what the units produce.

The mechanics are `${CLAUDE_PLUGIN_ROOT}/skills/plan-run/scripts/cmux-fanout.sh`, a script rather
than prose because it decides two things a model must never decide by reading a screen — whether
the tooling is there, and whether a unit is finished — and both fail by returning a confident wrong
answer.

For each wave, in wave order:

1. **A wave with one unbuilt leaf runs inline**, exactly as the serial loop above — no worktree, no
   workspace; a session for a single phase buys nothing and costs a round trip and a context re-read.
2. **`check_todo.py --slice <n,n>`** over the wave's unbuilt leaves — the same preflight, with the
   same three refusals, and a missing checker is still a **stop**. Nothing else verifies the slice.
3. **`cmux-fanout.sh preflight`.** It checks four things: cmux is reachable, this is the primary
   tree, the tree is clean, and **the repo has been trusted in Claude Code**. Workspace trust is per
   *path*, and a worktree is a new path — a session started in one opens on the trust dialog and
   never reads its prompt. `spawn` copies the repo's own trust decision onto each worktree it makes,
   which is why the repo must carry one: a fan-out may inherit a judgement the user already made,
   never invent one.

   A non-zero exit is a **stop**, deliberately: elsewhere a missing tool is a named skip, but
   `--cmux` was typed on purpose, and quietly running serially instead would hand back something
   other than what was asked for. Say what was missing and offer the serial run as the user's
   choice, not yours.
4. **One `spawn` per leaf**, up to three live at once:

   ```sh
   FAN="${CLAUDE_PLUGIN_ROOT}/skills/plan-run/scripts/cmux-fanout.sh"
   "$FAN" spawn --id "phase-<n>" --dir "../<repo>-p<n>" --base "<base>" \
          --marker-file "<plan>" --marker-prefix 'built: ' \
          --prompt "/r:plan-run <plan> --phases <n> --no-merge --yes [--ask <session>]"
   ```

   The `--marker-*` pair lets `wait` check the branch itself rather than trusting the session's own
   account. `[--ask <session>]` is there only when this run was given one, and it is passed through
   **verbatim to every unit** ([`--ask <session>`](#--ask-session--reporting-a-defect-in-the-pack)).
5. **`wait`**, then `cleanup` each unit **the moment it comes back ok** — its workspace closes and
   its worktree is removed on the spot: a stale worktree is what the next `spawn` collides with, a
   finished workspace looks like a working one in the sidebar, and the freed slot admits the next
   queued leaf. A wave wider than three is therefore a **rolling window**, not batches waiting on
   the slowest.
6. **A unit that failed or stalled is left standing** — workspace open, worktree in place, both named
   in the report. A stall is usually a question waiting for a human, and that state is the only
   evidence of what went wrong.
7. **Land the whole wave in ascending phase order** with the `--land` logic below, once every leaf is
   in. Order comes from the plan, never from which unit finished first.

A leaf that fails, or lands a branch carrying no `<!-- built: … -->` marker, is a **halt** with the
usual semantics: the branch stays unmerged, nothing is ticked past it, and the report names the wave
and the `--from N` that resumes — later waves depend on this one by construction.

**Three at a time by default, and the cap lives in the config** — `steps.fanout.maxUnits`, resolved
by the script itself, so there is one place to change it for both skills that drive it. Three full
implement+review pipelines is already the machine's limit — `implement` alone measures 20.9M tokens
and 1022s per agent — so raise it as a measurement rather than a guess. A project sets its own
width in `.config/skill-pack.yaml`; the script names anything it had to substitute and never runs
uncapped. A wave that spawned eight would thrash rather than finish sooner.

### The alarm channel

Get your own session name from `ListAgents` — its first line names this session — and pass it to
every `spawn` as `--orchestrator <name>`. Each unit then arrives holding
`CMUX_FANOUT_ORCHESTRATOR`, and can `SendMessage` **up** to you. Only that direction is wired,
because only it needs no discovery: a unit knows who spawned it, while finding a unit from here
means prefix-matching an unpredictable session name against every session on the machine.

**What a unit is told to send** — the four cases under [Being a unit](#being-a-unit): an undeclared
file, a question the plan can answer, a failing test it did not write, a halt. Each is something to
know *before* the timeout.

**Hold the union of what they report, because you are the only one who can.** A unit sees its own
worktree; you see the wave. Keep the set of files the units have claimed, and the phase that claimed
each — the wave's real footprint, accumulating while it is still cheap to act on.

**What you may do with it.** Answer a question. Ask a read-only check — what branch it is on, whether
it has touched a file. Three rules:

- **A message never closes a unit.** `wait` blocks on the sentinel; landing needs the marker. A unit
  saying it is done is a *claim*, and this pipeline lands *evidence* — a session can go idle having
  declined its work, and completion-by-message would bank exactly that as a success.
- **Ask, never drive.** A message that changes what a unit builds makes its run something other than
  the `--no-merge` loop everything downstream assumes it ran.
- **Don't poll.** That is what `wait` is for, and every message costs the receiving session a whole
  turn.

**An undeclared file is recorded; a *claimed* one is a halt.** These arrive as the same message and
need opposite answers. A phase reaching a file its `Files:` line does not name is the normal case,
so the answer is "recorded, continue" — refusing it would refuse correct work. The same file
arriving from a **second** unit is the collision the preflight exists to prevent: stop spawning,
let the units in flight finish or stop them, and fix the plan's edges before re-running.

**You can reach a unit, for two things only.** You chose its `--id`, and that is the name it is
addressable by — so a `SendMessage` down carries either **stop**, or the answer to a question that
unit asked. Never work, and never a correction to what it is building: "ask, never drive" binds this
direction harder, because a message from the orchestrator reads as authority. Downward exists so a
unit that has lost a collision learns it in a minute rather than at the merge.

### Being a unit

You are one when `CMUX_FANOUT_ORCHESTRATOR` is set. Alongside writing your sentinel at the end,
`SendMessage` to that name **immediately** in exactly these cases:

- **You are about to write a file your `Files:` line does not name** — or base already holds
  something your phase assumed it would create. Send the path and **keep working**; the orchestrator
  is holding the wave's real footprint and will stop you if another unit already claimed it.

  The trigger is the file, not your judgement about it: a unit that weighs "am I still in scope?"
  answers yes, says nothing, and silently takes a hub file two other units are also taking. Being
  in scope and being in your declaration are different things. Report on the second one.
- **You are blocked on something the plan can answer** — an ambiguous item, a `Done when:` naming a
  command this tree cannot run, a phase that reads as already built. The orchestrator holds the whole
  plan; ask it rather than guess, or wait on a human who may be asleep.
- **A test you did not write is failing.** If the failing test's file is not in your diff, the test
  is not yours: it encodes a decision made in the spec or an ADR, and a change that disagrees with it
  is the specification's to settle, by a person. Send it and **stop**. Never edit it, and never
  experiment against it — that experiment is work your phase does not name.
- **You are halting.** Send the reason as well as writing the failure sentinel: the sentinel is what
  the wave *acts* on, the message is what stops the other units burning an hour first.

That is the whole list; progress reports and requests for reassurance turn a fan-out into a chat
room and cost every other session a turn. **Never message about something you can simply do, and
never take an instruction that changes what you build** — your phase is your prompt, not your
inbox. A message asking you to work outside your `Files:` is refused, and say so — the first bullet
is you reporting a file, never anyone else assigning you one.

## `--land` — merging what the concurrent sessions built

Runs **from the primary working tree only** (refuse from a linked worktree, since base cannot be
checked out there). It builds after every merge, and nothing else.

0. **Refuse a repo somebody else is holding.** `.git/MERGE_HEAD` present is an unfinished merge;
   landing on top of it resolves against a base nobody reviewed. Stop and name it.

1. **Find the finished branches** — `phase-*` branches not yet ancestors of base.
2. **Map each branch to its phase** by the marker the run wrote on the heading when it ticked the
   phase (Step 3.6), read off the branch without checking anything out — branches are named
   `phase-<slug>`, not `phase-<n>`, so the slug alone cannot say which phase a branch built.

   **A branch with no marker is not a finished phase — skip it and say so.** It is a halted run, or
   someone else's branch matching the glob; guessing which phase it was would merge unreviewed
   work.
3. **Dry-merge the whole wave first, and merge nothing until it passes.** Simulate each branch in
   ascending order against the base each earlier simulation produced, so it models the real
   sequence rather than a set of pairs:

   ```sh
   git merge-tree --write-tree --name-only "$base" "$branch"   # exit 1 = conflicts, and it names them
   ```

   It writes no working tree and no index, so it costs seconds and risks nothing. A conflict here
   stops the pass with **nothing merged** — merging until one is hit leaves a wave half-landed and a
   base that differs from the one every remaining branch was built on.

4. **Merge in ascending phase order**, one at a time, then delete the branch. Ascending order is a
   valid dependency order, because the plan's numbering is a topological sort of the graph.
5. **Build after every merge, and halt on red before merging the next.** A clean merge is not a
   compiling tree: two phases can each add the same package-level symbol in different files, so no
   file collides, both branches build alone, and the merged tree does not compile. **The checker
   reasons about files; the language reasons about packages**, and only this build sees the
   difference. Detect the runner the way Step 3 does and run it; on red, stop with that branch
   named.
6. **On a conflict, stop and surface it — never force it.** Report which branch, leave it in place
   and unmerged, and name the ones already landed. The merge is idempotent (step 1 skips anything
   already an ancestor), so re-running after a manual resolution is safe. With `--auto-resolve`, the
   conflicts that are provably additive are resolved first and only the rest reach this step — see
   [Auto-resolving the additive
   conflicts](#--auto-resolve--resolving-the-conflicts-that-are-provably-additive).

Then **record the run** — Step 4's stats line with `mode: "land"`, `landed` set to what merged, and
`phasesInRun: 0`, since a landing pass builds nothing. A conflict that stopped it is
`haltReason: "merge-conflict"` with the phase in `haltedAt`.

**About the plan file.** Every phase ticks it, so it is the one file every branch touches — which is
why the wave collision check excludes it. Git merges ticks in separate regions cleanly; when two
phases sit adjacent enough to conflict, the resolution is always **both sides' ticks**, since each
branch ticked what it genuinely built.

## `--auto-resolve` — resolving the conflicts that are provably additive

A wave's conflicts are mostly two phases adding wiring at the same point, and "keep both" is the
answer to nearly all of them — but a side that quietly dropped a line reads exactly like a side that
never had it, and the resolution that drops it **compiles clean** and fails only in the tests. So
the decision is a script rather than a judgement:

```sh
python3 "${CLAUDE_PLUGIN_ROOT}/skills/plan-run/scripts/merge-resolve.py" --plan <plan> [--dry-run]
```

Run it while `git merge` has left the tree conflicted. Each conflict is re-materialised with its
merge **base** visible and asked one question: *does every base line still exist on both sides,
ignoring whitespace?* Yes means neither side removed anything, so both sides are kept. No means a
side rewrote shared code, and that file is left unmerged with the base still showing, for you.
The base is the whole trick — without it "they added a field" and "they deleted a field" are the
same picture — and whitespace matters as much: a formatter realigns a block when a longer name
arrives, so a strict comparison reads a pure addition as a rewrite.

**Then verify, and treat the verification as part of the resolution.** Format, run the build, run the
**full** test suite. Green: commit the merge. Red: `git merge --abort` and hand the whole thing over
— never patch up an auto-resolved merge, because the failure is the evidence that the rule was wrong
here. The residual risk the rule cannot see is ordering: two sides adding statements at one point
produce a union in some order, and only for declarations is that order certainly irrelevant. The
test run covers that, which is why it is not optional and why this flag is off by default.

**Report both halves, always** — every file resolved and every file handed over, by name. Silent
auto-resolution is indistinguishable from a merge nobody had to think about.

Turn on `rerere` as well (`git config rerere.enabled true`): the conflicts this refuses are in the
hub files every wave touches, so a resolution made once replays in the next wave.

## Running unattended

`--unattended` is for a run nobody is watching: a twelve-phase plan started before dinner, or a
`--cmux` wave that will take hours. It changes one thing only — **what counts as a reason to stop**
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
| `--slice` refused the slice | no | build that wave **serially** |
| `footprint-warn` returned 2 under `--cmux` | no | build that wave **serially** |

The last two are the ones that pay for the flag: both are facts about *scheduling* with an obvious
local response, and stopping a four-hour run over one is the pipeline refusing to do what a person
would have done in a second.

### Answer nothing, queue everything

A question is not a halt. Where an attended run stops for input, an unattended one **collects the
question, builds everything that does not depend on the answer, and reports the queue at the end**:

- **`## Resolve first` blockers** (Step 1) — drop the phases they block out of the run list, build
  the rest, and name them.
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
completing, a wave landing, a conflict auto-resolved or a degrade to serial. Those are the report.

### Every workaround is named

The report carries a line per degrade — "wave 13 ran serially: footprint-warn flagged
`internal/ui`", "Phase 9's review was blocked and passed on retry", "base was dirty at Phase 4;
snapshotted to `refs/wip/pre-phase-4`" — and the stats line carries `degraded` (how many) and
`questionsQueued`. A degrade nobody hears about is indistinguishable from nothing having gone
wrong.

**Unattended never softens these**: a blocked review is not a pass, an auto-resolved merge still runs
the full test suite and is discarded on red, and a halted phase is never ticked and never merged.

## `--ask <session>` — reporting a defect in the pack

`--ask <session>` means a pack maintainer session is watching the **tooling** at that address:
report defects in the pack there and keep working. It works with or without `--cmux` — a serial run
hits pack defects too — and it changes nothing else about the run.

**What belongs there is a defect in the TOOLING, never in the project being built.** Three
addresses, three different things, and mixing them is what makes each of them useless:

- a bug in the code this plan is producing → the plan, or the project's own backlog;
- a question about the *work* — a contradictory `Done when:`, a phase that reads as already built →
  the **orchestrator** ([The alarm channel](#the-alarm-channel));
- a step of the *pipeline* that is wrong → **here**. A step that cannot run, a bundled script
  returning a confident wrong answer, a handoff field a caller cannot read, an instruction in a
  skill that contradicts what the tool actually does.

Five rules, and the first is what makes this safe to switch on:

- **A report is never a halt, and never a question.** Send it and carry on with the same run you
  would have had. Never wait for a reply, never poll for one, and never let a maintainer's answer
  change what this run does — a pack fixed mid-run does not retroactively change the run that
  reported it. If the defect genuinely stops the work, that is a halt on its own terms and the halt
  rules above apply unchanged; the report is extra, not instead.
- **Never work around a pack defect silently.** Working around it is usually right — report it *and*
  keep going — but the workaround goes in this run's own report to the user as well, in the words of
  what was done instead ([Every workaround is named](#every-workaround-is-named)). A workaround
  nobody hears about is how a defect survives twenty runs.
- **Send evidence, not a conclusion.** The exact error string, the run id, `file:line`, what you
  already ruled out, and what you did instead. The maintainer verifies every claim against the pack
  before changing anything, so a report that hands over a verdict with nothing under it costs more
  to check than the defect costs to find — and a confident wrong diagnosis is worse than a raw
  observation. Say plainly which parts you observed and which you inferred.
- **An expectation the pack contradicts is a report too.** Some of what looks broken is designed — a
  field empty because a tier does not fill it, a step that runs only at one profile. Report it in the
  same shape and let the maintainer say which it is: "this looked like a malfunction and was not" is
  a real finding about the tooling's legibility, and it is cheap to answer.
- **The maintainer does not touch this repo.** It fixes the pack, in the pack's repo, and replies.
  Nothing it does lands in this working tree, so nothing about `--ask` can change this run's diff.

**Under `--cmux`, pass `--ask <session>` through to every unit's own command line**, exactly as the
spawn prompt already carries `--phases` and `--no-merge`. The unit is the first thing that touches
the pipeline, so it is where a pack defect is seen first, and a report relayed through the
orchestrator loses the detail that made it actionable.

`cmux-fanout.sh` needs no change and no new environment variable: the address rides in the child's
own command line, which is also why it works on serial runs. `CMUX_FANOUT_ORCHESTRATOR` stays what
it is — a different address for a different kind of message.


## Step 4 — Report

Close with a summary of the whole run. Include each phase's **review tier** — the `profile` the
review Workflow returned, the depth its diff actually got; both Workflows log their tier only to
the `/workflows` view, so it reaches the user nowhere else.

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

Name every phase built, which branch merged into base, every phase the re-check found already done,
the phase that halted and why, and the phases never reached. **Say plainly what was written back
and what wasn't** — a phase merged with no tick is one the next run will offer again.

**An unattended run adds two sections** — the user was not there, so the report is the only place
any of it exists:

```
Worked around:
  Phase 4  base was dirty — snapshotted to refs/wip/pre-phase-4, then cleaned
  Phase 6  merge conflict in 3 files — 6 of 7 hunks resolved as additive, build + tests green
  wave 13  footprint-warn flagged internal/ui across 5 leaves — built serially instead of fanned out

Needs you:
  Phase 8  "the retry window" is not defined anywhere in the plan or the spec — built to 24h, say if wrong
  Resolve first: "sign the payments contract" blocks Phase 11, which was dropped from the run list
```

Print both sections even when empty — "Worked around: nothing" is information, and its absence
reads the same as not looking.

Then record one line into the pack-wide store — counts only, never phase titles or plan paths.
**Every run records, including a halt, a `--dry-run` and a `--land`:**

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:plan-run","mode":"serial","phasesInPlan":0,"phasesInRun":0,"merged":0,"landed":0,
 "alreadyDone":0,"doneCheckRan":0,"doneCheckFailed":0,"haltedAt":null,"haltReason":null,
 "unattended":false,"degraded":0,"questionsQueued":0}
STATS_JSON
```

**`mode` is what makes every other number readable**, and it is `serial` | `cmux` | `no-merge` |
`land` | `dry-run`. Without it a `--no-merge` session's `merged: 0` — it is *supposed* not to merge
— is indistinguishable from a run whose merge failed; absence of an action is not a failed action,
and only the row itself can say which this was.

**What every remaining field is for** — which counts a `no-merge`, `land` or `dry-run` row leaves at
zero, why the concurrent flow only reads across rows, `haltReason`'s closed vocabulary and
`doneCheckFailed` — is in [references/stats-fields.md](references/stats-fields.md). Read it while
filling the line in: a field written without knowing its question gets a plausible number instead
of a true one.

The script always exits `0` — a lost row is never a failed run, and it must never change what was
merged, landed or ticked. Never retry it.

## Non-negotiables

- **The plan's order is the run's order.** Within a session, phases run one at a time, in numeric
  order, never reordered and never folded together. Grouping two phases into one change — the thing
  `/r:issues-fix` exists to do — is here a commit you cannot revert by halves against premises you
  never checked.
- **Concurrency is across sessions, never inside one, and only where the graph allows it.** Two
  leaves may be built at the same time when the plan says they share no dependency and no file —
  each in its own detached worktree, with `--no-merge`, verified by the checker's `--slice` preflight
  first. Two runs sharing a working tree or a base ref destroy each other, so the preflight enforces
  the separation: a slice run in one directory is a **stop**, and one the graph refuses is a stop
  too — or, under `--unattended`, that wave built serially. `--cmux` drives that same protocol and
  nothing else — the sessions it spawns are real separate sessions, and the orchestrator builds no
  phase of its own while a wave is in flight.
- **A failed phase halts the whole run.** Restore a clean base, leave the failed branch unmerged,
  never tick it, and report the `--from N` that resumes. Building Phase 5 on a Phase 4 that failed
  its build, its review or its `Done when:` is the single worst outcome this skill can produce,
  because everything after the break still compiles. `--unattended` does not touch this: what it
  works around is a dirty tree, a conflict it can prove additive and a fan-out the preflight refused
  — none of which is a phase failing.
- **Derive nothing the plan already states.** `Files:`, `Risk:` and `Done when:` are the plan
  author's, and there is no verification fan-out here to second-guess them. The one write-back is a
  measurement, not a second guess: a committed phase replaces its own `Files:` line with the diff it
  produced. The one thing checked per phase is whether the code has moved underneath the plan — one
  read-only agent, immediately before that phase runs, never a sweep at the start.
- **Both halves are Workflows, run from your main thread.** `task-run-implement.workflow.js`, then
  `task-review.workflow.js`. Each isolates its own fan-out and returns a summary, so neither floods
  your context and neither can silently degrade. Never hand either to a subagent — a subagent cannot
  spawn (Step 3), so neither half can reach what it dispatches, and both still return something
  that looks like success.
- **The review runs as the Workflow — verify it, never accept a silent prose fallback.** Confirm the
  `wf_…` Run ID. If the `Workflow` tool isn't available, `/r:plan-run` is not in a real main thread
  — **halt and tell the user** to re-run from a top-level session.
- **A returned Workflow is not a passed review.** `endVerify: "blocked"`, a non-empty
  `tracksBlocked`, or a red `build`/`localScan` each mean part of the diff had no reader. Do not
  merge on any of them.
- **Run the phase's `Done when:`, or name the skip.** It is the only check that asks whether the
  phase delivered what it was for rather than whether the diff is sound. Prose with no runnable
  command is recorded as *done-check skipped*, never as a pass.
- **Hand the implement Workflow a reference, never a body.** `"<plan> / Phase <n>"` — it re-reads
  the plan for the checklist and the intent; a phase body pasted as free text arrives with no
  criteria at all.
- **Force the tier only where the plan does.** `profile: "full"` when the phase carries a `Risk:`
  line; omit `profile` entirely when it doesn't. A missing `Risk:` line means the planner made no
  claim, not that the phase is low risk.
- **`## Resolve first` is never buildable.** Unticked entries there block the phases they name and
  need a person. List them and stop; never number one, never hand one to the implement Workflow.
- **Tick only what was built and verified, after the review and before the commit.** A partial phase
  leaves partial ticks — an honest record, not a defect. A phase ticked before its review, or after
  its commit, is one whose "built" and "done" no longer revert together.
- **Clean base between phases.** Every phase starts from a clean checkout of the recorded base; never
  sweep an unrelated dirty tree into a phase's commit. If the merge conflicts, surface it and halt —
  never force it.
- **Honor the approval gate unless `--yes`.** `--dry-run` never mutates anything; `--yes` skips the
  gate but never the halt.
