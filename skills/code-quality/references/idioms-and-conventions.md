# Idioms & Conventions

Reviewer focus: **is this written the way code in this language, this framework, and this project is normally written?** Idiomatic code is readable because it meets the reader's expectations — they recognize the pattern instead of decoding a novel one; non-idiomatic code makes a fluent reader stop and ask "why *this* way?"

Two layers, and the project layer wins ties:

1. **Language/framework idioms** — the standard, well-understood way to do a thing in Java/Kotlin/Spring/etc.
2. **Project conventions** — how *this* codebase already does it. **Always check the neighbors first** (skim sibling files, the relevant `CLAUDE.md`). Code that matches the surrounding code is correct even if it isn't your first choice; flag deviations *from the project's own pattern*, not failures to meet an external ideal.

Apply `what-not-to-flag.md` as a hard filter — especially the "respect the local code" and "don't force functional style" sections. When torn, drop it.

## Reinventing the standard library / framework

- Hand-rolling something the platform already gives you, where the standard form is clearer and less bug-prone: a manual null-check chain instead of `Optional`/`?.`, a hand-written map-merge instead of `merge`/`computeIfAbsent`, manual string building where the idiom is `String.join`/a formatter, a custom retry loop where the project already has a retry utility.
- Not using an **existing project helper/abstraction** and re-implementing it inline — the reader expects the established helper and now has to verify the bespoke copy does the same thing. (Find the helper first; only flag if it genuinely exists and fits.)

## Fighting the framework

- Using a framework against its grain: manual transaction handling where `@Transactional` is the project norm, building responses by hand where the project uses a standard mapper, field injection in a codebase that consistently uses constructor injection, bypassing the established validation/error-handling path.
- **Inconsistent with the project's chosen pattern**: the codebase does X one way everywhere and this change introduces a second way to do the same thing, for no reason the reader can see. Two ways to do one thing is a tax on everyone.

## Language-level idioms (flag only when the idiom is genuinely clearer)

- Verbose constructs where a standard concise one is unambiguous and the project uses it: a switch where the project uses enhanced switch/pattern matching, `new ArrayList<>(){{ add(...) }}` double-brace init, raw types where generics are the norm.
- Misused equality/comparison idioms that aren't outright bugs but read wrong: `==` on boxed types, comparing with `.equals` in a project that uses a helper, etc. (If it's an actual bug, it belongs to `/r:code-bugs` — note it briefly and move on.)
- Ignoring established conventions for naming, package placement, or class layout that the rest of the module follows.

## What this is NOT

- It is **not** "rewrite loops as streams" or "make it more functional." Both forms are idiomatic; pick the project's prevailing one and only flag a real outlier. See `what-not-to-flag.md`.
- It is **not** importing idioms from another language. Idiomatic means idiomatic *here*.
- It is **not** style/formatting — a formatter owns that.

## How to judge cost

State the concrete cost to a fluent reader/maintainer:
- Good: "The codebase uses constructor injection everywhere; this field-injected `@Autowired` makes the class harder to test and breaks the pattern every other service follows."
- Bad: "Should use constructor injection — best practice."

If the non-idiomatic code is locally consistent and harmless, let it go.
