# `r:maven-build-runner` — behaviour register

The bundled **Maven build execution specialist**: it runs the Maven goals it was asked for, reads
the result, and reports one line — `BUILD SUCCESSFUL`, or the specific error that caused the
failure. Nothing else.

**This document is ~85% identical to [`agent-gradle-build-runner.md`](agent-gradle-build-runner.md),
with the build command swapped.** That is recorded as a fact rather than deduplicated, because the
two agents are separate files that each load **without the other**: a rule stated once, in the
sibling, governs nothing here. Where they genuinely differ — the tool list, the strictness of the
read-only wording, and the tool named for executing the build — the entries say so.

Format, ID scheme and the meaning of the three trailing fields: [`README.md`](README.md).

## Entries

- **SB-agent-maven-build-runner-001** — It is a Maven **build execution** specialist: execute maven
  tasks, report clear actionable results, **nothing else**. The narrowness is the product — every
  caller in the pack dispatches it expecting a verdict, not an opinion.
  *States it:* `agents/maven-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-maven-build-runner-002** — **It never modifies any project file.** It is a read-only
  diagnostic agent: it executes maven tasks and analyses their output, and does **not** attempt to
  fix errors by editing code. The frontmatter backs the claim — `tools` is
  **`Glob, Grep, Read, WebFetch, WebSearch, Bash, BashOutput, KillBash`**, with **no `Edit` and no
  `Write`** — so the only write path left is a shell command, which the restriction above forbids
  by wording rather than by tooling.
  *States it:* `agents/maven-build-runner.md`
  *Enforced by:* `tools/validate.py`
  *Tested by:* `validate.sh`

- **SB-agent-maven-build-runner-003** — **Step 1 — run the build command.** It parses the request
  for the maven goal(s), **defaults to `clean install` when none are named**, captures both stdout
  and stderr, and **monitors the exit code** to decide success or failure.
  *States it:* `agents/maven-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-maven-build-runner-004** — **Step 2 — analyse the output.** A successful build is
  reported with its key metrics (build time, goals executed); a failed one has its **root cause**
  extracted and highlighted, and the **phase where it failed** (compilation, tests, packaging)
  named.
  *States it:* `agents/maven-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-maven-build-runner-005** — **Step 3 — error diagnosis is one concise line per shape**:
  `Compilation error: [message] at [file:line]`, `Test failed: [testName] - [assertion]`,
  `Dependency error: [missing/conflict details]`, `POM error: [validation/parsing issue]`,
  `Plugin error: [plugin name] - [error message]`. The POM and Plugin shapes are Maven's own and
  have no counterpart in the gradle twin.
  *States it:* `agents/maven-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-maven-build-runner-006** — **Step 4 — the output is only the verdict**: `BUILD
  SUCCESSFUL` for a green build, or **one line** carrying the specific error for a red one (e.g.
  `Compilation error: cannot find symbol 'foo' at MyClass.java:42`). A build runner that returns a
  log returns the caller's problem back to it.
  *States it:* `agents/maven-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-maven-build-runner-007** — **Step 5 — Maven-specific considerations**: check
  `settings.xml` configuration when repository errors appear; note when the build requires a
  specific Java version as configured in the POM; identify failures caused by missing test
  infrastructure; recognise common Spring Boot Maven plugin issues; and **look for the Maven
  wrapper (`.mvnw`) and use it if available**.
  *States it:* `agents/maven-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-maven-build-runner-008** — **Step 6 — error prioritisation: report the FIRST error
  that caused the failure.** Subsequent errors are usually cascading effects, so the most
  actionable information is extracted rather than an entire stack trace dumped.
  *States it:* `agents/maven-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-maven-build-runner-009** — **It executes immediately on being invoked** and returns
  only the build result. There is no exploratory phase: the agent exists to spend one command and
  come back.
  *States it:* `agents/maven-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-maven-build-runner-010** — Its frontmatter is `model: haiku`, `effort: medium`, which
  is right for what it does on **almost every dispatch**: run one command and report
  `BUILD SUCCESSFUL`.
  *States it:* `agents/maven-build-runner.md`
  *Enforced by:* —
  *Tested by:* `skills/task-run/tests/control-flow.test.mjs`

- **SB-agent-maven-build-runner-011** — **The pipelines step the MODEL up over this agent's own
  tier for the classifying build call**, to `sonnet`/`medium`. On a **red** build that call splits
  failures into in-scope and pre-existing, and the split is load-bearing **both ways**: wrongly
  "pre-existing" halts the run on a failure the fix phase should have taken; wrongly "in-scope"
  sends a fixer to edit somebody else's failing test, which the pipeline forbids outright. The
  green path is most dispatches and costs the same either way, because the model only matters once
  there is something to classify.
  *States it:* `skills/task-review/SKILL.md`, `skills/task-review/task-review.workflow.js`
  *Enforced by:* `skills/task-review/task-review.workflow.js`
  *Tested by:* `skills/task-run/tests/control-flow.test.mjs`

- **SB-agent-maven-build-runner-012** — **The post-scan rebuild stays at `sonnet` too**, although it
  has nothing to classify — the tree was green before `/r:code-scan` ran, so any failure there is
  in-scope by construction. It still decides **green versus red at all**, and that verdict halts the
  run outright with no tier above it to disagree. On this agent's own `haiku` tier the verdict comes
  from whatever the log looks like; the tier above is what reliably captures `$?` instead.
  *States it:* `skills/task-review/task-review.workflow.js`
  *Enforced by:* `skills/task-review/task-review.workflow.js`
  *Tested by:* —

- **SB-agent-maven-build-runner-013** — **Every build prompt names the deciding rule: judge from the
  EXIT CODE, never from the log text.** The incremental commands are `-q`, so a green build prints
  no `BUILD SUCCESS` line **and does print `[ERROR]` lines** — failure-path tests, and Surefire's
  `going to kill self fork JVM` shutdown notice. An agent grepping for the first while seeing the
  second calls a finished, green diff red. The absence of a `BUILD SUCCESS` line proves **nothing**.
  *States it:* `skills/task-review/SKILL.md`, `skills/task-review/task-review.workflow.js`
  *Enforced by:* `skills/task-review/task-review.workflow.js`
  *Tested by:* —

- **SB-agent-maven-build-runner-014** — **Both pipelines select it from the detected build tool.**
  A `pom.xml` resolves `buildTool 'maven'`, `buildCmd "mvn clean package"`, `buildCmdFast
  "mvn package"` and `runnerAgent "r:maven-build-runner"`; a `build.gradle*` resolves the gradle row
  instead. A project with **no** JVM build tool gets `runnerAgent ''`, and the build runs through a
  **general-purpose agent** executing the detected command — the runner agents exist to parse
  mvn/gradle output, and a shell command's exit code needs no parser.
  *States it:* `skills/task-run/task-run-implement.workflow.js`,
  `skills/task-review/task-review.workflow.js`
  *Enforced by:* `skills/task-review/task-review.workflow.js`
  *Tested by:* `skills/task-review/tests/control-flow.test.mjs`,
  `skills/task-run/tests/control-flow.test.mjs`

- **SB-agent-maven-build-runner-015** — **`r:bug-hunter` delegates Maven builds and test runs to
  this agent** rather than invoking Maven directly, so a root-cause investigation does not carry a
  build log in its own context.
  *States it:* `agents/bug-hunter.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-maven-build-runner-016** — **It carries `WebFetch` and `WebSearch`; the gradle twin
  does not.** That is the one capability difference between the two documents, and nothing in the
  agent's prose asks for either — a build runner told to return one line has no step that reaches
  the network.
  *States it:* `agents/maven-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

## Prose-only behaviours

Held up by wording alone — no *Enforced by:* and no *Tested by:*. Nothing fails if one quietly
stops being true, which is the class a rewrite can lose in silence. The agent ships no script and
no suite of its own, so 10 of 16 entries:

SB-agent-maven-build-runner-001, SB-agent-maven-build-runner-003,
SB-agent-maven-build-runner-004, SB-agent-maven-build-runner-005,
SB-agent-maven-build-runner-006, SB-agent-maven-build-runner-007,
SB-agent-maven-build-runner-008, SB-agent-maven-build-runner-009,
SB-agent-maven-build-runner-015, SB-agent-maven-build-runner-016.

**-012** and **-013** are the pair to watch: both are enforced by the pipeline's prompt text, and
neither has a suite that fails if the exit-code rule is reworded out of it.

## Defect recorded, not fixed

**The execution step names a tool the agent does not have.** Step 1 says to execute `mvn [goals]`
"using the **exec_command** tool", which is in no `tools` list in this pack; the granted shell tool
is `Bash`, and the gradle twin's corresponding step says `Bash` correctly. The agent also lacks the
gradle twin's explicit "the Bash tool can ONLY be used to execute gradle/gradlew commands"
restriction, so its read-only promise in **-002** rests on one bullet rather than on a bounded
command set.
