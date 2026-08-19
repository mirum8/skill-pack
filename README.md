# r — a personal Claude Code skill pack

Sixteen engineering skills and the eight agents they dispatch, in one repository,
loaded as a skills-directory plugin named `r`. Every skill is reachable as
`/r:<name>`.

> **This installs at personal scope, which has no trust gate at all.** A skill is
> arbitrary instructions to an agent with tool access, and this pack additionally
> ships executable Python, shell and JavaScript. That is the right trade-off for
> the author's own machine and the wrong one for anybody else. Read what you are
> installing.

## Install

```sh
git clone <this repo> ~/projects/skill-pack && cd ~/projects/skill-pack
./install.sh            # --dry-run to see the commands, --no-deps to skip provisioning
                        # --keep-originals to keep the old flat-named skills installed
```

`install.sh` copies the pack into `~/.claude/skills/r`, provisions the mandatory
prerequisites, removes a superseded global hook registration, and retires the
pre-pack originals still installed under their old flat names — the pack renames
what it carries, so an original left behind is a twin that answers to the old
name with the old behaviour. Pass `--keep-originals` to leave them. Then **restart
the session** — skills-directory plugins are discovered at session start, never
mid-session. An install that appears to have done nothing is almost always a
session that was not restarted.

Verify in two steps, in this order:

```sh
claude --plugin-dir "$PWD"    # proves the manifest, namespace and layout, installs nothing
/plugin                       # after installing: must list  r@skills-dir
```

Either check alone is ambiguous — a malformed manifest and a pack that was never
copied both present as a namespace that simply is not there.

To uninstall: `rm -rf ~/.claude/skills/r`. The clone survives, so it is never a
data loss. Prerequisites are not removed; they are ordinary tools that may
predate the pack.

### It copies, it does not symlink

**This repository and the installed pack are two separate copies.** Edit here,
then re-run `./install.sh` to publish. A `SKILL.md` edit is live in the current
session once copied; anything else — `agents/`, `hooks/`, `.mcp.json` — needs one
`/reload-plugins`.

A plain directory holding `.claude-plugin/plugin.json` is the documented
skills-directory case. Whether plugin discovery follows a *symlinked* entry is
documented neither way, and it fails identically to a malformed manifest, so the
pack does not rely on it.

## The eighteen skills

| command | does |
|---|---|
| `/r:task-run` | one unit of work end to end — plan, implement test-first, review, PR |
| `/r:task-review` | the review pipeline over the current diff; never fires on its own |
| `/r:issues-draft` | a free-text message → a verified `issues-<slug>.md` backlog + a reply |
| `/r:issues-fix` | triage, group and fix a backlog — GitHub issues or a markdown list |
| `/r:code-bugs` | hunt real defects, plus drift between the changes and the docs |
| `/r:code-quality` | readability and idiom review; reports, never edits |
| `/r:code-scan` | PMD + SpotBugs + Semgrep as local CLIs, then triage and fix |
| `/r:code-adversarial` | the real Codex review, never an imitation of it |
| `/r:code-refactor` | restructure behind a behaviour-locking test |
| `/r:spec-brainstorm` | idea → one `spec.html`: domain model, user stories, modules, stack, API |
| `/r:spec-design` | docs → `todo.md`: milestones, design contracts, leaves, and a dependency graph |
| `/r:plan-run` | build a whole `todo.md` phase by phase; non-overlapping phases can run in parallel sessions |
| `/r:hexagonal-architecture` | Hexagonal Lite boundaries: what lives in core, what a module may import |
| `/r:tests-write` | JVM test conventions; loads proactively on Java/Kotlin work |
| `/r:test-app-create` | scaffold a project-local `/test-app` for the detected stack |
| `/r:git-commit` | group the working tree into logical Conventional Commits |
| `/r:claudemd-compact` | compact and de-stale a CLAUDE.md hierarchy |
| `/r:claudemd-patch` | insert the standard rule blocks and the test-writing hook |

Names are domain-first (`<domain>-<action>`, at most three kebab segments) so the
alphabetically sorted `/` menu groups the families: `claudemd-*`, `code-*`,
`issues-*`, `spec-*`, `task-*`. `hexagonal-architecture` is the one exception — it is a
rulebook rather than an action, and "hexagonal" is the word someone reaches for.

`task-run` and `issues-fix` carry `disable-model-invocation: true` — each says
in its own text that it must never fire on its own, and the frontmatter enforces
that rather than trusting the prose. They stay invocable by name; they just will
not auto-load, and their descriptions are not in context at all, which is why
neither counts against the 16,000-character listing budget below.

`task-review` says the same thing but carries no flag, on purpose. The flag is
all-or-nothing: it blocks the Skill tool outright, so it cannot tell "the model
auto-loaded this" from "the model was told to run this" — and `task-run`'s Step 5
is *required* to invoke `/r:task-review`. With the flag on, that step could not
reach it and the mandatory review quietly became something the user had to type.
For that one skill the no-auto-fire rule is carried by its description and its
non-negotiables instead.

The eight agents in `agents/` are what the review fan-out dispatches to — four
bug hunters, two build runners, and two stack-specific implementers.

## Prerequisites

`./check-prereqs.sh` reports all of them and exits non-zero only if a **mandatory**
one is missing. The skills also check themselves at the point of use, which is
better — those checks can say which coverage was lost. This one answers the
question they cannot answer between them: will the pack work here at all?

**Mandatory** — the pipeline cannot run honestly without them. `task-review`
calls `code-scan` on every tier and treats it as required, and UI verification
goes through `agent-browser`.

| tool | for | install |
|---|---|---|
| `pmd`, `spotbugs`, `semgrep` | `code-scan` | `brew install pmd spotbugs semgrep` |
| `agent-browser` | UI verification | `npm i -g agent-browser && agent-browser install` |
| `node`, `python3` | workflow scripts, analyzers | — |

**Optional** — absent, what is lost is **named** and the run continues. Neither is ever
satisfied by a model-written substitute: a skipped step reported as a review is worse than
no review at all.

| tool | for | absent |
|---|---|---|
| `gh` (authenticated) | `task-run` issue sources and PRs; `issues-fix` against GitHub | GitHub stops being one of the sources |
| `codex` plugin | `code-adversarial` | the step is recorded as **skipped** and named |

The pack runs end to end **without GitHub**. `task-run` takes a todo phase, a list item or
free text as its source and finishes by merging the feature branch instead of opening a PR;
`issues-fix` reads the list file at the repo root. Only issue sources, `gh pr create` and
closing issues on merge need `gh`, and each says so rather than improvising — which is why
it is not mandatory: a machine without it loses one source, not the pipeline.

The `codex` plugin comes from the `openai-codex` marketplace:

```
/plugin marketplace add openai-codex
/plugin install codex@openai-codex
```

A skills-directory plugin has no way to declare a dependency on another plugin,
which is why this is a README section and a runtime check rather than metadata.

Known-good versions, read 2026-07-30 — recorded as tested-against, not as minimum
floors, because no lower bound was tested: `pmd` 7.26.0 · `spotbugs` 4.10.2 ·
`semgrep` 1.168.0 · `gh` 2.96.0 · `codex-cli` 0.146.0 · `node` v26.4.0 ·
`agent-browser` 0.26.0 · Claude Code 2.1.220.

## Maintaining it

```sh
./validate.sh            # run before every push
./install.sh             # publish repo edits into ~/.claude/skills/r
```

There is no CI, so `validate.sh` is the whole gate. It checks that the manifest
parses with `name == "r"`, eighteen skill directories sit exactly two levels deep,
every frontmatter is valid YAML with a `description` under the 1,536-character
cap, the listing cost of the model-invocable skills stays under 16,000, no skill name is referenced
without its `r:` prefix, no reference dangles, every bundled agent is dispatched
by some skill, every skill has an eval suite with both case kinds, no absolute
path points into a skill directory, no build artefact is tracked, and no two
descriptions open with nearly the same sentence. Then it runs the two workflow
test suites, `claude plugin validate`, the guard's behaviour tests, the plan
graph's (edges, derived waves, same-wave file collisions and the concurrency
preflight), the stats store's, and the installer's. The whole run is a few
seconds; `SKIP_INSTALL_TEST=1` drops the slowest part.

### Layout

```
.claude-plugin/plugin.json   identity and namespace — nothing else
skills/<name>/               SKILL.md, plus references/ scripts/ tests/ evals/
agents/<name>.md             the eight the skills dispatch
hooks/                       hooks.json, the workflow-immutability guard, the stats hook
lib/                         the pack-wide stats sink and reporter, shared by every skill
tools/                       build and validation scripts, not shipped
docs/skill-pack-repo/        the design write-up, not shipped
```

`install.sh` copies only `.claude-plugin/`, `skills/`, `agents/`, `hooks/`, `lib/`
and `check-prereqs.sh`. Everything else stays in the repo.

### Measuring the pack

`lib/record-run.py` writes into `~/.claude/skill-stats.db` (SQLite, WAL);
`lib/skill-stats.py` reads it back. Four tables, defined in `lib/schema.sql`:

| table | one row per |
|---|---|
| `runs` | invocation (`event=invoke`, from the hook) or outcome (`event=result`, from a skill) |
| `findings` | finding, with the **verdict** triage reached — `confirmed` / `dismissed` / `unresolved` |
| `items` | workflow agent: its prompt, its result, its model, tokens and wall-clock |
| `meta` | `schema_version` |

```sh
python3 lib/skill-stats.py                  # everything
python3 lib/skill-stats.py --review         # the review pipeline's per-track table alone
python3 lib/skill-stats.py --mine-items     # fill `items` from the workflow transcripts on disk
python3 lib/skill-stats.py --import-jsonl   # copy the pre-SQLite JSONL archive in, once
python3 lib/skill-stats.py --backfill       # recover past reviews from transcripts, once
```

Runs are counted from `invoke` rows only — the same run produces both shapes, and
counting both would double every number. `session_id` joins them, and points at the
transcript the run left on disk.

**`findings.verdict` is what makes a track judgeable.** A track that surfaces ten
real defects triage rejects scores exactly the same zero in `fixes by source` as a
track that finds nothing; only the rejections separate a noisy track from a quiet
one. Both pipelines and the report-only skills therefore record what they *dropped*,
not just what they kept. Descriptions are one line — the store holds titles, never
finding bodies, because the payload travels inside an agent's prompt.

**`items` is mined, not recorded.** Claude Code already persists every workflow
run under `~/.claude/projects/<project>/<session>/subagents/workflows/wf_*/` — a
`journal.jsonl` of each item's return value, plus a full transcript per agent
carrying its prompt, model, effort, timestamps and token usage. `--mine-items`
reads those, so the pipelines pay nothing at run time and every run already on
disk is recoverable. `prompt` and `result` are capped and `transcript_path` keeps
the full text one read away. Neither workflow could time itself in any case:
`Date.now()` is unavailable inside a `Workflow` script.

**Cost is reported per pipeline step, not per agent type.** Claude Code persists a
subagent's `agentType` but not the workflow's `label`, and one type covers many
steps — `general-purpose` alone spans the codex pass, triage, `code-scan`, the UI
deploy and the sink. So `items.label` is recovered by matching the prompt against
the literal chunks of each `agent()` dispatch in the shipped `*.workflow.js`. The
mapping is read from the scripts rather than kept in a table, so a reworded prompt
updates it with the wording, and a rename fails to an **unlabelled** row — counted
and named in the report — never a confidently wrong one. Pre-pack skill names are
aliased so history still classifies; for runs recorded by a script the pack no
longer ships, point `--label-source <script>` at it.

The hook is registered on two events because a skill is reachable two ways and the
two are disjoint in the transcript: `PostToolUse`/`Skill` when the model invokes
one, `UserPromptSubmit` when a person types `/r:<name>`. Only `r:`-prefixed names
are recorded.

`~/.claude/skill-stats.jsonl` is the append-only store that predates the db, and it
is never written now. `--import-jsonl` copies its rows in, deriving each `run_id`
from a hash of the line it came from so a second import inserts nothing. The file
stays where it is — the import is a copy, never a move.

There is **no fallback store**: a row the db rejects is lost, and the reason goes to
stderr. That is why the inserts name the one conflict they mean to ignore rather
than using `INSERT OR IGNORE`, which also swallows a `NOT NULL` violation and would
drop rows in silence.

These numbers are the pack's second instrument, next to the eval suites: they say
which skill is *used*, what it *finds*, how much of that survives judgement, and
what it cost. A skill with no rows was never **observed** — recording starts when
the hook is installed, and the report says so rather than showing a zero.

### Paths inside skills

Nothing may hard-code an install location. A skill referring to its own files
uses `${CLAUDE_SKILL_DIR}`; a skill referring to another's uses
`${CLAUDE_PLUGIN_ROOT}/skills/<name>`. The two are not interchangeable —
`${CLAUDE_SKILL_DIR}` is the skill's own subdirectory and cannot reach a sibling.

Neither placeholder is substituted inside a `*.workflow.js` that the `Workflow`
tool executes, so those receive the pack root as `args.packRoot`, passed from the
`SKILL.md` that invokes them. `validate.sh` fails if an absolute path reappears.

### The workflow guard

`hooks/guard-workflow.py` keeps the `task-review` and `task-run` pipelines
immutable: a forked copy of either cannot be run or written, whether as a
`scriptPath`, an inline script, or a `Write`/`Edit` that would create one. Its
allow-list is built at run time from `$CLAUDE_PLUGIN_ROOT`, so it travels with the
pack, and it matches only real workflow scripts — prose that merely quotes a
guarded pipeline name is left alone.

`hooks/tests/guard.test.sh` covers both halves: the canonical pipelines run, forks
do not.

### Eval suites

Every skill has `evals/evals.json` with at least one **trigger** case and one
**neighbour-exclusion** case. They need a model, so run them deliberately — after
editing any description, and before a release — rather than on every push.

They are the only instrument the pack has for its most likely failure. The router
is a model reading prose, so a description that drifts until it stops triggering
looks exactly like a skill nobody needed. A failing neighbour-exclusion case means
that skill is mis-routing right now.

### Rollback

Fix a wrong skill here and re-run `./install.sh` — the repo is the copy to edit.
It is **not** the only copy on this machine: pre-pack originals under their old
flat names still sit in `~/.agents/skills/`, and an edit that lands there works
under the old name and is missing under the new one. `validate.sh` names them on
every run for exactly that reason; treat that line as a standing warning, not as
noise. The pre-pack versions are also archived under `~/.claude-backups/`:

```sh
tar -xzf ~/.claude-backups/claude-skills-<stamp>.tar.gz -C ~/.claude
```

That archive holds `~/.claude/skills`, `agents/` and `settings.json` as they were
before the pack was installed.

## Provenance

`skills/spec-brainstorm/references/html-effectiveness/` is vendored third-party
material, retrieved 2026-07-30, kept so `spec-brainstorm` works offline and its
citations stay valid. Its `LICENSE`, `CODE_OF_CONDUCT.md` and `SECURITY.md` are
preserved verbatim.

The design is written up in `docs/skill-pack-repo/` — `spec.html`,
`architecture.html`, and the interview notes behind them.

Everything else: MIT, see `LICENSE`.
