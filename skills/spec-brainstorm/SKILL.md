---
description: >-
  Turn an idea or feature request into a developer-ready specification - a researched design doc
  covering the business domain, a comparison of existing solutions, a proposed architecture,
  requirements and risks - written to docs/<topic>/spec.html, plus an interactive
  architecture.html when the system has more than one moving part worth drawing. Use for ANY
  request to spec, design or architect a build - "brainstorm", "spec this out", "write a design
  doc / PRD / RFC / technical design", "help me architect X", "how should I build X", "design a
  feature for my app", "what already exists for this?", "/r:spec-brainstorm" - and whenever
  someone describes an idea or feature and wants it designed and written down rather than coded.
  Researches prior art in parallel when the domain warrants it. For a feature inside an existing
  repo use --feature ("/r:spec-brainstorm --feature let users export invoices as CSV") - it reads
  the code first and asks neither the scope nor the depth question. Also accepts --small /
  --standard / --enterprise to set depth, and --continue to resume an unfinished or
  under-interviewed spec. NOT for the phased implementation plan - that's /r:spec-plan.
model: opus
effort: xhigh
---

# Brainstorm to specification

Interview the user, research what already exists, then write into `docs/<topic>/`: `spec.html` (the
specification), `architecture.html` (an interactive diagram), and `interview-notes.md` (the answer log).

The phased implementation plan is a separate job — `/r:spec-plan` reads the spec this skill produces and
writes `todo.md` beside it. Don't write phases here; the spec carries requirement ids and a v1 line, which is
what that skill consumes.

## Never write a deliverable until the user says yes

The two deliverables are `spec.html` and `architecture.html`. Before creating or changing either, say what you
are about to write and wait for an explicit go-ahead. Not "generating now", not a summary after the fact — a
stop, and an answer.

This applies to the first spec and to every later edit. A spec is something the user reads, shares and builds
on; changing it under them without asking destroys their ability to trust what it says. When resuming, name
the sections that will change and what will change in them.

If they say go, write. If they say wait, wait. If they don't answer, don't write.

**`interview-notes.md` is the exception, and it is not really one.** It is the working transcript of this
conversation, not a document the user is asked to accept — so it is written continuously, from the first answer
batch onwards, with no gate. Gating it would mean asking permission to remember, and an interview that gets
interrupted before permission is granted is lost entirely. The gate protects the reader of the spec; the notes
have no reader but you and the next `--continue`.

## `--feature` — a feature inside this repo

`/r:spec-brainstorm --feature let users export invoices as CSV` is the short path, and it is the common one.

The flag settles **scope** — a feature inside an existing codebase — so neither the scope question nor the
depth question gets asked. Go straight to reading the repo (`references/interview.md` §6) and open with what
you found there.

Depth defaults to **standard**, announced in one line so it can be overridden with one word: *"Treating this
as a standard-depth feature — say small if you want it shorter."* This is not the skill inferring a depth
against the user's wishes; it is skipping a question the repo has already answered. The stack, the hosting,
the storage and the compliance posture are all fixed by the code, and depth mostly decides how many sections
exist. `--feature --small` and `--feature --enterprise` both work when the user says so.

Everything else is unchanged: the delta rounds, the `path:line` rule, the coverage floor, the write gate.

## Pick the depth first

The user chooses. Do not infer it, do not score it, do not argue with it.

If the invocation carries `--small`, `--standard` or `--enterprise`, use it and say which you're using. With
`--feature` and no depth flag, take standard and say so — see above. If it carries neither, ask once — a
single question, before anything else:

- **small** — a personal or internal tool. One or two people build it, failure is an inconvenience.
- **standard** — a real product with real users. Someone's work or money depends on it.
- **enterprise** — regulated, safety-relevant, or moving customer money. Auditors, named regulations, or a
  contractual SLA are in play.

If the answer sounds wrong once you know more, say so in one sentence and let them re-pick. Never silently
upgrade.

Depth decides which coverage rows apply and how much detail each section carries — not how many questions you
may ask. Each number has exactly one home, named in the table below; if the same number appears in two files,
the reference file wins and the duplicate is a bug worth reporting.

**Content triggers, independent of depth.** These decide which sections *exist*, not how deep the document
goes, so they fire at every depth. No trigger, no section — this is what keeps a small spec small.

Watch for: cards or checkout · patients or health records · EU/UK personal data · banks, payment rails or
IBANs · SSO and enterprise buyers · tenants or white-label · realtime, telemetry or IoT · migrating off an
existing system · an LLM or model making decisions.

`references/spec-sections.md` says what each one adds. Note which fired; don't write the module yet.

## Read these before you act

At each gate, read the named file **in full**. Skimming one produces output that looks right and is wrong in
ways nobody catches until implementation.

| Before you… | Read | It owns |
|---|---|---|
| ask the first question | `references/interview.md` | the coverage floor, rounds, when to push back |
| dispatch research agents | `references/research.md` | agent counts, lookup caps, honesty rules |
| write `spec.html` | `references/spec-sections.md`, then `references/spec-html.md` | which sections exist, page style |
| write `architecture.html` | `references/architecture-html.md`, then `references/architecture-example.html` | diagram contract, sizing |

## Step 0 — ground yourself

Do this silently, then report it in one line.

- **Resume.** Glob `docs/*/interview-notes.md`. If one exists, say so and offer to continue it, restart it, or
  start something else. `--continue` skips that offer — see the section below.
- **Existing plan guard.** If the repo already has a document that owns its plan — a root `PROJECT.md`, or a
  spec another tool maintains — say so and offer to extend that instead. Writing a second spec beside one that
  is already being kept current gives the repo two answers to the same question, and the stale one wins about
  half the time.
- **Existing docs.** Read `README`, `CLAUDE.md`, `docs/`, any ADRs. Never re-derive a decision already
  written down.
- **Collision.** If `docs/<topic>/` exists, read it, say so, and update in place. Never mint `<topic>-2`.
- **Slug.** 2–4 words, kebab-case, no dates, no `-spec` suffix — the folder already means "spec".

## `--continue` — finish an unfinished spec

`/r:spec-brainstorm --continue` picks up where a previous run left off. With a path or topic slug, use it. Without
one, glob `docs/*/interview-notes.md`; if several exist, ask which. If none exists, say so and start fresh
rather than pretending to resume.

Three situations, and the last two are the common ones:

- **`status: interviewing`** — the run was interrupted. Carry on from the first uncovered row.
- **`status: generated-partial`** — the files exist, but the `## Coverage` ledger has rows marked `open` or
  `assumed`, or the spec leans on assumptions and open questions that the user could actually answer. This is
  the case worth supporting well: a spec that got written early is not a finished spec.
- **`status: generated`** — the previous run believed it was done. It may have been wrong, and it is the run
  that would know least about it. Treat the status as a claim to check, not a verdict: audit the ledger below
  before concluding there is nothing to continue. If the user invoked `--continue` on a spec that says
  `generated`, something made them think it wasn't — find what.

**On `--continue` you ask. That is the entire point of the mode.** The "decide by default" rule in Step 1 is
for a first pass, where momentum matters and a guess can be corrected later. It does not apply here. The user
came back *specifically* to be asked — resuming and then quietly deciding everything yourself is the one
outcome that makes `--continue` worthless.

### Audit the ledger before you ask anything

Read the whole notes file first — coverage ledger, answers, assumptions, open questions. Then **do not take
the ledger at face value.** A row an earlier run marked `answered` may have been decided rather than asked;
that is exactly the gap you are here to find, and it is invisible if you trust the word.

For every settled row, look for its evidence — a quoted answer under `## Answers`, a `path:line` or URL
citation, or a written `n/a` reason. A row with none of those was inferred. Downgrade it to `assumed`, put it
in the gap list, and **say which rows you downgraded**, so the user sees where the previous run got ahead of
itself:

> "The ledger says integrations is answered, but nothing under Answers records that question being asked —
> the spec names PagerDuty and Slack, and that looks inferred rather than told. I'm putting the row back on
> the list."

The gap list is therefore: every `open` row · every `assumed` row · every row you just downgraded · every
`Assumed — not confirmed` line · every open question the user could answer in one sentence. Ask about all of
them. Batch them, but ask them.

Four rules make resuming safe:

1. **Never re-ask a row with evidence behind it.** Re-asking what someone already answered is the fastest way
   to lose their trust in the transcript. Quote their earlier answer when you build on it.
2. **Defaulted assumptions are fair game.** Anything recorded as `assumed` or `Assumed — not confirmed` was a
   guess made to keep moving. Offer them back as questions — that's most of the value of continuing.
3. **Open questions get re-triaged.** Anything the user can answer in one line is now a question. Only what
   genuinely needs someone absent stays filed.
4. **Requirement ids are frozen.** `FR-7` stays `FR-7`. New requirements append. `/r:spec-plan` may already
   have built a plan against those ids, and renumbering silently breaks every `Implements:` line.

### After each batch, re-derive the gaps — then offer three choices

Answers open ground. A decision about how the thing installs raises where its binaries come from; a decision
about who operates it raises what they get paged for. So when a batch of answers lands, work out the *new*
gap list before you propose any edit — the list you started with is already out of date.

Then say what's settled, what isn't, and what you'd default the rest to. Three real options, every time:

> "Settled this round: who runs it — the same nine engineers, no platform team — and that a failed
> notification has to be visible in the app rather than dropped. Still unexplored: which external systems it
> talks to, since the PagerDuty and Slack lines were inferred (I'd default to keeping both and marking them
> assumed); and retention, currently 12 months on my guess. Keep going on those two, apply what we have and
> file them as assumptions, or stop here?"

**Never offer to apply while the gap list still has something on it.** Applying is what you offer once the
list is empty, or what the user picks over continuing — it is never the only thing on the table. A user who
sees only "Apply?" has to notice the missing topic themselves, and the whole point of `--continue` is that
they shouldn't have to.

Stop when the gap list is empty, when the user stops you, or when a round produces no new answers *and* no new
gaps. Nothing else ends it — not a question count, not a feeling that the spec looks finished.

### Confirm before you touch the files

This spec has already been read. Changing it without warning is not the same as writing a new one — the user
may have shared it, quoted it, or built on it. So when the gaps are closed, say what you intend to change,
name anything still unanswered, and wait for a yes:

> "Six answers change four sections: Distribution (new), Non-goals (three added), NFR-2 (24h → 1h), and
> Prior art (two candidates now ruled out by the licence constraint). FR ids unchanged. Nothing left open.
> Apply?"

On yes, **update in place** — rewrite only the sections those answers touch, leave the rest alone, refresh the
coverage ledger with its verdicts, and set the status. Never regenerate from scratch, never mint a second
folder, and never rewrite a section no new answer affected.

## Step 1 — scope, then interview

**Scope** is the first question after depth, because it reshapes everything: a new service · a feature inside
an existing codebase · replacing an existing system. `--feature` settles it, and on `--continue` both scope
and depth are already settled in the notes — don't re-ask them in either case.

For the feature and replacement scopes, read the repo before asking anything else, and hold to the rule that
no claim about the existing system enters the spec without a `path:line` citation.

**Read `references/interview.md` in full now.** It owns the round structure, the coverage floor, the question
bank and the rules for pushing back. Do not improvise questions.

**Decide by default. Ask only what only they can answer.** This is the rule that matters most, because
breaking it destroys the user's confidence faster than any wrong answer. It applies to a first pass only —
on `--continue` you ask about every gap, because that is what the user invoked it for.

Ask when the answer is something no amount of reading, searching or thinking would give you — their
constraints, their preferences, their deadline, facts about their organisation or their users. Everything
else you decide yourself, write into the assumptions block, and let them overrule in one line.

The spec is editable and `--continue` exists, so a wrong guess costs one sentence of correction. That makes
guessing cheaper than asking almost every time. Guess, and say that you guessed.

**Saying you guessed is what makes the rest of this true.** A decision you made goes into the coverage ledger
as `assumed`, never as `answered` — the verdicts are in `references/interview.md` §10. Written honestly, a
guess is a decision the user can overturn later. Written as an answer, it is indistinguishable from something
they told you, and `--continue` will never think to raise it again.

Every question must also be about the thing being designed. If it has no such area, that area is settled as
not applicable — write down why and move on. **Never ask a question to confirm that something doesn't apply**,
and never hand someone a multiple choice between options you were perfectly able to choose between.

**The interview ends two ways only: every coverage row is settled, or the user stops it.** There is no question
quota. After each round, say what's covered and what isn't, and offer to generate or keep going. After every
answer batch, append to `docs/<topic>/interview-notes.md`, including its `## Coverage` ledger.

## Step 2 — research

**Read `references/research.md` now**, then dispatch the agents it defines **in a single message** so they run
in parallel. Announce it in one line and don't ask anything while waiting.

Research fires *after* the first round — before that you don't yet know what to research, and the result is a
generic comparison table nobody needed. If the `Agent` tool is missing (this skill running nested inside a
subagent), degrade to serial `WebSearch` and **say so** — never fake the fan-out.

On the `--feature` path the repo *is* the research and the external fan-out is off unless a specific question
survives reading the code — `interview.md` §6 names the beat and the three conditions that reopen it. Say in one
line which way it went, so the user knows whether anything was searched.

When the research lands, **you talk first**: in ≤120 words, name the problem category in the industry's own
vocabulary, list the components that recurred across the systems you found, and say what you copy versus what
you deliberately do differently. Then ask only about the decisions where prior art genuinely disagrees, each as
two named options with the force that decides it and your recommendation. Everything the field already agrees
on is a statement, not a question.

## Step 3 — write the files

**Stop. Show the plan and wait for a yes before writing anything** — the sections you'll include, the
diagrams, and anything you defaulted rather than asked. Writing first and summarizing afterwards is not
confirmation.

If any coverage row is still `open` or `assumed`, this gate is not a yes/no. Name those rows, say what you'd
default each to, and offer the third option the user actually wants: **another round on them.** Reaching for
the write gate while a topic has never been discussed puts the user in the position of having to notice the
hole themselves — and they usually notice it after the file is written, which is the expensive moment.

The two HTML files have deliberately opposite contracts. Check against this table rather than trusting memory:

| | `spec.html` | `architecture.html` |
|---|---|---|
| Purpose | the readable document | the one-screen diagram |
| Palette names | document set (`--ivory`, `--gray-*`, `--slate`) | diagram set (`--bg`, `--ink`, `--muted`, …) |
| Theme | light only | light **+** `html.dark` |
| Toggle · `localStorage` · apply-before-paint | never | required |
| `<script>` anywhere | **none at all** | required |
| SVG | static figures in flow | one interactive full-screen stage |
| Layout | scrolling `max-width` sheet | `overflow: hidden` flex column, 100vh |

The two palettes share their light values under different alias names — `--ivory` *is* `--bg`, `--slate` *is*
`--ink`, `--gray-500` *is* `--muted`. The diagram set adds tint, line and zone colours the document doesn't
need, plus a dark override. Each reference file lists its own full set; use each file's own names inside that
file and they cannot contradict each other.

Each file inlines its **own** stylesheet. Never factor a shared `style.css` — that breaks the standalone
promise for both. Cross-links are bare relative filenames: `href="architecture.html"`.

- **3a** — read `references/spec-sections.md`, draft the section plan, read `references/spec-html.md`, write
  `docs/<topic>/spec.html`.
- **3b** — read `references/architecture-html.md`, then `references/architecture-example.html`, write
  `docs/<topic>/architecture.html`. At **small** depth this file is optional: write it only if the system has
  more than one moving part worth drawing.
- **3c** — set the status in `docs/<topic>/interview-notes.md`: `generated` only if every coverage row is
  `answered`, `repo`, `research` or `n/a`; `generated-partial` if any row is `open` or `assumed`. That flag is
  how `--continue` finds unfinished work later, so set it honestly even when the files look complete — a
  defaulted row is unfinished work no matter how good the default was.

The spec must carry stable `FR-n` requirement ids and a stated v1 line. `/r:spec-plan` consumes both; a spec
without them cannot be turned into a plan that traces back to anything.

## Step 4 — check the output

Mechanical checks are a script's job, not a checklist you run in your head:

```
python3 <this skill>/scripts/check_spec.py docs/<topic>/
```

Fix everything it reports, then re-run until clean. It catches inconsistent requirement ids, unversioned
technology, placeholder text, filler prose, palette bleed and diagram desync — plus the four failures that only
show up at length: confidence tags that stopped partway or cite no source, a missing v1 line or an `FR-n`
referenced but never stated, an open question with no default, and Codebase facts asserted without `path:line`.
These are the failures that are invisible on a read-through, which is why they belong to a script.

Then five judgments a script cannot make. Be willing to delete your own work here.

1. **Proportionality** — does any component exist that no requirement forces? Cut it.
2. **Substance** — does any section restate its heading, or say "follow best practices"? Delete it rather than
   pad it. An empty section is better than a filled one that says nothing.
3. **Honesty** — is any claim about a third-party product stated more strongly than what you actually read?
4. **Buildability** — could someone who has never seen this conversation build phase 1 from what's written?
5. **Domain** — would a developer new to this industry understand *why* the requirements are what they are?

## Step 5 — hand off

Summarize the folder, the depth used, the sections and diagrams included, every row you settled as `assumed`
rather than asked, and anything left in Open questions. Then give the next command:

```
/r:spec-plan docs/<topic>/spec.html
```

which turns the spec into a phased plan beside it. Offer to refine any section or diagram first — it's cheaper
to fix the spec now than after the plan has been built on top of it.

## Never do this

- Never reference a path outside this skill's directory.
- Never infer or upgrade the depth the user chose. Taking standard on `--feature` is not that — it is a
  stated default, announced in the same breath and overridable with one word.
- Never create or change `spec.html` or `architecture.html` before the user has said yes to what you're about
  to write. `interview-notes.md` is the working transcript and is written as you go.
- Never offer "apply?" or "write it?" as the only choice while a coverage row is still `open` or `assumed` —
  offer another round on those topics too, and say what you'd default them to.
- Never record a decision you made as `answered`. It becomes invisible to `--continue`, which is the one
  mechanism that would have caught it.
- Never read `status: generated` as proof there is nothing left to continue — audit the ledger against its
  evidence first.
- Never ask what you could decide yourself and record as an assumption. The spec is editable; a wrong guess
  costs one line, and asking costs their patience.
- Never ask a question that isn't about the thing being designed.
- Never ask what a grep, a read or a fetch could answer. State what you found.
- Never accept an adjective as a requirement. Reflect it back as a number or a rule.
- Never state a price, quota, limit or version you did not read this session.
- Never introduce a component no requirement forces.
- Never write phases or a `todo.md` here — that's `/r:spec-plan`, and two plans drift within a day.
- Never object twice to the same decision.
- Never claim research ran when it didn't.
