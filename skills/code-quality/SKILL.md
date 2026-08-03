---
description: >-
  Report-only review of how READABLE and IDIOMATIC code is — the human-judgment layer a static
  analyzer can't do. Flags code that is correct but hard to read or follow: confusing or
  misleading names, control flow you have to re-read to understand, a method doing five things,
  surprising structure, leaky abstractions, and code that ignores the language/framework idioms or
  the project's own conventions. Deliberately anti-dogma: it does NOT enforce clean-code formality
  (tiny-method rules, "comment everything", one-assertion-per-test) and only surfaces changes a
  senior dev would agree make the code genuinely clearer. Use on "review code quality", "is this
  readable?", "/r:code-quality", "check readability", "does this follow best practices/our
  conventions?", "is this idiomatic?", "code smell check", or as the readability step in a
  post-task review. NOT for: finding bugs / correctness defects (that's /r:code-bugs), mechanical
  static-analysis findings that need compiled bytecode (that's /sonar), applying cleanups (that's
  /simplify or /r:code-refactor), or security (that's /security-review). This skill only REPORTS —
  it never edits code.
---

# Code Quality

A focused, report-only review of whether code is **easy for the next human to read and change**, and whether it follows the **idioms of the language/framework and the conventions already in this codebase**.

This is the judgment layer that the rest of the review stack can't cover. `/r:code-bugs` hunts for things that are *broken*; `/sonar` runs a mechanical static analyzer over compiled bytecode; `/simplify` and `/r:code-refactor` *apply* changes. None of them answer the question this skill exists for: *"if a teammate opened this file cold, would they understand it quickly — and is it written the way code in this project (and this language) is normally written?"* That question needs a reader, not a linter.

## The bar: clarity wins, not clean-code theater

The single most important thing about this skill is **what it refuses to flag**. Most "code quality" tools fail by drowning the real signal in dogma — splitting a clear 30-line method because "methods should be tiny," demanding a comment on every field, rewriting a fine loop into a stream because streams are "cleaner." That noise trains people to ignore the tool.

So hold every finding to one test: **would a thoughtful senior engineer, seeing this, agree the change makes the code genuinely easier to read or maintain?** If it's a matter of taste, a rule applied for its own sake, or a change that trades one readable form for an equally readable one, **drop it**. A short report of real clarity wins is worth far more than a long list of nits. Read `references/what-not-to-flag.md` — it is not an appendix, it is half the job.

## Phase 1: Scope Resolution

Decide what code to review:

1. Parse the request:
   - **Diff / "my changes"** (the default in a post-task context): review the working-tree changes — `git diff` (and `git diff --cached` if staged). When invoked as part of a review routine, review the **full changed files**, not just the diff hunks, so a method's clarity is judged in its real context — but keep findings on lines that actually changed unless a changed line makes a pre-existing problem materially worse.
   - **Specific class/file**: review that file in full.
   - **Package/module**: review the source files in that package.
   - **Whole project**: only when explicitly asked — review the source tree (exclude tests unless asked, generated code, build output).
2. If scope is ambiguous, use `AskUserQuestion` to clarify before proceeding.
3. Use `Glob`, `Grep`, and `git` to resolve the actual files.

Before reviewing, **learn the local conventions** — skim a few neighboring files (or the relevant `CLAUDE.md`) so "idiomatic" and "follows project style" mean *this* project, not a generic ideal. Code that matches the surrounding code is usually right even when it wouldn't be your personal first choice.

## Phase 2: Review

Launch **two reviewers in parallel** as subagents, each owning one lens and reading **only its own reference file plus the shared guard**. Splitting the work keeps each reviewer focused and gives two independent reads:

- **Reviewer A — Readability & clarity** → reads `references/readability-and-clarity.md`
- **Reviewer B — Idioms & conventions** → reads `references/idioms-and-conventions.md`

**Both reviewers must also read `references/what-not-to-flag.md`** and apply it as a hard filter before reporting anything. This is what keeps the skill from becoming a nit machine.

Give each reviewer the scope from Phase 1 (the file list and `git diff` for diff scope) and tell it:

- Read the actual source — enough surrounding code to understand intent, not just the changed lines.
- This is a **discovery read for clarity**, not a bug hunt and not a fix pass. **Report only — never edit.**
- Apply the local-conventions context from Phase 1: prefer "matches how this codebase writes things" over abstract ideals.
- For each finding, return: `file:line`, what's unclear or non-idiomatic, **why it costs the reader** (the concrete cost — "a reader has to scan the whole method to learn `flag` means 'already refunded'"), and a short suggested direction. The direction is a hint, not a patch.
- Hold every finding to the senior-engineer bar above and the `what-not-to-flag` filter. When in doubt, drop it.

For a small diff or a single file, running the two lenses in one reviewer (or inline) is fine — the parallel split earns its cost mainly on modules and larger scopes. Scale to the work. **As a concrete cutoff: a single changed file → run both lenses inline; use the risky parallel join only when the scope is large enough that two independent reads pay for it.**

**If you have no `Agent` tool, run both lenses inline and say so.** Since Claude Code 2.1.217 subagents can't spawn, so when this skill is invoked inside one — which is how `/r:task-review` drives it — the split simply isn't available. That's a mild loss here (two lenses over one diff, not five hunters), so just work through both reference files yourself, still applying `what-not-to-flag` as the hard filter, and note it in one line at the top of your report: *"Both lenses run inline in one context."* Label it rather than leaving the reader to assume two independent reads happened.

### Subagent-flow contract (don't hang on a stalled reviewer)

A subagent's result is the value the `Agent` tool returns (its final message); that return **is** the completion signal — when it arrives the subagent is done. Never wait on, re-check, or poll a subagent that has already returned, and never invent a side-channel done-marker / output-file / status-file to watch (no `Monitor`, no file-mtime polling) — inventing such a protocol is what makes a coordinator hang for minutes on a subagent that already finished. If a reviewer comes to rest **without a usable result** (it died, returned nothing, or stalled past a short bounded wait), re-dispatch it — same lens, scope, prompt — bounded to **2 re-dispatches**; after that, stop and say which one is blocked. Never silently proceed without it and never keep waiting.

If after the bounded re-dispatch a reviewer still doesn't return, **proceed with the surviving reviewer's findings** and add an explicit "the &lt;lens&gt; reviewer did not return" note to the report, rather than blocking on the join.

## Phase 3: Report

1. Collect findings from the reviewers that returned (per the subagent-flow contract above — if one never returned after its bounded re-dispatch, proceed with the survivor and carry the "did not return" note into the report). Deduplicate (the same line often shows up under both lenses — merge into one entry), and drop anything that doesn't clear the bar.
2. Group findings by impact, not by reviewer, so the reader sees the important things first:
   - **Worth fixing** — real clarity or maintainability wins: a misleading name in a hot path, a method that genuinely needs splitting along a real seam, a non-idiomatic construct that will trip up the next maintainer.
   - **Minor / optional** — small, low-stakes improvements the author can take or leave.
3. For each finding present:
   - **File & line**: exact location.
   - **What** : the unclear or non-idiomatic code.
   - **Why it costs the reader**: the concrete readability/maintainability cost — not "this violates rule X."
   - **Suggested direction**: a brief sketch of a clearer form (not a full rewrite).
4. If the code reads well, **say so plainly and stop** — "No meaningful clarity issues; the changes are readable and idiomatic." Do not pad the report to look thorough. An honest empty report is the correct, valuable outcome for clean code, and it's what keeps the skill trustworthy.
5. This skill stops at the report. It does **not** edit code. Applying the findings is `/r:code-refactor`'s job — it locks behavior with a test first, then changes form safely, which is exactly what a readability/idiom fix needs. Hand it the confirmed findings if the user wants them applied.

## Record the run

Last thing, once the report exists. One line into the pack-wide store, so this skill's yield is
measured rather than assumed — counts only, never finding text:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:code-quality","scope":"diff|all|explicit","reviewers":0,"reviewersLost":0,"worthFixing":0,"minor":0}
STATS_JSON
```

An honest empty report records `0` and `0` — that is the outcome this skill exists to be able to
give, and the store has to be able to show it happening. The script always exits `0`: a row that
does not get written is a lost row, not a failed review. Never retry it.
