# Interview guide

This file owns the round structure, the coverage floor, and the rules for pushing back.

## Contents

1. How long the interview runs
2. Before you ask anything — the two gates
3. Batching
4. Gate order
5. Rounds — new service
6. Rounds — existing codebase
7. Making answers concrete
8. Pushing back on a risky answer
9. "I don't know", and what an open question is for
10. Persisting the interview
11. The coverage floor
12. Failure modes

---

## 1. How long the interview runs

**There is no question quota.** Keep asking until either the coverage floor in §11 is met, or the user tells
you to stop. Those are the only two ends.

Depth changes *which rows* are on the floor, not how many questions you're allowed. A small project has fewer
rows to cover, so it finishes sooner on its own — you don't need a ceiling to make that happen. Reaching for
a number instead of the floor is how an interview stops at seven questions with half the spec unasked.

**Reading the repo replaces questions, it doesn't shorten the floor.** On the existing-codebase path most rows
get answered by the code; you still have to be able to state each one, you just cite a file instead of asking.

**After every round, offer the choice explicitly.** Summarize what's now covered and what's still open, name
each uncovered topic with **what you'd default it to**, then let the user decide whether to keep going:

> "Covered so far: users, the core flow, scale, the data model. Still open: how it ships (I'd default to a
> single Docker image behind your existing nginx), what it deliberately won't do, and where the v1 line falls.
> Keep going on those three, or generate now and let me default them?"

Naming the defaults is what makes stopping a real choice rather than a blind one — "three rows still open"
tells the user nothing they can weigh. Never generate without offering the choice, and never keep asking after
the user takes it. A user who wants to stop early gets a spec with its gaps named; a user who wants
thoroughness gets it without having to ask.

---

## 2. Before you ask anything — the two gates

Every candidate question passes both, or it doesn't get asked.

**Gate 1 — could you decide this yourself?** If you can make a reasonable call from what you already know,
**make it.** Write it in the assumptions block and move on.

The spec is not carved in stone. A wrong assumption costs the user one sentence of correction, and
`--continue` exists precisely so decisions can be revisited later. That makes the cost of guessing wrong far
lower than the cost of asking — so guess, and say that you guessed.

Handing someone a multiple-choice question between options you were perfectly able to choose between is not
diligence. It is giving them your job back, and it reads that way.

**Gate 2 — is this something only they can tell you?** A constraint, a preference, a deadline, a fact about
their organisation or their users — something no amount of reading the repo, searching, or thinking would
give you. That is the whole set of things worth asking about.

If you already have the answer from the opening message, an earlier answer, the repo or the research, state
it as a fact. Never open a question by quoting the answer you're about to re-ask — that reads as not
listening, because it is.

**Ask only what passes Gate 2. Everything else you decide, write down, and let them overrule.**

## 3. Batching

Put **3–6 numbered questions in one call**, under ~150 words of question text. Round trips, not question
counts, are what make people quit.

Ask alone only what reshapes the tree: **scope**, **depth** (when not passed as a flag), and **the v1/advanced
cut**. Everything else batches — auth mechanism, deployment target, error format and test depth are
independent, so they go in one call.

Order inside a batch: what you most need first, cheapest last. Mark the optional ones
`(skip — I'll default to X)` so a tired user can drop them without feeling like they failed.

---

## 4. Gate order

Each gate supplies the vocabulary the next one needs. Jumping ahead produces questions the user can't answer
yet.

1. **Who, and the job** — who uses this, what do they do today instead.
2. **The one flow** — one complete case, end to end.
3. **Scale and shape** — orders of magnitude, read-heavy vs write-heavy.
4. **Constraints** — stack, team, deadline, compliance.
5. **Anti-scope** — what this explicitly does not do.

Asking about column types before you know who the users are feels productive and produces a spec for the wrong
system.

---

## 5. Rounds — new service

**This is a bank, not a script.** Every question below still passes the two gates in §2 before it is asked.
Drop the ones whose answer wouldn't change the document for *this* project. Reading the list out in order is
how an interview turns into a form.

**Round 1 — who, the job, the one flow.** One call. The only mostly-open round.

1. "In one or two sentences: who is this for, and what do they do today instead?"
2. "Walk me through one complete case end to end — from the first trigger to 'done, nobody touches it again'."
3. "Roughly how many of these per day in year one — 10, 1,000, or 100,000? And is it read-heavy or
   write-heavy?"
4. "Name one product that already does part of this well, and one that does it badly — what specifically is
   bad?"

Question 4 earns its place twice: anti-examples are the most concrete thing users produce, and it seeds the
research with real names.

**→ Research fires here.** Announce it, wait, ask nothing meanwhile.

**Round 2 — the domain.** One call, 4–6 questions. Propose-then-confirm: state your guess as fact and let them
correct it, because correcting is far easier than composing.

1. Play the timeline back: "So the sequence is `Quote Requested → Quote Priced → Policy Bound → Premium Paid →
   Policy Issued`. What did I miss, and which of those is the point of no return?"
2. "What are the unhappy endings? I'd guess cancel, reject, refund, expire. Which others are real?"
3. "Where does it stop and wait — for a human, a batch, an external system, or a legal clock?"
4. "Is there a word here that means something different from everyday English?"
5. "What must never be true, no matter what?"
6. *enterprise* — "Which of these rules is law or contract, which is company policy, and which is just how
   it's always been done?" This is what decides which rules are configurable.

Question 4 is the highest-yield question in the interview. Every domain has one of these words, and getting it
wrong poisons the glossary, the class names and the schema.

**Round 3 — the architecture proposal.** You talk first (the shape is in SKILL.md Step 2), then ask only about
the decisions where prior art genuinely disagrees.

**Round 4 — constraints and anti-scope.** One call, 3–6 questions, mostly default-and-veto.

- The stack block: one default per line, each with one clause of why and an escape hatch.
- Pre-mortem: "It's six months out and this failed — not from lack of time, something specific broke. What was
  it?"
- Anti-scope, seeded with three exclusions drawn from what they've described: "Three things this explicitly
  does NOT do in v1 — I'll start with … Object to any."
- *standard and enterprise* — "Which existing systems must this talk to, and which of them can we not change?"

**Never ask about availability targets, RPO, RTO or latency percentiles.** Default them from the depth, write
them into the spec marked `Assumed — not confirmed`, and let the user correct one line if they care.

**Round 5 — enterprise only.** 4–8 questions: named regulator and jurisdictions · data residency · audit and
retention · integration contracts and their SLAs · fail-open vs fail-closed per channel · migration shape ·
who is on call · and for anything with a model, how long until you know a decision was wrong.

**Round 6 — the v1 cut.** Asked alone. A multi-select with the smallest end-to-end slice pre-selected. If
scope is visibly too big, force a trade-off first: "Pick one to push to v2: (a) …, (b) …, (c) …. I'd push (a)
because …"

---

## 6. Rounds — existing codebase

This is the `--feature` path, and the flag means the user has already told you the scope. Don't ask it, don't
ask the depth either — read the code and open with what you found.

**Before any question**, read in this order, capped at ~15 files: build files (real dependency *versions*), the
migration folder (real schema), the package layout, lint or architecture rules, `CLAUDE.md`, existing docs, and
**two existing tests** to copy their style.

**No claim about the existing system enters the spec without a `path:line` citation.** Anything uncited becomes
an open question, not a fact.

**Round 0 — the opener that skips five questions.** State what you found, ask only what the code cannot tell
you:

> "I read the repo: Spring Boot 3.4.1, Postgres via Flyway (`db/migration`, V1–V23), JUnit 5 + Testcontainers,
> hexagonal modules with ArchUnit rules in `architecture-tests/`. I'll follow all of that. Two things the code
> can't tell me: 1. should this live in the existing `billing` module or its own adapter module? 2. …"

**Round 1 — the delta.** 3–5 questions, one call:
- Which existing entities, endpoints and roles does it reuse, extend, or change?
- What is genuinely new?
- Which existing behaviour must **not** change? (the regression contract)
- What does the user-visible surface look like — a screen, an endpoint, a background job?
- Anything in the current implementation that already annoys you here?

**→ Research fires here, if anything is still open.** On this path the repo has already answered most of what
the fan-out would ask: the stack, the versions, the storage and the conventions are facts, not options. So the
default is **no external fan-out** — say in one line that the repo was the research, and go on.

Dispatch agents only for a question the code genuinely cannot answer, and name it:

- a library or service the feature needs and the repo doesn't have yet → agent C, constrained to versions
  compatible with what the build file already pins;
- a content trigger fired that the codebase has never had to handle (first time it touches card data, health
  records, EU personal data) → agent D;
- the user asked what already exists rather than how to build it → agent A.

If none of those applies, skipping research here is the right answer, not a shortcut. A comparison table of
frameworks for a repo that made that choice twenty commits ago is the generic output §1 of `research.md` warns
about, and it costs a round trip to produce.

**Round 2 — rollout.** 2–3 questions: migration shape (expand → migrate → contract is the default), feature
flag name and default, backfill runtime against real production row counts, rollback and its point of no
return.

Then the v1 cut as above.

---

## 7. Making answers concrete

**Default-and-veto beats open questions** everywhere after round 1. "I'll use Postgres via Supabase —
relational integrity for the ledger, row-level security for tenant isolation, free tier covers year one. Push
back if you already run MySQL or need on-prem." That's a decision with a reason and an escape hatch. Compare:
"Which database do you prefer?"

**Every default names a real product, version, tier or number** — never a category. `Clerk — free to ~10k MAU`
beats "a hosted auth provider".

**At most two named options per decision, plus your pick.** Three only when a genuine third axis exists.

**Never accept an adjective.** Reflect it back and name the fork that matters:

> "You said *secure*. I'll take that as: audit log on every write, no PII in logs, secrets in a managed KMS,
> TLS everywhere — SOC 2-shaped but not certified. If you actually mean PCI DSS or HIPAA, say so now, because
> that changes the hosting and the data model."

**Failure stories outperform requirement questions.** "Tell me about the last time this went wrong the current
way — what happened, what did it cost?" produces alerting, audit and error-handling requirements for free.

**Show progress** at the top of each round, and **end every round with a ≤7-bullet assumption block** and
"silence = agreement".

**Offer the escape hatch in round 1 and honour it instantly:** "If you'd rather not go through this, say
**'you decide'** and I'll write the spec with the defaults above and list every call I made for you."

---

## 8. Pushing back on a risky answer

The user decides. Your job is to make sure a decision that's hard to reverse gets made with the mechanism
visible — not to win.

**Challenge on sight:** rolling own auth, crypto or JWT verification · storing a raw card PAN outside a
PSP-hosted field · money or balances on eventual consistency · a non-transactional store as the ledger ·
microservices for fewer than about six engineers · no idempotency key on a mutating public endpoint · unbounded
list endpoints · self-managed Kubernetes for an MVP · secrets in a committed `.env` · PII in logs · an LLM in a
synchronous critical path with no fallback · EU personal data in a US-only region · "we'll add tests later".

**The script — four beats, one message, then stop:**

1. **Name the mechanism, not a vibe.** "Two requests arriving in the same second both read balance 100 and both
   write 90" — not "this might have race conditions".
2. **The alternative with its cost.** "A unique constraint on `(account_id, idempotency_key)` plus
   `SELECT … FOR UPDATE` — about half a day, and it makes the endpoint safe to retry."
3. **Reversibility.** "Changing this after launch means a migration with downtime" versus "we can swap this in
   an afternoon".
4. **Hand it back.** "Your call — I'll write it either way."

**Rules.** Object once per decision, never twice — re-litigating is the most annoying thing an AI interviewer
does. Only for decisions expensive to reverse. Never "are you sure?". Never invoke a scale the user didn't
claim. Stop challenging entirely once it starts reading as friction rather than help.

**Concede the decision, keep the risk.** When overruled, retract the objection, not the warning. Record it once,
as an `ADR-n` entry with `accepted risk` and `revisit trigger` filled in, plus an `R-n` row in Recommendations &
Risks when the risk survives. A revisit trigger is a number or an event, never a date: "revisit if write
throughput exceeds 2,000/s".

Abandoning a correct technical concern because someone pushed back once is the failure that makes an assistant
useless in exactly the moments it matters.

---

## 9. "I don't know", and what an open question is for

When **the user** says they don't know: take the researched default, write it into Assumptions (assumption ·
why · what breaks if wrong · how to confirm), add an open question with a **default if unanswered**, and move
on — all in the same message. Never re-ask. Never block.

**This is not a general escape hatch, and misusing it is the most likely way this interview fails.** An open
question is for something *nobody in this conversation can answer today* — it needs a decision from someone
absent, a measurement that hasn't been taken, or a third party's answer.

If the user could answer it in one sentence and the answer changes the spec, **it is a question, not an open
question.** "Is this repo public or private?" · "Do we delete the old version at cut-over?" · "Who operates
this once it ships?" — each is one line of typing for them and reshapes real sections. Filing those as open
questions looks diligent and is actually the interview quitting early with extra steps.

Test before filing anything as an open question: *could the person I am talking to answer this right now?*
If yes, ask it. You have the budget.

**Ratio check before you generate.** Count open questions against questions asked. More than about one open
question per three asked means you under-interviewed — go back and ask the answerable ones. Six open questions
off seven asked is not a thorough spec; it is an unfinished interview.

---

## 10. Persisting the interview

After every answer batch, append to `docs/<topic>/interview-notes.md`. A long interview will get interrupted,
and losing it costs everything.

This file is **not** behind the write gate — that gate covers `spec.html` and `architecture.html`, the two
documents the user is asked to accept. The notes are your own transcript. Write them as you go, without asking.

```markdown
---
topic: fraud-decisioning
scope: new-service        # new-service | feature | replacement
depth: enterprise
status: interviewing      # interviewing | generated-partial | generated
---
<!-- generated-partial: files written while rows were still open, or while the user stopped early.
     Set it honestly — it is the flag /r:spec-brainstorm --continue looks for. Only "generated" means done. -->

## Coverage
<!-- every §11 row for this depth, one line each: <row>: <verdict> — <evidence> -->
- users-and-job: answered (round 1) — fraud analysts, triaging card alerts in a spreadsheet today
- core-flow: answered (round 1) — auth → score → hold → analyst decision → release or block
- scale: answered (round 1) — 1,100 TPS peak, write-heavy
- data: repo — db/migration/V1__init.sql, 9 tables, `transaction` is the source of truth
- stack-and-constraints: answered (round 4) — Java 21 / Spring Boot 3.4.1, on-prem, 4 engineers
- distribution: open
- anti-scope: open
- v1-line: open
- integrations: answered (round 4) — card scheme feed and the case-management tool, neither changeable
- failure-behaviour: n/a — single process, no external dependency
- operations: assumed — the platform team runs it, alerting via the existing Grafana; never asked
- rollout: research — expand → migrate → contract, the default shape for a live scoring path
- regulator: answered (round 5) — DNB under PSD2, plus the scheme rulebook; internal model risk sign-off
- retention-and-residency: answered (round 5) — 7 years for decisions, EU-only, no US replica
- audit: answered (round 5) — every decline reconstructable with the feature values that produced it
- cutover: assumed — shadow-score alongside the PL/SQL rules for one month, then flip per BIN; never asked
- on-call: answered (round 5) — the existing payments rota, 24/7, 15-minute response

## Answers
- **Peak volume** — 1,100 TPS at peak, 11M card transactions/day. *(round 1)*

## Assumptions (not confirmed)
- 99.95% availability — inherited from the card scheme SLA. Breaks if: … Confirm with: …

## Open questions
- OQ-2 Which jurisdiction holds the analyst audit log? Owner: Ops. Blocks: phase 6.
  Default if unanswered: EU-only.
```

Open questions use these four fields everywhere they appear — here, in the spec, and nowhere in a third shape.

### The ledger records *how* a row was settled, not just that it was

Six verdicts. The distinction that matters is between the first four (someone or something told you) and
`assumed` (you decided):

| verdict | means | evidence to write after the dash |
|---|---|---|
| `answered (round n)` | the user said it | their answer, in your words, one clause |
| `repo` | the code said it | `path:line` |
| `research` | prior art or a doc said it | the source |
| `n/a` | the project has no such area | why |
| `assumed` | **you decided it** and nobody has confirmed it | the call, and that it was never asked |
| `open` | nothing settles it yet | — |

`assumed` is a legitimate way to keep moving — §2 tells you to prefer it over asking. What is not legitimate
is recording it as `answered`. The two look identical in the finished spec, and once the difference is lost,
`--continue` has no way to find the decision and offer it back. That is the single failure that makes
resuming worthless, and it is caused here, in this file, by one lazy word.

So: if you cannot write the evidence clause, the verdict is `assumed`, not `answered`. A row settled by three
different means (part asked, part read) takes the weakest of them.

This file doubles as the provenance record: the "why did we decide that?" answer six months later, which
`spec.html` deliberately doesn't carry. It is also the only input `/r:spec-brainstorm --continue` has, so write it
for a reader who wasn't in the conversation: which rows are settled, what was assumed rather than answered,
and why. A notes file that records only the answers makes resuming guesswork.

---

## 11. The coverage floor

Do not generate until every row below is **settled** — answered, already known, or marked not applicable with
a reason. "It didn't come up" is not the same as "it doesn't apply", and a section written without its row is
a section written from imagination.

**Settled does not mean asked.** Four of these five ways to settle a row involve no question at all — and each
one has its own ledger verdict, because which one you used is what `--continue` reads later:

- **The user already told you**, in the opening message or an earlier answer → `answered (round n)`. Write it
  down and move on. A question that opens by quoting the answer it's about to re-ask is the single most
  irritating thing in this whole workflow.
- **The repo, the docs or the research answer it** → `repo` or `research`. Cite the file.
- **The row doesn't apply** → `n/a — <reason>`. Decide that yourself. If the project has no such area, the
  row is settled — you are allowed to know this without asking.
- **You decided it** → `assumed — <the call>, never asked`. This is the one that has to stay honest. It is a
  fine way to settle a row and a terrible thing to disguise as an answer.
- **Only what's left gets asked.**

The floor exists so you don't skip a row that matters. It is not a script to read aloud. Marching through it
question by question produces exactly the interrogation the removed quota was meant to prevent, and a user
answering a question about an area their project doesn't have has correctly concluded you aren't listening.

The **ledger key** column is the exact string to write in the `## Coverage` block. `scripts/check_spec.py` reads
these keys to tell you which rows you never recorded, so a row covered under an invented name reads to the
script as a row you skipped. Copy them verbatim.

**Every depth:**

| | Ledger key | Covered when you can state… |
|---|---|---|
| Users & job | `users-and-job` | who uses it, and what they do instead today |
| The core flow | `core-flow` | one complete case, first trigger to done |
| Scale | `scale` | the order of magnitude, and read-heavy vs write-heavy |
| Data | `data` | the entities that matter and which is the source of truth |
| Stack & constraints | `stack-and-constraints` | language, storage, hosting, deadline, team size |
| **Distribution** | `distribution` | how it ships, who can see it, public or private, who installs it |
| Anti-scope | `anti-scope` | at least three things it explicitly does not do |
| The v1 line | `v1-line` | which capabilities are must-have versus deferred |

**Standard adds:**

| | Ledger key | Covered when you can state… |
|---|---|---|
| Integrations | `integrations` | which external systems it talks to, and which cannot be changed |
| Failure behaviour | `failure-behaviour` | what the user sees when a dependency is down |
| Operations | `operations` | who runs it, and how they find out it broke |
| Rollout | `rollout` | if anything exists today: migration shape, and how to undo it |

**Enterprise adds** — the standard rows above, plus:

| | Ledger key | Covered when you can state… |
|---|---|---|
| Regulator or contract | `regulator` | which named instrument binds this, and who enforces it |
| Retention & residency | `retention-and-residency` | how long each data class is kept, and in which jurisdiction |
| Audit | `audit` | who may read what, and what the audit trail must reconstruct |
| Cut-over | `cutover` | the cut-over shape and the rollback, with its point of no return |
| On call | `on-call` | who is paged, and what they are paged for |

**The interview ends exactly two ways.**

1. **Every row carries a verdict** — answered, cited, not applicable with the reason, or assumed with the
   call written out. Then say so, name the `assumed` rows, and generate.
2. **The user stops it** — either by taking the generate option you offered at the end of a round, or by
   saying so directly. Then generate immediately, and open the spec by naming every row you defaulted and what
   you defaulted it to.

Nothing else ends it. Not a question count, not a feeling that you have enough, not "answers are getting
repetitive" — a competent stakeholder never becomes repetitive, they just answer well. If a row is uncovered
and the user hasn't stopped you, keep going.

Silently skipping a row and silently defaulting it look identical in the finished document. The difference is
whether the reader knows, so say which rows you filled in yourself.

---

## 12. Failure modes

| Failure | Test | Fix |
|---|---|---|
| Lookup-able question | Could a grep, a read or a fetch answer this? | Read first, then state what you found |
| Null-effect question | Write both spec versions in your head — identical? | Delete the question |
| Interrogation | Count against the budget | Batch, default, cut |
| **Failure to probe** — accepting "fast", "secure", "scalable" | Does any adjective lack a number or a rule? | Reflect it back as testable requirements |
| Leading question | Does the phrasing signal the answer you want? | State your recommendation openly, then ask neutrally |
| False precision | Is the question's precision above the project's depth? | Match the question to the depth the user chose |
| Premature detail | Are you at gate 4 while gate 2 is open? | Follow the gate order |
| Compound question | Count the `and`s and `?`s | One idea per numbered item |
| **Scope inflation by question** — "want notifications, an admin panel, an API?" | Did the user mention it, or did you? | Ask about cuts, not additions |
| Amnesia | Diff against the answer ledger before each batch | Quote their earlier answer when you use it |
| **Disguised assumption** — a row you decided, recorded as `answered` | Can you write the evidence clause after the dash? | Record `assumed` instead — it is the only thing that lets `--continue` offer the decision back |
| Restating without deciding | Does the checkpoint contain a decision, or a paraphrase? | Every bullet is a decision or a number |
| Infinite hedging | Count TBDs with no default | Every unknown gets a default and an open-question row |
| Register mismatch | Match vocabulary to the user's own first message | Define a term inline, once, only if you must use it |
| Monologue | Is question text over ~150 words? | Cut the preamble, lead with the question |

Failure to probe is the dominant real-world failure of AI interviewers — an adjective accepted at face value
becomes a requirement nobody can test.
