# post-task-review — the prose pipeline (Steps 0–9)

This is the **authoritative spec** of the review pipeline, and the **fallback engine** for it.

**You almost certainly should not be reading this file.** In the main thread the pipeline runs as
the deterministic `task-review.workflow.js` via the `Workflow` tool, and that script — not this
prose — is what executes. Read this file only in the one case SKILL.md sends you here: a main
thread that has `Agent` but **no** `Workflow` (a headless/cron context). Then run Steps 0–9 below by
hand, in order. They are binding, not best-effort.

The two encodings describe the same graph and **must change together**: editing one without the
other silently makes the two engines diverge.

## Contents

| Step | What it does |
|---|---|
| 0 | Triage — is a review even owed? Tier, `uiTouched`, `securitySurface` |
| 1 | Detect the build tool; answer the `/test-app` gate |
| 2 | One parallel review pass (report-only): Codex, hunters, `/r:code-quality` |
| 3 | Triage once, intent-aware, into a single fix-list |
| 4 | Fix everything once, **serially**: correctness → domain subagent, *then* readability → `/r:code-refactor` |
| 5 | Build with tests |
| 6 | `/r:code-scan` on the changed classes, then rebuild if it wrote code |
| 7 | End-verify: one bounded Codex review of the final diff |
| 8 | UI / runtime verification — only when `uiTouched` and `/test-app` exists |
| 9 | Record learnings, keep CLAUDE.md lean, log the run |
| — | **Non-negotiables** (between Steps 8 and 9 — they govern both engines) |

---

## Step 0 — Triage: is a review even owed?

Run `git diff --name-only` (working tree) and, if there are staged changes, `git diff --cached --name-only`.

**First, make untracked source files visible to the diff.** `git diff` shows nothing for a file git has never seen, and every diff-scoped track downstream keys off it — `/security-review` strictly so. Without this, a brand-new controller gets *zero* review and the run still reports clean:

```bash
git add -N <untracked source files>   # intent-to-add: stages no content, reversible with `git reset`
```

Then classify what changed:

- **No-review set** — `*.md`, `*.txt`, `*.adoc`, `*.rst`, `docs/**`, `LICENSE`, `.gitignore`, images/assets, and pure-text editor config. If **every** changed file is in this set → print `post-task-review: doc/config-only diff, nothing to review` and **stop**. This is the doc-only / config-only skip.
- **Review-required set** — anything else: source (`*.java`, `*.kt`, `*.sql`), build files (`pom.xml`, `*.gradle*`), runtime config (`*.yml`, `*.yaml`, `*.properties`). If any changed file is here → continue.

A comment-only or formatting-only edit inside a source file still counts as review-required. That's intentional: the cost of a needless review is small; the cost of skipping a needed one is a shipped bug. When unsure, review.

**Classify the review tier.** If the caller passed a `profile` or the user gave a `--light`/`--standard`/`--full` flag, honor it. Otherwise classify from the diff — you have it in front of you, so judge what the change *does*, not what the files around it happen to contain. Three questions, in order:

1. Can the change alter behavior for any real input? No → **light** (a getter, a constant/config value, a log message, a rename, formatting, a comment, a cosmetic template/CSS tweak).
2. Does it carry a design decision — a new or changed approach, several seams, a data model or contract — or does it add or alter auth/permissions, money/pricing/tax math, persistence (a schema change, migration or index; locking or transaction semantics), concurrency/locking, or security-sensitive code? No → **standard** (a bug fix inside one method, a two-line null check, a new field plus its mapping, a new endpoint over an existing service, a new read-only query over an existing table).

   **Read the persistence arm narrowly** — schema, migration, index, locking; what a revert can't undo. An ordinary read-only query, or a repository/port method over a table that already exists, is `standard`. Read broadly it swallows the tier system: in a JPA/ORM codebase nearly every feature touches a query, and `standard`'s own examples above are themselves queries.
3. Otherwise → **full**.

Scary wording alone doesn't force `full` (a copyright-year bump in a payment template is light); "small" alone doesn't earn `light` (a one-line auth-role change is full). **When you're unsure, answer `standard`** — it keeps a real Codex read of the diff, the real `/security-review`, the docs hunter, static analysis and build+tests, so `full` keeps meaning what it should. Reserve `full` for a change whose *approach* deserves challenging. (A `profile` that isn't one of the three tiers at all is different: nothing classified the diff, so fall back to `full`.)

Then record **profileReason** — one line naming what actually decided the tier: the file, seam or operation you weighed, not a restatement of the tier. "it is a full change" is not a reason; "read-modify-write on `DealRepo` with no lock" is. Honouring a caller-provided profile is itself a reason — say so. It travels to the stats sink and is read back later, because `profile` says which tier and `profileForced` says who chose it while neither says what decided it: without this, an over-rated run and a correctly rated one are the same row. 21 of 26 classified runs land on `full`, and each step down from it is worth ~37M tokens measured (71.1M/run at `full` against 33.8M at `standard`) — so this line is what decides whether that 21 is a finding or a fact.

Separately record two gates the later steps read:

- **uiTouched** — whether any changed file is frontend (`*.html`/templates, `*.css`, `*.js`, `static/**`, `templates/**`). It decides whether the UI step (Step 8) runs, **in every tier including `full`** — the tier says how risky the change is, not whether there is a new rendered result to look at.
- **securitySurface** — whether the diff touches anything `/security-review` could have an opinion about (auth/session/CSRF, a new or changed endpoint, upload or file IO, SQL/migrations, crypto/secrets, untrusted parsing or deserialization, raw template output, outbound calls, security config). It gates the security hunter in Step 2b. Answer conservatively — **if you can't tell, treat it as true** and let the hunter run. A missing answer must never be the reason a security review was skipped.

If `git` is unavailable or this is not a repo, say so and ask the user how to scope the diff rather than guessing.

**A triage that can't run is a halt, not a skip.** "Nothing to review" and "nothing classified the diff" are opposite outcomes that produce the same empty result, and an unattended caller (`/r:issues-fix`) reads a skip as *reviewed, nothing owed* — then merges the branch and closes the issue on a review that never started. If this step can't complete, stop with `triage-blocked` and say so.

## Step 1 — Detect the build tool, and check for `/test-app`

At the repo root (`git rev-parse --show-toplevel`):

| Build tool | Detect | Clean build (once) | Incremental rebuild | Build-runner agent |
|-----------|--------|--------------------|---------------------|--------------------|
| Gradle | any of `build.gradle[.kts]`, `settings.gradle[.kts]` | `./gradlew clean build` | `./gradlew build` | `r:gradle-build-runner` |
| Maven  | `pom.xml` | `mvn clean package` | `mvn package` | `r:maven-build-runner` |

If both exist, prefer the root build file; if still ambiguous, ask. If neither, ask the user how to build.

**One clean build per run; every rebuild after it is incremental.** A review that finds something runs the build 2–4 times (Step 5, its retry loop, the Step 6c rebuild, the Step 8 minor-fix rebuild), and `clean`-ing each time throws away work the next build immediately redoes — on Gradle it also discards the incremental state the daemon exists to keep. So the run's **first** build uses the clean command: it starts from a known state (nothing left over from another branch or session can leak in) and gives `/r:code-scan` trustworthy bytecode. Every build after it uses the incremental command, because by then the build directory holds *this run's own clean output* plus a small fix delta — there is nothing stale for it to pick up. The green bar is untouched by this: the baseline build is still a full clean build with tests, and a red build still halts the routine.

The one case where incremental is unsafe: a **deleted or renamed** source file can leave a stale `.class` behind that lets a genuinely broken build pass. If a fix deleted or renamed a source file, use the clean command for that rebuild.

**`baselineBuilt: true` — skip even that first clean build**, because the caller already ran one. `/r:task-run` and `/r:issues-fix` both hand the implement half a clean green build immediately before calling this review, on the same branch, in the same working tree; without the flag this run opens by doing it again from an empty build directory, re-proving what was proved minutes ago over a diff that has changed only by this run's own fix phase. On a multi-module JVM project that is the most expensive duplicated step in the chain. So when the caller passes it, the **first** build uses the incremental command too. Callers pass it **only** from a handoff reading `buildGreen: true` — `"n/a"` means no build ran at all, and honoring it there would leave the run with no clean build anywhere. Everything else is unchanged: the bar is still a fully green build with tests, and the deleted-or-renamed rule above still forces a clean build when incremental could lie.

Don't add build-level parallelism flags (`-T 1C`, `--parallel`, `--build-cache`) on your own. They're a real win on multi-module projects, but a non-thread-safe plugin turns them into a flaky false-red — and a false red halts the whole routine. That's an opt-in the user enables per project after checking their build is thread-safe.

**Also answer the Step 8 gate here**, while you're already running repo commands — it's a single `test -f`, and asking it later costs a whole extra subagent round-trip on the critical path:

```bash
test -f "$(git rev-parse --show-toplevel)/.claude/skills/test-app/SKILL.md" && echo present || echo absent
```

Record the answer as **hasTestApp**; Step 8 reads it rather than re-checking. See Step 8 for what presence/absence means.

## Step 2 — One parallel review pass (report-only)

**How much of this step runs depends on the tier.**

- **light** — none of it. The change can't alter behavior, so its sole review is the Codex `--mode review` pass over the final diff in Step 7.
- **standard** — a **Codex `--mode review`** pass over the diff, plus the **security** hunter. Codex reading the diff is a real independent tool, which is worth more than a set of LLM pattern-matchers; the security hunter stays because a diff reviewer can't stand in for the real `/security-review`. What standard gives up is the `/r:code-bugs` **pattern** hunters (`logic`, and `runtime-and-failures` = concurrency/performance + silent failures), the up-front codex **adversarial** pass — a stronger machine than this tier needs, and one that would duplicate the Step 7 read — and the `/r:code-quality` readability pass, which is polish rather than correctness. Know the cost: nothing at this tier is specifically hunting performance-at-scale (N+1, unbounded fetches, pool exhaustion), so `/r:code-scan` and the Step 7 end-verify are where that has to surface.
- **full** — all the blocking tracks in parallel, so triage sees the whole field.

**The `docs` hunter runs at standard and full, but NOT inside this step's join.** It is the one finding track whose output nothing downstream acts on: doc drift resolves to *update doc* / *update code* / *confirm intent*, which is the user's call, so it is surfaced and never auto-fixed. Dispatch it right after Step 0, alongside the docker pre-warm, and collect it when you assemble the fix-list — holding the fix phase behind a track that only produces a list for the user bought nothing.

The rest of this step describes the tracks; run the ones your tier calls for. When `/r:code-quality` didn't run, the readability bucket comes back **empty** — don't mine the other reports to fill it, since nothing reviewed readability and `/r:code-refactor` would then be sent after code no reviewer flagged.

Everything that *reads* the code runs here, at once, over the same diff: Codex, the hunters, and `/r:code-quality`, each in its own subagent, all launched in the same turn. They're independent, so overlapping them costs no extra wall-clock and gets you a single complete picture before a line is touched. Running them as Agent children (rather than detaching Codex as a background shell job) keeps every track legible to the harness — a subagent that's still working is a live child, never a false "came to rest." **No track fixes anything in this step** — that keeps the "find everything first" shape and means the triage in Step 3 sees the whole field.

Launch your tier's tracks in the same turn:

**2a — Codex in a foreground subagent.** Dispatch a `general-purpose` subagent (it needs `Bash` to run the wrapper) whose sole job is to run the adversarial-review script in the **foreground** from the repo root and hand back the result. **The reviewer mode is a tier decision, not a preference:**

```bash
cd "$(git rev-parse --show-toplevel)"
# full — the strict adversarial/challenge review (questions the approach, not just the code)
${CLAUDE_PLUGIN_ROOT}/skills/code-adversarial/scripts/run.sh" --wait
# standard — Codex's lighter built-in reviewer
${CLAUDE_PLUGIN_ROOT}/skills/code-adversarial/scripts/run.sh" --mode review --wait
```

The two modes are **different machines**. `r:code-adversarial` is a prompt-driven Codex session that challenges design choices. `--mode review` calls Codex's native reviewer API: it fetches its own diff (nothing is embedded) and **hard-errors on trailing focus text**, so pass it no focus text and no extra positionals — give the subagent the scope as context, never as an argument.

**One more gate on full's adversarial pass: `planReviewed`.** When the caller certifies that Codex already reviewed the **plan** for this task — which `/r:task-run`'s implement half does at its own full tier, before a line of code exists — use `--mode review` here instead. Challenging the approach a second time over the finished diff is the most duplicated expensive step in the chained pipeline, and the adversarial session is the slowest kind of Codex run there is; measured across 9 stored implement runs the plan review raised ~24 findings and folded ~20 of them in, every time. The pass still happens, it just spends itself on the **code**. This is fail-open: only an explicit `planReviewed: true` buys the lighter mode, so a caller that says nothing — or a `/r:task-run` whose own tier was below full and therefore ran no plan review — still gets adversarial. Every other full-tier track is untouched.

**The report is Codex's, not the subagent's.** Brief it not to review the diff itself: no reading project source, no `git show`/`cat`/`grep` through the change, no checking the script's directory before invoking it — run the command, wait, report what comes back. One `git diff --stat` to name the scope is enough. Its own reading adds nothing to Codex's critique and is measured at ~30k characters of tool output per run for no extra finding. (Same clause the security hunter carries, for the same reason.)

Brief it to return **`run.sh`'s exit code and its full stdout verbatim** — that's what Step 2d branches on. Run it **foreground, never** `Bash(run_in_background: true)`: a detached background shell job is invisible to the harness's child-tracking, so the orchestrator would get "came to rest / no live children" while Codex is still running and could wrongly park or kill the run. A foreground subagent stays a live *Agent* child for the whole review, so its state is always legible and its returned report is the completion signal (exactly like 2b/2c). `--wait` runs the review to completion in one shot; the script's own per-attempt timeout and 3× retry loop apply. (Don't pass the script's own `--background` flag either — the Codex companion ignores it for reviews.)

**2b — the hunters, dispatched by YOU.** Don't hand `/r:code-bugs` to one subagent and expect it to fan out beneath itself. Since Claude Code **2.1.217 subagents have no `Agent` tool**, its hunters can't spawn there — and the failure is invisible: the subagent reads the diff in one context and returns that as a completed scan, byte-identical in shape to a real multi-hunter report. So spawn the hunters **yourself**, in parallel, exactly as find-bugs' Phase 2 defines them (read that skill for each hunter's brief; don't re-derive it). **Which ones you spawn is the tier's call:**

| hunter label | reference file(s) it reads | agent type | model | effort | standard | full |
|---|---|---|---|---|---|---|
| `logic` | `logic-and-flow.md` | `r:bug-hunter-pattern` | *inherited* | `high` | – | ✅ |
| `runtime-and-failures` | `concurrency-data-and-performance.md` **and** `silent-failures-and-java.md` | `r:bug-hunter-pattern` | *inherited* | `high` | – | ✅ |
| `security` — invokes the **real `/security-review`** | – | `r:bug-hunter-security` | *inherited* | *inherited* | ✅ *(gated, below)* | ✅ *(gated, below)* |
| `docs` — code/doc drift vs docs + CLAUDE.md rules | `documentation-consistency.md` | `r:bug-hunter-docs` | `sonnet` | `medium` | ✅ *off the join* | ✅ *off the join* |

The `docs` row is in this table because it is dispatched with the same brief, but it is **not** part of this step's join — see the note above Step 2a. Nothing waits on it until the fix-list is assembled.

**Use `r:bug-hunter-pattern` for the pattern hunters, never `r:bug-hunter`.** The agent has to agree with the job or it quietly does the other one. `r:bug-hunter` is the `/r:code-bugs` single-bug investigator — *Reproduce Before You Fix*, trace the data flow, ask clarifying questions — a persona that earns its cost by going deep on **one** thread, and it carries 13 tools: MCP and Task tools a hunter never calls (0.0 uses per run) plus WebSearch (0.1), all sitting in the prefix that every turn re-reads. These hunters do the opposite, a discovery sweep over a changeset, which the brief also says ("report-only, no tests"). Point them at the investigator and the persona wins for the first dozen turns: measured over 151 stored `logic` runs, the median hunt reads **twelve whole source files before it ever runs `git diff`**, reaches the diff around turn 31, and finishes at turn 49 holding ~93k tokens of context. `r:bug-hunter-pattern` is the same reasoning depth with the sweep discipline and four tools. `r:bug-hunter` is right where reproduction genuinely *is* the job — `/r:issues-fix` uses it for exactly that.

**Why `runtime-and-failures` is one hunter and not two.** Concurrency/performance and silent-failures share one hunter. Every extra subagent is a fresh context that re-reads the same diff and the same surrounding source from scratch, and with no shared prefix it re-writes its whole cache — so two agents cost roughly twice one for the same diff. Measured over 10 instrumented runs those two returned **0.25 and 0.12 fixes per run**, the weakest pair in the pipeline. Keeping them merged keeps **both** pattern files and every category; it just pays the diff-reading cost once. Brief it to make a *single* pass looking for anything in either list, weighted by what the change actually does — a diff with no shared state has little for the concurrency patterns, and one full of swallowed exceptions has a lot for the silent-failure ones.

**Don't merge any further, though** — the saving is smaller than it looks and it is not where the money is. Apart, concurrency and silent-failures cost **2.15M and 2.86M cache-read tokens** per run; merged, `runtime-and-failures` costs **4.23M**. That is ~15%, not the ~50% that "one agent instead of two" suggests, because the merged hunter simply takes more turns (41/47 → 57). Cost here is **turns × context**; an agent count is only a proxy for it. Folding `logic` in too would risk the best-yielding pattern track (0.92 fixes/run) for another ~15%. The levers that actually pay are the lean agent above, the ordered and bounded hunt below, and the single shared diff.

**Why the pattern hunters run at `high` and docs at `medium`.** A pattern hunter is handed one list of known failure shapes and asked whether the diff matches any — real judgement, but bounded by the file it was given, which is a different job from deciding what is a false positive (Step 3) or what reads well (`/r:code-quality`). Yield agrees: `logic` returns 0.88 fixes/run against 1.33 for `codex`, which already runs at `medium` because *Codex* does its thinking. The docs hunter goes lower still because its output is not a judgement the pipeline acts on — doc drift resolves to a decision the user owns, so it is compared and surfaced, never adjudicated and fixed. (Its 0.00 fixes/run is **not** evidence against the track: the metric counts fixes, and this track is deliberately excluded from the fix-list. Retiring it on that number would be measuring the metric, not the hunter.) `security` keeps the inherited top tier — its cost is the real `/security-review` it invokes, not its own reasoning, and it is already gated twice.

**The docs hunter is also the one hunter pinned to a cheaper *model*.** Every hunter agent carries `model: opus` in its own frontmatter, so an effort pin alone leaves the top model in place — right for a track that adjudicates, wrong for this one. It compares a diff against written statements (a matching job), its findings are never auto-fixed, and a false positive therefore costs a user one read rather than a wrong edit. Measured at **3.18M cache-read tokens over 52 turns per run**, the second-most expensive hunter of the four. Dispatch it on `sonnet`. The hunters that decide what is broken keep the inherited model.

**Order the hunt and bound it — this is the largest single cost in the review.** Left to itself a hunter explores first and reads the change late; the numbers in the `r:bug-hunter-pattern` note above are what that looks like. Cost is turns × context, so that preamble — not the reasoning, not the reference file, not the brief — is the biggest line item here. Put this in every hunter's brief (the security hunter's own brief already carries the same shape, in point 2 below):

1. **Read the change first**, before opening any other file.
2. **Judge each hunk against the patterns from the diff itself** wherever that is possible.
3. **Open source only for a candidate you cannot settle from the hunk** — `Grep` for the symbol, `Read` with `offset`/`limit` around the line. Never read a file end to end, never open every file that mentions a name.
4. **A budget of about 12 tool calls.** A budget, not a wall: a real candidate that needs a few more is worth them, but the overrun goes on *that candidate*, not on general orientation.
5. **If the budget runs out with a candidate unconfirmed, name it in `coverage`** — "possible N+1 at `OrderRepo:88`, not confirmed". An honest short answer beats both a silent drop and a padded report, and it is what keeps a budget from quietly becoming a truncated scan.
6. **Batch independent tool calls.** Several greps, several reads, a `git diff` beside a `git status`: when the next calls do not depend on each other's results, issue them in ONE block rather than one per turn. Same arithmetic as the ordering rule above — cost is turns × context, and every turn re-reads the whole context accumulated so far, a median of ~77k tokens, so a call that could have ridden along with the previous one pays a full re-read to return one grep. Measured over the stored transcripts, 22% of shell calls return under 200 characters. Calls that genuinely need a previous result stay serial. (The bundled hunter agents carry this in their own definition; steps that dispatch a **built-in** agent — `general-purpose`, `Explore`, `Plan` — have no file to carry it, so it goes in their brief.)

**Capture the diff once, and point every hunter at that one file.** Each hunter is a fresh context with no shared prefix, so left alone each derives the change for itself — 10–17 shell calls apiece before any hunting begins. Worse, they don't converge on *what the change is*: stored runs show `git diff HEAD`, `git diff` and `git diff origin/main..HEAD` inside a single review, which are three different changesets. So before dispatching them, run one cheap capture from the repo root:

```bash
d="$(mktemp)"; git diff HEAD -U20 > "$d"; echo "$d"
```

and give every hunter that path with "read it first, treat it as the scope, do **not** re-derive it with git". Two rules make this safe. **Capture it after Step 0/1**, because that is where untracked sources get `git add -N`'d — taken earlier, a brand-new file is silently missing from the artifact the whole scan reads. And **pass a path, never the diff text**: embedding 40k characters of patch in a brief asks each hunter to work from a copy that may have been re-emitted lossily, and a hunter reviewing a paraphrased diff is worse than one that fetched its own. If the capture fails, fall back to telling each hunter to run `git diff HEAD` itself, once — slower, not wrong. Skip it entirely for a whole-project scope, where there is no diff to capture.

Same idea for the docs hunter's *other* input: discovering the doc tree with `ls`/`find` costs it 25 shell calls and 141k characters of tool output per dispatch, the most shell-heavy hunter of the four. You have already walked this repo in Step 0 — hand it the doc list you found, and tell it to Glob only for a file missing from that list.

Never substitute `r:bug-hunter-pattern` (or a plain `r:bug-hunter`) for `r:bug-hunter-security`: only that type has the `Skill` tool, so the swap silently turns the security track into a checklist read.

**The security hunter has a second gate: does the diff have security surface at all?** Dispatch it when the change touches auth / permissions / session / CSRF, a new or changed endpoint or controller mapping, upload or file/path IO, SQL/JPQL or a migration, crypto / secrets / tokens, deserialization or parsing of untrusted input, raw template output (`th:utext`, `innerHTML`, `eval`), outbound network calls, or security configuration. Skip it only when the change is plainly none of those — copy and CSS, a log message, a rename, a badge count, a test-only edit.

Why the gate exists, and why it is drawn conservatively: measured over 19 dispatches in one project, this track returned **zero findings** at roughly **232k cache-write tokens each** — and most of those diffs were text wrapping and notification counts that `/security-review` structurally could not comment on. **When in doubt, dispatch it.** A skipped security review is a coverage hole; it has to be earned by a diff with genuinely no security surface, never by a guess. And when you do skip it, say so in the summary as a **skip** — `no security surface in this diff; nothing was security-reviewed` — never as a clean result.

**Two things to put in the security hunter's brief**, both measured token burn:

1. **Pass the changed FILE PATHS as the skill's argument** — `Skill(skill: "security-review", args: "<space-separated changed files from triage>")`, never a sentence describing the scope. The skill's Phase 0 honours an argument in exactly three shapes — a PR number, a branch name, or a file path — and discards anything else, then falls through to its own `git diff @{upstream}...HEAD`. On a branch carrying earlier commits that is a changeset this review is not certifying, and a prose scope string buys none of the protection it looks like it buys: measured 2026-08-19, 3 of 3 dispatches handed a scope *sentence* came back having read the branch commits instead. Called bare it is worse still — it derives its own scope and inlines the whole branch history (git status, the full changed-file list, every commit message) into its prompt: ~27,000 characters per run, worst case 47,000. Where there is no file list to pass (scope `all`, or a triage that returned none), pass the prose scope and expect the skill to resolve its own — the `scopeMatched` check below is what keeps that honest.
2. **Forbid re-deriving the diff by hand afterwards.** The skill already holds the changeset; re-reading it with `git show`/`cat` was measured at ~13 extra shell calls per run for no extra finding.

**And know what that tool refuses to look at.** `/security-review` reports only HIGH/MEDIUM issues it is **>80% confident are exploitable**, only for what the change **newly introduces**, and it **excludes** denial of service, resource exhaustion, **rate limiting**, and secrets stored on disk. So `findings: []` from this track means *nothing cleared that bar* — not *this change is secure*. Require the hunter's `coverage` to state both the scope it read **and** those limits, because the excluded categories are real risks that `codex`, the `runtime-and-failures` hunter and `/r:code-scan` have to cover instead.

Give each the diff scope explicitly (changed-file list + the captured patch path above) — a subagent can't `AskUserQuestion` to clarify it — and tell each to report only, no failing tests and no fixes. Then dedup across them (same `file:line` + same description = one finding) and carry the merged list into Step 3. This is the same shape the workflow script uses, so both engines now agree; the fan-out simply lives at the level that can actually perform it.

**Every hunter your tier dispatched must report** — up to four at full, up to two at standard (one fewer in each when the security gate above skipped it). The rule is about the set you *dispatched*: a scan missing a hunter it did dispatch is not complete, and reporting it as clean certifies nothing. A hunter that was never dispatched is a different thing — a named skip, not a failure. If a hunter comes back without usable findings (died, returned nothing, empty report), **re-dispatch that same hunter** — same type, same scope, same brief — bounded to **2 re-dispatches**. After that, carry the surviving hunters' findings forward but mark the track **incomplete** and say which hunter is blocked. Degrade to fewer hunters; never degrade silently to a claim of full coverage. **Name the track for what you actually ran**: at standard it is the security + docs hunters, not `/r:code-bugs` — calling it find-bugs tells whoever reads the summary that a tool failed when it was simply never dispatched. The subagent-flow non-negotiable governs the waiting: a hunter's returned message **is** its completion signal — don't poll it, don't watch for an output file.

**2c — `/r:code-quality` in a `general-purpose` subagent.** In parallel with the above, dispatch a `general-purpose` subagent (it needs the `Skill` tool to invoke the skill). Its two review lenses can't fan out into sub-subagents from there, so tell it to **run both lenses inline in its own context and say so in its report** — `/r:code-quality` explicitly allows that, and for a single diff scope the parallel split buys little. Brief it to:

- Run `/r:code-quality` over the **diff scope** — pass the changed-file list and `git diff`; review the full changed files but keep findings to what the change touched.
- Return the grouped report — **Worth fixing** and **Minor / optional** — as `file:line` + one line each, then stop. The skill is report-only; it never edits.

This is the human-judgment layer (readability + idioms) that static analyzers structurally can't do. It reads the **pre-fix** code, which is a deliberate tradeoff of the one-pass design: the end-verify (Step 7) still catches any correctness problem the fixes introduce, and readability of the fix code itself is low-stakes.

The subagent-flow non-negotiable applies here too: this subagent's returned report **is** its completion signal — don't poll it or watch for an output file. If it comes back **without a usable report** (died, returned nothing, or stalled past a short bounded wait), **re-dispatch it** (same `general-purpose` type, same diff scope, same brief), bounded to **2 re-dispatches**, then stop and say it's blocked — never keep waiting on one that already came to rest.

**2d — Read Codex's result.** The Codex subagent's returned report **is** its completion signal — the same model as 2b/2c: don't poll it, don't watch for an output file. When it returns, branch on the `run.sh` exit code it reported (this same handling applies to the Step 7 end-verify):

- **`0`** — the review ran; carry its findings into triage.
- **`0` with `CODEX SKIPPED:` first on stdout** — the Codex plugin is not installed. It is the one **optional** prerequisite, so this is a **skip, not a block**: print `post-task-review: codex SKIPPED — the OpenAI Codex plugin is not installed; every other step ran` and continue with the remaining tracks. Record the step as **skipped** in the report — never as reviewed, and never fake it. At standard that costs the correctness reader, so say which tracks actually survived rather than reporting the tier as reviewed.
- **`4`** — Codex is installed and ran, but its own tool calls were rejected (a transient Codex-runtime error) so it never inspected the diff. `run.sh` already retried 3× before returning this, so **do not retry again here**. The `Review blocked` text is *not* a finding — **drop it, never put it on the fix-list.** Print `post-task-review: Codex review still blocked after retries — proceeding with the hunter findings only; re-run it later` and continue. The hunters (and, at full, code-quality) still ran, so the routine isn't blocked. **At standard this degrade costs more than at full**: Codex *was* the correctness reader there, so the surviving tracks are only security and doc drift — say that plainly rather than reporting the tier as reviewed.

- **any other non-zero** — the wrapper itself failed (node missing, a bad flag, the companion threw). Its stdout is **not** findings. Treat it as a not-run and say so; never read it as a clean review.

If the Codex subagent comes back **without a usable result** (it died, returned nothing, or stalled), **re-dispatch it** (same `general-purpose` type, same brief), bounded to **2 re-dispatches**; after that, treat it as the exit-`4` degrade path and continue. Never block the pipeline indefinitely on Codex — the hunters already ran.

Defense-in-depth: even on exit `0`, if the Codex report's only "findings" are review-process failures (`Review blocked`, `could not be inspected`, `rejected tool calls`), treat it as a not-run too, not as bugs.

**Every report-only track must state whether its tool actually ran — an empty findings list is a claim, not a safe default.** This is the failure this routine is least able to detect and most damaged by: a track that died still hands back a well-formed "no findings", which is byte-identical to a genuinely clean review, and an unattended caller banks it as verified. So each track (Codex, each hunter, `/r:code-quality`, and the Step 7 end-verify) reports a **ran** flag alongside its findings — `ran=false` whenever the real tool didn't run or returned a blocked/degraded/empty report — and a track with `ran=false` counts as **blocked**, exactly like one that died. It never counts as clean. The workflow encodes this as a required `ran` field on the findings schema, mirroring what the UI track's report already does.

Carry every report your tier produced into Step 3 — the hunters (bugs at full, security and doc drift at both), Codex, and (full only) code-quality. A track the tier never dispatched is labelled *(not run at this tier)*, which is a tier decision, not a missing input to work around.

## Step 3 — Triage once (intent-aware — keep it lean)

**Split this by bucket — one subagent per bucket, in parallel.** Correctness reads the hunter and Codex reports and decides what is a real defect; readability reads only `/r:code-quality` and decides what is a behavior-preserving clarity win. They never shared an input, and merging them meant one serial agent swallowing the full JSON of every report. Below `full` the readability agent isn't spawned at all, because `/r:code-quality` didn't run. Doc drift isn't triaged at all any more — it comes straight from the docs hunter, since routing a list that is only ever handed to the user through a filter that cannot act on it bought nothing.

Read the reports and decide what's **real** in a single pass. The one thing that separates a genuine issue from a false positive is *why the code was written this way this turn* — the change's intent. In the prose (subagent) path you hold that yourself; in the workflow the triage subagent is **given** the intent (the caller's `taskIntent`, or what Phase 0 inferred), so a finding that contradicts the intent is dropped as a false positive either way. When you drop a finding, note why in one line; keep that **dropped list**, the Step 7 end-verify reuses it.

This step is only judgment — you do **not** read the whole codebase or apply edits here. Produce one **fix-list**, split into the buckets that get handled differently in Step 4:

- **Correctness / security** (from the hunters + Codex): `file:line` + one sentence on what's wrong and the intended fix, **plus the track that found it** — `codex`, `security`, `docs`, `logic` or `runtime-and-failures`. Every finding you were handed already carries that label (the hunters stamp it as they merge); copy it rather than re-deriving it, and when two tracks reported the same defect credit the first. This is what lets a later question — *does this track ever actually find anything?* — be answered with counts instead of opinion, so a wrong label is worse than a missing item. **Don't pass the label to the fixer**: which track flagged something shouldn't colour how it gets fixed.
- **Readability — worth fixing** (from code-quality): `file:line` + the clearer direction. Drop taste-only or intentional items here.
- **Doc drift** (straight from the docs hunter, which runs at standard and full): code/doc divergences, collected here rather than triaged. These resolve to *update doc* / *update code* / *confirm intent* — a decision the user owns, so they don't go on the auto-fix list; surface them in Step 8's summary (or ask if any block correctness). A **blocked** docs hunter loses the list and must say so: nothing checked the change against the documentation, which is a coverage hole, never "the docs agree with the code".

**Check the scope the skill actually read.** Passing the changed file paths (Step 2b) is what makes the skill read this diff, but it is the skill that decides whether to honour the argument, so verify rather than assume — compare what its report says it covered against what you asked for. Handed a scope *sentence* instead of paths it ignores the argument outright and reads the unpushed branch commits: 7 of 46 recorded dispatches, and 3 of 3 on 2026-08-19. On a mismatch the track is **not** a clean bill: the report is real, complete, and about a changeset this review is not certifying. Say so, name both scopes, and treat the security half exactly as you treat a blocked one — the scan did not cover this diff. Give it its own wording, though: a blocked tool has to be made to run, a drifted one has to be made to read the right thing.

Record the security half's own outcome — `clean` | `scope-mismatch` | `blocked` | `not-dispatched` — in the stats row. All four leave `findings: []` behind, and until they are separable the 47 recorded dispatches that each returned nothing cannot say whether the diffs were clean or the track never reports anything at all.

Carry the security hunter's `coverage` through verbatim. It has to answer three different questions that all produce an empty findings list: **reviewed and clean** ("no issues in the reviewed changeset" — diff-scoped, never "the whole codebase is secure"), **blocked** (the tool died — nothing was reviewed), and **not dispatched** (the gate found no security surface). Only the first is a reason to merge, so never let the three collapse into one line.

If every bucket is empty, skip Step 4 and go straight to the build.

**If the CORRECTNESS half of triage can't run, what happens depends on what would be lost.** (A lost readability list costs polish, not soundness — note it and carry on.) Findings pending → **stop** (`fix-triage-blocked`) and hand them back untriaged: they were found, never triaged, never fixed, so a caller must not merge on them. No track reported anything → nothing was lost; note it and continue with an empty fix-list. What must never happen is the quiet middle: dropping real findings and reporting `fixed: 0` as though the field was clean.

## Step 4 — Fix everything once

One fix phase, the heavy work delegated so it stays out of your context. Apply the correctness fixes first, then the readability refactor on top.

**4a and 4b are SERIAL — never launch them in the same turn.** This is the one place in the pipeline where two writers would be pointed at the same files, and it is not a style preference. Both lists come from reviews of the *same* diff, so a shared file is the common case rather than the tail. Two agents editing one file at once has three outcomes and only two of them are caught: a broken file fails the fixer's own self-check or the Step 5 green build. The third is silent — the refactorer writes a file from a read taken *before* the correctness fix landed, the fix vanishes, the build is still green, and the run reports it as fixed. Nothing downstream re-reads it, because the full-tier end-verify is framed regression-only and told to skip anything already triaged, which is exactly what a reverted triaged fix looks like. No "stay in your lane" wording in the two prompts can make concurrent writes to one file safe; only the ordering can. Correctness first is also the cheaper order on its own terms — refactoring code that is about to be surgically fixed is wasted work, and the separate readability commit in 4b is only an honest "behavior-locked" description once the fixes are already in.

**Count only what a live fixer took.** If either subagent dies, the triaged list is what someone was *asked* to do, not what got done. Report that half as `0` fixed, name the lost items in the log, and don't credit the finding tracks for them in `fixedBySource` — a `fixed` count a caller merges on has to be earned. A dead readability refactor costs polish only; a dead correctness fixer means the defects are still in the tree.

**4a — Correctness / security → a domain subagent.** Hand the correctness fix-list to a specialist: the list, the diff (`git diff`), and one or two sentences on what the change was meant to do (so it doesn't "fix" something intentional). Brief it as a **surgical fixer, not a feature builder**:

- Fix **only** the listed items — the smallest diff that resolves each. No refactoring, renaming, or "improving" outside them.
- Test-first: write the test, **run it and watch it fail** on the current code, then fix until it passes (use the `r:tests-write` skill) — and have the fixer report what the failure was. Red-before-green is an observation, not a claim: a test that was already green hasn't reproduced the finding, so either it's too weak to reach it or the finding was wrong, and both are worth surfacing instead of shipping a green test as proof of a fix. For non-behavioral fixes a regression test is enough — label it as one.
- Respect project conventions: no new comments or Javadocs, `@Builder` on data classes with more than 3 fields, match the surrounding code.
- **Self-check by compiling, not by building.** Give the fixer the cheap command — `mvn -q test-compile` or `./gradlew -q testClasses` — plus the one test it wrote test-first (`-Dtest=X` / `--tests X`), and tell it explicitly **not** to run the full build or the whole suite. Left vague ("verify it compiles"), a fixer reaches for `mvn clean package` and runs the entire suite seconds before Step 5 runs it again — a hidden duplicate test run per fixer, invisible because it happens inside a subagent. Nothing is verified less: compiling is all the self-check must prove, and Step 5 runs the suite immediately after. Don't add `-o` (offline) by default — fixers run *before* this run's first build, so on a fresh clone an uncached dependency makes it fail hard.
- Return a short summary (files + one line each).

Route by area: backend (`*.java`, `*.kt`) → **`r:java-backend-developer`**; Thymeleaf / HTMX / templates → **`r:htmx-thymeleaf-dev`**; spanning both → one subagent per area in parallel, each with its slice; no clear specialist → a general subagent. That split is safe to overlap precisely because the slices are **disjoint files** — which is what 4a and 4b never are. Give each its file list explicitly; the moment two fixers could touch one file, run them one after the other.

**4b — Readability wins → `/r:code-refactor`.** Apply the "worth-fixing" code-quality findings with the **`/r:code-refactor` skill**, not a domain subagent. `/r:code-refactor` is the right tool because a readability/idiom fix must change *form, not behavior*, and `/r:code-refactor` locks behavior with a test first, then refactors safely. Scope it to the **changed files only**, and — by default — have it land as **its own commit**, separate from the correctness fixes, so if a readability change turns out wrong it's one `git revert` and the end-verify can review it in isolation. **Exception — `deferCommit` mode** (the caller, e.g. `/r:task-run`, commits the whole task as one commit at the end): the refactor applies its changes **in the working tree without a separate commit**; they fold into the caller's single final commit. **Minor / optional** code-quality items are just listed for the user, never auto-applied (readability is partly taste; don't churn the diff).

`/r:code-quality` reports, `/r:code-refactor` fixes — that's the division of labor.

## Step 5 — Build with tests

Run the build via the matching build-runner agent (`r:gradle-build-runner` / `r:maven-build-runner`). This is the run's **one clean build** (`./gradlew clean build` / `mvn clean package`) — every rebuild after it, here and in Steps 6c and 8, uses the incremental command per Step 1. **Unless the caller passed `baselineBuilt: true`**, in which case it just ran that clean build itself and this one is incremental too (Step 1).

**Green is the exit code, not the log text.** Run the command so the code is captured (`<cmd> > <logfile> 2>&1; echo "EXIT=$?"`) and judge on that. The incremental commands are `-q`, under which Maven and Gradle print **no** `BUILD SUCCESS` / `BUILD SUCCESSFUL` line at all — so its absence proves nothing, and an agent that greps the log instead has only the `[ERROR]` lines left to judge on. `EXIT=0` is green even when the log carries `[ERROR]`, `FAILED` or a stack trace: tests that exercise failure paths log all three, and Surefire's `going to kill self fork JVM … after System.exit(0)` is a shutdown-timing notice, not a failure. Get this backwards and a finished, green diff is called red — which halts the routine and strands the work, the most expensive wrong answer available at this step.

If it's red, first decide **whose failure it is** — this is what keeps the green invariant honest without ever touching unrelated code:

- **In-scope** — a compile error or a test failure in code *this turn changed*. Hand only these back to the fixer subagent — with the same compile-only self-check rule from Step 4a, since this loop rebuilds and re-runs the suite the moment it returns — then rebuild. **Cap the build→fix cycle at 2–3 iterations** — "loop until green" is unbounded, and an unfixable build would loop forever. On exhaustion, **STOP and surface the remaining failures to the user**; don't grind silently.
- **Pre-existing / out-of-scope** — a failure that reproduces on the base commit and is unrelated to the diff (e.g. `main` was already red). Do **not** try to "fix" it, do **not** touch those tests/classes, and — the thing that just went wrong — do **not** fork or edit the pipeline to tolerate it. **STOP immediately and surface it** (list the failing classes), so the user fixes or quarantines them on `main`. The review cannot certify a green build on a red baseline; that's the user's call, not a workaround to bake into the routine.

When red is a mix, fix the in-scope failures and surface the pre-existing ones. Never relax the green bar to get past someone else's broken tests.

## Step 6 — `/r:code-scan` on the changed classes

`/r:code-scan` is the server-free static-analysis pass — PMD + SpotBugs/find-sec-bugs + Semgrep run as local CLIs, no SonarQube server, no tokens, nothing committed to the build. It's used here (instead of `/sonar`) because the routine runs after *every* code-changing turn, so a fast offline pass over the diff is the right inner-loop cost; `/sonar` stays the heavier gate to run explicitly before merge. Like `/sonar`, it needs compiled bytecode for SpotBugs, which is why it comes after the build, and it both scans **and** applies its own fixes: simple ones inline, method-shape ones via `/r:code-refactor`, class-level / public-API issues surfaced to you. There is no separate fix step.

**6a — Static analysis is mandatory in every tier — no skip.** `/r:code-scan` runs in **both** the light and full tiers; there is no trivial/mechanical skip (that older skip is removed — static bug/security coverage is the one thing worth keeping even on the cheap path). The only time it does nothing is when no `*.java`/`*.kt` file changed — e.g. a cosmetic frontend-only change — since the JVM analyzers have no bytecode to scan; that's a natural no-op, not a deliberate skip. Any change with modified Java/Kotlin classes gets scanned, however small.

**6b — Run the scan over the branch's changed classes.** Cover the **full classes that changed across this branch** — every issue in each, not just today's diff lines — so a class touched here (or deferred from an earlier trivial turn) gets cleaned completely.

```bash
BASE=$(git merge-base HEAD origin/HEAD 2>/dev/null || git merge-base HEAD origin/main 2>/dev/null || echo HEAD)
{ git diff --name-only; git diff --cached --name-only; git diff --name-only "$BASE"...HEAD; } \
  | grep -E '\.(java|kt)$' | sort -u
```

If git can't resolve a base, fall back to the working-tree + staged diff and note it. Then invoke **`/r:code-scan <ClassA> <ClassB> …`** with that list (the explicit-list invocation shape — see the local-scan skill), telling it to fix **all** issues in each full class. If the set is empty, skip with a one-line note.

**Trust the scan only if it actually ran — don't read a failed scan as clean.** `/r:code-scan` is fail-closed: a non-zero exit / `status: "error"` in its `findings.json` means an analyzer errored, the compile fell back to stale classes, or **no analyzer ran at all** — that is *not* a clean result. Treat it like the missing-prerequisite non-negotiable: surface which analyzer/category was uncovered and don't report the changed classes as scanned-clean. Likewise carry through any per-tool `skipped` so a partial scan isn't presented as a full static pass. Only an exit-`0`, `status`-ok run with at least one tool `ran` counts as a real clean.

**6c — Rebuild if the scan changed code.** If `/r:code-scan` modified any files, run the build again — the **incremental** command (Step 1), same runner agent, and Step 5's exit-code rule — until green. The build was fully green before the scan ran, so any failure here is a regression from the scan's own self-fixes. If it changed nothing — or the scan was skipped — skip. After this step the code is **final**: every machine- and human-applied change is in, and tests are green.

**Bound this red like Step 5's, and read a nameless red as a misread.** A red here halts the whole routine, so cap it at **3 build attempts**. A red that *names* failing classes earns one surgical fix (Step 4a rules) and another build. A red that names **nothing** — or a build agent that died — is the shape a misread log takes, so just re-run the build: dispatching a fixer after failures nobody listed is how a green tree gets edited. Still red after three attempts: **STOP** and surface it. Say plainly that *resuming* the run will not retry this step — a resume replays the cached red verdict rather than rebuilding — so the recovery is a fresh review on the branch.

## Step 7 — End-verify: one bounded review of the final diff

**Run this step and Step 8 TOGETHER, not one after the other.** They are the two longest blocks in the pipeline — Step 8 measured a median of 542s (p90 1150s), and this one is up to two Codex passes each followed by a fixer — and they read different things: this one reads the git diff, Step 8 drives a browser against a deployed image. They share nothing until their fixes land, so launch both and join. Everything that **writes** waits for that join: Step 8's minor fixes, its issue filing, and its teardown all happen after both have returned.

**The honesty cost, and the guard that pays it.** Step 8's halves verify an image built *before* this step's fixers ran. When one of those fixers touches a **frontend** file, what Step 8 looked at is stale — so re-deploy and re-run its two halves **once**, and say so in the log. That case costs about what running the two serially costs every time, which is the point: the worst case here is the serial ordering, and the common case (end-verify fixes are overwhelmingly backend) is the whole saving. A fixer that **died** changed nothing, so it never triggers the re-verify.

This is the single safety gate that makes the one-pass design safe. Steps 4–6 *wrote code* — bug fixes, a refactor, the scan's self-fixes — and none of it has been reviewed since it was written. Rather than re-review after each step, re-review once here, over the **final** diff, so the whole batch of machine-and-subagent-written code gets one real independent read. Codex is the right reviewer for this: the risk is "did a fix or refactor quietly change behavior," which is an equivalence-reasoning question Codex is well-suited to. This pass uses Codex's **lighter built-in reviewer** (`--mode review`) in **all three** tiers, not the strict adversarial mode Step 2 uses at full. Only the *framing* changes, by what has already read the change: in **full** it is regression-only (did Steps 4–6 break anything?), in **standard** a Codex read the pre-fix diff and this one reads the final one, and in **light** nothing has read the change at all, so this is the review.

**7a — When it runs depends on the tier; every tier uses the same Codex `--mode review` reviewer.**
- **Light:** no Codex has read this change yet, so this pass is its *only* Codex review and **always runs** — review the whole change (correctness, edge cases, anything it introduced), not just regressions.
- **Standard:** **always runs** too, but frame it honestly — a `--mode review` pass already read the **pre-fix** diff and the security and docs hunters went over it, and all of that was triaged and fixed. This pass reads the **final** diff, so spend it on what the fixes, the refactor and `/r:code-scan`'s self-fixes introduced, and on what a diff review of the earlier state would have missed. Say explicitly that the pattern hunters did **not** run at this tier, so performance-at-scale problems (N+1, unbounded fetches, pool exhaustion) have had no dedicated reader and deserve attention here.
- **Full:** a regression-only re-check of what Steps 4–6 wrote, **skipped** when they changed nothing of substance (empty fix-list, no refactor, local-scan no-op) → `post-task-review: end-verify skipped — no substantive changes since review`, then go to Step 8.

**7b — Run Codex over the final diff (foreground).** Re-run the adversarial-review script over the current working-tree diff — the fixes/refactor/scan edits are already in it, so no snapshot is needed — in the built-in reviewer mode, `--mode review` (the same reviewer at every tier; below full it simply reviews the whole change rather than only regressions). At end-verify nothing else runs in parallel, so run it **foreground and blocking** — no background job, no `$TMP`. Blocking here is the point: the agent never yields with an invisible job still running, so it can't be mistaken for parked and killed mid-review:

```bash
${CLAUDE_PLUGIN_ROOT}/skills/code-adversarial/scripts/run.sh" --mode review --wait
```

(The `review` reviewer ignores trailing focus text — pass only `--wait`/`--base`/`--scope`.) When it returns, apply the **same exit-code handling as Step 2d**. Hand the triage your **dropped list** from Step 3 conceptually — when reading the report, skip anything already judged there, so what's left is genuinely *new*: something Steps 4–6 introduced. (If you landed the refactor as its own commit in 4b, you can point Codex at that commit to scope it tightly instead of re-reading the whole diff. In `deferCommit` mode there's no such commit — the refactor is already folded into the working-tree diff Codex reviews here, so nothing changes.)

**7c — Triage → fix → converge, bounded at 2 passes.** Triage the end-verify findings (you have the context):

- **Real correctness / equivalence break** → add to the fix-list, run back through Step 4a (domain subagent) + Step 5 build (+ Step 6c rebuild if needed).
- **Structural or uncertain** → don't grind on it; **surface it to the user** with the fix-list so far.

Cap the end-verify at **2 Codex passes total** — a converge loop without a cap can ping-pong (fix A breaks B, fix B breaks A). If a pass returns no new real findings → converged. **But check `ran` before calling it converged:** a blocked Codex also returns no findings, and reading that as a pass means reporting the final diff as verified when nothing read it.

**`ran=false` earns one more dispatch before it becomes a verdict.** Exit 4 means the wrapper burned its own three Codex attempts on an environment error — re-running it buys three more, and on the real occurrence a manual re-run minutes later returned a clean review. So re-dispatch once; only if *that* also comes back `ran=false` is the final diff **unverified** — then stop, report it as blocked, and never present the run as clean. One retry is cheap; a blocked end-verify costs the caller the whole merge.

**A finding you didn't adjudicate is a finding.** Triage decides real vs. false positive *explicitly*; a finding you simply didn't classify counts as **real** and goes to a fixer. This is the failure mode with the worst payoff in the whole routine, and it has happened: Codex returned one verified correctness finding, the pass treated an unmarked finding as nothing, and the run reported `endVerify: passed` with `correctness: 0` while the defect shipped. So:

- `passed` requires a Codex pass that came back with **nothing outstanding** — it is the word a caller merges on, so never say it while a finding is still on the table. Findings raised by pass 2 are fixed but *never re-read* (the cap ends the loop), so they are **`findings-unresolved`**, not `passed`.
- **What a caller owes each verdict**, since this field decides whether a change ships: `passed` → safe to merge. `skipped` → nothing substantive changed after the review, also safe. `findings-unresolved` → read `endVerifyFindings` and decide; the fixes went in but nothing re-read them. `blocked` → **do not merge**: the final diff has no reader at all. That last one is not a warning to note and move past — a review Workflow that returns is not a review that passed, and a caller that only checks "did the pipeline run" will merge an unreviewed diff.
- **Report the remainder verbatim** in the result (`endVerifyFindings`) rather than only logging it. A finding that reaches no later agent and no summary field has been swallowed, not dismissed.
- Count end-verify fixes in the run's `fixed.correctness`, so that number matches what the run actually did.

## Step 8 — UI / runtime verification (only if a `/test-app` skill exists)

The static tracks read the code. This last step **exercises the running app** to catch what only shows up at runtime: a wrong redirect, a 500 on a valid form, a broken/unstyled page, a JS console error, a flow that no longer works end to end, plus genuine UI **design-quality** regressions. It runs dead last so it tests the **final, fixed, built, scan-cleaned, end-verified** code rather than something earlier steps then change.

**It is three steps, not one: deploy → (functional ‖ visual) → teardown** — and the whole thing runs *alongside* Step 7 rather than after it (see the note at the top of Step 7). The deploy and the two halves are what overlaps; the teardown, the minor fixes and the issue filing all happen after the join, so they can't race Step 7's fixers over the same files. Put the teardown in a `finally` around the **join**, not inside the parallel branch: a branch that throws is swallowed by the fan-out, and a teardown nested in there would be skipped exactly when it is needed most.

**Warm the image at Step 0.** The deploy is 42% of this step's tool time and took over two minutes in 17 of 56 stored runs (worst: 607s). `uiTouched` is known as soon as Triage classifies the diff, so start `worktree-deploy.sh prewarm` there — it builds the image **without starting anything**, so it cannot serve stale code, and it then overlaps the review, the fix phase, the build and the scan instead of just this step. A fixer editing a file below simply invalidates the layers that file touches, which the real deploy rebuilds; the cache is an optimisation, never the artifact under test. The helper always exits 0, and nothing reads its result — a failed pre-warm costs a cold build and nothing else.

**It is three steps, not one: deploy → (functional ‖ visual) → teardown.** A single agent doing all four jobs end to end is the slowest thing in the pipeline — measured across 59 stored runs: median 542s, p90 1150s, with **two thirds of it model time** spread over a median of 86 serial turns. The Phase 2 hunters at least overlap each other; this one runs alone at the end. `/test-app` is *designed* to split its work across parallel subagents ("one subagent for one focused area… spawn them in parallel"), and it **cannot** — subagents have no `Agent` tool since 2.1.217, and not one of those 59 runs ever spawned one. So you do the fan-out, exactly as Step 2b already does for the hunters.

**Gate.** Two conditions decide whether UI verification runs: **`uiTouched`** — the change touched a frontend file — and `/test-app` **present on disk**. The first applies in **every tier, `full` included** — the tier itself must never force this step. Forcing it is the most expensive unearned work available: what routes a change to `full` is auth, money, persistence, concurrency or an approach worth challenging, none of which implies a rendered page changed, so a backend-only `full` run boots the whole stack, drives a browser and grades the design of pages the diff never touched, at a median 542s. The evidence for a UI defect is a **new rendered result**, and there is one only when a frontend file changed; when none did, the static tracks (which `full` runs in full) are what read the change. So a backend-only diff **skips Step 8** at any tier with `post-task-review: no frontend change in this diff (<tier> tier) — skipping UI verification`. When `uiTouched`, the remaining question is presence on disk — that is all the `Skill` tool needs to load it. Whether git *tracks* it on the current branch is irrelevant: a `/test-app` scaffolded locally and gitignored (e.g. a `.venv` + `bugs/` setup) is fully usable even though `git` reports it as not on this branch. That's the filesystem check, not git history — and **Step 1 already ran it** and recorded **hasTestApp**, so read that flag here rather than spending another round-trip on the same `test -f`.

- **Present on disk:** continue with the verification.
- **Absent on disk:** skip with `post-task-review: UI verification skipped — no /test-app skill configured.` Never auto-scaffold one. This also covers the **stale-worktree** case automatically — a worktree branched off a commit from before the skill was added never checked the file out, so it is genuinely absent here and a plain `test -f` returns false without any git/branch reasoning. (If you want to tell the user *why* it's missing in that case, note that it exists in the main tree: `[ -f "$(git rev-parse --git-common-dir)/../.claude/skills/test-app/SKILL.md" ]` — update the worktree to enable it.)

A missing `/test-app` is a skip, not a blocking missing-prerequisite (unlike `/r:code-scan`'s analyzers or Codex's CLI) — the static review still happened.

**Worktree prerequisite.** When the skill *is* present **and you're in a linked git worktree**, this step needs working isolation — otherwise it would redeploy on the project's default port and clash with the main stack or another worktree. Require **both** before proceeding:

```bash
WTD=${CLAUDE_SKILL_DIR}/scripts/worktree-deploy.sh"
IN_WORKTREE=$([ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ] && echo yes || echo no)
HELPER_OK=$([ -x "$WTD" ] && echo yes || echo no)
SKILL_AWARE=$(grep -q "worktree-deploy.sh" .claude/skills/test-app/SKILL.md && echo yes || echo no)
```

If `IN_WORKTREE=yes` and either `HELPER_OK=no` or `SKILL_AWARE=no`, **skip this step** with `post-task-review: UI verification skipped — worktree isolation unavailable (helper missing or /test-app not upgraded; run /r:test-app-create in the main tree, commit it, and rebase this worktree).` **Never** fall back to deploying on the default port from a worktree — that is the exact collision this isolation exists to prevent. In the **main tree** this guard doesn't apply: proceed normally (default port, no isolation needed).

**The pre-warm command**, dispatched back at Step 0 as described above — a cheap `general-purpose` subagent running:

```bash
${CLAUDE_SKILL_DIR}/scripts/worktree-deploy.sh" prewarm
```

Collect it before deploying, so the build it started can't still be running against the same docker daemon when the deploy asks for the same layers. Never let it halt or block the run.

**8a — Deploy, once, in its own subagent.** A `general-purpose` subagent brings the app up and returns the live `BASE_URL`. It tests nothing. Reading a command out of a skill file and running a script does not get better with more thinking, and doing it inside the verifier put a whole docker build log into an expensive context. Brief it to read `.claude/skills/test-app/SKILL.md` (+ `references/subagent-prompt.md`) for the redeploy command, health check and default URL, then deploy **only** through the shared helper at the **absolute** path — never the raw redeploy command:

```bash
WTD=${CLAUDE_SKILL_DIR}/scripts/worktree-deploy.sh"
"$WTD" deploy '<the REBUILD_NOTE redeploy command>'
"$WTD" base-url '<the default BASE_URL>'
```

(Always use that absolute path; a bare `scripts/…` resolves against the project cwd and looks missing. If it isn't there, locate it with `find ~/.claude -name worktree-deploy.sh`.) The helper makes this step **safe to run in parallel across worktrees**, which is the normal case when several tasks are in flight. It branches purely on location: in the **main working tree** it redeploys exactly as before (default port + config) and leaves the stack up; in a **linked git worktree** it brings up a fully isolated ephemeral stack (unique compose project, a free host port, unique container names, throwaway per-worktree volumes → an ephemeral DB). So a verifier in one worktree can never bind the same port, clobber the same containers, or share a DB with the main tree or another worktree.

**A deploy that didn't come up is a blocked track, not a clean UI pass.** If the health check fails, do **not** dispatch the halves — testing whatever happens to be running on that port is worse than not testing. Report the UI track blocked, and still run the teardown in 8c.

**8b — Verify, in two halves, in parallel.** Dispatch **two** `r:bug-hunter-ui` agents (`subagent_type: "r:bug-hunter-ui"`) in the **same turn**. Both invoke the **real `/test-app`** skill — only the scope each is pointed at differs:

| half | scope | browser session |
|---|---|---|
| **functional** | API responses and status codes, form submits and redirects, end-to-end flows, app logs | `AGENT_BROWSER_SESSION=ptr-func` |
| **visual** | screenshots of the changed pages at three viewports, the responsive checklist, then the **`frontend-design`** rubric | `AGENT_BROWSER_SESSION=ptr-visual` |

Give both the resolved URL and tell them the stack is **already up and not theirs**: `export TEST_APP_BASE_URL="<url>"`, do not deploy, do not tear down. The isolated `AGENT_BROWSER_SESSION` is not optional — sessions have separate browser instances, so without it the visual half switching to iPhone 14 would silently reshape the page the functional half is clicking.

Two budgets belong in the visual half's brief, because both were measured being blown:

- **At most 6 screenshots** — the two pages the diff changed most, each at desktop (1280×800), tablet (`set viewport 768 1024`) and mobile (`set device "iPhone 14"`). Past runs took a median of 7 and up to 35; past about six the extra shots re-show what the first ones already showed, and each one is an image the agent must then read. Tell it to batch the switch and the capture into one call — `agent-browser batch 'set viewport 768 1024' 'open <url>' 'screenshot <path>'` — so a run doesn't spend a whole model turn per shot.
- **`frontend-design` is mandatory, not garnish** — it ran in only **11 of 59** past verifications. `/test-app` catches UI that is *broken*; `frontend-design` judges whether the changed pages are *well-designed*. Different lens, and it is the part that quietly goes missing.

Both agents are **report-only**: they return findings plus the durable screenshot paths. Each report must lead with the confirmation line `✅ Invoked the real /test-app skill …` or `❌ Did NOT run …` — if that line is genuinely absent, treat that half as not having run and re-dispatch. Don't downgrade `r:bug-hunter-ui` to a generic `r:bug-hunter`: only `r:bug-hunter-ui` has the `Skill` tool to invoke `/test-app` + `frontend-design`.

Per the subagent-flow non-negotiable: a returned report **is** the completion signal — don't poll it or watch for an output file. If a half comes to rest **without a usable report** (died, returned nothing, no confirmation line, or stalled past a short bounded wait), **re-dispatch it**, bounded to **2 re-dispatches**. **A half that stays dead makes the UI track incomplete, not clean** — carry the survivor's findings into triage, but never report the track as a clean bill. Reading one half as a full pass is the same phantom-clean failure Step 2b guards against for the hunters.

**8c — Teardown, and it is now the ONLY teardown.** Once **both** halves have returned — **on success, failure, OR stall**, and before triage — run it yourself:

```bash
${CLAUDE_SKILL_DIR}/scripts/worktree-deploy.sh" teardown
```

This is safe to call always: in a linked worktree it removes that worktree's ephemeral containers and volumes; in the main tree it is a deliberate no-op by design, so it never touches the main stack. Structure it as a `finally` around 8a–8b so a failed deploy or a dead half still reaches it.

**Neither half tears down, and that is deliberate.** With two agents sharing one stack, a half that ran teardown when *it* finished would delete the containers out from under its sibling, mid-run. So the orchestrator is the single owner of the stack's lifecycle, and no agent-side backstop is needed. (Worth knowing why one would otherwise matter: across 59 measured runs a hunter left to tear down after itself reached that step in only 21 of them — skipped nearly two thirds of the time.)

**8d — Triage.** You, the main agent, drop false positives in one line each. Keep the confirmed UI/runtime/design findings with their evidence (screenshot path, HTTP status, log line) and note which half reported each — a functional defect and a design defect go to different fixers.

**8e — Auto-resolve: fix minor, file major (no prompt).** If the verification came back **clean**, print a one-line pass summary and finish. Otherwise — and this is where Step 8 differs from the earlier steps — **don't stop to ask.** Step 8 *does* act on findings now, but it splits them: minor defects are fixed inline, anything bigger is filed as a GitHub issue. That split is exactly what keeps a large UI/design cycle from hijacking a turn that was about something else, while never interrupting the flow with a question.

Classify each confirmed finding **by the size and risk of its fix, not by the bug's severity:**

- **Minor** — surgical, low-risk, clearly scoped (a wrong redirect, a missing/incorrect CSS class, an obvious 500, a clipped element fixable with a small tweak). *Fix it now.* A serious bug with a one-line fix still counts as minor — small fixes are safe to fold in.
- **Major** — needs its own development or design cycle (a flow redesign, a responsive-layout overhaul, a design-quality rethink, a behavior change with broad blast radius). *File a GitHub issue, don't fix it this turn.* Reworking this inline would quietly turn a turn about something else into a UI project.

**Fix the minor ones.** Triage is already done; delegate to the matching domain subagent — UI/template/CSS → **`r:htmx-thymeleaf-dev`**, backend/runtime → **`r:java-backend-developer`** — briefed as surgical fixers (smallest diff, project conventions, no stray refactors). UI/runtime defects are runtime-proven, not unit-testable in the usual way, so the proof is the **re-verify**, not a JUnit test: rebuild (the **incremental** command from Step 1 + runner agent) until green, redeploy through the helper, and re-verify **once** — dispatching only the half that reported the defects, not both, since the other half found nothing to re-check. Bound it to this one loop — do **not** re-run Steps 2–7 (review / fixes / `/r:code-scan` / end-verify) from here. Anything still failing after that single re-verify is **escalated to a GitHub issue** (treat it as major) rather than looping or asking.

**File the major ones as GitHub issues.** Preflight GitHub once and cache the result: `gh auth status` must succeed **and** the repo must have a GitHub remote (`gh repo view` resolves, or `git remote get-url origin` points at github.com). When usable, create one issue per finding with `gh issue create`:

- **title** — concise, e.g. `[UI] checkout form returns 500 on valid coupon`.
- **body** (markdown) — where (route / `file:line`), what it does vs. what it should do, the evidence (HTTP status, log line), the **durable screenshot path(s)** `r:bug-hunter-ui` returned, and the suggested fix. GitHub can't embed a local screenshot path automatically, so reference the path and note the user can attach the image. Tag each responsive finding with the viewport it failed at (mobile/tablet).
- **label** — best-effort `--label bug`; if that label doesn't exist the create fails, so retry **without** `--label` rather than aborting.

Print the created issue URLs in the final summary. Writing long issue bodies can be delegated to a general subagent to keep your context lean.

**Fallback when GitHub isn't usable** (preflight failed — no `gh`, not authenticated, or no GitHub remote): log the major findings instead of losing them. `mkdir -p .claude/skills/test-app/bugs` and write **one grouped, self-contained HTML report** `.claude/skills/test-app/bugs/<YYYY-MM-DD>-ui-review.html` — for each finding: title + severity, where (route / `file:line`), what it does vs. what it should do, the evidence, and a suggested fix — with the captured **screenshots embedded** (copy them into a sibling `.claude/skills/test-app/bugs/assets/<slug>/` and reference relatively, or inline as base64). Writing the HTML can be delegated to a general subagent. Then tell the user GitHub wasn't available, so the findings were logged to that report instead.

## Non-negotiables

- **This routine never fires on its own — but it is reachable.** It runs on an explicit `/r:task-review`, or when `/r:task-run` reaches its post-task-review step and invokes it through the Skill tool. It does **not** run because a coding turn ended, a build went green, or a diff looked reviewable — that judgement belongs to the user or to `/r:task-run`, never to a model deciding a review "seems owed". The rule lives **here and in the skill's description, never in frontmatter**. `disable-model-invocation: true` is the wrong instrument: it doesn't distinguish "the model auto-loaded this" from "the model was explicitly told to run this", so it also blocks `/r:task-run`'s **mandatory** Step 5 — the pipeline's own caller cannot reach it, and the review it is required to run silently becomes something the user has to type by hand. Don't add it.
- **The pipeline is immutable — never edit or fork it, in either engine.** There is one pipeline with two encodings: the canonical `task-review.workflow.js` (run via the `Workflow` tool in the main thread — the normal path) and the prose Steps 0–9 (the fallback, run by hand in a main thread that has `Agent` but no `Workflow` — a headless/cron context). In the main thread, run the workflow *only* from the canonical `${CLAUDE_SKILL_DIR}/task-review.workflow.js` — never a copy, edit, inline `script`, or a `Workflow` call with any other `scriptPath`; a `PreToolUse` hook (the pack's `hooks/guard-workflow.py`) blocks forked invocations. **That guard can't reach the prose path** — there's no `Workflow` call to intercept there — so on that path the immutability is on you: run Steps 0–9 as written, don't improvise, reorder, or skip a step to "save time." A per-session redefinition of what "reviewed" means is never allowed in either engine, not even "just this once." **The two encodings describe the same graph and must change together:** editing the prose without the script (or vice-versa) silently makes the two runs diverge — so change the pipeline deliberately in *both* files (e.g. via `skill-creator`), never in one.
- **The build invariant is GREEN, and it is never relaxed.** The routine certifies a genuinely green build. If the build is red — **including a `main` that was already red before this change** — the routine STOPS (`stopped: build-red`) and surfaces it; it never tolerates known/pre-existing failures, never adds an "expected to fail" allowance, and never edits the pipeline or touches out-of-scope tests/code to force green. A red baseline is the user's to fix or quarantine on `main`; the review cannot certify green on top of it, and saying it's green when it isn't is the one thing this routine exists to prevent. The build→fix loop only ever fixes failures **this turn's change caused** — never a pre-existing or out-of-scope failure (that both bloats the PR and is the exact temptation that leads to forking the pipeline).
- **Real tools only.** Every step named after a tool runs that actual tool. Never substitute an LLM prompt that *imitates* a scanner, reviewer, or build — that misses real issues and invents fake ones. If a step can't run the real tool, stop and say so; don't fake it.
- **Missing prerequisite → STOP, don't skip.** `/r:code-scan` needs at least one of its analyzers (`pmd`, `spotbugs`, `semgrep`) plus `python3`; the `r:code-adversarial` skill needs the Codex CLI installed. If a prerequisite is **genuinely absent** — e.g. *none* of the analyzers are installed, or `run.sh` exits `3` — **stop and tell the user it's blocked** (point them at `brew install pmd spotbugs semgrep`); never silently skip and never fake the step. Two things are distinct from a hard block and are fine to continue through with a visible note: (a) only *some* analyzers installed — `/r:code-scan` runs the available subset and reports which category went uncovered; (b) a tool *installed but its run failed transiently* — the `r:code-adversarial` wrapper auto-retries, and if still blocked afterward (exit `4`) the routine degrades-and-continues. The failed/absent run is never faked and its blocked-text never reaches the fix-list.
- **Three tiers, chosen by evidence — depth scales, integrity doesn't.** **Light** is for a change that cannot alter behavior: it skips the up-front fan-out (Step 2). **Standard** is for ordinary work that can alter behavior, and is where an uncertain call lands: it runs a Codex `--mode review` pass over the diff plus the security and docs hunters, but not the `/r:code-bugs` pattern hunters, the up-front codex adversarial pass or `/r:code-quality`. **Full** runs everything, and is for a change whose approach deserves challenging, or that adds or alters auth, money, persistence, concurrency or security. The UI step (Step 8) is the one thing the tier does *not* govern — it is gated on `uiTouched` in all three, because a tier says how risky the change is, not whether a page changed. **No tier ever drops build + tests, mandatory `/r:code-scan`, or a real Codex read of the final diff** — nothing is faked, every tool that runs is the real one, and the tier + `uiTouched` are logged. Routing a risky change to a cheap tier is the one failure that matters here; routing an ordinary one to `full` is how a tier system stops meaning anything, which is why uncertainty goes to `standard` rather than up.
- **Find everything → fix everything → verify once (full tier).** All analysis is one parallel pass (Step 2): Codex + the four hunters + code-quality over the same diff, every track report-only, so triage (Step 3) sees the whole field before anything is touched. Fixes are one phase (Step 4). The single end-verify (Step 7) is what lets the routine skip per-step re-reviews safely: instead of re-reviewing after each mutation, it re-reviews the *final* diff once, bounded to two passes. That batches the cost — instead of a Codex pass and a build after every mutation, Codex runs once up front plus a bounded end-verify (≤2 passes), and the build runs **clean once** (Step 5) with every later rebuild incremental over it (Step 1).
- **Order is load-bearing, not ceremony.** The fix → build → `/r:code-scan` → rebuild → end-verify tail is sequential because each depends on the previous: `/r:code-scan` needs the post-fix bytecode for SpotBugs, and the end-verify must read the *final* code (after the scan's self-fixes) or it would miss exactly the machine-written changes it exists to catch. UI verification (Step 8) is dead **last** because it must exercise the final, fully-verified app — and it redeploys so the running process matches the diff. Don't reorder.
- **Subagent result = its return value; never poll, never leave one dead.** A subagent's result is the value the `Agent` tool returns (its final message); that return **is** the completion signal — when it arrives the subagent is done. Never wait on, re-check, or poll a subagent that has already returned, and never invent a side-channel done-marker / output-file / status-file to watch (no `Monitor`, no file-mtime polling) — inventing such a protocol is what makes a coordinator hang for minutes on a subagent that already finished. If a subagent comes to rest **without a usable result** (it died, returned nothing, or stalled past a short bounded wait), re-dispatch it — same type, scope, prompt — bounded to **2 re-dispatches**; after that, stop and say which one is blocked. Never silently proceed without it and never keep waiting. This governs every fan-out in this skill (Step 2a Codex, Step 2b the hunters, Step 2c code-quality, Step 8b the two `r:bug-hunter-ui` halves).
- **CLAUDE.md compaction is unattended but evidence-gated.** Step 9b runs `/r:claudemd-compact --auto` with **no confirmation**, but only behind the two-part gate (CLAUDE.md changed this turn **and** root > 200 lines) — never on every run. It may **only** delete a rule the codebase proves stale; anything unconfirmed is kept. The no-prompt behavior is intentional (so an autonomous `/r:task-run` isn't stalled); the evidence gate + the skill's mandatory verify pass + git-revertability are what replace the human approval, so it can't silently drop a valid rule.
- **UI verification auto-resolves without asking.** Step 8 never stops to ask the user how to handle findings. It classifies each by **fix size**: minor defects are fixed inline (then re-verified once), and ones that need their own development/design cycle are filed as **GitHub issues** (HTML-report fallback under `.claude/skills/test-app/bugs/` when GitHub is unavailable). That fix-size split — not a question — is what keeps a large UI/design rabbit-hole from being dragged into a turn that was about something else. The `r:bug-hunter-ui` agent itself stays report-only; the **orchestrator** is what acts on its findings.

## Step 9 — Record learnings, keep CLAUDE.md lean, log the run

**9a — Record.** Add anything worth remembering to the project's `CLAUDE.md` — gotchas, non-obvious behavior, architectural nuances uncovered while fixing. This is also what makes the compaction below worth doing: every review that learns something grows the always-on file a little, so the routine that *adds* to CLAUDE.md owns trimming it back.

**9b — Compact CLAUDE.md when it has actually grown bloated.** `CLAUDE.md` is loaded into context on essentially every turn, so an overgrown one is paid for on every future task. Run `/r:claudemd-compact --auto` to trim it — but only when it's **really required**, decided by a cheap two-part gate (both must hold, else skip silently with a one-line note):

```bash
ROOT="$(git rev-parse --show-toplevel)/CLAUDE.md"
CHANGED=$({ git diff --name-only; git diff --cached --name-only; } | grep -qx 'CLAUDE.md' && echo yes || echo no)  # did THIS turn touch it (incl. 9a)?
LINES=$([ -f "$ROOT" ] && wc -l < "$ROOT" || echo 0)
```

- **Gate 1 — CLAUDE.md changed this turn** (`CHANGED=yes`, which the 9a append usually makes true). If nothing touched CLAUDE.md, there's nothing newly grown to compact → skip.
- **Gate 2 — it's past the bloat threshold** (`LINES > 200`). Below that, compaction isn't worth the diff churn → skip.

When **both** hold, dispatch `/r:claudemd-compact --auto` in a **`general-purpose` subagent** (it needs the `Skill` tool to invoke the skill; wrapping it keeps the compaction's discovery/inventory bulk out of your context, and a subagent structurally can't prompt — which is what makes the run genuinely unattended). Brief it to run `--auto` over this repo's CLAUDE.md hierarchy and return the short after-the-fact report (root size before → after, what moved where, and the evidence-backed "Removed (stale)" list). Surface that report in the final summary.

**9c — Record one line of statistics.** Every tier and track decision in this routine was argued from mechanism, never measured — so no track can be retired on evidence, only on opinion. Fix that by appending one row per run:

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'PTR_STATS_JSON'
{"kind":"review","profile":"…","profileReason":"…","tracksBlocked":[],"fixedBySource":{…},"fixedCorrectness":0,"fixedReadability":0,"docDriftCount":0,"endVerify":"…","endVerifyCount":0,"security":"clean|scope-mismatch|blocked|not-dispatched","localScan":"…","scanChangedCode":null,"build":"…","findings":[{"track":"logic","verdict":"confirmed","fixed":true,"description":"file:line + the fix, one short line"},{"track":"security","verdict":"dismissed","fixed":false,"description":"…"}]}
PTR_STATS_JSON
```

`scanChangedCode` is `true`/`false` only when a scan actually completed (`localScan":"ok"`) and `null` otherwise. It is the only yield signal local-scan can produce — the scan applies its own fixes rather than feeding the fix-list, so it can never appear in `fixedBySource`, and a zero there says nothing about it. Do not send `false` for a scan that was blocked, skipped or never owed: that invents a quiet scan that never ran.

`fixedBySource` is the per-track counts from Step 3's fix-list, plus `end-verify` for anything the Step 7 passes handed to a fixer. In both cases a track is credited only when the fixer that received its finding actually **lived** (see Step 4): the number exists to retire a track on evidence, so it has to count fixes that happened, not assignments that were made. Everything else is the context needed to read it, since a track scores zero on a tier that never dispatched it.

`findings` is the other half, and the more decisive one — **one row per finding, including the ones you dropped** (that is what the Step 3 dropped list is for). A track whose findings are all rejected scores exactly the same zero in `fixedBySource` as a track that found nothing, and only the verdicts tell a noisy track from a quiet one. Use `confirmed` for what survived triage, `dismissed` for what you rejected, and `unresolved` for anything never adjudicated (doc drift, which the user owns). A **blocked** triage made no judgement at all: send no dismissals rather than an empty list that reads as "rejected nothing".

Two rules. **Short descriptions, never full finding bodies** — one line each, because the whole payload travels inside this step's prompt. And **it can never fail the run**: the script always exits `0`, and a row that doesn't get written is a lost row, not a failed review. Never retry it, never treat it as a blocked track.

Read it back any time with `python3 ${CLAUDE_PLUGIN_ROOT}/lib/skill-stats.py"` (add `--review` for this section alone, or `--backfill` once to recover past runs from transcripts — those have no attribution, so they're marked and excluded from the per-track table).

This is hands-free **by design** — no confirmation. Safety comes from `--auto`'s own contract, not a prompt: it prunes a rule **only** with hard codebase evidence that it's stale, keeps everything it can't confirm, and runs a mandatory verify pass that every still-valid rule survived — and it all lands in the diff, one `git revert` away. The subagent-flow non-negotiable applies: its returned report **is** completion; if it comes to rest without a usable report, re-dispatch bounded to 2, then note the compaction step is blocked and finish (a blocked compaction never blocks the routine — the review already happened).
