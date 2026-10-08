---
description: >-
  Review a build plan for over-engineering and simplify it without losing a requirement: cut
  speculative abstractions, infrastructure and contracts no story needs, merge phases that only
  scaffold, and rewrite phases to extend code the repo already has instead of building it again.
  On a half-built plan it also reads the code the ticked phases landed, and where that code is
  over-built in a way later phases would inherit, adds a behaviour-preserving "Simplify" phase —
  built phases are never edited. Every cut is checked against the spec's stories, decisions and
  characteristics, and the plan checker runs over the result. Reads todo.md + tech-design.md from
  /r:spec-design; drafts to one side and writes only after a yes. Runs inside /r:spec-design
  before its Codex challenge, and deliberately as "/r:plan-simplify". NOT for writing the plan
  (/r:spec-design), building it (/r:plan-run) or refactoring code now (/r:code-refactor).
model: opus
effort: high
disable-model-invocation: true
---

# plan-simplify

Find what a plan builds that its documents do not need, take it out, and prove nothing the
documents do need went with it. **Simple, not simplistic**: the simplest plan that still fully
delivers every story, with the validation, error handling, safeguards and tests those stories need.
A cut that saves a phase and drops a requirement is a defect, not a simplification.

## Invocation

`/r:plan-simplify [<plan>] [<doc>...] [--yes]`

- **`<plan>`** — the `todo.md` to review. Omitted, it is found where `/r:plan-run` looks:
  `docs/*/todo.md` (several → ask which), then `todo.md`, `PLAN.md` at the root.
- **`<doc>...`** — the documents the plan was derived from. Omitted, the `spec.html` beside the plan
  plus any document the plan's header names.
- **`--yes`** — skip the gate in Step 7. Every outcome is still reported.

**Embedded** — `/r:spec-design` reads this file and follows it over its draft before its Codex
challenge. Then the caller hands over the draft directory, the documents and the requirement inputs
it already extracted, and four things change: work on the draft in place, skip Step 6's checker
(the caller's own check runs over the result), skip Steps 7–9 (the caller's gate shows the outcome
lists, the caller writes, the caller's stats row carries the counts), and return the outcome lists
of Step 3 plus the phases added in Step 5.

## Step 1 — read the plan, the documents and the code

Read `todo.md`, the `tech-design.md` (or `design.md`) beside it, and every document. No documents at
all → the plan's own checklist items are the requirements; only cuts that keep every item's
observable behaviour are in bounds, and the gate says so.

**Mark what is frozen.** A leaf is frozen when it carries a `- [x]` item, a `<!-- built: … -->`
marker, or is already under way: a `.task-plans/*.md` plan whose source names that phase and whose
`status:` is not `done`. A started leaf counts because its branch is building what the plan says
now — rewrite it and that branch builds something the plan no longer contains. Frozen leaves keep
number, title, ticks and ticked wording exactly; only an unticked item inside one may change.

**Build the requirements ledger before judging anything.** It is the guard every cut is checked
against, so it is written first, while nothing argues for a cut yet:

- every user story by name, and what its acceptance asks;
- every ADR consequence — a consequence the spec accepted is work it wants, not complexity;
- the architectural characteristics and the number each one sets;
- every validation rule, error response, status code and security rule the documents name;
- the v1 line.

**In an existing codebase, find the reuse index** — the doc `/r:reuse-index` writes, linked from the
root `CLAUDE.md` or under `docs/` — and pass it to the explorer.

## Step 2 — two fresh readers, in parallel

Dispatch both in **one message** with the `Agent` tool, `subagent_type: "general-purpose"`, each
handed the absolute path of [references/rubric.md](references/rubric.md)
(`${CLAUDE_SKILL_DIR}/references/rubric.md`) and told to follow its section for that role:

- **Plan reviewer** — the unbuilt leaves and `tech-design.md` against the documents and the ledger.
- **Code explorer** — only when the repo has code. For each unbuilt leaf, what existing code already
  does part of it; for each frozen leaf, whether the code it landed is over-built.

They are separate readers because the context that wrote a plan defends its own decomposition, and
because exploring code fills a context the plan judgement does not need.

**No `Agent` tool → stop with `blocked: no-agent`** and say so. Reviewing inline in the same
context is the single-reader run this step exists to avoid, and reporting it as a review would be
the confident wrong answer. Embedded, return the block to the caller, which names it at its gate.

A reader that returns nothing is a **named gap** in the report, never "no findings".

## Step 3 — verify every finding

The readers propose; this step decides. Check each finding against the ledger, the documents and
the code, and give it exactly one outcome:

| outcome | when |
|---|---|
| **apply** | It is real, the simpler shape is concrete, and after it every ledger entry is still met by some leaf. |
| **keep** | The complexity serves a ledger entry. Name the entry. A kept finding is a correct plan, not a miss. |
| **dismiss** | Not real — a misread, a reuse candidate whose semantics differ from what the leaf needs, code that does not exist. Give the reason. |
| **question** | The documents themselves demand the complexity and the finding argues they are over-built. Never cut against the spec: it goes to Open questions with the trade named. |

**Never cut, whatever the finding says:** a story or any of its acceptance; a test an item names
(tests may move with a merge, never disappear); validation, error responses or status codes the
documents or contracts name; auth, money, persistence and concurrency safeguards — constraints,
idempotency, transactions; the verification step for an architectural characteristic; an ADR
consequence; a `Done when:`; a `## Resolve first` entry.

**A reuse finding is applied only when the code was read and does what the leaf needs** — same
semantics, not the same name. Write it into the item by type or module name: "extend
`LedgerService` with `reverse(entryId)`", never a `file:LINE`. Lines move before a later leaf runs,
and an imagined citation reads exactly like a real one; `/r:task-run`'s planner writes the
line-level map with the files open.

Carry all four lists out. "Five findings, all kept" and "no findings" are opposite facts about a
plan and must not look alike.

## Step 4 — apply to the unbuilt part

Work on a draft: the caller's directory when embedded, otherwise copies of `todo.md` and
`tech-design.md` in a scratch directory. The real files stay byte-identical until Step 8.

- Remove or merge leaves; a merged leaf stays inside 5–12 items and one session's work.
- Rewire every `**Depends on:**` the change touches, and update `**Files:**` where reuse means a file
  is no longer created.
- Trim `tech-design.md` in the same pass, so the two files stay one document.
- **Renumber unbuilt leaves only**, above the highest frozen one, so every dependency stays
  lower-numbered. Keep an old → new map; it is reported.
- Every item still stands alone — repeat the contract it needs rather than pointing at a milestone.

## Step 5 — over-built code that already landed

A frozen leaf is never edited; over-built code it landed is **new work**, a new leaf. Add one only
when all four hold:

1. **The complexity is real** — the explorer read the code, not the plan text.
2. **No ledger entry needs it.**
3. **It costs something later** — an unbuilt leaf will build on it, or it carries a defect risk such
   as two mechanisms for one concern. Code that is merely not how you would write it, with nothing
   building on it, gets no leaf: name it in the report and point at `/r:code-refactor`.
4. **The simpler shape preserves behaviour** — the landed tests stay green with their assertions
   unchanged, except tests of an internal mechanism the leaf removes.

The leaf, in the plan's usual shape:

```markdown
### Phase 9 — Simplify payout retry handling
**Implements:** Replay a payout safely
**Depends on:** Phase 6 · Phase 7
**Files:** `.../PayoutRetryPolicy.java` (delete) · `.../PayoutService.java`
**Risk:** money + persistence
- [ ] `PayoutService` retries through the existing `RetryTemplate` bean; `PayoutRetryPolicy` and its factory are deleted
- [ ] `PayoutRepositoryIT` and `PayoutWebhookIT` stay green with no change to their assertions
**Done when:** `mvn -pl payments test` is green.
```

- **Implements** — the story names of the frozen leaves it simplifies, verbatim.
- **Numbered** right after the highest frozen leaf, so the unbuilt leaves that build on that code can
  depend on it; add those edges.
- **Placed** in the milestone of the first unbuilt leaf that builds on it, or the last milestone that
  still has unbuilt leaves. Never in a milestone whose leaves are all built — that reopens a
  milestone `/r:plan-report` may already have written up. If every milestone is built, add
  `## Milestone N — Simplification`.

## Step 6 — check the draft

```sh
python3 "${CLAUDE_PLUGIN_ROOT}/skills/spec-design/scripts/check_todo.py" <draft>/todo.md \
    --spec <spec> --tech-design <draft>/tech-design.md --against <the original todo.md>
python3 "${CLAUDE_PLUGIN_ROOT}/skills/plan-unblock/scripts/resolve_scope.py" <draft>/todo.md --check
```

`--against` is the freeze guard and `--spec` the coverage guard: a story that lost its last leaf is
reported there. Fix what they report and re-run. **A finding is never fixed by loosening a check** —
it means a cut took something it was not allowed to; undo that cut and move it to **keep**.
Embedded runs skip this step, because the caller checks the same draft.

## Step 7 — the gate

Show, before writing anything:

- **applied** — each cut: what goes, and which leaf still meets the ledger entries it touched;
- **added** — each Simplify leaf with the four reasons from Step 5;
- **kept** — each finding with the ledger entry that needs the complexity;
- **dismissed** — each with its reason;
- **questions** — the trades only the user can make;
- **renumbered** — the old → new map, and the leaf count before and after.

Then stop for a yes. The user may drop individual cuts; dropped ones move to **kept**, the draft is
re-derived and re-checked. A decline writes nothing and goes to Step 9 with `mode: "declined"`.
`--yes` skips the wait.

## Step 8 — write

Replace `todo.md` and `tech-design.md` together, add the questions to the plan's Open questions,
and leave both as working-tree changes — `git diff` is the record of what was cut. Then say:

- which phase numbers moved — an earlier `--from N`, or a `/r:plan-run` already running on this
  plan, holds stale numbers and has to be restarted;
- the next command, `/r:plan-run <plan>`.

## Step 9 — record the run

Counts only, never a path or a title. Always, including a decline or a block:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:plan-simplify","mode":"applied","leavesBefore":0,"leavesAfter":0,
 "leavesFrozen":0,"findingsRaised":0,"applied":0,"kept":0,"dismissed":0,"questions":0,
 "reuseApplied":0,"simplifyLeavesAdded":0,"checkerProblems":0,"readers":2}
STATS_JSON
```

`mode` is `applied` | `declined` | `blocked`. `kept` against `applied` is the pair to read: a skill
whose findings are mostly kept is raising complexity the specs ask for, and one that applies
everything is not checking. The script always exits 0; never retry it.

## Never do this

- Never cut a ledger entry, and never cut against the documents — that is a question, not a cut.
- Never drop a test, a validation, an error response or a safeguard to make a plan smaller.
- Never edit, renumber, retitle or un-tick a frozen leaf, including one `/r:task-run` has started.
- Never apply a reuse finding nobody verified in the code, and never cite `file:LINE`.
- Never add a Simplify leaf for taste, or one that changes behaviour.
- Never review in the caller's context when the `Agent` tool is missing — stop and say so.
- Never write the real files before the gate, and never report a block or a silent reader as clean.
