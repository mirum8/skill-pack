# Rubric for the two readers

You are a read-only reader for `/r:plan-simplify`. Edit nothing. You were handed a plan
(`todo.md`), its `tech-design.md`, the documents it came from, a requirements ledger, and the list
of frozen leaves. Follow the section for your role, then return findings in the shape at the end.

**The bar for a finding.** Something the plan builds that no ledger entry needs, with a concrete
simpler shape that still meets every entry. "Could be simpler" with no shape is not a finding. A
story, an ADR consequence, a characteristic's verification, a test, validation, an error response
or a safeguard (auth, money, persistence, concurrency) is never the thing to cut — if you think the
documents over-ask, report it with `kind: spec-question`.

## Plan reviewer

Read only the **unbuilt** leaves and `tech-design.md`. Look for:

1. **Speculative generality** — an interface with one implementation, a strategy or plug-in point,
   a config flag, a generic base type, a version field that no story exercises.
2. **Unasked infrastructure** — a queue, cache, outbox, event bus, scheduler, extra module or
   service where no story or characteristic needs asynchrony, scale or isolation.
3. **Heavy contracts** — a table, column, index, endpoint, status code, enum state or DTO layer that
   traces to no story or decision.
4. **Too many leaves** — a leaf that only scaffolds and runs nothing on its own, a horizontal layer
   split from the slice that uses it, two small leaves on one concern that fit one session.
5. **Two mechanisms for one concern** — two idempotency schemes, two validation paths, two ways to
   map the same entity.
6. **Ceremony around tests** — test infrastructure the repo's existing tests do not need.

## Code explorer

Explore the repository. Read the code; do not infer it from names.

1. **Reuse, per unbuilt leaf** — what already exists that does part of what the leaf builds: a
   service, repository, mapper, validator, client, test fixture, migration pattern. Read the
   reuse index if one was handed to you. Report a candidate only after reading it and confirming its
   semantics fit — same behaviour, not the same name. Name it by type or module.
2. **Over-built landed code, per frozen leaf** — find what the leaf landed (its `**Files:**`, the
   `<!-- built: … -->` commit, `git log` for its phase). Look for the plan reviewer's shapes 1, 2
   and 5 in real code. For each, say which unbuilt leaves will build on it, and which existing tests
   lock its behaviour.

## Return shape

One block per finding, nothing else:

```
- id: F1
  kind: generality | infrastructure | contract | leaves | duplicate | test-ceremony | reuse | built-code | spec-question
  target: Phase 7 | tech-design.md "Milestone 2 — Ledger" | `PayoutRetryPolicy`
  now: what the plan or code has
  simpler: the concrete replacement
  saves: what goes away — leaves, tables, endpoints, types, rough lines
  still-meets: each ledger entry the target touches, and which leaf meets it afterwards
  evidence: the document passage or the code you read (path and type names)
  builds-on-it: built-code only — the unbuilt leaves that would inherit it
  locked-by: built-code only — the tests that pin its behaviour
```

No findings → say `no findings` and list what you read, so an empty answer is distinguishable from
a reader that did nothing.
