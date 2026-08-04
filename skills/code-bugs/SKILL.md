---
description: >-
  Scan code for real production bugs and implementation mistakes — code that will break, produce
  wrong results, fail in edge cases, or cause production outages through performance issues (N+1
  queries, unbounded fetches, connection exhaustion). Also checks changes against the project's
  existing documentation (spec, todo, docs/, DESIGN.md/ui-design.md, CLAUDE.md rules, README) and
  flags code/doc drift. Use on "find bugs", "scan for bugs", "check for bugs", "/r:code-bugs",
  "look for mistakes in my changes", "anything broken in the diff?", "any N+1 queries?",
  "performance bugs in this code?", "do my changes match the docs/spec?". NOT for: adding
  validation, writing tests, fixing known bugs, refactoring, code review style feedback, or
  running builds. This is a bug hunter, not a linter or fixer.
---

# Find Bugs

Scan code for real production bugs — code that doesn't do what the developer intended, will break in production, produces wrong results, or causes outages through severe performance issues (N+1 queries, unbounded fetches, pool exhaustion). Not a pedantic linter, not a micro-optimizer. A focused hunt for code that is actually broken or will fall over under real load.

## Phase 1: Scope Resolution

Determine what code to scan:

1. Parse the user's request to identify scope:
   - **Specific class/file**: "find bugs in UserService" → scan that file and its direct dependencies
   - **Package/module**: "find bugs in the payment module" → scan all files in that package
   - **Entire project**: "find bugs" with no qualifier → scan the full source tree (excluding tests, generated code, build output)
2. If scope is ambiguous, use `AskUserQuestion` to clarify before proceeding
3. Use `Glob` and `Grep` to resolve the actual files to scan

## Phase 2: Code Scanning

1. Launch up to **5 hunters in parallel** — three `r:bug-hunter-pattern` agents by pattern category, plus a dedicated security hunter and a dedicated documentation-consistency hunter. Each owns a topic file under `references/` and reads **only that file**, so each hunter loads just its own patterns:
   - **Agent 1** (`r:bug-hunter-pattern`): Wrong Business Logic, Implementation Mistakes, Broken Flows → `references/logic-and-flow.md`
   - **Agent 2** (`r:bug-hunter-pattern`): Data Corruption, Concurrency Issues, Resource & Connection Issues, Performance & Scalability → `references/concurrency-data-and-performance.md`
   - **Agent 3** (`r:bug-hunter-pattern`): Silent Failures, Language-Specific Patterns → `references/silent-failures-and-java.md`
   - **Agent 4** (`r:bug-hunter-security`): Security — this hunter runs the **real `/security-review` skill** over the scope, not the static checklist (`references/security.md` is its fallback only). `r:bug-hunter-pattern` has no `Skill` tool and can't invoke it; `r:bug-hunter-security` does. This is why Security is its own hunter rather than a category bolted onto Agent 3 — a checklist is not a security review.
   - **Agent 5** (`r:bug-hunter-docs`): Documentation Consistency — checks the change against the project's docs (`spec.md`/`spec.html`, `todo.md`, `docs/*`, `DESIGN.md`/`ui-design.md`, the `**/CLAUDE.md` hierarchy + nested module rules, `README.md`/`ARCHITECTURE.md`) and reports code/doc divergences and violations of stated CLAUDE.md rules → `references/documentation-consistency.md`. Dispatch it with `subagent_type: "r:bug-hunter-docs"` — the dedicated hunter that treats docs as authoritative intent and recommends which side to move. This is a consistency check, not a bug hunt: when code and docs disagree, the fix may be to update the docs, not the code.

   **Do not downgrade Agent 4.** The security track is the one place this skill is most often subtly broken, so be exact:
   - Dispatch it with `subagent_type: "r:bug-hunter-security"` — never `r:bug-hunter-pattern`. Substituting a pattern hunter silently turns the scan into a checklist read, because that agent has no `Skill` tool.
   - Its prompt must instruct it to **invoke the `/security-review` skill** over the scope. Do NOT write a prompt that says "read `security.md` and check these patterns" or "run `git diff` and look for XSS/SQLi" — that makes the fallback checklist the primary scan, which is the failure this design exists to prevent. `security.md` is fallback only; the prompt names the scope, not the checklist.
   - Its report must contain the mandatory confirmation line (`✅ Invoked the real /security-review skill …` or `❌ Did NOT run …`), leading the report. If that line is genuinely absent, or the output is a hand-rolled "security analysis" with no sign the real skill ran, treat the security track as not having run and re-dispatch.
   - **Mind the scope gap.** `/security-review` is diff-scoped — it reviews the working-tree diff (or the unpushed branch commits when the tree is clean), NOT the full source tree, even when this scan is whole-project. The security hunter states its real coverage in the confirmation line; carry that through to Phase 3 so a clean security result is reported as "no issues in the changeset reviewed," never as "the whole codebase is secure."
   **If you have no `Agent` tool, you are a subagent — scan inline and SAY SO.** Since Claude Code 2.1.217 subagents can't spawn, so the fan-out above is simply unavailable to you. Don't pretend otherwise and don't quietly skip a track: work through all five topic files **yourself**, in your own context, one after another (including invoking the real `/security-review` for the security track, if you have the `Skill` tool). Then open your report with an explicit line — *"Run single-context: no hunter fan-out available in this context."* A one-context scan reads exactly like a five-hunter scan unless you label it, and an unlabelled one lets a thinner review pass for a full one. If your caller needed the real fan-out, the right fix is on their side: they should dispatch the five hunters themselves, from a level that can.

2. Give each agent the scope resolved in Phase 1 (explicit file list, package, or `git diff` for "bugs in my changes") and tell it to read its own topic file (above) for the patterns it owns. Agents 1–3 and 5 have `Bash`, `Glob`, and `Grep`, so they can run `git diff` and search the tree themselves; Agent 4 just needs the scope — it drives `/security-review`. Tell each agent it is doing a discovery scan (find unknown bugs across the scope), not investigating a single reported bug, and that it should NOT write reproducing tests in this phase — just report findings.

   **When the scope is a diff, capture it once and give every hunter the same file.** Each hunter is a fresh context with no shared prefix, so each otherwise derives the change for itself — measured at 10–17 shell calls apiece before any hunting starts, and *not to the same answer*: stored runs show `git diff HEAD`, `git diff` and `git diff origin/main..HEAD` inside one scan, which are three different changesets. Run `d="$(mktemp)"; git diff HEAD -U20 > "$d"` once, pass that path, and tell each hunter to read it first and not re-derive it. Pass the **path**, never the diff text — a brief that embeds 40k characters of patch asks each hunter to work from a copy that may come back lossy, and a hunter reviewing a paraphrased diff is worse than one that fetched its own.

   **Bound the hunt.** Cost here is turns × context, and left alone a hunter explores before it reads the change: measured over 151 runs, the median one reads **twelve whole source files before it ever runs `git diff`**, reaches the diff around turn 31, and finishes at turn 49 holding ~93k tokens. So brief each hunter to read the change first, judge from the hunk where it can, open surrounding source only for a candidate it cannot settle (`Grep` the symbol, `Read` with `offset`/`limit` — never a whole file), and keep to about **12 tool calls**. Make it a budget, not a wall: overrun is fine on a real candidate, and a hunter that stops with something unconfirmed must **say so** rather than dropping it silently or padding the report.

   **Agent 5 also needs the mode.** Pass it the scope **and** tell it which mode to run: **diff mode by default** (compare only the changed code against the docs), and **whole-project doc audit only when Phase 1 resolved scope to the entire project**. If it finds no documentation files anywhere in scope, it returns "No documentation found to check against" — that is a valid, expected result, not a failure.
3. Each agent must:
   - Read actual source code — not just file names
   - Trace real execution paths through the code
   - Understand the intended behavior from method names, class context, and surrounding code
   - Focus on code that is **actually wrong** — not style, not theoretical, not "could be better"
   - Report findings with: file path, line number, what the code does vs what it should do, production impact

**Collecting results — every hunter must run.** Each hunter returns its findings as its **final message** (the value the `Agent` tool hands back). There is no `.done` marker, status file, or output file to watch — so never invent one, and never use `Monitor` or poll a file's mtime to wait on a hunter. That improvised polling is exactly what hangs the scan for ten minutes on a hunter that has already finished or died.

All five hunters must actually run and report before you consolidate — a scan missing the security or docs hunter is not a complete find-bugs, so you may not proceed without one. If a hunter comes to rest **without usable findings** (it errored, died, returned nothing, or — where one is required — its report lacks the mandatory confirmation line), **re-dispatch that same hunter**: same `subagent_type`, same scope and prompt. Re-dispatching is the fix, not waiting. Bound it to **2 re-dispatches per hunter** so a genuinely broken hunter can't loop forever; if it still won't return after that, **stop and tell the user which hunter is blocked and why** — never silently drop it from the report and never keep waiting on it. (Same spirit as the security track above: never fake a hunter, never quietly skip one.)

**Critical rules for agents:**
- Only report findings where you have **high confidence** the code is broken
- If you're unsure whether something is a bug or intentional, skip it
- Never report style issues, naming suggestions, or "consider using X instead"
- Read enough surrounding code to understand context before flagging

## Phase 3: Bug Report

1. Compile findings from all agents (Agents 1–4; Agent 5's doc-drift findings get their own heading in step 3), deduplicate, and discard low-confidence items. All five must have reported — if one didn't, you re-dispatched it in Phase 2, so don't reach here with a hunter still missing.
2. For each confirmed finding, present:
   - **File & line**: exact location
   - **What it does**: what the code actually does right now
   - **What it should do**: what the developer likely intended
   - **Production impact**: what breaks, what data gets corrupted, what fails silently
3. **Documentation drift (Agent 5)** goes under its own heading, separate from the production bugs above — its resolution is a doc-or-code decision, not a fix to verify with a test. For each divergence present:
   - **Doc**: file + section/line of the documentation statement, quoted briefly
   - **Code**: file + line of the contradicting code
   - **Divergence**: the specific mismatch
   - **Suggested resolution**: `update doc` / `update code` / `confirm intent`, with the one-line rationale
   If Agent 5 reported "No documentation found to check against," say so plainly and skip this section.
4. Use `AskUserQuestion` to present the findings. For production bugs, let the user select which to investigate further with failing tests. For documentation drift, let the user choose per divergence whether to **update the doc**, **update the code**, or **confirm intent** (leave both as-is). A code-side resolution falls into the normal fix flow (failing test + plan); "confirm intent" changes nothing.

   Choosing **update doc** selects the resolution — it is **not** yet permission to write to the file. Before editing any documentation file, show the concrete proposed edit (the file path and the exact before/after text) and get explicit approval for that specific change; only then apply it with `Edit`/`Write`. Doc files are the project's written intent and easy to clobber silently, so they get the same see-it-before-it-happens treatment that code fixes already earn through the Phase 5 plan-mode gate — the user should never find a doc rewritten by a resolution they pictured differently.
5. If no real bugs found, report that clearly — don't invent findings to seem useful
6. **State the security track's actual coverage.** Quote what the security hunter's confirmation line says `/security-review` covered (e.g. "the uncommitted diff," "the 15 unpushed commits"). When the scan was whole-project but the security hunter only saw the changeset, say so explicitly — "no security issues in the reviewed changeset (the rest of the tree was not security-scanned)" — so the user isn't left thinking the full codebase got a security pass.

## Phase 4: Failing Tests

For each bug the user selected:

1. Write a unit test that **exposes the bug** — the test should **FAIL** against current code
2. Test framework selection:
   - **Java**: JUnit 5 + Mockito, follow existing test patterns in the project
   - **Other languages**: detect and use the project's existing test framework
3. Use `r:java-backend-developer` agent (or appropriate language agent) for test implementation
4. Run the tests to confirm they fail — this proves the bug exists
5. If a test passes (bug not reproducible), reconsider the finding and inform the user

## Phase 5: Fix Plan

1. Enter plan mode via `EnterPlanMode`
2. For each confirmed bug with a failing test:
   - Describe the root cause
   - Propose the minimal fix
   - List affected files
3. Order fixes by:
   - Severity (data corruption > wrong results > silent failures)
   - Dependencies (fix A before B if B depends on A)

## Record the run

Last thing, once the report exists. One record into the pack-wide store, so a hunter can be
retired on measured yield instead of opinion:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:code-bugs","scope":"diff|all|explicit","hunters":0,"huntersBlocked":[],"testsWritten":0,
 "findings":[{"track":"logic","category":"logic","severity":"high","file":"src/Foo.java","line":88,
              "verdict":"confirmed","fixed":false,"description":"one short line, not the write-up"}]}
STATS_JSON
```

**Record every finding a hunter reported, including the ones you rejected** — `verdict` is
`confirmed` for what you kept and `dismissed` for what you dropped in Phase 3. This is the whole
point of the row: a hunter whose findings you reject every time and a hunter that finds nothing
look identical in the counts, and the first should be retired while the second may just have had
clean diffs. `track` is the hunter that reported it.

Keep each `description` to one line — the payload travels in this step's prompt, and the store
holds titles, never finding bodies. The script always exits `0`: a record that does not get
written is a lost record, not a failed run. Never retry it and never report it as a failure of
the hunt.
