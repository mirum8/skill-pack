# `r:gradle-build-runner` — behaviour register

The bundled **Gradle build execution specialist**: it runs the Gradle tasks it was asked for, reads
the result, and reports one line — `BUILD SUCCESSFUL`, or the specific error that caused the
failure. Nothing else.

**This document is ~85% identical to [`agent-maven-build-runner.md`](agent-maven-build-runner.md),
with the build command swapped.** That is recorded as a fact rather than deduplicated, because the
two agents are separate files that each load **without the other**: a rule stated once, in the
sibling, governs nothing here. Where they genuinely differ — the tool list, the strictness of the
read-only wording, and the Bash restriction — the entries say so.

Format, ID scheme and the meaning of the three trailing fields: [`README.md`](README.md).

## Entries

- **SB-agent-gradle-build-runner-001** — It is a Gradle **build execution** specialist: execute
  gradle tasks, report clear actionable results, **nothing else**. The narrowness is the product —
  every caller in the pack dispatches it expecting a verdict, not an opinion.
  *States it:* `agents/gradle-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-gradle-build-runner-002** — **It is STRICTLY read-only**: it never modifies, edits,
  writes or creates any file or directory, never uses a tool that can modify the filesystem, and
  never attempts to fix, correct or modify any code or configuration file. The frontmatter agrees —
  `tools` is **`Glob, Grep, Read, Bash, BashOutput, KillBash`**, with **no `Edit` and no `Write`**.
  The document opens **and closes** on this rule ("you are completely read-only — run gradle, report
  what it said, change nothing"), because an agent that can see a compilation error is one turn away
  from being asked to fix it, and a build runner that edits the tree makes its own verdict
  unfalsifiable.
  *States it:* `agents/gradle-build-runner.md`
  *Enforced by:* `tools/validate.py`
  *Tested by:* `validate.sh`

- **SB-agent-gradle-build-runner-003** — **The `Bash` tool may ONLY execute gradle/gradlew
  commands** — no other command is allowed. This bound is the gradle twin's own: the maven agent
  carries no equivalent restriction, and it is what turns **-002**'s read-only promise from a
  request into a bounded command set.
  *States it:* `agents/gradle-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-gradle-build-runner-004** — **Step 1 — run the build command.** It parses the request
  for the gradle task(s), executes **only** `./gradlew [tasks]` or `gradle [tasks]` **via the Bash
  tool**, **defaults to `clean build` when no tasks are named**, captures both stdout and stderr,
  and **monitors the exit code** to decide success or failure.
  *States it:* `agents/gradle-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-gradle-build-runner-005** — **Step 2 — analyse the output.** A successful build is
  reported with its key metrics (build time, tasks executed); a failed one has its **root cause**
  extracted and highlighted, and the **phase where it failed** (compilation, tests, packaging)
  named.
  *States it:* `agents/gradle-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-gradle-build-runner-006** — **Step 3 — error diagnosis is one concise line per shape**:
  `Compilation error: [message] at [file:line]`, `Test failed: [testName] - [assertion]`,
  `Dependency error: [missing/conflict details]`. Three shapes here against the maven twin's five —
  Gradle has no POM and no `Plugin error` row.
  *States it:* `agents/gradle-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-gradle-build-runner-007** — **Step 4 — the output is only the verdict**: `BUILD
  SUCCESSFUL` for a green build, or **one line** carrying the specific error for a red one (e.g.
  `Compilation error: cannot find symbol 'foo' at MyClass.java:42`). A build runner that returns a
  log returns the caller's problem back to it.
  *States it:* `agents/gradle-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-gradle-build-runner-008** — **Step 5 — Gradle-specific considerations**: check the
  `GRADLE_USER` and `GRADLE_PASSWORD` environment variables when Nexus repository errors appear;
  note when the build requires **Java 21** as configured in the project; identify failures caused by
  missing integration-test infrastructure; and recognise common Spring Boot build issues.
  *States it:* `agents/gradle-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-gradle-build-runner-009** — **Step 6 — error prioritisation: report the FIRST error
  that caused the failure.** Subsequent errors are usually cascading effects, so the most actionable
  information is extracted rather than an entire stack trace dumped.
  *States it:* `agents/gradle-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-gradle-build-runner-010** — **It executes immediately on being invoked** and returns
  only the build result. There is no exploratory phase: the agent exists to spend one command and
  come back.
  *States it:* `agents/gradle-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

- **SB-agent-gradle-build-runner-011** — Its frontmatter is `model: haiku`, `effort: medium`, which
  is right for what it does on **almost every dispatch**: run one command and report
  `BUILD SUCCESSFUL`.
  *States it:* `agents/gradle-build-runner.md`
  *Enforced by:* —
  *Tested by:* `skills/task-run/tests/control-flow.test.mjs`

- **SB-agent-gradle-build-runner-012** — **The pipelines step the MODEL up over this agent's own
  tier for the classifying build call**, to `sonnet`/`medium`. On a **red** build that call splits
  failures into in-scope and pre-existing, and the split is load-bearing **both ways**: wrongly
  "pre-existing" halts the run on a failure the fix phase should have taken; wrongly "in-scope"
  sends a fixer to edit somebody else's failing test, which the pipeline forbids outright. The green
  path is most dispatches and costs the same either way, because the model only matters once there
  is something to classify.
  *States it:* `skills/task-review/SKILL.md`, `skills/task-review/task-review.workflow.js`
  *Enforced by:* `skills/task-review/task-review.workflow.js`
  *Tested by:* `skills/task-run/tests/control-flow.test.mjs`

- **SB-agent-gradle-build-runner-013** — **Every build prompt names the deciding rule: judge from
  the EXIT CODE, never from the log text.** The incremental commands are `-q`, so a green build
  prints no `BUILD SUCCESS`/`BUILD SUCCESSFUL` line **and does print error lines** from failure-path
  tests. An agent grepping for the first while seeing the second calls a finished, green diff red —
  the absence of a success line proves **nothing**.
  *States it:* `skills/task-review/SKILL.md`, `skills/task-review/task-review.workflow.js`
  *Enforced by:* `skills/task-review/task-review.workflow.js`
  *Tested by:* —

- **SB-agent-gradle-build-runner-014** — **Both pipelines select it from the detected build tool.**
  A `build.gradle*` resolves `buildTool 'gradle'`, `buildCmd "./gradlew clean build"`, `buildCmdFast
  "./gradlew build"` and `runnerAgent "r:gradle-build-runner"`; a `pom.xml` resolves the maven row
  instead. A gradle project's implementers also get gradle self-check commands
  (`./gradlew -q testClasses`), so the tool choice reaches further than this agent. A project with
  **no** JVM build tool gets `runnerAgent ''` and a **general-purpose agent** executing the detected
  command — the runner agents exist to parse mvn/gradle output, and a shell command's exit code
  needs no parser.
  *States it:* `skills/task-run/task-run-implement.workflow.js`,
  `skills/task-review/task-review.workflow.js`
  *Enforced by:* `skills/task-run/task-run-implement.workflow.js`
  *Tested by:* `skills/task-run/tests/control-flow.test.mjs`

- **SB-agent-gradle-build-runner-015** — **It carries no `WebFetch` and no `WebSearch`; the maven
  twin does.** That is the one capability difference between the two documents, and this is the side
  that matches the prose: a build runner told to return one line has no step that reaches the
  network.
  *States it:* `agents/gradle-build-runner.md`
  *Enforced by:* —
  *Tested by:* —

## Prose-only behaviours

Held up by wording alone — no *Enforced by:* and no *Tested by:*. Nothing fails if one quietly
stops being true, which is the class a rewrite can lose in silence. The agent ships no script and
no suite of its own, so 10 of 15 entries:

SB-agent-gradle-build-runner-001, SB-agent-gradle-build-runner-003,
SB-agent-gradle-build-runner-004, SB-agent-gradle-build-runner-005,
SB-agent-gradle-build-runner-006, SB-agent-gradle-build-runner-007,
SB-agent-gradle-build-runner-008, SB-agent-gradle-build-runner-009,
SB-agent-gradle-build-runner-010, SB-agent-gradle-build-runner-015.

**-003** is the one with the most leverage and the least protection: the gradle-only Bash
restriction is what makes this agent's read-only claim structural rather than aspirational, and
nothing at all fails if it is edited away.
