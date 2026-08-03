# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

The source of `r`, a **skills-directory plugin** for Claude Code: 15 skills (`/r:<name>`) and the
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
bash tests/install.test.sh                                 # installer behaviour
claude plugin validate .                                   # the loader's own view of the pack
claude --plugin-dir "$PWD"                                 # load the pack without installing it
```

`tools/build-pack.py` is a **one-shot historical build** that wipes `skills/` and `agents/` and
regenerates them from flat originals under `~/.claude`. Those originals were deleted on
2026-07-31 — this pack is now the only copy. Do not run it.

Eval suites (`skills/*/evals/evals.json`) need a model, so they are not part of `validate.sh`. Run
them deliberately after editing any `description`, and before a release.

## Layout and what ships

```
.claude-plugin/plugin.json   identity + namespace (name must stay "r")
skills/<name>/SKILL.md       the skill; plus references/ scripts/ tests/ evals/
agents/<name>.md             the 8 agents skills dispatch to
hooks/                       hooks.json + guard-workflow.py
tools/                       build/validation scripts — NOT shipped
tests/, validate.sh          repo-level test + gate — NOT shipped
docs/skill-pack-repo/        spec.html, architecture.html, interview notes — NOT shipped
```

`install.sh` copies exactly `.claude-plugin/ skills/ agents/ hooks/ check-prereqs.sh`. Anything a
skill needs at run time must live under one of those.

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

**Skills that must never self-trigger** (`task-run`, `gh-issues-fix`) carry
`disable-model-invocation: true` in frontmatter — the enforcement, not just a sentence in the body.
`task-review` must not self-trigger either, but carries **no** flag: the flag blocks the Skill tool
outright and cannot tell an auto-load from a deliberate call, so it also blocked `task-run`'s
mandatory Step 5 from invoking the review. There the rule lives in the description and the
non-negotiables — don't "fix" it back.

**Real tools, or a named skip.** The pipelines call `gh`, the real Codex review, real build runners,
`agent-browser`, `code-scan`. Never substitute a model-written prose imitation. When a tool is
missing, the step is recorded as **skipped** and named, and the run continues.

## Rules `validate.sh` enforces (edit within them)

- **Paths.** Nothing hard-codes an install location. A skill referencing its own files uses
  `${CLAUDE_SKILL_DIR}`; referencing another skill's files uses
  `${CLAUDE_PLUGIN_ROOT}/skills/<name>`. They are not interchangeable. Neither placeholder is
  substituted inside a `*.workflow.js`, so those take the pack root as `args.packRoot`, passed by
  the invoking `SKILL.md`. No `/Users/<name>/` or `~/.claude/skills/<x>` paths anywhere outside
  `docs/`.
- **Names.** Every packed skill referenced anywhere must carry the `r:` prefix. Every skill name a
  body mentions must be packed, bundled with Claude Code, or listed in the README as an external
  prerequisite — anything else is a name the model will try to invoke mid-run and fail to reach.
  New names are domain-first: `<domain>-<action>`, at most three kebab segments.
- **Frontmatter.** Valid YAML, a `description` under 1,536 characters, and the whole listing cost
  under 16,000. No two descriptions may open with nearly the same sentence.
- **Structure.** Exactly 15 skill directories, two levels deep. Every bundled agent must be
  dispatched by some skill. Every skill needs `evals/evals.json` with at least one `trigger` case
  and one `neighbour-exclusion` case. No build artefacts tracked.

## Conventions

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
