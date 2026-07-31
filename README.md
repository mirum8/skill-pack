# r — a personal Claude Code skill pack

Fifteen engineering skills and the eight agents they dispatch, in one repository,
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
```

`install.sh` copies the pack into `~/.claude/skills/r`, provisions the mandatory
prerequisites, and removes a superseded global hook registration. Then **restart
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

## The fifteen skills

| command | does |
|---|---|
| `/r:task-run` | one unit of work end to end — plan, implement test-first, review, PR |
| `/r:task-review` | the review pipeline over the current diff; never fires on its own |
| `/r:gh-issues-fix` | triage, group and fix open GitHub bug issues, one group at a time |
| `/r:code-bugs` | hunt real defects, plus drift between the changes and the docs |
| `/r:code-quality` | readability and idiom review; reports, never edits |
| `/r:code-scan` | PMD + SpotBugs + Semgrep as local CLIs, then triage and fix |
| `/r:code-adversarial` | the real Codex review, never an imitation of it |
| `/r:code-refactor` | restructure behind a behaviour-locking test |
| `/r:spec-brainstorm` | idea → `spec.html` + `architecture.html` |
| `/r:spec-plan` | spec → phased `todo.md` with runnable done-when checks |
| `/r:tests-write` | JVM test conventions; loads proactively on Java/Kotlin work |
| `/r:test-app-create` | scaffold a project-local `/test-app` for the detected stack |
| `/r:git-commit` | group the working tree into logical Conventional Commits |
| `/r:claudemd-compact` | compact and de-stale a CLAUDE.md hierarchy |
| `/r:claudemd-patch` | insert the standard rule blocks and the test-writing hook |

Names are domain-first (`<domain>-<action>`, at most three kebab segments) so the
alphabetically sorted `/` menu groups the families: `claudemd-*`, `code-*`,
`spec-*`, `task-*`.

`task-run`, `task-review` and `gh-issues-fix` carry
`disable-model-invocation: true` — each says in its own text that it must never
fire on its own, and the frontmatter enforces that rather than trusting the
prose. They stay invocable by name; they just will not auto-load, and they do not
appear in the model's own list of skills.

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
| `gh` (authenticated) | `gh-issues-fix` | `brew install gh && gh auth login` |
| `agent-browser` | UI verification | `npm i -g agent-browser && agent-browser install` |
| `node`, `python3` | workflow scripts, analyzers | — |

**Optional** — the `codex` plugin from the `openai-codex` marketplace, used by
`code-adversarial`. Absent, the step is recorded as **skipped** and named, and the
run continues. It is never satisfied by a model-written substitute: a skipped step
reported as a review is worse than no review at all.

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
parses with `name == "r"`, fifteen skill directories sit exactly two levels deep,
every frontmatter is valid YAML with a `description` under the 1,536-character
cap, the total listing cost stays under 16,000, no skill name is referenced
without its `r:` prefix, no reference dangles, every bundled agent is dispatched
by some skill, every skill has an eval suite with both case kinds, no absolute
path points into a skill directory, no build artefact is tracked, and no two
descriptions open with nearly the same sentence. Then it runs the two workflow
test suites, `claude plugin validate`, the guard's behaviour tests, and the
installer's. The whole run is a few seconds; `SKIP_INSTALL_TEST=1` drops the
slowest part.

### Layout

```
.claude-plugin/plugin.json   identity and namespace — nothing else
skills/<name>/               SKILL.md, plus references/ scripts/ tests/ evals/
agents/<name>.md             the eight the skills dispatch
hooks/                       hooks.json + the workflow-immutability guard
tools/                       build and validation scripts, not shipped
docs/skill-pack-repo/        the design write-up, not shipped
```

`install.sh` copies only `.claude-plugin/`, `skills/`, `agents/`, `hooks/` and
`check-prereqs.sh`. Everything else stays in the repo.

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

The pack is the only copy of these skills on this machine. If one turns out to be
wrong, fix it here and re-run `./install.sh`. The pre-pack versions are archived
under `~/.claude-backups/`:

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
