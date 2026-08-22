---
description: >-
  Run server-free static analysis on a JVM project with local CLI analyzers — PMD, SpotBugs +
  find-sec-bugs, and Semgrep — then triage and fix the findings, the same loop as /sonar but with
  no SonarQube server. Use this skill whenever the user wants to "run local-scan", "/r:code-scan",
  "static analysis without sonar", "scan locally", "check the diff with pmd/spotbugs/semgrep",
  "find code smells/bugs/security issues without the server", "any local findings?", "fix the
  static-analysis issues", or wants a fast offline alternative to a SonarQube scan. Also trigger
  when the user complains the SonarQube server is slow and wants the same quality/security/bug
  checks run locally on the changed code, or includes a local static-analysis pass as part of a
  task-completion routine. Supports scanning the current git diff (default), the whole project
  (`ALL`), a specific module/directory or class with no diff at all, an explicit list of classes,
  or the files touched by an already-committed commit or commit range (`--commit <ref>` / `--range
  <A..B>` — e.g. "scan what changed in commit a1b2c3d", "check the last 3 commits", "review
  HEAD~2..HEAD", "look over what landed on this branch since main"). Requires pmd, spotbugs, and
  semgrep on PATH (the skill checks and tells the user how to install any that are missing); no
  server, no tokens, no build-file changes.
---

# Local Static Analysis (server-free)

Run three local analyzers over a slice of a JVM project, merge their findings into one list, and work through the fixes with the user. This is the offline cousin of `/sonar`: same triage-and-fix loop, but nothing talks to a SonarQube server, nothing is uploaded, and the project's `pom.xml`/`build.gradle` are never touched.

The three tools are complementary, which is why all three run:
- **PMD** — source-level code smells and complexity (cognitive complexity, too-many-params, dead code, duplicated literals). Needs only source, runs in seconds.
- **SpotBugs + find-sec-bugs** — bytecode-level real bug patterns (null derefs, resource leaks, broken equals/hashCode) plus a strong security ruleset. Needs compiled classes.
- **Semgrep** — fast pattern-based security and anti-pattern rules from the community registry. Source only.

Each tool is independent: if one isn't installed (or SpotBugs has no bytecode to chew on), the orchestrator skips it with a notice and still returns the others' findings. Partial coverage beats no scan.

## Prerequisites

- `pmd`, `spotbugs`, and `semgrep` should be on `PATH`. Run `"${CLAUDE_SKILL_DIR}/scripts/check-tools.sh"` first — it reports what's present and prints the one-line install command for anything missing (on macOS: `brew install pmd spotbugs semgrep`). The skill still runs with a subset, but tell the user which tools were skipped so they understand the coverage gap.
- The cwd must be a project root with `pom.xml`, `build.gradle*`, or `mvnw`/`gradlew`. SpotBugs needs compiled classes, so the orchestrator runs an incremental compile each run (cheap, and it keeps SpotBugs reading the *current* bytecode rather than stale `.class` files from before your fixes). If the build is broken, **stop and fix the build first** — bug findings on code that doesn't compile are noise.
- `python3` is used to run the orchestrator. No tokens, no env vars, no network except a one-time download of the find-sec-bugs plugin jar (cached under `~/.cache/local-scan/`) and Semgrep's first registry-rule fetch (also cached).

## Workflow

### Step 1: Run the scan

Run `python3 "${CLAUDE_SKILL_DIR}/scripts/local-scan.py"` with the flag matching the user's invocation (see "Invocation arguments"). It scopes the source set, runs each available analyzer, normalizes the three output formats, filters to the in-scope files, and writes `findings.json` plus a printed table:

```
SEVERITY  TOOL      CATEGORY  FILE:LINE                       RULE                MESSAGE
```

The default (`/r:code-scan`, no arg) scans the **git diff** — files changed on the branch plus uncommitted edits — which is what the user wants while iterating. Stream the output to the user.

If the orchestrator reports the build/compile failed, **stop here** and surface it — the rest of the loop is meaningless on code that won't compile.

**Check the run actually succeeded before trusting it — fail closed.** `findings.json` is a structured object: `{status, scope, tools{pmd/semgrep/spotbugs: ran|skipped|errored}, errors[], warnings[], findings[]}`, and the script's **exit code is the source of truth** — `0` = a real scan completed, non-zero = it did not. An empty `findings[]` only means "clean" when `status` is not `error` **and** at least one tool's status is `ran`. So before reporting anything:

- **Non-zero exit / `status: "error"`** (an analyzer `errored`, compile failed against stale classes, or **zero analyzers ran**): this is **not a clean result** — report it as a blocked/incomplete scan (which tool errored, or that no analyzer was available), exactly like the build-failed stop above. Never print "no issues found" on a run that errored or never ran a single analyzer.
- **Per-tool coverage:** name any tool whose status is `skipped` or `errored` so the user knows that category (smells / security / bugs) wasn't covered — don't let a partial scan read as a full pass. The `warnings[]` (e.g. a narrowed scope with no diff base resolved) belong in that same "what wasn't fully covered" note.

### Step 2: Triage and fix

Read the `findings[]` array from `findings.json` (the structured object above) and group findings by file. For each file with findings:
1. Read the file.
2. Apply fixes for all of its findings in one pass.
3. Move to the next file.

Treat the three tools' findings by what they are, not who reported them:
- **Security findings** (`category: security` — mostly find-sec-bugs and Semgrep): fix these first and read carefully. A false positive here is cheap to dismiss; a real one is expensive to miss. If a finding is a genuine false positive (e.g. the "tainted" value is a compile-time constant), say so to the user and move on — don't contort the code to silence a tool.
- **Bug findings** (`category: bug` — SpotBugs): these are usually concrete correctness defects (NPE paths, ignored return values, resource leaks). Fix them directly.
- **Smell findings** (`category: smell` — PMD, some Semgrep): style and complexity. Fix the simple ones inline (unused imports, redundant code, magic literals).

The tool findings define the work list — don't pad it with invented findings (see "What NOT to do"). But static tools have blind spots, and a hardcoded credential or API secret sitting in plain sight (`sk_live_…`, an inline password, a private key) is something a reader catches that a pinned ruleset often misses. If you spot one while editing a file for its real findings, **surface it to the user as your own observation** — say plainly "the scanners didn't flag this, but this looks like a hardcoded secret" rather than silently rewriting it or dressing it up as a tool finding. That's honest review, not a faked scan: the difference that matters is you're not inventing tool output or guessing at issues you haven't seen, you're reporting a concrete thing in front of you.

Some PMD smells are **method-shape** problems — best fixed with a real refactor, not a hand-edit:
- Cognitive complexity ("refactor this method to reduce its Cognitive Complexity").
- Too many parameters.
- Method too long.

Route these to the `/r:code-refactor` skill, which writes a behavior-locking test first and then applies the change — the right shape for this work. Run it once per file that has any of these, after the simple fixes in that file are done. **Skip the refactor and surface to the user instead** if the affected method is on a public API surface (a `*Controller`, a cross-module `*UseCase` port, a public SDK export) — changing that signature ripples beyond the module and the user should decide.

Surface **class-level smells** (god class, too many methods/fields) to the user rather than fixing them — splitting a class changes DI wiring, callers, and tests, so it needs a design conversation.

### Step 3: Codify recurring rules

After fixing, count findings per rule key in the `findings[]` array. **For any rule that hit more than 5 times**, propose a one-line convention for the project's `CLAUDE.md` under a `Code Conventions` section so the same class of issue stops recurring.

- Phrase it as a positive rule the author follows ("Extract repeated string literals into named constants"), not "don't violate rule X".
- **Always ask the user to confirm** the wording before editing `CLAUDE.md`; show the rule and the finding it addresses.
- If there's no `Code Conventions` section, ask before creating one — don't fabricate it silently.

This is the lever that keeps the skill off the treadmill: fix a thing once, write the rule, and the next round shouldn't see it.

### Step 4: Offer a re-scan

When done, offer to re-run the scan so the user sees the cleared list. Don't auto-loop — a re-scan recompiles for SpotBugs and takes a moment.

### Step 5: Record the run

One line into the pack-wide store. This skill is the one `/r:task-review` treats as mandatory on every tier, and it applies its own fixes rather than handing them to triage — so this row is the only place its yield can be read at all. Counts only, never finding text:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:code-scan","scope":"diff|all|filter|files|commit|range","analyzers":["pmd","spotbugs","semgrep"],"analyzersMissing":[],"fixed":0,"changedCode":false,
 "findings":[{"track":"pmd","category":"rule id","severity":"blocker|critical|major|minor","file":"src/Foo.java","line":88,
              "verdict":"confirmed","fixed":true,"description":"one short line"}]}
STATS_JSON
```

`track` is the analyzer that reported it, so the store can say which of the three actually earns its place. Record what you triaged away as `verdict: "dismissed"` — for a static analyzer the false-positive rate *is* the thing worth knowing, and it is invisible in a fixed-count alone.

`analyzersMissing` is what makes a low finding count readable: a scan that ran two of three tools found less because it looked less, and a store that cannot tell those apart will eventually be quoted as evidence the code is clean. Keep each `description` to one line; the payload travels in this step's prompt. The script always exits `0` — a record that does not get written is a lost record, not a failed scan. Never retry it.

### What NOT to do

- Don't add `// NOSONAR`, `@SuppressWarnings`, `@SuppressFBWarnings`, or `nosemgrep` comments to silence findings unless the user explicitly asks. Fix the cause, not the messenger.
- Don't fix findings outside the scope the user asked for. `/r:code-scan` is bounded to the diff; `/r:code-scan <module-or-class>` to that path; only `/r:code-scan ALL` opens the whole codebase. Scope creep makes the change unreviewable.
- Don't mass-edit generated code (MapStruct impls, generated clients). If the scan is picking it up, exclude the generated dir, don't rewrite the files.
- Don't invent findings or "what a scanner would probably say" — only act on what the tools actually reported in `findings.json`. If a tool was skipped (not installed, no bytecode), tell the user that category wasn't covered rather than papering over the gap with guesses.

## Invocation arguments

The user invokes this skill in one of four shapes. Strip a leading `@` and any trailing `/` from path arguments (Claude Code's `@web-adapter/` arrives verbatim).

- `/r:code-scan` — scan and triage **only the changed files** (`--scope diff`, the default). What the user wants while iterating on a branch.
- `/r:code-scan ALL` — scan and triage the **entire project** (`--scope all`). The literal token `ALL` (any case) means full project; lowercase `all` is also accepted.
- `/r:code-scan <module-or-class>` — scope to one argument via `--filter <arg>`. The argument can be a directory (Maven/Gradle module — this is the **"scan a whole module without any diff"** case), a file path, or a bare class name (the orchestrator resolves `FooService` to its source file).
- `/r:code-scan <class-or-file> [<class-or-file> …]` — scope to an explicit **list** via `--files <a> <b> …` (used by `/r:task-review` to clean a branch's changed classes). Fixes all findings in each listed file, not just diff lines.

**Scanning already-committed code (no working-tree diff).** When the user wants to check what a past commit or commit range touched — "scan the files in commit `a1b2c3d`", "check what changed in the last 3 commits", "review `HEAD~2..HEAD`", "look over what landed on this branch since `main`" — use the git-history scopes instead of the default diff:

- `--commit <ref>` — the files touched by one commit (`HEAD`, `HEAD~2`, a SHA, a tag).
- `--range <A..B>` — the files changed across a range (`HEAD~3..HEAD`, `main...HEAD`, `v1.0..v1.1`).

These resolve to the **current working-tree version** of the files that commit/range touched — not the historical file contents — because the point of this skill is to scan *and fix* those files in place, and you can only fix the current version. Files that the commit touched but that no longer exist are skipped. SpotBugs still analyzes the current compiled bytecode, so build first as usual.

If the user passes a bare argument that could be either a class name or a commit-ish (e.g. a short hex string), check git: if `git rev-parse --verify <arg>` resolves it to a commit, treat it as `--commit`; otherwise treat it as a class/module `--filter`. When genuinely ambiguous, ask.

If the user passes anything else, ask before guessing — the shapes above are the supported surface.

## How it differs from /sonar

Reach for `/r:code-scan` when the user wants speed and no infrastructure: a diff-scoped pass with no server round-trip, no upload, nothing committed to the build. Reach for `/sonar` when the user wants the canonical SonarQube ruleset, quality gates, coverage integration, or a result that lands on the shared dashboard. They share the same triage-and-fix loop, so it's fine to use `/r:code-scan` for the inner-loop iteration and `/sonar` for the gate before merge.
