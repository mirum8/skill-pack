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

The install is a copy, so **this repository and the installed pack are two
separate copies**. Edit here, then re-run `./install.sh` to publish. A `SKILL.md`
edit is live in the current session once copied; anything else — `agents/`,
`hooks/`, `.mcp.json` — needs one `/reload-plugins`.

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
| `/r:claudemd-patch` | insert the standard rule blocks and the write-tests hook |

Names are domain-first (`<domain>-<action>`, at most three kebab segments) so the
alphabetically sorted `/` menu groups the families: `claudemd-*`, `code-*`,
`spec-*`, `task-*`.

Three skills carry `disable-model-invocation: true` — `task-run`, `task-review`
and `gh-issues-fix` all say in their own text that they must never fire on their
own, and the frontmatter enforces it rather than trusting the prose. Every skill
can still be invoked by name.

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
./validate.sh            # run before every push — static checks + both test suites + the guard
./install.sh             # publish repo edits into ~/.claude/skills/r
```

There is no CI. `validate.sh` runs the same checks a workflow file would have:
the manifest parses with `name == "r"`, fifteen skill directories exactly two
levels deep, names matching the map, every frontmatter valid YAML, no description
over the 1,536-char cap, the total listing cost under 16,000, no `version:` key,
no un-prefixed reference to an old skill name, no dangling reference, every
bundled agent dispatched by some packed skill, an eval suite per skill with both
a trigger and a neighbour-exclusion case, no absolute path into a skill
directory, no tracked build artefacts, and no two descriptions that open with
nearly the same sentence. Each runs in well under a second. The residual risk is
that a script has to be remembered.

### The originals stay, forever

The fifteen flat skills under `~/.claude/skills/` are never deleted. `/commit`
runs the flat one, `/r:git-commit` runs the packed one, and neither shadows the
other. There is no cut-over, so rollback stays trivial indefinitely.

The cost is that everything exists twice, and one rule holds it together:
**edits go to the pack, never to an original.** `validate.sh` compares each flat
original against a hash taken when the pack was built and names any that changed
— an edit that landed in the wrong copy is not lost at a cut-over, because there
is no cut-over. It just sits there, working under the old name and missing under
the new one, which is harder to notice than losing it outright.

Refresh the baseline deliberately, never as a side effect:
`./validate.sh --refresh-drift-baseline`.

### Eval suites

Every skill has `evals/evals.json` with at least one **trigger** case and one
**neighbour-exclusion** case. They need a model, so they are run deliberately —
after editing any description, and before a release — not on every push. A
failing neighbour-exclusion case means that skill is mis-routing right now.

They are the only instrument the pack has for its most likely failure. The router
is a model reading prose, so a description that drifts until it stops triggering
looks exactly like a skill nobody needed — and because the flat twins stay
installed, every packed description competes with its own twin in the listing.

## How it is built

`skills/` and `agents/` were generated once from the flat originals by
`tools/build-pack.py`, which applies the rename map, the bounded reference
rewrite and the path de-absolutisation. **The pack is the source now** — the
builder refuses to run over an existing `skills/` without `--force`, because a
rebuild would discard everything the pack owns that the originals do not.

The reference rewrite is bounded to four shapes (`/name`, `` `name` ``,
`Skill(name)`, and a `subagent_type`/`agentType`/`skill` key). That bound is the
whole design: `commit` appears about a hundred times in these files and
`refactor` about forty, almost always as English. Three classes of false rewrite
got through the first pass and were caught by hand review and by the packed
tests — English "or" slashes (`compact/refactor/reorganize`), backticked
`` `refactor` `` in a Conventional Commit type list, and JS regex literals in
test assertions. All three are now excluded by rule, not by exception list.

Absolute paths resolve through substituted variables: `${CLAUDE_SKILL_DIR}` for a
skill's own files, `${CLAUDE_PLUGIN_ROOT}/skills/<name>` for a sibling's. The two
are not interchangeable — `${CLAUDE_SKILL_DIR}` is the skill's own subdirectory
and cannot reach a sibling. Neither is substituted inside a `*.workflow.js` the
`Workflow` tool executes, so those take the pack root as `args.packRoot`, passed
from the SKILL.md that invokes them.

`hooks/guard-workflow.py` keeps the two pipelines immutable: a forked
`task-review` or `task-run` script cannot be run or written. Its allow-list is
built at run time from `$CLAUDE_PLUGIN_ROOT` plus the two flat originals, and it
matches only files that are actually workflow scripts — an earlier version
matched by content alone and blocked an edit to a prose document that merely
quoted the guarded names.

## Provenance

`skills/spec-brainstorm/references/html-effectiveness/` is vendored third-party
material, retrieved 2026-07-30, kept so `spec-brainstorm` works offline and its
citations stay valid. Its `LICENSE`, `CODE_OF_CONDUCT.md` and `SECURITY.md` are
preserved verbatim.

The design is written up in `docs/skill-pack-repo/` — `spec.html`,
`architecture.html`, and the interview notes that record how the decisions were
reached, including the ones that were wrong first.

Everything else: MIT, see `LICENSE`.
