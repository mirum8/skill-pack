---
topic: skill-pack-repo
scope: new-service        # new repo, but payload is 15 existing skills — repo-read rules applied
depth: standard
status: generated
---

## Coverage

- users-and-job: answered — one maintainer, their own machine; today the 15 skills are loose directories
  under `~/.claude/skills/` with no namespace, no repo and no way to move them to a second machine
- core-flow: answered — clone → copy → restart → `/r:<skill>` resolves; the pack is read at session
  start and never installed in the package-manager sense (`ADR-1`)
- scale: **n/a** — 15 markdown skills + 8 agent files read from disk at session start. No throughput,
  no concurrency, no growth curve, no capacity dimension. The one quantity that genuinely constrains
  the design is the always-on description budget, measured at 15,186 chars and fixed as `NFR-1`.
  Asking "how many requests or machines" here would be reciting a checklist at a directory of markdown.
- data: answered — the manifest and frontmatter schemas *are* the data model
- stack-and-constraints: answered for language, storage, hosting. **Deadline and team size n/a** —
  one maintainer, and no schedule is in this spec's scope (`/spec-to-todo` owns phasing).
- distribution: answered *(round 3)* — private now, public later
- anti-scope: answered — 7 non-goals
- v1-line: answered *(round 3)* — eval suites join v1; everything else deferred
- integrations: answered — codex plugin, bundled skills, CLI binaries
- failure-behaviour: answered — full error taxonomy; every failure mode is silent by default
- operations: answered *(round 3)* — local pre-push validation script
- rollout: answered *(round 3)* — permanent dual-run, originals never deleted
- integrations / external dependencies: **re-opened and re-answered *(round 4)*.** Round 3 recorded this
  as settled when it had only been *inferred* from the v1-cut answer. Now genuinely answered: two tiers
  (`ADR-16`) — `code-scan` binaries + `agent-browser` mandatory and installer-provisioned, `codex`
  optional and degrading to a reported skip.

Every row settled. No open questions remain.

**Round 4 changed four things that were recorded as settled but were not:** one assumption was false
(install-path independence), one requirement specified work that already existed (`FR-15`), one coverage
row had been inferred rather than asked (external dependencies), and one security control was stated in
terms the design no longer honours (`install.sh` "only clones and prints"). A ledger row saying
*answered* is not evidence that it was asked.

## Verified facts (read 2026-07-30)

### Distribution mechanism
- Plugin `name` is the skill namespace. `my-plugin/skills/review/SKILL.md` → `/my-plugin:review`.
  [verified: https://code.claude.com/docs/en/skills, read 2026-07-30]
- **Skills-directory plugin**: any folder under a skills dir containing `.claude-plugin/plugin.json`
  loads as `<name>@skills-dir` — "with no marketplace and no install step… discovered in place rather
  than copied into the plugin cache." So `~/.claude/skills/r/` + `{"name":"r"}` → `/r:<skill>`.
  [verified: https://code.claude.com/docs/en/plugins-reference, read 2026-07-30]
- `plugin.json` is optional for marketplace plugins but **required** for skills-dir detection.
  [verified: plugins-reference, read 2026-07-30]
- Personal scope (`~/.claude/skills/`) loads in every project with no trust gate; project scope
  (`<cwd>/.claude/skills/`) requires the workspace trust dialog and blocks background monitors.
  [verified: plugins-reference, read 2026-07-30]
- Editing a skill's `SKILL.md` takes effect immediately; changing `hooks/`, `agents/`, `.mcp.json`
  needs `/reload-plugins`. [verified: plugins-reference, read 2026-07-30]
- `claude plugin validate .` checks plugin.json / marketplace.json schema.
  [verified: plugin-marketplaces, read 2026-07-30]
- Reserved marketplace names do not include `r`. [verified: plugin-marketplaces, read 2026-07-30]
- mattpocock/skills uses `skills/<category>/<name>/`, kebab-case, no prefix; offers plugin install
  *and* `npx skills@latest add`. [verified: https://github.com/mattpocock/skills, read 2026-07-30]

### SKILL.md frontmatter — the COMPLETE field list

An earlier pass this session extracted this table with a grep filtered to field names already
expected, and therefore **missed eight real fields**. Corrected, in full:

| field | required | notes |
|---|---|---|
| `name` | No | Defaults to the directory name |
| `description` | Recommended | What the model reads to decide whether to load the skill |
| `when_to_use` | No | **"Appended to `description` in the skill listing and counts toward the 1,536-character cap."** |
| `argument-hint` | No | Autocomplete hint |
| `arguments` | No | Named positional args for `$name` substitution |
| `disable-model-invocation` | No | Blocks auto-load, subagent preload, and scheduled-task firing |
| `user-invocable` | No | `false` hides it from the `/` menu |
| `allowed-tools` | No | Pre-approved tools for the invoking turn |
| `disallowed-tools` | No | **Tools removed from the pool while the skill is active** |
| `model` | No | Model override for the turn |
| `effort` | No | `low` … `max` |
| `context` | No | `fork` runs it in a subagent |
| `agent` | No | Subagent type when `context: fork` |
| `background` | No | Only with `context: fork`; requires Claude Code v2.1.218+ |
| `hooks` | No | Hooks scoped to the skill's lifecycle |
| `paths` | No | **"Glob patterns that limit when this skill is activated… Claude loads the skill automatically only when working with files matching the patterns."** |
| `shell` | No | `bash` (default) or `powershell` |

[verified: https://code.claude.com/docs/en/skills, read 2026-07-30]

- **`version` is not a field.** Absent from the frontmatter table, and the skills doc carries no
  "unrecognized fields are ignored" clause (that clause exists only for `plugin.json`). The doc's only
  `version` mentions are `node --version`, eval version-comparison, and "commit to version control" —
  all unrelated. This **resolves the former OQ-1 by lookup**: drop it.
  [verified: skills docs, read 2026-07-30]
- Two missed fields are directly useful and are recorded as **deferred** requirements rather than
  silently adopted: `paths` (scope `tests-write` / `code-scan` to JVM globs) and `disallowed-tools`
  (make `code-bugs` / `code-quality` genuinely unable to edit rather than merely promising not to).

## Source-skill inventory (read from ~/.claude/skills, 2026-07-30)

| skill | SKILL.md | extra files | frontmatter |
|---|---|---|---|
| commit | 7.1 KB | evals/evals.json | version 1.1.0, effort medium |
| brainstorm | 10.4 KB | 5 references, 1 script, evals, 380 KB vendored html-effectiveness | model opus, effort xhigh, no version |
| fix-gh-issues | 33.4 KB | none | version 1.5.0, effort xhigh |
| claudemd-compact | 17.6 KB | 2 references | version 2.1.0, effort medium |
| write-tests | 17.3 KB | 1 reference | none |
| claudemd-patch | 17.3 KB | none | version 2.2.0, effort low |

Measured defects in the source skills:
- `run-task` description is **2,174 chars against a 1,536 cap** — 638 chars, including its
  `--light/--standard/--full` triggers, never reach the model. It under-triggers today, invisibly.
- `spec-to-todo` frontmatter **fails strict YAML** — bare scalar containing `Stack-agnostic: it follows…`.
- **678 raw** occurrences of old skill names, of which only **309 are references**; `commit`×101 and
  `refactor`×61 are mostly ordinary English. A blind `sed` would corrupt 369 lines of prose silently.
- Two committed `__pycache__/*.pyc` under `post-task-review/scripts/`.
- Always-on listing cost: **15,186 chars ≈ 3,796 tokens** (sum of per-skill `min(len, 1536)`).

Reference counting used two methods that do not agree — keep them apart:
- **Raw `/name` count** (every slash mention, including "NOT for:" routing pointers):
  fix-gh-issues → `/run-task`(14), `/post-task-review`(7) · brainstorm → `/spec-to-todo`(7)
- **Positive-usage count** (excludes "NOT for / instead of / rather than" lines — the real coupling):
  fix-gh-issues → run-task **12**, post-task-review **8** · post-task-review → local-scan **22**

The spec quotes the **positive-usage** figures. Raw figures appear only where total rewrite workload is
counted, because a routing pointer still has to be rewritten.

`-workspace` dirs (commit-workspace, brainstorm-workspace, …) are skill-creator eval scratch — not pack content.

## Answers

### Round 0
- **Depth** — standard.
- **Not a plugin store** — no marketplace publication. Resolved to a skills-dir plugin, which needs
  neither a marketplace nor an install step.

### Round 1
- **Naming convention** — domain-first: `<domain>-<action>`, kebab-case, ≤3 segments. Chosen because
  the `/` menu sorts alphabetically, so families cluster once the pack grows.
- **Dependency handling** — expand the pack. The round-1 multiple-choice pick ("document as
  prerequisites") was overridden by the user's own text: "i need the fix-gh-issues skill in the pack
  and all skills it uses; they can be used separatelly; also i need /spec-to-todo skill there".
  Explicit text wins over the earlier pick.
- **"Nested skills"** — meant *include the dependencies as skills*, not sub-skills. "They can be used
  separately" → flat `skills/<name>/`, every skill independently invocable. The `references/` split of
  `gh-issues-fix` was therefore **never requested**.
- **Repo contents** — evals harness YES · vendored html-effectiveness YES · install script YES ·
  CI `claude plugin validate` NO.

### Round 2
- **Pack boundary** — 14 skills, then `create-test-app` added mid-turn → **15**.
- **Agents** — widened by "all needed agents needed in /run-task" to the full dispatch union → **8**.

### Round 3 (`--continue`)
- **Visibility** — **private now, public later.** The pre-publish secret audit is not avoided, only
  deferred to the flip; recorded as a rollout gate so the flip cannot quietly skip it.
- **Cut-over** — **keep both copies indefinitely.** The 15 flat originals are never deleted. I argued
  against this once and conceded; the risk survives as `R-4`, with `ADR-13` recording the accepted
  trade-off. Consequence: rollout loses its point of no return entirely, so rollback stays trivial
  forever, and the cost moves to permanent duplicate-edit exposure.
- **Operations** — **local pre-push validation script.** This is what `ADR-10` previously claimed as
  mitigation with nothing confirming it; now a required deliverable (`FR-17`).
- **v1 additions** — **eval suites for all 15 skills join v1** (`FR-11` promoted to must).
  `paths`/`disallowed-tools` (`FR-18`), runtime prerequisite checks (`FR-15`), and the
  `gh-issues-fix` split are all deferred to v2.

### Round 4 (`--continue`, second resume)

Opened by resolving the four `Assumed — not confirmed` lines rather than by asking anything. Three were
lookups; one of those came back **false**, which is what this round was actually for.

- **Claude Code version** — confirmed by `claude --version`: **2.1.220**. Clears every floor the spec
  relies on (`displayName` 2.1.143+, `${CLAUDE_SKILL_DIR}` in `allowed-tools` 2.1.129+, `background`
  2.1.218+). Assumption deleted, fact recorded.
- **"No packed skill depends on its install path"** — **disproved.** 42 hard-coded absolute references
  across 12 files in 7 skills: `post-task-review` ×25, `run-task` ×8, `adversarial-review` ×8,
  `find-bugs` ×1. Split 26 self / 16 cross-skill. This is *how* the two flagship skills invoke their own
  pipelines, so it is structural. Became `FR-19`.
  - The spec's stated mitigation (`${CLAUDE_SKILL_DIR}`) was **correct but insufficient** — it is "the
    skill's subdirectory within the plugin, not the plugin root", so it cannot reach a sibling. Cross-skill
    refs need `${CLAUDE_PLUGIN_ROOT}/skills/<name>/…`. Both substitute in skill markdown content.
  - Worse, `post-task-review/scripts/guard-workflow.py` — registered globally at
    `~/.claude/settings.json:159` — allow-lists two literal paths and blocks by *content*: any workflow
    script whose `meta` block declares either guarded pipeline name, from any other path, is refused, and
    its `Write`/`Edit` branch refuses to create one. The packed copies could neither run **nor be built**.
    Became `FR-20`.
- **Install shape** — user chose **clone then symlink, user scope**. `ADR-11` amended: scope decision
  unchanged, mechanism refined. Symlinked *skill* entries are documented and two are already in use here;
  symlinked *plugin* discovery is not documented either way → `R-10`, the spec's highest-rated risk,
  confirmable in one command at first install.
  - **Superseded at implementation (round 5, below): the install copies instead.**
- **Research fan-out** — user chose to **keep it as recorded**. The honesty note stands verbatim.

**Then the user pushed back: "we didn't discuss about external dependencies as codex and local scan
utils."** Correct, and the notes were wrong to imply otherwise — the previous round recorded
"how is the codex prerequisite surfaced?" as answered, but it had been *inferred* from the v1-cut answer,
never asked. Reading the skills first changed the question:

- Three of four dependency families **already preflight themselves**, at the moment of need, better than
  any install-time check: `local-scan/scripts/check-tools.sh` (names each analyzer, prints its install
  line, runs on a subset while reporting uncovered categories), `fix-gh-issues/SKILL.md:53`
  (`command -v gh && gh auth status`, hard gate), `adversarial-review/scripts/run.sh:54` (exit 3, and
  `SKILL.md:83` forbids substituting an imitation). So `FR-15` was specifying work that largely existed.
- `agent-browser` was the **only** unguarded dependency, and it is reachable from the pack's own pipeline
  via `task-review → bug-hunter-ui → /test-app`, where UI verification is "Mandatory whenever UI is in
  scope". Its target turned out to be a **2.8 KB discovery stub** (`vercel-labs/agent-browser` per
  `~/.agents/.skill-lock.json`); the real dependency is the CLI (0.26.0) plus a browser engine.
- **User's answers:** codex **skippable** if absent; `code-scan` binaries and `agent-browser`
  **mandatory, installed during the main installation**; `FR-15` **promoted to v1 with a preflight
  script**. → `ADR-16`, `FR-15` rewritten, `FR-21`, `FR-22`.
- **Decided rather than asked:** `agent-browser` is installer-provisioned, **not vendored** — vendoring a
  pointer would still leave the CLI to install, while adding 925 chars to `NFR-1` and `ADR-9` licence
  work. Recorded as an assumption the user can overrule in one line.
- **Concern raised once, not overruled, not repeated:** making codex skippable is a *behaviour* change,
  which `ADR-12`/`ADR-14` bar from the rename diff, and `task-review`'s two encodings must change
  together behind the very guard `FR-20` ships. Recorded as `R-11`, not re-argued.
- **Second-order consequence the user did not have to point out:** `install.sh` now runs package-manager
  commands, contradicting the spec's own security control that it "only clones and prints", and coupling
  install to Homebrew/macOS → `R-12`, plus `--dry-run`/`--no-deps`. And `NFR-2`'s "under 60 seconds"
  silently became false, so it was narrowed to the repo and `NFR-8` added — **explicitly unmeasured**
  rather than guessed, since no cold `brew install` was timed this session.

**The guard blocked this very file mid-write.** Drafting the paragraph above with the two guarded
pipeline names quoted in their `meta` form tripped `guard-workflow.py`'s `Write`/`Edit` branch — an edit
to a *documentation* file in an unrelated repository. That is a false positive with real consequences for
this project: the pack's own spec, README and notes cannot quote the guarded names in that form, and
neither can a build script that rewrites them. `FR-20` therefore has to narrow the match to actual
workflow scripts, not any file containing the string. Recorded because it was observed, not predicted.

Versions read this session, recorded as tested-against rather than floors: pmd 7.26.0 · spotbugs 4.10.2 ·
semgrep 1.168.0 · gh 2.96.0 · codex-cli 0.146.0 · node v26.4.0 · agent-browser 0.26.0 · Claude Code 2.1.220.

**User asked whether the local (non-marketplace) plugin system could be used.** It already is — `ADR-1`'s
skills-directory plugin *is* that mechanism. But reading `code.claude.com/docs/en/plugins` for the answer
turned up one route the spec had missed, and it is the more useful half of the answer:

- **`claude --plugin-dir <repo>`** loads a plugin "directly without requiring installation", for one
  session, touching nothing on disk. That splits `R-10` — the spec's highest-rated risk — into two
  distinguishable failures. Previously the only check was `claude plugin list` after installing, and a
  malformed manifest and an unfollowed symlink both present identically, as a namespace that just is not
  there. Now: `--plugin-dir` first (proves manifest + namespace + layout), symlink and `plugin list`
  second (proves discovery). `R-10`'s detection plan, the maintainer-commands table, the error taxonomy
  and the diagram's install flow were all updated to run them in that order.
- Also confirmed why the cache/in-place distinction matters here: marketplace installs copy into the
  plugin cache, skills-dir plugins are "discovered in place". Editing a cached copy would do nothing —
  which is the mechanism behind `NFR-3`, previously stated as behaviour without its cause.

**A correction that went the other way.** Reviewing this, I told the user `FR-20` was wrong to say the
hook is declared in `plugin.json`. It was not: the reference gives the location as "`hooks/hooks.json` in
plugin root, **or inline in plugin.json**". Both are valid, so this was a choice presented as an error.
`FR-20` now names `hooks/hooks.json` and says why — keeping `plugin.json` to identity alone, so that the
file `R-5` calls the single point of failure does not also carry executable wiring whose syntax errors
would take the namespace down with it.

### Round 5 (implementation)

One decision from the user, and five things the build found that the spec had wrong or missing.

- **Install shape, again — the pack is COPIED, not symlinked.** User: "the git repo shouldnt be
  symlinked; install should copy/rewrite the skils". The rename and reference rewrite still happen once
  at build time; `install.sh` is a pure copy that overwrites. `ADR-11` amended a second time.
  - This **deletes `R-10`**, which was the highest-rated risk in the spec, and it deletes it rather
    than mitigating it: a plain directory holding `.claude-plugin/plugin.json` is the documented
    skills-dir case, so the undocumented behaviour is simply no longer relied on.
  - It also **resolves process note 10** — the pack now uses no symlinks anywhere, so the prior-art
    rejection of a symlink farm no longer sits next to a symlink install.
  - What it costs is §14's "the working clone *is* the installed pack", which was true only while the
    two were one directory. They are now two copies, so publishing takes a step and a stale install is
    possible. `R-10` was **rewritten in place** to carry exactly that, keeping the id count at 63 with
    no gaps.

**Found by building it, not by reading:**

1. **The bounded rewrite was not bounded enough, three times over.** `BR-3`'s four patterns are right in
   principle and wrong as literally specified. `/name` matched `.claude/skills/post-task-review/` (a
   path, `FR-19`'s job) and English "or" slashes — `compact/refactor/reorganize`, `branch/commit/PR`.
   `` `name` `` rewrote the Conventional Commit **type** list in `git-commit/SKILL.md`, whose literal
   text is "`refactor` — code change that neither fixes a bug nor adds a feature". And in `.mjs` files a
   JS **regex literal** opens with `/`, so `assert.match(p, /code-quality did NOT run/)` became
   `/r:code-quality did NOT run/` while the workflow text it matches stayed bare — a test that still
   ran and no longer checked anything. All three are now excluded by rule. **`R-1` was real, and the
   thing that caught it was reading the report and running the packed tests, not the rewrite passing.**
2. **The reference counts in the spec do not reproduce.** `FR-4`/`NFR-5` assert exactly 309 rewrites and
   369 untouched prose occurrences; measuring the actual tree gives 778 raw and 368 pattern-bounded
   across 56 files, and the build applies **318**. The spec's figures came from a narrower file set.
   Asserting them would fail on a correct build, so the validator checks the invariant that cannot be
   satisfied by accident — **zero un-prefixed references survive anywhere in the pack** — and reports
   the prose counts for the `R-1` hand review instead of asserting them.
3. **`${CLAUDE_PLUGIN_ROOT}` does not reach inside a workflow script.** It substitutes in skill markdown
   and in `allowed-tools` Bash rules. The 12 absolute paths in the two `*.workflow.js` files sit in bash
   strings handed to subagents, where nothing would expand it. `FR-19` says to use the variable and does
   not say this. The pack root is passed as `args.packRoot` from the SKILL.md that invokes the workflow
   — markdown, so the placeholder resolves there — and the script falls back to the literal placeholder
   rather than an empty string, because an empty root turns every sibling path into a plausible-looking
   `/skills/…` that points nowhere.
4. **`FR-19` has a third case the spec does not name.** Beyond self and cross references there are
   *project-relative* paths — `.claude/skills/test-app/…`, the target project's generated skill, not an
   install path. Rewriting those would be a bug. And `create-test-app`'s template becomes a
   **project-local** skill, where `${CLAUDE_PLUGIN_ROOT}` does not resolve at all, so it carries a
   `{{WTD_PATH}}` placeholder the generator substitutes — the same mechanism it already uses for
   `{{CREDS_PATH}}`.
5. **A dangling reference nobody had noticed.** `agents/bug-hunter.md` points at `/find-bug`, which has
   never existed — the skill is `find-bugs`. `FR-9` allows none, and the validator found it.

**Cut-over (same day, after the install):** the user asked for the flat originals to be removed once
they were backed up. That **reverses `ADR-13`** — the round-3 decision to keep both copies permanently,
which I argued against once, conceded, and recorded as `R-4` at severity H precisely because the
exposure never closed. It closes now.

- `~/.claude/skills` (all 55 dirs), `~/.claude/agents` and `settings.json` were archived to
  `~/.claude-backups/`, and the archive was **verified by extracting it and diffing against the live
  tree** before anything was deleted — including that the two symlinked entries stayed symlinks.
- Only the **15 packed** skills were deleted. The other 40 are not in the pack; deleting those would
  lose them outright.
- Directly observed afterwards: `/r:` resolves all fifteen with the originals gone, `/commit` resolves
  to nothing, `claude plugin list` still shows `r@skills-dir`.
- **The dual-run is what made this safe**, which is worth recording in favour of a decision I had
  argued against: the pack ran beside the originals until it demonstrably worked, so the cut-over was
  a decision made on a working machine rather than a bet. The right criticism of `ADR-13` was never
  "dual-run is wrong", it was "permanent is wrong" — and permanent is what got reversed.
- `FR-17`'s drift check was built entirely on `ADR-13` and failed **79 times**, once per deleted file,
  the moment the originals went. It now treats a wholesale deletion as the cut-over having happened
  and reports `R-4` closed; a *partial* deletion is still a failure, because a half-present twin is
  exactly the ambiguous state the check exists to catch.

**Decided while implementing, not asked:**

- The **`R-4` drift check cannot work as specified.** "Diff each original against its packed twin, only
  the name and its references differing" fails immediately, because v1 deliberately changes more than
  the rename — `FR-7`, `FR-8`, `FR-10`, `FR-13`, `FR-16`, `FR-19`, `FR-20`, `FR-22`. It hashes the flat
  originals against a baseline taken at build time instead, which detects what `R-4` actually is: an
  edit that landed in the wrong copy.
- **`build-pack.py` is a one-shot.** It regenerates `skills/` from the originals, so re-running it would
  destroy everything the pack owns and the originals do not — the thirteen new eval suites, first. It
  refuses to run over an existing `skills/` without `--force`. The pack is the source after the first
  build, which is what §6 already says.
- **Bare old names in log strings are left alone.** `task-review` logs `local-scan BLOCKED` and prefixes
  its logs with `post-task-review:`. Those are prose under `BR-3`, and `ADR-12` keeps prose out of the
  rename diff. Cosmetic, and deliberate.

## Rename table — 15 skills, domain-first

| old name | new name | family |
|---|---|---|
| commit | `git-commit` | git |
| brainstorm | `spec-brainstorm` | spec |
| spec-to-todo | `spec-plan` | spec |
| fix-gh-issues | `gh-issues-fix` | gh |
| claudemd-compact | `claudemd-compact` (unchanged) | claudemd |
| claudemd-patch | `claudemd-patch` (unchanged) | claudemd |
| write-tests | `tests-write` | tests |
| run-task | `task-run` | task |
| post-task-review | `task-review` | task |
| local-scan | `code-scan` | code |
| find-bugs | `code-bugs` | code |
| code-quality | `code-quality` (unchanged) | code |
| refactor | `code-refactor` | code |
| adversarial-review | `code-adversarial` | code |
| create-test-app | `test-app-create` | test-app |

Families after sort: claudemd ×2 · code ×5 · gh ×1 · git ×1 · spec ×2 · task ×2 · test-app ×1 · tests ×1.

## Agents to ship (8) — dispatch evidence

| agent | dispatched by |
|---|---|
| bug-hunter | post-task-review ×2 |
| bug-hunter-ui | post-task-review ×10 |
| bug-hunter-security | post-task-review ×4, find-bugs ×1 |
| bug-hunter-docs | post-task-review ×1, find-bugs ×1 |
| maven-build-runner | run-task ×3, post-task-review ×5 |
| gradle-build-runner | run-task ×2, post-task-review ×4 |
| java-backend-developer | run-task ×1, post-task-review ×1 |
| htmx-thymeleaf-dev | run-task ×1 |

Not shipped: `code-reviewer`, `comment-cleaner` (no packed skill dispatches them). `general-purpose`
is built into Claude Code and needs no vendoring.

## Excluded from the pack, with evidence

| excluded | why | evidence |
|---|---|---|
| html, html-diagram, html-plan (1.2 MB) | brainstorm forbids calling them | `brainstorm/SKILL.md:163` "Never call `Skill(html-diagram)`, `Skill(html)` or `Skill(html-plan)` — all three are user-invocable only and the call fails" |
| sdd-idea, sdd-impl, sdd-feature, sdd-change, sdd-undo | reached only through "NOT for:" routing pointers, never called | brainstorm description "NOT for SDD repos with PROJECT.md (/sdd-feature)" |
| sonar | comparative reference, not a dependency | `local-scan/SKILL.md:9` "This is the offline cousin of `/sonar`" |
| htmx | reached only via sdd-idea, itself excluded | closure walk |
| test-app | generated per-project by `test-app-create`; vendoring one copy would ship one repo's stack assumptions everywhere | `create-test-app/SKILL.md:17` |

## External prerequisites — cannot be vendored

- `codex` plugin from the `openai-codex` marketplace — `code-adversarial` shells out to
  `codex:adversarial-review` and `codex:review`. A skills-dir plugin has no dependency declaration
  mechanism, so this is README-only in v1.
- Bundled Claude Code skills `/security-review` and `/simplify` — referenced by `claudemd-patch` and
  `task-review`; present by default, nothing to ship. [verified: absent from ~/.claude/skills, 2026-07-30]
- `agent-browser` skill — a **symlink** to `~/.agents/skills/agent-browser`, outside `~/.claude`.
  Used by the `test-app` skill that `test-app-create` generates.
- CLI binaries: `pmd`, `spotbugs`, `semgrep` (`code-scan`), `gh` (`gh-issues-fix`), `codex`.

## Assumptions (not confirmed)

- Install is `git clone <repo> ~/.claude/skills/r` at **personal** scope, so the pack loads in every
  project with no trust dialog. Breaks if: a per-project checkout is wanted, which hits the
  project-scope trust gate and silently drops background monitors. Confirm with: first install.
- No packed skill depends on living at `~/.claude/skills/<name>`; skills should use
  `${CLAUDE_SKILL_DIR}`. Breaks if: a script resolves the wrong path once nested in a plugin.
  Confirm with: grep the 82 files for hard-coded `.claude/skills` paths during the build.
- Claude Code stays at v2.1.143+ (for `displayName`). Breaks if: older — cosmetic only.
- Research ran as **serial web lookups, not the standard-depth 3-agent parallel fan-out**, because this
  session's CLAUDE.md forbids subagents. Narrower prior-art coverage than standard depth normally gets:
  one comparable repository read, no field survey. No vendor-pricing or liveness sweep was performed
  because the pack has no third-party runtime dependencies.

## Open questions

**None.** All six the previous run filed are closed. Their ids are deliberately not reused below — a
closed question does not need an identifier, and keeping one invites it being read as still open:

| was | resolution |
|---|---|
| Does `version:` do anything? | **Resolved by reading, not asking** — absent from the documented field list and from the whole skills doc. Drop it (`FR-10`). |
| Delete the originals at cut-over? | Answered round 3 — never delete; permanent coexistence (`ADR-13`) |
| How is the codex prerequisite surfaced? | Answered round 3 — README-only in v1; runtime check (`FR-15`) gated on the public flip |
| Split `gh-issues-fix`? | Answered round 3 — deferred to v2 (`ADR-12`) |
| Evals for the other 13? | Answered round 3 — **yes, in v1** (`FR-11` promoted to must) |
| Public or private? | Answered round 3 — private now, public later; the audit becomes a gate on rollout step 7 |

## Process notes — what the previous run got wrong

Recorded because it is the most useful thing in this file for anyone reviewing how the spec was made.

1. **`status: generated` was dishonest.** Four coverage rows were open and six answerable questions
   were filed as open questions. The correct value was `generated-partial`.
2. **No `## Coverage` ledger existed**, which is why the open rows were invisible on review.
3. **The generate-or-continue choice was never offered** at the end of any round.
4. **Six open questions off seven questions asked.** `references/interview.md` §8 names that ratio as
   the signature of an under-interviewed spec, and names three of these six as examples of questions
   that should simply have been asked.
5. **The frontmatter extraction was filtered to expected field names** and missed eight real fields,
   two of which (`paths`, `disallowed-tools`) are directly useful and one of which (`when_to_use`)
   makes the description-cap rule wrong as originally written.
6. **This file was corrupted** — a malformed tool-call block appended a stray `AskUserQuestion`
   payload into the document body. Truncated 2026-07-30.
7. **Round 3 opened with two noise questions** — "how many machines" and "is there a deadline" — both
   coverage-floor rows recited at a project with no such area. Rejected by the user, correctly. Those
   rows are recorded as `n/a` with reasons in the ledger above instead.
8. **Round 3 marked the external-dependency row answered without asking it.** The resolution table said
   "how is the codex prerequisite surfaced? — answered round 3", but no such question was put; the answer
   was derived from the v1-cut answer and written up as if it had been given. The user caught this in
   round 4 with "we didn't discuss about external dependencies". *Deriving* an answer is legitimate;
   *recording it as the user's* is not, because it removes the one signal that would have prompted the
   question later.
9. **`FR-15` specified work that already existed.** Three of the four dependency families ship their own
   preflight, and better ones — they fire at the point of use and can say which coverage was lost. Nobody
   had read them. The lesson generalises: before requiring a behaviour, check whether the code already
   has it, or the spec sends a builder to re-implement something and call it new.
10. **A rejected option came back as the chosen mechanism.** The prior-art table dismissed a "symlink
    farm" as fragile, and round 4 then adopted a symlink install. **Resolved in round 5 by dropping
    symlinks altogether**, but the lesson survives the resolution, because it is what made the
    contradiction visible in the first place. The two were genuinely different — one
    link to the pack root versus fifteen links bypassing the manifest — but the spec said neither until
    the contradiction was noticed and written down. Prior-art verdicts need re-reading whenever a
    decision moves.
11. **The guard hook blocked an edit to this file.** Documenting the guarded pipeline names in their
    declared form tripped the very hook the spec had just required the pack to ship. It is recorded in
    `FR-20` and the error taxonomy as an over-match to fix, and it is the strongest evidence in this
    whole document that the path-dependency finding was real rather than theoretical — the mechanism
    demonstrated itself, unprompted, on an unrelated repository.

## Verification run 2026-07-30

`check_spec.py docs/skill-pack-repo/` reports 2 problems, **both false positives**: it buckets ids by
digit-string length, so `FR-1`…`FR-9` alongside `FR-10`…`FR-18` trips its zero-padding heuristic. A
direct grep for `(FR|NFR|ADR|BR|R|OQ)-0[0-9]+` returns nothing — all ids are unpadded as required.

Contract checks that pass: `spec.html` has zero `<script>` tags and zero dark-theme artefacts; no
palette bleed in either direction; `architecture.html` has no hard-coded hex inside `<svg>`, no FLOWS
edge or node missing from the markup, no edge label pointing at a missing edge, marching-ants offset
12 = dash 7 + gap 5, `min-height: 0` on `.stage`, theme script before `<style>`, and
`<title id="arch-title">` as the first SVG child.

**Not verified:** the two checks that need a browser — overlapping rects, and whether any node sits
behind the always-visible `#detail` card in the bottom-right. Geometry keeps `x > 1050, y > 460` clear
for that card, but this was never rendered.

## Verification run 2026-07-30 (round 4)

`check_spec.py docs/skill-pack-repo/` → **clean**, with no false positives this time. The earlier
zero-padding complaint is gone; the run also caught one real defect — the `users-and-job` coverage row
recorded a verdict with no evidence — which is now filled in.

Id integrity: 63 ids, `FR-1..22` · `NFR-1..8` · `ADR-1..16` · `BR-1..5` · `R-1..12`, **no gaps, no
dangling references, no zero-padding**. Every id referenced in the prose is defined.

Contract checks re-run and passing: `spec.html` has zero `<script>` tags and zero dark-theme artefacts;
no palette bleed in either direction; `architecture.html` has no hard-coded hex inside `<svg>`, every
`FLOWS` edge and node present in the markup, every node has a `DETAIL` entry and vice versa, theme script
before `<style>`, `<title id="arch-title">` first SVG child.

**The two previously-unverified checks are now closed** — and computed from coordinates rather than
eyeballed, which is stronger for this particular pair. All 25 node rects: **zero overlaps**, nothing
inside the `#detail` keep-out (`x > 1050, y > 460`), nothing outside the 1560×980 viewBox, and no node
escaping its zone after `z-repo` was extended to fit `hooks/` and `z-ext` to fit the taller prerequisite
boxes.

Text-fit was also estimated per box. Four labels exceed their box by 1–40 px under a deliberately
conservative monospace advance — `manifest`, `listing` ×2 and `router`. **All four are pre-existing and
unchanged by this round**; the three labels that round 4 introduced and that genuinely overflowed
(60–80 px, well past estimator error) were rewritten and now fit. Still not rendered in a browser, so
the four inherited ones stay flagged rather than declared fine.
