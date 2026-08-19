# The document — three levels, one addressable node

## Full shape

```markdown
# Billing — Implementation Plan

Spec: `spec.html` · Sources: `spec.html`, `docs/pricing-prd.md` · Status: draft
Milestones 1–2 deliver v1. Each leaf is scoped to roughly one Claude Code session.
Everything under "Resolve first" needs a person, not an agent.

## Resolve first
- **Debezium against RDS** — can it read our instance, or do we need a polling fallback?
  Owner: platform. Blocks: Phase 7. Timebox: one afternoon. Output: a line in the spec's Risks.

## Waves
<!-- generated from the Depends on edges — regenerate, never hand-edit -->
- Wave 0: Phase 1, Phase 2
- Wave 1: Phase 3, Phase 4, Phase 5
- Wave 2: Phase 6

## Milestone 1 — Ledger
**Design**
- Schema `ledger_entry` — `id uuid primary key`, `account_id uuid not null references account(id)`,
  `amount_minor bigint not null`, `currency char(3) not null`, `created_at timestamptz not null
  default now()`; index on `(account_id, created_at desc)`
- API `GET /accounts/{id}/entries` → `200 {entries: [...]}` · `404` unknown account ·
  `400` malformed page cursor
- Types `LedgerService.append(AppendEntry): EntryId` · amounts are **minor units, never floats**
- Boundaries `ledger` owns both tables; `web` calls the service, never the repository

### Phase 1 — Ledger schema
**Implements:** Record a ledger entry
**Depends on:** —
**Files:** `db/migration/V1__ledger.sql` (new)
**Risk:** money + persistence
- [ ] `V1__ledger.sql` creates `ledger_entry` with `amount_minor bigint not null` and
      `index (account_id, created_at desc)`
- [ ] `LedgerSchemaIT` asserts the index exists and `amount_minor` rejects a fractional value
**Done when:** `mvn -pl ledger test -Dtest=LedgerSchemaIT` is green.

## Milestone 2 — Payouts
...
```

## The three levels

| level | heading | addressable | carries |
|---|---|---|---|
| grouping | `## Milestone N — name` | no | the `**Design**` contracts its leaves share |
| **leaf** | `### Phase N — title` | **yes — one `/r:task-run`** | `Depends on`, `Files`, `Risk`, the checklist, `Done when` |
| item | `- [ ]` | no | one concrete, self-contained piece of the contract |

**Only the leaf is addressable**, and its heading shape is fixed: `### Phase N — title`, numbered
continuously from 1 across every milestone, gap-free, no repeats. `/r:task-run` locates a leaf by
that heading; `/r:plan-run` orders the run by that number; `check_todo.py` enforces both. A
milestone is `##` — writing one as `###` turns a grouping into something an agent will try to build.

## Why the milestone's Design never reaches the implementer

`/r:task-run` resolves `"todo.md / Phase 1"` by locating **that block** and lifting **its** checklist
into acceptance criteria. It does not read upward and follows no links out. So:

- The `**Design**` section is for the human, and for the pass that *derives* leaf items from it.
- A leaf item that points at it ("per the milestone design") arrives as a dangling pointer — the
  contract it names is absent, and the planner re-derives whatever it can.
- Therefore **every item repeats the part of the contract it needs.** Repetition between a
  `**Design**` section and the items it produced is correct, not duplication to factor out. They
  have different readers: one is read by a person deciding whether the design is right, the other
  by a planner that will never see the first.

`check_todo.py` reports items that defer outside their block.

## What a contract is, and is not

**Is** — the detail that survives being written before the code exists:

- **Schema**: column types, nullability, defaults, indexes, unique constraints, foreign keys.
- **API**: method, path, request shape, response shape, and every status code including errors.
- **Types**: signatures, and the invariants that matter.
- **Boundaries**: which module owns what, and what may import what.
- **Tests**: named, with the case each one locks.

**Is not** — and each exclusion has a reason:

- **`file:LINE` references and reuse maps.** For a leaf six weeks out these are imagined, and an
  imagined citation is worse than none because it reads exactly like a real one. `/r:task-run`'s
  planner writes both at execution time with the files open, and its reuse map is explicitly "the
  evidence you explored rather than imagined". Counterfeiting that is the one thing this document
  must never do.
- **Approach prose, algorithms, pseudocode, file-by-file change lists.** A diff plan against a
  codebase that does not exist. By the time leaf 9 runs, the earlier leaves may have ruled the
  approach out — and an implementer following a stale one lands somewhere nobody chose.
- **Anything used by exactly one leaf.** It belongs in that leaf's items. Hoisting it adds a hop
  for the reader and reaches nobody extra.

## Writing an item

An item names the concrete thing and stands alone:

```
- [ ] add idempotency to the payout webhook          <- unbuildable; the planner re-derives everything
- [ ] `V7__payout_idempotency.sql` creates `payout_idempotency` with
      `UNIQUE (merchant_id, idempotency_key)`
- [ ] `POST /webhooks/payout` returns `200 {payoutId}` on replay, `409` when the key is
      reused with a different body
- [ ] `PayoutWebhookIT` covers first call, replay, and concurrent double-post
```

5–12 items per leaf. A deeper plan means **richer items, not more of them** — the leaf is still one
focused session, which is the size `/r:task-run` is built around.

## The graph

`**Depends on:**` is authored on every leaf — the leaves it builds on, or `—` for none. Two rules,
both enforced:

- **A leaf may depend only on lower-numbered leaves.** Numeric order then *is* a valid build order,
  which is what lets `/r:plan-run` run the plan straight down the page and still respect every edge.
- **No two leaves in one wave may name the same file.** They would run at the same time in separate
  worktrees. The fix is an edge between them, which pushes one into the next wave.

**Waves are derived, never authored**: `wave(p) = 0` with no dependency, else `1 + max(wave(d))`.
The `## Waves` block is a generated summary — `check_todo.py` recomputes it and reports a drift,
because a stale summary is worse than none: it is the half a person reads when deciding what to run
at once.

The plan file itself is excluded from the collision check. Every leaf ticks it, so it is shared by
construction, and git merges the ticks — separate leaves edit separate regions of the document.

## Checking it

```sh
python3 "${CLAUDE_SKILL_DIR}/scripts/check_todo.py" docs/<topic>/todo.md --spec docs/<topic>/spec.html
python3 "${CLAUDE_SKILL_DIR}/scripts/check_todo.py" docs/<topic>/todo.md --slice 3,4
```

`--slice` answers a different question: may these leaves run **concurrently**, right now? It reports
only what makes that unsafe — a dependency that isn't built yet, a dependency inside the same slice,
a shared file — and stays quiet about plan quality, because refusing to start concurrent work over a
missing `Implements:` line would be noise at the worst moment. This is `/r:plan-run`'s preflight.
