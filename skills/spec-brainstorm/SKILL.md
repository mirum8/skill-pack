---
description: >-
  Understand a business domain and decide what to build in it - then write both into one
  self-contained docs/<topic>/spec.html: the domain model, user stories, key flows, the module
  or service structure, named technologies with versions, and the API. Interviews first, decides
  the rest by default, and never writes without a yes. Use for ANY request to spec, design or
  architect a build - "brainstorm", "spec this out", "write a design doc / PRD / RFC / technical
  design", "help me architect X", "how should I build X", "design a feature for my app", "explain
  this domain to me", "/r:spec-brainstorm" - and whenever someone describes an idea or a feature
  and wants it designed and written down rather than coded. Fits a weekend project and a work
  system without asking which. Add --explain when the domain is unfamiliar: it adds the domain
  narrative, actors, event timeline, glossary and a worked example, and researches how the
  industry actually builds this. Use --feature for a feature inside an existing repo
  ("/r:spec-brainstorm --feature let users export invoices as CSV") - it reads the code first.
  --continue resumes an unfinished or under-interviewed document. NOT for the phased
  implementation plan - that's /r:spec-design.
model: fable
effort: high
---

# Brainstorm to specification

Interview the user, then write `docs/<topic>/spec.html` — one self-contained page holding what
the domain is and what to build in it — plus `interview-notes.md`, the answer log.

**The ceiling.** This document describes the domain model, user stories, key flows, modules and
services, named technologies, and the API. It stops there. No column types, no indexes, no code,
no build order — those belong to `/r:spec-design`, which reads this document and writes `todo.md`
beside it: it decides the build order *and* the design contracts (schema with real types and
indexes, endpoint signatures, module boundaries) that this document deliberately stops short of.
Writing the code is `/r:task-run`. Don't write phases here — two plans drift within a day.

**It fits the project it is given.** There is no depth question and no size flag. A weekend tool
has no integrations and no operations material, so those sections don't exist in its document; a
work system's answers fill them. A section with nothing real to say is deleted, not padded. Say
in one line how you read the project so a wrong read costs one sentence.

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

**Default.** Interview, then the document: problem and non-goals · domain model · user stories ·
key flows · modules & structure · technologies · API · the v1 line · risks, assumptions and open
questions. No web research.

**`--explain`.** Everything above, plus the layer that teaches the domain — narrative, actors,
event timeline, glossary, a worked example, why the rules are what they are — and the research
that feeds it. Reach for it when the domain is unfamiliar, or when the user is trying to
understand a business as much as build in it.

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
| write `spec.html` | `references/sections.md`, then `references/html.md` | which sections exist, page and diagram style |

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

**Read `references/interview.md` in full now.** It owns the three rules every question passes,
the seven-round funnel, the question bank and the rules for pushing back. Do not improvise
questions.

The three rules, so you know what you are reading for:

1. **Order by leverage.** Scope reshapes the entity list, which reshapes the boundaries, which
   reshape the API. Asking about pagination while the scope is open produces a confident document
   about the wrong system.
2. **Style follows reversibility.** Expensive to get wrong → ask openly. Moderate → propose the
   answer and let them correct it. Cheap and conventional → assert the default and invite a veto.
   People correct far better than they compose.
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

**Stop. Show the plan and wait for a yes before writing anything** — the sections you'll include,
the diagrams, and anything you defaulted rather than asked. Writing first and summarizing
afterwards is not confirmation.

If any coverage row is still `open` or `assumed`, this gate is not a yes/no. Name those rows, say
what you'd default each to, and offer the third option the user actually wants: **another round on
them.** Reaching for the write gate while a topic has never been discussed puts the user in the
position of having to notice the hole themselves — and they usually notice it after the file is
written, which is the expensive moment.

- **3a** — read `references/sections.md`, draft the section plan, read `references/html.md`, write
  `docs/<topic>/spec.html`.
- **3b** — set the status in `docs/<topic>/interview-notes.md`: `generated` only if every coverage
  row is `answered`, `repo`, `research` or `n/a`; `generated-partial` if any row is `open` or
  `assumed`. That flag is how `--continue` finds unfinished work later, so set it honestly even
  when the file looks complete — a defaulted row is unfinished work no matter how good the default
  was.

The document must carry **user stories with stable bold names** and a stated **v1 line**.
`/r:spec-design` consumes both; a document without them cannot be turned into a plan that traces
back to anything.

## Step 4 — check the output

Mechanical checks are a script's job, not a checklist you run in your head:

```
python3 "${CLAUDE_SKILL_DIR}/scripts/check_spec.py" docs/<topic>/
```

Fix everything it reports, then re-run until clean. It catches unversioned technology, placeholder
text, filler prose, a story with no acceptance criteria, a v1 line naming a story that isn't
defined, a claim about existing code with no `path:line`, a coverage row settled with no evidence,
and — under `--explain` — confidence tags that stopped partway or cite no source. These are the
failures invisible on a read-through, which is why they belong to a script.

Then five judgments a script cannot make. Be willing to delete your own work here.

1. **Proportionality** — does any module, technology or section exist that no story forces? Cut it.
2. **Substance** — does any section restate its heading, or say "follow best practices"? Delete it
   rather than pad it. An empty section is better than a filled one that says nothing.
3. **Altitude** — has anything drifted below the ceiling: column types, indexes, code, build order?
4. **Honesty** — is any claim about a third-party product stated more strongly than what you read?
5. **Domain** — would a developer new to this industry understand *why* the model is what it is?

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

Four rules make resuming safe:

1. **Never re-ask a row with evidence behind it.** Quote their earlier answer when you build on it.
2. **Defaulted assumptions are fair game.** Anything recorded as `assumed` was a guess made to keep
   moving. Offer them back as questions — that's most of the value of continuing.
3. **Open questions get re-triaged.** Anything the user can answer in one line is now a question.
4. **Story names are frozen.** A renamed story silently breaks every `Implements:` line in a plan
   `/r:spec-design` may already have built. New stories append.

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
 "researchRan":"skipped","checkerProblems":0,"wrote":false,"blockedReason":null}
STATS_JSON
```

`mode` is `full` | `explain` | `feature` | `continue`, and it is what keeps the other numbers
comparable: an `--explain` run researches and a `--feature` run reads an existing codebase, so their
question counts answer different questions and averaging them reports neither.

**`rowsAsked` against `rowsAssumed` is the bar this skill is tuned on.** Interviewing first and
deciding the rest by default is the whole design, and only that ratio says where the line actually
fell. All-asked means the interview is offloading decisions the skill is supposed to make;
all-assumed means it is guessing at things a single question would have settled, and the guesses
reach the plan and then the code.

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
- Never read `status: generated` as proof there is nothing left to continue.
- Never ask what you could decide yourself and record as an assumption.
- Never ask what a grep, a read or a fetch could answer. State what you found.
- Never accept an adjective as a requirement. Reflect it back as a number or a rule.
- Never state a price, quota, limit or version you did not read this session.
- Never introduce a module, service or technology no story forces.
- Never write schema columns, indexes, code or build phases — that is below this document's ceiling.
- Never write a `todo.md` here — that's `/r:spec-design`.
- Never object twice to the same decision.
- Never claim research ran when it didn't, and never run it without `--explain`.
