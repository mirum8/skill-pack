---
description: >-
  Build and maintain a project's reuse index — one tracked reference doc naming the canonical
  example of each pattern the codebase already has, so a later task copies the existing shape
  instead of re-deriving it. Mines the plan corpus `/r:task-run` leaves in `.task-plans/`: every
  plan's "Reuse map" names exemplars its planner found by reading the code, and an exemplar two
  or more plans independently reached for is a convention worth writing down. Verifies each
  anchor against the current tree, groups them by layer, and writes the doc beside the project's
  other reference docs. Re-running merges rather than rebuilds — existing entries keep their
  prose, newly-qualifying ones are added, moved anchors are re-resolved. Use on "build the reuse
  index", "/r:reuse-index", "what patterns do we already have?", "refresh the reuse index",
  "turn the plan corpus into something we can read", "index the canonical examples". NOT for:
  reviewing whether code is readable (`/r:code-quality`), finding defects (`/r:code-bugs`),
  compacting a CLAUDE.md (`/r:claudemd-compact`), or planning a task from a spec
  (`/r:spec-design`).
effort: high
---

# reuse-index

Turn what the project's planners already learned about the codebase into a page someone can read.

Every plan `/r:task-run` writes carries a **Reuse map** — a table of "this pattern already exists,
here, and this is what it gives you", written by an agent that had just read the code for that one
task. Each map is discarded after its task. The corpus of them is the most concentrated record of
the codebase's conventions anywhere in the repo, and nothing reads it.

This skill mines that corpus into **one reference doc**, and keeps it current.

**The threshold is the whole idea.** One plan reaching for a file is a choice made under one
task's pressure. Two plans, written weeks apart, independently reaching for the same file is a
convention. Only the second kind goes in the doc.

## Invocation

- `/r:reuse-index` — mine the corpus, write or merge the index, report.
- `/r:reuse-index --plans <dir>` — a corpus somewhere other than `.task-plans/`.
- `/r:reuse-index --min-cited <n>` — override the 2-plan threshold.
- `/r:reuse-index --dry-run` — report what would change; write nothing.

Read `${CLAUDE_SKILL_DIR}/references/output-format.md` before writing anything. It holds the
section layout, the entry format, the merge rules, and what must be left out.

## Step 0 — Resolve the corpus and the index

Run the mechanical half. It does the extraction, the counting, the path resolution and the diff
against any index that already exists, and it is the only thing that touches the corpus:

```sh
python3 "${CLAUDE_SKILL_DIR}/scripts/reuse-index.py" \
  --plans .task-plans --repo . --index <path-to-existing-index-or-omit>
```

It prints JSON: `corpus`, `candidates` (each with `cited`, `citedBy`, resolved `path`, the
`symbols` its rows named and which of them `symbolsVerified` in the file today), plus `new`,
`countChanged`, `stale` and `unresolved` when an index was passed.

- `{"error": "no-corpus"}` or zero plans → **say so and stop.** There is nothing to mine, and that
  is a finding, not a failure.
- `changed: false` → **say so and stop.** The index is current. Do not rewrite a file to no effect.

Locate the index the way the project would: a reference-doc directory it already tracks and
already points at from its root `CLAUDE.md`; `docs/` only if there is none.

## Step 1 — Read the rows

For each candidate the script kept, read its `rows` — the raw reuse-map cells from every plan that
cited it. This is where the pattern is actually described, in several plans' words. The script can
count them; only you can tell that four differently-worded rows are one pattern, or that one file
is carrying three.

Drop a candidate whose `symbolsVerified` is empty while `symbols` is not: its file survived but the
pattern the plans described is no longer in it.

## Step 2 — Cluster into entries

Entries are **patterns, not files**. Name each one the way a reader would search for it, not after
the class that happens to hold it. Merge rows that say the same thing; split a file that carries
several distinct shapes. Group by layer, from the resolved paths.

## Step 3 — Write or merge

**New index:** write the whole doc per the reference.

**Existing index:** merge — existing entries keep their prose and only their `Cited` refreshes;
`new` entries are added into their section; `stale` anchors are re-resolved from the script's
`candidates` list where that is unambiguous, and otherwise marked and reported. Never delete an
entry silently: a pattern that moved and a pattern that died need opposite responses, and only the
reader can tell which happened.

The doc names no tooling — not `.task-plans`, not the pipelines, not this skill. It describes the
codebase and itself.

## Step 4 — Wire it up, so something actually reaches it

**Add the pointer. An index nothing points at is a file nobody opens**, and the one place every
session already reads is `CLAUDE.md`.

- Root `CLAUDE.md`: add **one line** to its reference list, in that list's existing wording and
  position — e.g. `` - `<path>` — canonical examples to copy, by layer. ``
- A module-level `CLAUDE.md` that already carries a short "examples to copy" list: point it at the
  full set in a sentence. **Never copy entries into it** — a second copy drifts, and the module
  file's own inline examples stay where they are because that file is read on its own.

One line each, nothing more: `CLAUDE.md` is loaded on essentially every turn, so the pointer earns
its place only by staying a pointer. If the file has no reference list to join, say so in the
report rather than inventing a section for it.

Verify the path you wrote resolves before finishing — a broken pointer is worse than none.

## Step 5 — Report

- corpus size, how many plans carried a reuse map, how many candidates met the threshold
- entries written, entries merged, `Cited` counts that moved
- **every candidate that did not make it, and why** — below threshold, file gone, pattern gone,
  or folded into another entry. A silent drop is how an index starts lying about its coverage.
- stale anchors re-resolved, and the ones needing a human

## Non-negotiables

- **The threshold is evidence, not a knob to reach for.** Below it, the doc fills with one-off
  trivia and stops being worth reading.
- **No line numbers in an anchor.** Paths survive refactors; line numbers do not.
- **An unverifiable entry does not go in.** A reader trusts this doc, so a wrong entry costs more
  than a missing one.
- **A refresh never regenerates.** Prose in the doc may have been written by hand; merging is the
  only safe operation on it.
- **Write only on a real change**, so the doc produces no diff when nothing moved.
