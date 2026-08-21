# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

The source of `r`, a **skills-directory plugin** for Claude Code: 19 skills (`/r:<name>`) and the
8 agents they dispatch. There is no application here — the "product" is prose (`SKILL.md`),
workflow scripts, agent definitions and a hook, all loaded by Claude Code itself.

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
lib/                         pack-wide stats sink + reporter, shared by every skill
tools/                       build/validation scripts — NOT shipped
tests/, validate.sh          repo-level test + gate — NOT shipped
docs/skill-pack-repo/        spec.html, architecture.html, interview notes — NOT shipped
```

`install.sh` copies exactly `.claude-plugin/ skills/ agents/ hooks/ lib/ check-prereqs.sh`. Anything
a skill needs at run time must live under one of those.

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
- **The step label is recovered from the prompt**, by matching it against the literal chunks of
  each `agent()` dispatch in the shipped workflow scripts — `agentType` is persisted but `label`
  is not, and one type covers many steps. Read from the scripts, never a table here, so a reworded
  prompt updates the mapping with the wording; an unmatched prompt stays **unlabelled** and is
  counted as such, because a wrong step name is averaged in silently while a gap is visible.
  All three shapes a prompt is dispatched in are read — the literal passed to the call, the
  `prompt:` beside its `label:` in a table of tracks, and the literal under a builder the call
  passes by name — and a shape that goes unread costs its step every run it ever made: 995 of the
  1,646 unlabelled items were `implement`, `find-bugs`, `build`, `source` and `judge`, and
  `implement` alone turned out to be the most expensive step in the pipeline at 1.49B tokens.
  A chunk two steps share names neither. A stored label is corrected only when it is a step these
  same scripts can write — that one is this classifier's own earlier answer, so a disagreement is
  it having improved; a label outside their vocabulary came from a `--label-source` run over older
  scripts and is left alone.
- **Implementer depth is a claim under measurement, not a default.** `IMPL_RUN` in
  `task-run-implement.workflow.js` pins the implementers at `medium`, and the `implement depth`
  table is what decides whether that holds: it buckets every implement run by the effort mined off
  its items and prints the paired review's yield beside it. The `high` baseline it is read against
  is 2.11 correctness and 3.48 readability fixes per paired review, at 20.9M tokens and 1022s per
  implementer agent — the pack's most expensive step. Read the table before moving the pin either
  way, and read both halves: a cheaper implementer that pushes work into `fix-correctness` and
  `end-verify-fix` has moved cost, not saved it. The pairing is positional (same repo, the next
  pipeline-invoked review inside 12h), so it is a strong guess and never a recorded fact.
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

**Skills that must never self-trigger** (`task-run`, `issues-fix`, `plan-run`, `spec-design`) carry
`disable-model-invocation: true` in frontmatter — the enforcement, not just a sentence in the body.
Each of the four mutates the repo or a plan on a scale nobody wants arrived at by inference, so
they are invoked deliberately or not at all. Two consequences follow and are easy to forget: their
descriptions leave the listing budget entirely (they are not in the router's context), and **no
prompt can route to them**, so their own `trigger` eval cases are untestable by design and their
`neighbour-exclusion` cases pass without measuring anything — `tools/run-evals.py` skips both kinds
and says why rather than counting them as passes.

`task-review` must not self-trigger either, but carries **no** flag: the flag blocks the Skill tool
outright and cannot tell an auto-load from a deliberate call, so it also blocked `task-run`'s
mandatory Step 5 from invoking the review. There the rule lives in the description and the
non-negotiables — don't "fix" it back.

**Real tools, or a named skip.** The pipelines call `gh`, the real Codex review, real build runners,
`agent-browser`, `code-scan`. Never substitute a model-written prose imitation. When a tool is
missing, the step is recorded as **skipped** and named, and the run continues.

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
  `evals/evals.json` with at least one `trigger` case and one `neighbour-exclusion` case. No
  build artefacts tracked.

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
