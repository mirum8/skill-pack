# `r:bug-hunter-docs` — behaviour register

The bundled **documentation-consistency hunter**: Agent 5 of the `/r:code-bugs` parallel fan-out.
The other hunters look for code that will break in production; this one looks for code that
disagrees with what the project's **documentation says should be true**. Report-only — it never
edits docs or code.

Format, ID scheme and the meaning of the three trailing fields: [`README.md`](README.md).

## Entries

- **SB-agent-bug-hunter-docs-001** — It is the documentation-consistency hunter in the
  `/r:code-bugs` parallel scan, and it is a **different question from every other hunter's**: not
  "will this break in production" but "does this contradict what the project wrote down".
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-002** — **The docs are not automatically right.** A divergence is a
  report that code and docs disagree, **not a bug report against the code**, and sometimes the
  right fix is to update the docs. The agent's value is telling the user *which side most likely
  needs to move*, with a reason.
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-003** — **Step 1 — read the topic file first**, at
  `${CLAUDE_PLUGIN_ROOT}/skills/code-bugs/references/documentation-consistency.md`. It carries the
  full list of docs to check, what counts as a real divergence, what to ignore, the finding format
  and how to decide which side is stale. It is the playbook and it is followed. The path uses
  `${CLAUDE_PLUGIN_ROOT}/skills/<name>` because the file belongs to another skill, not to this
  agent.
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* `tools/validate.py`
  *Tested by:* `validate.sh`

- **SB-agent-bug-hunter-docs-004** — **Step 2 — resolve the scope and the mode.** The scope is an
  explicit file list, a package, or "the working-tree diff". The mode is one of two: **diff mode
  (the default)**, comparing only the changed code against the docs using `git diff` /
  `git status --short`, or **whole-project mode**, auditing the entire resolved code scope against
  all docs — used only when the scan covers the whole project. The agent runs from the repo root,
  so `git` works directly.
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-005** — **Step 3 — locate the docs over the filesystem, never over
  git.** Doc files are often **gitignored** (a local `spec.md`, `todo.md`, a scratch `docs/`), so
  discovering them with `git ls-files` / `git diff` **silently skips them** — and a hunter that
  found no docs reports a clean result. Every doc found is authoritative regardless of git status;
  git is only for finding what *code* changed, in diff mode.
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-006** — **What counts as documentation here**: `spec.md`/`spec.html`,
  `todo.md`, `docs/**`, `DESIGN.md`/`ui-design.md` (the visual design system), a plan's
  `tech-design.md` beside its `todo.md` (build contracts — schema, endpoints, types, module
  boundaries), the `**/CLAUDE.md` hierarchy (root, nested module files, linked reference docs), and
  `README.md`/`ARCHITECTURE.md`/`CONTRIBUTING.md`. `tech-design.md` and `DESIGN.md` are **different
  documents and never the same evidence**.
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-007** — A **nested `CLAUDE.md`'s rules are scoped to the module
  directory it lives in**, not applied across the repo.
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-008** — **No documentation anywhere in scope is a valid result, not a
  failure.** The agent reports exactly **"No documentation found to check against"** and stops. The
  string is fixed so the orchestrator can tell "nothing to compare against" from "compared and
  found nothing".
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-009** — **Step 4 — compare and judge, citing both sides.** Every
  candidate divergence names a concrete doc statement **and** a concrete code fact that contradict
  each other. `CLAUDE.md` is treated as a source of project rules and conventions, **not feature
  behaviour** — what gets flagged is a change that violates a stated rule, not a rule unrelated to
  the change.
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-010** — **The finding format is its own, deliberately distinct from
  the production-bug format**: **Doc** (file + section/line, quoted briefly), **Code** (file +
  line), **Divergence** (the specific mismatch in one or two sentences), and **Suggested
  resolution** — `update doc` / `update code` / `confirm intent`, with a one-line rationale.
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-011** — **The resolution is decided from what the change touched**: a
  change implementing new or intended behaviour usually means stale docs → `update doc`; a refactor
  or bugfix against a doc that encodes a deliberate spec or rule means the code may have drifted →
  `update code`; genuinely ambiguous → `confirm intent`. **It never offers both sides with no
  recommendation** — an unresolved "one of these is wrong" is the output this agent exists to avoid
  producing.
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-012** — Only divergences it has **high confidence** are real and
  concrete are reported. If it is inferring intent, or cannot cite both sides, it skips the item;
  if nothing diverges it says so rather than inventing findings.
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-013** — **Report-only: no doc edits, no code edits, no tests, no plan
  mode.** The orchestrator (`/r:code-bugs`) owns triage and fixing. The frontmatter is the
  enforcement, not the sentence: `tools` is exactly **`Bash, Glob, Grep, Read`**, so there is no
  `Edit` and no `Write` — an agent that recommends updating a doc genuinely cannot update it.
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* `tools/validate.py`
  *Tested by:* `validate.sh`

- **SB-agent-bug-hunter-docs-014** — **It is not a documentation linter.** Prose wording, typos,
  formatting, stale dates with no behavioural meaning and internal code comments are all ignored.
  It compares documentation files to code, and nothing else.
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-015** — It stays within the resolved scope and **does not audit the
  whole codebase in diff mode**.
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-016** — **Independent tool calls are batched into ONE block** —
  several greps, several reads, a `git diff` beside a `git status` — with only genuinely dependent
  calls serial. Cost is turns × context and every turn re-reads the whole accumulated context, **a
  median of ~77k tokens**, so a call that could have ridden along with the previous one pays a full
  re-read to return one grep. The bullet appears verbatim in six bundled agents as **deliberate
  cross-context restatement**: an agent file is loaded without its calling skill and without its
  sibling agents, so the rule has to travel with each one.
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-017** — It writes in **simplified (B2 level) English**.
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-018** — Its frontmatter is `model: opus`, `effort: high`. Deciding
  which of two documents is stale is an adjudication, not a lookup, so it keeps the hunters' tier.
  *States it:* `agents/bug-hunter-docs.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-019** — **`/r:code-bugs` dispatches it as Agent 5**, with
  `subagent_type: "r:bug-hunter-docs"`, alongside the four `r:bug-hunter-pattern` category hunters.
  A deliberate code-versus-intent check is what a user asking for `/r:code-bugs` gets.
  *States it:* `skills/code-bugs/SKILL.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-docs-020** — **`/r:task-review` dispatches it nowhere, on its own measured
  numbers.** Over **59 dispatches** the docs hunter cost **150.7M tokens (2.56M per run, the
  second-most expensive hunter)** and produced **35 findings with 0 confirmed, 0 dismissed and 35
  unresolved** — the pipeline never adjudicated one, because doc drift resolves to
  update-doc / update-code / confirm-intent, which is the **user's call**. Read by what it surfaced
  rather than by fixes/run (the honest test for a report-only track): 12 of the 35 are `todo.md`
  checkbox bookkeeping, which `/r:task-run` and `/r:plan-run` own directly, and 6 more are
  CLAUDE.md drift, which Step 9's `/r:claudemd-compact --auto` already covers. That leaves ~17
  genuine spec/design divergences across 59 runs — **0.29 unadjudicated items per review**. It is
  retired from **that pipeline only**; do not reinstate it without rows showing the drift list gets
  acted on.
  *States it:* `skills/task-review/task-review.workflow.js`
  *Enforced by:* `skills/task-review/task-review.workflow.js`
  *Tested by:* —

## Prose-only behaviours

Held up by wording alone — no *Enforced by:* and no *Tested by:*. Nothing fails if one quietly
stops being true, which is the class a rewrite can lose in silence. The agent ships no script and
no suite of its own, so 17 of 20 entries:

SB-agent-bug-hunter-docs-001, SB-agent-bug-hunter-docs-002, SB-agent-bug-hunter-docs-004,
SB-agent-bug-hunter-docs-005, SB-agent-bug-hunter-docs-006, SB-agent-bug-hunter-docs-007,
SB-agent-bug-hunter-docs-008, SB-agent-bug-hunter-docs-009, SB-agent-bug-hunter-docs-010,
SB-agent-bug-hunter-docs-011, SB-agent-bug-hunter-docs-012, SB-agent-bug-hunter-docs-014,
SB-agent-bug-hunter-docs-015, SB-agent-bug-hunter-docs-016, SB-agent-bug-hunter-docs-017,
SB-agent-bug-hunter-docs-018, SB-agent-bug-hunter-docs-019.

**-005** is the one to watch: nothing at all fails if doc discovery quietly moves to `git ls-files`,
and the symptom is a hunter that reports no divergences because it never saw the gitignored spec.
