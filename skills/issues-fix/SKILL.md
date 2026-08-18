---
description: >-
  Orchestrate the whole discover → verify → group → fix loop over a backlog of issues, features or
  bugs in any source — a GitHub tracker read through `gh`, a markdown or text file listing
  them, or a list pasted inline: verify each item is real, still applies and is not already done by
  reading the code, **group the items one change can fix together**, present the shortlist
  for approval, then fix the approved groups **one group at a time** — each implemented by the
  `run-task-implement` Workflow, then reviewed by the `/r:task-review` Workflow, merged into the
  base branch, and marked done where it came from (the GitHub issue closed, the markdown checkbox
  ticked). Use whenever the user says "/r:issues-fix", "go through the issues and fix them",
  "triage and fix the open issues", "work through the bug backlog", "fix everything in issues.md",
  "clear out the bug tracker", "check the issues and fix what's broken", or hands over a list of
  issues, features or bugs — a tracker, a file or a paste — and wants them verified and fixed, not
  just one known bug. NOT for: a single specific bug you already understand (hand that straight to
  `/r:task-run`), writing a plan only (`/r:spec-plan`), or reviewing an existing diff
  (`/r:task-review`).
effort: xhigh
disable-model-invocation: true
---

# issues-fix

Take a backlog — a GitHub tracker, a markdown file of issues, features and bugs, or a list pasted into the prompt — and drive the full fixing loop: **discover** what is open, **verify** each item is real work worth the effort by reading the code, **group** the ones a single change would fix, and **fix** them one group at a time. This skill is the orchestrator — it discovers, triages, and clusters items, then for each approved group it runs two Workflows back to back from the main thread: the **`run-task-implement` Workflow** (planning, Codex plan review, test-first implementation, green build) and then the **`/r:task-review` Workflow**, followed by the merge and marking every item in the group done at its source. Everything stays in the main thread on purpose: `Workflow` has always lived only there, and since Claude Code 2.1.217 so does `Agent` — so work buried in a subagent can neither run the deterministic review nor fan out at all. A Workflow keeps its whole fan-out out of your context and returns a summary, so hosting both here stays cheap. Your job is the *loop and the gate* — not the fix itself.

Everything uses a **real tool** — the source's own (`gh` for a GitHub tracker, a real read and a real write for a file), real read-only subagents for verification, the real `/r:task-run` for each fix. Never imitate a triage or a fix with a prose summary. If a required tool can't run, stop and tell the user — see [Non-negotiables](#non-negotiables).

Five things shape the whole design:
- **The source is an adapter, not the pipeline.** Only four things differ between a GitHub tracker, a file and an inline list: how items are discovered, how they are fetched, what identifies one, and how one is marked done. Everything else — verification, clustering, the gate, both Workflows, the merge — reads an item's *text*, its `touches` and its `risk`, none of which know where it came from. Keep new source handling inside those four seams and out of the loop; the contract is [references/issue-sources.md](references/issue-sources.md).
- **Verification is read-only and parallelizable** — no branch, no writes, so all candidates can be vetted at once.
- **The unit of a fix is a *group*, not an item.** Items that touch the same subsystem/files **and carry comparable risk** are fixed together as one task. What grouping buys is **cost and coherence**: one plan/implement/review pass instead of two, and a single review that sees the whole change at once. It buys **no safety** — groups run serially off a clean base, so two separate branches never actually race. But cost alone is reason enough to fold *same-tier* work, because the review is the slow half of the loop: every group you don't create saves a whole review pass, not just a plan. What cost never justifies is chaining a trivial fix to a risky one — there the cheap half inherits the expensive half's gate and its blast radius (Step 2.5).
- **Fixing must be serial.** Each group owns one feature branch that gets merged into the base. Two fixes on the same repo collide on that base ref (git worktrees share it too). So groups run **one at a time**, each starting from a clean base — never in parallel. This is the single most important constraint in the skill.
- **Each fixed group is two Workflows and a finish, all in *your* main thread.** Both halves — implement (`run-task-implement`) and review (`/r:task-review`) — are deterministic **Workflows**, and the `Workflow` tool exists only in the main thread. Since Claude Code 2.1.217 the `Agent` tool does too, so a subagent can neither run a Workflow nor spawn the fan-out that each half depends on. Keeping both here costs you almost nothing: a Workflow holds its entire fan-out in its own agents and hands back a summary, so your context stays a clean per-group ledger across the whole backlog.

## Invocation

`/r:issues-fix [<source>] [--label <label>] [--limit <n>] [--group <refs>] [--no-group] [--bugs-only] [--yes] [--dry-run]`

**`<source>`** is where the backlog is written down, detected in this order. Strip a leading `@` and
any trailing `/` from path arguments (Claude Code's `@backlog.md` arrives verbatim).

- **A path to an existing file** (`issues.md`, `docs/bugs.md`) → the **file** source. Read it, take
  every item that isn't already done. This is the shape a hand-kept list of issues, features and
  bugs arrives in, and the only one that can be **written back to without a network**.
- **Issue numbers or URLs** (`#42 57 https://github.com/o/r/issues/9`) → the **GitHub** source, using
  exactly those refs and skipping discovery. They still go through verification, clustering and the
  gate.
- **No argument** → GitHub discovery (open issues labeled `bug`) when the repo has a GitHub remote
  and `gh` is authenticated; otherwise the first list file found at the repo root — `issues.md`,
  `bugs.md`, `todo.md`, `backlog.md` — **named to the user before it is used**. Neither available, or
  two candidates with nothing to choose between them: **ask**. This is the one place the run stops
  for input.
- **Multi-line text that reads as a list** → the **inline** source: each line is an item. Deliberately
  the degraded shape — there is nothing to write back to, so a fixed item cannot be recorded as done
  and the next run will offer it again. Say so in the report.

Parsing rules, the per-source identity, and the write-back mechanics live in
[references/issue-sources.md](references/issue-sources.md) — read it before touching Step 1 or
Step 4.4.

- **`--label <x>`** → override the `bug` label used for GitHub discovery (e.g. `--label defect`).
  Ignored by the other sources, which have no labels.
- **`--limit <n>`** → cap how many candidates discovery pulls in (default a sane 20).
- **`--group <refs>`** → force a manual cluster, comma-separated: issue numbers for a tracker
  (`--group 42,61`), item locators for a file (`--group "Login 500s,Signup rejects"`). Repeatable for
  several forced groups. These items are fixed together regardless of what the auto-clustering would
  have decided; everything else still clusters normally. Use it when you already know two reports are
  one fix.
- **`--no-group`** → disable clustering entirely; every item is its own fix. The escape hatch for
  when you want a separate branch/commit per item.
- **`--bugs-only`** → accept only still-reproducing bugs, skipping features and chores. Verification
  is otherwise glad to take any real, actionable, not-yet-done item (Step 2), which is what a
  hand-written list needs and a `bug`-labeled tracker query mostly gives you anyway.
- **`--yes`** → skip the approval gate; verify, cluster, then fix every group that contains real work.
- **`--dry-run`** → run discovery + verification + clustering + triage and print the plan (groups
  included), then **stop** — never touch git, the tracker, or the list file. This is the safe way to
  preview what a real run would do.

**For a backlog you don't want to babysit, run it in two passes: `--dry-run` first, then re-run with `--yes`.** On a real backlog the longest single stretch of wasted wall-clock is usually the approval gate sitting untouched while the user is away — every group after it waits on a human who has already stopped watching. The dry run puts the whole shortlist in front of them while nothing is at stake, and `--yes` then runs the rest unattended. Verification is cheap and read-only, so paying for it twice costs little; a `--yes` run whose groups the user has already read is a very different thing from a `--yes` run nobody looked at, and this is how you get the first one.

## Step 0 — Preconditions & base branch

- **Resolve the source first** (the order above), because it decides which tools this run needs.
- **The source's own tool has to work.** For a GitHub backlog, confirm the CLI is authenticated:
  `command -v gh >/dev/null && gh auth status`. If `gh` is missing or unauthenticated, **stop and
  tell the user** — don't scrape the web UI. For a file backlog, confirm the file exists and is
  readable. A missing tool is a stop, never a quieter substitute.
- **`gh` is still a hard gate for the whole loop when any item is a GitHub issue**, because
  `/r:task-run` resolves those refs through `gh` too. A file or inline backlog needs none of it, so
  don't gate a markdown run on a tool it never calls.
- **The current repo is the tracker.** `gh` resolves issues against the current repo's GitHub remote
  — there's no repo override. So run this from inside the checkout whose issues you want to fix. A
  file source has no such tie: the list may live anywhere, and only the *fixes* land in this repo.
- **Record the base branch.** Note the current branch (usually `main`) — every fix branches off it and merges back into it. Fixes must always start from this same clean base.
- **Require a clean working tree** (`git status --porcelain` empty). A dirty tree is dangerous here: `/r:task-run` leaves work uncommitted until a single final commit, so pre-existing changes would get swept into a fix's commit and into its reviewed diff. If the tree is dirty, stop and ask the user to stash or commit first. This covers the list file too when it is tracked here — an already-edited backlog file is exactly the kind of change that must not ride along in a fix's commit.

## Step 1 — Discover & fetch candidates

Per the resolved source:

- **GitHub, default / `--label`:** `gh issue list --state open --label <label> --limit <n> --json number,title,url,labels,body,comments`.
- **GitHub, explicit refs:** skip the list; `gh issue view <n> --json number,title,url,labels,body,comments` for each ref passed.
- **File:** read it once and take every item not already marked done — a ticked box, struck-through
  text, this skill's own resolution marker, or anything under a `Done`/`Completed`/`Fixed` heading.
  Which lines are items and which count as done is [references/issue-sources.md](references/issue-sources.md); when a line is genuinely
  ambiguous, treat it as open and let verification decide — a spare verifier is cheap, a silently
  skipped item never gets fixed.
- **Inline:** each line of the pasted list is an item.

Normalise whatever you got into one record per candidate — `{ id, title, body, labels, comments }`,
where `id` is `#42` for an issue and the `<file>:<line>` plus the item's **verbatim text** for a
file. Keep that text: it is what re-locates the line at write-back, since a line number stops being
true the moment the file is edited.

If the candidate set is empty, report that (e.g. "no open issues labeled `bug`", "every item in
`issues.md` is already ticked") and stop — there's nothing to do.

Keep the fetched title/body/labels/comments; you'll hand them to the verifiers so they don't each re-fetch.

## Step 2 — Verify (parallel, read-only)

Using the Agent tool, spawn **one read-only verification subagent per candidate**, all at once — this is safe to parallelize because verification touches no branch and writes nothing. Use `Explore` (pure code-reading) by default, or `r:bug-hunter` when the item needs runtime reproduction to confirm. Brief each verifier with the item's id, title, body, labels, and relevant comments, and ask it to explore the codebase and decide whether this is worth an expensive fix.

Each verifier must judge, from the code and the item:
- **Is it real, actionable work** — not a question, a docs-only ask, or unactionable noise? A
  **feature or a chore counts**: a hand-kept list is mostly things that were never built, and a
  tracker query pointed at `enhancement` is a legitimate way to run this loop. What disqualifies an
  item is that nobody could implement it from what it says, not that it adds rather than repairs.
  With **`--bugs-only`**, narrow this back to defects and skip features and chores as `category`
  says.
- **Does it still apply** in the current code — does the bug still reproduce, or is the feature
  already built? An item the code has overtaken is `skip: stale`, and on a hand-kept list that is the
  single most common skip, because a file has nobody closing it when the work lands some other way.
- **Is it a duplicate?** If it duplicates an item that's already resolved or tracked *outside this run*, `skip` it. But if it duplicates **another candidate in this run**, keep it as `fix` — don't skip it. Clustering (Step 2.5) will merge the two so both get fixed by one change and **both get marked done**; skipping it would leave the duplicate open forever, which is the gap grouping closes.
- **Where would the fix land** — the file(s)/module/subsystem a fix would touch. This is the **first grouping signal** Step 2.5 clusters on, so name it concretely (a path or a class), not "the backend".
- **How deep does the fix cut** — the **second grouping signal**, and the one only you can judge, having just read the code. Rate it `cosmetic` | `local` | `deep`:
  - **`cosmetic`** — presentational and behavior-preserving: CSS/utility classes, copy, markup, a label or an icon.
  - **`deep`** — the fix plausibly reaches schema/migrations, core domain semantics, concurrency/locking, auth, or money.
  - **`local`** — an ordinary code change between the two: a wrong branch, a missing guard, a bad argument, a mapping fix.

  When torn between two tiers, pick the higher one — over-rating costs at most a group of one, under-rating chains a risky change onto a trivial one. A feature is rated the same way as a bug and by the same question — what the change *touches* — not by how large it sounds.
- **Is there enough information** to actually implement it?

Have each return a **compact structured verdict** so your context stays clean (a summary, not a transcript):

```
{ id, title, verdict: "fix" | "skip",
  category: "bug" | "feature" | "chore"        // fixable
          | "question" | "docs" | "duplicate" | "stale" | "not-enough-info",  // skipped
  confidence: "high" | "medium" | "low",
  root_cause_or_scope: "<1–2 lines: where it breaks / what building it means>",
  touches: ["<file/module/subsystem the fix would land in>", …],  // grouping signal 1 for Step 2.5
  risk: "cosmetic" | "local" | "deep",                            // grouping signal 2 for Step 2.5
  skip_reason: "<why, if verdict = skip>" }
```

`category` is what `--bugs-only` filters on, so it has to be recorded honestly even when the verdict
is `fix` — a run that labels every accepted item `bug` makes that flag do nothing.

Verifiers are **strictly read-only** — they diagnose, they never edit code, touch git, or mark anything done in the list file. The point of this step is to spend an `xhigh` `/r:task-run` only on items that are real and still worth doing.

## Step 2.5 — Cluster into fix groups

Fold the `fix` verdicts into **groups that one change can fix together**, working from the `touches` and `risk` each verifier reported. This is a small reasoning pass over the compact verdicts — do it inline in your own context; it's a handful of short records, not a job for a subagent.

**The grouping rule — same subsystem/files *and* comparable risk.** Both tests must pass; file overlap alone is necessary but **not sufficient**.

1. **Overlap** — their `touches` name the same file, the same class/module, or the same tight subsystem. How tight this has to be depends on the tier (below).
2. **Comparable risk** — their `risk` tiers are equal or adjacent (`cosmetic`+`local`, `local`+`deep`). **Never group `cosmetic` with `deep`**, however much the files overlap. This is a risk test, not a kind test: a feature and a bug of the same tier in the same place are one change, and two bugs of different tiers are not.

Duplicates and two-symptoms-of-one-bug pass both tests trivially. Two *distinct* items in the same file group only when their tiers are also comparable — a template that hosts both a CSS clipping fix and a domain-plus-migration fix is one file, not one change.

**How hard to fold depends on the tier, because the tier sets the price of being wrong.**
- **`cosmetic` and `local` — fold generously.** Same layer and same feature area is enough; the `touches` needn't name the same file. A pile of small `local` fixes across one controller-and-its-templates is one change, and treating it as five is five plans, five implements, five reviews and five builds for work a single reviewer could read in one sitting. If the fold turns out wrong, the cost is one slightly wider commit.
- **`deep` — fold only on real overlap**, exactly as strictly as the rule above reads. Two `deep` fixes in genuinely different places stay apart even when both are `deep`: one commit that carries two schema changes is a commit you cannot revert by halves.

The risk dimension carries as much weight as the file one because **a group's blast radius is its riskiest member, not its average**. Chain a one-line CSS fix to a migration-and-locking fix and three things go wrong at once: the cheap fix inherits the expensive one's gate (ready in minutes, merged hours later, after review rounds it didn't cause), the review's attention is monopolised by the risky half so the cheap half's own findings go unresolved, and they land as **one commit** — so reverting the migration reverts the CSS fix too. What you bought for all that is one saved plan/review pass on a change that would have classified `light` and been cheap on its own.

**A group of one is not free.** It buys its own plan, its own implement pass, its own full review, its own clean build and its own merge — and the review is the slow half. So "when in doubt, keep them apart" is the right instinct at `deep` and the wrong one for a backlog of `local` fixes in one area. When the tiers match and the area matches, **fold**; when the tiers differ, **don't**, whatever the files say.

**Honor the flags.** `--group 42,61` forces exactly those items into one group regardless of what `touches` and `risk` say; keep any such forced group intact and cluster everything else normally. `--no-group` skips this step entirely — every `fix` item becomes its own group of one.

Emit the groups as a compact structure you carry into the gate and the fix loop:

```
{ group_id, items: [<ids>], subsystem: "<the shared file/module>",
  risk: "cosmetic" | "local" | "deep",   // the highest tier among its members — that's the group's blast radius
  rationale: "<why one change fixes them all>", confidence: "high" | "medium" | "low" }
```

A group of one is fine when nothing genuinely belongs with it. But on a backlog holding several same-tier items in one area, a clustering pass that returns only singletons is one that will pay for a full review over and over — reread those before moving on. Grouping never crosses the serial rule: groups are still fixed one at a time (Step 4).

## Step 3 — Triage & approval gate

Collect the outcome into a table for the user — **the `fix` verdicts grouped**, the skips listed below. Name the source in the heading (`issues.md`, `owner/repo`), because which backlog this run is about is the one thing the table cannot show and the user cannot undo afterwards:

```
Backlog: issues.md (11 items)

Group  Items                     Subsystem / shared fix                     Kind      Risk      Conf
G1     Login 500s… / Signup…     AuthController — same unescaped-param bug  bug       local     high
G2     Refund total is negative  RefundService.total() — sign error         bug       deep      medium
G3     Export CSV as UTF-8       ExportService + its template               feature   local     high

Skipped (verification):
How do I configure X?      question, nothing to implement
Add dark mode              already shipped in SettingsPanel
```

The `Items` column carries whatever identifies an item in this source — `#42 #90` for a tracker, the
item's own opening words for a file. The `Kind` column is the `category`, and it is worth a column of
its own the moment features are in scope: "fix all eleven" reads very differently when three of them
are things that do not exist yet.

- **`--dry-run`** → print the table (groups and skips) and **stop**. Nothing is fixed; no branch, no commit, and not a character of the list file.
- **Otherwise** → present the **grouped "will fix" shortlist** and **pause for approval**, unless `--yes` was passed. At the gate the user can **drop** an item or a whole group, **split** a group they think bundles unrelated work, or **merge** two groups — each fix is heavyweight and it **mutates the repo and marks every item in the group done**, so a false positive is expensive to undo. A group whose members span two risk tiers, a group that mixes confidences, or any low-confidence `fix`, especially deserves a human glance — splitting a mixed group here costs one extra pass; unpicking one commit afterwards costs far more.
- **Say what the gate is worth in both directions.** Two same-tier groups in one area are worth offering to merge (it saves a whole review pass), and a mixed-tier group is worth offering to split. State the count plainly — "3 groups, ~3 review passes" — because that number is the run's cost and the user is the only one who can change it here.
- **Tell the user this is the last prompt.** Once the gate clears, Step 4 runs to the end with no further questions: a group that fails is recorded and the loop moves on. Saying so is what makes it safe for them to walk away, which on a long backlog saves more wall-clock than anything inside the loop.
- With **`--yes`**, skip the pause and carry the proposed groups straight into Step 4.

## Step 4 — Fix serially: two Workflows and a finish, all from the main thread

Work the approved shortlist **one group at a time, in sequence — never in parallel** (a group of one is the common case). Each fix runs as **two Workflow calls** — implement, then review — followed by the finish. Everything stays in **your** (main) thread, because the `Workflow` tool exists only there and, since Claude Code 2.1.217, so does the `Agent` tool. A Workflow keeps its whole fan-out out of your context and hands back a summary, which is what lets this loop stay a clean ledger across a long backlog. For each group (write `<src>` below to mean *the source string naming every item in the group*):

1. **Start from a clean base.** `git checkout <base>` and confirm the working tree is clean (`git status --porcelain` empty). If a previous iteration left the tree dirty (e.g. a fix that stopped mid-run), **don't plow ahead** — record that group as failed, restore a clean base, and move on, so one bad fix doesn't contaminate the next.

2. **Implement — the deterministic implement Workflow, no review yet.** `/r:task-run`'s Steps 0–4 have their own canonical script. Call it directly:

   ```
   Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/task-run/task-run-implement.workflow.js",
              args: { packRoot: "${CLAUDE_PLUGIN_ROOT}", source: "<src>", base: "<base>" } })
   ```

   Pass **every item in the group** in the one source string, in the shape its source uses:

   - **GitHub** — the refs, space-separated: `"#42 #90"` for a group, `"#42"` for a singleton. The
     workflow fetches each through `gh` and names the branch `issues-42-90-<slug>` (or
     `issue-42-<slug>` for one).
   - **File** — the path, then the items' locators: `"issues.md / Login 500s on '+' | Signup rejects unicode"`.
     A locator is a short **unique prefix of the item's own text**, never the whole body — the
     workflow re-reads the file and lifts the item and its nested bullets as the acceptance criteria,
     which is exactly what pasting the body in as free text would throw away. Branch:
     `items-<slug>` (or `item-<slug>` for one).
   - **Inline** — the item text itself. This is free text: there are no written criteria to lift, so
     the planner derives them. It is why the inline shape is the weakest of the three.

   The workflow merges the group's acceptance criteria, maps the code, plans it on Fable, has the **real Codex** challenge the plan, implements test-first through domain subagents, and drives the build green — then stops, leaving the uncommitted diff on that branch and returning the handoff:

   ```
   { branch, base, profile: "light" | "standard" | "full", profileReason, profileForced, uiTouched: <bool>,
     taskIntent: "<what the fix set out to do>", criteria: [...],
     planPath, buildGreen: true | "n/a",   // "n/a" = no build tool ran, NOT a pass
     planReview: { ran, passes, raised, applied, dropped } }
   ```

   `planReview` records what Codex raised about the plan and what the triage kept. Carry it into the resolution of **every item in the group** — the close comment on an issue, the report line for a file item. If it dismissed **every** finding, say so there — that's a plan the review left untouched, which is often fine but shouldn't be silent.

   or `{ stopped: <reason>, … }` when it can't honestly continue.

   **Why a Workflow rather than a subagent.** Handing `/r:task-run --stop-after-implement` to a `general-purpose` subagent does not work. Claude Code **2.1.217 removed the `Agent` tool from subagents**, and `/r:task-run` *is* its subagents — the explorers, the Fable planner, the Codex plan reviewer, the domain implementers, the build runner — so nested that way it cannot spawn any of them: the fix collapses into a single-context run and still reports success. The Workflow runs in your main thread and spawns every agent *itself*, so the fan-out survives **and** your context still only sees the handoff. Don't "simplify" this by invoking `/r:task-run` through the Skill tool instead — that works, but it loads a whole run into your context, and by the third group this loop would be compacting mid-run.

   Pass **references**, not bodies — refs for issues, locators for file items. Either way the workflow re-reads the source itself for the acceptance criteria and the intent, and a body pasted in as free text arrives with none. A `stopped` result is **one group's failure** (step 5): record the reason, restore a clean base, and move on. Never re-run the work inline to get past it.

3. **Review in the main thread — the deterministic Workflow, with a self-check.** The implement workflow left the working tree on the group's branch with the uncommitted diff, already in front of you. Now run post-task-review's canonical engine — the **Workflow** — *directly*, passing the handoff through:

   ```
   Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/task-review/task-review.workflow.js",
              args: { packRoot: "${CLAUDE_PLUGIN_ROOT}", deferCommit: true, taskIntent,
                      baselineBuilt: <handoff.buildGreen === true> } })  // + profile, uiTouched only if profileForced
   ```

   **`baselineBuilt` — pass `true` only when the handoff says `buildGreen: true`, never on `"n/a"` or `false`.** The implement half has just run a clean, fully green build on this branch, in this tree; without the flag the review opens by running a second clean build minutes later, from an empty `target/`, over a diff that has changed only by the review's own fix phase. On a multi-module JVM project that duplicate is the most expensive step in the whole loop. The flag makes the review start incremental instead — the green bar is untouched (still a full suite, still never relaxed) and the deleted/renamed escape hatch still forces a clean build when incremental could lie. `"n/a"` means no build ran at all, so passing it there would skip the run's *only* clean build.

   **Pass `profile`/`uiTouched` only when the handoff says `profileForced: true`** (the user forced a tier). Otherwise leave both out: the implement workflow's tier was classified from the *item text*, before any code existed, and post-task-review classifies from the diff it is about to review. A bug that read as risky but landed as four lines then gets reviewed as four lines, and one that read as trivial but grew doesn't slip through on the item's wording.

   Invoke the `Workflow` tool directly rather than `/r:task-review` via the Skill: that is what makes the review *provably* deterministic — the `Workflow` tool either runs the pipeline or it doesn't exist, with no silent prose middle-ground. (`deferCommit` so the review's refactor folds into the single final commit; `taskIntent` so a fixer doesn't undo intentional work. The guard hook allows this canonical `scriptPath`; the `Workflow` keeps its whole fan-out out of your context and returns a summary, so this stays cheap.)

   **Self-check — the review MUST have run as the Workflow, not prose.** A real Workflow run returns a **Run ID (`wf_…`)** and a structured result — **record the `wf_…` id as proof.** If the `Workflow` tool is **unavailable** here (you cannot make that call at all), then you are **not actually in a main thread** — e.g. this whole `/r:issues-fix` has itself been nested inside a subagent — and going through `/r:task-review` would **silently degrade to the prose pipeline**. Do **not** accept that quietly: **STOP this group, warn the user loudly** that the deterministic review isn't available in this context (they should run `/r:issues-fix` from a top-level session), record the group as failed, and restore a clean base. **Never finish (merge/close) a fix whose review couldn't run as the Workflow** — that silent fallback is exactly the regression this check exists to catch.

   Let the Workflow run to completion. If it **halts** — a required tool missing, build/tests red, the UI verifier can't deploy — **stop this group**: record it as a failure, restore a clean base, and move on. Never finish a fix on a degraded or partial review.

   **Then read the verdict — a Workflow that RETURNS is not a review that PASSED.** The `wf_…` id proves the pipeline ran; it says nothing about what the pipeline found or which of its steps came back empty-handed. Those are two different questions, and the second one is the one that decides whether this diff is safe to merge. Before Step 4, check the returned result for:
   - `endVerify: "blocked"` — the mandatory Codex pass over the **final** diff did not run. Everything the review's own fixers changed is therefore unreviewed, which is precisely what that step exists to catch.
   - `tracksBlocked` non-empty — a review track died; whatever it covers had no reader.
   - `build` or `localScan` not green.

   Any of these means the change has a surface nothing looked at. **Do not merge.** Either re-run the blocked step until it genuinely runs, or record the group as failed and restore a clean base. This has happened: a group's review Workflow ran perfectly and returned `endVerify: "blocked"` because the Codex wrapper inside it produced no report — the six fixes applied earlier in that same run had been reviewed by nothing, and only a caller noticing that `"blocked"` is not `"passed"` kept an unreviewed diff off `main`. The `wf_…` check would have passed it.

4. **Finish in the main thread.** With the review done and its fixes folded into the working tree (still uncommitted on the group's branch `<gb>`), close out the fix exactly as `/r:task-run`'s `--skip-pr` finish would:
   - **Confirm you are actually on `<gb>`**: `git rev-parse --abbrev-ref HEAD`. It should never be `<base>` (the implement Workflow halts rather than hand back a run that stayed on base), and this is a two-second check that stops a whole group's work being committed onto `main`.
   - **Mark a file source's items done, now — after the review, before staging.** Tick each of the group's items in place, `- [ ]` → `- [x]`, appending the branch on the line (`<!-- fixed: items-login-escaping -->`); an item with no checkbox gets the marker alone. Re-locate each by its **verbatim text**, never by the line number you read in Step 1. The rules — what is already done, what to do when the text has moved — are [references/issue-sources.md](references/issue-sources.md).

     The order is the point. **After** the review, so the reviewer's diff is the code change and not a bookkeeping edit the doc-consistency hunter has to rule on; **before** the commit, so "fixed" and "marked done" land together and revert together. A tick committed separately, or not at all, is how the same item gets offered again next run.
   - **One commit** on `<gb>`: stage everything (implementation + the review's fixes + the ticks) and commit once, referencing every item in the group in the message. **Write the message to a file and use `git commit -F <file>`, never inline `-m`.** These messages carry item text, backticks and quotes straight from the source, and a single stray double-quote breaks the shell mid-commit — inline quoting buys nothing here and fails on exactly the messages that matter most.
   - **Idempotent merge into base:** if base already contains the branch tip (`git merge-base --is-ancestor <gb> <base>`), it's already merged — skip. Otherwise `git checkout <base> && git merge --no-ff <gb>`, then delete the branch. **If the merge conflicts, stop and surface it — never force it** (record the group as failed).
   - **Close every GitHub issue in the group — one `gh issue close <n>` call per issue.** `gh issue close` accepts exactly one issue (`gh issue close 42 90` fails: `accepts 1 arg(s), received 2`), so loop over the group's numbers. Reference the merged work, with the `planReview` note on each. This comes **after** the merge because it is the one step that touches something outside the repo, and a closed issue cannot be un-closed by `git reset`.
   - **A list file outside the repo, or untracked, has no commit to ride in.** Tick it anyway and **say so in the report**: that is the one case where reverting the fix leaves the backlog still claiming the work is done. An inline list has nothing to write back to at all — report every item it fixed by name, because nothing else will remember.

5. **Record the outcome and continue.** Record fixed / stopped / failed per group (and per item within it) with the reason, restore a clean base branch, and move to the next group. A subagent-reported `stopped`, a halted review, or a merge conflict is **one group's failure — never the loop's.** One group that can't be fixed should never abort the whole run.

Never run two fixes against the same repo/branch at once — see [Non-negotiables](#non-negotiables).

## Step 5 — Report

Close with a summary of the whole run so the user sees exactly what happened. Include each group's **review tier** (the `profile` the post-task-review Workflow returned, which is the depth its diff actually got — not the implement half's guess): across a backlog this is the one column that shows where the review effort went, and both Workflows log their tier only to the `/workflows` view, so it never reaches the user otherwise.

```
Backlog: issues.md — verified 7 candidates → 5 to fix in 3 groups, 2 skipped.

Fixed, merged & marked done:
  G1  Login 500s… / Signup…     bug      full      merged items-login-escaping → main, both ticked
  G2  Refund total is negative  bug      full      merged item-refund-total-sign → main, ticked
  G3  Export CSV as UTF-8       feature  standard  merged item-csv-encoding → main, ticked

Skipped (verification):
  How do I configure X?         question, nothing to implement
  Add dark mode                 already shipped in SettingsPanel

Failed (fix stopped):
  G4  Flaky checkout timeout    /r:task-run stopped: build failed after fix — needs a look
```

List the groups, which items each resolved, which branch merged into base, and the reason for every skip or failure. Point the user at anything that stopped and needs manual attention.

**Say plainly what was written back and what wasn't.** A closed issue and a ticked line are visible in the source; an item fixed with **no** write-back is visible nowhere. So name every item whose source could not record it — an inline list, a file whose line had moved, a list outside the repo — because that is exactly the set the next run will offer all over again.

Then record one line into the pack-wide store — counts only, never item titles or bodies:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:issues-fix","source":"file","candidates":0,"verifiedItems":0,"skipped":0,"groups":0,"merged":0,"stopped":0,"dryRun":false}
STATS_JSON
```

The pair worth measuring is `candidates` against `verifiedItems`: it says how much of a backlog is real work, which is what decides whether the read-only verification pass earns its cost. `source` (`github` | `file` | `inline`) is what lets that ratio be read per source — a hand-kept file and a triaged tracker are not the same population, and one ratio averaged over both answers neither question. The script always exits `0` — a lost row is a lost row, never a failed run, and it must never change what was merged or closed. Never retry it.

## Non-negotiables

- **Real tools only, the source's included.** Actually run `gh` against a GitHub tracker, actually read and actually write the file backing a file source, and run the real `/r:task-run` for every fix; never simulate a triage, a fix, or a write-back with a prose summary. If a required tool can't run, stop and say so. A source you cannot write back to is not a reason to skip the write-back quietly — it is a line in the report.
- **Both halves are Workflows, run from your main thread.** Per group: `task-run-implement.workflow.js` for the plan/implement half, then `task-review.workflow.js` for the review. Each isolates its own fan-out and returns a summary, so neither floods your context and neither can silently degrade. Never hand either half to a subagent — since 2.1.217 a subagent has no `Agent` tool, so `/r:task-run` nested there can't spawn its planner, its Codex reviewer, or its implementers, and post-task-review nested there can't reach the `Workflow` tool at all. Both failures are silent: the work still returns something that looks like success. And never run the implement half inline via the Skill tool — it works, but it floods this loop's context by the third group.
- **The review runs as the Workflow — verify it, never accept a silent prose fallback.** In the main thread, invoke the post-task-review **Workflow** directly (canonical `scriptPath`) and confirm it returned a `wf_…` Run ID (Step 4.3). If the `Workflow` tool isn't available, `/r:issues-fix` is not running in a real main thread (it's been nested in a subagent) — **STOP and tell the user**; don't let the review quietly degrade to prose. The whole split exists to run the deterministic pipeline, so a prose-degraded review defeats it and must never be finished (merged/closed) as if it passed.
- **Fixing is serial — one group at a time.** Never run two fixes against the same repo/branch; each group owns one branch that gets merged to base, and overlapping runs collide. Verification may parallelize (read-only); fixing may not.
- **Group only on real code overlap *and* comparable risk.** Both tests must pass (Step 2.5): the items' `touches` name the same file/module/subsystem, **and** their `risk` tiers are equal or adjacent — never `cosmetic` with `deep`. Grouping buys **cost and coherence** (one plan/review pass, one review seeing the whole change), never safety: the serial rule already guarantees two branches can't race. So a mismatched group trades a cheap saving for a real price — the trivial fix waits behind the risky one's review, the review's attention goes to the risky half, and one commit means you can't revert either without the other. `--no-group` turns clustering off; `--group <refs>` forces a specific cluster. Within a tier, though, **fold generously** — a group of one is not free, it buys a whole extra review pass, and the review is the slow half of this loop. Doubt about *tiers* means don't group; doubt about how tightly two same-tier `local` fixes overlap means group them.
- **Verification accepts real work, not only defects.** A feature or a chore that is genuinely actionable and not already built is a `fix`, and its `category` is recorded honestly so `--bugs-only` can filter on it. What earns a `skip` is an item nobody could implement from what it says, or one the code has already overtaken — never the mere fact that it adds rather than repairs.
- **Verification is strictly read-only.** Verifier subagents diagnose and report — they never edit code, touch git, or mark anything done. All code changes happen inside the two Workflows: `run-task-implement` and `/r:task-review`.
- **Hand `/r:task-run` references, not bodies.** Passing a raw body as free text bypasses source detection and loses the acceptance-criteria/intent behavior — the free-text arm is defined as the one with no written criteria to lift. Pass GitHub issues as refs (`#42 #90`) and file items as `<path> / <locator> | <locator>`, the locator being a short unique prefix of the item's own text.
- **Clean base between iterations.** Every group starts from a clean checkout of the recorded base branch. Never sweep an unrelated dirty tree into a fix's commit; if the main-thread merge (Step 4.4) conflicts, stop and surface it — never force it.
- **Mark items done only after the review passed and the merge landed, never before.** Tick a file's items after the review returns and before the single commit, so the tick rides in that commit and reverts with it; close a GitHub issue only after the merge, because `git reset` cannot reopen it. An item fixed with no write-back must be named in the report — otherwise the next run offers it again.
- **Honor the approval gate unless `--yes`.** The gate exists because each fix mutates the repo and marks every item in the group done; don't skip it on your own initiative. `--dry-run` never mutates anything.
- **A stopped fix is one group's failure, not the loop's — and "stopped" means the Workflow said so.** Record a `{ stopped: … }` result, restore a clean base, and keep going. An awaited Workflow's returned value **is** its completion signal: there is nothing to poll, no output file to watch, and no reason to interrupt one that is still running. If you feel the need to check on a long implement, verify ground truth read-only (branch exists, plan `status:`, tests) and let it finish. The serial rule forbids a *second, parallel* fix; it never justifies ending the one in flight.
