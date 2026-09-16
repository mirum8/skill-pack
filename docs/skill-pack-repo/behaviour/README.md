# Behaviour register

What every skill, agent and pipeline in this pack actually does, stated once, with an ID.

`spec.html` beside this directory specifies the pack **as an artifact** — how it installs, how
it is named, how it is validated, how it is released. Its 63 IDs (FR-, BR-, NFR-, ADR-, R-) are
live and cited ~200 times from `tools/validate.py`, `install.sh` and `validate.sh`, and they stay
authoritative. What it has never carried is the *contents*: nothing in it says what `plan-run`'s
fan-out does, what `task-review`'s graph is, or which rules are held up by prose alone.

This register is that layer. It is markdown rather than a section of `spec.html` because a
behaviour change has to show up as a reviewable diff, which a 181 KB HTML blob cannot give.

`docs/` is not shipped — `install.sh` copies only `.claude-plugin/ .config/ skills/ agents/
lib/ hooks/ check-prereqs.sh` — so the register costs a run nothing.

## Who reads it

`/r:pack-compact` reads it as ground truth. That skill rewrites the pack's prose from scratch to
close the seams left by fix-after-fix editing, and it can only be safe against a statement of
what the prose has to keep saying. **The register is invariant under compaction**: a rewrite may
change where a behaviour is stated, never what it is. An entry that comes back missing means the
file is restored, not patched.

A human reads it to answer "what does this skill do" without loading 82 KB of instructions.

## ID scheme

`SB-<target>-NNN`, numbered within the file, three digits, never reused. `<target>` is the skill
directory name, or `agent-<name>` for a bundled agent. `SB-` extends the existing FR/BR/NFR/ADR/R
dictionary without colliding with it.

IDs are stable. Renumbering breaks every reference; an entry that stops being true is marked
`RETIRED` in place with the date and the reason, and its number is not reissued.

## Entry format

```markdown
- **SB-plan-run-014** — Under `--herdr` every unit gets a worktree and a full interactive
  session, a wave of one included; a unit running alone is landed before the next worktree is
  cut, because `git worktree add --detach` pins a tree to the base it was created from.
  *States it:* `skills/plan-run/SKILL.md`
  *Enforced by:* `skills/plan-run/scripts/fanout.sh`
  *Tested by:* `skills/plan-run/tests/fanout.test.sh`
```

One behaviour per entry, in the present tense, carrying the reason where a reader would
otherwise delete the rule. Three trailing fields, each a real path or `—`:

| field | means |
|---|---|
| *States it:* | the prose file that must go on saying this. What compaction checks against. |
| *Enforced by:* | the code that makes it true regardless of what the prose says. |
| *Tested by:* | the suite that fails if it stops being true. |

**The register points at the prose; the prose never points back.** No `SB-` tags are added to
shipped files — tagging the very files being lightened would add the noise this exists to remove.

## Prose-only behaviours

An entry with no *Enforced by:* **and** no *Tested by:* is held up by wording alone. Nothing
fails if it quietly stops being true, which makes it exactly the class a rewrite can lose in
silence. Every target file ends with a `## Prose-only behaviours` roll-up listing its own, and
the coverage table below totals them. That number is the pack's real exposure and nothing else
reports it.

The roll-up **names ids, it does not re-declare entries** — one sentence or a plain list, never
the `- **SB-...**` shape:

```markdown
## Prose-only behaviours

17 of 42: SB-code-scan-024, SB-code-scan-025, SB-code-scan-037, …
```

An id is a reference, and a second declaration of one silently redirects the first. The gate
reads the declaration shape to find entries, so a roll-up written as bullets would double every
count it exists to report.

**An `evals/evals.json` case is never a *Tested by:*.** `tools/run-evals.py` scores only the two
mechanical routing kinds and skips every `behaviour` case, so a behaviour case *names* a rule
without ever failing on it. Counting one as a test moves an entry out of the prose-only column
without anything having been made to hold it up, which is the one direction this number must not
drift — the whole point of it is to say how much of the pack is guarded by wording alone.

## What must not be "cleaned up"

Recorded here because it looks stale and is not, and because the first sweep over a pipeline
would otherwise fix it:

- **`post-task-review` and `run-task-implement` are live identifiers.**
  `hooks/guard-workflow.py` holds `GUARDED = ("post-task-review", "run-task-implement")` — the
  two workflow scripts' `meta.name` strings, deliberately left at the pre-rename names even
  though the files moved to `skills/task-review/` and `skills/task-run/`. The guard matches on
  those strings. Renaming them to match the directories disarms the immutability guard on both
  pipelines, and nothing downstream notices.

## Coverage

| target | entries | prose-only | file |
|---|---:|---:|---|
| `agent-bug-hunter-docs` | 20 | 17 | [`agent-bug-hunter-docs.md`](agent-bug-hunter-docs.md) |
| `agent-bug-hunter-pattern` | 24 | 14 | [`agent-bug-hunter-pattern.md`](agent-bug-hunter-pattern.md) |
| `agent-bug-hunter-ui` | 40 | 3 | [`agent-bug-hunter-ui.md`](agent-bug-hunter-ui.md) |
| `agent-bug-hunter` | 21 | 18 | [`agent-bug-hunter.md`](agent-bug-hunter.md) |
| `agent-gradle-build-runner` | 15 | 10 | [`agent-gradle-build-runner.md`](agent-gradle-build-runner.md) |
| `agent-htmx-thymeleaf-dev` | 21 | 16 | [`agent-htmx-thymeleaf-dev.md`](agent-htmx-thymeleaf-dev.md) |
| `agent-java-backend-developer` | 26 | 20 | [`agent-java-backend-developer.md`](agent-java-backend-developer.md) |
| `agent-maven-build-runner` | 16 | 10 | [`agent-maven-build-runner.md`](agent-maven-build-runner.md) |
| `claudemd-compact` | 86 | 83 | [`claudemd-compact.md`](claudemd-compact.md) |
| `claudemd-patch` | 59 | 55 | [`claudemd-patch.md`](claudemd-patch.md) |
| `code-adversarial` | 42 | 11 | [`code-adversarial.md`](code-adversarial.md) |
| `code-bugs` | 49 | 44 | [`code-bugs.md`](code-bugs.md) |
| `code-quality` | 37 | 34 | [`code-quality.md`](code-quality.md) |
| `code-refactor` | 25 | 22 | [`code-refactor.md`](code-refactor.md) |
| `code-scan` | 51 | 18 | [`code-scan.md`](code-scan.md) |
| `git-commit` | 26 | 25 | [`git-commit.md`](git-commit.md) |
| `hexagonal-architecture` | 35 | 33 | [`hexagonal-architecture.md`](hexagonal-architecture.md) |
| `issues-draft` | 46 | 44 | [`issues-draft.md`](issues-draft.md) |
| `issues-fix` | 165 | 134 | [`issues-fix.md`](issues-fix.md) |
| `pack-compact` | 30 | 19 | [`pack-compact.md`](pack-compact.md) |
| `pack-maintain` | 52 | 43 | [`pack-maintain.md`](pack-maintain.md) |
| `page-serve` | 36 | 5 | [`page-serve.md`](page-serve.md) |
| `plan-report` | 57 | 38 | [`plan-report.md`](plan-report.md) |
| `plan-run` | 246 | 174 | [`plan-run.md`](plan-run.md) |
| `plan-unblock` | 70 | 44 | [`plan-unblock.md`](plan-unblock.md) |
| `reuse-index` | 53 | 25 | [`reuse-index.md`](reuse-index.md) |
| `spec-brainstorm` | 161 | 108 | [`spec-brainstorm.md`](spec-brainstorm.md) |
| `spec-design` | 129 | 71 | [`spec-design.md`](spec-design.md) |
| `task-quick` | 42 | 38 | [`task-quick.md`](task-quick.md) |
| `task-review` | 189 | 10 | [`task-review.md`](task-review.md) |
| `task-run` | 136 | 23 | [`task-run.md`](task-run.md) |
| `test-app-create` | 110 | 51 | [`test-app-create.md`](test-app-create.md) |
| `tests-write` | 44 | 41 | [`tests-write.md`](tests-write.md) |
| `ui-prototype` | 85 | 35 | [`ui-prototype.md`](ui-prototype.md) |
| **total** | **2250** | **1340** (59%) | |

A snapshot, frozen with the register. `python3 tools/validate.py` prints the live totals on every
run and `check_behaviour_register()` fails if a target loses its file, so this table going stale is
visible rather than silent.

**1340 of 2250 behaviours are held up by wording alone.** That is the number this register was
built to produce, and the reason `/r:pack-compact` restores a file rather than patching it.

The figure errs high by roughly ten entries: a first pass cleared every eval citation from
*Tested by:* before the rule was made precise, and a handful of those named a routing case that
`run-evals.py` really does score. Recorded rather than quietly corrected, because a number that
overstates how exposed the pack is fails in the safe direction and a silent adjustment to it
would not.

## Open against `spec.html`

Recorded, not fixed — each needs a decision this register cannot make:

- **NFR-4's ≤2 MB repository target is violated.** Measured ~3,944 KB tracked against a target
  set when the repo was 1,257 KB. Either the target moves or the vendored tree does.
- **ADR-3 and ADR-4's revisit trigger has fired.** Both name "the pack exceeding roughly 25
  skills, where families may need real subdirectories" as the point to reconsider flat `skills/`
  and domain-first naming. The pack is at 25 and `pack-compact` makes 26. Neither has been
  revisited.
- **`BR-2` says "exactly the fifteen pairs"; `tools/rename_rules.py` has sixteen** and its own
  header comment says sixteen. The code silently redefines the rule the spec states.
- **`PACK_NATIVE` and `RETIRED_PACKED` have no spec vocabulary.** Nine skills born in the pack
  have no flat ancestor, and the retired-packed-name mechanism that stops a stale `/r:spec-plan`
  resolving is entirely undescribed.
