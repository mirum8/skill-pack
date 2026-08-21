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
- `/r:reuse-index --rebuild` — ignore the existing index and regenerate it from scratch, a full
  clustering pass that **overwrites** the current doc. This is the merge's escape hatch, for when
  a refresh cannot get you there: adopting a format change (a new column like `Plan`), or a doc
  that has drifted. It discards any prose hand-written into the current doc, so reach for it only
  on a doc you are willing to regenerate — a merge is the safe default and this is the deliberate
  exception.

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

**On `--rebuild`, run the script *without* `--index`** — you are regenerating, not diffing, so the
existing doc's counts are irrelevant and passing it would only surface a `changed: false` you are
about to ignore. Still locate the existing doc (below) so you overwrite it in place, and treat
every candidate as a fresh entry: this is the **New index** path in Step 3, pointed at the old
file. The two stops below do not apply to a rebuild.

- `{"error": "no-corpus"}` or zero plans → **say so and stop.** There is nothing to mine, and that
  is a finding, not a failure.
- `changed: false` → **say so and stop.** The index is current. Do not rewrite a file to no effect.
  (Not on `--rebuild`, which omits `--index` and so never reports this.)

Locate the index the way the project would: a reference-doc directory it already tracks and
already points at from its root `CLAUDE.md`; `docs/` only if there is none. On `--rebuild` this is
also how you find the doc to overwrite.

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

**New index (and any `--rebuild`):** write the whole doc per the reference, overwriting the located
file if one is there. A rebuild is a fresh clustering pass — it keeps no prose from the old doc.

**Existing index:** merge — existing entries keep their prose and only their `Cited` and `Plan`
cells refresh (both rebuilt from the candidate's `citedBy`); `new` entries are added into their
section; `stale` anchors are re-resolved from the script's `candidates` list where that is
unambiguous, and otherwise marked and reported. Never delete an entry silently: a pattern that
moved and a pattern that died need opposite responses, and only the reader can tell which happened.

Each entry carries a `Plan` cell linking the plans that cited its exemplar
(`[<slug>](.task-plans/<slug>.md)`, from `citedBy`) — the trail back to the full task context.
Beyond those links the doc narrates no tooling: it does not explain that it was mined from a
corpus, name the pipelines, or mention this skill. Linking a tracked plan file is a reference; a
sentence about how the index is built would be the tooling describing itself, and that stays out.

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
- entries written, entries merged, `Cited` counts (and their `Plan` links) that moved
- **every candidate that did not make it, and why** — below threshold, file gone, pattern gone,
  or folded into another entry. A silent drop is how an index starts lying about its coverage.
- stale anchors re-resolved, and the ones needing a human

## Step 6 — Record the run

Last thing, after the report — one line into the pack-wide store, so this skill's yield is measured
rather than assumed. It is the only way to answer the question this skill exists for: does a corpus
of plans actually converge on shared patterns, or does every task reach for something new?

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:reuse-index","corpus":0,"plansWithMap":0,"minCited":2,"candidates":0,
 "entriesNew":0,"entriesMerged":0,"citedMoved":0,"staleReresolved":0,"staleNeedingHuman":0,
 "pointerAdded":false,"wrote":false,"dryRun":false,"blockedReason":null,
 "findings":[{"track":"reuse-index","file":"src/main/java/.../DealService.java","verdict":"confirmed",
              "description":"cited by 4 plans — entered as <entry name>"}]}
STATS_JSON
```

One `findings` entry per candidate the script handed you, `verdict: "confirmed"` for the ones that
became entries and `dismissed` for every one you dropped — below threshold, file gone, pattern gone,
folded into another entry — with the reason as the `description`. The dismissals are the more
useful half: a corpus whose candidates are mostly noise and a corpus with nothing in it both write
one line and no entries, and only the verdicts tell them apart.

**A run that could not mine anything records `blockedReason` and NO findings.** `no-corpus`, zero
plans, or a script that failed is an absence of judgement, not a judgement that nothing qualified —
recording it as zero candidates would put "this project has no shared patterns" into the store on
the strength of a directory that was never there. `changed: false` is the opposite case and a real
result: the candidates were judged, the index already said so, and `wrote` is `false`.

Keep each `description` to one line; the payload travels in this step's prompt. The script always
exits `0`: a record that does not get written is a lost record, not a failed run. Never retry it.

## Non-negotiables

- **The threshold is evidence, not a knob to reach for.** Below it, the doc fills with one-off
  trivia and stops being worth reading.
- **No line numbers in an anchor.** Paths survive refactors; line numbers do not.
- **An unverifiable entry does not go in.** A reader trusts this doc, so a wrong entry costs more
  than a missing one.
- **A refresh never regenerates.** Prose in the doc may have been written by hand; merging is the
  only safe operation on it.
- **Write only on a real change**, so the doc produces no diff when nothing moved.
