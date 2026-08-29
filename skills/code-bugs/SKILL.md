---
description: >-
  Scan code for real production bugs and implementation mistakes — code that will break, produce
  wrong results, fail in edge cases, or cause outages through performance issues (N+1 queries,
  unbounded fetches, connection exhaustion) — and check changes against the project's existing
  documentation (spec, todo, docs/, DESIGN.md/ui-design.md, CLAUDE.md rules, README) for code/doc
  drift. Use on "find bugs", "scan for bugs", "check for bugs", "/r:code-bugs", "look for mistakes
  in my changes", "anything broken in the diff?", "any N+1 queries?", "performance bugs in this
  code?", "do my changes match the docs/spec?". NOT for: adding validation, writing tests, fixing
  known bugs, refactoring, code review style feedback, or running builds. A bug hunter, not a
  linter or fixer.
---

# code-bugs

Scan code for real production bugs — code that does not do what the developer intended, produces wrong results, or causes outages through severe performance issues (N+1 queries, unbounded fetches, pool exhaustion). Not a linter, not a micro-optimizer.

## Phase 1: Scope Resolution

1. Parse the request into a scope:
   - **Specific class/file**: "find bugs in UserService" → that file and its direct dependencies
   - **Package/module**: "find bugs in the payment module" → all files in that package
   - **Entire project**: "find bugs" with no qualifier → the full source tree (excluding tests, generated code, build output)
2. If the scope is ambiguous, use `AskUserQuestion` before proceeding
3. Resolve the actual files with `Glob` and `Grep`

## Phase 2: Code Scanning

1. Launch up to **5 hunters in parallel** — four `r:bug-hunter-pattern` agents by category plus a documentation-consistency hunter. Each owns one topic file under `references/` and reads **only that file**:
   - **Agent 1** (`r:bug-hunter-pattern`): Wrong Business Logic, Implementation Mistakes, Broken Flows → `references/logic-and-flow.md`
   - **Agent 2** (`r:bug-hunter-pattern`): Data Corruption, Concurrency Issues, Resource & Connection Issues, Performance & Scalability → `references/concurrency-data-and-performance.md`
   - **Agent 3** (`r:bug-hunter-pattern`): Silent Failures, Language-Specific Patterns → `references/silent-failures-and-java.md`
   - **Agent 4** (`r:bug-hunter-pattern`): Injection & Untrusted Input, Authentication & Authorization, Secrets & Credentials, Sensitive Data Exposure → `references/security.md`
   - **Agent 5** (`r:bug-hunter-docs`): Documentation Consistency — checks the change against the project's docs (`spec.md`/`spec.html`, `todo.md`, `docs/*`, `DESIGN.md`/`ui-design.md`, the `**/CLAUDE.md` hierarchy + nested module rules, `README.md`/`ARCHITECTURE.md`) and reports code/doc divergences and violations of stated CLAUDE.md rules → `references/documentation-consistency.md`. Dispatch it with `subagent_type: "r:bug-hunter-docs"` — it treats docs as authoritative intent and recommends which side to move. A consistency check, not a bug hunt: when code and docs disagree, the fix may be to update the docs.

   **Security is a category hunter, not a tool wrapper.** It reads `references/security.md` like
   every other pattern hunter and judges the same diff. Do NOT reach for the bundled
   `/security-review` skill here, and do NOT let a hunter reach for it: that skill builds its diff
   from four bash commands substituted into its prompt before the model runs, all pinned to
   `git diff origin/HEAD...`, and its body carries no argument placeholder — so a scope handed to
   it is discarded, it judges the branch commits instead of the change under review, and it never
   sees uncommitted work at all. Measured over 49 dispatches driven that way: 47 reports,
   0 findings, and 5 of the 6 that checked reported reviewing a different changeset.
   - **Its empty result is not a clean bill.** This hunt is for high-confidence-exploitable issues
     the change introduces, only. Denial of service, resource exhaustion, capacity rate limiting,
     missing hardening and dependency CVEs are out of its scope by design — Agent 2 and
     `/r:code-scan` cover those. Carry that boundary into Phase 3 so a clean security result reads
     as "no exploitable issue newly introduced in the changeset reviewed", never as "the whole
     codebase is secure".
   - **Mind the scope gap.** Every hunter is diff-scoped: on a diff they read the changeset and
     nothing else. When this scan is whole-project, say so.

   **If you have no `Agent` tool, you are a subagent — scan inline and SAY SO.** Subagents cannot spawn. Do not skip a track: work through all five topic files **yourself**, one after another, then open the report with the line *"Run single-context: no hunter fan-out available in this context."* — unlabelled, a one-context scan passes for a full one. If the caller needed the real fan-out, they dispatch the five hunters themselves, from a level that can.

2. Give each agent the scope resolved in Phase 1 (explicit file list, package, or `git diff` for "bugs in my changes") and tell it to read its own topic file. Every hunter has `Bash`, `Glob`, and `Grep`, so each can run `git diff` and search the tree itself. Tell each agent it is doing a discovery scan (unknown bugs across the scope), not investigating one reported bug, and that it must NOT write reproducing tests in this phase — just report findings.

   **When the scope is a diff, capture it once and give every hunter the same file.** Each hunter is a fresh context and otherwise derives the change itself — measured at 10–17 shell calls apiece before any hunting starts, and *not to the same answer*: stored runs show `git diff HEAD`, `git diff` and `git diff origin/main..HEAD` inside one scan. Run `d="$(mktemp)"; git diff HEAD -U20 > "$d"` once, pass that path, and tell each hunter to read it first and not re-derive it. Pass the **path**, never the diff text — 40k characters of patch embedded in a brief come back lossy, and a paraphrased diff is worse than one the hunter fetched itself.

   **Bound the hunt.** Left alone a hunter explores before it reads the change: measured over 151 runs, the median one reads **twelve whole source files before it ever runs `git diff`**, reaches the diff around turn 31, and finishes at turn 49 holding ~93k tokens. Brief each hunter to read the change first, judge from the hunk where it can, open surrounding source only for a candidate it cannot settle (`Grep` the symbol, `Read` with `offset`/`limit` — never a whole file), and keep to about **12 tool calls**. A budget, not a wall: overrun is fine on a real candidate, and a hunter that stops with something unconfirmed must **say so** rather than dropping it or padding the report.

   **Agent 5 also needs the mode.** Pass it the scope **and** the mode: **diff mode by default** (only the changed code against the docs), **whole-project doc audit only when Phase 1 resolved scope to the entire project**. If it finds no documentation files in scope, it returns "No documentation found to check against" — a valid result, not a failure.
3. Each agent must:
   - Read actual source code — not just file names
   - Trace real execution paths through the code
   - Understand the intended behavior from method names, class context, and surrounding code
   - Focus on code that is **actually wrong** — not style, not theoretical, not "could be better"
   - Report findings with: file path, line number, what the code does vs what it should do, production impact

**Collecting results — every hunter must run.** A hunter's findings are its **final message** (the value the `Agent` tool hands back). There is no `.done` marker, status file, or output file — never invent one, and never use `Monitor` or poll a file's mtime to wait on a hunter: that hangs the scan for ten minutes on a hunter that has already finished or died.

All five hunters must run and report before you consolidate — a scan missing the security or docs hunter is not a complete `/r:code-bugs` run. If a hunter comes to rest **without usable findings** (it errored, died, returned nothing, or — where one is required — its report lacks the mandatory confirmation line), **re-dispatch that same hunter**: same `subagent_type`, same scope and prompt. Re-dispatching is the fix, not waiting. Bound it to **2 re-dispatches per hunter**; if it still will not return, **stop and tell the user which hunter is blocked and why** — never silently drop it from the report, never keep waiting on it, never fake it.

**Critical rules for agents:**
- Only report findings where you have **high confidence** the code is broken
- If you are unsure whether something is a bug or intentional, skip it
- Never report style issues, naming suggestions, or "consider using X instead"
- Read enough surrounding code to understand context before flagging

## Phase 3: Bug Report

1. Compile findings from Agents 1–4 (Agent 5's doc-drift findings get their own heading in step 3), deduplicate, and discard low-confidence items. All five must have reported — a missing hunter was re-dispatched in Phase 2, so do not reach here without one.
2. For each confirmed finding, present:
   - **File & line**: exact location
   - **What it does**: what the code actually does right now
   - **What it should do**: what the developer likely intended
   - **Production impact**: what breaks, what data gets corrupted, what fails silently
3. **Documentation drift (Agent 5)** goes under its own heading — its resolution is a doc-or-code decision, not a fix to verify with a test. For each divergence present:
   - **Doc**: file + section/line of the documentation statement, quoted briefly
   - **Code**: file + line of the contradicting code
   - **Divergence**: the specific mismatch
   - **Suggested resolution**: `update doc` / `update code` / `confirm intent`, with the one-line rationale
   If Agent 5 reported "No documentation found to check against," say so plainly and skip this section.
4. Use `AskUserQuestion` to present the findings. For production bugs, let the user select which to investigate with failing tests. For documentation drift, let the user choose per divergence: **update the doc**, **update the code**, or **confirm intent** (leave both as-is). A code-side resolution falls into the normal fix flow (failing test + plan); "confirm intent" changes nothing.

   Choosing **update doc** selects the resolution — it is **not** yet permission to write to the file. Before editing any documentation file, show the proposed edit (file path and exact before/after text) and get explicit approval for that specific change; only then apply it with `Edit`/`Write`. Doc files are the project's written intent and easy to clobber silently, so they get the same see-it-first gate code fixes get through Phase 5 plan mode.
5. If no real bugs were found, report that clearly — do not invent findings to seem useful
6. **State the security track's actual coverage, and its boundary.** Quote what the security hunter says it read, and carry through what it did not look for — denial of service, resource exhaustion, capacity rate limiting, missing hardening and dependency CVEs are out of its scope by design. Report a clean result as "no exploitable issue newly introduced in the reviewed changeset", never as "the codebase is secure"; when the scan was whole-project but the hunters only saw the changeset, say that too.

## Phase 4: Failing Tests

For each bug the user selected:

1. Write a unit test that **exposes the bug** — it must **FAIL** against current code
2. Test framework:
   - **Java**: JUnit 5 + Mockito, following the project's existing test patterns
   - **Other languages**: detect and use the project's existing test framework
3. Use the `r:java-backend-developer` agent (or the appropriate language agent) for test implementation
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
retired on measured yield:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:code-bugs","scope":"diff|all|explicit","hunters":0,"huntersBlocked":[],"testsWritten":0,
 "findings":[{"track":"logic","category":"logic","severity":"high","file":"src/Foo.java","line":88,
              "verdict":"confirmed","fixed":false,"description":"one short line, not the write-up"}]}
STATS_JSON
```

**Record every finding a hunter reported, including the ones you rejected** — `verdict` is
`confirmed` for what you kept and `dismissed` for what you dropped in Phase 3. Without the
verdict, a hunter whose findings are always rejected and one that finds nothing look identical,
and only the first should be retired. `track` is the hunter that reported it.

Keep each `description` to one line — the store holds titles, never finding bodies. The script
always exits `0`: a record that does not get written is a lost record, not a failed run. Never
retry it and never report it as a failure of the hunt.
