# What NOT to Flag — the anti-dogma guard

Read this before you report anything. Both reviewers apply it as a hard filter. The goal of the whole skill is to surface the handful of changes that genuinely help the next reader — and to stay silent about everything else. A tool that flags taste is a tool people learn to ignore.

## The one test

For every candidate finding, ask: **would a thoughtful senior engineer, looking at this, agree the change makes the code meaningfully easier to read or maintain?**

If the honest answer is "it's a matter of preference," "it's the rule but it doesn't actually help here," or "both forms read fine" → **drop it.** When genuinely torn, drop it. A false positive here costs more than a missed minor nit, because it erodes trust in every other finding.

## Clean-code dogma to NOT enforce

These are the classic rules that get applied mechanically and do more harm than good. Do not flag code for any of them on its own:

- **Method/class length as a number.** A clear 40-line method that does one coherent thing is fine. Only flag length when the method actually does *several unrelated things* and there's a real seam to split along — and then the reason is "it mixes parsing, validation, and persistence," never "it's over N lines."
- **"Every method must be tiny."** Splitting one readable method into five one-liners that are only called once usually makes code *harder* to follow — the reader now hops between fragments to reconstruct one thought. Don't.
- **"Comment everything" / "add Javadoc."** This project's convention is *no* unnecessary comments and no Javadoc unless asked. Never suggest adding comments to explain code; if code needs a comment to be understood, the fix is clearer code or a clearer name, not a comment. (Do flag a comment that actively *lies* about what the code does.)
- **Parameter-count rules** ("never more than 3 params") applied blindly. Many params can be a smell, but a data-carrying call with 5 clearly-named args is fine; only flag it if grouping them into an existing/obvious type genuinely clarifies call sites.
- **Forcing functional style.** A plain `for` loop is not worse than a stream, and a stream is not worse than a loop. Suggest one over the other only when it removes real noise or a genuine bug-prone pattern — never for "more functional" or "more declarative."
- **DRY taken to an extreme.** A little duplication is better than the wrong abstraction. Don't demand extracting a shared helper for two superficially-similar blocks that may diverge; only flag duplication that is clearly the same logic and clearly should change together.
- **"One assertion per test," "no magic numbers ever," "Hungarian notation," and similar rote rules.** Skip.
- **Premature abstraction / speculative generality.** Don't ask for interfaces, config flags, or extension points "for the future." YAGNI. (Flagging *existing* speculative generality as noise is fair game — see readability.)

## Out of scope for this skill (route elsewhere, don't report here)

- **Bugs / correctness / edge cases** → `/r:code-bugs`. If you spot a genuine bug while reading, mention it briefly as a note, but it is not this skill's deliverable.
- **Security issues** → `/r:code-bugs`' security hunter.
- **Performance** (N+1, unbounded fetch) → that's `/r:code-bugs`' performance category.
- **Things only a compiled static analyzer should catch** (dead code a compiler flags, library-version lints) → `/sonar`.
- **Pure formatting / whitespace / import order** → a formatter's job, not a review's.

## Respect the local code

- **Match the codebase, not your preference.** If the surrounding code consistently does something a certain way, code that matches it is *correct* even if you'd personally write it differently. Only flag a convention deviation when the new code breaks *from* the project's own established pattern, not when it fails to meet an external ideal.
- **Don't relitigate settled design.** If a pattern is used widely across the project, a single new use of it is not the place to argue against it.
- **Assume competence.** The author had context you don't. If something looks odd but plausibly intentional, give it the benefit of the doubt or phrase the finding as a question, not a verdict.

The win condition for this skill is a **short, high-trust report** — or an honest "this reads well." Length is not a measure of thoroughness here; precision is.
