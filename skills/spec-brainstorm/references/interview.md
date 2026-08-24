# Interview guide

This file owns the question rules, the round structure and the coverage floor.

## Contents

1. The three rules
2. Batching
3. The funnel
4. Round bank
5. Making answers concrete
6. Playing back the picture
7. Existing codebase — the `--feature` path
8. Pushing back on a risky answer
9. "I don't know", and what an open question is for
10. Persisting the interview
11. The coverage floor
12. Failure modes

---

## 1. The three rules

Everything below is derived from these. When a situation isn't covered by the round bank,
work it out from here rather than inventing a question.

### Rule 1 — order by leverage, not by topic

Ask what reshapes the most first. Scope changes the entity list; the entity list changes the
boundaries; the boundaries change the API. Asking about pagination while the scope is still
open produces a document for the wrong system, and feels productive while doing it.

### Rule 2 — question style follows reversibility

This decides the *form* of every question:

| Altitude | Cost of guessing wrong | Style |
|---|---|---|
| Scope, users, the one case | expensive — the whole document is wrong | **Open question.** Genuinely ask. |
| **Driving characteristics** | expensive — every part below Part 3 is optimised for the wrong thing | **Forced trade-off.** Make them choose between two things they want. |
| Domain model, components, unhappy endings | moderate — a section gets rewritten | **Propose, then correct.** State it as fact. |
| API conventions, stack, error format | cheap — one line to change later | **Default and veto.** Assert it, invite objection, silence is agreement. |

People correct far better than they compose. *"What are your entities?"* returns a vague
list. *"I count `Invoice`, `GoodsReceipt`, `PurchaseOrder`, `MatchResult` — which do you own
and which are copies?"* returns a precise correction in ten seconds.

Getting this backwards is the most common way the interview fails. Open-questioning a cheap
convention wastes a round trip; asserting a default over the scope produces a confident
document about the wrong system.

**The fourth style exists because the other three all fail on characteristics.** Ask openly —
"how available does this need to be?" — and the answer is always "very"; every adjective is free
when nothing is being spent for it. Assert a default and nobody objects, because a number they
never had to trade for is a number they have no opinion about. So put two things they want on
opposite sides of a scale and make them pick:

> "Under a load spike, would you rather it get slow for everyone, or start rejecting some
> requests and stay fast for the rest?"
> "The cluster is unreachable for ten seconds. Show stale data with a warning, or an error?"
> "Pick one to give up: a second of startup time, or offline use."

Each answer is a *ranked* characteristic with a real cost attached, which is what Part 3 needs
and what an adjective can never become.

### Rule 3 — two gates before any question is asked

**Gate 1 — could you decide this yourself?** If you can make a reasonable call from what you
already know, **make it**. Write it into the assumptions block and move on. The document is
editable and `--continue` exists, so a wrong guess costs one sentence of correction. That
makes guessing cheaper than asking almost every time.

**Gate 2 — is this something only they can tell you?** A constraint, a preference, a
deadline, a fact about their organisation or their users — something no amount of reading the
repo, searching or thinking would give you.

**A question that settles scope passes gate 2 even when it is a business question**, and most
of them are: who this serves, what the process really is, what it deliberately won't do, what
a failure costs today. Scope is the thing most often got wrong and it is invisible in the
code. What fails the gates is business process detail with no consequence for the entities,
the boundaries, the technology, a story, the API or a flow.

If you already have the answer from the opening message, an earlier answer or the repo, state
it as a fact. Never open a question by quoting the answer you're about to re-ask — that reads
as not listening, because it is.

---

## 2. Batching

Put **3–6 numbered questions in one call**, under ~150 words of question text. Round trips,
not question counts, are what make people quit.

Ask alone only what reshapes the tree: the scope in round 1, and the v1 cut in round 8.
Everything else batches.

Order inside a batch: what you most need first, cheapest last. Mark the optional ones
`(skip — I'll default to X)` so a tired user can drop them without feeling like they failed.

---

## 3. The funnel

Eight rounds on paper, typically four in practice. **Rounds collapse.** Anything already
answered by the opening message, the repo or an earlier round is stated as fact and never
re-asked, and a small project finishes early because the later rounds have nothing left to
ask — not because a quota ran out.

| # | Round | Style | Buys |
|---|---|---|---|
| 1 | Who & the job | open | who this is for · one case end to end · volume and shape · new vs module vs replacement |
| 2 | The process | propose→correct | the sequence and its point of no return · unhappy endings · where it waits · what a failure costs |
| 3 | The model | propose→correct | entities and ownership · states and the irreversible transition · invariants · the ambiguous word · cross-system identity |
| 4 | Scope edges | default→veto | what it does not do · law vs policy vs habit · external systems · who operates it |
| 5 | **What it is optimised for** | forced trade-off | the two or three characteristics that win an argument · the number under each · what is being spent for them |
| 6 | Components & API | default→veto | the component cut and what each owns · sync vs async · transactional across boundaries · style and topology · surface shape · idempotency, errors, paging |
| 7 | Technology | default→veto | named stack with versions · where it runs · team and deadline · non-negotiables |
| 8 | Stories & v1 | alone | stories grouped by actor, smallest end-to-end slice pre-selected |

**Rounds 2 and 3 are the same subject twice** — the process in the business's own words, then
the model that has to hold it. That pairing is what makes the model right the first time:
round 2's unhappy endings *are* round 3's states. Collapse them into one round when the
opening message already described the process clearly, and say that you are doing it rather
than silently dropping the correction step.

**Round 5 is where it is because of what it decides.** The characteristics are the forces behind
the component cut, the style and half the ADRs — Parts 3, 4, 5 and 6 of the document. Asked
after the boundaries, they can only ratify a cut that was already made; asked before, they are
what the cut is argued from. This is rule 1 applied to the one place it is easiest to get wrong,
because characteristics *feel* like technical detail and are in fact the most load-bearing
business answer in the interview.

**→ Under `--explain`, research fires after round 1.** Read `research.md`. Without the flag it
does not fire at all.

---

## 4. Round bank

**This is a bank, not a script.** Every question still passes the two gates before it is
asked. Drop any whose answer wouldn't change the document for *this* project. Reading the
list out in order is how an interview turns into a form.

### Round 1 — who and the job

The only mostly-open round.

1. "Who is this for, and what do they do today instead?"
2. "Walk me through one complete case end to end — from the first trigger to 'done, nobody
   touches it again'."
3. "Roughly how many a day in year one — 10, 1,000, 100,000? Read-heavy or write-heavy, and
   does anything here have a latency ceiling a user would notice?"
4. "New service, a module inside something you already run, or a replacement for something
   live?"
5. *`--explain` only* — "Name one product that already does part of this well, and one that
   does it badly — what specifically is bad?" Anti-examples are the most concrete thing users
   produce, and they seed the research with real names.

Q4 decides whether the document carries a rollout section at all, and whether the code gets
read before anything else is asked.

Offer the escape hatch here, and honour it instantly: *"If you'd rather not go through this,
say **'you decide'** and I'll write it with the defaults above and list every call I made."*

### Round 2 — the process

Business vocabulary, business answers. Each lands somewhere technical, which is why it's
asked. Propose-then-correct throughout.

1. "So the sequence is `PO Raised → Goods Received → Invoice Arrived → Matched → Approved →
   Paid`. What did I miss, and which of those is the point of no return?"
   *(→ module boundaries: responsibility changing hands is where a boundary belongs)*
2. "What are the unhappy endings? I'd guess short delivery, price mismatch, duplicate
   invoice, invoice against a cancelled PO. Which others are real?"
   *(→ states, error paths, the failure flows the document must draw)*
3. "Where does it stop and wait — for a human, a batch, an external system, or a clock?"
   *(→ async boundaries, queues, timeouts)*
4. "When this goes wrong today, what does it cost — money, a phone call, a regulator?"
   *(→ how much error handling, alerting and audit the document should carry)*
5. *`--explain` only* — "Who are the people in this, what can each of them authorise, and
   what stops them?" *(→ the actors table)*

### Round 3 — the model

1. "Entities: I count `Invoice`, `GoodsReceipt`, `PurchaseOrder`, `MatchResult`. Which do you
   own, and which are copies of another system's record?"
2. "States: `Invoice` as `received → matched → approved → paid`, terminal `paid | rejected`.
   What's missing, and which transition is irreversible?"
3. "Invariants — 'the same invoice is never paid twice.' Is that a uniqueness constraint, and
   on which field?"
4. "Which word here means something different from everyday English? I'm watching 'receipt' —
   goods receipt note, or payment receipt?"
5. "What identifies a record across systems — your id, theirs, or a composite?"

**Q4 is the highest-yield question in the interview.** It sounds like a business question and
is a technical one: it decides the class, table and endpoint names, and getting it wrong
poisons the API for the life of the system. Every domain has one of these words.

### Round 4 — scope edges

Business questions, all of them. They decide what the document does *not* contain, which is
the cheapest thing to write down and the most expensive to discover late.

1. "Three things this explicitly does not do in v1 — I'll start with credit notes,
   multi-currency and supplier self-service. Object to any, add your own."
   Seed it from what they've already described. **Ask about cuts, never additions.**
2. "Which of the rules we've covered is law or contract, which is company policy, and which
   is just how it's always been done?" *(→ what is configurable versus hard-coded)*
3. "Which external systems must this talk to, and which of them can we not change?"
4. "Who operates this once it ships, and how do they find out it broke?"
5. Pre-mortem: "It's six months out and this failed — not from lack of time, something
   specific broke. What was it?" Failure stories outperform requirement questions; this one
   produces alerting, audit and error-handling material for free.

### Round 5 — what it is optimised for

The only round asked as forced trade-offs (§1, rule 2). Three or four items, and the answers
become Part 3 of the document. **Never ask for an adjective, and never offer a default** — both
produce a number nobody is committed to.

1. **The scale question.** "Under a spike, would you rather it get slow for everyone, or start
   rejecting some requests and stay fast for the rest?" *(→ elasticity vs availability, and which
   one is driving)*
2. **The failure question.** "The bank API is unreachable for ten minutes. Queue and keep taking
   requests, or refuse the ones you can't complete?" *(→ fault tolerance, consistency, and what
   the user sees; this often re-uses round 2's answer, in which case state it rather than re-ask)*
3. **The giving-up question.** "Name one you'd give up to get the others: a second of startup
   time, running on a machine with no network, or a build that ships twice a day." Whatever they
   refuse to give up is the driving characteristic.
4. **Then, and only then, the number.** Turn each answer into one: "so — repaint under 16 ms and
   cold start under a second, measured on a 500-pod cluster. Correct those numbers if they're
   wrong; I'll write them as the two things everything else gets traded against."

**At most three come out of this round as driving.** If they want five, ask which two they would
sacrifice to keep the other three — a list of five is a list of none, and it licenses every later
decision to point at whichever one suits it.

Everything they *didn't* pick is worth one line too: those are Part 3's "what we are not
optimising for", and writing them down is what stops the argument being had again in month four.

### Round 6 — components, style and API

1. "I'd cut three components where ownership changes — **Receiving** owns `GoodsReceipt`,
   **Matching** owns `MatchResult`, **Settlement** owns `Payment`. Object if anything else should
   own one of those." *(→ ownership is exclusive; two components writing one entity is the defect
   this question exists to catch)*
2. "One deployable, modules inside it. Three engineers don't need a network between their own
   functions. Object if any part must ship or scale separately." *(→ the style and topology, and
   whichever way this goes it is an ADR)*
3. "Matching runs async off a queue, not in the request path — it can wait 30s, a user staring at
   a spinner can't."
4. "Does anything need to be transactional *across* those boundaries, or is eventual consistency
   fine everywhere?"
5. "Surface: REST plus webhooks. Say if the real surface is screens or a CLI instead."
6. "Idempotency key on every mutating endpoint, supplied by the caller; error contract
   `{code, message, details}` with a stable machine-readable `code`; every list endpoint
   paginated, cursor, default 50. Push back on any of the three."

Every one of these is a proposal with a live alternative, which is exactly the shape of an ADR.
Log each outcome — corrected or accepted — in `## Decisions` (§10) as it lands.

### Round 7 — technology and constraints

One default per line, each with one clause of why and an escape hatch.

1. "Java 21 / Spring Boot 3.4.x, PostgreSQL 16, Flyway. Say if that's not what you run."
2. "Where does it run?"
3. "Team size and deadline?"
4. "Anything non-negotiable — a platform, a licence, a system you must not touch?"

### Round 8 — stories and the v1 line

Asked alone, because it reshapes everything else. Read the stories back grouped by actor with
the smallest end-to-end slice pre-selected and the rest deferred.

If v1 is visibly too big, force a trade-off before anything else: *"pick one of these five to
push to v2 — I'd push exception routing, because an unmatched invoice sitting in a queue is
survivable for a month."*

---

## 5. Making answers concrete

**Default-and-veto beats an open question** everywhere after round 2. "I'll use PostgreSQL 16
via your existing cluster — relational integrity for the ledger, and you already run it. Push
back if this has to be its own database." That is a decision with a reason and an escape
hatch. Compare: "Which database do you prefer?"

**Every default names a real product, version, tier or number** — never a category.
`Clerk — free to ~10k MAU` beats "a hosted auth provider".

**At most two named options per decision, plus your pick.** Three only when a genuine third
axis exists.

**Never accept an adjective.** Reflect it back and name the fork that matters:

> "You said *secure*. I'll take that as: audit log on every write, no PII in logs, secrets in
> a managed KMS, TLS everywhere. If you actually mean PCI DSS or HIPAA, say so now, because
> that changes the hosting and the model."

**Never ask about availability targets, RPO, RTO or latency percentiles.** Default them,
write them in marked `Assumed — not confirmed`, and let the user correct one line if they
care.

**Show progress** at the top of each round, and end every round with a ≤7-bullet assumption
block and "silence = agreement".

---

## 6. Playing back the picture

At the end of each round, play back the **running model**, not a paragraph:

```
Entities   Invoice · GoodsReceipt · PurchaseOrder · MatchResult
Invoice    received → matched → approved → paid        terminal: paid | rejected
                   ↘ disputed → rejected
Modules    Receiving | Matching | Settlement           async between Matching and Settlement
```

Correcting a picture is a reflex; correcting a paragraph is work. This is also what catches a
wrong entity name before it reaches the glossary, the API and the schema.

**Then name your defaults when you offer to stop.** Every round ends with a real choice:

> "Covered: users, the flow, the model, the boundaries. Still open: how it ships — I'd default
> to one Docker image behind your existing nginx — and retention, currently 12 months on my
> guess. Keep going on those two, or generate now and let me default them?"

"Three rows still open" tells someone nothing they can weigh. Naming the default is what makes
stopping a real choice rather than a blind one. Never generate without offering the choice,
and never keep asking after the user takes it.

---

## 7. Existing codebase — the `--feature` path

The flag means the user has already told you the scope. Don't re-ask it — read the code and
open with what you found.

**Before any question**, read in this order, capped at ~15 files: build files (real dependency
*versions*), the migration folder (real schema), the package layout, lint or architecture
rules, `CLAUDE.md`, existing docs, and **two existing tests** to copy their style.

**No claim about the existing system enters the document without a `path:line` citation.**
Anything uncited becomes an open question, not a fact.

**Round 0 — the opener that skips five questions.** State what you found, ask only what the
code cannot tell you:

> "I read the repo: Spring Boot 3.4.1, PostgreSQL via Flyway (`db/migration`, V1–V23), JUnit 5
> + Testcontainers, hexagonal modules with ArchUnit rules in `architecture-tests/`. I'll follow
> all of that. Two things the code can't tell me: 1. should this live in the existing `billing`
> module or its own adapter module? 2. …"

**Round 1 — the delta.** 3–5 questions, one call:

- Which existing entities, endpoints and roles does it reuse, extend or change?
- What is genuinely new?
- Which existing behaviour must **not** change? (the regression contract)
- What does the user-visible surface look like — a screen, an endpoint, a background job?
- Anything in the current implementation that already annoys you here?

**Round 2 — rollout.** 2–3 questions: migration shape (expand → migrate → contract is the
default), feature flag name and default, backfill runtime against real row counts, rollback
and its point of no return.

Then rounds 3–7 as normal, minus everything the code already answered — which is usually most
of round 6.

---

## 8. Pushing back on a risky answer

The user decides. Your job is to make sure a decision that's hard to reverse gets made with
the mechanism visible — not to win.

**Challenge on sight:** rolling own auth, crypto or JWT verification · storing a raw card PAN
outside a PSP-hosted field · money or balances on eventual consistency · a non-transactional
store as the ledger · services for fewer than about six engineers · no idempotency key on a
mutating public endpoint · unbounded list endpoints · self-managed Kubernetes for a first
version · secrets in a committed `.env` · PII in logs · an LLM in a synchronous critical path
with no fallback · EU personal data in a US-only region · "we'll add tests later".

**The script — four beats, one message, then stop:**

1. **Name the mechanism, not a vibe.** "Two requests arriving in the same second both read
   balance 100 and both write 90" — not "this might have race conditions".
2. **The alternative with its cost.** "A unique constraint on `(account_id, idempotency_key)`
   plus `SELECT … FOR UPDATE` — about half a day, and it makes the endpoint safe to retry."
3. **Reversibility.** "Changing this after launch means a migration with downtime" versus "we
   can swap this in an afternoon".
4. **Hand it back.** "Your call — I'll write it either way."

**Rules.** Object once per decision, never twice — re-litigating is the most annoying thing an
AI interviewer does. Only for decisions expensive to reverse. Never "are you sure?". Never
invoke a scale the user didn't claim. Stop challenging entirely once it reads as friction
rather than help.

**Concede the decision, keep the risk.** When overruled, retract the objection, not the
warning. Record it once in Risks with the accepted risk and a revisit trigger — a number or an
event, never a date: "revisit if write throughput exceeds 2,000/s".

---

## 9. "I don't know", and what an open question is for

When **the user** says they don't know: take the default, write it into Assumptions
(assumption · why · what breaks if wrong · how to confirm), add an open question with a
**default if unanswered**, and move on — all in the same message. Never re-ask. Never block.

**This is not a general escape hatch.** An open question is for something *nobody in this
conversation can answer today* — it needs a decision from someone absent, a measurement not
yet taken, or a third party's answer.

If the user could answer it in one sentence and the answer changes the document, **it is a
question, not an open question.** "Is this repo public or private?" · "Do we delete the old
version at cut-over?" · "Who operates this once it ships?" — each is one line of typing and
reshapes real sections. Filing those as open questions looks diligent and is the interview
quitting early with extra steps.

Test before filing: *could the person I am talking to answer this right now?* If yes, ask it.

**Ratio check before you generate.** More than about one open question per three asked means
you under-interviewed — go back and ask the answerable ones.

---

## 10. Persisting the interview

After every answer batch, append to `docs/<topic>/interview-notes.md`. A long interview will
get interrupted, and losing it costs everything.

This file is **not** behind the write gate — that gate covers `spec.html`, the document the
user is asked to accept. The notes are your own transcript. Write them as you go.

```markdown
---
topic: invoice-reconciliation
scope: new-service        # new-service | feature | replacement
mode: default             # default | explain
status: interviewing      # interviewing | generated-partial | generated
---
<!-- generated-partial: written while rows were still open or assumed, or while the user
     stopped early. It is the flag /r:spec-brainstorm --continue looks for. -->

## Coverage
<!-- one line per floor row: <row>: <verdict> — <evidence> -->
- users-and-job: answered (round 1) — AP clerks, matching in a spreadsheet today
- core-flow: answered (round 1) — receipt → invoice → three-way match → approve → pay
- process: answered (round 2) — point of no return is Approved; four unhappy endings
- domain-model: answered (round 3) — Invoice owned, PurchaseOrder is a copy from SAP
- scale: answered (round 1) — ~4,000 invoices/day, write-heavy
- anti-scope: answered (round 4) — no credit notes, no multi-currency, no supplier portal
- arch-characteristics: answered (round 5) — chose rejecting over slowing; match within 30s
- boundaries: answered (round 6) — Receiving | Matching | Settlement, ownership exclusive
- style-and-topology: answered (round 6) — modular monolith, one deployable, async matching
- api: assumed — REST plus webhooks, never asked
- stack-and-constraints: answered (round 7) — Java 21 / Spring Boot 3.4.1, on-prem, 4 engineers
- integrations: answered (round 4) — SAP and the bank SFTP drop, neither changeable
- failure-behaviour: answered (round 2) — unmatched invoices queue for a buyer, no auto-reject
- decisions: answered (rounds 5–7) — 6 logged below, 2 of them corrections
- stories-and-v1: open
- rollout: n/a — nothing exists today

## Answers
- **Volume** — ~4,000 invoices/day, write-heavy. *(round 1)*

## Decisions
<!-- one per decision that had a live alternative: what was proposed, what happened, what else
     was on the table, and the force that decided it. This becomes Part 6 verbatim. -->
- **One deployable, modules inside it** — proposed; accepted without objection. Alternative on
  the table: a service per module, which they'd read about. Decided by team size (4 engineers)
  and by `match within 30s` not needing independent scaling. *(round 6)*
- **Matching owns `MatchResult`** — proposed that Settlement own it; **corrected** — Matching
  writes it, Settlement only reads. Their reason: a re-match must not need Settlement to be up.
  *(round 6)*
- **Eventual consistency between Matching and Settlement** — proposed; **overruled**. They
  require the ledger write and the payment instruction in one transaction. Objection made once
  and withdrawn; accepted risk recorded in Risks. *(round 6)*

## Assumptions (not confirmed)
- REST plus webhooks — no existing API convention was named. Breaks if: … Confirm with: …

## Open questions
- Which jurisdiction holds the approval audit log? Owner: Finance. Blocks: the audit section.
  Default if unanswered: EU-only.
```

Open questions use these four fields everywhere they appear — here and in the document, never
a third shape.

### The Decisions log is written live, and that is the whole point

Append to `## Decisions` **the moment a decision lands**, not at generate time. Three things go
in it, and each is already happening in the interview:

- a **propose→correct** the user corrected — their correction is the decision, your proposal is
  the alternative;
- a **default→veto** they vetoed, or let stand after being told what it costs;
- an **objection you made and they overruled** (§8) — the decision is theirs, the alternative is
  yours, and the accepted risk is the consequence.

`sections.md` §8 turns this log into Part 6 of the document. Assembling that part from memory
afterwards produces ADRs with invented alternatives: what you write down is the option you would
now reject, not the one that was genuinely live at the time, and no reader can tell the
difference. A decision recorded five rounds later has already lost the thing that made it worth
recording.

Log the *force* as well as the outcome — the characteristic, the story or the constraint that
settled it. An ADR whose context names none of those is one nobody can check later.

### The ledger records *how* a row was settled

Six verdicts. The distinction that matters is between the first four (someone or something
told you) and `assumed` (you decided):

| verdict | means | evidence after the dash |
|---|---|---|
| `answered (round n)` | the user said it | their answer, in your words, one clause |
| `repo` | the code said it | `path:line` |
| `research` | prior art or a doc said it | the source |
| `n/a` | the project has no such area | why |
| `assumed` | **you decided it**, nobody confirmed it | the call, and that it was never asked |
| `open` | nothing settles it yet | — |

`assumed` is a legitimate way to keep moving — rule 3 tells you to prefer it over asking. What
is not legitimate is recording it as `answered`. The two look identical in the finished
document, and once the difference is lost, `--continue` has no way to find the decision and
offer it back. That single lazy word is what makes resuming worthless.

If you cannot write the evidence clause, the verdict is `assumed`. A row settled by several
means takes the weakest of them.

---

## 11. The coverage floor

Do not generate until every row below is **settled** — answered, cited, marked not applicable
with a reason, or assumed with the call written out. "It didn't come up" is not the same as
"it doesn't apply", and a section written without its row is a section written from
imagination.

**Settled does not mean asked.** Four of the five ways to settle a row involve no question at
all, and each has its own ledger verdict.

**`decisions` is settled differently from the rest.** Every other row is settled by knowing
something; this one is settled by having *written* something — the log exists and covers the
choices that had alternatives. A run that reaches the write gate with an empty log has not
skipped a question, it has thrown away the reasoning behind everything it is about to write, and
Part 6 will be reconstructed from memory. Check it before generating, not after.

`scripts/check_spec.py` reads these keys, so a row covered under an invented name reads to the
script as a row you skipped. Copy them verbatim.

| Ledger key | Covered when you can state… |
|---|---|
| `users-and-job` | who uses it, and what they do instead today |
| `core-flow` | one complete case, first trigger to done |
| `process` | the sequence, its point of no return, and at least one unhappy ending |
| `domain-model` | the entities, which you own, and the states each moves through |
| `scale` | the order of magnitude, read-heavy vs write-heavy |
| `anti-scope` | at least three things it explicitly does not do |
| `arch-characteristics` | the two or three characteristics that win an argument, each with a number, and what is being spent for them |
| `boundaries` | the component cut, which entities each one **owns**, and what talks to what |
| `style-and-topology` | the style by its name in the field, and one deployable or several |
| `api` | the surface shape, and who calls it |
| `stack-and-constraints` | language, storage, hosting, team size, deadline |
| `integrations` | which external systems it talks to, and which cannot be changed |
| `failure-behaviour` | what the user sees when a dependency is down or a case can't complete |
| `decisions` | every choice that had a live alternative is in the `## Decisions` log with the option not taken |
| `stories-and-v1` | the stories, and which ship first |

**Add `rollout`** whenever anything already exists: the migration shape, and how to undo it.

**Under `--explain`, add** `actors` (who acts, what each may authorise) and `vocabulary` (the
terms of art, and the word that doesn't mean what it looks like).

**The interview ends exactly two ways.**

1. **Every row carries a verdict.** Say so, name the `assumed` rows, and generate.
2. **The user stops it** — by taking the generate option you offered, or by saying so. Generate
   immediately, and open by naming every row you defaulted and what you defaulted it to.

Nothing else ends it. Not a question count, not a feeling that you have enough. Silently
skipping a row and silently defaulting it look identical in the finished document; the
difference is whether the reader knows.

---

## 12. Failure modes

| Failure | Test | Fix |
|---|---|---|
| **Style/altitude mismatch** — open-questioning a cheap convention, or asserting the scope | Which row of the rule 2 table is this? | Match the style to the cost of being wrong |
| Lookup-able question | Could a grep, a read or a fetch answer this? | Read first, then state what you found |
| Null-effect question | Write both document versions in your head — identical? | Delete the question |
| Interrogation | Count round trips | Batch, default, cut |
| **Failure to probe** — accepting "fast", "secure", "scalable" | Does any adjective lack a number or a rule? | Reflect it back as a rule or a number |
| Leading question | Does the phrasing signal the answer you want? | State your recommendation openly, then ask neutrally |
| Premature detail | Are you asking about paging while the scope is open? | Follow the funnel |
| Compound question | Count the `and`s and `?`s | One idea per numbered item |
| **Scope inflation by question** — "want notifications, an admin panel, an API?" | Did the user mention it, or did you? | Ask about cuts, not additions |
| Amnesia | Diff against the answer ledger before each batch | Quote their earlier answer when you use it |
| **Disguised assumption** — a row you decided, recorded as `answered` | Can you write the evidence clause? | Record `assumed` — it is the only thing that lets `--continue` offer the decision back |
| **Adjective accepted as a characteristic** — "highly available", "fast" | Does the row carry a number and a way to measure it? | Force the trade-off (§1, rule 2), then read the number back |
| **Everything is driving** — five ranked characteristics | Could any later decision point at one of these to justify itself? | Ask which two they'd sacrifice; three is the ceiling |
| **Unlogged decision** — a correction or veto that never reached `## Decisions` | Diff the log against the round you just finished | Append it now, with the alternative that was live — an ADR written later invents one |
| Restating without deciding | Does the checkpoint contain a decision, or a paraphrase? | Every bullet is a decision or a number |
| Infinite hedging | Count open questions with no default | Every unknown gets a default |
| Register mismatch | Match vocabulary to the user's own first message | Define a term inline, once, only if you must use it |
| Monologue | Is question text over ~150 words? | Cut the preamble, lead with the question |

Failure to probe is the dominant real-world failure of AI interviewers — an adjective accepted
at face value becomes a requirement nobody can test.
