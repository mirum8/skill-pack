# Readability & Clarity

Reviewer focus: **can the next person read this code and understand what it does and why, without re-reading it three times or stepping through a debugger?** You are the cold reader. Flag the things that made *you* stop and reconstruct intent — those are exactly what will slow down the next maintainer.

Apply `what-not-to-flag.md` as a hard filter. Only report a finding when a thoughtful senior engineer would agree it genuinely improves clarity. When torn, drop it.

## Names that mislead or hide intent

The highest-value clarity findings are usually names. A wrong name costs every future reader.

- **Misleading name**: a variable/method/field whose name says one thing and the code does another — `flag` that actually means "already refunded", `getUser()` that also mutates, `isValid` that returns a count. The reader trusts the name and gets burned.
- **Name that hides a unit or meaning**: `timeout`, `size`, `amount` where the reader can't tell seconds vs ms, bytes vs entries, cents vs dollars — and the surrounding code doesn't make it obvious.
- **Opaque abbreviation / single letter** outside a tiny scope: `procDtaLst`, or `d` living across 40 lines. (A loop index `i`, a lambda `e`, or a math `x` in a 3-line scope is fine — don't flag those.)
- **Boolean that needs the negation decoded**: `if (!isNotReady)`. The double negative makes the reader pause.

## Control flow you have to untangle

- **Deep nesting** where an early return / guard clause would flatten it and make the happy path obvious — but only when it actually reduces the cognitive load, not just to hit a nesting number.
- **Long boolean conditions** packed into one `if` with no naming — extracting the condition into a well-named local (`boolean eligibleForRefund = ...`) often turns a puzzle into a sentence.
- **Flag/mode parameters** that make a method do two different things depending on a boolean — the call site `render(true)` tells the reader nothing.
- **Surprising side effects**: a getter that writes, a method whose main job is hidden behind an innocuous name, state mutated far from where it's read.
- **Inconsistent return shapes**: sometimes null, sometimes empty, sometimes throws, for the same kind of "nothing" — the caller can't reason about it.

## A method doing too much (only when there's a real seam)

- A method that **mixes levels of abstraction** — high-level orchestration interleaved with low-level byte-twiddling — so the reader can't get the gist without reading every line. Flag it when there's a *natural* split (parse / validate / persist), name the seam, and skip it if splitting would just scatter one coherent thought. See `what-not-to-flag.md` on length-as-a-number.
- **Repeated, non-obvious literal or expression** that clearly represents one concept and would read better as a named constant — only when naming it actually aids understanding, not for "no magic numbers" dogma.

## Structure that surprises the reader

- **Leaky abstraction**: a class/method that forces callers to know its internals — e.g., you must call `init()` before `run()` or it silently misbehaves, with nothing signalling the order.
- **Dead-but-shipped scaffolding**: speculative generality, unused parameters, an interface with one implementation and no second caller in sight — noise the reader has to wade through. (This is the *existing* over-engineering case; don't ask the author to add abstraction — flag abstraction that isn't paying rent.)
- **Comment that contradicts the code**: the comment describes old behavior. Either the code or the comment is wrong; the mismatch alone is worth a flag.
- **Inconsistent shape within the same change**: two new methods that do parallel things written in two different styles, so the reader can't pattern-match.

## How to judge cost

For each candidate, state the **concrete reader cost**, not a rule:
- Good: "To learn that `status == 2` means 'refunded', a reader has to find the enum-less constant three files away."
- Bad: "Magic number — violates no-magic-numbers."

If you can't articulate a concrete cost to the reader, it's probably taste — drop it.
