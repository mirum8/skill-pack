---
description: >-
  Run the user's post-task review routine over the current git diff — one pipeline that finds
  everything, fixes it once, and verifies the result: parallel Codex + bug/security/docs hunters +
  code-quality, one fix phase, build with tests, mandatory `/r:code-scan` static analysis, a
  bounded Codex end-verify of the final diff, and UI/runtime verification when the frontend
  changed. Runs in three auto-classified tiers (light / standard / full) that scale depth only —
  no tier drops build+tests, `/r:code-scan`, or a real Codex read of the final diff. Every step
  invokes the ACTUAL tool, never an LLM imitation. **This routine is NOT automatic.** Invoke it
  only when `/r:task-run` reaches its post-task-review step, or when the user explicitly asks —
  "run the post-task review", "run the post-task checklist", "review the diff and fix it",
  "/r:task-review" (optionally with `--light` / `--standard` / `--full`). Never trigger it on your
  own after an ordinary code change, and never at the end of a regular coding session.
  Auto-detects Maven vs Gradle; skips itself on doc-only / config-only turns.
effort: xhigh
---

# post-task-review

The single entry point for the user's post-task verification. It runs over the **current git diff** (the code that just changed) and brings it to a clean, reviewed, building state. Each step invokes a **real** tool — never an LLM pretending to be one. The routine is deliberately one place so it can't drift, get reordered, or be half-applied across a sprawling checklist.

The shape is **find everything → fix everything → verify once.** All analysis happens up front in one parallel pass, all fixes happen in one phase, and a single bounded end-verify at the close re-checks the code the fixes/refactor/scan wrote — so nothing the routine itself changed ships unreviewed, without re-running a full review after every step.

**What runs off the critical path.** Three things are dispatched early or in parallel because nothing waits on them: the docker image **pre-warm** starts at Triage (it builds without starting anything, so it can only ever be a warm cache); the **docs hunter** runs outside the review join, because doc drift is a list handed to the user and never an auto-fix; and the **end-verify and the UI verification run together**, since one reads the git diff and the other drives a browser against a deployed image. That last one has a guard: if an end-verify fixer lands in a frontend file, the UI halves re-deploy and re-verify once, because what they looked at is then stale.

## How this runs — deterministic Workflow in the main thread, prose pipeline as the fallback

This routine has **one definition** — the graph of Steps 0–9 — with **two execution engines**, chosen by *where you're running*. **In the main thread, run the deterministic `Workflow`.** When you can reach the `Workflow` tool (a direct `/r:task-review`, or a `/r:task-run` you invoked yourself in the main thread), run the pipeline as the prototype script — do not hand-execute the steps:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/task-review/task-review.workflow.js",
           args: { packRoot: "${CLAUDE_PLUGIN_ROOT}" } })
```

**Run that canonical path verbatim — never a copy, never an edited fork, never an inline post-task-review script.** The pipeline is immutable on purpose (see the first non-negotiable); a `PreToolUse` guard hook (the pack's `hooks/guard-workflow.py`) blocks any forked invocation, so if a run seems to need different behaviour, that's a STOP-and-surface, not a reason to fork.

The script encodes the graph as real control flow, which is what makes the routine reliable: a subagent's returned value **is** its completion signal (nothing to poll, no invented `.done`/output-file), a dead/stalled subagent is re-dispatched in a bounded loop then surfaced, the build and end-verify loops are hard-capped, the UI teardown runs in a `finally`, and a failed `/r:code-scan` is treated as not-clean. These are the reliability properties this routine depends on; expressing them as code rather than prose is the point.

You run the pipeline on **every** invocation — there is no "skip the review for small diffs." Cheap turns stay cheap because **Step 0 / Phase 0 (Triage)** does the gating *inside* the graph: a doc/config-only diff returns immediately, and the rest are sorted into three tiers that scale how much of the up-front fan-out runs. Static analysis is not part of that gating — `/r:code-scan` is mandatory in every tier. So starting the pipeline unconditionally costs almost nothing on a turn that doesn't need it.

**Without the `Workflow` tool, run the prose pipeline — but only if you can still spawn.** The `Workflow` tool exists **only in the main thread**; no subagent has it, not even a `*`-tools `general-purpose` one. When it isn't reachable, execute the pipeline by hand from **`references/prose-pipeline.md`** — Steps 0–9 in order. That file is the **authoritative spec** (the workflow script mirrors it) and it carries the same guarantees: bounded build/end-verify loops, unconditional UI teardown, fail-closed `/r:code-scan`, red-build-halts. Follow it exactly; it is binding, not best-effort. **Don't read it on the normal path** — when the `Workflow` tool runs the script, that prose is 16k tokens of context describing steps you are not executing.

**The hard floor: no `Workflow` *and* no `Agent` means STOP.** This pipeline is a fan-out — Codex, the hunters, `/r:code-quality`, the fixers, the build runner, the UI verifier. Since Claude Code **2.1.217 subagents have no `Agent` tool**, so a post-task-review nested inside a subagent can reach neither engine: it can't run the Workflow and it can't dispatch a single reviewer. There is no honest way to run this routine from there. **Do not** improvise a single-context skim and report it as a review — that is precisely the "never fake a scan" line this skill exists to hold. Say plainly that the deterministic review isn't available in this context and that the user should re-run from a top-level session, and stop.

Well-designed callers never land there: a direct `/r:task-run` runs in the main thread, and `/r:gh-issues-fix` runs **both** halves — `run-task-implement` and this review — as Workflows from its own main thread. The prose path is a genuine fallback for a main thread that has `Agent` but no `Workflow` (a headless/cron context), not a way to smuggle the review into a subagent.

## Arguments

Pass `args` through when relevant:

| arg | meaning |
|---|---|
| `{ scope: "all" }` | review the whole project, not just the diff |
| `{ thorough: true }` | widen depth |
| `{ baselineBuilt: true }` | the caller *just* ran a clean green build in this working tree, so skip the run's own clean build. Pass **only** from a handoff reading `buildGreen: true` |
| `{ deferCommit: true }` | the caller commits the whole task once at the end (e.g. `/r:task-run`), so the readability refactor lands in the working tree instead of as its own commit |
| `{ taskIntent: "…" }` | 1–3 sentences on what the change set out to accomplish |
| `{ planReviewed: true }` | Codex already reviewed the **plan** for this task, so `full`'s up-front pass runs `--mode review` instead of the adversarial one. Pass **only** from a handoff reading `planReview.ran: true` |
| `{ profile: "light" \| "standard" \| "full" }`, `{ uiTouched: bool }` | force the tier / the UI gate |

`taskIntent` is threaded into every fix subagent so it doesn't "fix" (undo) something intentional; `/r:task-run` passes it automatically. When it's omitted, Triage infers it from the diff and any `.task-plans/*.md` plan file, so a standalone `/r:task-review` still gets one.

**Leave `profile` out unless the user forced it.** Phase 0 classifies from the diff, which is better evidence than anything a caller can supply before the code exists — that is why `/r:task-run` passes a tier only when the user asked for one, so a task that *sounded* risky but landed as four lines gets reviewed as four lines.

## The three tiers

The tier scales **depth**, never integrity. Phase 0 picks it from the diff by three questions, in order:

1. Can the change alter behavior for any real input? No → **light** (a getter, a constant, a log message, a rename, formatting, a comment, a cosmetic CSS tweak).
2. Does it carry a design decision — a new or changed approach, several seams, a data model or contract — or touch auth/permissions, money/pricing/tax math, persistence (query, schema, migration, index), concurrency/locking, or security-sensitive code? No → **standard** (a bug fix inside one method, a null check, a new field plus its mapping, a new endpoint over an existing service).
3. Otherwise → **full**.

**When unsure, answer `standard`.** Scary wording alone doesn't force `full` (a copyright-year bump in a payment template is light); "small" alone doesn't earn `light` (a one-line auth-role change is full).

| | light | standard | full |
|---|---|---|---|
| up-front Codex | – | `--mode review` | **adversarial**, or `--mode review` when `planReviewed` |
| pattern hunters (`logic`, `runtime-and-failures`) | – | – | ✅ |
| security hunter (real `/security-review`) | – | ✅ *if the diff has security surface* | ✅ *same gate* |
| docs hunter (code/doc drift) | – | ✅ *off the critical path* | ✅ *off the critical path* |
| `/r:code-quality` (readability) | – | – | ✅ |
| build + tests | ✅ | ✅ | ✅ |
| `/r:code-scan` static analysis | ✅ | ✅ | ✅ |
| Codex end-verify of the **final** diff | ✅ | ✅ | ✅ *(regression-only)* |
| UI / runtime verification | *iff* `uiTouched` | *iff* `uiTouched` | *iff* `uiTouched` |

**Spend depth where judgement happens.** This skill's frontmatter sets `effort: xhigh`, which every subagent would otherwise inherit — including ones whose whole job is running a shell command. The workflow tiers the fan-out instead. The test is not "does this step matter" (they all do) but **"does this agent decide anything?"** — a wrapper around a tool that decides for it does not, and neither does a fixer whose finding was already judged real by someone else. So the pre-warm, teardown, stats sink and issue-filer run at `low`; the build runners, UI deploy, Phase 0 triage and both Codex tracks at `medium` (Codex does the reviewing, the agent shells out and parses); the pattern hunters at `high` and the docs hunter at `medium` (a bounded match against a reference file, and doc drift is never auto-fixed); the UI halves and every fixer at `high`. What keeps `xhigh` is the set that forms an opinion nothing downstream re-forms: the security hunter, `r:code-quality`, the fix-triage that decides what is a false positive, `/r:code-scan`'s triage of its own findings, and the readability refactor.

There's a second reason these are pinned rather than inherited: **the frontmatter only applies when this skill is entered through the Skill tool.** Called by `scriptPath` — which `/r:gh-issues-fix` does for every group — nothing sets it, and an unpinned agent silently takes the *session's* effort. Pinning makes the review's depth a property of the pipeline instead of a property of how it happened to be invoked.

## Non-negotiables

The full text of each lives in `references/prose-pipeline.md` (between Steps 8 and 9). These govern **both** engines:

- **This routine never fires on its own — but it is reachable.** It runs on an explicit `/r:task-review`, or when `/r:task-run` reaches its post-task-review step and invokes it through the Skill tool. It does **not** run because a coding turn ended, a build went green, or a diff looked reviewable. This rule used to be frontmatter (`disable-model-invocation: true`), which was wrong: that flag doesn't distinguish "the model auto-loaded this" from "the model was told to run this", so it also blocked `/r:task-run`'s mandatory Step 5 — the pipeline's own caller could not reach it. The flag is gone and the rule is held here and in the description; don't restore it.
- **The pipeline is immutable — never edit or fork it.** One pipeline, two encodings: the canonical `task-review.workflow.js`, and the prose Steps 0–9 in `references/prose-pipeline.md`. Run the workflow *only* from the canonical path — a `PreToolUse` hook blocks forked invocations, and on the prose path (which the hook can't reach) the immutability is on you. **The two encodings must change together**; editing one silently makes the engines diverge.
- **The build invariant is GREEN, and it is never relaxed.** A red build — **including a `main` that was already red** — STOPS the routine and is surfaced. Never tolerate known failures, never add an "expected to fail" allowance, never touch out-of-scope tests to force green. The build→fix loop only fixes failures *this turn's change caused*.
- **Real tools only.** Every step named after a tool runs that actual tool. If it can't, stop and say so; never substitute an LLM prompt that imitates a scanner, reviewer, or build.
- **Missing prerequisite → STOP, don't skip.** *Genuinely absent* means blocked (none of `/r:code-scan`'s analyzers installed; Codex CLI missing, `run.sh` exit `3`). Distinct and fine to continue through with a visible note: only *some* analyzers installed, or a tool installed whose run failed transiently (exit `4` — the wrapper already retried).
- **An empty findings list is a claim, not a safe default.** Every report-only track states whether its tool actually **ran**. `ran=false` counts as **blocked**, exactly like a dead track — never as clean. This is the failure the routine is least able to detect and most damaged by.
- **Subagent result = its return value.** That return **is** the completion signal — never poll it, never invent a `.done` file or status marker to watch. A subagent that comes to rest without a usable result is re-dispatched, bounded to **2** re-dispatches, then surfaced as blocked.
- **Tiers scale depth, not integrity.** No tier drops build+tests, `/r:code-scan`, or a real Codex read of the final diff. Routing a risky change to a cheap tier is the failure that matters; routing an ordinary one to `full` is how a tier system stops meaning anything — which is why uncertainty goes to `standard`.
- **UI verification auto-resolves without asking.** It classifies findings by **fix size**: minor ones are fixed inline and re-verified once; ones needing their own development cycle are filed as GitHub issues (HTML report under `.claude/skills/test-app/bugs/` as fallback).
- **CLAUDE.md compaction is unattended but evidence-gated.** `/r:claudemd-compact --auto` runs with no confirmation, but only when CLAUDE.md changed this turn **and** its root exceeds ~200 lines, and it may only delete a rule the codebase proves stale.

## Files

| path | what it is | when to read it |
|---|---|---|
| `task-review.workflow.js` | the canonical pipeline (the `meta.name` inside it keeps the pre-rename spelling — that string is what the guard hook matches) | never by hand — run it via `Workflow` |
| `references/prose-pipeline.md` | Steps 0–9 in full + the non-negotiables verbatim | only on the fallback path (no `Workflow` tool), or when changing the pipeline |
| `scripts/worktree-deploy.sh` | port/container isolation for the UI step across worktrees | called by Steps 8a/8c |
| `scripts/record-run.py` · `scripts/review-stats.py` | the per-run stats row, and reading it back | Step 9c; `review-stats.py` any time you want the measured yield per track |
| `${CLAUDE_PLUGIN_ROOT}/hooks/guard-workflow.py` | `PreToolUse` hook that blocks forked invocations — pack-level, not this skill's | never directly |
| `tests/control-flow.test.mjs` | locks the workflow's control flow (`node --test`) | run it after any change to the pipeline |
