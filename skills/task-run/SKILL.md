---
description: >-
  Run one unit of work end to end — a GitHub issue (or several related refs that one change fixes,
  e.g. `#42 #61`), a single phase of a todo/plan file, or a free-text description — through plan →
  plan-review → implement (TDD) → /r:task-review → finish. Finishing opens a PR (`Closes #N`, one
  line per issue; a todo phase also gets its checkboxes ticked); `--skip-pr` merges the branch
  back into its base instead. Use whenever the user says "/r:task-run", "run issue #42",
  "implement this GH issue", "do issue <n>", "work the next phase", "implement Phase 3 of
  todo.md", "run this task: …", "build <feature> end to end", or hands over an issue URL, a plan
  phase, or a plain description of work and wants it actually built, reviewed and shipped rather
  than just planned. Always runs on a feature branch and never pauses for approval. Accepts
  `--light` / `--standard` / `--full` to force the review depth; otherwise it auto-classifies —
  light for a change that cannot alter behavior, standard for ordinary work that can (the default
  whenever the call is unclear), full when the approach itself needs reviewing or the change
  touches auth, money, persistence, concurrency or security. Every tier builds, tests, runs
  mandatory static analysis, and gets a Codex review of the final diff. NOT for: writing a plan
  only (that's /r:spec-brainstorm or /r:spec-plan), reviewing an existing diff (that's
  /r:task-review), or one-off edits you'd just make directly.
effort: xhigh
disable-model-invocation: true
---

# run-task

Take one unit of work — **a GitHub issue**, **a single phase of a todo/plan markdown file**, or **a free-text description of the work** — and carry it all the way from a blank slate to a reviewed, tested, shipped change. The skill is the orchestrator: it plans, gets the plan independently reviewed, fixes it, implements it test-first, runs the post-task review (at the depth the task warrants), and ties off the loose ends (a PR, plus checkbox ticks for a todo phase).

Everything here uses a **real tool** — `gh`, the real codex review, the real `/r:task-review` (which itself runs Codex over the diff, the bug hunters, `/r:code-scan`, the UI verifier), real build runners. Never imitate any of these with a prose "review" or a fake summary. If a required tool can't run, stop and tell the user — see [Non-negotiables](#non-negotiables).

## Invocation

`/r:task-run <task source> [--skip-pr] [--light | --standard | --full] [--stop-after-implement]`

- **Task source** is one of three things, detected in this order:
  1. **GitHub issue(s)** — `#42`, `42`, an issue URL, "issue 42". Several refs in one source (`#42 #61`) are a **grouped task**: issues that a single change fixes together. The workflow fetches each, merges their acceptance criteria (prefixed per issue), and names the branch `issues-42-61-<slug>`. The finish closes every issue in the group.
  2. **Todo phase** — a path to a markdown file plus a phase identifier (number, title, or "next phase").
  3. **Free-text description** — anything else that describes concrete work (e.g. `add a dark-mode toggle to the settings page`). This is the fallback: if the argument isn't an issue ref or a todo file+phase, treat the whole argument as the task description.
- **`--skip-pr`** changes only the finish step: instead of opening a PR, merge the feature branch back into its base branch and delete it. It does **not** skip any review.
- **`--light` / `--standard` / `--full`** force the review depth instead of letting the implement workflow classify it. Omitted → the run auto-classifies (see [Review tiers](#review-tiers)), and escalates to **full** by itself if the explorers find that the change alters one of the five risk surfaces the classifier tree names — auth/permissions, money, persistence, concurrency, security — including over an explicit `--light`, which it says plainly in the log rather than ignoring your flag in silence. Risk that merely lives near the change, or ordinary branching and read-only queries, is not an escalation; the escalation gate counts only those five surfaces and only when the flag cites a real `path:LINE`, so an over-broad or placeholder flag buys nothing rather than merely being discouraged.
- **`--stop-after-implement`** (opt-in) runs Steps 0–4 only — plan, plan-review, TDD implement, build green — then **stops before the review (Step 5) and the finish (Step 6)**, leaving the uncommitted diff on the feature branch and returning the implement workflow's handoff. A **standalone `/r:task-run` never passes this flag** and runs the complete flow end-to-end. A caller that only wants the implement half is usually better served by calling `run-task-implement.workflow.js` directly — same handoff, and it never loads this skill's text into its context.

The fallback only kicks in when the input actually describes work. If it's contentless or genuinely ambiguous (e.g. just "run the next thing" with no file, issue, or described work), ask the user what they mean before doing anything — this is the one case where the run stops for input, because there's no task to run at all. Once a real task is identified, the run proceeds end-to-end without further confirmation.

## Steps 0–4 — Implement: one deterministic Workflow

Everything from "what is this task?" to "the build is green" runs as a **single Workflow call**, from *your* main thread:

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/task-run/task-run-implement.workflow.js",
  args: { packRoot: "${CLAUDE_PLUGIN_ROOT}",
          source: "<the raw task source, verbatim>",
          profile: "<light|standard|full — omit unless the user forced it>",
          base: "<the current branch>" }
})
```

It returns the handoff — `{ branch, base, profile, profileReason, profileForced, profileEscalated, uiTouched, taskIntent, planPath, criteria, buildGreen, planReview, testEvidence }` — or `{ stopped: <reason>, … }` when the run can't honestly continue (see [When the workflow stops](#when-the-workflow-stops)). `buildGreen` is `true` or `'n/a'`, never a bare `true` for a project with no build tool the workflow knows how to run — don't report a build as passing in the PR body when none ran. `branch` is always a real feature branch — a run that couldn't leave `base` stops instead of handing one back. `testEvidence` is what the implementers **observed** when they ran each test before and after the change; a test that was already green is a regression guard, so don't present it as proof the fix works. Carry the handoff into Step 5 and Step 6; `taskIntent` and `criteria` are what stop a later fixer from undoing work the task did on purpose.

**Say the tier out loud the moment the workflow returns.** The workflow's own tier log goes to the `/workflows` progress view, not to this conversation, so unless you report it the user never learns how deeply their task was reviewed. One line, before anything else — **echo the handoff's actual `profile`, whichever of the three it is**, with `profileReason` as the justification:

```
tier: <profile> — <"forced by --<flag>" | "classified"> : "<profileReason>"
```

Every tier gets reported, not just the interesting ones — a run that says nothing about its tier reads as if it ran at full depth. All three shapes, plus the escalation case:

```
tier: light — classified: "log-level change only, no behavior"
tier: standard — classified: "bug fix inside one existing method, no risk surface"
tier: full — forced by --full
tier: full — escalated from light (overrode your --light): the change alters money math
             at PricingService.java:88
```

When `profileEscalated` is true, always name the risk the explorers found. An escalation that overrode an explicit flag is the last thing a user should discover from a PR body.

**Mid-run, the tier is on disk.** The plan file's header carries it from the moment planning ends, before a line of code is written:

```
$ head -4 .task-plans/<slug>.md
status: implementing
tier: <light|standard|full>
```

That's the settled, post-escalation value — useful when checking on a long run without opening `/workflows`.

`planReview` is `{ ran, passes, raised, applied[], dropped[] }` — what Codex raised about the plan and what the triage did with it. `ran: false` means the tier was below full or this was a resume, **not** that Codex came back clean (a Codex that can't run stops the workflow outright). Read `dropped` before you accept the run: it lists findings the triage judged not-real, and if it dismissed *everything* Codex raised, the plan went in exactly as the planner wrote it while still counting as reviewed. That can be perfectly correct — Codex does raise false positives — but it's worth a glance rather than an assumption.

**Why a Workflow, and not a fan-out you drive yourself.** run-task *is* its subagents — 1–3 `Explore` mappers, the Opus planner, the Codex plan reviewer, the domain implementers, the build runner. Claude Code **2.1.217 removed the `Agent` tool from subagents**, so a run-task running inside a subagent can no longer spawn any of them; it would collapse into a single-context run and still report success. A Workflow script runs in the main thread and spawns every agent *itself*, so the fan-out survives while the caller's context only ever sees the returned handoff. That is what lets `/r:gh-issues-fix` drive a whole backlog without its own context filling up, and it is the same "move the fan-out up one level" fix `post-task-review.workflow.js` already applies to the find-bugs hunters.

**The script is the spec — this section is not a second copy of it.** `run-task-implement.workflow.js` holds the real definition of Steps 0–4: source resolution and acceptance criteria, tier classification, the unconditional Explore fan-out, the plan (Opus at xhigh, deepened once, loading `frontend-design` first when the task touches the UI so visual direction is decided while it's still cheap, written to `.task-plans/<slug>.md` with its `status:` header by a **separate scribe**, because the read-only `Plan` type cannot write and moving the planner off it would trade a structural guarantee for a prompt), the Codex plan review with its fixed rubric, its judges **batched by rubric** rather than one agent per finding, and a single bounded re-review, test-first implementation through domain subagents, and the bounded build loop. The feature branch is created **alongside** planning rather than after the review, since it depends on nothing either produces. Read the script when you need the detail, and **change the pipeline there**, deliberately, via `skill-creator`. Resist restating the graph here: post-task-review pays a real lockstep tax for carrying two encodings, and this pipeline has no second engine to keep in sync — a context without the `Workflow` tool has no `Agent` tool either, so there is nothing a prose fallback could actually orchestrate.

**The one judgement that stays with you, before the call.** Decide whether there is a real task at all. If the input is contentless or genuinely ambiguous — "run the next thing", with no file, no issue, and no described work — **ask the user what they mean before starting anything**. This is the only point in the run that stops for input, and it has to live here: workflow agents can't reach `AskUserQuestion`. Once a real task is identified, hand the source to the workflow verbatim and the run proceeds end-to-end without further confirmation.

Pass `profile` only when the user forced a tier. Otherwise let the workflow classify — see [Review tiers](#review-tiers) below.

### Review tiers

Three tiers, chosen by what the change *does*. The workflow classifies from the task source, then the explorers can escalate on what they read in the code; the tier only ever moves up.

| | light | standard | full |
|---|---|---|---|
| Explorers | 1 | 2 | 2–3 |
| Plan | brief | full Opus xhigh | full Opus xhigh |
| Codex **plan** review | – | – | ✅ + 1 bounded re-review |
| up-front Codex over the diff | – | `--mode review` | adversarial |
| security hunter (real `/security-review`) | – | ✅ | ✅ |
| docs-consistency hunter | – | ✅ | ✅ |
| `/r:code-bugs` pattern hunters (`logic`, `runtime-and-failures`) | – | – | ✅ |
| `/r:code-quality` → `/r:code-refactor` | – | – | ✅ |
| build + tests, `/r:code-scan` | ✅ | ✅ | ✅ |
| Codex `--mode review` on final diff | ✅ | ✅ | ✅ |
| UI verifier | iff `uiTouched` | iff `uiTouched` | iff `uiTouched` |

The classifier answers three questions in order: *can this alter behavior for any real input?* (no → **light**); *does it need a design decision, span several seams, or add or alter auth / money / persistence / concurrency / security?* (no → **standard**); otherwise **full**.

**Unclear calls land on standard, not full.** That is the point of having it: standard still gets a real Codex read of the diff, the real `/security-review`, doc-drift checking, static analysis and a green build, so `full` can mean the one narrow thing it should — *this approach needs challenging before code is written*. What standard trades away is the three `/r:code-bugs` pattern hunters (their performance-at-scale lens has no dedicated reader below full), the up-front adversarial pass and `/r:code-quality`. A tier that absorbs every uncertainty ends up meaning nothing, which is exactly what happened when the only options were light and full.

### When the workflow stops

A `stopped` result is a real halt, not a hint to carry on by hand. **Never re-run the work inline to get past one** — a single-context redo of the pipeline this skill exists to enforce is precisely the failure it's built to prevent. Report the reason and stop:

| `stopped` | What happened | What to do |
|---|---|---|
| `no-source` / `source-blocked` | `gh` is missing or unauthenticated, the todo phase couldn't be read, or the task is contentless | Tell the user what's missing. Never scrape a fallback source. |
| `explore-blocked` | every explorer died, so nothing read the code | Report it — a plan built now would be anchored to imagined files. |
| `planner-blocked` / `plan-not-written` | the planner returned nothing after 3 attempts, or the plan file is genuinely missing/truncated on disk | Report it. `plan-not-written` now means the file was *checked* and is bad — a scribe that merely self-reports failure over an intact file no longer stops the run. |
| `codex-plan-review-unavailable` | the **real** Codex couldn't review the plan | Stop. There is no fallback reviewer and no stand-in model is acceptable — say the plan review can't run. |
| `branch-failed` / `branch-not-created` / `branch-name-missing` | the run could not get off the base branch (the checkout never happened, or Phase 0 produced no usable branch name) | Report it. **Never continue on base** — the whole point of the halt is that the diff would land on `main` and the finish step would try to merge `main` into itself. |
| `implement-blocked` | an implementer reports the plan is wrong or blocked | Surface *its* reason. Don't work around it. |
| `build-red-preexisting` | red build from failures that already fail on base | Surface them. Never fix or weaken an out-of-scope test to force green. |
| `build-red` | the in-scope build is still red after 3 bounded attempts | Surface the remaining failures. |

## Step 5 — Post-task-review (mandatory, runs to completion)

**`--stop-after-implement` stops the run before this step.** Under that flag, return the implement workflow's handoff and stop: Steps 5 (review) and 6 (finish) are the **caller's** job. (A caller that only ever wants the implement half is better off calling `run-task-implement.workflow.js` directly — it gets the same handoff without loading this skill at all. The flag stays for the case where a caller wants run-task's own front door.) The rest of this section (and Step 6) is the normal, non-flag path.

Invoke **`/r:task-review`** via the Skill tool over the resulting diff and let it run **to completion**. The diff is **uncommitted** (the implement workflow left it in the working tree) — that's fine: post-task-review reviews the working-tree diff. Invoke it in **defer-commit mode** so its readability refactor doesn't make its own commit but folds into the single final commit, and **pass the task intent** so the review's fix subagents don't "fix" (undo) something the task did on purpose — tell it to run with `{ packRoot: "${CLAUDE_PLUGIN_ROOT}", deferCommit: true, taskIntent: "<1–3 sentences on what this task set out to do, plus its acceptance criteria>", baselineBuilt: <handoff.buildGreen === true>, planReviewed: <handoff.planReview.ran === true> }`.

**`packRoot` is not optional and is not boilerplate.** `${CLAUDE_PLUGIN_ROOT}` is substituted in skill *markdown* and nowhere else — never inside a workflow script, and never in a subagent's shell, where it is unset and expands to the empty string. Seven of post-task-review's tool paths hang off it: both Codex tracks, the deploy and teardown helpers, the hunters' reference files and the stats sink. Passing your own args without it used to leave every one of them resolving under `/`; the review now halts with `stopped: 'no-pack-root'` instead, which is the failure you will see if this line is dropped. post-task-review threads that intent into every fixer; without it, a fixer briefed on only a `file:line` finding can revert intentional work. **`baselineBuilt` goes in only when the handoff says `buildGreen: true`** — never on `"n/a"` (no build tool ran) or `false`: it tells the review that a clean, fully green build already happened on this branch in this tree, so it can open incrementally instead of re-running the whole suite from an empty `target/` over a diff that has changed only by its own fix phase. The green bar is unchanged, and a deleted or renamed source still forces a clean build.

**`planReviewed` goes in only when the handoff says `planReview.ran: true`** — i.e. the real Codex actually challenged the plan for this task, which happens at the implement half's `full` tier. It lets a `full` review open with Codex's built-in `--mode review` over the diff instead of a second adversarial session, on the grounds that the approach was already challenged before the code existed. It changes **only** that one pass: every hunter, the static analysis, the build and the Codex read of the final diff are untouched. Never pass it on `ran: false` — below full there was no plan review, and the adversarial pass is then the only thing that questions the approach at all. It runs the real codex review over the diff, the bug hunters its tier calls for (the security hunter that runs the real `/security-review` and the docs hunter at standard and above; the pattern hunters as well at full), `/r:code-scan`, and the UI verifier, then triages and delegates fixes. Re-run the build if it changed code.

**Whether you pass `profile` depends on where the tier came from — read `profileForced` in the handoff.**

- `profileForced: true` — the user typed `--light`/`--standard`/`--full` (or an explorer escalated one of those to full). That's their call, so pass it through: add `profile: "<the handoff's profile>", uiTouched: <the handoff's uiTouched>`.
- `profileForced: false` — the tier was *classified from the task description before any code existed*. **Omit both `profile` and `uiTouched`.** post-task-review classifies from the diff it is about to review, which is strictly better evidence than a guess about work that hadn't happened yet — a task that sounded risky but landed as four lines gets reviewed as four lines, and one that sounded trivial but grew doesn't slip through.

**Report the review tier when it returns, the same way you reported the implement tier** — again echoing the `profile` post-task-review actually returned, whichever of the three it is. The two tiers are now decided from different evidence and can legitimately differ, so a bare "review done" hides the one number that says how hard the diff was really looked at:

```
review tier: <profile> — <"passed through (forced)" | "classified from the diff">
```

```
review tier: light — classified from the diff (1 file, 18 lines)
review tier: standard — classified from the diff; implement ran at full (the task read
             riskier than it landed)
review tier: full — passed through (you forced --full)
```

When it differs from the implement tier, say so in that line and again in the PR body — a divergence is informative, not an error to smooth over.

Depth is chosen by evidence, never faked. Within the chosen tier these tracks are **not skippable**. If `/r:task-review` halts — a required tool is missing (codex/sonar unavailable), a tool errors, the build or tests fail, or the UI verifier can't deploy — **stop and notify the user** with the failure. Do not advance to Step 6 on a degraded or partial review.

## Step 6 — Finish

**Skipped under `--stop-after-implement`** — the caller finishes (commit → merge/PR → close). Otherwise:

1. **Todo-phase source only:** flip only the tasks that were actually implemented **and** verified from `- [ ]` to `- [x]` in the todo file (and the phase heading itself if the whole phase is now done). A partial run leaves an honest record — never tick something that didn't pass verification. (GH-issue and free-text sources have nothing to tick — skip this part.)
2. **One commit — the only commit of the run.** Now, and only now, stage everything on the feature branch — the implementation, the review/fix changes from Step 5, and (todo source only) the checkbox ticks — and make a **single commit**. Nothing was committed before this point, so this lands the whole task as one commit, after the review. (If, on a resume, an earlier interrupted run already created a commit, fold the remaining working-tree changes in with a normal commit rather than forcing history rewrites — honest history beats a cosmetically-perfect single commit.)
3. **Default (no `--skip-pr`) — open a PR.** Push the branch and run `gh pr create --title … --body …`. The PR body has: a summary of the changes, the test plan, the **review tier** used (`light`, `standard` or `full` — name both when the implement and review tiers differed, and say why: the handoff's `profileReason`, or an escalation), the **plan-review outcome** from the handoff's `planReview` (what Codex raised and which findings were folded in — this is the auditable record of an approach that changed mid-plan), and **UI changes described in words** (no screenshots). For a GH issue add `Closes #<n>` — **one `Closes` line per issue** when the source was a group (`Closes #42` / `Closes #61`), so merging the PR closes them all; for a todo phase reference the phase; for a free-text task base the title/body on the description and the derived acceptance criteria (no `Closes`, no phase reference). Return the PR URL. For a GH issue you may also drop a `gh issue comment` linking the PR on each issue.
4. **With `--skip-pr` — merge instead.** First the **idempotency guard**: if base already contains the branch tip (`git merge-base --is-ancestor <feature-branch> <base>` succeeds, or `git branch --merged <base>` lists it), the merge already happened — skip it, don't re-merge or error. Otherwise `git checkout <base> && git merge --no-ff <feature-branch>`, then delete the feature branch. No PR is opened. If the merge conflicts, **stop and surface the conflict** — never force it. For a GH issue, `gh issue close <n>` referencing the work, since there's no PR to auto-close it — **close every issue in the group with one call each** (`gh issue close 42` then `gh issue close 61`; `gh issue close` accepts exactly one issue and errors on two). Todo and free-text sources have no issue to close.
5. Update the plan status header to `status: done`.

## Reading completion (don't wait on something that isn't running)

Since Steps 0–4 are one `Workflow` call and Step 5 is another, **you spawn no subagents of your own** — and an awaited Workflow's returned value *is* its completion signal. There is nothing to poll: no `.done` marker, no output file, no `Monitor`, no watching a file's mtime. Inventing such a protocol is what makes an orchestrator hang for minutes on work that already finished.

Inside the implement workflow the same rule holds structurally: `await agent(...)` resolves when that agent is done, dead agents are re-dispatched by a bounded loop, and the build and plan-review loops have hard caps. Those guarantees are code there, not sentences you have to remember here.

**The one trap that survives** is the detached shell job. The Codex plan review runs foreground (`--wait`), but a long review exceeds the ~600s Bash cap and moves to a **background Codex process — not an Agent child, so it never sends a completion notification, ever.** The workflow's Codex agent owns collecting it: poll the worker **pid** and then read the finished review from the job record's `rendered` field. Never poll for output-size stability — the log goes quiet for minutes mid-reasoning, so "it stopped growing" is a false done. A "came to rest / no live children" signal proves no child *agent* is running; it says nothing about a detached shell job.

If a Workflow call itself comes back without a usable result, treat it as a halt and report it — see [When the workflow stops](#when-the-workflow-stops). Never re-run the work inline to get past it.

## Resume & concurrency safety

A run-task run **owns one feature branch** and ends by merging it into base. **Two run-task runs on the same branch will collide at the merge** — double-merge, corrupted branch, or a lost half of the work. The trap that causes this is treating a transient failure as a death and spawning a *second* agent to "finish" the first.

- **A transient failure is not a death.** If an async run-task agent stops with an API/connection error (`ConnectionRefused`), or a `killed`/`completed`-with-error status, it may **still be alive or auto-resume when the API recovers**. A "completed" status with an *error* result does **not** prove it's permanently dead. (Note the difference from a clean "came to rest" notification, which — per [Reading completion](#reading-completion-dont-wait-on-something-that-isnt-running) — means the agent is idle with no live *Agent* child, though not necessarily no detached background job: read its last message before deciding it's done, then act on what you find.)
- **Never launch a parallel agent to resume, and never stop the one you already have.** Before doing anything about an interrupted run, confirm the original is *actually* terminated and has no live work: poll its status (a status that flips back to `running` means it resumed — let a genuinely-progressing agent finish) **and** read its last message for a live `run_in_background` job it's collecting — per [Reading completion](#reading-completion-dont-wait-on-something-that-isnt-running), "no live children" does **not** cover a detached shell job like the end-verify Codex, so an agent quietly waiting on one is progressing, not dead. Only if it keeps *coming to rest* with **nothing named in flight** do you apply the bounded resolution there: resume the *same* agent once for a final report, then verify read-only and move on. The branch-race danger this section exists for is **spawning a second, parallel agent** — that is the only thing that races the merge. It is **never** a reason to stop or kill the single in-flight agent: there is no second agent for it to race, and stopping it discards its transcript, turning a recoverable async wait into a dead run you can't resume.
- **Resume is single-agent, in place.** The partial work lives on the feature branch's working tree — and because commits are deferred to the finish step, that working tree is *uncommitted* until Step 6, which is expected: git keeps the working-tree changes across the interruption. The plan persists at `.task-plans/<slug>.md` with a `status:` header (`reviewing → implementing → done`). To resume: check out the existing branch and continue from the recorded status — re-plan only if status is still `reviewing`; otherwise pick up at implement/review/finish (the uncommitted changes are still there). Never re-create the branch, never spawn a duplicate.
- **The branch-exists check (inside the implement workflow)** and the **idempotent merge (Step 6)** above are the deterministic backstops — honor both so a resumed or re-invoked run can't double-branch or double-merge. The workflow also skips planning and plan-review outright when the plan file is already at `status: implementing`, so a resume picks up where it left off instead of re-planning.

## Non-negotiables

- **One agent per branch.** Never run two run-task agents against the same feature branch — a transiently-failed async agent can auto-resume, and two runs collide at the merge. Resume in a single agent from the persisted plan; rely on the branch-exists check and idempotent merge. See [Resume & concurrency safety](#resume--concurrency-safety).
- **Never stop or kill a subagent to resolve a stall.** Recovery is read-only — inspect `git status`/`git diff`, the target files, and the last test output — and then either let a genuinely-progressing agent finish (one that named a live background job it's collecting, like the end-verify Codex) or resume the *same* agent in place. A "came to rest / no live children" notification only means no live *Agent* child; it does not mean a detached `run_in_background` shell job has finished. Stopping/killing discards the agent's transcript, so you can't resume it — a recoverable async wait becomes an unrecoverable dead run. See [Reading completion](#reading-completion-dont-wait-on-something-that-isnt-running).
- **Orchestration belongs in the main thread — and this run must never re-do it inline.** As of Claude Code **2.1.217, subagents no longer have the `Agent` tool** (verified: a `general-purpose` subagent's tool list is `Agent, Bash, Edit, Read, Skill, ToolSearch, Write` on 2.1.216 and loses `Agent` from 2.1.217 on). Only the main thread — and a `Workflow` script, which runs there — can spawn. That is exactly why Steps 0–4 are a Workflow rather than a fan-out driven from a subagent. **Check, don't assume, in either direction:** `ToolSearch` can't answer this at all (`Agent` is top-level and only *deferred* tools are indexed, so `select:Agent` returns nothing regardless), and Anthropic may restore nested spawning in a later release — so the only real evidence is what an actual call does. If you find you can reach **neither** `Workflow` nor `Agent`, you are nested inside a subagent: **stop and tell the user** to run `/r:task-run` from a top-level session. Never quietly re-run the whole task in one context and report success — a single-context run that claims a plan review and a fan-out it never had is the one outcome this skill exists to prevent.
- **Real tools only.** Never imitate codex, the bug hunters, `/r:code-scan`, or the UI verifier with a prose summary. If you can't run the real thing, stop and say so.
- **Reviews are mandatory and real — their depth is chosen by evidence, never faked.** The implement workflow classifies each task into one of three tiers, or takes an explicit `--light`/`--standard`/`--full`; see [Review tiers](#review-tiers) for what each one runs. **No tier ever gives up build + tests, mandatory `/r:code-scan` static analysis, or a real Codex read of the final diff** — depth scales, integrity doesn't. Uncertainty routes to **standard**, and a change that turns out to alter a risk surface escalates to **full**; the tier only moves up. Every step that runs is the **real** tool — never skip, fake, or silently degrade; if a required tool cannot run or genuinely fails, **stop and notify the user**. `--skip-pr` changes only the finish step. (There is no plan-approval gate; the run is autonomous — the implement workflow folds accepted plan-review findings straight back into the plan and keeps going.)
- **A PR is required for every run unless `--skip-pr` is passed.** All three sources run on a feature branch and open a PR by default; `--skip-pr` is the only thing that replaces the PR with a `--no-ff` merge into base. Never force a conflicted merge.
- **One commit at the end — never before the review.** Implementation and the review/fix phase both stay uncommitted in the working tree; the whole task lands as a single commit at finish (Step 6), after `/r:task-review`. That's why Step 5 invokes post-task-review with `{ deferCommit: true }` — so its refactor doesn't sneak in an early commit. The reviewers read the working-tree diff, so deferring the commit costs nothing.
- **Only tick verified todo tasks.** Honest checkboxes over optimistic ones.
- **`.task-plans/` must be gitignored** before the first plan is written there.
