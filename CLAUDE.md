# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

The source of `r`, a **skills-directory plugin** for Claude Code: 22 skills (`/r:<name>`) and the
8 agents they dispatch. There is no application here — the "product" is prose (`SKILL.md`),
workflow scripts, agent definitions and a hook, all loaded by Claude Code itself.

**Load the `skill-creator` skill before you touch anything here.** Every file in this repo is a
skill, an agent or the machinery that loads them, so `skill-creator` is the reference for the
format the loader actually reads — frontmatter fields and their effects, description and trigger
wording, directory layout, evals. Load it at the start of any session that edits this pack, not
just when creating a skill from scratch: an edit to a `description`, a new `SKILL.md`, a
frontmatter flag or an `evals.json` is exactly the work it covers, and getting those wrong fails
silently — a skill that never routes, or a flag that quietly removes it from the router's context.
The pack's own rules below win where the two disagree; `skill-creator` is the format, this file is
the policy.

**The repo and the installed pack are two separate copies.** `install.sh` copies, it does not
symlink. Edit here → run `./install.sh` to publish into `~/.claude/skills/r`. A `SKILL.md` edit is
live once copied; `agents/`, `hooks/` or `.mcp.json` changes need `/reload-plugins`, and plugin
*discovery* only happens at session start. "The change did nothing" is almost always an unpublished
edit or an unrestarted session.

## Commands

```sh
./validate.sh                      # THE gate — run before every push (there is no CI)
SKIP_INSTALL_TEST=1 ./validate.sh  # same, minus the ~9s installer suite
./install.sh                       # publish repo edits; --dry-run, --no-deps
./check-prereqs.sh                 # are the mandatory external tools present here?
```

Individual pieces of `validate.sh`, for iterating:

```sh
python3 tools/validate.py                                  # static checks only
node --test skills/task-run/tests/control-flow.test.mjs    # one workflow's branches
node --test skills/task-review/tests/control-flow.test.mjs
bash skills/spec-design/tests/check_todo.test.sh            # the plan graph
bash skills/spec-brainstorm/tests/check_spec.test.sh        # the spec gate
bash skills/reuse-index/tests/reuse-index.test.sh           # corpus → candidates → diff
bash skills/code-scan/tests/local-scan.test.sh              # scoping + the fail-closed contract
bash skills/code-adversarial/tests/run.test.sh              # the Codex wrapper's exit codes
bash skills/task-review/tests/worktree-deploy.test.sh       # main-vs-worktree + compose isolation
bash skills/test-app-create/tests/tui-session.test.sh       # the TUI driver's fail-closed contract
bash skills/plan-report/tests/milestone_scope.test.sh       # milestone scope + the boundary predicate
bash hooks/tests/guard.test.sh                             # workflow-guard behaviour
bash lib/tests/stats.test.sh                               # stats sink + hook + reporter
bash tests/install.test.sh                                 # installer behaviour
claude plugin validate .                                   # the loader's own view of the pack
claude --plugin-dir "$PWD"                                 # load the pack without installing it
```

`tools/build-pack.py` is a **one-shot historical build** that wipes `skills/` and `agents/` and
regenerates them from flat originals under `~/.claude`. Those originals were deleted on
2026-07-31. Do not run it.

**The repo is the copy to edit, and `install.sh` is what makes it the only copy.** Pre-pack
originals under their old flat names (`post-task-review`, `run-task`, `find-bugs`, …) may still be
installed in `~/.claude/skills/` and `~/.agents/skills/`; while one survives, R-4 is open — an edit
lands in the wrong copy, where it works under the old name and is missing under the new one, and
the old bare name still answers with the old behaviour. `install.sh` retires them from both roots
(`--keep-originals` opts out) and `validate.sh` names whatever is left on every run. The roots and
the names both come from `tools/rename_rules.py`, so a skill added to the pack is retired by that
one edit. `RETIRED_PACKED` in the same table covers the other half — a *packed* name dropped by a
later rename (`spec-plan` → `spec-design`). `rsync --delete` clears it from the pack root but never
from the flat roots, where a copy sitting beside the pack keeps answering the old name with the old
behaviour; `validate.py` additionally fails if any packed text still mentions a retired name. Until you have re-run the installer, check which path you are in before editing anything
that exists under both names.

Eval suites (`skills/*/evals/evals.json`) need a model, so they are not part of `validate.sh`:
`python3 tools/run-evals.py` runs them (`--dry-run` first; `--skill <name>` to focus). It scores only
the two mechanical case kinds and names everything it skips — a behaviour case needs its fixture and
a judge, and a `disable-model-invocation` skill's cases are untestable by design. Run it after
editing any `description`, and before a release.

**Read its output before believing it.** A sweep in an empty scratch directory cannot tell "the
description drifted" from "the prompt named a codebase that wasn't there", and a result where every
trigger fails and every exclusion passes means the instrument never fired, not that the pack broke.
The runner redirects `CLAUDE_SKILL_STATS_DB` to a throwaway so a sweep never writes synthetic
`invoke` rows into the store the convention below says to read.

## Layout and what ships

```
.claude-plugin/plugin.json   identity + namespace (name must stay "r")
skills/<name>/SKILL.md       the skill; plus references/ scripts/ tests/ evals/
agents/<name>.md             the 8 agents skills dispatch to
hooks/                       hooks.json + guard-workflow.py + record-skill-run.py
lib/                         pack-wide stats sink + reporter + config reader, shared by every skill
.config/defaults.yaml        the shipped settings; a project overrides them in its own .config/
tools/                       build/validation scripts — NOT shipped
tests/, validate.sh          repo-level test + gate — NOT shipped
docs/skill-pack-repo/        spec.html, architecture.html, interview notes — NOT shipped
```

`install.sh` copies exactly `.claude-plugin/ .config/ skills/ agents/ hooks/ lib/ check-prereqs.sh`.
Anything a skill needs at run time must live under one of those.

## Architecture

**Skills are prose; the two pipelines are code.** `task-run` (implement half) and `task-review` are
`*.workflow.js` scripts run through the `Workflow` tool. The reason is structural: since Claude Code
2.1.217 subagents have no `Agent` tool, so a fan-out nested inside a subagent silently collapses to
a single context and still reports success. A `Workflow` script runs in the main thread and spawns
every agent itself, so the caller keeps the real fan-out and a clean context. Both scripts document
this at the top; keep it true.

`task-run-implement.workflow.js` is the **single encoding** of Steps 0–4 — `SKILL.md` delegates to
it and must not restate the graph. `task-review` deliberately carries two engines (the script plus
`references/prose-pipeline.md`) and pays a lockstep tax; changing one means changing the other.

`task-quick` is the third pipeline and is deliberately **not** code: implement → review → verify →
fix, run inline in the main thread with no `Workflow` and no subagents. There is no fan-out to lose,
so orchestration would buy nothing and cost a round trip and a context re-read per step; the trade
is that everything it reads stays in the caller's context, which is why the skill keeps telling the
reader to target its reading. It earns its place by what it leaves out — no planning phase, no
explorers, no hunters, no `/r:code-scan`, no UI pass, no branch, no PR, no commit, no plan file —
against a `task-run` whose `implement` step alone measures 88 runs / 1.69B tokens / 963s per agent
before the review that follows adds another 258 hunter dispatches. Two things carry its weight and
must not be softened: the review is the REAL Codex reviewer (a run that could not reach it reports
an unreviewed change, never a clean one), and every finding is VERIFIED against the code before
anything is fixed — confirmed or dismissed, each with a reason, and only the confirmed ones fixed.
Its findings are recorded under their own `quick-codex` track: same tool as `task-review`'s `codex`,
different mode and a much smaller change under it, so merging them would make neither readable.

**Every bundled executable has a test, and it is the only one it gets.** The two workflows have
their control-flow tests below; all eleven scripts under `skills/*/scripts/` have suites beside them.
They all guard the same failure shape, which is why none of them is optional: each script either
*decides a scope*, *decides whether a tool ran*, or *decides whether the app is on the screen at
all*, and every one of those fails by returning a confident wrong answer. A scan that resolved to
the wrong files, a review wrapper that banked a missing plugin as clean, a worktree stack that
reused the main one's ports and container names, an empty terminal capture read as a clean screen,
a CLI misread as a TUI so the wrong template pair is written for a whole generated skill — every
one of those leaves a green pipeline behind it, so a passing run is not evidence and the suite is.

`plan-run/scripts/cmux-fanout.sh` is the newest, and `issues-fix` drives it too — one protocol, one
script, reached across skills as `${CLAUDE_PLUGIN_ROOT}/skills/plan-run/scripts/`, the same way
`test-app-create`'s generated skills reach `task-review/scripts/worktree-deploy.sh`. It exists as
code for the usual reason: `--cmux` gives each unit a **full interactive `claude` session**, which
never exits and yields no status, so completion is *reported* rather than observed. Reading a
terminal to decide whether an agent finished is exactly the confident-wrong-answer shape, so a unit
is done only when its own sentinel **and** the marker on its branch agree — neither alone, because a
sentinel can be written by a run that then failed to commit, and a missing marker can just mean the
unit is still working. The cap is `steps.fanout.maxUnits` in the config, resolved by the script
rather than by either SKILL.md, so a caller cannot forget it and there is one place to change it —
one setting, not one per skill, since both drive the same script. It defaults to 3, and the script
refuses to run uncapped: an empty or non-numeric value falls back to 3 and is named, because the
comparison is `-ge` and a blank cap would let every spawn through.

Under `--cmux` **every** unit gets a workspace, a wave of one included — a wave decides how many run
at once, never whether a session opens, and the orchestrator builds nothing itself. A unit running
alone is landed **before the next worktree is cut**, because `git worktree add --detach` pins a tree
to the base it was created from and a queue of solo spawns with no merge between them is a
concurrent wave wearing a queue. The window rolls on `wait --any`, not `wait`: the bare form blocks
until every unit in the set has reported, which holds all three slots until the slowest finishes,
so a queued unit waits behind one that came back an hour ago. `--any` hands each verdict back
**once** — a failed unit is required to be left standing, so it keeps its slot and stays live, and
without the once-only rule every later call would re-report that failure while its wave-mates
finished unseen. The script tracks that rather than asking the caller to narrow the set by hand,
for the reason everything else here is in the script: a judgement that fails by looping silently is
not one to leave to a model reading a screen.

**The milestone report is written after the merge, as its own commit — never folded into a phase's.**
`plan-run`'s boundary check dispatches `plan-report` when a `## Milestone N`'s last leaf lands, and
the placement is forced rather than chosen. The report describes *merged* code, so it cannot be
written before the merge; the phase's commit is sealed one step earlier so that "built" and "ticked"
revert together; and a report written onto a phase branch would work serially and be impossible
under `--cmux`, where a unit's wave-mates land later from another tree and no unit can know its
milestone finished. So it takes the slot the reuse-index refresh already occupies — primary tree,
after the last merge, own commit. Which phases a milestone holds and whether it is done come from
`plan-report/scripts/milestone_scope.py`, never from reading the markdown: a report scoped to the
wrong phases still renders, and a milestone called complete one phase early still produces a
document that reads as authoritative. And a report that cannot be written is a **named skip**, never
a halt — the milestone's code is already merged, and no plan should stop over a document. That makes
three numbers necessary rather than one, because a missing report has three causes needing opposite
fixes: `milestonesInPlan: 0` is a plan that owed none, `milestoneReports: 0` under a non-zero
`milestonesInPlan` is a run that finished no milestone, and only `reportsSkipped` is a failure.

**Every workflow edit needs its control-flow test.** `tests/control-flow.test.mjs` executes the
script with `agent()`/`parallel()`/`phase()`/`log()` stubbed and asserts the branches — what stops
the run, what is retried, what reaches the handoff. It models both agent death shapes: `agent()`
resolving to `null`, and `agent()` throwing.

**The workflow guard** (`hooks/guard-workflow.py`, registered as a `PreToolUse` hook on
`Workflow|Write|Edit`) makes both pipelines immutable: a fork cannot be run or written, whether as a
`scriptPath`, an inline script, or a `Write`/`Edit` creating one. Editing a canonical file is
allowed. Its allow-list is built at run time from `$CLAUDE_PLUGIN_ROOT`, and it matches only real
workflow scripts (`export const meta` + a guarded `name`), so prose quoting a pipeline name is left
alone. It fails open on any parse/IO trouble.

**The stats store measures the pack.** `lib/record-run.py` writes into `~/.claude/skill-stats.db`
(SQLite/WAL, schema in `lib/schema.sql`); `lib/skill-stats.py` reads it back. It lives in `lib/`,
not in a skill's `scripts/`, because every skill writes to it — a shared store owned by one skill
stays that skill's store. Rules that are load-bearing:

- **A skill records an outcome when it owns a run, and only then.** Fourteen skills write a
  `result` row; `r:tests-write` and `r:hexagonal-architecture` write none, and that is correct
  rather than a gap to close. Both are consulted *inside* someone else's task — `tests-write` shapes
  tests another skill is writing, `hexagonal-architecture` answers where a class goes — so neither
  has a boundary to report an outcome at, and whatever they influenced belongs to the run that
  loaded them. The hook still counts their invocations, which is the honest measure available:
  `r:tests-write` is the most-invoked skill in the pack at 41 runs. Giving them a fabricated
  outcome row would put a number in the store that no question can be asked of, which is worse
  than the gap.
- **Runs come from `invoke` rows only.** One run produces both an `invoke` row (hook) and a
  `result` row (the skill), so counting both doubles every number. `session_id` joins them.
- **`findings.verdict` is the point.** A track whose findings triage rejects scores the same zero
  in `fixedBySource` as a track that finds nothing, so both pipelines record what they *dismissed*.
  A blocked triage records no verdicts at all — absence of a judgement is not a judgement of zero.
  The inverse is just as wrong and is the easier mistake to make: a **blockage must never be
  recorded as a finding**. A UI half handed no field for "I could not run" writes the blockage into
  `findings`, where it is dispatched to a fixer as work and stored as `confirmed`/`fixed` — which is
  why the store's only `ui-functional` row is a blocked track reading as 100% precision.
  Every report-only track therefore gets its own channel for that (`blockedReason`, `coverage`),
  and `fixed` is derived from the fixer returning, never from a finding's own size tag.
- **The end-verify is fenced, because it is the one track with no reader on either side.** Every
  other correctness finding is adjudicated by `task-review`'s triage; this pass adjudicates its
  own, and it is simultaneously the LAST write to the diff — nothing downstream re-reads what its
  fixer does. Below `full` its framing invites the reviewer to challenge the whole change rather
  than only regressions, so unfenced, the last agent to touch the code can rewrite what the change
  was for. Two fences, both in the script and asserted in `control-flow.test.mjs`: it applies only
  findings the reviewer sized `fixSize: minor` **by the size and risk of the fix, never by
  severity** — a major or *untagged* one is surfaced and the code left alone, the same split the UI
  track makes — and **pass 2 reports rather than fixes**, since a pass-2 fix is the one nothing
  re-reads and the verdict is `findings-unresolved` either way (~4.01M tokens and 424s per fixer
  over the 14 recorded runs that reached it, for no caller-visible signal). A withheld finding must
  keep the verdict off `passed`: outstanding is outstanding whether or not anyone attempted it.
  `real` unmarked means REAL and `fixSize` unmarked means MAJOR — both fail toward surfacing, never
  toward silently acting. And because nothing else judges this track, **both sides of its own
  adjudication are recorded** — what it kept and what it rejected. Recording only the remainder is
  what made it read as never wrong: 18 rows, every one `confirmed`, while the same wrapper under
  triage runs 29 confirmed against 24 dismissed.
- **A track fails to certify in two ways, and they need opposite fixes.** `tracksBlocked` is a tool
  that did not run; `tracksDrifted` is a tool that ran, returned a real report, and read a
  *different changeset* — a hunter whose prepared diff capture was missing derives the change
  itself and can resolve somewhere else. Equally disqualifying — `issues-fix`'s
  merge gate reads both — but a blocked tool has to be made to run while a drifted one has to be
  made to read the right thing, and re-running a drifted track unchanged just reproduces the same
  clean report about the same wrong diff. Both also subtract from a track's denominator in
  `skill-stats.py`: a track that never saw this diff had no opportunity to find anything in it.
- **`items` is mined, never recorded.** Claude Code persists every workflow run under
  `<session>/subagents/workflows/wf_*/`; `--mine-items` reads the prompts, results, models, tokens
  and timestamps from there, so the pipelines pay nothing at run time. They could not do it
  themselves anyway — `Date.now()` is unavailable inside a `Workflow` script.
- **Planning is not the cheap half, and it is bucketed on what the run RECORDED.** Per run that
  reaches a plan: judges 11.0M tokens, planner 10.3M, explorers 7.5M, plan-fix 3.9M, ~39M in all
  against the implementers' 33.1M, and ~97% of it cache reads rather than output. `plan depth` in
  `skill-stats.py` asks of it what `implement depth` asks of the write side, and prints the paired
  review's correctness fixes beside each bucket for the same reason. It buckets on `planModel`/
  `planEffort` in the run payload and **never on the items**: a subagent reports the tier it
  resolved to, not the one it was dispatched with, which is why the planner's items read xhigh
  under a row that asks for high. Runs made before that field existed are named `unrecorded`
  rather than folded into a tier they may not have run at.
- **Two instruments triage the plan review, and `findings.category` is which one.** A finding from
  a rubric the store measures at ~91% (grounding, test-adequacy, ui-design) that names a `file:LINE`
  gets a haiku LOOKUP against that line; coverage, risk, simplicity and anything without a usable
  citation get a full judge. The two cost two orders of magnitude apart, so one precision number
  over both describes neither — `plan triage by lane` reads them apart, and rows written before the
  lanes existed print as `<pre-lane>` rather than being folded into the judge column they would
  otherwise inflate. A citation lane materially below the judge lane on the same rubric is the
  wrong lane for that rubric: move it back, rather than tuning its prompt. The lane only ever
  routes work AWAY from itself — no citation means no lane, an unresolvable reference escalates to
  a judge in the same pass, and a dead reader leaves its findings unjudged.
- **The step label is recovered from the prompt**, by matching it against the literal chunks of
  each `agent()` dispatch in the shipped workflow scripts — `agentType` is persisted but `label`
  is not, and one type covers many steps. Read from the scripts, never a table here, so a reworded
  prompt updates the mapping with the wording; an unmatched prompt stays **unlabelled** and is
  counted as such, because a wrong step name is averaged in silently while a gap is visible.
  All four shapes a prompt is dispatched in are read — the literal passed to the call, the
  `prompt:` beside its `label:` in a table of tracks, the literal under a builder the call passes
  by name, and a builder chosen by a ternary (`agent(cond ? citePrompt(b) : judgePrompt(b),
  { label })`, where `label` is that same condition picking between two step names). The ternary's
  branches are paired by the CONDITION TEXT, never by position: two ternaries that merely sit near
  each other say nothing about each other. A shape that goes unread costs its step every run it
  ever made — the plan review's two triage lanes recorded nothing at all under the ternary shape,
  and the report read `cited% 0%` as though the cheap lane never fired.
  **Reading the scripts means tokenising them**, which is the same failure one level down: a regex
  literal carries quotes and backticks as ordinary characters, so a scanner with no notion of one
  reads `/([^\s:()[\]<>"'`,]+)/` as an opening quote and swallows every prompt up to the next —
  8.5KB of `task-run-implement.workflow.js`, taking `cite` and `judge` with it. Division must still
  divide; the `/` is decided by the token before it. `implement` is the most expensive step in the
  pipeline at 2.15B tokens and `judge` the third at 607M, and neither number was readable while
  those two shapes went unread. A chunk two steps share names neither.
  **A `label:` is often computed, and only its BRANCHES name steps — never its condition.**
  `label: step === 'implement' ? 'config' : \`config-${step}\`` read as "the first string in the
  value" awards the config reader to `implement`: 25 eleven-second shell-outs banked as
  implementer runs, pulling the pack's most expensive step from 808s to 695s and understating it
  by 14%. So the value is read to the end of its own property, cut at the first top-level `?`, and
  a step awarded only when every branch agrees on one — branches differing by a `-suffix`
  (`'branch'` / `'branch-retry'`) being one step retried, exactly what `_step` already collapses
  for `#`, `$` and `:`. Disagreement leaves it unlabelled, which is the visible failure.
  A stored label is corrected only when it is a step these
  same scripts can write — that one is this classifier's own earlier answer, so a disagreement is
  it having improved; a label outside their vocabulary came from a `--label-source` run over older
  scripts and is left alone.
- **Implementer depth is a claim under measurement, not a default.** The implementers' provider,
  model and effort come from `steps.implement` in the config (below); `IMPL_RUN` in
  `task-run-implement.workflow.js` is the fallback, not the pin. The `implement depth` table is
  what decides whether the configured value holds: it buckets every implement run by the effort
  mined off its items and prints the paired review's yield beside it. The `high` baseline it is
  read against is 2.11 correctness and 3.48 readability fixes per paired review, at 20.9M tokens
  and 1022s per implementer agent — the pack's most expensive step. Read the table before moving
  the default either way, and read both halves: a cheaper implementer that pushes work into
  `fix-correctness` and `end-verify-fix` has moved cost, not saved it. The pairing is positional
  (same repo, the next pipeline-invoked review inside 12h), so it is a strong guess and never a
  recorded fact. The table cannot yet compare **providers** — the mined effort is the *subagent's*,
  and on codex that is the driver's rather than the writer's — which is why the resolved row is
  written into the run payload as `implProvider`/`implModel`/`implEffort`. The shipped default is
  codex/`gpt5.6-sol`/`medium`, driven by a haiku/medium wrapper, and it cannot agree with
  `IMPL_RUN`: that fallback is claude/`opus`/`medium` and has no provider to set, so a codex row is
  unmirrorable there by construction. The workflow names the substitution in its log instead, which
  is what keeps an unreachable config visible rather than a silent tier change. `medium` is the
  thin half of that table — 4 runs against `high`'s 42, and none of them codex — so it is a
  direction under measurement, not a settled answer.
- **The fixers are configured the same way, on the same provider as the implementers.**
  `steps.fix` governs the three fixers in `task-review` — `fix-correctness`, `end-verify-fix`,
  `ui-fix-minor` — with the same five keys; `FIX_RUN` is their fallback. Not the readability
  refactor, which invokes `/r:code-refactor` and would have nothing to hand a CLI. They are the
  pack's second-largest write-side block (595M + 493M + 238M tokens), and the shipped row is
  codex/`gpt5.6-sol`/`low` — the least-measured value in the pack, with no Codex fixer run yet.
  Two consequences to hold onto. A fixer must never run **deeper** than the implementer whose code
  it patches, and nothing enforces that across two independent rows — `task-review` does not read
  `steps.implement`, and a silent clamp would override a value the user can see in their own file.
  And the shipped pair puts writer and fixer on the same provider, which is the one-writer rule
  met rather than worked around — Codex writes the change and Codex patches it, shallower, because
  a fixer's brief is one finding at one line. `fixProvider`/`fixModel`/`fixEffort` go into the review's payload so the
  question can eventually be answered from rows rather than argued.
- **On codex the writer and the wrapper are separate settings, because they fail differently.**
  `model`/`effort` reach the Codex CLI; `wrapperModel`/`wrapperEffort` (`haiku`/`medium`, fallback
  `IMPL_CODEX_RUN` in `task-run`, `FIX_CODEX_RUN` in `task-review`) are the Claude subagent that
  drives it, collects a run past the ~600s Bash cap and reads the working tree to report what
  landed. A cheap *writer* writes worse code, which the review catches; a cheap *wrapper* gives up
  on the collect and halts the run — or reports a fix Codex applied as unfixed — over work that was
  actually finished, which nothing catches. Each wrapper carries its own constant rather than the
  pipeline's `CODEX_RUN` so tuning it cannot re-tier the plan reviewer or the review tracks that
  share the same shape. On a fixer the wrapper owns one more thing: the edits are Codex's, but a
  rebuild, a redeploy or a re-verify in the brief dispatches other agents, so those stay the
  wrapper's own work.

  **The shipped `haiku` is an experiment under measurement, and it is the direction this row was
  written to warn against.** What makes it worth running is that the failure was never depth: it
  was the wrapper *deciding* a live PID looked stuck. The collect is now ONE blocking shell loop
  (`collect()` in both scripts) bounded below the ~600s cap, so that judgement is not the model's
  any more, and what the wrapper reports comes from `git status --porcelain`/`git diff` rather than
  from Codex's summary. `wrapperEffort` deliberately does NOT follow it down — the tree read at the
  end is real work. A regression looks like blocked slices over a working tree that already holds
  the change (`wf_9c4f981b-d68` is the recorded instance); put it back to `sonnet` if it appears.
- **The Codex REVIEW wrappers are `haiku` too, and they are pinned rather than inherited.**
  `CODEX_RUN` in both scripts — the plan reviewer, the `codex` track, every `end-verify` pass —
  names `haiku`/`medium`. Unnamed, the tier is whatever the caller happens to be running, which is
  not a tier anyone chose: 119 + 143 + 188 dispatches and ~359M tokens, mostly opus, for agents
  that review nothing. Every Codex wrapper in the pack is one tier because they do one job — shell
  out, wait, hand back what the CLI produced.

  **The risk that is specific to these three is worth naming, because it is the one that does not
  announce itself.** The implement and fix wrappers have a working tree to check their answer
  against; a review wrapper has none. The critique *is* the artifact, and the job is marshalling a
  long free-text report into `REVIEW`/`FINDINGS` without dropping or merging findings — which
  nothing downstream catches, since the plan review stops the run outright if Codex cannot run and
  `end-verify` is the last read of the diff. A degradation therefore reads as *fewer findings from
  a track that still reports `ran:true`*, never as an error. Read it in `fixes by source track`:
  `codex` 0.70 fixes/run over 77 runs and `end-verify` 0.88 over 83 are the numbers it would move.
  `medium` stays alongside it — these agents own the background-collect protocol, whose failures
  surface as false "the review could not run" blocks.
- **No fallback store.** A row the db rejects is lost. That is why inserts say
  `ON CONFLICT(<key>) DO NOTHING` and never `INSERT OR IGNORE`, which also swallows a `NOT NULL`
  violation — it hid exactly that bug once.
- **The hook watches *three* routes**, because no one of them sees the others and dropping any
  silently costs that share of the coverage: `PostToolUse`/`Skill` for a model invocation,
  `PostToolUse`/`Workflow` for a pipeline run by its canonical `scriptPath` or workflow `name`,
  and `UserPromptSubmit` for a typed `/r:<name>`. The `Workflow` route is not optional — it is the
  *primary* path for both pipelines, since `issues-fix` drives them by `scriptPath` and forbids the
  Skill route; without it `task-review` had 82 outcome rows against 0 invokes. The routes **chain**
  (a typed `/r:x` also produces a Skill call; a Skill call on either pipeline is followed by that
  skill's markdown dispatching its Workflow), so the hook drops a second sighting of the same
  `(session, skill)` by a *different* route inside 5 minutes — same route twice is two real
  invocations and both are kept. It records only `r:` names, always exits 0 and always prints
  nothing — on `UserPromptSubmit` stdout is injected into the conversation and a non-zero exit
  blocks the prompt.
- `~/.claude/skill-stats.jsonl` is the pre-SQLite archive: read by `--import-jsonl` once, never
  written.

**The config is the pack's one tunable surface.** `lib/read-config.py` resolves one step's settings
from `<repo>/.config/skill-pack.yaml`, then `.config/defaults.yaml` in the pack, then a built-in row
— key by key, so a project file naming `effort` inherits the model rather than resetting it.
`steps.plan`, `steps.implement`, `steps.fix` and `steps.fanout` are read today; later steps drop
in as sibling keys, and `--check` walks every one of them. It sits in
`lib/` for the same reason the stats sink does: every skill will eventually read settings, and a
reader owned by one skill stays that skill's reader. Rules that are load-bearing:

- **It never fails its caller, and it never falls back silently.** A missing file, a malformed
  line, an unknown key and a value outside its enum all resolve to the built-in value and add a
  line to `notes` naming what was substituted and why — and the caller **logs every note**. A
  config that quietly does nothing is indistinguishable from one that works, which is the whole
  failure a settings file invites. `--check` is the one mode that exits non-zero, and it exists so
  `validate.py` cannot ship a defaults file this reader would reject.
- **YAML here is a deliberate subset** — nested mappings, scalar values, comments, optional quotes
  — parsed in-tree so there is no PyYAML dependency and one code path. A line it cannot place
  becomes a note, never a silent drop.
- **`provider: codex` is verified before it is honoured**, at the two paths `check-prereqs.sh`
  already looks in. Absent, the *whole row* falls back to claude/opus/medium: a codex model name
  means nothing to `agent()`, and carrying the codex effort across would re-tier the Claude path by
  accident. All three substitutions are named.
- **`steps.plan` is the planning half, and it is three tiers in one row** — the planner, the
  explorers that map the code for it, and the judges that triage the plan review. One row because
  the three are chosen together: a deeper planner wants shallower judges, not deeper ones. The
  standing rule, documented and not clamped for the same reason `fix` is not clamped against
  `implement`: **the judges must never run deeper than the planner whose plan they check**. It has
  no `provider` key, and that is not an oversight — the planner returns markdown the pipeline copies
  to disk verbatim and the explorers and judges return schema'd objects it branches on, so nothing
  here survives a hand-off to a CLI; `resolve()` skips its codex branch on a provider-less row, and
  the `model` keys carry their own enum instead. The shipped `judgeModel: opus` is the **measured
  status quo**, not a recommendation: 223 judge items in the store, every one opus/high, from when
  the tier was inherited rather than named. A config row cannot express "whatever the caller was
  running", so naming it is what keeps a run that never reached the config indistinguishable from
  one that read the file. Dropping the judges to sonnet is the obvious first experiment, and
  `plan depth` is where its answer shows up.
- **Workflow scripts cannot read it themselves** — no filesystem access — so the pipeline dispatches
  a haiku/low agent that runs the reader and returns its JSON under a schema. That read happens
  **inside** `task-run-implement.workflow.js` and `task-review.workflow.js`, not in either
  `SKILL.md`, because `issues-fix` and `plan-run` come in by `scriptPath` and a markdown read would
  skip them. In the review it sits after the `reviewNeeded` gate, so a doc-only turn pays nothing.
- Its suite is `lib/tests/config.test.sh`, and it is the only one it gets.

**Skills that must never self-trigger** (`task-run`, `task-quick`, `issues-fix`, `plan-run`,
`spec-design`) carry `disable-model-invocation: true` in frontmatter — the enforcement, not just a
sentence in the body. Each of the five mutates the repo or a plan on a scale nobody wants arrived at
by inference, so they are invoked deliberately or not at all. Two consequences follow and are easy
to forget: their descriptions leave the listing budget entirely (they are not in the router's
context), and **no prompt can route to them**, so their own `trigger` eval cases are untestable by
design and their `neighbour-exclusion` cases pass without measuring anything — `tools/run-evals.py`
skips both kinds and says why rather than counting them as passes.

Which is why **FR-11 inverts with the flag**: a flagged skill owes a `behaviour` case, and
`validate.py` fails it for carrying only the two routing kinds. Give one those instead and its whole
suite is skipped — a green gate over nothing measured, which from the outside is indistinguishable
from a suite that passes. So read the case count `run-evals.py` prints, never the one in
`evals.json`.

`task-review` must not self-trigger either, but carries **no** flag: the flag blocks the Skill tool
outright and cannot tell an auto-load from a deliberate call, so it also blocked `task-run`'s
mandatory Step 5 from invoking the review. There the rule lives in the description and the
non-negotiables — don't "fix" it back. `plan-report` is the second unflagged case and the same
trade: `plan-run`'s milestone boundary invokes it through a subagent's Skill tool, which a flag
would block along with the auto-load it was meant to stop.

**Real tools, or a named skip.** The pipelines call `gh`, the real Codex review, real build runners,
`agent-browser`, `tmux`, `code-scan`. Never substitute a model-written prose imitation — a
hand-rolled `expect` wrapper in place of the TUI driver is the newest instance of that temptation,
and it fails open everywhere the driver fails closed. When a tool is missing, the step is recorded
as **skipped** and named, and the run continues. One exception, and it is principled: `tmux` absent
on a project whose generated `/test-app` **declared** a terminal surface is a **blockage**, not a
skip — that declaration is the project opting in, so the terminal is the instrument its verification
needs, exactly as docker is on the web path. A skip there would let `issues-fix`'s merge gate read
"nothing was owed" about a TUI nobody looked at.

The test is whether the thing runs a real binary or a different model — and the bundled
`/security-review` is neither, which is why the security track does NOT call it. It is a markdown
prompt whose diff comes from four bash commands substituted in before the model runs, all pinned
to `git diff origin/HEAD...`, with no argument placeholder anywhere in its body: a scope handed to
it is discarded, and it never sees uncommitted work at all. Measured over 49 dispatches: 47
reports, **0 findings**, and 5 of the 6 that checked reported reviewing a different changeset.
`security` is a `r:bug-hunter-pattern` over `code-bugs/references/security.md`, reading the same
captured diff as every other hunter. Reinstating the skill would re-open the hole, not close one.

## Rules `validate.sh` enforces (edit within them)

- **Paths.** Nothing hard-codes an install location. A skill referencing its own files uses
  `${CLAUDE_SKILL_DIR}`; referencing another skill's files uses
  `${CLAUDE_PLUGIN_ROOT}/skills/<name>`. They are not interchangeable. Neither placeholder is
  substituted inside a `*.workflow.js`, so those take the pack root as `args.packRoot`, passed by
  the invoking `SKILL.md`. No `/Users/<name>/` or `~/.claude/skills/<x>` paths anywhere outside
  `docs/`.
- **Names.** Every packed skill *and every bundled agent* referenced anywhere must carry the `r:`
  prefix — an `agentType` or `subagent_type` value, and the prose that names one. Bare, a bundled
  agent either dispatches a same-named agent outside the pack (different persona, different tools,
  no error) or dies with "agent type not found" and takes that track of the fan-out with it. The
  two exemptions are listed as `FOREIGN_TEXT` in `tools/validate.py`: prose that quotes a *user's*
  CLAUDE.md, where the flat name is what the search has to match. Every skill name a
  body mentions must be packed, bundled with Claude Code, or listed in the README as an external
  prerequisite — anything else is a name the model will try to invoke mid-run and fail to reach.
  New names are domain-first: `<domain>-<action>`, at most three kebab segments.
- **Frontmatter.** Valid YAML, a `description` under 1,536 characters, and the listing cost under
  16,000. That total counts only skills the model can invoke: a `disable-model-invocation: true`
  skill's description is *not in context* (it loads when you invoke it), so billing it buys
  headroom by trimming a description nothing reads. `validate.py` names the excluded skills on
  every run. No two descriptions may open with nearly the same sentence.
- **Structure.** The skill directories are exactly the set `tools/rename_rules.py` names, two
  levels deep — the map is the rule, not a count, and a stale count here reads as an instruction
  to delete a skill. Every bundled agent must be dispatched by some skill. Every skill needs
  `evals/evals.json` with at least one `trigger` case and one `neighbour-exclusion` case —
  unless it sets `disable-model-invocation`, which no prompt can route to, and which owes a
  `behaviour` case instead. A `kind` outside `trigger`/`neighbour-exclusion`/`behaviour` fails:
  `run-evals.py` skips what it cannot recognise, so a typo silently removes the case from the
  sweep. A bundled script is invoked through `${CLAUDE_SKILL_DIR}` or
  `${CLAUDE_PLUGIN_ROOT}/skills/<name>` — a bare `scripts/x.py` resolves against the user's
  project. No build artefacts tracked.

## Conventions

- **Read the stats before changing or fixing anything.** Run `python3 lib/skill-stats.py` first
  and let what it says shape the edit — which skills actually run, which tracks produce fixes,
  which tiers get chosen. Every tier and track decision here was once argued from mechanism alone,
  which is how a track nobody's findings survive stays in the pipeline for months. Quote the
  number in the change. Two readings that are *not* evidence: a skill with no `invoke` rows was
  never **observed**, not never useful (recording starts when the hook is installed), and a track
  scores zero on every run whose tier never dispatched it — the report separates both, so use its
  wording rather than the raw counts.
- The prose is the product: keep the existing register — direct, reasoned, explaining *why* a
  constraint exists where a future editor would otherwise remove it.
- **Write it as it stands now, never as a changelog.** Skills, agents and workflow comments
  describe the current design in the present tense. No "used to", "no longer", "this replaces",
  "we changed it to" — git already records what moved, and prose that narrates its own edits ages
  into a claim about a version nobody is running. Keep the *reason* and the measured numbers that
  justify a constraint (that is what stops a future editor deleting it); drop the story of how it
  got there. Where a wrong alternative is genuinely tempting, name it as a rule for the reader —
  "use X, never Y, because …" — not as a history of having once used Y.
- `skills/spec-brainstorm/references/html-effectiveness/` is vendored third-party material; its
  `LICENSE`, `CODE_OF_CONDUCT.md` and `SECURITY.md` stay verbatim.
