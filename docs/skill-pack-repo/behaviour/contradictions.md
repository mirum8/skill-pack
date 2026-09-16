# Contradictions the register surfaced

Freezing what the pack does, one target at a time, is the first thing that has ever been able to
ask whether two files agree. They do not always. Nothing here is reconciled: which copy is right
is a decision, and a compaction sweep that harmonised these by itself would pick a winner by
accident.

`/r:pack-compact` reads this file alongside a target's register and **refuses to silently
harmonise anything listed here**.

Status: `open` until someone decides. A resolved entry keeps its number and records what was
decided.

---

## C-1 — `wait --any` aborts the loop in one copy of a shared recipe · **live defect** · open

`skills/plan-run/SKILL.md` writes the fan-out wait as `"$FAN" wait --any || true`.
`skills/issues-fix/SKILL.md` writes the same line bare: `"$FAN" wait --any`.

**Verified against the source.** `do_wait` in `skills/plan-run/scripts/fanout.sh` sets `arc=1` on
a handed-back unit whose verdict starts with `failed`, and returns it. So the `issues-fix` recipe
as written aborts the orchestration loop on the first failed unit — directly against its own rule,
stated two paragraphs later, that **a failed unit is not a halt**, and against the whole point of
leaving a failed unit standing so it keeps its slot.

Worth recording how this was nearly missed: a second reader comparing the two skills' *rules*
found no disagreement, because the rules do agree. The divergence is in the copied shell block
under them. One of the two copies has to move.

## C-2 — the resumed-unit sentinel rule exists in only one copy · open

`plan-run` carries the resume guidance: once means once *per sentinel*, delete a unit's old
sentinel before it resumes, never `cleanup` a live unit to re-arm the wait. `issues-fix` has the
"handed back once" sentence and **none** of the rest, although `fanout.sh` and its suite carry the
behaviour for both callers. An `issues-fix` orchestrator resuming a failed unit is working without
instructions.

## C-3 — the two `spawn` recipes disagree about `--orchestrator` · open

`issues-fix`'s worked example passes `--orchestrator "<your own session name>"`; `plan-run`'s
omits it and introduces it only later under the alarm channel. Same script, same protocol, two
different examples of how to call it.

## C-4 — "exactly three" against "the four cases" · open

`issues-fix`: a unit sends on the alarm channel in *exactly three* cases. `plan-run`: *the four
cases* under Being a unit. The extra one is `plan-run`'s "a failing test it did not write", so the
difference may well be deliberate — but the word *exactly* in otherwise-identical prose is exactly
what a sweep would harmonise in the wrong direction.

## C-5 — `preflight` does five things, and both skills say four · open

`do_preflight` in `fanout.sh` also emits a named non-fatal skip when herdr's `claude` integration
is not installed, and `skills/plan-run/tests/fanout.test.sh` asserts it in both directions. Both
skills say "it checks four things". A caller who sees that line has nothing in the prose telling
them it is expected and harmless.

## C-6 — Step 2.6 restates the cap it says it does not restate · open

`issues-fix`: "at most three groups run at once by default … the cap is `steps.fanout.maxUnits` in
the config, resolved by the fan-out script rather than restated here" — with the 3 restated in the
sentence before it. `plan-run` says the same thing without the contradiction.

## C-7 — the sentinel is written "last", and is not · open

`issues-fix` Step 4.4 says write `FANOUT_SENTINEL` as the very last thing, then lists a
`gh issue close` bullet after it. It only holds because units always run `--no-merge` and so never
close anything; a serial run with the sentinel set would contradict the stated order.

## C-8 — the reuse-index refresh skips the path that actually merges · open

`issues-fix` refreshes `/r:reuse-index` only in `--land` step 4. The plain serial run — the
default, and the one that merges everything — never refreshes it, and nothing says why that path
is exempt.

## C-9 — "Three things shape everything below", then four bullets · open

`skills/plan-unblock/SKILL.md`. Its sibling `plan-report` says "Three things shape the design" and
lists three.

## C-10 — `plan-unblock` justifies its missing flag with a route `plan-run` forbids · open

`plan-unblock` explains why it carries no `disable-model-invocation`: "the flag blocks the Skill
tool outright, and the gate that most needs to reach this skill reaches it that way."
`skills/plan-run/SKILL.md` Step 1 says the opposite — **"The offer is terminal, not a dispatch"** —
and its non-negotiables say **never dispatch** the skill: it prints a command and stops, and the
user retypes it. So the reason `plan-unblock` gives for its own frontmatter is a route that does
not exist.

The contrast matters: `plan-report`'s identically-worded justification *is* load-bearing, because
`plan-run` really does reach it through a subagent's Skill tool. One of the two is a copied
sentence that stopped being true.

## C-11 — `plan-report`'s no-argument default is never in its own steps · open

Its Invocation section says that with no `<milestone>` it takes the highest-numbered complete
milestone with no report yet. Step 0 only ever shows `milestone_scope.py … --milestone <n>`. The
`--complete` call that answers the question appears only in `plan-run`'s boundary check. The
script implements it; the skill never tells itself to call it.

## C-12 — two scripts, same step, same file, opposite severity · open

`skills/spec-design/SKILL.md` Step 7 runs both `check_todo.py` and `resolve_scope.py --check` over
the same draft. On a plain-bullet entry, a missing `Owner:`/`Blocks:` and an unknown field,
`check_todo.py` emits **notes that never fail** — deliberately, so a plan on disk is not rejected
over a rule that postdates it — while `resolve_scope.py --check` **exits 1**. Both behaviours are
documented in their own script. Nothing says they disagree.

## C-13 — `blockedPhasesBuilt` gets opposite verdicts from one script's two modes · open

`resolve_scope.py --check` reports an open entry blocking an already-built phase as a problem to
resolve or drop. The `--outstanding` half returns the same entry as **moot**, so that a stale
blocker can never become a permanent trap — which is what `plan-run` and the repo `CLAUDE.md` both
describe. `spec-design` Step 7 also lists five findings where `problems()` emits eight.

## C-14 — `check_todo.py` is a hard loop in one skill and advisory in the next · open

`spec-design` Step 7 fixes and re-runs against any exit-1. `plan-run` calls the same script
advisory, with two hard stops, on the grounds that a hand-written plan can fail a quality
judgement and still be buildable. Probably deliberate; stated in neither skill.

## C-15 — the collision check reads only *backticked* paths · **fail-open** · open

`phase_files()` matches `` `path.ext` ``. A `Files:` entry written without backticks is invisible
to the same-wave collision check and to `--slice`, while `spec-design` says `Files:` "is what the
collision check reads" and `design-contracts.md` says never to buy a wave back by leaving a file
out. So the fail-open case is *formatting*, not only omission — and a safety check failing open on
formatting is the one direction the script's own comment says is not allowed.

## C-16 — `codexReview: "blocked"` has no writer · open

`skills/spec-design/references/stats-fields.md` defines `ran | skipped | blocked` and explains why
averaging `skipped` with `blocked` hides both. Step 6.5 defines only `ran` and `skipped` and gives
no path to `blocked`.

## C-17 — `check_todo.py` silently falls back to a neighbouring `spec.html` · open

When `--spec` is absent it uses one sitting beside the plan, undocumented in both prose files. On a
draft in a scratch directory there is none, so an unqualified run checks no story coverage at all
and says nothing about it.

## C-18 — four layers, five layers, and the fourth layer · open

`skills/claudemd-compact/references/patterns.md` §3 is headed "the five layers" and lists project
docs as layer 5; its own table of contents says "the four layers"; `SKILL.md` step 1 calls the
system prompt "the fourth layer" and does not list project docs at all. The five-layer list is the
operative one — layer 5 carries a do-not-cut exception nothing else states.

## C-19 — "`git revert` won't reach it" is half-wrong · open

`claudemd-compact` gates creating a skill and writing to memory behind a human on the grounds that
both leave the repo. `references/rewrites.md` §6's own worked example writes the new skill to
`.claude/skills/verify-change/SKILL.md`, a tracked in-repo path. Only the memory file is genuinely
outside. The gate is still the right call; the reason given for half of it is not true.

## C-20 — an untested executable that edits the user's settings · **rule violation** · open

`skills/claudemd-patch/SKILL.md` carries an inline `jq` snippet that writes a `PreToolUse` hook
into the project's `.claude/settings.json`. It is the skill's only executable artefact and it has
no suite anywhere under `skills/claudemd-patch/`. Marker-comment idempotency, the `|| true` no-op
and preservation of unrelated hooks all fail silently. The repo's own rule is that every bundled
executable has a test and that `validate.sh` names it.

## C-21 — one section, two skills, opposite verdicts · open

`claudemd-compact`'s destination table would classify an inline "how we verify a change before
shipping" checklist as *extract to a skill*; `claudemd-patch` deletes any such post-task section
outright, and only its rule keys off the review-tool names. Compact's `--auto` does not create
skills, so an unattended run cannot trip it — an attended one can.

## C-22 — "The two modes" heads a skill that has four · open

`skills/spec-brainstorm/SKILL.md`. `--feature` and `--continue` get their own sections further
down, and the skill records `mode: full | explain | feature | continue`.

## C-23 — the `mode:` field has three vocabularies · open

`spec-brainstorm/references/interview.md` §10's template writes `mode: default  # default |
explain`; `SKILL.md` Step 6 records `full`; the test fixture writes `full`. `check_spec.py` only
ever tests `== "explain"`, so nothing breaks today and all three disagree.

## C-24 — a never-do rule the skill's own next step breaks · open

`spec-brainstorm`'s never-do list says never reference a path outside this skill's directory; Step
6 calls `${CLAUDE_PLUGIN_ROOT}/lib/record-run.py`. The exception is correct and unwritten.

## C-25 — a documented check that is silently inert · **fail-open** · open

`spec-brainstorm/SKILL.md` Step 4 lists "a claim about existing code with no `path:line`" among
what `check_spec.py` catches. `check_codebase_facts()` only fires under a literal "Codebase facts"
heading, and nothing in `SKILL.md`, `sections.md` or `interview.md` ever tells the writer to create
one. On a real `--feature` run the check never runs and the rule is prose-only — while the prose
says a script holds it.

## C-26 — the open-question ratio is two different numbers · open

`interview.md` §9: more than about one open question per three **asked**. `check_spec.py`:
`oq > max(2, settled // 2)` — one per two **settled rows**. Different denominator, different
threshold, neither cites the other.

## C-27 — `spec-brainstorm` describes a successor that writes one file; it writes two · open

`spec-brainstorm` says `/r:spec-design` "reads this document and writes `todo.md` beside it: the
build order *and* the design contracts". `spec-design` Step 9 writes `todo.md` **and**
`tech-design.md`, with the contracts in the second. One file out of date about the other.

## C-28 — the empty-scope hole in `code-scan`'s fail-closed contract · **fail-open** · open

`skills/code-scan/SKILL.md` Step 1: an empty `findings[]` means clean only when `status` is not
`error` **and at least one tool's status is `ran`**; zero analyzers run must be reported as
blocked. But `local-scan.py`'s empty-scope early return writes `status: "ok"` with `tools: {}` —
no tool ran — and exits 0, and `tests/local-scan.test.sh` asserts that is correct, because nothing
to scan is not a failure.

So a legitimate empty scope is *blocked* by the prose rule and *clean* by the exit code. The only
thing separating them is the printed line "No source files in scope. Nothing to scan.", which the
prose never mentions. Both readings are defensible, which is why this needs a decision rather than
a transcription.

## C-29 — two severity vocabularies with no mapping · open

`code-scan` Step 5's record-run payload documents `severity: blocker|critical|major|minor`; the
orchestrator emits HIGH/MEDIUM/LOW. Nothing states the mapping the model is meant to apply.

## C-30 — "Four shapes", six accepted forms · open

`code-scan`'s Invocation section says four and lists four bullets, then adds `--commit` and
`--range` in the paragraph below. The frontmatter description enumerates all six.

## C-31 — eval suites whose fixtures do not exist · **measures nothing** · open

`skills/git-commit/evals/evals.json` names `setup_mixed.sh`, `setup_breaking.sh` and
`setup_refactor.sh`; `skills/git-commit/evals/` holds only `evals.json`. `code-scan`'s three
`behaviour` cases carry `files: []` and no fixture while their assertions describe planted classes
that are nowhere in the repo. `run-evals.py` skips a behaviour case with no fixture, so both suites
currently score only their trigger/exclusion pair — a green suite over unmeasured cases, which
from the outside is indistinguishable from one that passes. Read the count `run-evals.py` prints,
never the one in the file.

## C-32 — a stale exit-code comment inside correct code · open

`skills/code-adversarial/scripts/run.sh` line ~271 says a caller can tell a block from "a missing
plugin (3)". The missing-plugin path exits **0** with the `CODEX SKIPPED` marker, and
`tests/run.test.sh` asserts the usage text must not promise an exit 3. The code is right; its
comment describes an exit that does not happen.

## C-33 — "the script always exits 0" reads as a claim about the wrong script · open

`skills/code-adversarial/SKILL.md`'s Record-the-run paragraph says "The script always exits `0`,
so a lost record is never a failed review". In context "the script" is `lib/record-run.py`, but the
sentence sits three paragraphs above an exit-code section documenting 0/2/4 for the wrapper, where
it reads as a claim about `run.sh`.

## C-34 — two sentences, two lines apart, pointing opposite ways · open

`skills/code-quality/SKILL.md`: after the bounded re-dispatch, one line says "stop and say which
one is blocked. Never silently proceed without it"; the next says "proceed with the surviving
reviewer's findings". Reconcilable — the accompanying note is what makes proceeding non-silent —
but nothing in the text says so.

## C-35 — the two skills split security differently, and only one says so · open

`skills/task-review/task-review.workflow.js` merges security into the `logic` hunter, carrying the
79-dispatch / 3-fix / 43%-precision measurement that justifies it. `skills/code-bugs/SKILL.md`
still dispatches security as its own Agent 4 — four pattern hunters plus a docs hunter. Both may be
right for their own scope, but the reasoning is recorded in only one of them, so the difference
reads as drift rather than a decision.

## C-36 — the guard's own suite would not catch the rename it exists to prevent · **gap** · open

`hooks/tests/guard.test.sh` tests the guard's mechanism, but its fixtures use one pipeline, so the
literal string `run-task-implement` is asserted nowhere. Renaming that `meta.name` to match its
directory — the single most tempting "cleanup" in the pack, and the one the register's README
warns about first — **passes the existing suite**. The warning is real and nothing but wording
holds it up.

## C-37 — the planner is documented as Opus and ships as Fable · open

`skills/task-run/SKILL.md` says "Opus, deepened once" and its tier table says "full Opus plan". The
script's file header says "plan it on Opus at high", and the `IMPL_RUN` comment reasons about "a
plan built at opus/high". The shipped and fallback value is **`fable`/`medium`**
(`steps.plan.model`, `PLAN_RUN`) — and the script's own `meta.phases` already says "Fable planner".
One markdown file and three comments are describing a tier nothing runs at.

## C-38 — `IMPL_RUN`'s comment claims an agreement the config denies · open

The comment says the file and the fallback agree — claude/opus/medium. `.config/defaults.yaml`
ships `provider: codex` / `gpt-5.6-sol` / `medium` and states in its own words that the two
"deliberately disagree". The defaults file is right.

## C-39 — `JUDGE_RUN`'s comment describes the unshipped value as shipped · open

It says the shipped row is the measured status quo and that dropping the judges to sonnet "becomes
a change someone makes". `judgeModel` already **is** `sonnet`. The same paragraph's "file and
fallback agree" holds for the planner and explorers, not the judges.

## C-40 — `task-run`'s stop table and handoff list are short · open

The stop table omits `source-unresolved`, returned when the Phase 0 agent itself dies and distinct
from `source-blocked`. The handoff key list omits `headDetached`, `treeCommitted`, `implemented`
and now `resume` — the last being the key Step 5 itself branches on. Three of the four are keys the
skill elsewhere tells the caller to act on.

## C-41 — `classifyOnly` exists only in the script · open

The dry-run mode, with `repo` and `sourceModel`, is implemented and never mentioned in
`skills/task-run/SKILL.md`.

## C-42 — `{ thorough: true }` is documented twice and read nowhere · **dead option** · open

`skills/task-review/SKILL.md`'s Arguments table documents it as widening depth, and the script's
own header lists it under optional args. `opts.thorough` is never read in the 3,166 lines. A
caller who passes it gets nothing and is told otherwise.

## C-43 — `meta.phases` still describes five hunters · open

`meta.phases[1].detail` reads "codex + hunters; all 5 hunters and code-quality in full". There are
**two**. The comment block above `HUNTERS` still pins a `security` hunter as "a pattern hunter like
the other two" and says to pin its effort explicitly — there is no security hunter, and two
paragraphs below, the same block says so correctly. `hunterFanOut`'s comment points at a
`DOC_HUNT` note that no longer exists, and the `tracksDrifted` comment uses a security hunter as
its worked example of drift diagnosis.

## C-44 — step numbering drifted between the skill and its script · open

`skills/task-review/SKILL.md`'s Files table says the worktree and TUI scripts are called by Steps
8a/8c; the script dispatches them from Phase 7a/7c and comments them that way throughout. The skill
also says "the graph of Steps 0–9" where `meta.phases` holds eight — that one is deliberate, since
Step 9 sits outside the graph.

## C-45 — two "every tier" claims that hold of tiers but not of runs · open

The non-negotiable says no *tier* drops `/r:code-scan` or the Codex end-verify, and that is
literally true. But `/r:code-scan` is gated on `isJvm`, so a Go or Rust project gets
`localScan: 'n/a'` and no analyzer at all; and the **full** tier's end-verify is skipped outright
when neither the fix phase nor the scan wrote code. A reader of the tier table's ✅ column will
predict neither.

## C-46 — the reuse-index refresh is mandated by a reference and missing from the skill · open

`skills/plan-run/references/concurrent-sessions.md` requires one `/r:reuse-index` from the primary
tree after the last merge, as its own commit. `SKILL.md`'s `--land` section says it "builds after
every merge, and nothing else" and never lists the refresh; the only trace is an aside at the
milestone boundary ("the slot the reuse-index refresh already occupies"). A reader following
`SKILL.md` alone never runs it. Compare C-8, which is the same refresh missing from the other
skill's serial path.

## C-47 — the gate prints a cap the run does not use · open

`plan-run` Step 2 states the fan-out cap as a flat three; the `--herdr` section and `fanout.sh`
resolve it from `steps.fanout.maxUnits`. On a project that raised it, the gate prints 3 and the run
uses something else.

## C-48 — a `footprint-warn` stop has no `haltReason` to record itself under · open

`SKILL.md` makes exit 2 a stop under `--herdr` and Step 3.7 lists the preflight among the halts,
but `stats-fields.md`'s closed vocabulary offers only `slice-refused`, which names the other
preflight. The halt happens and cannot be recorded as itself.

## C-49 — a check stated in one step and scoped to another · open

"Confirm the work is still UNCOMMITTED before Step 3.4's review" sits inside Step 3.6, which runs
*after* that review.

## C-50 — the spawn recipe omits the flag the alarm channel requires · open

Neither `plan-run`'s `SKILL.md` block nor `references/concurrent-sessions.md` passes
`--orchestrator` in the worked `spawn`, while the alarm channel requires it on every spawn. A run
that copies the block has no upward channel. `issues-fix`'s block does pass it — the mirror image
of C-3, and the two together mean neither copy is right on its own.

## C-51 — `pack-maintain`'s documented payload has never been written · **verified** · open

`skills/pack-maintain/SKILL.md` documents `action` / `issueFile` / `notified` / `reporter`. All 22
stored `r:pack-maintain` result rows carry `reporter` plus `changed` / `validated` / `installed` /
`committed` / `testAdded` — a different schema. Of the four documented keys, only `reporter` has
ever been written. Either every row predates the current prose or the documented keys are not the
ones being emitted, and nothing in the store can tell those apart.

## C-52 — `CLAUDE.md`: "Fourteen skills write a `result` row" · **verified** · open

23 `SKILL.md` files invoke `lib/record-run.py`, plus both workflow scripts. The claim the sentence
exists to make — that `r:tests-write` and `r:hexagonal-architecture` correctly write none — still
holds. The number does not.

## C-53 — `CLAUDE.md`: "`r:tests-write` is the most-invoked skill in the pack at 41 runs" · **verified** · open

The store reads 80 `invoke` rows for `r:tests-write`, **third** behind `r:task-run` (94) and
`r:task-review` (90). Both the figure and the ranking have moved. This is the failure mode the
refresh move exists for: the number is what holds the surrounding rule up, and a reader who checks
it and finds it wrong discards the rule with it.

## C-54 — `CLAUDE.md` opens with "23 skills" · open

`skills/` holds 26 directories. Separate from the ADR-3/ADR-4 revisit trigger already tracked in
the register README.

## C-55 — `pack-maintain`'s own measured base is stale · open

"Five of the eleven reports in the store are minor" and "'no change' is the answer to two of every
four reports" are computed over eleven reports; the store now holds 22 `r:pack-maintain` result
rows.

## C-56 — `page-serve` exit 2 means one thing in the prose and another in the script header · open

`SKILL.md`'s table gives `2` as "missing, unreadable, **a dotfile**, or outside the working
directory"; `serve.sh`'s own header contract omits the dotfile clause. The code does refuse a
dotfile target, so the behaviour matches the prose and not the script's description of itself.

## C-57 — `--stop [<handle>]` is not optional, and `--local` is undocumented · open

`page-serve`'s invocation block offers `--stop [<handle>]` to "stop one, or all of them", but
`cmd_stop` requires an argument: a bare stop exits 64, and "all" is `stop --all`. The eval case
hides this by always calling `stop --all`. Separately, `--local` is a real script flag the
invocation block never lists.

## C-58 — a documented fallback mechanism that does not exist · open

`skills/test-app-create/SKILL.md` says that without a `test-app-surface` marker, `/r:task-review`
"infers the surface from whether a base URL appears in the file". The workflow does no inference —
it greps for the marker and treats anything not explicitly terminal as web. The consequence the
sentence warns about (a terminal skill read as web) is real; the mechanism it names is not.

## C-59 — the most important refusal in a wrapper has no named exit code · open

`ui-prototype`'s `designmd.sh` documents `0 · 1 · 2 · 3 (reserved) · 4 · 64` and returns a bare
`exit 5` on every positive-evidence failure — the load-bearing case. `tests/designmd.test.sh`
asserts only `!= 0` for it, where the sibling `tui-session.sh` asserts every code exactly.

## C-60 — "nothing leaves the machine", one paragraph above `--lan` · open

`ui-prototype`'s description and Step 5 state it absolutely; `--lan` makes the page reachable from
every device on the network. The consistent reading is "nothing leaves without a flag", and
neither sentence says so.

## C-61 — `bug-hunter` is told to do three things its tool list forbids · **live defect** · **verified** · open

`agents/bug-hunter.md` grants `Bash, Glob, Grep, ListMcpResourcesTool, Read, ReadMcpResourceTool,
TaskCreate, TaskGet, TaskList, TaskStop, TaskUpdate, WebFetch, WebSearch` — **no `Edit`, no
`Write`, no `Skill`, no `Agent`**. Its body then asks for:

- line 24, "**Write a reproducing test.** Create a focused, minimal test that fails because of the
  bug" — a file write, reachable only by shelling a heredoc through `Bash`;
- lines 24 and 40, "delegate to the `r:maven-build-runner` agent" — needs an `Agent` tool it does
  not have, and which since 2.1.217 a subagent cannot have at all;
- line 51, "**Update your agent memory**" — no `memory:` frontmatter key and no write tool.

This is the pack's only reproduce-first investigator, dispatched by `/r:issues-fix` and
`/r:issues-draft` exactly when a defect has to be reproduced to be believed — which is precisely
when the missing write capability bites.

## C-62 — `maven-build-runner` names a tool that does not exist · **live defect** · **verified** · open

`agents/maven-build-runner.md:22`: execute `mvn [goals]` "using the **exec_command** tool". The
granted shell tool is `Bash`, and the gradle twin says `Bash` correctly at the same step. Two
related asymmetries, recorded as entries rather than defects: maven carries `WebFetch`/`WebSearch`
that nothing in its prose uses, and it lacks gradle's "`Bash` may ONLY execute gradle/gradlew
commands" bound, so its read-only promise rests on one bullet instead of a bounded command set.


## C-63 — `planReview.ran: false` now has a third meaning the sentence does not list · open

`skills/task-run/SKILL.md` says `ran: false` means the tier was below full or this was a resume.
Since `d09180f` a full-tier resume of an **unstamped** plan runs the review and returns `ran: true`,
and a **stamped** resume returns `ran: false` for a reason the sentence never mentions. The field is
what a caller reads to decide whether the plan was challenged at all.

## C-64 — the build skip and the review skip are documented as one condition and are two · open

`skills/task-run/SKILL.md` says the build is skipped when a green build or passed review was
recorded over this exact tree, and that `resume.reviewDone` skips Step 5 on the same condition.
`plan-ledger.py` accepts a `build:` **or** a `review:` line for the build, and **only** a matching
`review:` line for `reviewDone`. Same sentence, two different predicates.

## C-65 — the `reviewed:` stamp has two readers that can disagree · open

`skills/task-run/SKILL.md` says the plan header is a ledger the implement workflow reads back
through `scripts/plan-ledger.py`. It does not: `reviewedEarlier` comes from `src.planReviewed` —
Phase 0's own read of the header **on base, before the checkout** — while the script's `reviewed`
field is read **on the feature branch**, returned, and never looked at (`ledger.reviewed` has no
reader in `task-run-implement.workflow.js`). The two answer differently whenever the plan on the
branch is not the plan on base, which is exactly the case a resume is for.

## C-66 — two files name a verdict that no longer exists · open

`skills/issues-fix/SKILL.md` and `fanout.sh`'s own comment both say an untracked marker file "would
come back `no-marker` — a broken fix, to anyone reading the run". Since `b54bad8` that case is
`failed marker-unreadable`, split from `no-marker` precisely because the two need opposite fixes.
Both passages argue for dropping the marker at `spawn`, which the code still does, so only the
verdict named under them is wrong.

## C-67 — the wave dry-merge is `plan-run`'s alone, and `issues-fix` lands differently · open

`plan-run` clears the **whole wave** with `scripts/wave-simulate.sh` and merges nothing until it
passes. `issues-fix`'s `--land` merges branches one at a time and records a conflicting group as
failed, accepting a half-landed wave. Pre-existing, and sharper now that the simulation is a script
under `skills/plan-run/scripts/` that `issues-fix` does not reach for — the two skills share
`fanout.sh` but not this.

## C-68 — a register entry describing a mechanism that was replaced · open

`SB-plan-run-199` still describes the inline `git merge-tree --write-tree --name-only` loop
"carried forward onto the **tree** the last one produced". Since `e6d76de` the dry-merge is a
bundled script and carries forward a **commit with both parents**, never the tree oid. Its core
claim — dry-merge first, nothing merged until it passes — holds, and SB-plan-run-250..253 state the
current mechanism beside it, but the entry's command and its tree-vs-commit detail are stale and
its `—`/`—` fields understate the coverage it now has.
