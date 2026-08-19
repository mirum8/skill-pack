# Document sections

This file owns which sections exist and what each must contain.

## Contents

1. How to choose the sections
2. The document — every run
3. Added by `--explain`
4. The domain model section
5. User stories
6. Modules & structure
7. Technologies
8. API
9. How this is usually built
10. Section smells

---

## 1. How to choose the sections

Start from §2. Add the §3 block when `--explain` was passed. That is the whole rule — there
are no tiers, no depth, no size bands.

**A section with nothing real to say is deleted, not padded.** This is what makes the same
skill fit a weekend project and a work system without ever asking which it is. A personal tool
with one caller has no integrations material and no operations material; those sections simply
don't exist in its document. A payments platform's answers fill them.

Merging neighbours is always allowed. What is never allowed is a heading followed by a
restatement of the heading. Ten sections of "the system will follow industry best practices"
make a document worse than one that omits them, because they hide the real content.

Draft the section plan before writing any HTML, and say in one line how you read the project:
*"Reading this as a small internal tool — no integrations, no operations section. Say if
that's wrong."*

**The ceiling.** This document describes modules, services, technologies, user stories and the
API. It does not go below that: no column types, no indexes, no code, no build order, no
step-by-step walkthrough. Everything one level down — the schema with real types and indexes, the
endpoint signatures, the build order — is `/r:spec-design`'s job; writing the code is
`/r:task-run`'s. A section that starts specifying `VARCHAR(255)` has left this document's altitude
and is writing `spec-design`'s design pass a day early, from less evidence.

---

## 2. The document — every run

| # | Section | Must contain |
|---|---|---|
| 1 | Header | Title · status (draft / in review / approved) · owner · date · mode (default or explained). A document without a status rots into a lie. Don't link `todo.md` — it doesn't exist yet, and a dead link in a deliverable is worse than no link. |
| 2 | Problem, goals & non-goals | Who hurts today and how much · 3–7 goals each with a metric · 3–8 non-goals each with a "revisit when". Non-goals are the cheapest section to write and the best defence against gold-plating. |
| 3 | **Domain model** | See §4. Entities · relationships · states and terminal states · invariants. |
| 4 | **User stories** | See §5. Grouped by actor, each with acceptance criteria. |
| 5 | Key flows | 3–6 flows including **at least two failure paths**. Draw one as a sequence SVG; write the rest as step lists. Drawing all of them is not worth the tokens. |
| 6 | **Modules & structure** | See §6. The cut, what each module owns, how they talk, and a context/container SVG. |
| 7 | **Technologies** | See §7. Named products with versions, one line of why each, and what it rules out later. |
| 8 | **API** | See §8. Endpoints, commands or screens — whichever this system actually has. |
| 9 | The v1 line | Which stories ship first and which are deferred, **as capabilities, not phases**. `/r:spec-design` turns this into an ordered plan; writing phases here would create a second one. |
| 10 | Risks, assumptions & open questions | Risks: what could go wrong · likelihood · impact · what you'd do · the trigger to revisit. Every overruled objection lands here with its accepted risk. Assumptions: what · why · what breaks if wrong · how to confirm. Open questions in the four-field shape from `interview.md` §9. |

**Also mandatory whenever an existing system is touched:** a rollout section — expand →
migrate → contract for schema, feature flag with removal criteria, backfill runtime against
real row counts, and the explicit rollback with its point of no return.

**Non-functional targets** live as a short table inside §7 (Technologies), not a section of
their own: availability, p95 latency, throughput, data volume, cost ceiling. Anything you
defaulted rather than asked is marked `Assumed — not confirmed` in the row itself.

---

## 3. Added by `--explain`

The layer that teaches the domain. Without the flag, none of it exists.

| Section | Must contain |
|---|---|
| Domain narrative | 3–6 paragraphs: what business this is, who pays whom for what, what a regulator or contract forces, what going wrong costs, what the people doing this job actually do all day, and where the money and the risk sit. Written for a developer who has never worked in this industry. |
| Actors | A table: actor · goal · frequency · authority and limits · what hurts today. Include the adversary as an actor when there is one. |
| Event timeline | Past-tense events in order (`Quote Requested → Quote Priced → Policy Bound → Premium Paid → Policy Issued`), marking **★ pivotal events** where responsibility, ownership or legal status changes — these are where module boundaries belong — **unhappy endings** (cancel, reject, refund, expire; at least one is mandatory), and **waiting points** where the process stops for a human, a batch, an external system or a legal clock. |
| Glossary | term · definition · also called · not to be confused with · **maps to in code**. 10–60 terms. The glossary names the code: class, table and endpoint names match glossary terms exactly, and renaming one without the other is a defect. |
| Worked example | One real case end to end with real numbers. This is the section that makes the rest legible. |
| Why the rules are what they are | Per rule: the force behind it — law with its article and date, contract, physics, or habit. This is what decides which rules are configurable and which are hard-coded. |
| How this is usually built | See §9. The industry's own vocabulary, the decomposition that recurs, and where the field disagrees. |

The narrative and the glossary go **before** the domain model in the finished document. A
reader who doesn't know the industry needs the words before the entities.

---

## 4. The domain model section

The centre of the document. A developer new to this industry must read it and then understand
why the rest is what it is.

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

---

## 5. User stories

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
  `/r:spec-design` both read the `<h3>` text. Keep names stable across a `--continue`; new stories
  append.
- **Every story has acceptance criteria** in Given/When/Then. A story without them is a wish,
  and `scripts/check_spec.py` reports it.
- **A story states a need, not a solution.** "As a clerk I want a Kafka topic" is not a story.

Stories that are deferred are still written; the v1 line is what separates them.

---

## 6. Modules & structure

- **The cut, and the reason for it.** Name each module or service and what it owns — the
  entities it writes. Two modules writing the same entity is the defect this section exists to
  prevent. Under `--explain`, the cut should follow the ★ pivotal events in the timeline;
  responsibility changing hands is where a boundary belongs.
- **How they talk.** Per pair: synchronous call or asynchronous message, and the reason. Name
  anything that must be transactional across a boundary — that is either a merge signal or the
  hardest problem in the build, and it should never be discovered later.
- **One deployable or several, with the reason.** Default to modules inside one deployable and
  say why: separate services buy independent deployment and scaling and cost a network, a
  contract and a distributed failure mode per boundary. Split only where a requirement forces
  it — a different scaling profile, a different release cadence, a different blast radius.
- **A context/container SVG.** What is inside, what is outside, what crosses the line.

---

## 7. Technologies

A table: technology · **version** · what it's for · one line of why · what it rules out later.

- **Every technology carries a version or a pricing tier.** `PostgreSQL 16`, not "a relational
  database". `scripts/check_spec.py` reports anything used twice and never versioned.
- **Never state a price, quota, limit or version you did not read this session.** Under
  `--explain`, every third-party claim carries a confidence tag — see `research.md` §3.
- **"What it rules out later"** is the column people skip and regret: *"no SCIM, so enterprise
  SSO later is a migration, not a config change."*

The non-functional table lives here: availability, p95 latency, throughput, data volume, cost
ceiling. Numbers, never adjectives, and defaults marked `Assumed — not confirmed`.

---

## 8. API

Whatever surface this system actually has — HTTP endpoints, CLI commands, screens, or
published events. One table:

`Method · Path (or command, or screen) · Purpose · Request shape · Response shape`

A sketch, never a pasted OpenAPI document. Request and response as a small `<pre><code>` JSON
shape where it helps; field names matter, field types do not — that is below the ceiling.

State the cross-cutting conventions once, above the table: authentication, the idempotency
rule for mutating endpoints, the error contract, and the pagination default. Repeating them
per row is noise.

---

## 9. How this is usually built

`--explain` only, and it comes from the research. In this order:

1. **The problem's name** in the industry's own vocabulary — the analyst category, the phrase
   practitioners themselves use. This is what makes the rest of the field searchable.
2. **The canonical decomposition** — the components that recurred across the real systems
   found, as function nouns at one level of abstraction.
3. **Where the field genuinely disagrees** — the 2–3 decisions with two defensible answers,
   each with the force that decides it (a latency budget, a consistency requirement, data
   volume, tenancy, team size).
4. **The edge cases everyone hits**, from post-mortems and "why we left X" write-ups.
5. **Three existing solutions**, each with a one-line verdict and **one named weakness**. A
   candidate with no named weakness means the research read only marketing.
6. **What we copy, and what we deliberately do differently**, with the reason.
7. **Dated sources.**

No scoring matrix, no must-have gates, no build-versus-buy ceremony. The point is
understanding the field, not procuring from it.

---

## 10. Section smells

Reject and rewrite when you see:

- a section restating its heading
- an adjective where a number belongs
- a technology with no version
- a user story naming a solution instead of a need, or carrying no acceptance criteria
- an entity with no terminal state
- an invariant missing one of its five parts
- two modules writing the same entity
- an API row with no concrete request or response
- a third-party claim with no confidence tag, under `--explain`
- an open question with no default
- a component no story forces
- schema columns, indexes, code or build phases — below the ceiling
- filler verbs of intent: *leverage, ensure, streamline, facilitate, utilise*

The rule behind all of them: prefer a sentence carrying a number, a proper noun, or a
decision. Prose carrying none of the three is usually filler — though a connecting sentence
that makes two paragraphs read as one thought earns its place.
