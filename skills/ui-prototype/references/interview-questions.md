# The direction interview

**Short, and it stays short.** `/r:spec-brainstorm` interviews to decide what to build and takes as
long as that needs. This one decides only what it should look like, and everything it asks about is
something a person answers in a sentence. Five questions is the ceiling; three is common.

Ask what the repo cannot answer, and read the rest. `docs/<topic>/spec.html` already carries the
audience and the architectural characteristics; an existing stylesheet already carries the palette
someone is living with. Asking again produces a second answer that nothing reconciles with the
first.

## The questions

**1 — What is it, in a sentence, and who opens it?** The Overview section is written from this.
"An internal ledger for two finance people" and "a public signup page" want opposite answers to
every question below, and neither is guessable from the code.

**2 — What should it feel like?** Push for a pair of adjectives and, if it comes easily, a thing it
should *not* feel like. "Calm, precise, not playful" is a brief. "Modern and clean" is not — it is
what everyone says, and it constrains nothing. If that is the answer, ask what product they would
be happy to be mistaken for.

**3 — Anything fixed?** An existing brand colour, a licensed typeface, a logo, a corporate palette,
an accessibility floor above AA. These are constraints, not preferences: a candidate that violates
one is wasted work, so ask before writing rather than after.

**4 — Dense or spacious?** One question, and it decides the spacing scale, the type scale and half
the Layout section. A ledger someone stares at all day and a marketing page want opposite answers.

**5 — (terminal only) Which terminals must it work in?** This sets `terminal.colorDepth`, and it is
the one question with a wrong answer that ruins the rest: authored at truecolor and run at 16, a
certified contrast ratio stops being true. Ask for the least capable target, not the one they
develop in. See `tui-mapping.md`.

## What not to ask

- **Which colours they want.** They will name one, and three candidates become one candidate in
  three shades. Ask for the feeling; propose the colour.
- **Anything already in the spec.** Users, scale, platform, features.
- **Anything already in the code.** If a stylesheet declares custom properties, that is a
  candidate, not a question.
- **Permission to proceed.** Write the three, then show them.

## Where the answers land

Question 1 and 2 become the **Overview** section, near-verbatim — it is the one section written for
a human rather than a parser, and the user's own words for their product are better than yours.
Question 3 becomes fixed token values and a line in **Do's and Don'ts**. Question 4 sets **Layout**
and the type scale. Question 5 sets `terminal.colorDepth` and constrains **Colors**.

If the user has no opinion on any of it, that is an answer: say you are choosing, make the three
genuinely different so the choice is a real one, and let the comparison page do the asking.
