# The entry, the stamp, and what each outcome records

`SKILL.md` carries the steps. This file carries the shapes — what an entry looks like before and
after, and what has to be true of a `Resolved:` line for the record to be worth keeping.

## Contents

1. The entry
2. Migrating a plain bullet
3. The `Resolved:` stamp
4. A decision, and what makes one recoverable
5. A person's entry
6. What is left outstanding
7. What never gets written

---

## 1. The entry

`/r:spec-design` writes one bullet per blocker, above the milestones:

```markdown
## Resolve first
- [ ] **Debezium against RDS** — can it read our instance, or do we need a polling fallback?
      Owner: platform. Blocks: Phase 7. Timebox: one afternoon. Output: a line in the spec's Risks.
```

Five parts, and `resolve_scope.py` reads each by name:

- **the checkbox** — what makes the entry closable at all. `/r:plan-run` gates on unticked entries.
- **the bold subject**, then the question after an em-dash.
- **`Owner:`** — who, or which function, is on the hook. An entry with no owner is one nobody will
  close, which is why the checker reports it.
- **`Blocks:`** — the phases held up, as `Phase N`, comma-separated. **This is the only edge.** A
  phase number in the subject line is part of the subject; nothing else in the entry makes an edge.
  An entry whose `Blocks:` is missing or names no phase blocks the **entire run list**, because
  there is no way to tell what it was guarding.
- **`Timebox:`** and **`Output:`** — how long a probe may spend, and where the answer is supposed to
  land. `Output:` is what Step 6 reports as outstanding when it names a file this skill does not own.

## 2. Migrating a plain bullet

Plans written before the checkbox shape carry:

```markdown
- **Debezium against RDS** — can it read our instance, or do we need a polling fallback?
      Owner: platform. Blocks: Phase 7. Timebox: one afternoon. Output: a line in the spec's Risks.
```

There is nothing to tick, so the entry can never be closed and the gate can only ever fire. The
migration is one edit — add `[ ] ` after the marker — and it changes nothing else about the line.
Do it for every entry in `legacyShape`, including ones this run does not resolve: an entry left in
the old shape is one the next run has to migrate before it can close it.

Reading a plain bullet as *settled* is the alternative, and it would close every pre-existing entry
in every plan at once, silently, on first run.

## 3. The `Resolved:` stamp

A tick alone says somebody closed it. The stamp says what they decided, and it is the only record
the plan keeps:

```markdown
- [x] **Debezium against RDS** — can it read our instance, or do we need a polling fallback?
      Owner: platform. Blocks: Phase 7. Timebox: one afternoon. Output: a line in the spec's Risks.
      Resolved: 2026-09-03 — polling fallback; Debezium needs a superuser role RDS won't grant.
      Alternative: logical replication. Outstanding: the spec's Risks line.
```

- **`Resolved:`** — an ISO date, then the decision in one clause, then the **force that settled
  it**. "Polling fallback" alone is an outcome nobody can check later; "Debezium needs a superuser
  role RDS won't grant" is the reason, and it is what a reader needs when the question comes back.
- **`Alternative:`** — what else was live. Optional only when there genuinely was nothing else: a
  question with one possible answer was never a decision.
- **`Outstanding:`** — present only when the entry's `Output:` still owes somebody a write.

A tick with no `Resolved:` line is reported by `resolve_scope.py --check`. It is treated as closed
for gating — somebody clearly closed it — and named, because the plan now records that a decision
happened and nothing about what it was.

**The stamp is the single record.** It is not duplicated into `design.md`: that file is replaced
wholesale by a `/r:spec-design` rewrite, which is exactly the follow-up a resolution triggers, and
two copies of one decision drift apart with nothing to notice.

## 4. A decision, and what makes one recoverable

Write the force, not just the outcome — the constraint, the measurement, or the preference that
decided it. This is the same rule `/r:spec-brainstorm` applies to its `## Decisions` log
(`interview.md` §10): a decision recorded without what settled it has lost the thing that made it
worth recording, and a later reader cannot tell a considered choice from a coin flip.

Three shapes arrive here, and all three are decisions:

- **The probe answered it and the user agreed.** The force is what the probe found, cited.
- **The user chose against the recommendation.** Their reason is the force; the recommendation is
  the alternative.
- **The user said "I don't know".** The recommendation is taken, and the stamp says so —
  `Resolved: 2026-09-03 — polling fallback (recommended; not contested).` A default recorded as a
  decision reads as more agreement than there was.

## 5. A person's entry

Closed only by the user saying it is done, and the stamp records that this is what happened rather
than something anyone worked out:

```markdown
      Resolved: 2026-09-03 — countersigned, confirmed by the user. Owner: legal.
```

An entry whose kind is `unclassified` is treated as one of these. It fails toward the outcome that
cannot be closed by asking a model, because the cost of the two mistakes is not symmetric: a
decision wrongly filed as paperwork waits for a human who says "just decide it", while paperwork
wrongly filed as a decision gets closed by an interview and the plan then claims a contract exists.

## 6. What is left outstanding

The entry's `Output:` names where the answer is supposed to land, and it is usually a file this
skill does not own — the spec's Risks, an ADR, a doc elsewhere. Report those as outstanding, by
file, and leave them alone. `spec.html` belongs to `/r:spec-brainstorm` and its `ADR-<n>` ids are a
shared space; an unrequested edit there is a second writer of a document with one.

The `Outstanding:` field on the stamp is what keeps that visible after the terminal has scrolled
away.

## 7. What never gets written

- **A tick nobody authorised.** Not from `--yes` on a `person` entry, not from a probe, not from a
  session with no human in it.
- **A new entry.** This skill closes entries; it does not open them. Work that turns up while
  resolving one belongs in the report, and in the plan only through `/r:spec-design`.
- **Anything outside the section.** No phase block, no phase item, no `## Waves`, no renumbering.
- **A resolution that names no force.** If you cannot write why, the entry is not resolved yet.
