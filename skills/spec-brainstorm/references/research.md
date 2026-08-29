# Research playbook

`--explain` only. Without the flag, research does not fire — say so in one line and go on.

## Contents

1. When it fires
2. The three agents
3. Honesty rules
4. How findings re-enter the interview
5. If the `Agent` tool is unavailable
6. Anti-patterns

---

## 1. When it fires

**After round 1, before round 2.** Round 1 tells you what to research; earlier produces a
generic comparison nobody needed.

Announce it in one line, dispatch all three agents in a **single message** so they run in
parallel, and ask nothing while waiting:

> "Round 1 done. Researching three things in parallel — how this industry models invoice
> matching, the decomposition teams converge on, and which of these decisions actually have
> two defensible answers. About two minutes."

**On the `--feature` path the repo is the research** and the external fan-out stays off even
under `--explain`, unless a specific question survives reading the code: a library the repo
doesn't have yet, a domain the codebase has never handled, or a user who explicitly asked how
this is usually built. Say in one line which way it went, so the user knows whether anything
was searched.

---

## 2. The three agents

All three are `general-purpose`. Every one gets the same preamble: the problem statement from
round 1, the constraints already known, a **≤600-word return budget**, and the honesty rules
in §3.

**A — how this industry models the problem.**

> "Name this problem category in the vocabulary practitioners actually use. Find how real
> systems in this field model it: the canonical entities and what they are called, the
> lifecycle each moves through, the terms of art and which ones are false friends, and the
> edge cases every implementation runs into."

Returns: the category name · 6–12 canonical entities with their usual names and lifecycles ·
a glossary of terms of art, flagging any word that means something different inside this
industry than outside it · the top edge cases, each with what it forces a system to contain ·
dated sources.

This is the agent that makes `--explain` worth running: its output feeds the glossary, the
domain narrative and the entity list, and a false-friend term it catches saves renaming every
class later.

**B — the decomposition.**

> "Find 4–6 real solutions to this problem — products, open source, engineering write-ups
> from companies within about 100× of our scale. List each one's components as function nouns
> at a single level of abstraction. Return the components present in at least 75% of them, and
> the 2–3 places they genuinely disagree."

Returns: 6–12 recurring components, one line each · a decision-points table
(`Decision · Option A · Option B · the force that decides it` — a latency budget, a
consistency requirement, data volume, tenancy, or team size) · failure modes named in the
sources · each source's scale next to ours · dated sources.

Enforced in the prompt: **take the component decomposition, discard the scaling mechanism**
unless our numbers are within 100× of theirs.

**C — technology options.**

> "For each of these decisions, return exactly two named current options plus a
> recommendation."

Returns per decision: two options, each with the real product name **and version or pricing
tier**, **one number that decides it**, and the downstream consequence — "no SCIM, so
enterprise SSO later is a migration, not a config change". Prices and limits must be
**fetched, never recalled**.

Cap the whole fan-out at ~8 vendor or documentation lookups. Stop when two consecutive sources
add no new component and no new evaluation axis; searching past that is theatre.

---

## 3. Honesty rules

These make a researched document more trustworthy than an unresearched one. Without them
research makes the document *worse*, because wrong facts arrive wearing confidence.

**One standard, no alternatives:** every claim about a third-party product, price, limit,
version or regulation carries exactly one of these tags. A bare URL is not a tag.

- `[verified: <url>, read <date>]` — you fetched it this session and read the claim there.
- `[likely: <the inference>]` — you're reasoning from something adjacent. Say what.
- `[unverified]` — plausible, unchecked. Perfectly acceptable; silence is not.
- `[assumption]` — you made it up as a working default.

Then:

- Never state a price, rate limit, latency, quota, SLA or version you did not read this
  session. `≈$X/mo at 1M events [unverified]` beats a confident wrong number.
- Write "no documented support for X (docs searched `<date>`)" — never "does not support X".
  Absence of evidence is not absence of feature.
- Don't paraphrase a feature into a stronger claim. "Supports webhooks" is not "signed
  payloads with retries".
- Cite a regulation with its article and date, or don't cite it.
- **Internal prior art outranks everything external.** If the repo or the interview reveals
  "we already have a service that does half of this", it is the most important thing found.

---

## 4. How findings re-enter the interview

Three channels. Research that reaches none of them is deleted.

1. **You talk first.** When the research lands, in ≤120 words: name the problem category in
   the industry's own vocabulary, list the components that recurred, and say what you copy
   versus what you deliberately do differently.
2. **Then ask only where prior art genuinely disagrees** — each as two named options with the
   force that decides it and your recommendation. Everything the field already agrees on is a
   statement, not a question.
3. **Named sections.** A → the glossary, the domain narrative, the entity list. B → modules &
   structure, and "how this is usually built". C → technologies.

If the research changed no question and no section, delete it and write one line saying what
was searched and that nothing decision-relevant came back. That is a legitimate, honest result.

---

## 5. If the `Agent` tool is unavailable

Subagents have no `Agent` tool, so a run invoked from inside one cannot fan out. Degrade to
serial `WebSearch` / `WebFetch` at half the lookup cap, and **say so in one line**. Never claim
a parallel fan-out ran when it didn't, and never imitate a search with prose — a fabricated
table of vendors is the worst possible output of this skill.

---

## 6. Anti-patterns

- **Cargo-culting a hyperscaler architecture.** Write down their scale, ours, and the ratio;
  above 100×, take the component decomposition and drop the scaling mechanism.
- **Tool before constraint.** Choosing the database, then discovering the consistency
  requirement.
- **Procurement theatre.** Scoring matrices, must-have gates and build-versus-buy verdicts.
  The point is understanding the field, not buying from it.
- **Marketing-page architecture.** A vendor's "how it works" diagram is a sales asset. Prefer
  docs, changelogs and post-mortems.
- **Reading only the winners.** The projects that died and the teams that migrated away hold
  most of the information.
- **Ignoring the boring baseline.** "A Postgres table and a cron job" is a real answer and
  sometimes the right one.
- **Research as decoration.** Five products listed with no verdicts and no effect on the
  document is worse than no section, because it looks like diligence.
