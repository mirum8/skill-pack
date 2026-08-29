# Documentation Consistency

Drift between a change and the project's written intent — places where the code and the docs
contradict each other. Hunter focus: **Documentation Consistency.**

This hunter does not look for code that will break in production; it looks for code that
disagrees with what the documentation *says* should be true. One side is then stale, and the
right fix is sometimes to change the docs. Surface the disagreement and say which side most
likely needs to move.

## What docs to read

Resolve these by `Glob` over the **filesystem**, at the repo root and nested — never via git:
doc files are often gitignored (a local `spec.md`, `todo.md`, or scratch `docs/`), so
`git ls-files` / `git diff` would miss them. They are authoritative regardless of git status.
Be tolerant of case and location; skip a missing file silently.

- `spec.md`, `spec.html`, `*.spec.md` — the behavioral specification
- `todo.md`, `TODO.md` — the phased plan / outstanding work
- `docs/**` (`*.md`, `*.html`) — design notes, API docs, architecture
- `DESIGN.md` / `ui-design.md` — the UI design system (tokens, components, conventions). A
  `DESIGN.md` may follow the google-labs-code/design.md format: normative tokens in YAML front
  matter, rationale in the prose — treat both layers as intent.
- `**/CLAUDE.md` — the full hierarchy: root `CLAUDE.md` plus nested module `CLAUDE.md`
  files, and any reference docs they link to (e.g. `docs/*.md` extracted from CLAUDE.md).
  Scope a nested CLAUDE.md's rules to the module directory it lives in.
- `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md` — project-level overview and rules

If none of these exist anywhere in scope, report exactly: **"No documentation found to
check against."** Do not invent findings.

## CLAUDE.md is rules, not a behavior spec

Treat `CLAUDE.md` (and the files it links) as project **conventions and constraints**, not
feature behavior. Rules it encodes: "use the maven-deps mcp for dependency versions", "don't
add comments to the code", "dependencies point only inward", "run builds via the
maven-build-runner agent", required architectural patterns.

Flag a change that **violates a stated rule**, or a rule the change makes obsolete or
self-contradictory — only rules the change touches, never unrelated ones.

## What counts as a divergence worth reporting

Same high-confidence bar as the bug hunters: report only a concrete doc statement AND a
concrete code fact that contradict each other.

- **Spec contradicted by behavior**: spec says "passwords expire after 90 days", the code
  uses 30; spec describes a flow the code no longer follows.
- **API/contract drift**: a documented endpoint, field, method signature, config key, or
  default value no longer matches the code.
- **todo.md out of sync**: an item marked done that the code doesn't implement, or the
  change implements something the todo/spec still describes the old way.
- **design system violated** (`DESIGN.md` / `ui-design.md`): the changed UI code contradicts documented design tokens or
  component rules (colors, spacing, naming, component states).
- **CLAUDE.md rule violated**: the change breaks a stated project convention or constraint.
- **Undocumented new behavior**: the change adds public/user-visible behavior that the docs
  clearly should mention but don't.

## What NOT to report

A consistency check, not a documentation linter.

- Prose wording, typos, formatting, or stale dates with no behavioral meaning
- Internal code comments — this is about the documentation files above, not comments
- Speculative "the docs could also mention X" when X is internal or trivial
- Anything where you can't cite both a specific doc line and a specific code line that
  conflict — if you're inferring intent, skip it

## Deciding which side is stale

A useful finding says which side to move, not just "these disagree." Reason from what the
change touched:

- If the change **implements new or intended behavior**, the docs are usually the stale
  side → **suggest updating the docs**.
- If the change is a **refactor or bugfix** and the doc encodes a deliberate spec or rule,
  the **code** may have drifted from intent → **suggest updating the code**.
- When it is ambiguous which is authoritative, say so and **suggest confirming intent** —
  never offer both with no recommendation.

## Finding format

Report each divergence in this shape (not the production-bug format):

- **Doc**: file + section/line of the documentation statement, quoted briefly
- **Code**: file + line of the contradicting code
- **Divergence**: the specific mismatch, in one or two sentences
- **Suggested resolution**: `update doc` / `update code` / `confirm intent`, plus a
  one-line rationale for the recommendation

## Scope

You are told the mode:

- **Diff mode (default)**: compare only the changed code against the docs. Flag drift the
  change introduced or exposed.
- **Whole-project mode**: audit the entire resolved code scope against all docs. Used only
  when the scan covers the whole project.
