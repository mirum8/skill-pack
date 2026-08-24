---
description: >-
  Understand a business domain and decide what to build in it - then write both into one
  self-contained docs/<topic>/spec.html, structured top-down in seven parts: business
  requirements, domain, architectural characteristics, logical components, architectural style,
  the decisions (ADRs) behind them, and technical details. Interviews first, decides the rest by
  default, and never writes without a yes. Use for ANY request to spec, design or
  architect a build - "brainstorm", "spec this out", "write a design doc / PRD / RFC / technical
  design", "help me architect X", "how should I build X", "design a feature for my app", "explain
  this domain to me", "/r:spec-brainstorm" - and whenever someone describes an idea or a feature
  and wants it designed and written down rather than coded. Fits a weekend project and a work
  system without asking which. Add --explain when the domain is unfamiliar: it adds the domain
  narrative, actors, event timeline, glossary and a worked example, and researches how the
  industry actually builds this. Use --feature for a feature inside an existing repo
  ("/r:spec-brainstorm --feature let users export invoices as CSV") - it reads the code first.
  --continue resumes an unfinished or under-interviewed document, and restructures one written
  in an older shape. NOT for the phased
  implementation plan - that's /r:spec-design.
model: fable
effort: high
---

# Brainstorm to specification

Interview the user, then write `docs/<topic>/spec.html` — one self-contained page holding what
the domain is and what to build in it — plus `interview-notes.md`, the answer log.

**It reads top-down, in seven parts.** Business requirements → domain → architectural
characteristics → logical components → architectural style → decisions → technical details, then
a closing risks section. Each part is the summary of the one below it, so a reader can stop at
any boundary with a coarser but still true picture. `references/sections.md` owns what goes in
each; the order is not negotiable and no part is dropped, though a part with little to say is
three sentences long.

**The ceiling.** This document stops at components, the style, named technologies and the API.
No column types, no indexes, no code, no build order — those belong to `/r:spec-design`, which
reads this document and writes `todo.md` beside it: it decides the build order *and* the design
contracts (schema with real types and indexes, endpoint signatures, module boundaries) that this
document deliberately stops short of. Writing the code is `/r:task-run`. Don't write phases here
— two plans drift within a day.

**It fits the project it is given.** There is no depth question and no size flag. A weekend tool
has no integrations and no operations material, so those *sections* don't exist in its document;
a work system's answers fill them. A section with nothing real to say is deleted, not padded —
but a *part* is never dropped, only shortened, because a missing part reads exactly like a
question nobody asked. Say in one line how you read the project so a wrong read costs one
sentence.

## Never write the document until the user says yes

Before creating or changing `spec.html`, say what you are about to write and wait for an explicit
go-ahead. Not "generating now", not a summary after the fact — a stop, and an answer.

This applies to the first write and to every later edit. A specification is something the user
reads, shares and builds on; changing it under them destroys their ability to trust what it says.
When resuming, name the sections that will change and what will change in them.

If they say go, write. If they say wait, wait. If they don't answer, don't write.

**`interview-notes.md` is the exception, and it is not really one.** It is the working transcript
of this conversation, not a document the user is asked to accept — so it is written continuously,
from the first answer batch onwards, with no gate. Gating it would mean asking permission to
remember, and an interview interrupted before permission is granted is lost entirely.

## The two modes

**Default.** Interview, then the document, in the seven parts above. No web research.

**`--explain`.** Everything above, plus the layer that teaches the domain — narrative, actors,
event timeline, glossary, a worked example, why the rules are what they are, how the field
usually builds this — and the research that feeds it. Each of those slots into an existing part
rather than forming one of its own; `sections.md` §11 says which.

Reach for it when the domain is unfamiliar, or when the user is trying to understand a business
as much as build in it.

Announce which mode is running in one line. `--explain` is off unless the flag is passed; never
turn it on because the domain looks interesting.

## `--feature` — a feature inside this repo

`/r:spec-brainstorm --feature let users export invoices as CSV` settles the scope, so don't ask
it. Read the repo first (`references/interview.md` §7) and open with what you found.

Everything else is unchanged: the delta rounds, the `path:line` rule, the coverage floor, the
write gate. `--explain` composes with it, but on this path the repo is the research and the
external fan-out stays off unless a specific question survives reading the code.

## Read these before you act

At each gate, read the named file **in full**. Skimming one produces output that looks right and
is wrong in ways nobody catches until implementation.

| Before you… | Read | It owns |
|---|---|---|
| ask the first question | `references/interview.md` | the three question rules, the funnel, the coverage floor |
| dispatch research agents | `references/research.md` | the three agents, lookup caps, honesty rules |
| write `spec.html` | `references/sections.md`, then `references/html.md` | the seven parts and what goes in each; page, navigation and diagram style |

## Step 0 — ground yourself

Do this silently, then report it in one line.

- **Resume.** Glob `docs/*/interview-notes.md`. If one exists, say so and offer to continue it,
  restart it, or start something else. `--continue` skips that offer — see below.
- **Existing plan guard.** If the repo already has a document that owns its plan — a root
  `PROJECT.md`, or a specification another tool maintains — say so and offer to extend that
  instead. A second document beside one already being kept current gives the repo two answers to
  the same question, and the stale one wins about half the time.
- **Existing docs.** Read `README`, `CLAUDE.md`, `docs/`, any ADRs. Never re-derive a decision
  already written down.
- **Collision.** If `docs/<topic>/` exists, read it, say so, and update in place. Never mint
  `<topic>-2`.
- **Slug.** 2–4 words, kebab-case, no dates, no `-spec` suffix — the folder already means it.

## Step 1 — interview

**Read `references/interview.md` in full now.** It owns the rules every question passes, the
eight-round funnel, the question bank and the rules for pushing back. Do not improvise questions.

The three rules, so you know what you are reading for:

1. **Order by leverage.** Scope reshapes the entity list; the entity list and the characteristics
   reshape the components; the components reshape the API. Asking about pagination while the
   scope is open produces a confident document about the wrong system.
2. **Style follows reversibility.** Expensive to get wrong → ask openly. Moderate → propose the
   answer and let them correct it. Cheap and conventional → assert the default and invite a veto.
   People correct far better than they compose. **Architectural characteristics are the one
   exception** and get a fourth style — a forced trade-off — because asked openly they return an
   adjective and asserted as a default they return a shrug.
3. **Two gates.** Could you decide this yourself? Then decide it, record it as an assumption, and
   move on. Is it something only they can tell you? Then ask. **A question that settles scope
   passes, even when it is a business question** — scope is what is most often got wrong, and it
   is invisible in the code.

**Decide by default, and say that you guessed.** The document is editable and `--continue` exists,
so a wrong guess costs one sentence of correction. That makes guessing cheaper than asking almost
every time. A decision you made goes into the coverage ledger as `assumed`, **never** as
`answered` — written honestly it is a decision the user can overturn later; written as an answer
it is indistinguishable from something they told you, and `--continue` will never raise it again.

Every question must be about the thing being designed. If an area doesn't apply, it is settled as
not applicable — write down why and move on. **Never ask a question to confirm that something
doesn't apply**, and never hand someone a multiple choice between options you could have chosen
between.

**The interview ends two ways only: every coverage row is settled, or the user stops it.** There
is no question quota. After each round, play back the running model — entities, states, module cut
— rather than a paragraph, say what's covered and what isn't with the default you'd take for each
gap, and offer to generate or keep going. After every answer batch, append to
`docs/<topic>/interview-notes.md`, including its `## Coverage` ledger.

## Step 2 — research (`--explain` only)

Without the flag, research does not fire. Say so in one line and go to step 3.

With it: **read `references/research.md` now**, then dispatch the three agents it defines **in a
single message** so they run in parallel. Announce it in one line and ask nothing while waiting.
Research fires *after* round 1 — before that you don't yet know what to research.

If the `Agent` tool is missing (this skill running nested inside a subagent), degrade to serial
`WebSearch` and **say so** — never fake the fan-out.

When the research lands, **you talk first**: in ≤120 words, name the problem category in the
industry's own vocabulary, list the components that recurred, and say what you copy versus what
you deliberately do differently. Then ask only about the decisions where prior art genuinely
disagrees, each as two named options with the force that decides it and your recommendation.
Everything the field already agrees on is a statement, not a question.

## Step 3 — write the document

**Stop. Show the plan and wait for a yes before writing anything** — the sections you'll include
under each of the seven parts, the diagrams, the decisions you'll write up as ADRs, and anything
you defaulted rather than asked. Writing first and summarizing afterwards is not confirmation.

If any coverage row is still `open` or `assumed`, this gate is not a yes/no. Name those rows, say
what you'd default each to, and offer the third option the user actually wants: **another round on
them.** Reaching for the write gate while a topic has never been discussed puts the user in the
position of having to notice the hole themselves — and they usually notice it after the file is
written, which is the expensive moment.

- **3a** — read `references/sections.md`, draft the part-and-section plan, read
  `references/html.md`, write `docs/<topic>/spec.html` **one part at a time** (`html.md` §7);
  write the contents links and the seven part ledes last, once the parts they describe exist.
- **3b** — set the status in `docs/<topic>/interview-notes.md`: `generated` only if every coverage
  row is `answered`, `repo`, `research` or `n/a`; `generated-partial` if any row is `open` or
  `assumed`. That flag is how `--continue` finds unfinished work later, so set it honestly even
  when the file looks complete — a defaulted row is unfinished work no matter how good the default
  was.

The document must carry **user stories with stable `<h3>` names** and a stated **v1 line**.
`/r:spec-design` consumes both; a document without them cannot be turned into a plan that traces
back to anything.

**Part 6 is assembled from the `## Decisions` log in `interview-notes.md`, never invented here.**
An ADR written at generate time has a fabricated Alternatives field — you record the option you
would now reject rather than the one that was live at the time — and nothing in the finished
document distinguishes the two. A thin log makes a short Part 6, which is the honest outcome.

## Step 4 — check the output

Mechanical checks are a script's job, not a checklist you run in your head:

```
python3 "${CLAUDE_SKILL_DIR}/scripts/check_spec.py" docs/<topic>/
```

Fix everything it reports, then re-run until clean. It catches a missing or out-of-order part, a
missing contents sidebar, a contents list that isn't linked, an anchor pointing at no `id`, more
than three driving
characteristics, a characteristic that is an adjective with no number, an entity owned by two
components, an `ADR-n` referenced but never written, unversioned technology, placeholder text,
filler prose, a story with no acceptance criteria, a v1 line naming a story that isn't defined, a
claim about existing code with no `path:line`, a coverage row settled with no evidence, and —
under `--explain` — confidence tags that stopped partway or cite no source. These are the
failures invisible on a read-through, which is why they belong to a script.

Then six judgments a script cannot make. Be willing to delete your own work here.

1. **The ledes alone.** Read the seven part ledes and nothing else. Do they describe this system
   correctly? A lede that lists its sections instead of summarising them has failed, and so has a
   part whose lede you could not write.
2. **Proportionality** — does any component, technology or section exist that no story and no
   characteristic forces? Cut it.
3. **Substance** — does any section restate its heading, or say "follow best practices"? Delete it
   rather than pad it. An empty section is better than a filled one that says nothing.
4. **Altitude** — has anything drifted below the ceiling: column types, indexes, code, build
   order? And has any *reasoning* drifted upward into Parts 4, 5 or 7 that belongs in an ADR?
5. **Honesty** — is any claim about a third-party product stated more strongly than what you read?
   Does any ADR list an alternative that was never actually on the table?
6. **Domain** — would a developer new to this industry understand *why* the model is what it is?

## `--continue` — finish an unfinished document

`/r:spec-brainstorm --continue` picks up where a previous run left off. With a path or topic slug,
use it. Without one, glob `docs/*/interview-notes.md`; if several exist, ask which. If none exists,
say so and start fresh rather than pretending to resume.

Three situations, and the last two are the common ones:

- **`status: interviewing`** — the run was interrupted. Carry on from the first uncovered row.
- **`status: generated-partial`** — the file exists, but the ledger has rows marked `open` or
  `assumed`. This is the case worth supporting well: a document written early is not a finished one.
- **`status: generated`** — the previous run believed it was done. It may have been wrong, and it
  is the run that would know least about it. Treat the status as a claim to check. If the user
  invoked `--continue` on a document that says `generated`, something made them think it wasn't —
  find what.

**On `--continue` you ask. That is the entire point of the mode.** "Decide by default" is for a
first pass, where momentum matters and a guess can be corrected later. Resuming and then quietly
deciding everything yourself is the one outcome that makes `--continue` worthless.

### Audit the ledger before you ask anything

Read the whole notes file first, then **do not take the ledger at face value.** A row an earlier
run marked `answered` may have been decided rather than asked; that is exactly the gap you are here
to find, and it is invisible if you trust the word.

For every settled row, look for its evidence — a quoted answer under `## Answers`, a `path:line` or
URL citation, or a written `n/a` reason. A row with none of those was inferred. Downgrade it to
`assumed`, put it in the gap list, and **say which rows you downgraded**:

> "The ledger says integrations is answered, but nothing under Answers records that question being
> asked — the document names SAP and a bank SFTP drop, and that looks inferred rather than told.
> I'm putting the row back on the list."

The gap list is therefore: every `open` row · every `assumed` row · every row you just downgraded ·
every `Assumed — not confirmed` line · every open question the user could answer in one sentence.
Ask about all of them. Batch them, but ask them.

### Audit the shape too — a document can be complete and the wrong shape

A ledger missing `arch-characteristics`, `style-and-topology` or `decisions` is a document written
before those parts existed. Its rows are not `open` — they were never rows. `check_spec.py` reports
this as *"coverage rows never recorded"*, and it is the signal that this resume is a restructure as
well as a top-up. Say so in the same breath as the ledger audit, and say what it costs:

> "Three of the ledger's rows predate the current shape — characteristics, style and decisions were
> never asked. The document is also in the old nine-section layout. Most of that is a reorder I can
> do from the file, but three things need you: which of your five numbered goals are the two or
> three everything gets traded against, which entities each package writes, and what was actually
> on the table for the decisions the document explains but never names an alternative for."

**Most of a restructure is free, and saying which part isn't is the whole job.** Working through
`sections.md` §1: Parts 1, 2 and 7 are a reorder of prose that already exists. Part 3 is usually an
*extraction* — a goals table with real numbers in it is a characteristics table that was never
called one. Parts 4 and 5 are a split of whatever the old document called modules: what each owns
goes up, topology and how they talk go down. What is genuinely missing is the ranking (which three
are driving), the not-optimising-for list, and Part 6.

### Never manufacture Part 6 from a document that has no Decisions log

A document written before the log existed records its reasoning as prose — a non-goal's "revisit
when", a paragraph explaining where a line falls, a risk with an accepted trade. That prose gives
you Context and Consequences honestly. It almost never gives you **Alternatives**, because the
option that was live at the time was never written down.

So an ADR is written here only when the alternative is *on the record* — named in the document, or
recoverable from a quoted answer under `## Answers`. For every other decision, do one of two things
and never a third:

1. **Ask.** List them in one batch — "these five look like real decisions; what else was on the
   table for each?" — and write the answers into `## Decisions` as they land, so the log exists
   from now on. This is the good outcome and it is usually one round trip.
2. **Name them as defaults.** Part 6 carries the ADRs that are real, then a short list: *"these
   were defaults nobody discussed"*. A short honest Part 6 is a fine document.

**Inventing the alternative is the one thing that is not allowed.** You would be writing the option
*you* would now reject, not the one that was ever considered, and nothing in the finished file
distinguishes the two — so it devalues every genuine ADR beside it. A migration is where this would
happen at scale, which is why the rule is stated here and not left to judgement.

Four rules make resuming safe:

1. **Never re-ask a row with evidence behind it.** Quote their earlier answer when you build on it.
2. **Defaulted assumptions are fair game.** Anything recorded as `assumed` was a guess made to keep
   moving. Offer them back as questions — that's most of the value of continuing.
3. **Open questions get re-triaged.** Anything the user can answer in one line is now a question.
4. **Story names are frozen.** A renamed story silently breaks every `Implements:` line in a plan
   `/r:spec-design` may already have built. New stories append. This binds hardest during a
   restructure: stories move from wherever they were into Part 1, and moving a section is not a
   licence to retitle what is in it.

### After each batch, re-derive the gaps — then offer three choices

Answers open ground. A decision about how the thing installs raises where its binaries come from.
So when a batch lands, work out the *new* gap list before proposing any edit — the list you started
with is already out of date.

Then say what's settled, what isn't, and what you'd default the rest to:

> "Settled this round: who runs it — the same nine engineers, no platform team — and that a failed
> match has to be visible in the app rather than dropped. Still unexplored: which external systems
> it talks to, since the SAP and SFTP lines were inferred (I'd keep both and mark them assumed);
> and retention, currently 12 months on my guess. Keep going on those two, apply what we have and
> file them as assumptions, or stop here?"

**Never offer to apply while the gap list still has something on it.** A user who sees only
"Apply?" has to notice the missing topic themselves, and the whole point of `--continue` is that
they shouldn't have to.

Stop when the gap list is empty, when the user stops you, or when a round produces no new answers
*and* no new gaps.

### Confirm before you touch the file

When the gaps are closed, say what you intend to change, name anything still unanswered, and wait
for a yes:

> "Six answers change four sections: Technologies (two versions pinned), Modules (Settlement now
> async), the v1 line (two stories deferred), and Risks (one accepted). Story names unchanged.
> Nothing left open. Apply?"

On yes, **update in place** — rewrite only the sections those answers touch, leave the rest alone,
refresh the coverage ledger with its verdicts, and set the status. Never regenerate from scratch,
never mint a second folder, and never rewrite a section no new answer affected.

**A restructure is the one resume that touches every section, and it is still not a regeneration.**
Prose that is only moving is moved, not rewritten: same sentences, same numbers, same story names,
under a new part. What is rewritten is what the new shape genuinely changes — a goals table
becoming a characteristics table with a ranking, a modules section splitting in two, the sidebar,
the ids, the seven ledes and Part 6. Say which is which at the gate, because they carry very
different risk:

> "Restructuring into the seven parts. Moving unchanged: problem, non-goals, all 16 stories, the
> domain model, key flows, the keymap, risks. Rewriting: Goals becomes Part 3 with startup and
> repaint as the two driving rows and the other three demoted to supporting; Modules and structure
> splits into Parts 4 and 5; Part 6 gets 4 ADRs from your answers plus 3 choices listed as defaults
> nobody discussed. New: the sidebar, the glance card, the part ledes. Story names unchanged.
> Apply?"

Then re-run `check_spec.py` before showing it. A restructure is the run most likely to leave a dead
anchor or a part with no lede, because it is the only one where the whole file moves at once.

## Step 5 — hand off

Summarize the folder, the mode used, the sections and diagrams included, every row you settled as
`assumed` rather than asked, and anything left in Open questions. Then give the next command:

```
/r:spec-design docs/<topic>/spec.html
```

which turns the document into a phased plan beside it. Offer to refine any section or diagram first
— it's cheaper to fix now than after the plan has been built on top of it.

## Step 6 — record the run

One line into the pack-wide store — counts only, never a topic, a section title or a question the
user answered. **Record even when the user says no at the gate**, with `wrote: false`: a document
that was proposed and declined is the most informative row this skill can write, and dropping it
leaves a store in which every spec was one somebody wanted.

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:spec-brainstorm","mode":"full","rounds":0,"questionsAsked":0,
 "rowsAsked":0,"rowsAssumed":0,"openQuestions":0,"sections":0,"diagrams":0,
 "adrs":0,"adrsFromLog":0,"drivingCharacteristics":0,"restructured":false,
 "researchRan":"skipped","checkerProblems":0,"wrote":false,"blockedReason":null}
STATS_JSON
```

`restructured` is `true` when the resume re-shaped an old-layout document rather than topping up a
current one. Both are `mode: continue` and they are not the same unit of work — one rewrites a file
and interviews for a ranking and a set of alternatives, the other settles two rows — so averaging
their `rounds` and `questionsAsked` together describes neither.

`mode` is `full` | `explain` | `feature` | `continue`, and it is what keeps the other numbers
comparable: an `--explain` run researches and a `--feature` run reads an existing codebase, so their
question counts answer different questions and averaging them reports neither.

**`rowsAsked` against `rowsAssumed` is the bar this skill is tuned on.** Interviewing first and
deciding the rest by default is the whole design, and only that ratio says where the line actually
fell. All-asked means the interview is offloading decisions the skill is supposed to make;
all-assumed means it is guessing at things a single question would have settled, and the guesses
reach the plan and then the code.

**`adrs` against `adrsFromLog` is the honesty check on Part 6.** `adrs` is how many the document
carries; `adrsFromLog` is how many of them trace to a line written in `## Decisions` while the
interview was running. The two being equal is the design working. `adrs` well above `adrsFromLog`
means Part 6 is being reconstructed at write time, which is the failure that makes every ADR in
the document worth less — and it is invisible in the finished file, because a fabricated
alternative reads exactly like a real one.

**`drivingCharacteristics` should be 2 or 3.** One means round 5 produced a single number and
nothing was traded; more than three means the forced trade-off was asked and then not enforced,
and every decision below Part 3 can now point at whichever characteristic suits it.

**`checkerProblems` is what `check_spec.py` reported on the first run**, before fixing. Consistently
zero means Step 4 is not earning its place; consistently high means this skill writes documents it
already knows how to reject.

**`wrote: false` with no `blockedReason` is a decline; with one it is a blockage.** They need
opposite fixes — a declined document means the proposal was wrong, a blocked one means the skill
could not run — and a row that conflates them reads as the first while being the second.

The script always exits `0` — a lost row is a lost row, never a failed run, and it must never change
what was written. Never retry it.

## Never do this

- Never reference a path outside this skill's directory.
- Never create or change `spec.html` before the user has said yes to what you're about to write.
  `interview-notes.md` is the working transcript and is written as you go.
- Never ask how big or how serious the project is. Read it from the answers and say how you read it.
- Never offer "apply?" or "write it?" as the only choice while a coverage row is still `open` or
  `assumed` — offer another round on those topics too, and say what you'd default them to.
- Never record a decision you made as `answered`. It becomes invisible to `--continue`, which is
  the one mechanism that would have caught it.
- Never read `status: generated` as proof there is nothing left to continue, and never read a
  complete-looking document as proof it is in the current shape.
- Never write an ADR for a decision whose alternative was never recorded. Ask for it, or list the
  choice as a default nobody discussed.
- Never rewrite prose during a restructure that is only moving. Moving a section is not a licence
  to reword it, and least of all to retitle a story.
- Never ask what you could decide yourself and record as an assumption.
- Never ask what a grep, a read or a fetch could answer. State what you found.
- Never accept an adjective as a requirement. Reflect it back as a number or a rule.
- Never state a price, quota, limit or version you did not read this session.
- Never introduce a component, service or technology no story and no characteristic forces.
- Never drop one of the seven parts. Shorten it to three sentences; a missing part reads exactly
  like a question nobody asked.
- Never let a characteristic through as an adjective, and never carry more than three as driving.
- Never write an ADR at generate time that was not logged during the interview, and never write
  one whose only alternative you invented to fill the field.
- Never argue a decision inline in Parts 4, 5 or 7 — state the outcome and point at its ADR.
- Never emit FR-, NFR-, BR-, R- or OQ- style requirement ids. `ADR-<n>` is the only id scheme
  here; story handles are their `<h3>` names.
- Never write schema columns, indexes, code or build phases — that is below this document's ceiling.
- Never write a `todo.md` here — that's `/r:spec-design`.
- Never object twice to the same decision.
- Never claim research ran when it didn't, and never run it without `--explain`.
