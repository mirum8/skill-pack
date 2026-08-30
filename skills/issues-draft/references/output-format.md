# The two output files

One message in, two documents out. They share a slug and nothing else: the backlog is parsed by a
machine, the notes are read by the person who sent the message.

```
issues-<slug>-<yyyy-MM-dd>.md        the backlog  — /r:issues-fix reads this
issues-<slug>-<yyyy-MM-dd>-notes.md  the reply    — nothing parses this
```

`<slug>` names the subject and the suffix the day the backlog was opened, read from `date +%F`
and never from memory: `issues-carnet-2026-08-18.md`, not `issues-2026-08-18.md` — the subject is
what a reader searches for, the date only orders the folder. The date is *not* a new-file trigger:
a second message about the same subject merges into the pair already on disk under that slug,
whatever date it carries, because a backlog split across two files is a backlog `/r:issues-fix`
reads half of.

## The backlog file

Its format is the input contract of
[`/r:issues-fix`'s file adapter](${CLAUDE_PLUGIN_ROOT}/skills/issues-fix/references/issue-sources.md),
which takes every unticked checklist line as one item and every line indented beneath it as that
item's body. Write to that shape and the handoff works; improvise and items silently merge or vanish.

```markdown
# Карнетъ — backlog from the message of 18 Aug 2026

16 asks in the message; 12 are work and are below. The other 4 — a question, two already
built, one that needs more detail — are in `issues-carnet-2026-08-18-notes.md`, with what the code
says about each. `[#n]` is the sender's own numbering.

Verified against `avtoportal` @ `main` `4c953b5`.

- [ ] [#1] Везде заменить рабочее название Auto Import, АвтоИмпорт, Auto Portal на «Карнетъ»
      - No user-visible surface renders any of the three working names
      - Covers Thymeleaf templates, message bundles, page titles and outbound e-mail subjects
      - The database and package names are out of scope; this is presentation only

- [ ] [#2] Добавить возможность переименовывать созданную сделку
      - A deal has an editable display name, settable by both the client and the broker
      - The name shows wherever the deal is listed or referenced
      - Renaming is audited in the deal history like any other change

- [ ] [#5] Разделить уведомления о сообщениях в чате и системные уведомления по сделке
      - Chat messages and deal-status events are two separate notification streams
      - A status change never buries an unread chat message
      - Each stream can be read and cleared independently
```

Rules that hold whatever the message looks like:

- **One `- [ ]` line per item**, starting with `[#n]` — the sender's number — then their **verbatim
  title, in their language**. Never translate it and never rewrite it into an imperative: that
  string is what lets them find the ask in their own sent mail.
- **Acceptance criteria are indented beneath, in English**, two to four of them, each testable.
  `/r:task-run` reads them as `criteria[]`, which is why this file is worth more than a
  transcription of the message.
- **Nothing else on the item.** No `touches`, no `risk`, no priority, no estimate. `/r:issues-fix`
  re-derives scope and risk against the code as it stands when the fix happens; a hint written
  weeks earlier is either redundant or wrong, and the second is worse than absent.
- **A blank line between items**, so a long criteria block cannot be misread as the next item's body.
- **No section headings.** A `##` heading followed by prose is itself one item to the parser, so a
  helpful "## UI" divider becomes a phantom backlog entry. Keep the file one flat list. The header
  paragraph above the first `- [ ]` is fine — nothing before the first item is parsed.
- **Never write `- [x]`.** This skill produces work to be done. Ticks belong to `/r:issues-fix`,
  which writes them after a fix is reviewed and merged; an item that arrives pre-ticked is never
  done.

## The notes file

Free prose — nothing parses it, so it is shaped for a human reading it once and replying. Three
sections, each of which can be empty *and must then say so*, because an absent section reads as
"nothing to report", which is a claim.

```markdown
# Карнетъ — notes on the message of 18 Aug 2026

Read against `avtoportal` @ `main` `4c953b5`. The 12 buildable asks are in
`issues-carnet-2026-08-18.md`; this file covers what did not become work, plus three asks that did
but that touch architecture or the estimate.

## Questions — need an answer before they can become work

**[#6] What «Коммерческий транспорт» means in the broker profile**
In the code it is a boolean on the broker profile (`BrokerProfile.java:88`) that only
filters the equipment types offered in the new-request form (`RequestForm.vue:41`). It
affects nothing else — not pricing, not routing, not visibility. If that is what you
expected, there is nothing to change; if you meant it to gate commercial-vehicle deals,
that is a different and much larger ask.

## Already built, or built differently than the message assumes

**[#9] Equipment type on «Новая заявка» — already there**
The selector was added in `RequestForm.vue:41` and covers car, moto and commercial. If it
is not visible for you, that is a bug in a specific state rather than a missing feature —
tell us which account and we will look.

**[#3] Verification is already in the broker profile**
The message says it is still shown separately. In the current code it renders inside the
profile (`ProfileView.vue:112`); the standalone route was removed. Nothing to do unless
you are seeing the old screen, in which case this is a caching or deployment issue.

## Moves architecture or the estimate

**[#8] Keeping a filled-in request across registration** — in the backlog, flagged here.
Preserving form state through an anonymous → authenticated transition means the request
has to exist before the user does, which touches the session model, the auth flow and the
request's ownership rules. It is the only ask in the message that changes a boundary
rather than working inside one.
```

- **Answer questions from the code, do not just forward them.** `[#6]` above is the pattern: what
  the code does, where, and what it does *not* do. A question relayed back unanswered is the one
  outcome the sender could have reached without asking.
- **When the sender's premise is wrong, quote the code, not your conclusion.** A `file:line` is
  checkable; "that has already been done" is an assertion taken on faith, useless if it turns out
  to be about a different screen.
- **The architecture section lists asks that ARE in the backlog.** Not a second reject pile — the
  "flag anything that affects architecture or the estimate" request, answered. Say plainly that
  the item is still going to be built.
- **No risk ratings, no story points, no internal vocabulary.** This file goes to whoever wrote the
  message. `touches` and `risk` did their job in Step 3, deciding what belongs in this section; they
  are not for publication.

## Merging into an existing pair

A follow-up message about the same subject appends to both files rather than starting new ones, and
the filenames keep the date they were opened under — the suffix dates the backlog, not the last edit:

- Existing items — ticked or not — are left byte-identical. A ticked item is finished work, and
  nothing in a new message un-finishes it.
- New asks are appended at the end with their **new message's** numbering, prefixed so the two
  cannot collide: `[#2/2]` is ask 2 of the second message. Renumbering to keep one sequence breaks
  every reference in the notes file and in the sender's own mail.
- The header paragraph gains a line naming the new message and its date. The revision the file was
  verified against changes too, and only the newly appended items were checked against it: say
  which, because a single "verified against 4c953b5" line at the top otherwise claims the old items
  were re-checked when they were not.
