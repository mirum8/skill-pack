---
description: >-
  Run the user's post-task review routine over the current git diff — one pipeline that finds
  everything, fixes it once, and verifies the result: parallel Codex + bug hunters +
  code-quality, one fix phase, build with tests, mandatory `/r:code-scan` static analysis, a
  bounded Codex end-verify of the final diff, and UI/runtime verification when the change touches
  what the app renders — a web page or a terminal UI. Three auto-classified tiers (light /
  standard / full) scale depth only — no tier drops build+tests, `/r:code-scan`, or a real Codex
  read of the final diff. Every step invokes the ACTUAL tool, never an LLM imitation. **This
  routine is NOT automatic.** Invoke it only when `/r:task-run` reaches its review step, or when
  the user explicitly asks — "run the post-task review", "run the post-task checklist", "review
  the diff and fix it", "/r:task-review" (optionally with `--light` / `--standard` / `--full`).
  Never trigger it on your own after an ordinary code change, and never at the end of a regular
  coding session. Auto-detects Maven vs Gradle; skips itself on doc-only / config-only turns.
effort: high
---

# task-review

The single entry point for the user's post-task verification. It runs over the **current git diff** and brings it to a clean, reviewed, building state. Each step invokes a **real** tool — never an LLM pretending to be one. The routine is one place so it can't drift, get reordered, or be half-applied.

The shape is **find everything → fix everything → verify once.** All analysis happens up front in one parallel pass, all fixes in one phase, and a single bounded end-verify at the close re-checks the code the fixes/refactor/scan wrote — so nothing the routine itself changed ships unreviewed, without a full re-review after every step.

**What the end-verify may write is fenced.** It is the only correctness track whose findings reach a fixer with no independent triage between them — it adjudicates itself — and it is at the same time the last write to the diff, which nothing downstream re-reads. So it applies **only findings sized as a small, low-risk fix**; a major or untagged one is reported to you and the code is left alone, and pass 2 reports rather than fixes, since nothing re-reads a pass-2 fix. A withheld finding keeps the verdict at `findings-unresolved` — outstanding is outstanding whether or not anyone attempted it.

**What runs off the critical path.** Two things are dispatched early or in parallel because nothing waits on them: the docker image **pre-warm** starts at Triage (it builds without starting anything, so it can only ever be a warm cache); and the **end-verify and the UI verification run together**, since one reads the git diff and the other drives a browser against a deployed image. Guard on the last: if an end-verify fixer lands in a frontend file, the UI halves re-deploy and re-verify once, because what they looked at is then stale.

## How this runs — a deterministic Workflow in the main thread, and nothing else

**One definition and one engine.** The graph of Steps 0–9 is `task-review.workflow.js`, and it runs only as a `Workflow`. When you can reach the `Workflow` tool (a direct `/r:task-review`, or a `/r:task-run` you invoked yourself in the main thread), run the pipeline as the script — do not hand-execute the steps:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/task-review/task-review.workflow.js",
           args: { packRoot: "${CLAUDE_PLUGIN_ROOT}" } })
```

**Run that canonical path verbatim — never a copy, never an edited fork, never an inline review script.** The pipeline is immutable on purpose (see the first non-negotiable); a `PreToolUse` guard hook (the pack's `hooks/guard-workflow.py`) blocks any forked invocation, so a run that seems to need different behaviour is a STOP-and-surface, not a reason to fork.

The script encodes the graph as real control flow: a subagent's returned value **is** its completion signal (nothing to poll, no invented `.done`/output-file), a dead/stalled subagent is re-dispatched in a bounded loop then surfaced, the build and end-verify loops are hard-capped, the UI teardown runs in a `finally`, and a failed `/r:code-scan` is treated as not-clean.

Run the pipeline on **every** invocation — there is no "skip the review for small diffs." Cheap turns stay cheap because **Step 0 / Phase 0 (Triage)** gates *inside* the graph: a doc/config-only diff returns immediately, and the rest are sorted into three tiers that scale how much of the up-front fan-out runs. Static analysis is not part of that gating — `/r:code-scan` is mandatory in every tier.

**Without the `Workflow` tool, STOP.** The `Workflow` tool exists **only in the main thread**; no subagent has it, not even a `*`-tools `general-purpose` one. There is deliberately no prose fallback to run the steps by hand: the store recorded 65 workflow invocations of this review against 0 prose runs, and a second encoding of a 3,000-line graph is a lockstep tax paid on every edit for an engine nothing ever chose. This pipeline is a fan-out — Codex, the hunters, `/r:code-quality`, the fixers, the build runner, the UI verifier — and only the main thread, through a `Workflow` script, can spawn it, so a review nested inside a subagent reaches no engine at all. Check, don't assume: `ToolSearch` cannot answer it (only deferred tools are indexed) and only a real call is evidence; nested spawning may return in a later release. **Do not** improvise a single-context skim and report it as a review — that is the "never fake a scan" line this skill exists to hold. Say plainly that the deterministic review isn't available in this context and that the user should re-run from a top-level session, and stop.

Well-designed callers never land there: a direct `/r:task-run` runs in the main thread, and `/r:issues-fix` runs **both** halves — the implement workflow and this review — as Workflows from its own main thread.

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

`taskIntent` is threaded into every fix subagent so it doesn't "fix" (undo) something intentional; `/r:task-run` passes it automatically. When omitted, Triage infers it from the diff and any `.task-plans/*.md` plan file.

**Leave `profile` out unless the user forced it.** Phase 0 classifies from the diff, which is better evidence than anything a caller can supply before the code exists — `/r:task-run` passes a tier only when the user asked for one, so a task that *sounded* risky but landed as four lines gets reviewed as four lines.

## The three tiers

The tier scales **depth**, never integrity. Phase 0 picks it from the diff by three questions, in order:

1. Can the change alter behavior for any real input? No → **light** (a getter, a constant, a log message, a rename, formatting, a comment, a cosmetic CSS tweak).
2. Does it carry a design decision — a new or changed approach, several seams, a data model or contract — or touch auth/permissions, money/pricing/tax math, persistence (a schema change, migration or index; locking or transaction semantics), concurrency/locking, or security-sensitive code? No → **standard** (a bug fix inside one method, a null check, a new field plus its mapping, a new endpoint over an existing service, a new read-only query over an existing table).
3. Otherwise → **full**.

**Read the persistence arm narrowly** — schema, migration, index, locking; what a revert can't undo. An ordinary read-only query or a repository method over an existing table is `standard`. Counting every query sends every feature in a JPA/ORM diff to `full`, and contradicts `standard`'s own examples.

**When unsure, answer `standard`.** Scary wording alone doesn't force `full` (a copyright-year bump in a payment template is light); "small" alone doesn't earn `light` (a one-line auth-role change is full).

| | light | standard | full |
|---|---|---|---|
| up-front Codex | – | `--mode review` | **adversarial**, or `--mode review` when `planReviewed` |
| `logic` hunter (business logic, broken flows; injection, authz, secrets, data exposure) | – | – | ✅ |
| `runtime-and-failures` hunter (concurrency, data, N+1, silent failures) | – | – | ✅ *if the diff has runtime surface* |
| `/r:code-quality` (readability) | – | – | ✅ |
| build + tests | ✅ | ✅ | ✅ |
| `/r:code-scan` static analysis | ✅ | ✅ | ✅ |
| Codex end-verify of the **final** diff | ✅ | ✅ | ✅ *(regression-only)* |
| UI / runtime verification | *iff* `uiTouched` | *iff* `uiTouched` | *iff* `uiTouched` |

**Spend depth where judgement happens.** This skill's frontmatter sets `effort: high`, which every subagent would otherwise inherit — including ones whose whole job is running a shell command. The workflow tiers the fan-out instead, by one test: **"does this agent decide anything?"** — a wrapper around a tool that decides for it does not, nor does a fixer whose finding someone else already judged real. So the pre-warm, teardown, stats sink and issue-filer run at `low`; the build runners, UI deploy, Phase 0 triage and both Codex tracks at `medium` (Codex reviews, the agent shells out and parses). The three fixers — `fix-correctness`, `end-verify-fix`, `ui-fix-minor` — are not pinned: their provider, model and effort come from `steps.fix` in the config, resolved by the workflow itself, and on `provider: codex` they drive the Codex CLI while the tier shown here is the Claude subagent driving it. The setting is held to the rule a pin encodes: never deeper than the implementers whose code they patch. The readability refactor is not one of them — it invokes `/r:code-refactor`. The inherited depth goes to what forms an opinion nothing downstream re-forms: `r:code-quality`, the fix-triage that decides what is a false positive, `/r:code-scan`'s triage of its own findings, and the readability refactor. The two pattern hunters and the two UI halves sit there too, but **pinned** rather than inherited, and the pin is load-bearing even where the number matches: **the frontmatter only applies when this skill is entered through the Skill tool.** Called by `scriptPath` — which `/r:issues-fix` does for every group — nothing sets it, and an unpinned agent silently takes the *session's* effort. Pinning makes the review's depth a property of the pipeline, not of how it was invoked.

**And spend fewer turns where nothing is being judged.** The other axis is how much a subagent reads before it starts. The hunters are the review's largest line item, and across ~380 measured runs the cost is not the reasoning — the median hunt takes ~49 turns and grows to ~93k tokens of context, most of it whole source files opened *before the diff is*. Three things hold that down without retiring a track or narrowing what gets reviewed. Both pattern hunters run on `r:bug-hunter-pattern`, a four-tool sweep agent, rather than the single-bug investigator whose reproduce-first persona pulls a sweep into a deep read. Every hunter's brief orders the hunt — change first, judge from the hunk, open source only for a candidate it can't settle — with a ~12-call budget it must *report* overrunning or falling short of. And the diff is captured once, after triage, so N hunters read one file instead of each deriving its own, which also stops them reviewing three different changesets. And the runtime hunter carries a per-diff gate — `runtimeSurface`, fail-open — so a diff with no hunk its patterns can match doesn't pay for the hunt at all. Security has no hunter of its own: the `logic` hunter reads `security.md` beside `logic-and-flow.md`, because a separate security context measured 3 fixes over 79 dispatches and owned both recorded scope drifts, while every boundary-validation hunk it matched the logic patterns matched too.

**Model tiers run the other way too, where an agent is cheap by default but one of its calls is not.** The build-runner agents (`r:maven-build-runner`, `r:gradle-build-runner`) are `haiku`, which fits nearly every dispatch: run one command and report `BUILD SUCCESSFUL`. The *classifying* build call steps up to `sonnet`, because on a red build it splits failures into in-scope and pre-existing, and that split is load-bearing both ways: wrongly "pre-existing" halts the run on a failure the fix phase should have taken, wrongly "in-scope" sends a fixer to edit somebody else's failing test. The post-scan rebuild has nothing to classify — the tree was green before it, so any failure is in-scope by construction — but stays on `sonnet` too, because it still decides green vs red, and that verdict halts the run outright with no tier above it to disagree. Which is why every build prompt names the deciding rule: **judge from the exit code, never from the log text.** The incremental commands are `-q`, so a green build prints no `BUILD SUCCESS` line and does print `[ERROR]` lines — failure-path tests, and Surefire's `going to kill self fork JVM` shutdown notice — and an agent grepping for the first while seeing the second calls a finished, green diff red.

## Non-negotiables

These govern the pipeline:

- **This routine never fires on its own — but it is reachable.** It runs on an explicit `/r:task-review`, or when `/r:task-run` reaches its review step and invokes it through the Skill tool. It does **not** run because a coding turn ended, a build went green, or a diff looked reviewable. The rule is held **here and in the description, never in frontmatter**: `disable-model-invocation: true` cannot tell an auto-load from a deliberate call, so it also blocks `/r:task-run`'s mandatory Step 5. Don't add it.
- **The pipeline is immutable — never edit or fork it.** One pipeline, one encoding: the canonical `task-review.workflow.js`. Run it *only* from the canonical path — a `PreToolUse` hook blocks forked invocations.
- **The build invariant is GREEN, and it is never relaxed.** A red build — **including a `main` that was already red** — STOPS the routine and is surfaced. Never tolerate known failures, never add an "expected to fail" allowance, never touch out-of-scope tests to force green. The build→fix loop only fixes failures *this turn's change caused*.
- **Real tools only.** Every step named after a tool runs that actual tool; if it can't, stop and say so. Never substitute an LLM prompt that imitates a scanner, reviewer, or build.
- **Missing prerequisite → STOP, don't skip.** *Genuinely absent* means blocked (none of `/r:code-scan`'s analyzers installed; Codex CLI missing, `run.sh` exit `3`). Distinct and fine to continue through with a visible note: only *some* analyzers installed, or a tool installed whose run failed transiently (exit `4` — the wrapper already retried).
- **An empty findings list is a claim, not a safe default.** Every report-only track states whether its tool actually **ran**. `ran=false` counts as **blocked**, exactly like a dead track — never as clean.
- **Subagent result = its return value.** That return **is** the completion signal — never poll it, never invent a `.done` file or status marker. A subagent that comes to rest without a usable result is re-dispatched, bounded to **2** re-dispatches, then surfaced as blocked.
- **Tiers scale depth, not integrity.** No tier drops build+tests, `/r:code-scan`, or a real Codex read of the final diff. Routing a risky change to a cheap tier is the failure that matters; routing an ordinary one to `full` is how a tier system stops meaning anything — which is why uncertainty goes to `standard`.
- **The UI step verifies whatever `/test-app` declares it drives.** Its surface is READ off that skill's own marker line — `web`, `tui` or `cli` — never inferred from this repo's file extensions, and never forced by a caller, who cannot know better than the file on disk. The surface decides *how* the step runs, never *whether* — that stays `uiTouched` in every tier.
- **UI verification auto-resolves without asking.** It classifies findings by **fix size**: minor ones are fixed inline and re-verified once; ones needing their own development cycle are appended to `issues/ui-review-<date>.md` as unticked backlog items, which `/r:issues-fix` reads directly. That filing is a local write, never `gh` — an agent told to publish tickets under the user's identity is stopped by the safety classifier before its first tool call, and the finding is lost.
- **CLAUDE.md compaction is unattended but evidence-gated.** `/r:claudemd-compact --auto` runs with no confirmation, but only when CLAUDE.md changed this turn **and** its root exceeds ~200 lines, and it may only delete a rule the codebase proves stale.

## Files

| path | what it is | when to read it |
|---|---|---|
| `task-review.workflow.js` | the canonical pipeline (its `meta.name` is `'post-task-review'`; the guard hook and the stats hook match that string) | never by hand — run it via `Workflow` |
| `scripts/worktree-deploy.sh` | port/container isolation for the UI step across worktrees | called by Steps 8a/8c on a **web** surface |
| `${CLAUDE_PLUGIN_ROOT}/skills/test-app-create/scripts/tui-session.sh` | the real terminal a TUI's verification is driven through | called by Steps 8a/8c on a **terminal** surface |
| `${CLAUDE_PLUGIN_ROOT}/lib/record-run.py` · `${CLAUDE_PLUGIN_ROOT}/lib/skill-stats.py` | the per-run stats row, and reading it back — pack-level, shared with every other skill | Step 9c; `skill-stats.py --review` any time you want the measured yield per track |
| `${CLAUDE_PLUGIN_ROOT}/hooks/guard-workflow.py` | `PreToolUse` hook that blocks forked invocations — pack-level, not this skill's | never directly |
| `tests/control-flow.test.mjs` | locks the workflow's control flow (`node --test`) | run it after any change to the pipeline |
