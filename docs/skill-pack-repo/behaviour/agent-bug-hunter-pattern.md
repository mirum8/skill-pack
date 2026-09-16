# `r:bug-hunter-pattern` — behaviour register

The bundled **pattern hunter**: one hunter in a parallel bug scan, handed a scope and **ONE**
reference file of known failure shapes, asked where the code matches them. A discovery sweep over a
changeset — it never reproduces, never writes a test, never fixes. It is the agent that covers
security, by reading `security.md` beside its own pattern file.

Format, ID scheme and the meaning of the three trailing fields: [`README.md`](README.md).

## Entries

- **SB-agent-bug-hunter-pattern-001** — It is **one hunter in a parallel scan**, handed a **scope**
  and **one reference file** of known failure shapes (logic and flow; concurrency, data and
  performance; silent failures and language traps). Its job is to decide where the code in that
  scope matches those shapes and report it. **Nothing else.**
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-pattern-002** — **It is not investigating a reported bug.** Nobody has said
  something is broken, so there is no failure to reproduce, nothing to make deterministic, and a
  reproducing test is work the orchestrator **explicitly does not want** from it. Stating this in
  the agent rather than only in the brief matters because the agent file loads without its calling
  skill.
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-pattern-003** — A sweep is **judged on whether the findings are real, not
  on how much of the codebase was read**. A root-cause investigation earns its cost by going deep
  on one thread; a sweep earns its cost by covering the change and stopping.
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-pattern-004** — **Step 1 — read your reference file, and no other.** The
  hunter is told which one. Reading another hunter's file duplicates that hunter's work inside this
  hunter's context, which is what keeps the parallel reads cheap in the first place.
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* `skills/task-review/task-review.workflow.js`
  *Tested by:* —

- **SB-agent-bug-hunter-pattern-005** — **Step 2 — read the change before anything else.** It is
  normally handed the diff, or a path to it, and reads that first. **If it was not handed one, it
  runs `git diff HEAD` once itself, from the repo root** — once, not repeatedly, and only as the
  fallback. A hunter that re-derives a diff it was already given produced no extra finding in any
  measured run, and stored scans show hunters deriving *different* changesets (`git diff HEAD`,
  `git diff` and `git diff origin/main..HEAD` inside one scan).
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* `skills/task-review/task-review.workflow.js`
  *Tested by:* `skills/task-review/tests/control-flow.test.mjs`

- **SB-agent-bug-hunter-pattern-006** — **Step 3 — judge from the hunk where possible.** Most
  matches against a known failure shape are visible in the changed lines plus their context, and
  are settled there.
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-pattern-007** — **Step 4 — open source only for a candidate it cannot
  settle**, and then narrowly: `Grep` for the symbol, `Read` with `offset`/`limit` around the line.
  Reading a file end to end, or opening every file that mentions a name, is how a sweep turns into
  an investigation.
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-pattern-008** — **The budget is roughly a dozen tool calls — a budget, not
  a wall.** A genuine candidate that needs a fifteenth call is worth it, but the overrun is spent on
  **one candidate**, never on general orientation.
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-pattern-009** — **The measured figure that justifies the budget.** Across
  **~380 measured hunter runs the median hunt takes ~49 turns and grows its context to ~93k
  tokens**, mostly whole files read before the diff is ever opened. Every turn re-reads everything
  accumulated so far, so that reading is the **largest single cost in a review** — and it is not
  where the findings come from. The same numbers appear in `skills/task-review/SKILL.md` and in the
  pipeline's own hunter prompt; that is **deliberate cross-context restatement, not duplication**.
  The agent file is loaded on its own, so a budget stated only in the calling skill governs none of
  the agent's own default behaviour.
  *States it:* `agents/bug-hunter-pattern.md`, `skills/task-review/SKILL.md`
  *Enforced by:* `skills/task-review/task-review.workflow.js`
  *Tested by:* —

- **SB-agent-bug-hunter-pattern-010** — **If it stops short, it says so.** Running out of budget
  with an unconfirmed candidate is a normal and useful outcome, named in the coverage note —
  "possible N+1 at `OrderRepo:88`, not confirmed" — so the orchestrator knows what was left open.
  **Silently dropping it, and padding the report to look thorough, are both worse than an honest
  short answer.**
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-pattern-011** — **The finding format is four fields**: **file**, **line**,
  **category** (from its own reference file), and what the code does now versus what it should do,
  plus the **production impact** in one line.
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-pattern-012** — It reports only what it has **high confidence** is actually
  broken: no style, no naming, no "could be better", no theoretical risk that needs an unlikely
  caller to materialise. **A clean result is a real result** — if the change does not match its
  patterns it says so rather than inventing something.
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-pattern-013** — It **weights its patterns by what the change actually
  does**. A diff with no shared state and no threading has little for concurrency patterns; one
  full of swallowed exceptions has a lot for silent-failure patterns. **Hunting a category the
  change cannot exhibit produces false positives, not coverage.**
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-pattern-014** — **Report-only.** No edits, no fixes, no tests, no plan
  mode — the orchestrator owns triage and fixing. The frontmatter backs it: `tools` is exactly
  **`Bash, Glob, Grep, Read`**, so there is no `Edit` and no `Write` to fix with, and no `Skill` or
  `Agent` to sub-contract with. Four tools is enough to run `git diff` itself and nothing it would
  be tempted to reach for.
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* `tools/validate.py`
  *Tested by:* `validate.sh`

- **SB-agent-bug-hunter-pattern-015** — **Stay in scope.** Findings must be about the code the
  hunter was pointed at; pre-existing defects elsewhere are somebody else's scan.
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-pattern-016** — **Independent tool calls are batched into ONE block** —
  several greps, several reads, a `git diff` beside a `git status` — with only genuinely dependent
  calls left serial. Cost is turns × context, and every turn re-reads the whole accumulated
  context, **a median of ~77k tokens**, so a call that could have ridden along with the previous
  one pays a full re-read to return one grep. The bullet appears verbatim in six bundled agents as
  **deliberate cross-context restatement**: each agent loads without the others and without its
  calling skill.
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-pattern-017** — It writes in **simplified (B2 level) English**.
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-pattern-018** — Its frontmatter is `model: opus`, `effort: high`. Every
  hunter keeps the top model because each one **adjudicates** whether a hunk is actually a defect,
  which is the job that earns the tier; `high` rather than the top effort because a pattern hunter
  is bounded by the file it was handed, unlike fix-triage ("what is a false positive?") or
  code-quality ("what reads well?"). The measured yield agrees: **`logic` returns 0.71 fixes per
  run over 24 runs and `runtime-and-failures` 0.31 over 16**, against 0.79 for codex and 0.84 for
  the end-verify, both of which run at `medium` because Codex does their thinking.
  *States it:* `agents/bug-hunter-pattern.md`
  *Enforced by:* `skills/task-review/task-review.workflow.js`
  *Tested by:* `skills/task-review/tests/control-flow.test.mjs`

- **SB-agent-bug-hunter-pattern-019** — **`/r:task-review` pins the effort explicitly rather than
  letting it inherit**, even though this agent's own frontmatter already says `high`. Unpinned, the
  row would run at the right depth **for the wrong reason** — nothing in the script would say so,
  and the control-flow assertion would stay green on a lie. The pin is what makes the claim and the
  run agree, and what holds the row still the day this frontmatter moves.
  *States it:* `skills/task-review/task-review.workflow.js`
  *Enforced by:* `skills/task-review/task-review.workflow.js`
  *Tested by:* `skills/task-review/tests/control-flow.test.mjs`

- **SB-agent-bug-hunter-pattern-020** — **`/r:code-bugs` dispatches it four times**, one per
  category file, in a fan-out of up to five hunters: Agent 1 → `skills/code-bugs/references/logic-and-flow.md`
  (Wrong Business Logic, Implementation Mistakes, Broken Flows); Agent 2 →
  `skills/code-bugs/references/concurrency-data-and-performance.md` (Data Corruption, Concurrency, Resource &
  Connection, Performance & Scalability); Agent 3 → `skills/code-bugs/references/silent-failures-and-java.md`
  (Silent Failures, Language-Specific Patterns); Agent 4 → `skills/code-bugs/references/security.md` (Injection &
  Untrusted Input, AuthN/AuthZ, Secrets & Credentials, Sensitive Data Exposure). The fifth is
  `r:bug-hunter-docs`.
  *States it:* `skills/code-bugs/SKILL.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-bug-hunter-pattern-021** — **`/r:task-review` dispatches it twice, with two reference
  files each.** `logic` carries `logic-and-flow.md` **and** `security.md`; `runtime-and-failures`
  carries `concurrency-data-and-performance.md` **and** `silent-failures-and-java.md`. The merge is
  billed, not stylistic: a pattern hunter measures 1.53M cache tokens and 198s per dispatch over 32
  runs, so two agents cost roughly twice one for the same diff while concurrency and
  silent-failures together return 0.37 fixes per run, the weakest pair in the pipeline. Apart they
  cost 2.15M and 2.86M cache-read tokens per run; merged, 4.23M — **~15%, not the ~50% "one agent
  instead of two" suggests**, because a merged hunter takes more turns (41/47 → 57).
  *States it:* `skills/task-review/task-review.workflow.js`
  *Enforced by:* `skills/task-review/task-review.workflow.js`
  *Tested by:* `skills/task-review/tests/control-flow.test.mjs`

- **SB-agent-bug-hunter-pattern-022** — **This is the agent that covers security, and there is no
  security hunter.** The `logic` hunter reads `skills/code-bugs/references/security.md` beside its own pattern file
  and judges the same diff. A separate security context measured **3 fixes over 79 dispatches (0.04
  fixes/run, 43% precision over the 7 findings that reached triage)** and owned **both** recorded
  scope drifts, for a pattern file `logic-and-flow.md` already overlaps at every
  boundary-validation hunk. Merged, the security categories are still hunted on every full-tier
  diff; what is gone is the second cold context.
  *States it:* `skills/task-review/task-review.workflow.js`, `skills/task-review/SKILL.md`
  *Enforced by:* `skills/task-review/task-review.workflow.js`
  *Tested by:* `skills/task-review/tests/control-flow.test.mjs`

- **SB-agent-bug-hunter-pattern-023** — **The security hunt is not a tool wrapper**, and the hunter
  must not reach for the bundled `/security-review` skill. That skill builds its diff from four bash
  commands substituted into its prompt before the model runs, all pinned to `git diff origin/HEAD...`,
  and its body carries no argument placeholder — a scope handed to it is discarded, it judges the
  branch commits instead of the change under review, and it never sees uncommitted work at all.
  Measured over **49 dispatches: 47 reports, 0 findings, and 5 of the 6 that checked reported
  reviewing a different changeset.**
  *States it:* `skills/code-bugs/SKILL.md`, `skills/task-review/SKILL.md`
  *Enforced by:* —
  *Tested by:* `skills/task-review/tests/control-flow.test.mjs`

- **SB-agent-bug-hunter-pattern-024** — **On the security half, the coverage note must name what
  was NOT looked for.** The hunt is newly-introduced, high-confidence-exploitable issues only;
  denial of service, resource exhaustion, capacity rate limiting, missing hardening and dependency
  CVEs are out of scope here (codex, the `runtime-and-failures` hunter and `/r:code-scan` cover
  those). **An empty findings list is not a clean bill of health, and it has been read as one** —
  which is why the boundary is stated by the hunter rather than inferred by the reader.
  *States it:* `skills/task-review/task-review.workflow.js`, `skills/code-bugs/SKILL.md`
  *Enforced by:* `skills/task-review/task-review.workflow.js`
  *Tested by:* —

## Prose-only behaviours

Held up by wording alone — no *Enforced by:* and no *Tested by:*. Nothing fails if one quietly
stops being true, which is the class a rewrite can lose in silence. The agent ships no script and
no suite of its own, so 14 of 24 entries:

SB-agent-bug-hunter-pattern-001, SB-agent-bug-hunter-pattern-002,
SB-agent-bug-hunter-pattern-003, SB-agent-bug-hunter-pattern-006,
SB-agent-bug-hunter-pattern-007, SB-agent-bug-hunter-pattern-008,
SB-agent-bug-hunter-pattern-010, SB-agent-bug-hunter-pattern-011,
SB-agent-bug-hunter-pattern-012, SB-agent-bug-hunter-pattern-013,
SB-agent-bug-hunter-pattern-015, SB-agent-bug-hunter-pattern-016,
SB-agent-bug-hunter-pattern-017, SB-agent-bug-hunter-pattern-020.

Three more are enforced by the pipeline's prompt but have no suite that fails on them: **-004**,
**-009** and **-024**. **-023** is the inverse — no code stops a hunter loading the skill, but the
control-flow suite asserts the pipeline never routes security through it.
