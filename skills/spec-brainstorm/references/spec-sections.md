# Spec sections

This file owns which sections exist. No other file restates the counts.

## Contents

1. How to choose the sections
2. Core — every spec
3. Added at standard
4. Added at enterprise
5. Trigger modules
6. IDs
7. The business domain section
8. The prior art section
9. Requirements
10. Spec smells

---

## 1. How to choose the sections

Start from the **core** list. Add the depth block for standard or enterprise. Add a module for each content
trigger that fired, **at any depth**. A trigger adds its module; it does not raise the depth.

Roughly 11 core sections, 16 at standard, 22 at enterprise, plus modules. These are shapes, not quotas: a
section with nothing real to say is **deleted, not padded**, and merging neighbours is always allowed. What is
never allowed is a heading followed by a restatement of the heading. Twelve sections of "the system will follow
industry best practices" make a spec worse than one that omits them, because they hide the real content.

Draft the section plan before writing any HTML.

---

## 2. Core — every spec, at every depth

| # | Section | Must contain |
|---|---|---|
| 1 | Header | Title · status (draft / in review / approved) · owner · date · depth · a link to `architecture.html`. A spec without a status rots into a lie. Don't link `todo.md` — it doesn't exist yet, and a dead link in a deliverable is worse than no link. |
| 2 | **Recommendations & risks** | `R-n` rows: risk · likelihood H/M/L · impact · recommended action · trigger to revisit. Three bullets at small. Placed here, near the top, because at the end nobody reads it. Every overruled objection lands here. |
| 3 | Problem, goals & non-goals | Who hurts today and how much · 3–7 goals each with a metric · 5–8 non-goals each with a "revisit when". Non-goals are the cheapest section in a spec and the best defence against gold-plating. |
| 4 | **Business domain** | See §7. Narrative · actors · the core process as an event timeline · entity lifecycles · glossary. |
| 5 | **Prior art** | See §8. Three candidates with a one-line "why not" at small; the full shape above that. |
| 6 | Requirements | `FR-n` in EARS form with Given/When/Then, and a non-functional table. See §9. |
| 7 | Architecture & stack | The decisions that shape everything else · a static context/container SVG · concrete technology with versions · a link to `architecture.html`. On the existing-codebase path this carries the **Codebase facts** block, every line with a `path:line` citation. |
| 8 | Data model | ER SVG plus a table: types, cardinality, nullability, uniqueness, indexes, **classification flags**, retention per entity. Money as minor units with an ISO 4217 code. |
| 9 | Interfaces | Endpoints, CLI commands or screens — whichever this system actually has. Method · path · description · request · response. A sketch, never a pasted OpenAPI document. |
| 10 | Security & error handling | Authentication, the authorisation model, secrets, encryption. Error taxonomy and response format, timeout/retry/idempotency policy with numbers. Merge these two at small. |
| 11 | Scope, assumptions & open questions | **The v1 line as capabilities, not phases** — which `FR-n` are must-have for a first working version and which are deferred. `/r:spec-plan` turns that into an ordered plan; writing phases here would create a second one. Assumptions: what · why · what breaks if wrong · how to confirm. Open questions in the four-field shape from `interview.md` §9. |

**Also mandatory at any depth when an existing system is touched:** a rollout section — expand → migrate →
contract for schema, feature flag with removal criteria, backfill runtime against real row counts, and the
explicit rollback procedure with its point of no return.

---

## 3. Added at standard

| Section | Must contain |
|---|---|
| Key decisions | `ADR-n`, 5–10 of them: context · options considered · decision · consequences both better and worse · **revisit trigger** · confirmation (the lint rule, architecture test or CI check that enforces it). An ADR with no confirmation is a wish. Decisions the user overruled live here too, with `accepted risk` filled in. |
| Runtime flows | 3–6 sequences including **at least two failure paths**. Draw one; write the rest as step lists. |
| Test strategy | Which layer proves which requirement, coverage target, test data and environments. For JVM work name the house stack — JUnit 5 + AssertJ + Testcontainers, tests before fixes — rather than inventing one the implementation will contradict. |
| Observability | What to instrument, structured logs with trace ids, business metrics, alerts with thresholds and owners. |
| Environments & release | Environment ladder, release strategy, feature flags. |

At small, 2–3 key decisions fold into the architecture section rather than getting their own heading.

---

## 4. Added at enterprise

| Section | Must contain |
|---|---|
| Compliance | Named instruments with article and date — never "compliance requirements". A matrix: requirement → control → where implemented → evidence artefact → owner. |
| Capacity & cost | Sizing derived from a business number, cost per 1,000 transactions, the top three cost drivers at 10× scale. |
| Resilience & DR | RTO/RPO, DR strategy, degradation matrix (dependency down → user-visible behaviour → mechanism), drill cadence. |
| SLOs | SLI definitions, error-budget policy with a stated consequence, burn-rate alerting. |
| Operational readiness | A runbook per alert, on-call, incident severities, a named owner per component. |
| Traceability | FR → component → interface → phase → test id → ADR → status. This is the artefact an auditor asks for. |
| Sources | Normative separated from informative. Every external number dated. |

ADRs stay **inside** `spec.html` at every depth. Do not spawn a `docs/adr/` tree — a second location is a
second source of truth.

---

## 5. Trigger modules

One short module per fired trigger, at any depth. Each is a few paragraphs and a table, not a chapter.

| Trigger | Module contains |
|---|---|
| payments | which flows touch card data, what keeps you out of PCI scope, refund and chargeback handling |
| health data | lawful basis, who may read a record, retention, export and erasure |
| EU/UK personal data | data classes, residency, subject-rights mechanics |
| financial rails | ledger integrity, reconciliation, idempotency of money movement |
| enterprise buyers | audit log contents, access review, SSO expectations |
| tenancy | isolation model (pool / bridge / silo) and the test that proves it |
| high throughput | backpressure, queue depth, shedding policy |
| migration | dual-run, reconciliation, cut-over and rollback |
| model decisions | what the model decides, human review path, monitoring for drift |

---

## 6. IDs

Six prefixes. Stable ids are what let the todo, the diagrams and the tests point at the same thing.

| Prefix | Meaning |
|---|---|
| `FR-n` | Functional requirement |
| `NFR-n` | Non-functional target |
| `BR-n` | Business rule, invariant or calculation |
| `ADR-n` | Decision, including one you argued against |
| `R-n` | Risk |
| `OQ-n` | Open question |

**No zero padding**: `FR-7`, never `FR-07`. Pick it once and hold it — mixed forms break every grep and every
cross-reference.

**A business rule is testable only with all five parts:** trigger · condition · outcome *with units* · scope
(per what) · behaviour on violation. Plus a source with an as-of date and whether it's configurable.

> `BR-11` — **When** a SEPA Instant transfer is submitted, **if** the payer's rolling 24-hour outbound total
> would exceed €15,000, **the system** holds it for manual review **per payer account**; **on violation** the
> transfer is rejected with `LIMIT_EXCEEDED` and an alert is raised.
> Source: Payments Policy v4.2, 2026-03-01. Configurable: yes.

Reject any rule containing *appropriate, timely, valid, properly, reasonable, sufficient, as needed* unless a
number or an enumerated list follows.

---

## 7. The business domain section

This is what "explain the business domain" means. A developer who has never worked in this industry must read
this and then understand why the requirements are what they are. Write it for them.

1. **Narrative** — ≤120 words at small; at enterprise, 3–6 paragraphs: what business this is, who pays whom for
   what, what the regulator or contract forces, what going wrong costs, what the people doing this job actually
   do all day, and where the money and the risk sit.
2. **Actors** — a table: actor · goal · frequency · authority and limits · what hurts today. Include the
   adversary as an actor when there is one.
3. **The core process as an event timeline** — past-tense events in order
   (`Quote Requested → Quote Priced → Policy Bound → Premium Paid → Policy Issued`), marking:
   - **★ pivotal events** where responsibility, ownership or legal status changes — these are where module
     boundaries belong;
   - **unhappy endings** (cancel, reject, refund, expire) — at least one is mandatory;
   - **waiting points** where the process stops for a human, a batch, an external system or a legal clock.
4. **Entity lifecycles** — the states each core entity moves through, and its terminal states. An entity
   without a terminal state is a leak.
5. **Glossary** — term · definition · also called · not to be confused with · maps to in code. 10 terms at
   small, up to 60 at enterprise. **The glossary names the code**: class, table and endpoint names match
   glossary terms exactly, and renaming one without the other is a defect.
6. **Business metrics** — the 3–5 numbers this system exists to move, with today's value where known.

---

## 8. The prior art section

In this order:

1. **Problem framing** — the category name in the industry's own vocabulary.
2. **Must-have gates** — 3–5 requirements from the constraints. A candidate failing a gate is out, not scored
   down.
3. **Candidates** — `Solution · Type · Licence/Pricing · Maturity · Confidence · Verdict + which gate it fails`.
   Include the boring baseline and any internal system that already does part of this.

   **Confidence is a column, not a habit.** The tag rules in `research.md` §3 are easy to hold for three
   paragraphs and easy to lose over two thousand lines — which is exactly what happens, and the pricing and
   maturity claims are what go first. A column can't be forgotten the way a convention can: an empty cell is
   visible while you're writing the row. Fill it with the tag that applies to the *weakest* claim in that row —
   `[verified: <url>, read <date>]`, `[likely: …]`, `[unverified]` or `[assumption]`. A whole table of
   `[unverified]` is an honest table; a table with no tags is an unreadable one, because nobody can tell which
   numbers to trust.
4. **Comparison matrix** — standard and enterprise only; at most 6 candidates × 9 axes. Every axis must be able
   to change the decision; one that can't is deleted.
5. **One known weakness per shortlisted candidate — mandatory.** A candidate with no named weakness means the
   research read only marketing.
6. **Reference architecture distilled** — the components that recurred across most solutions.
7. **Decision points** — the 2–3 places the field genuinely disagrees, each with the force that decides it.
8. **Build / buy / extend** with the triggers that fired and the reversibility answer.
9. **What we copy, and what we deliberately do differently**, with the reason.
10. **Dated sources.**

At small this collapses to three candidates with a one-line "why not" each and no matrix.

---

## 9. Requirements

**Functional, in EARS form:**

- Ubiquitous — `The system shall <response>.`
- Event-driven — `When <trigger>, the system shall <response>.`
- State-driven — `While <state>, the system shall <response>.`
- Unwanted — `If <condition>, then the system shall <response>.`
- Optional — `Where <feature is included>, the system shall <response>.`

> `FR-7` (Must) — **When** a payout webhook arrives with an idempotency key already seen, **the system shall**
> return `200` with the original payout id and create no new row.
> *Given* a payout `p1` created with key `k1`, *when* the same key is posted again, *then* the response is
> `200` with `payoutId = p1` and `payouts` has one row.

A requirement states a need, not a solution.

**Non-functional, as numbers, never adjectives.** At small, one table of six defaulted rows — availability, p95
latency, throughput, data volume, backup/restore, cost ceiling — each marked `Assumed — not confirmed`. Above
that, six-part scenarios:

> `NFR-2` — Under peak load (1,100 authorisations/second, weekday evening), the scoring service returns a
> decision for 99% of requests within 150 ms measured at the API gateway, and never exceeds the 300 ms issuer
> timeout.

---

## 10. Spec smells

Reject and rewrite when you see: a section restating its heading · an adjective where a number belongs · a
technology with no version · a requirement naming a solution instead of a need · an interface row with no
concrete request or response · a third-party claim with no confidence tag · an open question with no default ·
a component no requirement forces · a "done when" nobody can run · two places both claiming to be the source of
truth · filler verbs of intent (*leverage, ensure, streamline, facilitate, utilise*).

The rule behind all of them: prefer a sentence carrying a number, a proper noun, or a decision. Prose that
carries none of the three is usually filler — but this is a writing instinct, not a checklist item, and a
connecting sentence that makes two paragraphs read as one thought earns its place.
