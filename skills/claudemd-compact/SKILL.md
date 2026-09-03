---
description: >-
  Compact, reorganize, and de-stale a project's CLAUDE.md infrastructure — root, nested module
  files, and extracted reference docs — so it costs less always-on context and stops misleading
  the model. Use whenever the user wants to "compact/refactor/reorganize CLAUDE.md", says "my
  CLAUDE.md is too long / bloated / out of date", wants to "split CLAUDE.md into references",
  "remove stale rules from CLAUDE.md", "reduce always-on context", or "apply progressive
  disclosure to my instructions" — even if they don't name the file. Also for
  a CLAUDE.md that is accurate but over-constrains the model, restates the repo or the harness,
  or disagrees with an installed skill: "my rules fight my skills", "is my
  CLAUDE.md over-constraining?". `--auto` applies without the approval prompt — used by `/r:task-review`'s keep-CLAUDE.md-lean
  step and whenever the user wants compaction with no confirmations. NOT for: adding the user's
  standard reusable rule blocks (Test-Writing Policy, Code Conventions, or removing a post-task
  auto-run block) — that's `r:claudemd-patch`; NOT for `/init` or project bootstrap;
  NOT for a generic one-off edit to CLAUDE.md.
effort: medium
---

# CLAUDE.md Compact

Reorganize a project's CLAUDE.md infrastructure so the always-on context stays
lean, accurate, and high-signal — without losing a rule that still matters.

## Two kinds of cost

`CLAUDE.md` is **always-on context**: the root file, every nested `CLAUDE.md`,
and anything pulled in via `@imports` load on essentially every turn, and that
context is paid twice.

**Volume cost**: duplicated rules, stale commands, giant inline samples,
exhaustive lists, module detail piled into the root. Every token is charged
every turn and dilutes attention from the rules that shape behavior.

**Constraint cost** doesn't show up as length, and most files get it wrong. An
accurate rule can still make the model worse: it over-constrains a decision the
model would make well on its own, restates the repo, or quietly disagrees with
the harness, another CLAUDE.md, or an installed skill — leaving the model to
work out which instruction wins. Over 80% of Claude Code's own system prompt
turned out to be removable on this basis with no measurable loss: the guidance
wasn't wrong, it was in the way.

Four moves: **compact** (tighten and dedupe), **reorganize** (put content where
it's needed — mostly progressive disclosure), **soften** (restate a rigid rule
as the intent behind it), and **prune** (remove what the codebase contradicts).

## What belongs in an always-on file

The test isn't "is this true?" — most bloat is true. It's **"would the model get
this wrong without being told?"**

- Readable off the file tree, `pom.xml`, or `package.json`? Any competent
  engineer with the repo open would know it? → **cut**; it pays rent to repeat
  what the repo already says.
- Would the model do it anyway — ordinary good practice, or something the
  harness already instructs? → **cut**.
- Could the model plausibly get it wrong, expensively? → **keep**. That's a
  gotcha, and gotchas are what the file is for.

Prefer intent over prohibition. "Match the comment density of the surrounding
code" reaches cases a list of banned constructs never anticipated, and doesn't
fight the user when they ask for something different.

## Progressive disclosure — the default move for anything long

Most of what bloats a root file isn't wrong or redundant; it's **rarely
needed**. The answer is **progressive disclosure**: a one-line pointer in the
always-on file, the body one hop away — a nested `CLAUDE.md`, a reference doc, a
skill. The content costs nothing on turns that don't need it.

Reach for this first: it's the only move that can't lose anything, so it needs
no evidence — cutting and pruning do, because information leaves the project.
When something is long and you're unsure whether it earns its place in the
root, **extract it rather than agonize over it**: a reference nobody opens
costs one line; the same text inline costs its full length on every turn.

The root becomes a map — the short rules that shape most edits, the gotchas, and
an index of plain on-demand pointers. A pointer only works if it says **when**
to follow it, so make the trigger concrete ("read `.claude/docs/testing.md`
before touching the integration tests"), not a bare filename.

## Where content can go

| Destination | For |
|---|---|
| **keep** | short, high-signal, shapes most edits |
| **soften** | a rigid rule worth keeping — restate it as intent |
| **relocate to nested `CLAUDE.md`** | rules that only apply inside one module |
| **extract to a reference** | deep dives, long procedures, exhaustive lists, troubleshooting |
| **extract to a skill** | a multi-step procedure with a trigger of its own |
| **point at code** | a spec that a test suite, a real function, or an artifact already states better |
| **move to memory** | decision logs, dated notes, "we chose X because Y" — session memory, not instructions |
| **flag for global** | *should* be global but isn't — true of the user's other projects too, not just this one. (If it already **is** in the global file, that's a **cut**, not a flag.) Suggest it; never move it yourself |
| **cut** | true, but free to look up — the repo, the harness, the global file, or a skill already says it |
| **prune** | false — the codebase contradicts it |

The three disclosure rows are one idea at different granularities — a nested
`CLAUDE.md` discloses by scope, a reference by task, a skill by invocation.
Between one of them and a **cut**, prefer the disclosure: a cut has to be
defended with evidence.

Prefer a **skill** over a reference when the content has a natural trigger and
steps of its own ("how we verify a change before shipping") — a skill can be
invoked, where a reference is only read if the root remembers to mention it.
Prefer **pointing at code** over prose about code: a test suite or a real
function can't drift the way a prose copy will.

One mechanical trap — `@path` is an **eager import**, recursively pulled into
context at load time, so it saves nothing. Link extracted content with a plain
on-demand instruction ("read `.claude/docs/result.md` when working on error
handling"), **never** with `@`. Converting an oversized `@import` into a plain
reference is a win on its own.

`references/rewrites.md` works each of these through as a before/after.

## What is preserved, and what may change

Facts and intent survive; framing may change. Every rule that still reflects
reality ends up somewhere — root, a nested file, a reference, a skill, memory,
or a "suggest adding to global" note. Three moves alter a rule rather than
relocate it, and each needs its own evidence:

- **prune** (delete something false) needs **hard codebase evidence** the rule is
  stale: a path, script, module, or symbol that does not exist, or a command the
  build config contradicts. Never delete on an impression.
- **cut** (delete something true) needs the opposite evidence — **where it still
  says it**: the file tree, build file, harness instruction, global rule, or
  skill that carries it. If you can't point at one, it isn't redundant.
- **soften** (rewrite) is a judgement call, so it's always shown as a
  before/after and always needs approval. It preserves intent — a rewrite that
  drops the intent is a cut or a prune, and needs that list's evidence instead.

When you can't confirm something either way, **flag and keep** — raise it as a
question rather than resolving it by deleting.

Two things look like over-constraint and aren't. **A deliberate preference** —
when the user has said how they want their code to look, that's a decision, not
a guardrail left over from a weaker model; the tell is whether the rule expresses taste
("no javadoc unless I ask") or defends against a failure. And **a hook with its
prose rule** — `r:claudemd-patch` installs both on purpose, the hook enforcing
deterministically and the prose explaining why; don't delete the text because a
hook covers it.

## Workflow

### 1. Discover

- Read the root `CLAUDE.md`; glob `**/CLAUDE.md` for nested files. Skip
  `node_modules`, build output, and vendored dirs — and skip **git worktrees**
  (`.git/`, `.claude/worktrees/`, anything `git worktree list` reports): a
  worktree holds a second copy of the hierarchy on another branch, and treating
  it as nested module files would "reconcile" the branches into each other.
  Check for them before globbing, not after.
- Follow any `@imports`; note what they pull in and how big it is.
- Detect the project's reference convention — an existing `docs/` or
  `.claude/docs/`? Follow it; otherwise default to `.claude/docs/`.
- Read the global `~/.claude/CLAUDE.md` and the installed skills — both
  `~/.claude/skills/*/SKILL.md` and any project-local `.claude/skills/` — for
  comparison only. A name present in both shadows silently; raise it. Your own
  system prompt is in context too: the fourth layer, and the one projects
  duplicate without realizing it.

### 2. Inventory, then check against reality

Break the content into atomic rules. For each, note how often it applies, which
scope owns it, and whether it's duplicated, verbose, or misplaced.

Then two checks. **Staleness** — do referenced paths, scripts, directories,
modules, and symbols still exist? Do the stated build / test / run commands
match `package.json` / `pom.xml` / `build.gradle` / `Makefile`? This makes
pruning safe. **Redundancy and conflict** — does the rule restate the repo, the
harness, the global file, or a skill, and does anything here contradict
anything there?

`references/patterns.md` has the rubric and both sets of heuristics.

### 3. Plan

Give each item one destination from the table above, using the reference
location found in step 1. When two destinations fit, take the one that keeps
the rule but gets it off the always-on path — the choice you never have to
justify. Sanity-check: would the root read as a map with pointers? For anything
still inline, ask what it is doing on every turn.

### 4. Propose (wait for approval before editing)

> In `--auto` this step loses its **wait**, not its content — see below.

Present four separate lists — they carry different risk and the user vetoes
them independently:

- **Moves** — what goes where, grouped. Mark the two that leave the repo
  (a new skill, a memory file), since `git revert` won't undo them.
- **Rewrites** — each softened rule as before/after, so a change in meaning is
  visible rather than buried in a diff.
- **Cuts (redundant)** — content that is *true* but free to look up. Evidence is
  where it's already stated: *"module list — `settings.gradle` names all six"*,
  *"'use the maven-deps MCP' — already in your global CLAUDE.md"*.
- **Removals (stale)** — content that is *false*. Evidence is the absence:
  *"`run ./scripts/build.sh` — no such file; the build is `mvn package`"*.

Keep those last two apart: only staleness clears the `--auto` gate, and a
true-but-redundant cut stays a judgement call.

Report the root size before → after in **both lines and characters** — wrapped
paragraphs can cost more than a file twice their line count.

Then list what's flagged for global (with exact lines, since you won't move
them), and any conflicts — as questions, not decisions. Conflicts run both ways:
a project rule that contradicts a global one, and a **global rule that doesn't
fit this project** ("use the maven-deps MCP" in a Gradle-only repo) — easy to
miss, and it costs the model a decision on every turn.

Where a rule ends up somewhere non-obvious, say so as one line per rule —
`old location → new location` — so the user can confirm nothing fell out.

### 5. Apply

- Rewrite the root: lean, reordered, deduped, ending with a short **"Detailed
  references"** index of plain on-demand pointers, each naming when to follow it.
- Write the nested files, references, or skills the plan called for. Give a
  reference over ~300 lines a short table of contents.
- Never edit the global `~/.claude/CLAUDE.md`; print the lines you suggest
  adding instead.

### 6. Verify

- every still-valid rule is present somewhere;
- every removal was approved and carried evidence;
- every rewrite kept the original intent;
- nothing came back as an eager `@import`;
- every reference link resolves to a file that now exists, and each pointer says
  when to follow it — an extraction the model never opens is a deletion;
- nothing in the result contradicts anything else;
- the root is meaningfully leaner than before.

Report the root size delta in lines **and** characters, files created or updated,
items cut and pruned, and the lines suggested for global. Skills carry the same
two costs; `/doctor` covers those if the user wants them looked at.

## Non-interactive mode (`--auto`)

Invoked by `/r:task-review`'s keep-CLAUDE.md-lean step, or whenever the user
wants compaction with no confirmations. Same workflow without the wait in step 4
— and one line that has to hold, since nobody is watching:

**`--auto` applies only what cannot lose a rule, and only inside the repo.** The
lossless in-repo operations — compact, dedupe, relocate to a nested `CLAUDE.md`,
extract to a reference — always run; pruning runs only on hard codebase evidence
of staleness, with anything unconfirmed kept. With every judgement call
withheld, progressive disclosure is where nearly all the win comes from, so be
generous with it. Everything resting on judgement — softening, redundant cuts,
conflict resolutions — is **reported as a suggestion and left in place**.
Creating a **skill** and moving content to **memory** also wait for a human — costing nothing is not the same as needing no approval, and a skill is the one disclosure that writes outside the repo:
both are judgement calls, and both write outside the repo, where `git revert`
doesn't reach. Step 6 runs in full every time; it's the only remaining net, so
if it finds a valid rule that didn't survive, restore it before finishing.

Afterwards print the step-4 report in full — root size before → after, what moved
where, a clearly-marked **"Removed (stale)"** list with per-item evidence, and
the **Rewrites** and **Cuts** lists. Those last two matter *more* here: `--auto`
leaves them unapplied, so the before/after wording is the entire deliverable.
It's all in the diff, one `git revert` away. If the project's standard blocks
are missing, note that `/r:claudemd-patch` would refresh them rather than
running it unattended.

## Compose with `r:claudemd-patch`

Chain them, don't merge them: `r:claudemd-patch` *adds* the user's canonical
rule blocks; this skill *restructures and prunes* what's already there. If those
blocks (Test-Writing Policy, Code Conventions, removal of a post-task auto-run
block) are missing or clearly stale, suggest running `/r:claudemd-patch`. Don't
write them yourself.

## Record the run

One line into the pack-wide store — counts and byte sizes only, never a rule's text, a file path
outside the project root, or anything quoted from the CLAUDE.md.

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:claudemd-compact","mode":"interactive","filesRead":0,
 "bytesBefore":0,"bytesAfter":0,"rulesKept":0,"rulesRewritten":0,"rulesMovedToReference":0,
 "rulesMovedToSkill":0,"rulesDropped":0,"conflictsResolved":0,"staleFound":0,
 "wrote":false,"blockedReason":null}
STATS_JSON
```

`mode` is `interactive` | `auto`: `--auto` decides without a gate, so its `rulesDropped` means
something different from a number a human approved.

**`bytesBefore` against `bytesAfter` is the only number that says whether this skill did its job** —
the always-on context cost is what it exists to reduce. Read it beside `rulesDropped`: only the
pair distinguishes compaction (moved behind references) from deletion.

**`staleFound` justifies the de-staling half.** If it stays zero across many runs, the pass reads
every rule and catches nothing, and the skill is just a reorganizer.

**`wrote: false` with no `blockedReason` is a decline; with one it is a blockage** — a CLAUDE.md
that could not be read or written is an absence of judgement, not a judgement that nothing needed
compacting.

The script always exits `0` — a lost row is a lost row, never a failed run, and it must never change
what was written. Never retry it.

## References

- `references/patterns.md` — the destination rubric, staleness heuristics,
  redundancy-and-conflict heuristics, and the smells checklist.
- `references/rewrites.md` — worked before/afters for every transformation:
  rigid rule → intent, obvious cut, the progressive-disclosure family (long
  section → reference, module rule → nested `CLAUDE.md`, `@import` → reference,
  procedure → skill), prose → code pointer, decision log → memory, conflict →
  resolution.
