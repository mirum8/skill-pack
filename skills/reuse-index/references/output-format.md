# The index doc — layout, entry format, and merge rules

## What the doc is

One tracked reference page per project answering a single question: **what is the existing
precedent for X here?** A reader who finds their pattern in it stops searching; a reader who
does not falls back to a normal search having lost a few seconds. That asymmetry is the whole
design — a wrong entry costs far more than a missing one, so an entry that cannot be verified
does not go in.

## Where it goes

Prefer a reference-doc directory the project already tracks and already points at from its root
`CLAUDE.md`. Only fall back to `docs/` when there is no such directory. Never write it somewhere
git ignores — an index nobody's teammates receive is a private note, not a project document.

## Reaching it

The doc is wired in on the run that creates it: one line in the project's root `CLAUDE.md`
reference list, and — where a module-level `CLAUDE.md` already carries a short "examples to copy"
list — one sentence pointing that at the full set. Never copy entries into either; a second copy
drifts from the first, and the whole point of one index is that there is one.

## Voice

The doc describes **itself and the codebase**. It never mentions the plan corpus it was mined
from, the pipelines, or this skill. A file written into someone's repo describes what it is, not
the tooling that produced it. Its own header says it is a hand-maintained reference and how to
add an entry, in the register of the project's other reference docs.

## Sections

Group by where the exemplars actually live, computed from the resolved paths rather than a fixed
list — a project without a web layer must not get an empty "Web layer" heading. Typical grouping
for a Maven multi-module JVM project:

- Web layer — controllers and HTTP shapes
- Templates and fragments
- Core — domain services, ports, selectors
- Persistence — repositories and migrations
- Tests — harnesses and fixtures
- Cross-cutting — security, config, files

Order sections by entry count, densest first. Order entries within a section by `Cited`, then
alphabetically by pattern.

## Entry format

```markdown
| Pattern | Canonical example | Reach for it when | Cited |
|---|---|---|---|
| Race-free native upsert | `jpa-adapter/.../calculator/CurrencyRateJpaRepository` — `on conflict … do update` | A write two requests can race | 4 |
```

- **Pattern** — what the reader is looking for, in their words, not the file's. "Race-free native
  upsert", never "CurrencyRateJpaRepository".
- **Canonical example** — path, then an em dash, then the symbol that carries the pattern:
  a method, a class, a fragment name, a selector. **No line numbers.** In a reference corpus of
  922 anchors, 95% of paths still resolved while the line numbers had drifted throughout, so a
  line number is a promise the doc cannot keep. Elide long middle segments with `/.../`.
- **Reach for it when** — the situation, not a restatement of the pattern. This is the column a
  reader scans.
- **Cited** — how many distinct plans independently reached for this exemplar. It is the evidence
  for the entry's presence and tells a future editor which lines are load-bearing.

**Entries are patterns, not files.** One file often carries several: a controller can supply the
download plumbing, the logging style, and the repopulate-the-view-after-catch shape as three
separate entries. Equally, several plans describing the same thing in different words are one
entry, worded once.

## Merge rules for a refresh

The doc is its own state file — the anchors and the `Cited` counts are all a refresh needs, so
there is no marker file and nothing that can fall out of sync with it.

1. **Existing entries keep their prose.** Only `Cited` is refreshed. Hand edits survive, always.
2. **New entries** are the ones that crossed the threshold since the last pass. This is the only
   part that needs judgment, and on most refreshes it is empty.
3. **Stale anchors are fixed where possible, reported otherwise.** When the symbol re-resolves
   unambiguously elsewhere in the repo, update the anchor. When it is ambiguous or gone, leave the
   entry, mark it, and name it in the report. Never delete silently — a pattern that moved and a
   pattern that died need opposite responses, and only the reader can tell which happened.
4. **Write only if something changed.** A refresh that finds nothing new leaves the file
   byte-identical, so it produces no diff and no commit noise.

## What does not go in

- An exemplar the threshold rejects. One plan reaching for a file is a choice; two independently
  reaching for it is a convention.
- An entry whose file resolves but whose named symbol is nowhere in it — the pattern was
  refactored away and the file merely survived.
- Trivia a grep answers faster than an index does: where one icon glyph or one string constant
  lives.
