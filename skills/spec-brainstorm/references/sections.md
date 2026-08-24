# Document sections

This file owns which parts and sections exist and what each must contain.

## Contents

1. The seven parts
2. How to choose what goes in them
3. Part 1 — Business requirements
4. Part 2 — Domain
5. Part 3 — Architectural characteristics
6. Part 4 — Logical components
7. Part 5 — Architectural style
8. Part 6 — Decisions
9. Part 7 — Technical details
10. The closing section
11. Added by `--explain`
12. Cross-references — what points where
13. Section smells

---

## 1. The seven parts

The document is read **top-down**, and the order is the point: each part is the summary of
the one after it, so a reader can stop at any part boundary and hold a true picture — coarser
than the one below it, never a wrong one.

| Part | Answers | Sections |
|---|---|---|
| **1 · Business requirements** | what has to become true, and for whom | Problem, goals & non-goals · Actors · User stories · The v1 line |
| **2 · Domain** | what the words mean and what the rules are | Domain model · Key flows |
| **3 · Architectural characteristics** | what the architecture is being optimised for | Driving characteristics · Supporting · What we are not optimising for |
| **4 · Logical components** | what the pieces are and what each owns | The component cut · Component diagram |
| **5 · Architectural style** | how the pieces are arranged and deployed | The style · Topology · How components talk · Context/container diagram |
| **6 · Decisions** | why it is this and not the obvious alternative | ADR-1 … ADR-n |
| **7 · Technical details** | with what | Technologies · API · Rollout |
| *closing* | what could still be wrong | Risks, assumptions & open questions |

Read the chain backwards and you can see why any other order reads as a wall: components
make no sense before you know what the architecture is optimising for, and the style makes no
sense before you know what components it is arranging.

**The seven parts always exist. The sections inside them do not.** "A section with nothing
real to say is deleted, not padded" is unchanged and it is still what makes this document fit
a weekend tool and a work system without ever asking which. But a weekend tool has all seven
parts: it has requirements, a domain, a characteristic it is being optimised for (a terminal
client's is *start in under a second*), components, a style (one binary), decisions, and
technologies. A part reduced to three sentences is a correct part. A part **deleted** leaves a
reader unable to tell whether the question was answered badly or never asked at all.

**Every part opens with a lede** — 2–4 sentences saying what this part settles. Write the seven
ledes last, from what the parts actually ended up saying, and then read them alone: they must be
a true summary of the whole document. That test is the cheapest quality check here, and a lede
that lists the sections below it instead of summarising them has failed it.

---

## 2. How to choose what goes in them

Start from §§3–9. Add the `--explain` sections from §11 when the flag was passed. That is the
whole rule — there are no tiers, no depth, no size bands.

Merging neighbouring **sections** is always allowed; dropping a **part** is not. What is never
allowed anywhere is a heading followed by a restatement of the heading. Ten sections of "the
system will follow industry best practices" make a document worse than one that omits them,
because they hide the real content.

Draft the part-and-section plan before writing any HTML, and say in one line how you read the
project: *"Reading this as a small internal tool — no integrations, no operations section, and
Part 5 is two paragraphs because there is one binary. Say if that's wrong."*

**The ceiling.** This document describes requirements, the domain, characteristics, components,
the style, the decisions, technologies and the API. It does not go below that: no column types,
no indexes, no code, no build order, no step-by-step walkthrough. Everything one level down —
the schema with real types and indexes, the endpoint signatures, the build order — is
`/r:spec-design`'s job; writing the code is `/r:task-run`'s. A section that starts specifying
`VARCHAR(255)` has left this document's altitude and is writing `spec-design`'s design pass a
day early, from less evidence.

---

## 3. Part 1 — Business requirements

What has to become true, said in the business's words, before any of it is architecture.

| Section | Must contain |
|---|---|
| Problem, goals & non-goals | Who hurts today and how much · 3–7 goals **each with a metric** · 3–8 non-goals **each with a "revisit when"**. Non-goals are the cheapest section to write and the best defence against gold-plating. |
| Actors | Who acts on the system, what each wants, and what each may authorise. One line each in the default mode; the full table under `--explain` (§11). |
| **User stories** | See below. Grouped by actor, each with acceptance criteria. |
| The v1 line | Which stories ship first and which are deferred, **as capabilities, not phases**, and why the line falls there. `/r:spec-design` turns this into an ordered plan; writing phases here would create a second one. |

### User stories

The unit of scope, and the handle `/r:spec-design` builds phases against. **Grouped by actor**,
each in the same shape:

> **Match an invoice against its receipt**
> As an **AP clerk**, I want an arriving invoice matched against its goods receipt and
> purchase order automatically, so that I only look at the ones that disagree.
> *Given* an invoice for PO-4471 within tolerance of its receipt, *when* it is imported,
> *then* it moves to `matched` and no task is created for a human.

Three rules:

- **The name is the handle, and in the HTML it is an `<h3>`.** One `<h3>` per story inside the
  User stories section, nothing else at that level. It must be unique in the document, and it is
  what a phase's `Implements:` line carries verbatim — `scripts/check_spec.py` and
  `/r:spec-design` both read the `<h3>` text. Keep names stable across a `--continue`; new
  stories append.
- **Every story has acceptance criteria** in Given/When/Then. A story without them is a wish,
  and `scripts/check_spec.py` reports it.
- **A story states a need, not a solution.** "As a clerk I want a Kafka topic" is not a story.

Stories that are deferred are still written; the v1 line is what separates them.

---

## 4. Part 2 — Domain

What the words mean and which rules are not allowed to break. A developer new to this industry
must read this part and then understand why Parts 4–7 are what they are.

### Domain model

1. **Entities and relationships** — an ER-shaped SVG plus a short table: entity · what it is ·
   **do we own it or is it a copy of another system's record** · what identifies it across
   systems. Ownership is the line that decides half the architecture; state it explicitly.
   No column types here — that is below this document's ceiling.
2. **Lifecycles** — the states each core entity moves through and its **terminal states**. An
   entity without a terminal state is a leak. Draw the two or three that matter; write the
   rest as `a → b → c` lines.
3. **Invariants** — the rules that must never be violated. Each needs all five parts, or it is
   not testable: **trigger · condition · outcome with units · scope (per what) · behaviour on
   violation.** Plus where it comes from, and whether it is configurable.

   > **When** a SEPA Instant transfer is submitted, **if** the payer's rolling 24-hour
   > outbound total would exceed €15,000, **the system** holds it for manual review **per
   > payer account**; **on violation** the transfer is rejected with `LIMIT_EXCEEDED` and an
   > alert is raised.
   > Source: Payments Policy v4.2, 2026-03-01. Configurable: yes.

   Reject any rule containing *appropriate, timely, valid, properly, reasonable, sufficient,
   as needed* unless a number or an enumerated list follows.

Money is always minor units with an ISO 4217 code. Say so once, here.

### Key flows

3–6 flows including **at least two failure paths**. Draw one as a sequence SVG — the one with a
failure branch usually repays it best — and write the rest as step lists. Drawing all of them is
not worth the tokens.

**Flows live here, with the domain, not with the components.** A flow is the process in the
business's own words; it has to be true before there are components to route it through, and it
is what Part 4's cut is checked against. The sequence diagram therefore has actors and domain
steps in its lanes. The picture of components talking to each other is a different diagram and
belongs to Part 5.

---

## 5. Part 3 — Architectural characteristics

What the architecture is being optimised for, as numbers. This part is short, and everything
after it is downstream of it.

**At most three driving characteristics.** Ranked, in a table whose rows carry
`class="driving"` so the checker can count them:

`Characteristic · Target (a number) · How we would know (the fitness function) · What it costs us`

> `Startup latency` · cold start to a populated list in **under 1 s** on a 500-pod cluster ·
> timed on the reference cluster in CI, failing the build over 1 s · rules out a runtime that
> has to warm up, and forces a cache that can be served stale.

Then two shorter lists:

- **Supporting characteristics** — real, measured, but not what gets traded for. Same four
  columns.
- **What we are not optimising for** — 2–4 named characteristics we are deliberately spending,
  each with one clause of why. This is the cheapest section in the document and it stops more
  argument later than any other.

Four rules:

- **Use the field's own names** — availability, elasticity, deployability, startup latency,
  fault tolerance, portability, auditability, testability. The name carries a body of known
  trade-offs; a phrase invented here carries none.
- **Every row is a number or an enumerated rule.** This is the one part whose entire job is
  turning "fast" into *keystroke to repaint under 16 ms*. An adjective here is a defect, and
  `scripts/check_spec.py` reports an adjective sitting in a row with no number in it.
- **Three is a ceiling, not a target.** A list of eight characteristics says nothing and
  licenses everything, because every later decision can point at one of them.
- Anything defaulted rather than asked is marked `Assumed — not confirmed` in the row itself.

**Why it sits here and not inside Technologies.** These are the forces that decide Parts 4, 5
and 6. Printed after them, they read as a footnote to decisions they actually caused, and no
reader can check whether the architecture answers them. Printed before, every later part is
checkable against three lines.

---

## 6. Part 4 — Logical components

What the pieces are, **independently of how they are deployed**. A component is a capability,
not a deployable.

One table:

`Component · What it does (one line) · Owns · Used by · Forced by`

- **`Owns` is the entities it writes**, each in `<code>`, matching the Part 2 names character
  for character. **Ownership is exclusive** — two components writing the same entity is the
  defect this part exists to prevent, and `scripts/check_spec.py` reports it.
- **`Forced by`** names the story or the driving characteristic that requires this component to
  exist. A component nothing forces is architecture for its own sake; delete it rather than
  justify it.
- Under `--explain`, the cut should follow the ★ pivotal events in the timeline — responsibility
  changing hands is where a boundary belongs.

Then **the component diagram**: boxes for components, the entities each owns, and arrows for
what calls what. No deployment, no network, no processes.

**Nothing in this part says process, container, service, cluster or repository.** Whether these
components are one deployable or nine is Part 5's question, and answering it here is what makes
the two impossible to change independently — which is how a codebase ends up with a service
boundary nobody can explain.

---

## 7. Part 5 — Architectural style

How the components are arranged, and what they run inside.

- **The style, named.** Modular monolith · layered · microkernel and plugins · event-driven ·
  pipeline · service-based · microservices · client with a local cache. Use the field's name,
  because the name carries the trade-offs; "layered-ish, kind of event driven" carries none and
  cannot be argued with.
- **Why this style, against Part 3.** One line per driving characteristic saying how the style
  serves it. If a driving characteristic has no line here, either the style is wrong or the
  characteristic is not really driving.
- **The styles rejected** — two or three, each with the characteristic that ruled it out. This is
  a genuine decision with genuine alternatives, so it is also an ADR: state the outcome here and
  point at it.
- **Topology** — one deployable or several, with the reason. Default to modules inside one
  deployable and say why: separate services buy independent deployment and scaling and cost a
  network, a contract and a distributed failure mode per boundary. Split only where a requirement
  forces it — a different scaling profile, a different release cadence, a different blast radius.
- **How components talk** — per pair: synchronous call or asynchronous message, and the reason.
  Name anything that must be transactional **across** a boundary; that is either a merge signal
  or the hardest problem in the build, and it should never be discovered later.
- **A context/container SVG.** What is inside, what is outside, what crosses the line.

---

## 8. Part 6 — Decisions

Every decision that had a real alternative, and nothing else.

Each is an `<h3>` in this shape:

> ### ADR-3 — Store the match result rather than recompute it
> **Status** accepted
> **Context** Matching reads three systems and takes 200–400 ms. `Repaint under 16 ms`
> (Part 3) cannot absorb that, and a clerk reopens the same invoice several times an hour.
> **Decision** `MatchResult` is persisted by `Matching` and read by everything else.
> **Alternatives** Recompute on read — rejected, it misses the latency target by an order of
> magnitude. Cache in memory with a TTL — rejected, the result has to survive a restart and be
> auditable a year later.
> **Consequences** A match becomes a stored fact that can go stale; a re-match has to
> invalidate it, and that invalidation is now a named flow. Auditors get history for free.
> **Revisit when** matching drops below 20 ms, or the store exceeds 50M rows.

Six fields, and the two that carry the weight are **Alternatives** and **Consequences**.

- **`Status`** — accepted · proposed · superseded by ADR-n. A superseded ADR stays in the
  document; deleting it destroys the only record of why the earlier answer stopped working.
- **`Context`** — the forces, in two or three sentences, naming the Part 3 characteristic or the
  Part 1 story that pushed on this. An ADR whose context names neither is one nobody can check.
- **`Decision`** — one sentence, active voice, present tense.
- **`Alternatives`** — **at least one**, with what ruled it out. A decision with no live
  alternative was not a decision, it was a default: it belongs in the Technologies table with one
  clause of why, not here.
- **`Consequences`** — what this now makes easy, and what it now makes hard or expensive. Both
  halves. An ADR listing only benefits is advocacy.
- **`Revisit when`** — a number or an event, never a date.

### Where they come from: the interview, live

`interview-notes.md` carries a `## Decisions` log written **as the interview runs**
(`interview.md` §10). Every `propose→correct` the user corrected, every `default→veto` they
vetoed or let stand, and every objection they overruled is a decision with a real context and a
real alternative, captured at the moment both were still true. Assemble this part from that log.

**Never invent this part at write time.** An ADR reconstructed afterwards has a fabricated
Alternatives field — you write down the option you would have rejected, not the one that was
actually on the table — and a reader cannot tell the two apart, which makes every ADR in the
document worth less. If the log is thin, the honest Part 6 is short and says so: name the choices
that were defaults nobody discussed, and let `--continue` turn them into real decisions later.

Five to fifteen ADRs is normal. An overruled objection (`interview.md` §8) becomes an ADR whose
Consequences carry the accepted risk, and the Risks section cites it rather than re-arguing it.

---

## 9. Part 7 — Technical details

With what. This part is a bill of materials, not an argument — the arguments are in Part 6.

### Technologies

A table: `Technology · Version · What it's for · Why / ADR`

- **Every technology carries a version or a pricing tier.** `PostgreSQL 16`, not "a relational
  database". `scripts/check_spec.py` reports anything used twice and never versioned.
- **The last column is one clause or one ADR reference, never both.** A technology chosen against
  a live alternative points at its ADR and says nothing else; one that was a conventional default
  carries a single clause and no ADR. That split is what keeps this table scannable at a glance
  while the reasoning stays reachable in one jump.
- **What it rules out later** stays, as a short line under the table for the two or three
  technologies that genuinely constrain the future: *"no SCIM, so enterprise SSO later is a
  migration, not a config change."*
- **Never state a price, quota, limit or version you did not read this session.** Under
  `--explain`, every third-party claim carries a confidence tag — see `research.md` §3.

### API

Whatever surface this system actually has — HTTP endpoints, CLI commands, screens, or published
events. One table:

`Method · Path (or command, or screen) · Purpose · Request shape · Response shape`

A sketch, never a pasted OpenAPI document. Request and response as a small `<pre><code>` JSON
shape where it helps; field names matter, field types do not — that is below the ceiling.

State the cross-cutting conventions once, above the table: authentication, the idempotency rule
for mutating endpoints, the error contract, and the pagination default. Repeating them per row is
noise.

### Rollout

**Mandatory whenever an existing system is touched.** Expand → migrate → contract for schema,
feature flag with removal criteria, backfill runtime against real row counts, and the explicit
rollback with its point of no return.

---

## 10. The closing section

`Risks, assumptions and open questions` — not a part, because it applies to all seven. It goes
last, after Part 7.

- **Risks**: what could go wrong · likelihood · impact · what you'd do · the trigger to revisit.
  A risk accepted by overruling an objection cites its ADR instead of re-arguing it.
- **Assumptions**: what · why · what breaks if wrong · how to confirm.
- **Open questions**: the four-field shape from `interview.md` §9.

Give the risks table visual weight that matches its importance — it should look like it matters,
not like an appendix.

---

## 11. Added by `--explain`

The layer that teaches the domain. Without the flag, none of it exists. Each of these slots into
an existing part rather than forming one of its own.

| Section | Part | Must contain |
|---|---|---|
| Domain narrative | 2, **before** the domain model | 3–6 paragraphs: what business this is, who pays whom for what, what a regulator or contract forces, what going wrong costs, what the people doing this job actually do all day, and where the money and the risk sit. Written for a developer who has never worked in this industry. |
| Glossary | 2, **before** the domain model | term · definition · also called · not to be confused with · **maps to in code**. 10–60 terms. The glossary names the code: class, table and endpoint names match glossary terms exactly, and renaming one without the other is a defect. |
| Actors (full) | 1, replacing the one-line version | A table: actor · goal · frequency · authority and limits · what hurts today. Include the adversary as an actor when there is one. |
| Event timeline | 2, with the domain model | Past-tense events in order (`Quote Requested → Quote Priced → Policy Bound → Premium Paid → Policy Issued`), marking **★ pivotal events** where responsibility, ownership or legal status changes — these are where component boundaries belong — **unhappy endings** (cancel, reject, refund, expire; at least one is mandatory), and **waiting points** where the process stops for a human, a batch, an external system or a legal clock. |
| Worked example | 2, after the invariants | One real case end to end with real numbers. This is the section that makes the rest legible. |
| Why the rules are what they are | 2, with the invariants | Per rule: the force behind it — law with its article and date, contract, physics, or habit. This is what decides which rules are configurable and which are hard-coded. |
| How this is usually built | 5, at the end | See below. |

The narrative and the glossary go **before** the domain model. A reader who doesn't know the
industry needs the words before the entities.

### How this is usually built

`--explain` only, and it comes from the research. It sits at the end of Part 5 because the
canonical decomposition and the field's disagreements are exactly what our components and style
are being judged against. In this order:

1. **The problem's name** in the industry's own vocabulary — the analyst category, the phrase
   practitioners themselves use. This is what makes the rest of the field searchable.
2. **The canonical decomposition** — the components that recurred across the real systems found,
   as function nouns at one level of abstraction.
3. **Where the field genuinely disagrees** — the 2–3 decisions with two defensible answers, each
   with the force that decides it (a latency budget, a consistency requirement, data volume,
   tenancy, team size). Each of these is an ADR in Part 6; name it here and point at it.
4. **The edge cases everyone hits**, from post-mortems and "why we left X" write-ups. These feed
   the Risks section.
5. **Three existing solutions**, each with a one-line verdict and **one named weakness**. A
   candidate with no named weakness means the research read only marketing.
6. **What we copy, and what we deliberately do differently**, with the reason.
7. **Dated sources.**

No scoring matrix, no must-have gates, no build-versus-buy ceremony. The point is understanding
the field, not procuring from it.

---

## 12. Cross-references — what points where

This is the rule that makes the document top-down rather than merely reordered:

> **A row states *what*. It points at an ADR for *why*.**

- **Parts 4, 5 and 7 carry decisions, not arguments.** Where a choice had a live alternative, the
  cell reads `ADR-4` and nothing else. Where it was a conventional default, one clause.
- **Every ADR's Context names a Part 3 characteristic or a Part 1 story.** That is what makes an
  ADR checkable rather than a story about itself.
- **Part 4's `Forced by` names a story or a characteristic**, both of which live above it.
- **The v1 line names stories verbatim**, and Risks cite the ADR that accepted them.

The reason is what the reader does with it. Someone who trusts the *what* skims Parts 4–7 in two
minutes. Someone who doubts one row jumps to one ADR and reads three hundred words. Inlining
every reason forces both readers through the same eight thousand words, and it is the single
biggest reason a long specification reads as a wall.

**The only ids in this document are `ADR-<n>`.** Story handles are their `<h3>` names, and parts
and sections are addressed by the HTML `id` attributes `html.md` defines. There is deliberately
**no FR-, NFR-, BR-, R- or OQ- numbering**: those schemes buy a traceability matrix nobody
maintains at this size, and they push a writer into one-line requirements that lose exactly the
reasoning this document exists to carry.

---

## 13. Section smells

Reject and rewrite when you see:

**Structure**
- a part deleted rather than shortened, or a section kept and padded
- a part with no lede, or a lede that lists its sections instead of summarising them
- a "why" argued inline in Parts 4, 5 or 7 where an ADR reference belongs
- a section restating its heading

**Part 3**
- more than three driving characteristics
- a characteristic with an adjective and no number
- a driving characteristic that no part below it ever answers

**Parts 4 and 5**
- two components owning the same entity
- a component nothing forces
- a component table naming a process, container, service or repository — that is Part 5
- a style named as a shape rather than by the field's name for it

**Part 6**
- an ADR with no alternative, or with only benefits in its Consequences
- an ADR invented at write time rather than logged during the interview
- an ADR whose Context names no characteristic and no story

**Everywhere**
- an adjective where a number belongs
- a technology with no version
- a user story naming a solution instead of a need, or carrying no acceptance criteria
- an entity with no terminal state
- an invariant missing one of its five parts
- an API row with no concrete request or response
- a third-party claim with no confidence tag, under `--explain`
- an open question with no default
- schema columns, indexes, code or build phases — below the ceiling
- filler verbs of intent: *leverage, ensure, streamline, facilitate, utilise*

The rule behind all of them: prefer a sentence carrying a number, a proper noun, or a decision.
Prose carrying none of the three is usually filler — though a connecting sentence that makes two
paragraphs read as one thought earns its place.
