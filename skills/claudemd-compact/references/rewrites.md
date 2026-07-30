# Worked rewrites

One before/after per transformation. Read the one matching the destination you
picked in `patterns.md`.

1. Rigid rule → intent
2. Obvious fact → cut
3. Long section → reference
4. Module rule → nested `CLAUDE.md`
5. Eager `@import` → plain reference
6. Procedure → skill
7. Prose spec → pointer at code
8. Decision log → memory
9. Cross-layer conflict → resolution

Sections **3–6 are the progressive-disclosure family** — the three destinations
that keep a rule while taking it off the always-on path, differing only in what
triggers the reload (a task → §3, a directory → §4, an invocation → §6), plus
§5, the repair for the one link form that *looks* like disclosure and isn't.
Reach for these first. Unlike a cut or a prune they can't lose anything, so they
need no evidence and no argument about whether the content still deserves its
place — the text survives word for word and simply stops being charged every
turn. Most of the size delta in a good compaction comes from this family, not
from deletion.

---

## 1. Rigid rule → intent

The commonest constraint-cost fix. A prohibition stack anticipates the cases its
author thought of and fights the user on the rest; one sentence of intent
generalizes and leaves room for the exception.

**Before**

```markdown
## Comments
- Default to writing NO comments.
- Never write multi-paragraph docstrings.
- Never write multi-line comment blocks — one short line maximum.
- Do not add javadoc.
```

**After**

```markdown
## Comments
Match the comment density and style of the surrounding code.
```

The intent — *don't spray generated commentary over this codebase* — survives,
and the model can still write a real explanation where one genuinely helps.

The same shape applies broadly: "never use `var`; never use streams for more than
two operations; never nest ternaries" → "prefer the plainest construct that reads
clearly at a glance."

**When not to do this:** if the user stated the rule as a preference rather than a
guardrail ("don't add javadocs if I don't ask"), it's a decision, not
over-constraint. Leave it exactly as written.

---

## 2. Obvious fact → cut

Anything the model can read off the file tree or the build files is paying rent.

**Before**

```markdown
## Project structure
This is a Java 21 Spring Boot project built with Maven. Source lives in
`src/main/java`, tests in `src/test/java`. The modules are `core`, `web-adapter`,
`jpa-adapter`, and `telegram-adapter`. We use JUnit 5 and AssertJ for testing.
```

**After**

```markdown
## Architecture
Hexagonal: `core` holds domain logic and defines the ports; the `*-adapter`
modules implement them and may depend on `core`, never on each other.
```

Every deleted sentence was true and freely discoverable. What replaced it is the
part that *isn't* discoverable — the dependency rule you'd only learn by breaking
it. Keep the build command itself if it's non-obvious (a specific profile, a
required flag); drop it if `mvn test` is simply `mvn test`.

---

## 3. Long section → reference

The workhorse of this skill. A section that is correct, wanted, and read on one
turn in twenty is the clearest case there is: it costs its full length every
turn to be useful occasionally.

**Before** — ~55 lines in the root, relevant only when someone touches the
integration suite:

```markdown
## Running the integration tests
The IT suite needs a local Postgres and RabbitMQ:
1. `docker compose -f docker/it.yml up -d`
2. Wait for both healthchecks to go green (~20s).
3. `mvn -Pit verify`

### Troubleshooting
- "connection refused on 5432" — compose binds 5433 on macOS; export `IT_DB_PORT`.
- "ryuk timed out" — set `TESTCONTAINERS_RYUK_DISABLED=true`.
- `OrderFlowIT` flakes — it asserts on wall-clock ordering; rerun before filing.
- ...
```

**After** — three lines in the root:

```markdown
## Testing
`mvn test` runs the unit suite. The integration suite needs Docker services and
has its own setup and troubleshooting — read `.claude/docs/integration-tests.md`
before running or fixing an `*IT` test.
```

with `.claude/docs/integration-tests.md` holding the original text unchanged.

Nothing was judged and nothing was lost, which is why this needs no evidence and
is safe to apply unattended. Note what the surviving sentence does: it names the
**trigger** ("before running or fixing an `*IT` test"), so the model knows both
that the file exists and when it becomes relevant. A bare `see
.claude/docs/integration-tests.md` is a file nobody opens — and an extraction the
model never opens is a deletion with extra steps.

The everyday command stays inline. Disclose the depth, not the thing people need
on every turn.

> The one way to overdo this: extracting a genuinely tiny, genuinely
> always-relevant snippet just to link it. Four lines inline beat four lines plus
> a hop. "Long" is the trigger for this move — not "could theoretically live
> elsewhere".

---

## 4. Module rule → nested `CLAUDE.md`

The cheapest disclosure of all, because the trigger is the file path itself —
nobody has to remember to mention a doc. Rules that only bind inside one module
belong next to that module.

**Before** — in the root, loaded on backend-only turns too:

```markdown
## Frontend
- Templates live in `web-adapter/src/main/resources/templates`.
- HTMX for interactions; no hand-rolled `fetch()`.
- One fragment per component in `fragments/`, named `_component.html`.
- Alpine.js only for local UI state — never for anything the server owns.
```

**After** — the section leaves the root entirely and becomes
`web-adapter/CLAUDE.md`:

```markdown
# web-adapter
HTMX-driven server-rendered UI. Interactions go through `hx-*` attributes rather
than hand-rolled `fetch()`; one fragment per component in `templates/fragments/`,
named `_component.html`. Alpine.js is for local UI state only — anything the
server owns stays on the server.
```

The root keeps nothing: work inside `web-adapter/` picks the file up on its own.

The one thing to check before moving a rule down is **who needs to read it**. A
boundary rule binds the side that would violate it — "`core` must not import
adapter packages" is useless in `web-adapter/CLAUDE.md` and belongs in the root
or in `core/`. Rules about *how this module is written* move; rules about *how
others may use it* don't.

---

## 5. Eager `@import` → plain reference

`@path` recursively pulls the file into context at load time, so it saves
nothing — it relocates text that still loads on every turn.

**Before** — the import drags ~200 lines into every turn:

```markdown
## Error handling
We use a Result monad everywhere. @docs/result-monad.md
```

**After** — the root stays tiny, the detail loads only when relevant:

```markdown
## Error handling
Fallible operations return `Result<T>` rather than throwing across module
boundaries. For the full API and conversion rules, read
`.claude/docs/result-monad.md` when touching error paths.
```

`result-monad.md` doesn't change — only how it's linked, and the link gained the
trigger it needs (§3). This is a pure win and counts as compaction even if
nothing else moves.

---

## 6. Procedure → skill

A multi-step routine with its own trigger is a skill wearing a CLAUDE.md
costume. Inline, it loads on every unrelated turn; as a skill it loads when
invoked and can carry its own progressive disclosure.

**Before** — 40 lines in the root, loaded whether or not anyone is shipping:

```markdown
## How to verify a change before shipping
1. Run `mvn -pl core test` first — it's fast and catches most breakage.
2. Then the full `mvn verify` including Testcontainers integration tests.
3. Check the Flyway migration applies cleanly against a fresh schema...
4. ...
```

**After** — one line in the root:

```markdown
- Verifying a change before shipping: load the `verify-change` skill.
```

plus a real `.claude/skills/verify-change/SKILL.md` whose description names the
triggers ("verify my change", "am I ready to ship", "run the pre-ship checks").

Propose this when the content has a clear trigger *and* steps of its own. A rule
with no procedure attached is not a skill — it's a rule. And *propose* is the
word: unlike the other three disclosures, a new skill lands outside the repo
where `git revert` can't reach it, so `--auto` reports this one instead of doing
it.

---

## 7. Prose spec → pointer at code

Code is a higher-fidelity spec than prose about code, and it can't drift.

**Before**

```markdown
## Webhook payload
The webhook body has `id` (string), `type` (one of `created`, `updated`,
`deleted`), `occurredAt` (ISO-8601 UTC), and an optional `payload` object whose
shape depends on `type`. Unknown types must be ignored, not rejected...
```

**After**

```markdown
## Webhook payload
Shape and the ignore-unknown-types rule are pinned by
`WebhookPayloadTest` — read it before changing the contract.
```

The test already states every rule the prose stated, executably. The same applies
to design: an HTML mockup beats a description of a layout, and an existing
function beats a paragraph about what the new one should look like.

---

## 8. Decision log → memory

History explains why something is the way it is. It's worth keeping — just not in
always-on context, where it competes with instructions.

**Before**, in CLAUDE.md:

```markdown
## Decisions
- 2026-03: Moved off Redis; the cache hit rate never justified the operational
  cost, and Caffeine covers the hot path. Revisit if we go multi-node.
```

**After** — the CLAUDE.md entry disappears; the fact moves to
`~/.claude/projects/<project-slug>/memory/no-redis-cache.md`:

```markdown
---
name: no-redis-cache
description: Why this project uses Caffeine instead of Redis, and when to revisit
metadata:
  type: project
---

Redis was removed in March 2026 — the hit rate never justified the operational
cost, and Caffeine covers the hot path. Revisit only if the app goes multi-node.
```

with a one-line pointer added to that directory's `MEMORY.md`.

Keep the *rule* in CLAUDE.md if one exists ("cache with Caffeine, don't add a
network cache") — move the *story* to memory. Dated entries, meeting notes, and
"we tried X and it didn't work" are all memory.

---

## 9. Cross-layer conflict → resolution

Two live instructions that disagree force the model to litigate before it acts.
Surface both with their locations; which one wins is the user's call.

**Found:**

- root `CLAUDE.md`: "Document every public method with javadoc."
- `~/.claude/CLAUDE.md`: "Don't add javadocs if I don't ask."

**Present it as a question, not a fix:**

```
Conflict — javadoc:
- CLAUDE.md:31 says document every public method.
- Your global ~/.claude/CLAUDE.md says don't add javadoc unless asked.
These can't both hold. Which wins for this project?
```

Resolve it only once the user answers. If the project rule wins it should say so
explicitly ("javadoc on public API here, overriding my global default") so the
next reader doesn't re-open the same question.

The same treatment applies to a project rule that contradicts a skill, or two
nested `CLAUDE.md` files that disagree about the same directory.
