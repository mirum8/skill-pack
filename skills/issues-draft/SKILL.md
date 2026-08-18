---
description: >-
  Turn a free-text message — a client email, a chat dump, meeting notes, a numbered wishlist — into
  a verified backlog file: split it into discrete asks, check each one against the actual codebase
  (already built? built differently from what the sender assumes? which files it touches?), separate
  the real work from the questions, and write `issues-<slug>.md`, an unticked checklist
  `/r:issues-fix` can consume directly, alongside `issues-<slug>-notes.md` carrying the questions,
  the already-built findings and anything that moves architecture or the estimate. Titles keep the
  sender's own wording and numbering, so every line maps back to the message it came from, in any
  language. Use when the user pastes or points at a message full of asks — "turn this into issues",
  "make a backlog out of this email", "check these against the code and write them up", "разбери
  эти правки". NOT for: working through a backlog that already exists (`/r:issues-fix`), designing
  something nobody has specified (`/r:spec-brainstorm`), or phasing a written spec (`/r:spec-plan`).
effort: high
---

# issues-draft

Take a message written by a human — a client email, a chat thread, a meeting note, a numbered list of complaints and wishes — and turn it into two documents: a **backlog file** of verified, actionable work, and a **notes file** that answers the sender. Between the two sits the step that makes this worth doing: every ask is checked **against the actual code** before it is written down as work.

The two files have two different readers, and that is the whole reason there are two of them:

- **`issues-<slug>.md` is machine input.** `/r:issues-fix` reads it, so it holds only items that are real work, in exactly the shape that parser expects. A question sitting in it costs a read-only verifier on every future run and never becomes anything.
- **`issues-<slug>-notes.md` is the reply.** Questions that need the sender to answer, asks the code has already overtaken, places where the sender's description of current behaviour is simply not what the code does, and anything that moves architecture or the estimate. Nobody hands a client a checklist of internal risk ratings, and nobody implements from a discussion document.

Four things shape the design:

- **The sender's numbering is the primary key.** Their item 6 has to stay findable as `[#6]` in both files. A reply they cannot line up against their own message is a reply they have to re-read the original to use, and the single most common way this whole exercise wastes their time.
- **Splitting is where meaning gets lost, not verification.** A numbered message is nearly free to split. Prose is not: one sentence often carries an ask plus its rationale, and one paragraph occasionally carries two unrelated asks. Both mistakes — merging two asks to tidy the list, promoting a rationale into an item of its own — produce a file that looks right and is wrong.
- **Verification answers the *sender's* question, not the implementer's.** Three outcomes matter to the person who wrote the message: it is not built, it is already built, or **it is built differently from what they assume**. That third one is why the code gets read at all — a message asserting "verification is still shown separately" is stating a fact about the system, and that statement can be out of date.
- **Nothing here changes code.** No branch, no fix, no edit outside the two output files. This skill produces documents, and `/r:issues-fix` is what acts on them.

## Invocation

`/r:issues-draft [<message | @file>] [--out <slug|path>] [--no-verify]`

**The message** is the text itself, pasted into the prompt, or `@notes.md` / a path to a file holding it (strip a leading `@` and any trailing `/`). With no argument, use the message already in this conversation — that is the common case, since the text usually arrives as the user's own paste. If there is no message in reach, ask for one; that is the only place this run stops for input.

- **`--out <slug|path>`** → name the output. A bare slug becomes `issues-<slug>.md` and `issues-<slug>-notes.md`; a path is used as given, with `-notes` inserted before the extension for the second file. Default: a slug from the project or the subject of the message, written into an existing `issues/` directory if the repo has one and at the repo root otherwise — a project that keeps a folder for these has already decided where they go, and it is usually ignored by git on purpose.
- **`--no-verify`** → split and classify without reading any code. For a message that arrives before the repo does, or one about a codebase you do not have here. The backlog is still written; every item is marked `unverified` in the notes and the report says so, because an unverified backlog looks exactly like a verified one on disk.

## Step 0 — Resolve the message and the codebase

Establish both before anything else, and say what you resolved:

1. **The message.** Argument, file, or the conversation. Record how many discrete asks you expect to find (a numbered list announces its own count — use it as a check on Step 1, not as an instruction).
2. **The codebase to verify against.** The current repo by default. Note the branch and the short commit, and put both in the backlog file's header: verification is a statement about one revision, and a month later that header is the only thing that says which one.
3. **No repo, or no code that relates to the message** → say so and continue as `--no-verify`. Never quietly skip verification and present the result as if the code had been read; the whole value of the notes file is that somebody looked.

## Step 1 — Split into asks

One ask, one item. Work through the message in order and keep the sender's numbering.

- **A numbered or bulleted message** maps one-to-one. Keep their numbers even where they are wrong (duplicated, skipped, restarting at 1) — the number is a pointer back to their text, not an index you own.
- **Prose** needs judgement. An ask plus its justification is **one** item ("split chat messages from system notifications — right now they mix and messages get lost"): the second clause is why, and it belongs in the item's body, not in a second item. One paragraph making two unrelated demands is **two** items, both carrying the same source number, distinguished as `[#5a]` / `[#5b]`.
- **Meta-instructions are not asks.** "Let me know if any of this affects the estimate", "thanks in advance", "as we discussed" — these shape the *reply*, and several of them state a real requirement for the notes file. Record them as instructions to yourself, never as backlog items.
- **Preserve the sender's wording in the title, verbatim, in their language.** Do not translate it, tidy it, or make it imperative. The acceptance criteria beneath are yours to write, in English, because those are read by the implementer and by `/r:task-run`.

If the count you end with differs from the count the message announced, say so in the report and name which items you merged or split. A silent 16 → 14 is how two asks disappear.

## Step 2 — Verify each ask against the code (parallel, read-only)

Using the Agent tool, spawn **one read-only verifier per ask**, all at once — nothing here writes, so nothing here has to be serial. Use `Explore` for pure code-reading, which is nearly every case; use `r:bug-hunter` only when an ask claims a defect that has to be reproduced to be believed.

Brief each verifier with the ask's number, its verbatim text, and any surrounding context from the message, and have it answer four questions from the code:

- **Does this already exist?** Not "could it be built" — is it there now, and where.
- **Does the sender's description of current behaviour match the code?** This is the question they actually asked and the one they cannot answer themselves. Record what the code does today with a `file:line`, so the notes can quote it rather than assert it.
- **What would make this done?** Two to four testable acceptance criteria, in English, concrete enough that someone could implement against them without the original message.
- **What would it touch, and how deep does it cut?** `touches` as concrete paths or classes; `risk` as `cosmetic` | `local` | `deep`. These do **not** go in the backlog file (Step 4) — they are what tells you whether an ask is architecture-shaped, which the sender asked about.

Have each return a compact structured verdict, so your context stays a ledger rather than a pile of transcripts:

```
{ n: "6", title: "<verbatim, sender's language>",
  outcome: "work" | "question" | "already-done" | "unclear",
  category: "bug" | "feature" | "chore",              // when outcome = work
  current_state: "<what the code does today> (<file:line>)",
  contradicts_sender: true | false,                   // their premise does not match the code
  criteria: ["<testable, English>", …],               // when outcome = work
  touches: ["<file/module>", …],
  risk: "cosmetic" | "local" | "deep",
  impact: "none" | "architecture" | "estimate" | "both",
  note: "<1–2 lines for the sender, when there is something to say>" }
```

Two fields carry weight the others do not. **`contradicts_sender` is orthogonal to `outcome`** — an ask can be perfectly good work *and* rest on a wrong premise, and folding the two together loses whichever one you did not encode. **`impact` is orthogonal to `category`** — a small feature can move architecture and a large one need not, so it is judged from `touches` and `risk`, never from how big the ask sounds.

`outcome: "question"` is for an ask that is asking rather than requesting — "clarify what X currently means", "what does this setting affect?". These are the sender's own questions, and answering them from the code is one of the most valuable things this skill does. `outcome: "unclear"` is different and worth keeping separate: a real request nobody could implement from what it says. One needs an answer; the other needs the sender to say more.

Verifiers are **strictly read-only**. They read, they report; they never edit, never touch git, never write either output file.

## Step 3 — Route each ask

Every ask lands in the backlog, the notes, or both. The routing is mechanical once Step 2 is done — resist re-litigating a verdict here:

| verdict | backlog | notes |
|---|---|---|
| `work`, premise holds | ✓ | only if `impact` is not `none` |
| `work`, `contradicts_sender` | ✓ | ✓ — what the code actually does today |
| `already-done` | — | ✓ — where it is, so they can go look |
| `question` | — | ✓ — under Questions, answered from the code where you can |
| `unclear` | — | ✓ — naming exactly what you need in order to size it |

An `already-done` ask whose *current* behaviour still is not what the sender wants is **`work`**, not `already-done` — "built" and "built the way they asked" are different claims, and only the second one closes an ask.

## Step 4 — Write the two files

Write both, always, even when one has a single entry — a missing notes file reads as "nothing to flag", which is a claim, and usually a false one.

The **backlog file** holds title plus acceptance criteria and nothing else. It deliberately carries no `touches` and no `risk`: `/r:issues-fix` re-derives both against the code as it stands when the fix actually happens, and a hint that has aged into a lie is worse than no hint. The exact format both files use — and the parser contract the backlog side has to satisfy — is [references/output-format.md](references/output-format.md). Read it before writing anything.

Both files are **new documents you own**. If one already exists, do not silently overwrite it: say so, and either write beside it under a new slug or merge into it, keeping every existing ticked item exactly as it is. An item already ticked in a previous run is done — never re-offer it and never un-tick it.

## Step 5 — Report

Say what happened, in the shape the sender's own message can be checked against:

```
Message: 16 numbered asks → issues-carnet.md (12 items) + issues-carnet-notes.md (6 entries)
Verified against avtoportal @ main 4c953b5.

Backlog (12):
  [#1] Rename Auto Import → «Карнетъ»            feature   cosmetic
  [#2] Rename a created deal                     feature   local
  [#8] Keep request data across registration     feature   deep      ← architecture
  …

Notes (6):
  [#6] «Коммерческий транспорт» — question       answered from BrokerProfile.java:88
  [#9] Equipment type on «Новая заявка»          already built — RequestForm.vue:41
  [#3] Verification shown separately             sender's premise is out of date: it already
                                                 moved to the broker profile in ProfileView
  [#8] Keep request data across registration     touches session + auth — affects the estimate
```

Name the three things a reader cannot recover from the files themselves: **any ask you split or merged** (with its source number), **any ask you could not verify** and why, and **whether the codebase was read at all** (`--no-verify` runs must say this first, not last).

Then record one line into the pack-wide store — counts only, never ask text:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:issues-draft","asks":0,"work":0,"alreadyDone":0,"questions":0,"unclear":0,"contradicted":0,"architecture":0,"verified":true}
STATS_JSON
```

The pair worth measuring is `asks` against `work`: it says how much of an incoming message is actually buildable, which is the number that decides whether reading the code up front pays for itself. `contradicted` is the second one — it counts asks whose premise the code disproved, and that is the only measure of what this skill catches that a straight transcription would not. The script always exits `0`; a lost row is a lost row, never a failed run. Never retry it.

## Non-negotiables

- **Read the code, or say you did not.** Verification is the whole point: without it this skill is a text reformatter, and the notes file becomes a set of assertions nobody checked. `--no-verify` is legitimate, and it is legitimate precisely because it is *declared* — in the notes file, in the report's first line, and in the stats row.
- **Never invent an ask, never drop one.** Every item traces to text the sender wrote. If the numbers do not match at the end of Step 1, that is a line in the report, not something to quietly reconcile.
- **The sender's words stay their words.** Titles are verbatim and in the original language; acceptance criteria are yours and in English. Translating a title breaks the one thing that lets them map your file onto their message.
- **The backlog file holds only actionable work.** Questions, already-built findings and things you could not size go in the notes. Anything else makes `/r:issues-fix` spend a verifier on them, every run, forever.
- **This skill writes two files and nothing else.** No branch, no commit, no fix, no edit to source. Handing the result to `/r:issues-fix` is the user's decision and their next command, not this run's last step.
- **An existing output file is somebody's work.** Never overwrite one silently, never un-tick an item, never reorder or reflow a file you did not write in this run.
