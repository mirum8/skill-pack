# Research playbook

This file owns the agent counts and the lookup caps. No other file restates them.

## Contents

1. When it fires
2. How many agents, and what each is asked
3. Honesty rules
4. How findings re-enter the interview
5. If the `Agent` tool is unavailable
6. Anti-patterns

---

## 1. When it fires

**After round 1, before round 2.** Round 1 tells you what to research; researching earlier produces a generic
comparison table nobody needed.

Announce it in one line, dispatch everything in a **single message** so the agents run in parallel, and ask
nothing while waiting:

> "Round 1 done. Researching three things in parallel — what already exists for real-time card fraud
> decisioning, the reference architecture teams converge on, and which of these decisions actually have two
> defensible answers. About two minutes."

**For the existing-codebase scope, research is reading the repo, and the external fan-out is off by default.**
The beat sits after the delta round — `interview.md` §6 names it, and owns the three conditions that turn the
fan-out back on (a library the repo doesn't have yet, a content trigger the codebase has never handled, or a
user who asked what already exists). Everything the fan-out would normally decide — language, storage, hosting,
test stack — the repo decided already, with more authority than any blog post.

---

## 2. How many agents, and what each is asked

| | small | standard | enterprise |
|---|---|---|---|
| Agents | 1 (prior art + options, merged) | 3 (A, B, C) — plus D if a content trigger fired | 5 (A–E) |
| Vendor lookups to verify | ≤2 | ≤6 | ≤12 |
| Candidates agent A returns | 3 | 6–8 | 6–10 |

All are `general-purpose` agents. Every one gets the same preamble: the problem statement from round 1, the
depth, the constraints already known, a **≤600-word return budget**, and the honesty rules in §3.

**A — Prior art.** "Name this problem category in the vocabulary the industry actually uses — the analyst
category, the CNCF landscape box, or the phrase vendors themselves use. Find the candidates: commercial, open
source, and the boring baseline nobody blogs about. Run a liveness check on every OSS candidate."

Returns: category name · 3–5 must-have gates derived from the constraints · a candidates table
(`Solution · Type · Licence/Pricing · Maturity signal · Confidence · Verdict + which gate it fails`) · **one known
weakness per shortlisted candidate, mandatory** · a build/buy/extend recommendation with the triggers that fired ·
reversibility (engineer-weeks to undo, and what would make you undo it) · dated sources.

The `Confidence` cell carries the §3 tag for the weakest claim in the row, and it survives into `spec.html` as a
column of the same name. Returning the tags per-row is what stops them being reconstructed — badly — later.

Liveness check: last commit, last release, committers in the past 90 days, organisational diversity of those
committers, open CVEs, licence and relicensing risk, named real adopters. GitHub stars are never a decision
input.

**B — Reference architecture** *(standard and enterprise)*. "Find 4–6 solutions to this problem — products,
OSS, engineering blog posts from companies within about 100× of our scale. List each one's components as
function nouns at a single level of abstraction. Return the components present in at least 75% of them, and the
2–3 places they genuinely disagree."

Returns: 6–12 canonical components, one line each · a decision-points table
(`Decision · Option A · Option B · the force that decides it` — a latency budget, a consistency requirement,
data volume, tenancy, or team size) · failure modes named in the sources · each source company's scale next to
ours · dated sources.

Enforced in the prompt: **take the component decomposition, discard the scaling mechanism** unless our numbers
are within 100× of theirs.

**C — Stack options.** "For each of these decisions, return exactly two named current options plus a
recommendation."

Returns per decision: two options, each with the real product name **and version or pricing tier**, **one
number that decides it**, and the downstream consequence — "no SCIM, so enterprise SSO later is a migration,
not a config change". Prices and limits must be **fetched, never recalled**.

**D — Compliance** *(when a content trigger fired, or at enterprise)*. "Name the instruments that bind this
system — regulation with article and date, scheme rulebook with version, standards we must speak. For each:
what it forces the architecture to contain, what it eliminates, and the deadline or retention it imposes."

Returns: rule-setters and what each can actually do to us · mandatory standards and formats · the clock map
(`deadline · trigger · length · calendar or business days · consequence of breach`) · what must be logged,
immutable or reconstructable · candidates this eliminates · dated primary-source links.

Runs **before** the comparison matrix, because compliance eliminates candidates rather than scoring them.

**E — Failure modes** *(enterprise)*. "Search for how this class of system fails in production — post-mortems,
'migrating off X', 'why we left X', regulator findings. Return the top five failure modes and, for each, the
one thing a spec must contain to prevent it."

Returns five rows: `failure mode · what caused it · the spec artefact that prevents it · source`.

---

## 3. Honesty rules

These are what make a researched spec more trustworthy than an unresearched one. Without them research makes
the spec *worse*, because wrong facts arrive wearing confidence.

**One standard, no alternatives:** every claim about a third-party product, price, limit, version or regulation
carries exactly one of these tags. There is no "cited so a tag isn't needed" exemption — a bare URL is not a
tag, and the largest documents are where this quietly slips.

- `[verified: <url>, read <date>]` — you fetched it this session and read the claim there.
- `[likely: <the inference>]` — you're reasoning from something adjacent. Say what.
- `[unverified]` — plausible, unchecked. Perfectly acceptable; silence is not.
- `[assumption]` — you made it up as a working default.

Then:

- Never state a price, rate limit, latency, quota, SLA or version you did not read this session.
  `≈$X/mo at 1M events [unverified]` beats a confident wrong number.
- Write "no documented support for X (docs searched `<date>`)" — never "does not support X". Absence of
  evidence is not absence of feature.
- Don't paraphrase a feature into a stronger claim. "Supports webhooks" is not "signed payloads with retries".
- Cite a regulation with its article and date, or don't cite it.
- **Internal prior art outranks everything external.** If the repo or the interview reveals "we already have a
  service that does half of this", it's the highest-priority candidate in the matrix.
- Stop when two consecutive sources add no new evaluation axis and no new component. More searching past that
  is theatre.

---

## 4. How findings re-enter the interview

Three channels. Research that reaches none of them is deleted.

1. **Options, not inventions.** Every question option after the fan-out is a researched name with a number
   attached, never a category.
2. **The architecture proposal** — the beat described in SKILL.md Step 2.
3. **Named spec sections.** A → prior art. B → the reference architecture and solution strategy. C → the stack
   and the decision records. D → compliance, security, retention. E → recommendations and error handling.

If the research changed no question and no section, delete it and write one line saying what was searched and
that nothing decision-relevant came back. That's a legitimate result and an honest one.

---

## 5. If the `Agent` tool is unavailable

This skill normally runs in the main thread, where it can spawn agents. If it's been invoked from inside a
subagent the `Agent` tool will be missing. Degrade to serial `WebSearch`/`WebFetch` at half the lookup cap, and
**say so in one line**.

Never claim a parallel fan-out ran when it didn't, and never imitate a search with prose. A fabricated
comparison table is the worst possible output of this skill.

---

## 6. Anti-patterns

- **Cargo-culting a FAANG architecture.** Write down their scale, ours, and the ratio; above 100×, take the
  component decomposition and drop the scaling mechanism.
- **Tool before constraint.** Choosing the database, then discovering the consistency requirement.
- **Feature bingo.** A matrix axis that can't change the decision is noise. If a row can't flip a verdict,
  delete the row.
- **Marketing-page architecture.** A vendor's "how it works" diagram is a sales asset. Prefer docs, changelogs
  and post-mortems.
- **Reading only the winners.** The projects that died and the teams that migrated away hold most of the
  information.
- **Ignoring the boring baseline.** "A Postgres table and a cron job" belongs in the matrix and sometimes wins.
- **Prior art as decoration.** Five products listed with no verdicts and no effect on the architecture is worse
  than no section, because it looks like diligence.
