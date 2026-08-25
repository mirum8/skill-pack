// =============================================================================
// post-task-review — PROTOTYPE Workflow (deterministic orchestration)
//
// This encodes the /r:task-review pipeline as a hardcoded subagent graph.
// The reliability properties we hardened in the prose skill become STRUCTURAL
// here, because the control flow is real code the runtime executes:
//
//   * "never wait on a completed subagent / never poll an output-file"
//        -> agent() is awaited; the resolved promise IS completion. Nothing to poll.
//   * "no dead subagent blocks the flow; re-dispatch bounded to 2, then surface"
//        -> reliable() below: a real loop. null return (died) -> re-run -> sentinel.
//   * "bounded build loop / end-verify <=2 passes"
//        -> literal for-loops with caps, not a sentence a model may ignore.
//   * "teardown on ANY exit path"
//        -> try/finally around the UI hunter.
//   * "/r:code-scan is fail-closed; a failed scan is NOT clean"
//        -> an explicit status check in JS, not a judgement call.
//
// NOTE: Workflow scripts are pure JS orchestration — no shell/fs access. So every
// step that touches the repo (git, build, scan, codex, test-app) is done BY an
// agent whose prompt runs the commands and returns a schema-validated object.
//
// LOCKSTEP: this script is only ONE of two engines for this pipeline. The `Workflow`
//   tool is main-thread-only, so where it can't be reached the pipeline runs from the
//   PROSE Steps 0-9 in SKILL.md instead. The two encode the SAME graph and must be
//   edited TOGETHER - change one without the other and the two runs silently diverge.
//   As of Claude Code 2.1.217 subagents lost the `Agent` tool, so the prose engine is
//   only viable in a main thread that has `Agent` but no `Workflow` (headless/cron); a
//   context with NEITHER must STOP rather than improvise - SKILL.md states that floor.
//   BOTH engines spawn the hunters directly - this script from the workflow, the prose
//   engine from the main thread. Neither may nest them under a single find-bugs subagent,
//   because nothing below the orchestrator can fan out. Keep the engines agreeing here,
//   including WHICH hunters each tier dispatches (full: all four; standard: security +
//   docs only).
//
// TESTS: tests/control-flow.test.mjs executes this script with agent()/parallel() stubbed and
//   asserts the branches — what halts, what is retried, what reaches the summary. Run it after
//   every edit here; it is the only thing that catches a dead-track leak before a real run does:
//     node --test <pack>/skills/task-review/tests/control-flow.test.mjs
//
// HOW TO RUN (in a real project repo, from its root):
//   Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/task-review/task-review.workflow.js",
//              args: { packRoot: "${CLAUDE_PLUGIN_ROOT}" } })
//   or copy to .claude/workflows/post-task-review.js to register it as a named
//   workflow, then: Workflow({ name: "post-task-review" }).
// Optional args: { scope?: "diff"|"all", thorough?: boolean, deferCommit?: boolean,
//                  taskIntent?: string, profile?: "light"|"standard"|"full", uiTouched?: boolean }.
//   Omit `profile` unless the caller genuinely knows better than this diff does — Phase 0
//   classifies the tier from the diff it is about to review, which beats any guess made
//   before the code existed.
// =============================================================================

export const meta = {
  name: 'post-task-review',
  description: 'Review the diff: find, fix once, build, scan, verify, UI',
  phases: [
    { title: 'Triage',     detail: 'classify diff + tier + detect build tool' },
    { title: 'Review',     detail: 'codex + hunters; all 5 hunters and code-quality in full' },
    { title: 'Fix-triage', detail: 'one pass: real findings -> bucketed fix-list' },
    { title: 'Fix',        detail: 'domain subagent + /r:code-refactor' },
    { title: 'Build',      detail: 'build with tests, bounded retry' },
    { title: 'Local-scan', detail: 'fail-closed static scan + rebuild' },
    { title: 'End-verify', detail: 'bounded <=2 light Codex review passes; image pre-warm alongside' },
    { title: 'UI',         detail: 'deploy -> functional || visual (test-app + frontend-design), guaranteed teardown' },
  ],
}

// The pack root arrives from the caller, because ${CLAUDE_PLUGIN_ROOT} is
// substituted in skill markdown but not inside a workflow script the Workflow
// tool executes (FR-19). The SKILL.md invocation always passes it.
// The fallback is the placeholder itself, never an empty string: `args` may
// legitimately arrive as a bare source string, and an empty root would turn
// every sibling path into a plausible-looking /skills/... that silently points
// nowhere. Left as the placeholder it either expands or fails loudly.


// ----------------------------------------------------------------- schemas ---
const FINDINGS = {
  type: 'object', additionalProperties: false,
  required: ['ran', 'findings'],
  properties: {
    // false => the real tool did NOT run (blocked/degraded/failed exit). Without this field a
    // dead track returns findings:[] — byte-identical to a genuinely clean review — and the
    // orchestrator banks a phantom clean. UIRES.ran already worked this way; the read-only
    // review tracks did not, which is how a blocked Codex review certified nothing on #74.
    ran: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['file', 'line', 'category', 'what'],
        properties: {
          file: { type: 'string' }, line: { type: 'integer' },
          category: { type: 'string' }, what: { type: 'string' },
          real: { type: 'boolean' },
        },
      },
    },
    coverage: { type: 'string' }, // what this hunter actually read, and what it will not report
    // Did the hunter review the changeset it was HANDED, or one it resolved for itself? Every
    // hunter is pointed at one shared diff capture, and told to fall back to `git diff HEAD` only
    // if that file is missing or empty — so a hunter CAN come back alive, complete, and reporting
    // on a changeset this review does not certify. That report is real and it is about the wrong
    // code, which looks exactly like a clean one. Optional and read as `!== false`: an unanswered
    // field is a hunter that did not check, never a reason to invent a mismatch.
    scopeMatched: { type: 'boolean' },
  },
}
const TRIAGE = {
  type: 'object', additionalProperties: false,
  required: ['reviewNeeded', 'reason', 'profile', 'uiTouched', 'hasTestApp'],
  properties: {
    reviewNeeded: { type: 'boolean' },
    profile: { type: 'string', enum: ['light', 'standard', 'full'] }, // review tier — 'standard' absorbs uncertainty
    // WHY that tier, in one line. `profile` says which one and `profileForced` says who picked
    // it; neither says what decided it, so an over-rated run and a correctly rated one are the
    // same row and the distribution can be read but never audited. Deliberately NOT required,
    // like `securitySurface` above: an unanswered note is a gap in the record, never a reason to
    // fail a triage that answered everything else.
    profileReason: { type: 'string' },
    uiTouched: { type: 'boolean' },         // any frontend file changed -> the UI gate, in EVERY tier
    reason: { type: 'string' },
    changeIntent: { type: 'string' }, // 1-3 sentences: what this change is trying to do (fix subagents get it so they don't undo intentional work)
    buildTool: { type: 'string', enum: ['maven', 'gradle', 'none'] },
    buildCmd: { type: 'string' },           // CLEAN, certifying build — used once, for the run's first build
    buildCmdFast: { type: 'string' },       // incremental rebuild — every build AFTER the first one in this run
    runnerAgent: { type: 'string' },        // r:maven-build-runner | r:gradle-build-runner
    changedFiles: { type: 'array', items: { type: 'string' } },
    hasBackend: { type: 'boolean' },
    hasFrontend: { type: 'boolean' },
    hasTestApp: { type: 'boolean' },        // /test-app present ON DISK — the Phase 7 gate, folded in here to save a hop
    // WHAT KIND of app /test-app drives, READ off that skill's own marker line — never inferred
    // from this repo's file extensions. It selects the DEFINITION of uiTouched below and the
    // mechanism 7a deploys through; it is not a second gate, and it is not caller-forceable,
    // because a caller cannot know better than the file on disk and a forced surface is a way to
    // start the wrong thing. Deliberately NOT required, like `securitySurface`: the authoritative
    // read happens again in 7a, where the step that needs the answer looks for it itself.
    testAppSurface: { type: 'string', enum: ['web', 'tui', 'cli', 'unknown'] },
    // The project's written-intent docs, listed ONCE here instead of re-discovered by the docs
    // hunter on every run. Optional: an empty or missing list just means the hunter globs for
    // them itself, which is what it did before.
    docFiles: { type: 'array', items: { type: 'string' } },
    // Does the diff touch anything the security patterns could match? Deliberately NOT required,
    // and read as `!== false` below: an unanswered gate runs the hunter. A missing field must
    // never be the reason a security review was skipped.
    securitySurface: { type: 'boolean' },
  },
}
// Sources a correctness item can be attributed to. An ENUM, not free text: triage is labelling
// reports it was handed already keyed by track, not inferring, and an open string field would
// fill the stats sink with near-miss spellings that never aggregate.
const FIX_SOURCES = ['codex', 'security', 'docs', 'logic', 'runtime-and-failures']
// Triage is SPLIT by bucket — one agent per bucket, in parallel — so each returns only its own.
// The buckets never shared an input: correctness reads the hunter + codex reports, readability
// reads only code-quality, and docDrift is not triaged at all any more (it comes straight from the
// docs hunter, because it is a list handed to the user rather than a fix anyone applies).
// {item, source} rather than a bare string: without the source, every downstream count is
// "the review fixed 8 things" and no one can ever ask WHICH track found them — which is the
// only question that can retire a track for not earning its keep. The fixer is still shown
// `item` alone, so knowing who flagged it can't bias how it gets fixed.
const TRIAGED_ITEM = {
  type: 'object', additionalProperties: false,
  required: ['item', 'source'],
  properties: {
    item: { type: 'string' },                            // file:line + intended fix
    source: { type: 'string', enum: FIX_SOURCES },
  },
}
const CORRECTNESS_LIST = {
  type: 'object', additionalProperties: false,
  required: ['correctness', 'dismissed'],
  properties: {
    correctness: { type: 'array', items: TRIAGED_ITEM },
    // What triage REJECTED. A track that surfaces ten real defects triage throws away scores
    // exactly like a track that finds nothing, unless the rejections are recorded — so this is
    // the difference between retiring a track for being quiet and retiring it for being wrong.
    // It reaches the stats row and nothing else; the fixer never sees it.
    dismissed: { type: 'array', items: TRIAGED_ITEM },
  },
}
const READABILITY_LIST = {
  type: 'object', additionalProperties: false,
  required: ['readability', 'dismissed'],
  properties: {
    readability: { type: 'array', items: { type: 'string' } }, // always /r:code-quality
    dismissed: { type: 'array', items: { type: 'string' } },
  },
}
const BUILD = {
  type: 'object', additionalProperties: false,
  required: ['green'],
  properties: {
    green: { type: 'boolean' },           // true ONLY on a fully clean build (zero failures)
    failures: { type: 'string' },         // short combined log
    inScopeFailures: { type: 'string' },  // compile/test failures in code THIS turn changed -> fix these
    preExistingFailures: { type: 'string' }, // unrelated, reproduce on base -> NEVER fix, surface to user
  },
}
const SCAN = {
  type: 'object', additionalProperties: false,
  required: ['status', 'changedCode'],
  properties: {
    status: { type: 'string', enum: ['ok', 'error', 'skipped'] }, // fail-closed signal
    changedCode: { type: 'boolean' },
    reason: { type: 'string' },
    uncovered: { type: 'array', items: { type: 'string' } }, // skipped/errored tools
  },
}
const UIRES = {
  type: 'object', additionalProperties: false,
  required: ['ran', 'findings'],
  properties: {
    ran: { type: 'boolean' },                 // false => confirmation line was the ❌ form
    // Where a half that could NOT run says why. It exists so the blockage has somewhere to go
    // that is not `findings`: handed no such field, a blocked half writes its blockage as a
    // finding instead, and a finding is a thing this pipeline FIXES and RECORDS. That is not
    // hypothetical — a "VERIFICATION TRACK BLOCKED, /test-app is not installed" entry arrives
    // tagged fixSize=minor, is dispatched to the UI fixer as work, counted in minorFixed, and
    // stored as verdict=confirmed/fixed=true. It is the only ui-functional row the store holds,
    // which makes a blocked track read as a 100%-precision one. A blockage is the absence of a
    // judgement, and must never be recorded as one.
    blockedReason: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'where', 'fixSize'],
        properties: {
          title: { type: 'string' }, where: { type: 'string' },
          evidence: { type: 'string' }, screenshot: { type: 'string' },
          fixSize: { type: 'string', enum: ['minor', 'major'] }, // by fix size, not severity
          suggestedFix: { type: 'string' },
        },
      },
    },
  },
}
// The deploy is its own step now (Phase 7a), so it needs its own contract. `ok` is the gate the
// two verifier halves hang off: a deploy that didn't come up must never let them test stale code
// or, worse, whatever the previous run left running.
const DEPLOY = {
  type: 'object', additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    url: { type: 'string' },     // the helper-resolved BASE_URL — ephemeral in a worktree
    reason: { type: 'string' },  // one line, only when ok=false
    // /test-app is not on disk after all. Distinct from every other ok=false because it is an
    // absent PREREQUISITE, not a failure: the UI track is then SKIPPED, not blocked, and nobody
    // should go looking for a broken deploy.
    //
    // The check exists because a `test-app` DIRECTORY is not evidence of a `test-app` SKILL. The
    // skill is one SKILL.md beside gitignored artifacts it accumulates — e2e scripts, screenshots,
    // credentials — which stay behind when the definition does not, so the directory reads as a
    // live skill with no skill in it. Measured: one triage in four answers `hasTestApp` true over
    // that shape, and the run pays a pre-warm, an 86s docker deploy and both UI halves before the
    // halves report the file gone. This is the check that cannot be answered from impression: the
    // step that needs the file looks for the file.
    missing: { type: 'boolean' },
    // WHICH surface this deploy actually brought up, re-read from the skill's own marker at step 0b
    // below rather than taken from triage, which answered from a model's read of the same file.
    // Absent or 'web' => every branch below behaves exactly as it did before this field existed.
    surface: { type: 'string', enum: ['web', 'tui', 'cli'] },
    // The handle for a non-web surface: a tmux session name, or the absolute path of the built
    // binary. Deliberately NOT reported in `url` — a session name in a field called url becomes
    // `export TEST_APP_BASE_URL=ta-a1b2c3` and a verifier that then curls it.
    handle: { type: 'string' },
  },
}
// The shared diff every hunter reads (Phase 0b). Deliberately a PATH and a couple of counts, never
// the diff text itself: a schema field holding 40k characters of patch asks the model to re-emit it
// verbatim, and a hunter reviewing a silently paraphrased diff is worse than one that fetched its
// own. A file costs each hunter exactly one Read and cannot be transcribed wrong.
const DIFFPACK = {
  type: 'object', additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    path: { type: 'string' },     // absolute path to the unified diff
    files: { type: 'integer' },   // changed-file count, for the prompt
    lines: { type: 'integer' },   // line count of the patch, ditto
    reason: { type: 'string' },   // one line, only when ok=false
  },
}
// --------------------------------------------------------------- helpers -----
// The subagent-flow contract, in code: a null return means the subagent died /
// was skipped. Re-dispatch up to 2 extra times (3 total), then surface a blocked
// sentinel instead of hanging or silently dropping it. Never polls anything.
//
// A dead agent USUALLY resolves null, but it can also THROW — a StructuredOutput retry cap and an
// exhausted token budget both surface as a rejected promise. Untrapped, that ends the whole
// script rather than the step, which is never what this routine wants: a review that dies mid-way
// certifies nothing but looks like an infrastructure blip. A throw is the same event as a null
// return — the step produced nothing — so it earns the same bounded re-dispatch. It also restores
// the retries for reliable() calls nested inside parallel(), which converts a thrown thunk to null
// one level ABOVE this loop — untrapped, one throw there costs the step all three attempts at once.
async function reliable(label, phaseName, run) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let r = null
    try { r = await run(attempt) }
    catch (e) { log(`${label}: threw on attempt ${attempt}/3 — ${String(e && e.message || e).slice(0, 200)}`) }
    if (r !== null && r !== undefined) return r
    log(`${label}: no usable result (attempt ${attempt}/3) — ${attempt < 3 ? 're-dispatching' : 'surfacing as BLOCKED'}`)
  }
  return { blocked: true, label }
}
// A `*`-tools type: it needs the `Skill` tool to invoke a skill. It does NOT get the `Agent`
// tool — see HUNTERS below — so a GP agent here can DRIVE a skill but cannot fan subagents out
// beneath it. Any track whose skill depends on a fan-out has to be fanned out by this script.
const GP = { agentType: 'general-purpose' }
// A track is blocked when it DIED (agent() resolved to null/undefined), when the runner gave
// up on it (the reliable() sentinel), OR when the subagent reported that its tool never
// actually ran. All three must count: a track that failed still returns a well-formed
// {findings: []}, and reading that as "reviewed, nothing found" is precisely how an
// unattended run certifies a review that never happened.
//
// The null case is the one that leaks if this is written as `!!(x && …)`: that makes
// blocked(null) === FALSE, so every call NOT wrapped in reliable() reads a dead agent as a good
// result — a null end-verify has no findings and "converges", a null triage skips the whole
// review, a null fix-triage drops every finding on the floor. Nothing downstream treats
// blocked() as anything but
// "this track is bad", so counting a dead agent as blocked is correct at every call site.
// FR-22: an optional prerequisite that is simply absent. Distinct from blocked (a tool that
// died) and from clean (a review that ran and found nothing) — collapsing the three is how a
// step nobody ran gets reported as a step that passed.
const skipped = (x) => !!(x && typeof x.coverage === 'string' && /^SKIPPED\b/.test(x.coverage))
const blocked = (x) => !skipped(x) && (!x || !!(x.blocked || x.ran === false))

// Appended to every report-only track's prompt. The schema alone isn't enough — the subagent
// has to be told that an empty findings list is a CLAIM, not a safe default.
const RAN_CLAUSE = `
     Set ran=true ONLY if the real tool actually ran and produced a usable report. If it did
     not — a blocked/non-zero exit, an empty or degraded report, or you could not invoke it at
     all — set ran=false and leave findings empty. Never return ran=true with findings:[] for a
     run that failed: that reads as "reviewed, found nothing" and silently certifies nothing.`

// Appended to the prompts of steps that dispatch a BUILT-IN agent (general-purpose, Explore).
// The bundled agents under agents/ carry this rule in their own definition; the built-ins have no
// file to carry it, so their only channel is the dispatch prompt. Cost in a subagent is
// turns × context — every turn re-reads everything accumulated so far, a median of ~77k tokens —
// so a call that could have ridden along with the previous one pays a full re-read to return one
// grep. Measured over the stored transcripts, 22% of shell calls return under 200 characters.
const BATCH_CLAUSE = `
     Batch independent tool calls: when the next calls do not depend on each other's results —
     several greps, several reads, a \`git diff\` beside a \`git status\` — issue them in ONE
     block rather than one per turn. Calls that genuinely need a previous result stay serial.`

// ------------------------------------------------------- find-bugs hunters ---
// The hunters of /r:code-bugs Phase 2, spawned by THIS SCRIPT instead of beneath a single
// "run /r:code-bugs" subagent. Only the FULL tier dispatches all four: standard takes the two a
// Codex diff review cannot stand in for (see HUNTER_SET below), and light dispatches none.
//
// Why the shape differs from SKILL.md: workflow-spawned agents have no `Agent` tool. That is
// not a guess — across the whole local transcript history, 0 of 1158 workflow agents ever
// called it, and the ones that needed it (the find-bugs track among them) searched, failed,
// and wrote "No Agent-spawn tool is available", then read the diff in one context and returned
// it as a completed scan. Passing agentType:'general-purpose' does not change that. So a
// nested fan-out is structurally impossible here, and asking for one buys a silent single-
// context skim on EVERY run — the exact degradation SKILL.md calls a last-resort fallback.
//
// The script itself can spawn agents, so the fan-out lives one level up and the workflow plays
// the coordinator role that find-bugs' Phase 2 describes. As of Claude Code 2.1.217 ordinary
// subagents have no `Agent` tool either, so the prose engine in SKILL.md spawns these same
// hunters directly as well — the engines AGREE here. Keep them agreeing: whoever is
// orchestrating owns the fan-out, because no level below it can perform one.
//
// `refs` is where each hunter's pattern file lives; hunters read only their own file, which is
// what keeps four parallel reads cheap. r:bug-hunter-pattern has Bash/Glob/Grep/Read — enough to
// run `git diff` itself, and nothing else it would be tempted to reach for.
//
// WHY THE PATTERN HUNTERS ARE `r:bug-hunter-pattern` AND NOT `r:bug-hunter`. The agent has to agree
// with the job, or it quietly does the other one. `r:bug-hunter` is the /r:code-bugs single-bug
// investigator — "Reproduce Before You Fix", trace the data flow, ask clarifying questions — a
// persona that earns its cost by going deep on ONE thread, and it carries 13 tools, including MCP
// and Task tools a hunter never calls (0.0 uses per run) and WebSearch (0.1), all sitting in the
// prefix that every turn re-reads. These hunters do the opposite: a discovery sweep over a
// changeset, which the prompt below also says ("report-only, write no tests"). Point them at the
// investigator and the persona wins for the first dozen turns — measured over 151 stored `logic`
// runs, the median hunt reads TWELVE whole source files before it ever runs `git diff` and reaches
// the diff around turn 31 of 49. `r:bug-hunter-pattern` is the same reasoning depth with the sweep
// discipline and four tools. `r:bug-hunter` is right where reproduction IS the job — /r:issues-fix
// uses it for exactly that.
//
// PER-HUNTER EFFORT, and why the pattern hunters are not at the top tier. A pattern hunter is
// handed one reference file of known failure shapes and asked whether the diff matches any of
// them — real judgement, but bounded by the file it was given, which is a different job from
// deciding what is a false positive (fix-triage) or what "well-designed" means (code-quality).
// The measured yield says the same thing: logic returns 0.71 fixes per run over 24 runs and
// runtime-and-failures 0.31 over 16, against 0.79 for codex and 0.84 for the end-verify — both of
// which run at `medium` because CODEX does their thinking. `high` keeps the hunt and stops paying
// the top tier for a bounded pattern match.
//
// The `docs` hunter goes lower still, to `medium`, because its output is not a judgement the
// pipeline acts on: doc drift resolves to update-doc / update-code / confirm-intent, which is the
// USER's call, so these findings are surfaced and never auto-fixed. It is comparing the diff
// against written statements — a matching job, not an adjudicating one. (Its 0.00 fixes/run in
// the stats is NOT evidence against the track: the metric counts fixes, and this track is
// deliberately excluded from the fix-list. Retiring it on that number would be measuring the
// metric, not the hunter.)
//
// `security` is a pattern hunter like the other two and takes the same `high`. Pin it EXPLICITLY
// rather than letting it inherit: r:bug-hunter-pattern's own frontmatter already says `high`, so
// an unpinned row would RUN at the right depth for the wrong reason — nothing in this script would
// say so, and the control-flow test asserting `effort === undefined` would stay green on a lie.
// The pin is what makes the claim and the run agree, and what keeps the row where it is when the
// agent's own frontmatter moves.
const PATTERN_HUNT = { effort: 'high' }
// The docs hunter is the one track whose MODEL is pinned down, not just its effort. Every hunter
// agent carries `model: opus` in its own frontmatter, so an effort pin alone leaves the top model
// in place — correct for a track that adjudicates, wrong for this one. It compares a diff against
// written statements, its output is never auto-fixed (0.00 fixes/run BY CONSTRUCTION — doc drift
// resolves to update-doc / update-code / confirm-intent, which is the user's call), so a false
// positive costs a user one read rather than a wrong edit. Measured at 3.18M cache-read tokens over
// 52 turns per run, the second-most expensive hunter, for a matching job. Sonnet is the tier that
// fits. Keep the hunters that decide what is broken on the inherited model.
const DOC_HUNT = { model: 'sonnet', effort: 'medium' }
// A function, not a constant: PACK is resolved after the arg parser below, and this is only
// ever evaluated inside hunterPrompt() at dispatch time — long after that.
const refsDir = () => `${PACK}/skills/code-bugs/references`
// `concurrency` and `silent-failures` are ONE hunter, and the reason is how fan-out is billed:
// every extra subagent is a fresh context that re-reads the diff and the surrounding source from
// scratch, and with no shared prefix it re-writes its whole cache (a pattern hunter is measured at
// 1.53M cache tokens and 198s per dispatch over 32 runs). Two agents therefore cost roughly twice one
// for the same diff — while together these two return 0.37 fixes per run, the weakest pair in the
// pipeline. Keeping them merged keeps BOTH pattern files and both category sets, and pays the
// diff-reading cost once. Splitting a hunter is worth it when each half has enough to find that
// the second read pays for itself; these two do not.
//
// DON'T MERGE FURTHER — the saving is smaller than it looks, and it is not where the money is.
// Apart, concurrency and silent-failures cost 2.15M and 2.86M cache-read tokens per run; together
// as runtime-and-failures they cost 4.23M. That is ~15%, not the ~50% "one agent instead of two"
// suggests, because a merged hunter simply takes more turns (41/47 -> 57). Cost here is
// turns × context; an agent count is only a proxy for it. Folding `logic` in as well would risk
// the best-yielding pattern track (0.92 fixes/run) for another ~15%. The levers that actually pay
// are the ones below: a leaner agent, a hunt that reads the diff first and stops, and one shared
// diff so N hunters don't each orient themselves from scratch.
// `security` leads the list, and the position is load-bearing: the dedup below is
// first-hunter-wins by array order, three hunters now read the SAME diff against pattern files
// written in the same house style, and a boundary-validation hunk matches both `security.md` and
// logic-and-flow.md's boundary patterns. Whoever is listed first takes the attribution — and
// `fixedBySource.security` is the exact counter the retirement list reads, so losing those ties
// would keep scoring the track at zero for findings it actually made.
const HUNTERS = [
  { label: 'security', agentType: 'r:bug-hunter-pattern', ref: 'security.md',
    focus: 'Injection & Untrusted Input, Authentication & Authorization (including auth-relevant rate limiting), Secrets & Credentials, Sensitive Data Exposure — newly introduced and high-confidence exploitable only',
    // The one hunter whose empty result gets read as a verdict on the whole change, so its
    // 'coverage' has to state the boundary and not just the scope. Everything after "What NOT to
    // report" in security.md is a real risk this track does not own; the summary must be able to
    // say so, or findings:[] reads as "this change is secure".
    note: `'coverage' MUST name what you did NOT look for, not only what you read: this hunt is
     newly-introduced, high-confidence-exploitable issues only, and denial of service, resource
     exhaustion, capacity rate limiting, missing hardening and dependency CVEs are out of scope
     here (codex, the runtime-and-failures hunter and /r:code-scan cover those). An empty findings
     list is not a clean bill of health, and it has been read as one.`,
    ...PATTERN_HUNT },
  { label: 'logic', agentType: 'r:bug-hunter-pattern', ref: 'logic-and-flow.md',
    focus: 'Wrong Business Logic, Implementation Mistakes, Broken Flows', ...PATTERN_HUNT },
  { label: 'runtime-and-failures', agentType: 'r:bug-hunter-pattern',
    ref: ['concurrency-data-and-performance.md', 'silent-failures-and-java.md'],
    focus: 'Data Corruption, Concurrency Issues, Resource & Connection Issues, Performance & Scalability (N+1, unbounded fetches, pool exhaustion), Silent Failures, Language-Specific Patterns',
    ...PATTERN_HUNT },
  { label: 'docs', agentType: 'r:bug-hunter-docs', ref: 'documentation-consistency.md',
    focus: 'Documentation Consistency', ...DOC_HUNT },
]
// How each hunter gets at the change. Set once, right after triage, from the shared diff capture
// below; the value here is the fallback, used whenever there is no capture to point at — the
// capture failed, or the scope is the whole project rather than a diff. A `let` rather than a
// parameter because hunterPrompt() is called from three places and only ever renders one scan's
// worth of prompts, all after the capture is resolved.
let diffClause = 'Run `git diff HEAD` yourself, ONCE, to see the change — no prepared diff was handed to you.'
// Same idea for the docs hunter's OTHER input: the doc tree. Discovering it costs that hunter 25
// Bash calls and 141k characters of tool output per run, the most shell-heavy of the four, and
// triage is already walking this repo — so triage lists the docs once and they arrive here. The
// value below is the fallback for a triage that found none to hand over.
let docListClause = 'Locate the docs yourself with Glob over the filesystem (never `git ls-files` — doc files are often gitignored).'
const hunterPrompt = (h, scope) => {
  // The order and the budget are the point. Left to itself a hunter explores first and reads the
  // change late: measured over 151 stored `logic` runs the median one opens twelve whole source
  // files before it ever runs git diff, reaches the diff around turn 31, and finishes at turn 49
  // holding ~93k tokens of context. Cost here is turns × context, so that preamble — not the
  // reasoning, not the reference file, not this prompt — is the largest line item in the review.
  // The clauses below cost nothing and are worth about a dozen shell calls a run: a hunter that
  // re-derives a diff it was already handed produced no extra finding in any measured run.
  const common = `You are one hunter of a parallel bug scan over ${scope}.
     ${diffClause}
     Work in this order, and keep it tight:
       1. Read the change FIRST, before you open any other file.
       2. Judge each hunk against your patterns from the diff itself wherever that is possible.
       3. Only when a concrete candidate at a specific line cannot be settled from the hunk,
          open the source around it — Grep for the symbol, Read with offset/limit around that
          line. Don't read a file end to end, and don't open every file that mentions a name.
     Budget: about 12 tool calls. That is a budget, not a wall — a real candidate that needs a few
     more is worth them — but spend the overrun on THAT candidate, not on general orientation.
     If you run out with a candidate still unconfirmed, NAME IT in 'coverage' (e.g. "possible N+1
     at OrderRepo:88, not confirmed"). An honest short answer is worth more than either a silent
     drop or a padded report.
     Report ONLY findings you have HIGH confidence are actually broken — no style, no
     naming, no "could be better", no theoretical risks. Each finding: file, line,
     category, and 'what' = what the code does now vs what it should do + the production
     impact, in one line. Report-only: write no tests, fix nothing.
     Last, set scopeMatched — it is what tells this run whether you read the change it is
     certifying. true if the diff you actually judged is the one named above; false if you ended
     up on a different changeset (the prepared capture was missing or empty and your own git
     command resolved somewhere else), and then name BOTH in 'coverage'. A complete report about
     the wrong diff looks exactly like a clean one, which is the whole reason this field exists.
     Leave it unset if you did not check — an unanswered field invents no mismatch.${RAN_CLAUSE}`
  if (h.label === 'docs') {
    return `You are the DOCUMENTATION-CONSISTENCY hunter of a parallel bug scan over ${scope}.
     ${diffClause}
     Read ${refsDir()}/${h.ref} for what to look for. Run in DIFF mode: compare only the changed
     code against the project's written intent — spec.md/spec.html, todo.md, docs/*,
     DESIGN.md/ui-design.md, the **/CLAUDE.md hierarchy incl. nested module rules, README/ARCHITECTURE.
     ${docListClause}
     Report divergences plus violations of stated CLAUDE.md rules. Use category
     'doc-drift' for every finding, and put the doc side (file + quoted statement) and the
     suggested resolution (update doc / update code / confirm intent) in 'what'. These are
     user decisions, not bugs to fix. "No documentation found to check against" is a valid
     result — return ran=true with findings:[] in that case.${RAN_CLAUSE}`
  }
  // A hunter may own more than one pattern file (see the note on HUNTERS: merging two thin
  // hunters pays the diff-reading cost once). Read them all, then hunt every category in one
  // pass over the same diff — the files are separate lists of failure shapes, not separate jobs.
  const refs = Array.isArray(h.ref) ? h.ref : [h.ref]
  const refList = refs.map((r) => `${refsDir()}/${r}`).join(' and ')
  return `Read ${refList} — those are the patterns you own; read ${refs.length > 1 ? 'those files' : 'only that file'}
     and no other reference file.${refs.length > 1
       ? ` They are ${refs.length} lists of failure shapes for ONE hunt: make a single pass over the diff
     looking for anything in any of them, rather than separate passes. Weight them by what the change
     actually does — a diff with no shared state or threading has little for the concurrency
     patterns, and a diff full of swallowed exceptions has a lot for the silent-failure ones.`
       : ''}
     Your categories: ${h.focus}.${h.note ? `\n     ${h.note}` : ''}
     ${common}`
}
// Fan the hunters out, then merge. WHICH hunters is a tier decision (see HUNTER_SET below), so
// this takes the list rather than reading HUNTERS directly. `ran` is true only when every hunter
// THIS TIER DISPATCHED reported: a partial scan that reports ran=true is a phantom clean. A
// blocked hunter therefore marks the TRACK incomplete (blocked() picks it up, and it lands in
// tracksBlocked) while the surviving hunters' findings still flow into triage — degrade to fewer
// hunters, never silently to a claim of full coverage. `trackName` is what the log calls the
// track: at standard this is NOT find-bugs, and saying "find-bugs is incomplete" about a scan
// that was never dispatched as find-bugs would send someone looking for a failure that isn't one.
async function hunterFanOut(scope, hunters, trackName) {
  const hunts = await parallel(hunters.map((h) => () =>
    reliable(`find-bugs:${h.label}`, 'Review', () => agent(
      hunterPrompt(h, scope),
      // h.effort is per-hunter (see HUNTERS): the three pattern hunters run at `high` and docs at
      // `medium`, so nothing here inherits its depth from the caller. Spread conditionally so a
      // hunter with no effort of its own still inherits rather than being pinned to undefined.
      { label: `find-bugs:${h.label}`, phase: 'Review', schema: FINDINGS, agentType: h.agentType,
        ...(h.effort ? { effort: h.effort } : {}) }))))
  const missing = hunters.filter((h, i) => blocked(hunts[i])).map((h) => h.label)
  if (missing.length) {
    log(`${trackName}: hunter(s) BLOCKED — ${missing.join(', ')}. The scan is INCOMPLETE; ` +
        `the other hunters' findings are still carried into triage, but this track is not a clean bill.`)
  }
  // A hunter can come back ALIVE and having read the wrong thing. Every hunter is pointed at one
  // shared diff capture and told to derive the change itself only if that file is missing or
  // empty — and that fallback can land on a different changeset (a hunter's own `git diff` on a
  // branch resolves differently from the capture). The report is then real, complete, and about
  // code this review is not certifying. Same conclusion as a blocked hunter — the scan did not
  // cover this diff, so `ran` must not claim it did — but its OWN log line, because the two need
  // opposite fixes: a blocked tool has to be made to run, a drifted one has to be made to read
  // the right thing, and re-running a drifted hunter unchanged reproduces the same wrong answer.
  const drifted = hunters
    .filter((h, i) => !blocked(hunts[i]) && hunts[i] && hunts[i].scopeMatched === false)
    .map((h) => h.label)
  if (drifted.length) {
    log(`${trackName}: hunter(s) reviewed a DIFFERENT changeset than the one they were given — ` +
        `${drifted.join(', ')}. Their report is real but it is not about this diff, so this track ` +
        `is NOT a clean bill. See the coverage note for what each one actually read.`)
  }
  const seen = new Set()
  const findings = []
  hunts.forEach((h, i) => {
    if (!h || !Array.isArray(h.findings)) return
    for (const f of h.findings) {
      // Two hunters flagging the same line with the same description is one finding. Distinct
      // descriptions at one line stay distinct — different bugs do collide on a line.
      const key = `${f.file}:${f.line}:${String(f.what || '').slice(0, 60).toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      // Stamp WHICH hunter found it, here, at the only point that still knows. After this merge
      // a security finding and a logic finding are indistinguishable, and the whole point of the
      // stats sink is being able to ask which track actually earns its keep. First hunter to
      // report a given line wins the attribution — the dedup above already picked that one.
      findings.push({ ...f, source: hunters[i].label })
    }
  })
  const secIdx = hunters.findIndex((h) => h.label === 'security')
  const sec = secIdx >= 0 ? hunts[secIdx] : null
  // Three different states share one empty findings list, and they mean opposite things.
  // Whoever reads this summary must be able to tell them apart without the transcript.
  // Never in front of a SKIPPED marker: skipped() tests this string with an anchored ^SKIPPED,
  // and a prefix there would turn "the hunter was never dispatched" into "the track ran".
  const secCov = (sec && typeof sec.coverage === 'string') ? sec.coverage : ''
  const secDrift = drifted.includes('security') && !/^SKIPPED\b/.test(secCov)
  const securityNote = secIdx < 0
    ? 'security hunter NOT DISPATCHED — no security surface in this diff. Nothing was ' +
      'security-reviewed. This is a skip, not a clean bill.'
    : (secDrift ? 'security hunter SCOPE MISMATCH — it judged a different changeset than this ' +
                  'diff; nothing security-reviewed THIS change. ' : '') +
      (secCov ||
       (missing.includes('security') ? 'security hunter BLOCKED — nothing was security-reviewed' : ''))
  // Every hunter's coverage note survives the merge, not just the security one. The hunt is
  // budgeted, and a hunter that runs out with a candidate still unconfirmed says so here. Dropping
  // that turns "I could not confirm the N+1 at OrderRepo:88" into silence, and silence from a
  // finding track reads as "looked, found nothing" — the one thing this pipeline must never
  // manufacture. The security note leads, so skipped()'s ^SKIPPED test still sees what it needs.
  const notes = hunts.map((h, i) =>
    (hunters[i].label !== 'security' && h && typeof h.coverage === 'string' && h.coverage.trim())
      ? `${hunters[i].label}: ${h.coverage.trim()}` : '').filter(Boolean)
  return {
    ran: missing.length === 0 && drifted.length === 0,
    // Which hunters produced that `ran`, and by which of the two failures. `ran` deliberately
    // collapses them — every caller that must not treat this as a clean bill reads it and needs
    // no more — but the RECORD must not, because the two need opposite fixes: a blocked tool has
    // to be made to run, a drifted one has to be made to read the right thing. Collapsed into one
    // `tracksBlocked: ['find-bugs']`, a drifted hunter reads as "the bug scan failed" and sends
    // someone looking for a broken tool that isn't broken — while the hunters that did complete,
    // and the findings they produced, are invisible.
    blockedHunters: missing,
    driftedHunters: drifted,
    findings,
    coverage: [securityNote, ...notes].filter(Boolean).join(' | '),
    // The security half's own outcome, carried out separately because the merged `ran` and
    // `coverage` cannot separate the four states that all leave findings:[] behind. Without it a
    // run of empty security results cannot say whether the diffs were clean or the track never
    // reports anything — the question 49 recorded dispatches of the previous tool could not answer.
    security: secIdx < 0 ? 'not-dispatched'
      : missing.includes('security') ? 'blocked'
      : drifted.includes('security') ? 'scope-mismatch' : 'clean',
  }
}

// Effort tiers. The skill's frontmatter sets effort:high, which every subagent would otherwise
// inherit — including ones whose whole job is running a shell command. Depth belongs where the
// JUDGEMENT is, and the test is not "does this step matter" (they all do) but "does THIS AGENT
// decide anything?". A wrapper around a tool that decides for it does not; nor does a fixer whose
// finding was already judged real by someone else. What still inherits is the set that forms an
// opinion nothing downstream re-forms: code-quality, fix-triage (which decides what is a false
// positive), /r:code-scan's own triage of its findings, and the readability refactor. The hunters
// are pinned at that same depth rather than left to inherit it — see the PATTERN_HUNT / DOC_HUNT
// note above HUNTERS for why the pin is load-bearing even where the number matches.
//
// A second reason to pin rather than inherit: the frontmatter only applies when this skill is
// entered through the Skill tool. Called by scriptPath — which /r:issues-fix does for every group
// — nothing sets it, and these agents silently take the SESSION's effort instead. Pinning makes the
// review's depth a property of the pipeline rather than of how it happened to be invoked.
// Run one fixed command and report what it printed. No branch, no classification, no prose —
// whatever decides anything about the result decides it in THIS script, not in the agent. These
// pinned effort but not MODEL, so a step marked "nothing to decide" was still running whatever the
// session was on; through a /r:task-run chain that is Opus, to run `worktree-deploy.sh teardown`.
const ECHO = { model: 'haiku', effort: 'low' }
// Cheap, but not the echo tier: it composes prose (a markdown issue body) and merges it into a
// file that may already have items in it.
const MECHANICAL = { model: 'sonnet', effort: 'low' }
// The build runner AGENTS (r:maven-build-runner, r:gradle-build-runner) are `haiku`, which is right
// for what they do on almost every dispatch: run one command and report "BUILD SUCCESSFUL". This
// call is the exception, and it steps the model back up over the agent's own tier. On a RED build
// it must split the failures into inScopeFailures and preExistingFailures, and that split is
// load-bearing in both directions: wrongly "pre-existing" HALTS the run (stopped:
// 'build-red-preexisting') on a failure the fix phase should have taken, and wrongly "in-scope"
// sends a fixer to edit somebody else's failing test, which the pipeline forbids outright. Paying
// for a bigger model on every build to protect the red path is the trade here; the green path is
// most of them and costs the same either way, because the model only matters once there is
// something to classify.
const BUILD_RUN = { model: 'sonnet', effort: 'medium' }
// The post-local-scan rebuild is a build too, and it has nothing to CLASSIFY: the tree was fully
// green before local-scan ran, so the prompt can tell it that any failure here is in-scope by
// construction. That is the judgement BUILD_RUN steps up to protect, and it is already made — but
// this call still makes the other one, green or red at all, and here that is the more consequential
// of the two: a red halts the run outright and strands the diff, where in phase 4 it only opens a
// fix loop. On the runner agents' own `haiku` tier that verdict comes from whatever the log looks
// like; the tier below is what reliably captures `$?` instead. Three dispatches per review at most,
// so buy it.
const REBUILD_RUN = { model: 'sonnet', effort: 'medium' }
// The UI deploy is not a build runner at all — it is a GP agent reading a command out of a skill
// file and running a helper. It has its own tier so a change to BUILD_RUN above, which exists for
// a judgement this step does not make, cannot move it by accident.
const DEPLOY_RUN = { model: 'sonnet', effort: 'medium' }
// The Codex tracks (`codex`, every `end-verify` pass) shell out to the real Codex CLI, wait, and
// parse the report it produces. CODEX does the reviewing; the wrapper's own reasoning adds nothing
// to the critique, and it was paying the top tier on every standard and full run plus up to two
// end-verify passes. run-task pins its own Codex agent at exactly this tier for exactly this
// reason. Not `low`: this agent owns the background-collection protocol whose failures show up as
// false "the review could not run" blocks, and that is the wrong place to save 20 seconds.
const CODEX_RUN = { effort: 'medium' }
// Phase 0 reads the diff into a schema — changed files, build tool, reviewNeeded — plus ONE real
// judgement: the tier. Same shape as run-task's `source` step, which is pinned here too. The tier
// is also the most recoverable decision in the pipeline: an under-rated diff still gets the build,
// /r:code-scan and a Codex end-verify, and the caller can force a tier outright.
const TRIAGE_RUN = { effort: 'medium' }
// A fixer is handed a finding, a file and a line, and told to make the smallest change that fixes
// it. That is strictly less than an implementer, which follows a whole plan — so the implementers'
// pinned depth is the CEILING here, never a floor to sit above: a patch applied deeper than the
// code it patches was written is depth spent on the wrong step. run-task pins them at `medium`
// (see IMPL_RUN there, and read `implement depth` in lib/skill-stats.py before moving either).
// What that removes is reasoning on work whose hard thinking — is this finding real, what should
// change — already happened in triage, which is why this is deliberately NOT applied to
// fix-triage, where that thinking lives.
//
// It is the pack's second-largest block of tokens after the implementers themselves: ui-fix-minor
// 583M over 61 runs, fix-correctness 487M over 50, end-verify-fix 238M over 42. A fixer that is
// too shallow is also the most VISIBLE failure in the pipeline — a bad patch fails the build, then
// end-verify, then the next review reports it — so a regression here surfaces in a run or two
// rather than hiding in the diff.
const FIX_RUN = { effort: 'medium' }
// The UI verifiers are a JUDGING track that must not be pushed any deeper. Measured over 59 stored
// r:bug-hunter-ui transcripts: 66% of their wall time was model time, spread over a median of 86
// turns (p90 144) at ~4.2s of thinking each — and the large majority of those turns drive a browser
// or read a page, not adjudicate a defect, so every extra second of thinking is paid mostly on the
// mechanical majority. `high` keeps the judgement that decides "is this a real problem or an
// intentional design choice". Deliberately NOT MECHANICAL: these agents still have to make that
// call.
const VERIFY = { effort: 'high' }

// ================================================================ pipeline ===
// Tolerant arg parsing. The Workflow tool passes `args` VERBATIM and its docs ask callers for a
// real JSON value — but callers hand over a JSON *string* almost every time (across the local
// transcript history: 0 object args, 39 string ones, 26 of them carrying deferCommit). A string
// reads back as `undefined` for every option, which is how EVERY run of this pipeline lost
// `deferCommit` and let the Step 4b refactor make its own commit in the middle of a /r:task-run
// that was supposed to land exactly one commit at the end. Silent, and invisible in the result.
// So parse defensively, and never let a malformed arg take the review down:
//   - valid JSON object  -> use it
//   - anything else      -> {}, i.e. run with defaults. There is nothing to recover from a
//                           malformed arg here (unlike run-task-implement, where a bare string
//                           is unambiguously the task source), and a review that runs with
//                           defaults is strictly better than one that dies on a SyntaxError.
const opts = (() => {
  if (typeof args === 'string') {
    try {
      const v = JSON.parse(args)
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    } catch { return {} }
  }
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {}
})()

// --- Where the pack lives, and why this is a HALT ----------------------------
// Seven things hang off this: both Codex tracks (run.sh), the deploy and teardown helpers, the
// hunters' reference files, and the stats sink. It has to come from the CALLER, because
// ${CLAUDE_PLUGIN_ROOT} is substituted in skill MARKDOWN and nowhere else — not inside a workflow
// script the Workflow tool executes, and not in a subagent's shell, where the variable is unset and
// bash expands it to the empty string.
//
// Read it off `opts`, NEVER off the raw `args` above the tolerant parser. A test like
// `(args && typeof args === 'object' && args.packRoot)` looks equivalent and is not: callers hand
// over a JSON *string* almost every time — 0 object args against 39 string ones across the stored
// history — and a string fails that typeof, so packRoot goes missing even when it WAS passed.
//
// And do not fall back to the placeholder itself on the reasoning that it "either expands or fails
// loudly". Neither half holds. It does not expand, and it does not fail loudly: `python3
// /lib/record-run.py` is a plain not-found, and the one track that surfaces it is the stats
// sink — best-effort by design, so the row is lost in silence while every other path is equally
// broken. A run that cannot locate its own tools must stop before it certifies anything.
const PACK = (() => {
  const p = typeof opts.packRoot === 'string' ? opts.packRoot.trim() : ''
  // An unsubstituted placeholder is ABSENT, not a path — that is a caller who copied the
  // invocation out of the markdown without the substitution happening.
  return (!p || p.includes('CLAUDE_PLUGIN_ROOT')) ? '' : p
})()
if (!PACK) {
  log('post-task-review: no usable `packRoot` in args — the pipeline cannot locate run.sh, the ' +
      'worktree-deploy helper, the hunters\' reference files or the stats script. Stopping rather ' +
      'than running with every tool path resolving under "/". Pass packRoot: "${CLAUDE_PLUGIN_ROOT}" ' +
      'from the skill markdown, where that placeholder is actually substituted.')
  return { stopped: 'no-pack-root' }
}

const scope = opts.scope === 'all' ? 'whole project' : 'the current git diff (working tree + staged)'
// Ordered cheapest -> deepest. 'standard' exists because the gap between light and full was so
// wide that every change able to alter behavior had to be routed to full, which made full the
// answer for almost everything and the tier system decorative.
const TIERS = ['light', 'standard', 'full']
// What this change set out to do. /r:task-run passes it as { taskIntent }; every fix subagent
// then gets it so it won't "fix" (undo) something the change did on purpose — the recurring
// "subagent contradicts the intent" failure. When the caller omits it, triage infers it below.
const taskIntent = (opts.taskIntent || '').trim()
// When the caller defers committing (e.g. /r:task-run lands the whole task as one
// commit at the end), the readability refactor must NOT make its own commit.
const commitClause = opts.deferCommit
  ? 'in the working tree WITHOUT committing — the caller will commit everything once at the very end'
  : 'as a behavior-locked, separate commit'

// --- Phase 0: triage + build-tool detection (deterministic gate) -------------
phase('Triage')
const triage = await reliable('triage', 'Triage', () => agent(
  `You are Step 0+1 of /r:task-review. From the repo root:
   1. Run git diff to get changed files for ${scope}.
   1b. Make UNTRACKED source files visible to the diff: run \`git add -N\` (intent-to-add)
       on any untracked changed source files. Otherwise every diff-scoped track — the hunters,
       codex, /r:code-scan — silently sees NOTHING for a brand-new file, which is exactly where a
       new endpoint lands. Intent-to-add stages no content and is reversible (\`git reset\`).
   2. Decide reviewNeeded: false ONLY if every changed file is doc/config-only
      (*.md,*.txt,docs/**,LICENSE,.gitignore,images). Any source/build/runtime-config
      file => true. A comment/format-only edit inside source still => true.
   3. Detect the build tool and return BOTH build commands — the run does exactly ONE clean
      build (the first) and every rebuild after it is incremental over that same run's output:
        pom.xml        => buildTool 'maven',  buildCmd \`mvn clean package\`,   buildCmdFast \`mvn package\`,      runnerAgent r:maven-build-runner
        build.gradle*  => buildTool 'gradle', buildCmd \`./gradlew clean build\`, buildCmdFast \`./gradlew build\`, runnerAgent r:gradle-build-runner
        neither        => buildTool 'none'
      Do NOT add parallelism flags (-T, --parallel, --build-cache): a non-thread-safe plugin
      would turn them into a flaky false-red, which halts the whole routine.
   4. Set hasBackend (*.java/*.kt changed) and hasFrontend (templates/css/js changed).
   4b. hasTestApp — run
       \`test -f "$(git rev-parse --show-toplevel)/.claude/skills/test-app/SKILL.md" && echo yes || echo no\`.
       true iff the file is present ON DISK right now — that is all the Skill tool needs to load
       /test-app; whether git tracks it on this branch is irrelevant (a locally-scaffolded,
       gitignored test-app counts). A stale worktree where it was never checked out naturally
       reports no, so no git/branch reasoning is needed. This is the Phase 7 gate, answered here
       so the pipeline doesn't spend a whole subagent round-trip on one \`test -f\` later.
   4d. testAppSurface — WHAT KIND of app that /test-app drives. Do NOT judge this from the repo.
       READ it, with one command over the file you just tested for:
         grep -m1 -oE 'test-app-surface: (web|tui|cli)' \
           "$(git rev-parse --show-toplevel)/.claude/skills/test-app/SKILL.md" | cut -d' ' -f2
       Answer whatever it prints. If it prints NOTHING the skill predates the marker: answer 'web'
       when the file names a base URL (\`grep -q BASE_URL\` on the same file), and 'unknown'
       otherwise. Omit the field entirely when hasTestApp is false. This is a read, not a
       judgement — do not reason about the project, and do not run the app to find out.
   4c. docFiles — the project's written-intent docs, as repo-relative paths: spec.md/spec.html,
       todo.md, docs/**, DESIGN.md/ui-design.md, README.md/ARCHITECTURE.md/CONTRIBUTING.md, and
       EVERY **/CLAUDE.md (root and nested module ones). Glob the FILESYSTEM, not git — these are
       often gitignored, so \`git ls-files\` would silently miss them. One \`find\`-style pass is
       enough; do not read them. Cap the list at ~40 entries, closest to the changed files first.
       You are already walking this repo, and the docs hunter would otherwise re-discover the same
       tree on every run (measured: 25 shell calls per dispatch). Return [] if the project has none.
   5. changeIntent — 1-3 sentences on what this change is trying to accomplish. The later fix
      subagents use it to avoid "fixing" (undoing) something intentional, so it must be accurate.
      If a caller-provided intent is given below, echo it back verbatim as changeIntent. Otherwise
      INFER it from the diff, any \`.task-plans/*.md\` plan file at the repo root, and recent
      commit messages (\`git log --oneline -5\`).
      Caller-provided intent: ${taskIntent ? JSON.stringify(taskIntent) : '(none — infer it)'}
   6. profile — classify the DIFF as 'light', 'standard' or 'full'. You have the real diff in
      front of you, so judge what the change DOES, not what the files around it happen to contain.
      Work the tree in order:
        a. Can the change alter behavior for any real input?        no  -> 'light'
        b. Does it carry a design decision — a new/changed approach, several seams, a data model
           or a contract — OR does it add or alter auth/permissions, money/pricing/tax math,
           persistence (a schema change, migration or index; locking or transaction semantics;
           a query whose result shape callers depend on), concurrency/locking, or
           security-sensitive code (crypto, input parsing, file/network IO, deserialization,
           secrets, headers)?                                       no  -> 'standard'
        c. otherwise                                                    -> 'full'
      READ THE PERSISTENCE ARM NARROWLY: schema, migration, index, locking — what you cannot
      simply revert. An ordinary read-only query, a repository/port method over an existing
      table, or a field plus its mapping is NOT that arm; it is 'standard'. Counting every
      query sends every feature in a JPA/ORM diff to 'full' — measured over 52 real runs,
      'standard' was chosen ZERO times.
      Calibrate: a getter, a constant/config VALUE tweak, a log message, a rename, formatting, a
      comment or a cosmetic template/CSS change is 'light'; a bug fix inside one method, a
      two-line null check, a new field plus its mapping, a new endpoint over an existing service,
      a new read-only query over an existing table plus what renders it
      is 'standard'; a migration, an auth-rule change, money math, a read-modify-write that needs
      a lock, or a change spanning several
      seams is 'full'. Scary wording alone doesn't force 'full' (a copyright-year bump in a
      template is light); "small" wording alone doesn't earn 'light' (a one-line auth-role change
      is full). When you are unsure, answer 'standard': it keeps a real Codex read of the diff
      (--mode review), the security hunter, the docs hunter,
      static analysis and build+tests, and only gives up the other pattern hunters plus
      the up-front adversarial + readability passes. A caller-provided profile OVERRIDES your call
      — echo it if given. Caller-provided profile: ${TIERS.includes(opts.profile) ? opts.profile : '(none — classify it)'}
      Then set profileReason: ONE line naming what actually decided it — the file, seam or
      operation you weighed, not a restatement of the tier. "it is a full change" is not a reason;
      "read-modify-write on DealRepo with no lock" is. It is recorded and read back later to check
      whether this classification holds up, so give the evidence rather than the verdict. Echoing
      a caller-provided profile is itself a reason — say so.
   7. uiTouched — does this diff change WHAT THE APP RENDERS? Which files those are depends on
      the surface you READ in 4d, and on nothing else:
        * 'web', 'unknown', or unanswered — true iff any changed file is frontend: *.html/templates,
          *.css/*.scss, *.js/frontend *.ts, or under templates/, static/, resources/templates/,
          webapp/.
        * 'tui' or 'cli' — true iff a changed file DRAWS or DRIVES the terminal interface: the
          view / render / widget / screen layer, the key bindings and the event loop, the printed
          output and its formatting, the flag parsing and the help text. A change under the data,
          storage, network or parsing layers is NOT that, even in a single-binary repo where all
          of it lives in one tree. Do not fall back to "it is a terminal app, so everything
          renders" — that turns the most expensive gate in the pipeline permanently on.
      Answer this carefully: it is the SOLE gate on the UI/runtime step in EVERY tier (the tier
      does not force it), and that step is the single most expensive thing in the pipeline —
      a false 'true' boots the whole stack and drives a browser for nothing, a false 'false'
      ships a rendered change that nothing looked at.
      Caller-provided uiTouched: ${typeof opts.uiTouched === 'boolean' ? opts.uiTouched : '(none — determine it)'}
   8. securitySurface — does this diff touch anything the security patterns could match?
      true if ANY of: auth / permissions / session / CSRF, a new or changed HTTP endpoint
      or controller mapping, upload or file/path IO, SQL/JPQL/native queries or a migration,
      crypto / secrets / tokens / credentials, deserialization or parsing of untrusted input,
      raw/unescaped template output (th:utext, innerHTML, eval), outbound network calls, or
      security/framework configuration. false only when the change is plainly none of those —
      copy and CSS, a log message, a rename, a badge count, a test-only edit.
      This gate exists because the security hunt is a full parallel subagent — 1.53M cache
      tokens and about 200s — and on a diff of text wrapping and notification counts there is
      nothing in its pattern file to match. Answer conservatively — when in doubt say true.
      Every hunk it never reads is a hunk nothing looked at. A skipped security review is a
      coverage hole, so it must be earned by a diff that genuinely has no security surface, not
      by a guess. If you cannot tell, omit the field: an unanswered gate runs the hunter.
   Return the structured result.`,
  { label: 'triage', schema: TRIAGE, ...GP, ...TRIAGE_RUN }
))
// A DEAD triage and a diff that genuinely needs no review are opposite outcomes, and they used
// to return the same `{skipped: true}`. That is the worst failure this pipeline has: an
// unattended caller (/r:issues-fix) reads `skipped` as "reviewed, nothing owed" and goes on to
// merge the branch and close the issue on a review that never started. Blocked => STOP.
if (blocked(triage)) {
  log('post-task-review: TRIAGE BLOCKED — nothing classified the diff, so nothing was reviewed. This is a halt, not a skip.')
  return { stopped: 'triage-blocked' }
}
if (!triage.reviewNeeded) {
  log(`post-task-review: nothing to review — ${triage.reason}`)
  return { skipped: true, reason: triage.reason }
}

// The authoritative intent for the fix phase: caller-provided wins, else what triage inferred
// from the diff/plan. Every fixer/triage subagent gets `intentBlock` appended to its prompt so
// it won't undo something the change did on purpose (the "contradicts the intent" failure).
const intent = taskIntent || (triage && triage.changeIntent) || ''
const intentBlock = intent
  ? `\n\n   WHAT THIS CHANGE IS TRYING TO DO — do NOT undo or contradict it. If a finding asks you
   to revert or "fix" something this change did on purpose, SKIP it and say why instead of applying
   it. Run \`git diff\` to see the full change before touching anything:\n   ${intent}`
  : `\n\n   Run \`git diff\` FIRST to understand what this change is trying to do, so you don't
   "fix" something that was done on purpose.`

// Resolve the review tier. A caller (e.g. /r:task-run) may pass { profile, uiTouched }; otherwise
// use what triage classified from the diff. Two different defaults are at work and they must not
// be confused: 'standard' is where an UNSURE CLASSIFIER lands (see the tree above), while 'full'
// is the defensive fallback for a value that isn't a tier at all — a garbled or absent answer
// means nothing classified this diff, and that is not a reason to review it cheaply.
const profile = TIERS.includes(opts.profile)
  ? opts.profile
  : (TIERS.includes(triage.profile) ? triage.profile : 'full')
const uiTouched = (typeof opts.uiTouched === 'boolean') ? opts.uiTouched : !!triage.uiTouched
log(`post-task-review: tier=${profile}, uiTouched=${uiTouched} (${TIERS.includes(opts.profile) ? 'caller-set' : 'classified'})`)

// --- Two things started HERE, because nothing on the critical path is waiting for them -------
//
// 1. The docker image pre-warm for the UI step. Measured over 59 stored UI runs the deploy is 42%
//    of that step's tool time and took over two minutes in 17 of 56 runs (worst: 607s), all of it
//    on the critical path at the very end. Started here it overlaps the review, the fix phase, the
//    build and the static scan; dispatched alongside the end-verify instead, it would overlap only
//    one phase. Build-only — nothing starts, so it cannot serve stale code, and
//    a fixer editing a file below simply invalidates the layers that file touches, which the real
//    deploy then rebuilds. The cache is an optimisation, never the artifact under test. The helper
//    always exits 0 and Phase 7 never reads this result, so a failed pre-warm costs a cold build
//    and nothing else.
//
// 2. The docs hunter. Its findings feed `docDrift`, which is a list handed to the USER — never a
//    fix, never an input to the build. Keeping it inside the Review barrier meant the fix phase
//    waited on a track whose output it does not consume.
const uiWanted = uiTouched
// A terminal app has no image to warm, and worktree-deploy.sh require_bin's docker BEFORE it reads
// its subcommand — so `prewarm` there exits 127 rather than no-opping. Written as a negative on
// purpose: a web project whose triage omitted the new field must be indistinguishable from today.
const terminalSurface = (x) => x === 'tui' || x === 'cli'
const prewarmP = (uiWanted && triage.hasTestApp && !terminalSurface(triage.testAppSurface))
  ? agent(
      `Run \`"${PACK}/skills/task-review/scripts/worktree-deploy.sh" prewarm\` from the
       repo root and report its stderr line verbatim. It builds the app image WITHOUT starting
       anything, to warm the docker layer cache for a deploy that happens later in this run.
       It always exits 0 by design. Do NOT start containers, do NOT deploy, do NOT touch the repo,
       and do NOT treat a skip or a failed build as a problem — a cold cache is slow, not wrong.`,
      { label: 'ui-prewarm', phase: 'Triage', ...GP, ...ECHO }).catch(() => null)
  : null

// --- Phase 0b: capture the diff ONCE, for every hunter ------------------------
// Each hunter is a fresh context with no shared prefix, so left to themselves they each derive the
// change independently: 10–17 shell calls apiece just to work out what they are looking at, before
// any hunting starts. And they do not converge on the same answer — across stored runs one review
// has hunters using `git diff HEAD`, `git diff`, and `git diff origin/main..HEAD`, which are three
// different changesets. One capture answers both: the orientation is paid once at the cheapest
// tier, and every hunter reviews the same bytes, so their findings are about the same diff.
//
// It runs HERE, after triage, because triage's step 1b `git add -N` is what makes untracked new
// files visible to `git diff` at all — captured any earlier, a brand-new file is missing from the
// artifact the whole scan reads.
//
// Fail-open by construction: one attempt, no reliable() wrapper, and `diffClause` simply stays the
// fetch-it-yourself instruction if anything goes wrong. A failed capture costs each hunter a few
// shell calls, never the review. Skipped entirely when there is no diff to capture (scope 'all')
// or nothing to hand it to (the light tier dispatches no hunters).
if (profile !== 'light' && opts.scope !== 'all') {
  const pack = await agent(
    `Capture this review's diff to a file, so the hunters that follow read one shared artifact
     instead of each deriving its own. From the repo root run EXACTLY this, in one Bash call:
       d="$(mktemp)"; git diff HEAD -U20 > "$d"; echo "PATH=$d"; wc -l < "$d"; git diff HEAD --name-only | wc -l
     Return ok=true with path=$d, lines=<the wc -l of the file> and files=<the name-only count>.
     If the command fails, or the file came out empty (0 lines), return ok=false with a one-line
     reason and no path.
     Do NOT read the diff, do NOT summarise it, do NOT judge it, and do NOT modify the repo. You
     are capturing an artifact for other agents; its contents are none of your business.`,
    { label: 'diff-pack', phase: 'Triage', schema: DIFFPACK, ...GP, ...ECHO }).catch(() => null)
  if (pack && pack.ok && pack.path) {
    diffClause =
      `The change is already captured for you: read the unified diff at ${pack.path}` +
      `${pack.files ? ` (${pack.files} changed file(s), ${pack.lines || '?'} lines)` : ''}. ` +
      `It is \`git diff HEAD -U20\` taken after any untracked sources were staged, and EVERY hunter ` +
      `in this scan reads that same file — so a finding against it is a finding against the same ` +
      `change everyone else reviewed. Read it FIRST and treat it as the scope. Do NOT re-derive it ` +
      `with git. Only if that file is missing or empty, run \`git diff HEAD\` yourself once.`
    log(`post-task-review: diff captured once at ${pack.path} — every hunter reads that file instead of deriving its own`)
  } else {
    log('post-task-review: the shared diff capture did not produce a file — each hunter will run ' +
        '`git diff HEAD` itself. Slower, not wrong.')
  }
}
// Triage already walked this repo, so the docs hunter is handed the doc tree rather than
// re-globbing for it. Absent or empty => the hunter finds them itself.
if (Array.isArray(triage.docFiles) && triage.docFiles.length) {
  docListClause =
    `The docs in this project have already been located for you — check these, and do not spend ` +
    `shell calls re-discovering the tree:\n     ${triage.docFiles.join('\n     ')}\n     ` +
    `If a doc you clearly need is missing from that list, Glob for that one file.`
}

const DOCS_HUNTER = HUNTERS.find((h) => h.label === 'docs')
const docsP = profile === 'light' ? null
  : reliable('find-bugs:docs', 'Review', () => agent(
      hunterPrompt(DOCS_HUNTER, scope),
      { label: 'find-bugs:docs', phase: 'Review', schema: FINDINGS,
        agentType: DOCS_HUNTER.agentType, ...DOC_HUNT })).catch(() => null)

// A fixer's self-check only has to prove the code COMPILES, and the prompt has to NAME the command.
// Told just "verify it compiles", a fixer can plausibly reach for the full clean build — a whole
// hidden test-suite run, seconds before the pipeline runs the suite itself. Naming the cheap command
// (and forbidding the full build) removes that duplication without removing any verification: the
// one test the fixer wrote test-first still runs, and Phase 4 runs everything else right after.
// No `-o` (offline): fixers run BEFORE this run's first build, so on a fresh clone an uncached
// dependency would make it fail hard.
const selfCheckClause = triage.buildTool === 'maven'
  ? 'Self-check with `mvn -q test-compile` — COMPILE ONLY — plus `mvn -q test -Dtest=<TheTestYouWrote>` for the test you just wrote.'
  : triage.buildTool === 'gradle'
    ? 'Self-check with `./gradlew -q testClasses` — COMPILE ONLY — plus `./gradlew -q test --tests <TheTestYouWrote>` for the test you just wrote.'
    : 'Verify your change is syntactically sound before returning.'
const noFullBuild = triage.buildTool === 'none' ? ''
  : ' Do NOT run the full build or the whole test suite: the pipeline runs it immediately after you return, so doing it here only duplicates it.'

// --- Phases 1–3: up-front review + fix (SKIPPED in the light tier) -----------
// Light: skip the fan-out entirely — the change cannot alter behavior, and a single Codex
// --mode review pass over the final diff (Phase 6) is the review.
// Standard: a real Codex read of the PRE-FIX diff (the lighter built-in reviewer, --mode review)
// plus the security hunter. Security stays at this tier while its sibling pattern hunters do not,
// and the reason is the shape of a miss rather than the yield: a missed N+1 degrades a page, a
// missed injection or missing authorization check is exploitable in production and is the one
// class of defect nothing later in the pipeline re-derives. The track is also self-limiting —
// `securitySurface` closes it on any diff whose hunks have no security surface — so it is not a
// blanket extra hunter on every standard run. What standard trades away are the other PATTERN
// hunters (logic, and runtime-and-failures = concurrency/performance + silent failures) and the
// code-quality pass, a polish concern rather than a correctness one. The trade is an independent tool over the
// LLM pattern-matchers; the coverage it costs is the performance-at-scale lens (N+1, unbounded
// fetches, pool exhaustion), which /r:code-scan partly picks up and which a diff-scoped reviewer
// is least likely to flag — worth knowing when reading a clean standard run.
// Full: the strict ADVERSARIAL Codex review (it challenges the approach, not just the code) plus
// the three blocking hunters plus code-quality, so triage in Phase 2 sees the whole field.
// The DOCS hunter runs in both tiers but outside this barrier — see HUNTER_SET.
// Build (Phase 4) and static analysis (Phase 5) run in EVERY tier.
//
// The two Codex modes are different machines, not two settings of one dial: `r:code-adversarial`
// is a prompt-driven session that challenges design choices, `review` calls Codex's native
// reviewer API, which fetches its own diff and HARD-ERRORS on trailing focus text. Never pass
// focus text with the latter.
//
// The full tier's ADVERSARIAL pass has one more gate on it: `planReviewed`. /r:task-run's implement
// half already runs a real Codex review of the PLAN at full tier, before a line of code exists —
// measured across 9 stored implement runs it raised ~24 findings and folded ~20 of them in, every
// time. Challenging the approach again over the finished diff is the most duplicated expensive step
// in the chained pipeline, and it is the slowest kind of Codex run there is. So when the caller
// certifies that the approach was already challenged, this pass drops to the built-in reviewer and
// spends itself on the CODE instead. `=== true` is the fail-open: a caller that says nothing, or a
// run-task whose tier was below full and therefore ran no plan review, still gets adversarial.
const planReviewed = opts.planReviewed === true
const codexMode = profile === 'full' ? (planReviewed ? 'review' : 'adversarial-review')
  : profile === 'standard' ? 'review'
  : null
if (profile === 'full' && planReviewed) {
  log('post-task-review: full tier, but the caller certifies Codex already reviewed the PLAN for ' +
      'this task — the up-front pass runs --mode review over the diff rather than re-challenging an ' +
      'approach that was challenged before it was built. Every other full-tier track is unchanged.')
}
const wantCodexUpfront = !!codexMode
const wantQuality = profile === 'full'
// Which hunters this tier dispatches, and what to CALL that track. At standard the track is not
// find-bugs and must not be reported as it — a caller reading `tracksBlocked: ['find-bugs']` for
// a tier that never ran find-bugs is being told a tool failed when nothing did.
//
// The security hunter has a SECOND gate on top of the tier: the diff has to have security surface
// at all. The hunt is a pattern match against security.md — injection sinks, authorization checks,
// credential handling, data exposure — so on a CSS or copy change there is no hunk any of those
// patterns can apply to, and a full subagent (1.53M cache tokens, ~200s) buys nothing. `!== false`
// is the fail-open, and it matters MORE now that this track can actually return findings: only an
// explicit "no security surface" from triage skips it, never a missing field.
const securitySurface = triage.securitySurface !== false
// The DOCS hunter is dispatched separately, below, and is deliberately not a member of this set.
// It is the one finding track whose output the pipeline never acts on: doc drift resolves to
// update-doc / update-code / confirm-intent, which is the USER's call, so its findings are
// surfaced and never auto-fixed (measured: 0.00 fixes per run by construction, 3.9 items surfaced).
// A track nothing downstream consumes has no business inside a barrier that the fix phase waits
// on — it was holding up triage to deliver a list that goes straight to the caller.
const HUNTER_SET = (profile === 'full'
  ? HUNTERS
  : HUNTERS.filter((h) => h.label === 'security')
).filter((h) => h.label !== 'docs')
 .filter((h) => h.label !== 'security' || securitySurface)
const hunterTrack = profile === 'full' ? 'find-bugs'
  : securitySurface ? 'security hunter' : 'no hunters'
if (!securitySurface && profile !== 'light') {
  log('post-task-review: security hunter SKIPPED — triage found no security surface in this diff ' +
      '(no auth/session, upload or file IO, new endpoint, SQL, crypto/secrets, untrusted parsing, ' +
      'raw template output or security config). Nothing was security-reviewed; this is a skip, not a clean bill.')
}
let codex, bugs, quality, docs, fixList
// Declared out here for the same reason the reports above are: the tier block below is where they
// get filled, and the stats row at the end of the run is outside it. A light tier never triages,
// so an empty list here means "no judgement was made", which is what it should record.
let dismissedCorrectness = [], dismissedReadability = []
let nothingToFix = true
// Correctness fixes counted per finding track — the stats sink's whole reason to exist. Declared
// out here because the light tier skips the block below entirely and the return still reads it.
let fixedBySource = {}
// Whether each Phase 3 fixer actually lived. Read only by the returned `fixed` counts, so a
// triaged list handed to an agent that died is never reported as work this run completed.
let fixApplied = { correctness: true, readability: true }
if (profile !== 'light') {
phase('Review')
;[codex, bugs, quality] = await parallel([
  !wantCodexUpfront ? (() => undefined) : () => reliable('codex', 'Review', () => agent(
    `Run the adversarial-review skill (Codex) in the FOREGROUND from the repo root over ${scope},
     with EXACTLY this command — the mode is a tier decision, do not change it:
     \`"${PACK}/skills/code-adversarial/scripts/run.sh"${codexMode === 'review' ? ' --mode review' : ''} --wait\`
     ${codexMode === 'review'
       ? `That is Codex's lighter BUILT-IN reviewer. It calls the native reviewer API with a target
     and fetches its OWN diff — nothing is embedded — and it REJECTS trailing focus text with a
     hard error, so append no focus text and no extra positional arguments. ${scope} above is
     context for you, not an argument.`
       : `That is the strict adversarial/challenge review: it questions the chosen approach, the
     design tradeoffs and the assumptions, not just implementation defects.`}
     Report-only, and the report is CODEX'S. Do not review the diff yourself: do not read project
     source, do not \`git show\`/\`cat\`/\`grep\` through the change, and do not check the script's
     directory before invoking it — run the command, wait for it, and report what it returns. One
     \`git diff --stat\` to name the scope is enough. Your own reading adds nothing to Codex's
     critique and is measured at ~30k characters of tool output per run for no extra finding.
     Return its findings; [] if it ran clean. Put the wrapper's trailing
     "what this run examined" block in 'coverage' (reviewer mode + whether the diff text was
     embedded or Codex had to fetch it itself) — those lines are provenance, NOT findings, and
     they are what tells a clean verdict over a real read apart from one over a file list.
     Exit codes: 0 with a first stdout line starting "CODEX SKIPPED:" => the Codex plugin
     is NOT installed: return ran=false, findings [], and coverage starting with the exact
     word SKIPPED followed by the reason — never a clean review, never an imitation of one;
     0 otherwise => it ran;
     3 (CLI missing) => blocked; 4 / timeout => not-run, drop the "Review blocked" text
     (it is NOT a finding); ANY OTHER non-zero exit => the wrapper itself failed and its
     stdout is NOT findings — report it as not-run, never as a clean review.${RAN_CLAUSE}`,
    { label: 'codex', phase: 'Review', schema: FINDINGS, ...GP, ...CODEX_RUN })),
  // The hunters, fanned out BY THIS SCRIPT (see hunterFanOut) rather than handed to one
  // subagent — they cannot spawn beneath a workflow agent. reliable() sits INSIDE, per
  // hunter, so a single dead hunter is re-dispatched on its own instead of re-running the
  // whole set. Report-only: no failing tests, no plan mode (a subagent can't reach
  // AskUserQuestion/EnterPlanMode anyway, so find-bugs' Phases 4–5 can't fire by accident).
  () => hunterFanOut(scope, HUNTER_SET, hunterTrack),
  !wantQuality ? (() => undefined) : () => reliable('code-quality', 'Review', () => agent(
    `Invoke the /r:code-quality skill (Skill tool) over ${scope}; report-only. Return the
     "worth fixing" readability/idiom findings as file:line + one line each.${RAN_CLAUSE}${BATCH_CLAUSE}`,
    { label: 'code-quality', phase: 'Review', schema: FINDINGS, ...GP })),
])
// Codex findings carry their source too, so triage sees the same shape on every report and the
// attribution doesn't depend on it remembering which JSON block an item came out of.
if (codex && Array.isArray(codex.findings)) {
  codex = { ...codex, findings: codex.findings.map((f) => ({ ...f, source: 'codex' })) }
}
// Only tracks this tier actually ran can be "blocked" — a track that was never dispatched is a
// tier decision, and logging it as blocked would read as a tool failure in the transcript.
for (const [name, r, ran] of [['codex', codex, wantCodexUpfront],
                              [hunterTrack, bugs, true],
                              ['code-quality', quality, wantQuality]]) {
  if (ran && skipped(r)) log(`post-task-review: ${name} SKIPPED — the OpenAI Codex plugin is not ` +
    `installed, so no Codex review ran; every other track proceeded. Add it with ` +
    `/plugin install codex@openai-codex. The step was NOT faked and is NOT reported as reviewed.`)
  else if (ran && blocked(r)) log(`post-task-review: ${name} track BLOCKED — proceeding with the others (not faked)`)
}
if (profile === 'standard') {
  log('post-task-review: standard tier — a Codex --mode review pass read the diff, alongside the ' +
      'security hunter. The docs hunter ran too, off the barrier. Skipped at this tier: the ' +
      'other /r:code-bugs pattern hunters (logic; runtime-and-failures = concurrency/performance + silent failures), the ' +
      'up-front codex ADVERSARIAL pass and /r:code-quality. A second Codex --mode review over the ' +
      'FINAL diff always runs below, and build/tests + local-scan are unchanged.')
}

// --- Phase 2: triage into a bucketed fix-list, SPLIT by bucket ---------------
// One agent per bucket, in parallel, because the two buckets share nothing: correctness reads the
// hunter + codex reports and decides what is a real defect; readability reads only code-quality and
// decides what is a behavior-preserving clarity win. Merging them meant one serial agent swallowing
// the full JSON of every report — the same shape as the plan-review triage that measured 11 minutes
// and 122k tokens before it was split. The readability agent does not even exist below full, where
// code-quality never runs.
//
// docDrift is not triaged at all: it comes straight from the docs hunter. Routing a list that is
// only ever handed to the user through a filter that cannot act on it buys nothing, and it would
// force the docs hunter to finish before this phase could start.
phase('Fix-triage')
const triageIntro = `You are Step 3 triage. REPORT-ONLY: do NOT edit, write, or run any code — your
   ONLY output is your part of the fix-list. A report marked "(not run at this tier)" is a
   deliberate tier decision, not a missing input to work around. A finding that contradicts the
   intent below is a false positive — drop it.

   Dropping is a JUDGEMENT, and it is recorded: every finding you reject goes in \`dismissed\`,
   in the same shape as a kept one. Never drop a finding silently. A track whose findings are all
   rejected and a track that found nothing are indistinguishable in the statistics unless you
   report the rejections, and the first should be retired while the second may just have had a
   quiet run. Return \`dismissed: []\` only when you genuinely rejected nothing.`

const [correctnessList, readabilityList] = await parallel([
  () => reliable('fix-triage', 'Fix-triage', () => agent(
    `${triageIntro}

   Produce the CORRECTNESS bucket only, from the hunter and codex reports below. Each item is
   {item, source}: 'item' is the file:line + intended fix, and 'source' is the track that found it.
   Every finding already carries a "source" field — COPY it, don't re-derive it. When two tracks
   reported the same defect, attribute it to the FIRST one listed here; when a finding somehow has
   no source, use the report it came out of. Valid sources: ${FIX_SOURCES.join(' | ')}.
   This is how the run records which track earns its keep, so a wrong label is worse than a missing
   item — never guess one to make an entry look complete.

   Do NOT include readability or doc-drift items: another agent owns readability, and doc drift is
   a user decision that must stay out of correctness so nobody "fixes" a doc mismatch by changing
   the code.
   ${hunterTrack}: ${JSON.stringify(bugs)}
   codex (${codexMode || 'not run at this tier'}): ${wantCodexUpfront ? JSON.stringify(codex) : '(not run at this tier)'}${intentBlock}`,
    { label: 'fix-triage', schema: CORRECTNESS_LIST, agentType: 'Explore' })), // read-only: no Edit/Write
  !wantQuality ? (() => undefined) : () => reliable('fix-triage-readability', 'Fix-triage', () => agent(
    `${triageIntro}

   Produce the READABILITY bucket only, from the code-quality report below — ONLY genuinely
   BEHAVIOR-PRESERVING clarity wins (rename, extract method, dedup). If an item would change
   behavior (e.g. "replace the loop with a stream that treats empty input differently"), it is NOT
   a readability item: drop it and say so. /r:code-refactor's behavior-lock gate will refuse a
   behavior-changing "readability" item, so don't hand it one. Another agent owns correctness.
   code-quality: ${JSON.stringify(quality)}${intentBlock}`,
    { label: 'fix-triage-readability', schema: READABILITY_LIST, agentType: 'Explore' })),
])

// docDrift, straight from the hunter that produces it. A blocked docs hunter loses the list and
// says so — it can never be mistaken for "the docs agree with the code".
docs = await docsP
if (profile !== 'light' && blocked(docs)) {
  log('post-task-review: the docs hunter track BLOCKED — no code/doc drift was checked. That is a ' +
      'coverage hole, not a clean bill; the rest of the review proceeded.')
}
const docDrift = ((docs && docs.findings) || [])
  .map((f) => `${f.file}:${f.line} ${f.what}`)

// A dead triage must never read as `nothingToFix`: that drops every finding the tracks just paid
// for on the floor and reports `fixed: 0/0, reviewed: true`. Whether it is a halt depends on
// whether there was anything to lose:
//   findings exist -> STOP. They were found, never triaged, never fixed; a caller must not merge.
//   no findings    -> nothing was lost. Note it and carry on with an empty fix-list.
// Only the CORRECTNESS half can halt the run: a lost readability list costs polish, not soundness.
if (blocked(correctnessList)) {
  const raw = [codex, bugs].flatMap((t) => (t && Array.isArray(t.findings)) ? t.findings : [])
  if (raw.length) {
    log(`post-task-review: FIX-TRIAGE BLOCKED with ${raw.length} untriaged finding(s) — stopping rather than dropping them.`)
    return { stopped: 'fix-triage-blocked', rawFindings: raw }
  }
  log('post-task-review: fix-triage blocked, but no track reported a finding — nothing was lost; continuing with an empty fix-list.')
}
if (wantQuality && blocked(readabilityList)) {
  log('post-task-review: the readability half of triage BLOCKED — code-quality findings went ' +
      'unapplied; the correctness half is unaffected.')
}
const correctness = (!blocked(correctnessList) && Array.isArray(correctnessList.correctness))
  ? correctnessList.correctness : []
const readability = (readabilityList && !blocked(readabilityList) && Array.isArray(readabilityList.readability))
  ? readabilityList.readability : []
// What triage threw away. It goes only to the stats row — never to a fixer, and never into the
// user-facing report, where a rejected finding reads as a defect nobody fixed. A blocked triage
// returns nothing, which is ABSENCE of a judgement and must not be recorded as "rejected nothing".
dismissedCorrectness = (!blocked(correctnessList) && Array.isArray(correctnessList.dismissed))
  ? correctnessList.dismissed : []
dismissedReadability = (readabilityList && !blocked(readabilityList) && Array.isArray(readabilityList.dismissed))
  ? readabilityList.dismissed : []
fixList = (correctness.length || readability.length || docDrift.length)
  ? { correctness, readability, docDrift } : null
// Triage returns correctness as {item, source}. Normalize defensively: a model that hands back
// bare strings (an older schema, a degraded response) must still produce a fixable list rather
// than a crash — the fix phase matters more than the attribution does.
if (fixList && Array.isArray(fixList.correctness)) {
  fixList = {
    ...fixList,
    correctness: fixList.correctness.map((c) =>
      (c && typeof c === 'object') ? { item: String(c.item || ''), source: c.source || 'unattributed' }
                                   : { item: String(c || ''), source: 'unattributed' }),
  }
}
nothingToFix = !fixList ||
  (!fixList.correctness.length && !fixList.readability.length)
// --- Phase 3: fix everything once (correctness first, then readability) ------
// SERIAL, and the order is the point. These two ran in parallel() and are scoped to the SAME
// files by construction — the correctness list and the code-quality report are both reviews of
// one diff, so a shared file is the common case, not the tail. Two agents editing one file
// concurrently has three outcomes and only two of them are caught: a broken file fails the
// fixer's own self-check, or the Phase 4 green build. The third is silent — the refactorer
// writes a file from a read taken BEFORE the correctness fix landed, the fix disappears, the
// build is still green, and the run reports `fixed.correctness: N` for a fix that is no longer
// in the tree. Nothing downstream re-reads it: the full-tier end-verify is framed regression-only
// and told to skip anything already triaged, which is exactly what a reverted triaged fix looks
// like. A `fixed` count a caller cannot trust is the one thing this routine must never produce,
// and no prompt-level "stay in your lane" clause can make concurrent writes to one file safe.
// Correctness first is also right on its own terms: refactoring code that is about to be
// surgically fixed is wasted work, and with deferCommit:false the readability agent's
// "behavior-locked, separate commit" is only an honest description once the fixes are already in.
if (!nothingToFix) {
  phase('Fix')
  // Both were bare agent() calls inside parallel(), which converted a throw to null one level up.
  // Awaiting them directly removes that trap, so it is restored here: a StructuredOutput cap or an
  // exhausted budget in a FIXER must not end a run that still has the build, the scan and the
  // end-verify to do. Deliberately not reliable() — a fixer that died has usually already written
  // part of its diff, and re-dispatching it onto its own half-applied edits is worse than saying so.
  const fix = (prompt, o) => agent(prompt, o).catch(() => null)
  let correctnessFixed = true
  let readabilityFixed = true
  if (fixList.correctness.length) {
    const agentType = triage.hasFrontend && !triage.hasBackend ? 'r:htmx-thymeleaf-dev' : 'r:java-backend-developer'
    const fc = await fix(
      `Surgical fixer, not a feature builder. Fix ONLY these items — the smallest diff that
       resolves each; no refactoring, renaming, or "improving" outside them:
       ${fixList.correctness.map((c) => c.item).join('\n')}
       - Test-first where behavioral: write the test, RUN IT and SEE IT FAIL on the current code,
         then fix until it passes (load the write-tests skill). Say in your summary what the
         failure actually was. A test that passes before your fix has not reproduced the finding —
         either it is too weak to reach it, or the finding was wrong; both are worth saying out
         loud rather than shipping a green test as proof. A regression test is enough for
         non-behavioral fixes; label it as one.
       - Respect project conventions: no new comments or Javadocs, @Builder on data classes with
         more than 3 fields, match the surrounding code.
       - ${selfCheckClause}${noFullBuild}
       - Return a short summary (files + one line each).${intentBlock}`,
      { label: 'fix-correctness', phase: 'Fix', agentType, ...FIX_RUN })
    // Same rule the end-verify fixer follows: only count what a live fixer took. Counting a dead
    // one leaves `fixed.correctness` reporting the full triaged list — the same false-confidence
    // failure the serialization above exists to prevent, arriving by a different route. The items
    // stay visible in the log either way.
    if (blocked(fc)) {
      correctnessFixed = false
      log(`post-task-review: the correctness fixer DIED — ${fixList.correctness.length} triaged item(s) were NOT fixed:\n` +
          fixList.correctness.map((c) => `  - ${c.item}`).join('\n'))
    } else {
      // What each track cost and bought, for the stats sink. Counted from the TRIAGED list, not
      // the raw reports: a track whose findings were all judged false-positive contributed
      // nothing, and that is exactly the distinction worth recording. Credited HERE rather than
      // at triage time so it cannot disagree with `fixed.correctness` — a track gets credit for
      // a finding that was actually fixed, never for one handed to a fixer that died.
      for (const c of fixList.correctness) fixedBySource[c.source] = (fixedBySource[c.source] || 0) + 1
    }
  }
  if (fixList.readability.length) {
    // Only now, and only into a tree the correctness fixer has finished writing.
    const fr = await fix(
      `Invoke the /r:code-refactor skill on the changed files ONLY, applying these readability
       wins ${commitClause}:\n${fixList.readability.join('\n')}${intentBlock}${BATCH_CLAUSE}`,
      { label: 'fix-readability', phase: 'Fix', ...GP })
    if (blocked(fr)) {
      readabilityFixed = false
      log(`post-task-review: the readability refactor DIED — ${fixList.readability.length} clarity win(s) went unapplied. Polish only; correctness is unaffected.`)
    }
  }
  fixApplied = { correctness: correctnessFixed, readability: readabilityFixed }
}
} else {
  log('post-task-review: light tier — skipping the up-front codex + hunter + code-quality fan-out. ' +
      'A single Codex --mode review pass checks the final diff at the end; static analysis + build/tests still run.')
}

// --- Phase 4: build with tests (bounded retry, never "loop until green") ------
// ONE clean build per run. The run's FIRST build is the clean, certifying one — it starts from
// a known state, so nothing left over from a previous branch/session can leak in, and it gives
// local-scan trustworthy bytecode. Every build AFTER it (retry, post-local-scan rebuild,
// UI minor-fix rebuild) is incremental, because by then target/ holds THIS run's own clean
// output plus a small fix delta — there is nothing stale for it to pick up. That turns the
// 2–4 clean builds a fixing review would otherwise do into 1 clean + N incremental, with the green
// invariant untouched: the bar is still a fully green build with tests, never relaxed.
const cleanCmd = triage.buildCmd || ''
const fastCmd = (triage.buildCmdFast || cleanCmd.replace(/\bclean\s+/, '')) || cleanCmd
// `baselineBuilt` — the caller certifies that a CLEAN, fully green build already ran in THIS
// working tree, on THIS branch, moments ago. That is exactly what run-task-implement hands back
// as `buildGreen: true`, and when /r:issues-fix chains implement -> review the two clean builds
// land minutes apart on a diff that changed only by this run's own fix phase. The second one
// re-runs the whole suite from an empty target/ to re-learn what the first one just proved, which
// on a multi-module JVM project is the single most expensive duplicated step in the loop.
// So: trust it, and start incremental. What the clean build actually protects against is stale
// output from ANOTHER branch or session — not from a build this run has already seen — and the
// deleted/renamed escape hatch below still covers the one case where incremental can lie.
// Only ever set from `buildGreen === true`: 'n/a' means no build ran at all, and treating that as
// a baseline would skip the run's only clean build entirely.
const baselineBuilt = opts.baselineBuilt === true && triage.buildTool !== 'none'
if (baselineBuilt) log('post-task-review: caller certified a clean green build in this tree — starting incremental, skipping the duplicate clean build')
// The one case incremental is unsafe: a deleted/renamed source can leave a stale .class that
// makes a genuinely broken build pass. Every rebuild prompt carries this escape hatch.
const staleRule = `If any source file was DELETED or RENAMED since the last build, run \`${cleanCmd}\` instead — a removed source can leave a stale .class behind that would let a broken build pass.`
// How a build agent decides green, stated once and carried by EVERY build prompt below. The exit
// code is the verdict; the log only explains it. The reverse — grepping the log for a success
// marker — cannot work here: the fast commands are quiet (`-q`), under which Maven and Gradle
// print no `BUILD SUCCESS` line at all, so an agent looking for one finds nothing and is left
// judging on the `[ERROR]` lines, which a fully green build has plenty of (tests that exercise
// failure paths, and Surefire's `going to kill self fork JVM` shutdown notice at the tail). A
// green build read as red is the expensive direction: it halts the run and leaves a finished,
// green diff unmerged, with no tier above this call to disagree.
const exitCodeRule = `Decide green from the process EXIT CODE, never from the log text: run the ` +
  `command so the code is captured (\`<cmd> > <logfile> 2>&1; echo "EXIT=$?"\`) and read that. ` +
  `EXIT=0 is green even when the log contains \`[ERROR]\`, \`FAILED\` or a stack trace — tests ` +
  `that exercise failure paths log all three, and Surefire's "going to kill self fork JVM … after ` +
  `System.exit(0)" is a shutdown-timing notice, not a failure. Under \`-q\` there is no ` +
  `BUILD SUCCESS/BUILD SUCCESSFUL line to find, so its absence proves NOTHING — do not report red ` +
  `because you could not grep one. A non-zero exit is red, and then the log says why.`
// Handed to the later fixers (end-verify, UI minor) so they rebuild incrementally too. Told only
// "ensure the build is green", a fixer picks its own command, and that is usually the clean one.
const rebuildClause = triage.buildTool !== 'none'
  ? `then rebuild via the ${triage.runnerAgent} agent with \`${fastCmd}\` (incremental — a clean baseline build already ran in this working tree) until green. ${staleRule} ${exitCodeRule}`
  : 'then verify nothing is broken (no build tool was detected for this project).'
phase('Build')
let buildGreen = false
if (triage.buildTool !== 'none') {
  const changed = (triage.changedFiles || []).join(', ')
  for (let i = 1; i <= 3; i++) {
    const b = await agent(
      `Run the build \`${i === 1 && !baselineBuilt ? cleanCmd : fastCmd}\` via the ${triage.runnerAgent} agent.
       ${i === 1 && !baselineBuilt ? 'This is the run\'s one clean build — it establishes the baseline.' : staleRule}
       ${exitCodeRule}
       green=true ONLY on a fully clean success (exit 0, zero failures). The green bar is
       NEVER relaxed. If red, CLASSIFY every failure:
       - inScopeFailures: compile errors or test failures in code THIS turn changed
         (changed files: ${changed || 'derive from git diff'}). These are ours to fix.
       - preExistingFailures: failures UNRELATED to the diff — a test/class the change
         didn't touch, the kind that already fails on the base commit. List the failing
         class names. These are NEVER ours to fix and NEVER a reason to edit the pipeline.
       Put a short combined log in 'failures'.`,
      { label: `build#${i}`, phase: 'Build', schema: BUILD, agentType: triage.runnerAgent, ...BUILD_RUN })
    if (b && b.green) { buildGreen = true; break }
    // Green is real: if the ONLY failures are pre-existing/out-of-scope, we do NOT fix
    // them, do NOT touch them, and do NOT tolerate them — we stop and surface. The review
    // cannot certify green on a red baseline; that's the user's to fix/quarantine on main.
    const inScope = b && b.inScopeFailures && b.inScopeFailures.trim()
    if (!inScope) {
      log('post-task-review: build RED from PRE-EXISTING / out-of-scope failures only — not fixing, not forking; surfacing to user')
      return { stopped: 'build-red-preexisting', preExisting: (b && b.preExistingFailures) || (b && b.failures) || 'unknown', fixList }
    }
    if (i < 3) await agent(
      `The build is red from failures THIS change caused. Fix ONLY these (surgical-fixer
       rules) and do NOT touch any pre-existing / out-of-scope test or class to force a
       pass:\n${inScope}
       ${selfCheckClause}${noFullBuild} (This loop rebuilds and re-runs the suite as soon as
       you return — that is what proves the failures are gone.)${intentBlock}`,
      { label: `build-fix#${i}`, phase: 'Build', agentType: 'r:java-backend-developer' })
  }
  if (!buildGreen) {
    log('post-task-review: in-scope build still RED after 3 attempts — stopping, surfacing to user')
    return { stopped: 'build-red', fixList }
  }
}

// --- Phase 5: /r:code-scan (fail-closed) + rebuild if it changed code ----------
// Static analysis is MANDATORY in BOTH tiers — no trivial-skip. If no *.java/*.kt changed
// (e.g. a cosmetic frontend-only change) the scan agent reports status 'skipped', so
// "mandatory" costs nothing when there's nothing for the JVM analyzers to scan.
// Tracked because the end-verify gate below needs it: local-scan APPLIES its own fixes, so a run
// with an empty fix-list can still have machine-written code in the diff. Skipping the end-verify
// on fix-list alone would let exactly that code ship unreviewed.
let scanChangedCode = false
let localScan = 'n/a'
if (triage.buildTool !== 'none') {
  phase('Local-scan')
  {
    // The scan agent computes its OWN class list, at scan time — it is NOT handed
    // triage.changedFiles. That list is the working-tree diff as it looked in PHASE 0, before the
    // fix phase ran, so anything the fixers or /r:code-refactor touch (a new test class, a second
    // file pulled into a fix) would never be scanned, and neither would a class deferred from an
    // earlier turn on this branch. SKILL.md Step 6b specifies the branch-wide, scan-time list.
    // Cost of asking here instead of reusing Phase 0: one round trip on a JVM project with no JVM
    // change, which the agent reports back as status 'skipped'.
    const scan = await reliable('local-scan', 'Local-scan', () => agent(
      `Run /r:code-scan over the classes this BRANCH changed. First compute the list YOURSELF —
       do not use any list you were given, and do not scope it to today's working-tree diff:
         BASE=$(git merge-base HEAD origin/HEAD 2>/dev/null || git merge-base HEAD origin/main 2>/dev/null || echo HEAD)
         { git diff --name-only; git diff --cached --name-only; git diff --name-only "$BASE"...HEAD; } \\
           | grep -E '\\.(java|kt)$' | sort -u
       That covers every class touched anywhere on the branch, including ones the fix phase just
       wrote, so nothing machine-written slips past static analysis. If git cannot resolve a
       base, fall back to the working-tree + staged diff and say so in 'reason'.

       If the list is EMPTY (e.g. a frontend-only change), do nothing and return status 'skipped'
       — that is a natural no-op, not a failure. Otherwise invoke
       \`/r:code-scan <ClassA> <ClassB> …\` with that list and fix all issues in each FULL class.

       Then report: status (from findings.json: ok|error|skipped — a non-zero exit or
       status:error means an analyzer errored / none ran => NOT clean), whether it changed
       any code, and which tools were skipped/errored.${BATCH_CLAUSE}`,
      { label: 'local-scan', phase: 'Local-scan', schema: SCAN, ...GP }))
    // Fail-closed, both ways. A dead scan agent must not fall through BOTH branches unlogged:
    // that turns a step the non-negotiables call mandatory into a silent no-op while the run still
    // reports clean. Blocked and status:'error' are the same thing here: not scanned.
    if (blocked(scan) || scan.status === 'error') {
      localScan = 'blocked'
      log(`post-task-review: local-scan BLOCKED — NOT a clean result (${(scan && scan.reason) || 'the scan agent returned nothing / an analyzer errored / none ran'}); ` +
          `uncovered: ${((scan && scan.uncovered) || []).join(', ') || 'unknown'}. The changed classes are NOT statically scanned.`)
    } else if (scan.status === 'skipped') {
      localScan = 'skipped'
      log(`post-task-review: local-scan no-op — ${scan.reason || 'no *.java/*.kt changed on this branch'}`)
    } else if (scan.changedCode) {
      localScan = 'ok'
      scanChangedCode = true
      // Bounded like phase 4, and for the same reason phase 4 is: this rebuild's red is the only
      // verdict in the routine that halts the run on a single agent's say-so, and a red that
      // NAMES nothing is the exact shape a misread log takes. So a nameless red just re-runs the
      // build — sending a fixer after failures nobody listed is how a green tree gets edited —
      // while a red that names failures gets one surgical fix and one more build, since by
      // construction those failures are local-scan's own.
      // The loop is also the only thing that makes a false red recoverable. `resumeFromRunId`
      // replays a cached agent result rather than re-running it (same prompt, same opts → cache
      // hit), and the workflow guard forbids editing this script to force a re-run, so a single
      // halting verdict would otherwise be final for the group. Attempts 2 and 3 are calls a
      // stopped run never made, which is what a resume can still reach live.
      let rebuildGreen = false
      for (let i = 1; i <= 3; i++) {
        const rb = await agent(`Rebuild via ${triage.runnerAgent}: \`${fastCmd}\` (incremental — the
          clean baseline build already ran in this working tree). ${staleRule}
          ${exitCodeRule}
          green=true ONLY on a fully clean success. The build was fully green before local-scan
          ran, so ANY failure here is a regression from local-scan's own self-fixes (in-scope) —
          name it in 'inScopeFailures'; do not touch out-of-scope tests/code.`,
          { label: `rebuild#${i}`, phase: 'Local-scan', schema: BUILD, agentType: triage.runnerAgent, ...REBUILD_RUN })
        if (rb && rb.green) { rebuildGreen = true; break }
        if (i === 3) break
        const failed = ((rb && (rb.inScopeFailures || rb.failures)) || '').trim()
        if (!failed) {
          log(`post-task-review: rebuild#${i} RED but named no failure (or the agent died) — re-running the build rather than dispatching a fixer`)
          continue
        }
        await agent(`The post-local-scan rebuild is red from local-scan's own self-fixes. Fix ONLY
          these (surgical-fixer rules) and do NOT touch any pre-existing / out-of-scope test or
          class to force a pass:\n${failed}
          ${selfCheckClause}${noFullBuild} (This loop rebuilds and re-runs the suite as soon as you
          return — that is what proves the failures are gone.)${intentBlock}`,
          { label: `rebuild-fix#${i}`, phase: 'Local-scan', agentType: 'r:java-backend-developer' })
      }
      if (!rebuildGreen) {
        log('post-task-review: rebuild after local-scan still RED after 3 attempts — stopping. To retry this step, run the review again on the branch; RESUMING this run replays the cached red verdict instead of rebuilding.')
        return { stopped: 'rebuild-red' }
      }
    } else {
      localScan = 'ok' // scanned clean, changed nothing — no rebuild owed
    }
  }
}

// The UI gate. It is resolved much earlier now (right after the tier, alongside the docker
// pre-warm) so the image build can start there — see the note at that dispatch site.
//
// The gate is `uiTouched` in EVERY tier, full included — never `full || uiTouched`. That
// unconditional half is the most expensive unearned step available: measured over 59 stored runs
// this step takes a median of 542s (p90 1150s) with two thirds of that model time across ~86
// serial turns, two `high` agents and up to six screenshots the visual half must then READ back as
// images. What routes a change to `full` is auth, money, persistence, concurrency or an approach
// worth challenging — none of which implies a rendered page changed. Gated on the tier, a
// backend-only `full` run boots the whole stack, drives a browser and grades the design of pages
// the diff never touched. The evidence for a UI defect is the rendered result, and there is a new rendered result
// only when a frontend file changed; when none did, the static tracks (which `full` runs in full)
// are what actually read the change. Tier still governs DEPTH everywhere else — this one step is
// governed by whether there is anything new to look at.

// --- Phase 6: end-verify — bounded <=2 Codex passes over the FINAL diff -------
// EVERY tier uses the SAME reviewer mode: Codex's lighter built-in reviewer (--mode review).
// Full tier: a regression-only re-check, ONLY when Phases 3–5 changed code (else there's nothing
// new to verify). "Changed code" means EITHER the fix phase wrote something OR local-scan applied
// its own fixes — gating on the fix-list alone would skip the end-verify on a run whose only
// machine-written code came from the scan, which is precisely the code this gate exists to read.
// Light and standard: no Codex has read this change yet, so this pass is its sole Codex review —
// it ALWAYS fires and reads the whole change. Same mode, fuller framing. All bounded to 2 passes.
const endVerifyWanted = profile !== 'full' ? true : (!nothingToFix || scanChangedCode)
let endVerifyBlocked = false
// What the LAST pass raised and nothing re-read clean. It needs somewhere to go, or the findings
// vanish — two ways, both observed in practice:
//   * `real` is OPTIONAL in FINDINGS, so `filter(f => f.real)` drops every finding a pass returns
//     WITHOUT adjudicating it. The loop then reads "no real findings" as converged and the run
//     reports endVerify:'passed', fixed.correctness:0 — for a Codex pass that found a genuine
//     defect and said so. Nothing downstream ever sees it.
//   * even an explicitly real finding raised by pass 2 goes to a fixer whose work no pass ever
//     re-reads, and the run still reports 'passed'.
// A caller merges on the strength of that word, so it must be backed by a pass that actually came
// back clean. Carry the remainder out instead, and let it decide the verdict below.
let endVerifyUnresolved = []
// Correctness items fixed HERE, so `fixed.correctness` counts everything this run fixed rather
// than only what Phase 2 triaged.
let endVerifyFixed = 0
if (!endVerifyWanted) log('post-task-review: end-verify skipped — no substantive changes since review')
// Frontend files an end-verify FIXER touched. It decides one thing after the barrier below: whether
// the UI verification, which ran against an image built before those fixes landed, has to look
// again. Derived from the findings the fixer was handed, so it costs no extra agent.
const FRONTEND_FILE = /\.(html|htm|css|scss|sass|less|js|mjs|ts|tsx|jsx|vue|svelte)$|(^|\/)(templates|static|webapp|resources\/templates)\//i
// Where a domain fix goes. The two bundled fixers are Spring/JPA-shaped and Thymeleaf-shaped; on a
// project with no JVM build there is no honest third one, so the fix goes to a general-purpose
// agent that reads the project's own conventions instead of importing somebody else's. A terminal
// /test-app is the first thing that reaches this code path with buildTool 'none' — before it, all
// 42 stored end-verify-fix runs were in one Spring repo, so this branch has never been exercised.
const domainFixer = triage.hasFrontend ? { agentType: 'r:htmx-thymeleaf-dev' }
  : triage.buildTool === 'none' ? { ...GP }
  : { agentType: 'r:java-backend-developer' }
let endVerifyTouchedFrontend = false
const endVerifyTrack = async () => {
  if (!endVerifyWanted) return
  // Same problem as the UI fixer's: on a project with no JVM build, 'r:java-backend-developer' is
  // a Spring/JPA persona pointed at Rust or Go. Narrower than domainFixer on purpose — this one
  // only reaches for the Thymeleaf agent when the change is frontend-ONLY.
  const fixAgent = triage.buildTool === 'none' ? null
    : (triage.hasFrontend && !triage.hasBackend ? 'r:htmx-thymeleaf-dev' : 'r:java-backend-developer')
  const fixAgentOpts = fixAgent ? { agentType: fixAgent } : { ...GP }
  // What pass 1 raised and what happened to it. Each pass shells out to `run.sh --mode review`,
  // which starts a FRESH Codex thread (lib/codex.mjs runAppServerReview: startThread, ephemeral) —
  // there is no session to resume, so pass 2 has literally no memory of pass 1 and, until this,
  // received a byte-identical prompt. It therefore re-read the diff cold with no idea which lines
  // had just been rewritten *in response to it*, which cost the loop its whole point: a fix that
  // landed wrong looked the same to it as code it had never seen. Carrying the findings forward in
  // the prompt is the only channel available, so use it.
  let priorPass = null
  for (let pass = 1; pass <= 2; pass++) {
    // Same reviewer MODE at every tier: Codex's lighter built-in --mode review. Only the framing
    // differs, by what has already read this change. In light nothing has, so this pass IS the
    // review. In standard a --mode review pass read the PRE-FIX diff — this one reads the final
    // one, so it is neither a first read nor a pure regression check, and saying "no Codex has
    // read this change yet" there would be false and would waste the pass on re-reporting.
    const framing = profile === 'full'
      ? `This end-verify is regression-only — do NOT re-challenge the approach. Skip anything already
       triaged; flag only NEW correctness/equivalence breaks the fixes/refactor/scan introduced.`
      : profile === 'standard'
      ? `A Codex --mode review pass already read the PRE-FIX diff, and the security + docs hunters
       went over it too; their findings were triaged and fixed. You are reading the FINAL diff — the
       fixes, the refactor and /r:code-scan's self-fixes are all in it now. So don't re-report what
       was already triaged and fixed: spend this pass on what those later changes introduced, and on
       what a diff review of the earlier state would have missed. Note that the three /r:code-bugs
       pattern hunters did NOT run at this tier, so performance-at-scale problems (N+1 queries,
       unbounded fetches, connection-pool exhaustion) have had no dedicated reader — they are worth
       your attention here.`
      : `No Codex has read this change yet, so this is its ONLY Codex review — review the WHOLE
       change: correctness, edge cases, and anything the change introduced (not just regressions).`
    // Hand pass 1's verdict to pass 2. Two things it can't otherwise know: which findings were
    // raised, and whether a fixer actually took them (a dead fixer means the code is untouched, so
    // re-finding them is CORRECT rather than a duplicate). Framed as "verify the fix", not "here is
    // the answer" — a reviewer told only "these were fixed" tends to agree, and the case worth
    // catching is the fix that is partial, wrong, or broke a neighbour.
    const carryover = !priorPass ? '' : `
       Pass ${pass - 1} of this same end-verify raised the finding(s) below, and a fixer ${priorPass.fixed
        ? 'then edited the code — the diff you are reading now INCLUDES those edits'
        : 'DIED before touching them, so expect them to be exactly as reported'}.
       For each one: confirm it is genuinely resolved (a partial fix, a fix that only silences the
       symptom, or a fix that broke something nearby is precisely what this pass exists to catch),
       and report anything NEW those edits introduced. Don't re-report one that is now correct.
${priorPass.findings.map(f => `         - ${f.file}:${f.line} [${f.category}] ${f.what}`).join('\n')}
`
    const dispatchEndVerify = (tag) => reliable(`end-verify#${pass}${tag}`, 'End-verify', () => agent(
      `Re-run the adversarial-review skill (Codex, foreground) over the CURRENT working-tree diff in
       the built-in reviewer mode — pass --mode review:
       \`"${PACK}/skills/code-adversarial/scripts/run.sh" --mode review --wait\`.
       ${framing}${carryover}
       Put the wrapper's trailing "what this run examined" block in 'coverage' — provenance, not
       findings — so a clean pass records WHAT was read, not just that nothing came back.
       Same exit-code handling (3=CLI missing→blocked, 4/timeout→not-run, drop the "Review blocked"
       text, any other non-zero => wrapper failed, not findings). Mark each finding real:true or
       real:false EXPLICITLY — a finding you leave unmarked counts as REAL and goes to a fixer, so
       omitting the flag is never a way to quietly drop something Codex reported.${RAN_CLAUSE}`,
      { label: `end-verify#${pass}${tag}`, phase: 'End-verify', schema: FINDINGS, ...GP, ...CODEX_RUN }))
    // This was the ONE major step called bare — every other one goes through reliable(). blocked()
    // caught its ran:false, but nothing re-dispatched, so a single bad wrapper invocation left the
    // final diff unverified. Observed on a real run: the wrapper produced no report, the routine
    // reported endVerify:'blocked', and only an attentive caller noticing that 'blocked' is not
    // 'passed' stopped an unreviewed diff from merging.
    let v = await dispatchEndVerify('')
    // ran:false is a LIVE agent saying the tool did not run — reliable() cannot see it, because
    // the agent itself succeeded. It means the wrapper burned its own 3 Codex attempts (exit 4),
    // and re-running buys 3 more against a transient failure. On the real occurrence a manual
    // re-run minutes later returned a clean review, so one more dispatch is worth far more than
    // the alternative: declaring the final diff unverified and stopping the merge.
    if (v && v.ran === false) {
      log('post-task-review: end-verify Codex reported it did NOT run — re-dispatching once before calling the diff unverified')
      v = await dispatchEndVerify('.retry')
    }
    // A blocked end-verify returns no findings, which the "no findings => converged" test below
    // would read as a pass — the same phantom-clean shape as the up-front tracks. The final diff
    // is UNVERIFIED in that case, and saying otherwise is the one thing this routine exists to
    // prevent, so record it and surface it rather than converging.
    if (blocked(v)) {
      endVerifyBlocked = true
      log('post-task-review: end-verify Codex did NOT run — the final diff is UNVERIFIED (not counted as clean); surfacing')
      break
    }
    // An ABSENT `real` means "counts": a reviewer that reports a defect without adjudicating it
    // is reporting a defect, not dismissing one. Only an explicit real:false drops a finding, and
    // the prompt above asks for that flag on every one — so a dropped finding is always someone's
    // decision, never a missing field.
    const real = (v && v.findings || []).filter(f => f.real !== false)
    // A pass that came back clean is the only thing that clears the remainder. Assigning here (not
    // just breaking) is what makes "pass 1 found X, pass 2 read the fix and was happy" resolve.
    if (!real.length) { endVerifyUnresolved = []; break }
    endVerifyUnresolved = real.map(f => `${f.file}:${f.line} [${f.category}] ${f.what}`)
    const fx = await agent(`Fix these end-verify findings (surgical), ${rebuildClause}
      Fix ONLY these items; do NOT touch any pre-existing / out-of-scope test or class to
      force a pass (the green bar is never relaxed):
      ${real.map(f => `${f.file}:${f.line} ${f.what}`).join('\n')}${intentBlock}`,
      { label: `end-verify-fix#${pass}`, phase: 'End-verify', ...fixAgentOpts, ...FIX_RUN })
    // Only count what a live fixer took. A dead fixer must not inflate `fixed.correctness` — the
    // whole point of that number is that a caller can trust it. The findings stay in
    // endVerifyUnresolved either way, so a lost fix still shows up in the verdict.
    if (blocked(fx)) log(`post-task-review: the end-verify fixer died on pass ${pass} — ${real.length} finding(s) were NOT fixed`)
    else {
      endVerifyFixed += real.length
      // Attributable by construction — nothing but the end-verify Codex produced these. Recorded
      // separately from the up-front tracks because it answers a different question: how often
      // does the machine-written code from the fix/refactor/scan phase need fixing itself?
      fixedBySource['end-verify'] = (fixedBySource['end-verify'] || 0) + real.length
      // The UI track is running alongside this one, against an image built BEFORE these edits.
      // If a fix landed in a frontend file, what it verified is now stale — see the re-verify
      // guard after the barrier.
      // On a terminal surface FRONTEND_FILE can never match — the app's views are .go/.rs/.py like
      // everything else — so this flag would be permanently false and a re-verify would never fire.
      // Treat any end-verify fix there as render-affecting: the cost calculus that made this guard
      // narrow on the web (an 86s docker deploy) does not exist when a restart is seconds.
      if (terminalSurface(uiSurfaceResolved)) endVerifyTouchedFrontend = true
      else if (real.some((f) => FRONTEND_FILE.test(String(f.file || '')))) endVerifyTouchedFrontend = true
    }
    // The next pass's only link to this one. Recorded AFTER the fixer so it carries whether the
    // edits actually happened — a dead fixer changes what re-finding these items means, and pass 2
    // has no other way to tell the two situations apart.
    priorPass = { findings: real, fixed: !blocked(fx) }
    // Pass 2's fix is the one nothing re-reads — the loop is capped here. Fixed is not verified,
    // so these stay in endVerifyUnresolved and the run reports 'findings-unresolved', not 'passed'.
    if (pass === 2) log(`post-task-review: ${real.length} end-verify finding(s) remain after 2 passes — fixed but NOT re-verified; surfacing them in the result`)
  }
}

// --- Phase 7: UI / runtime verification (deploy -> 2 halves in parallel) ------
// Runs when /test-app exists AND the change touched the frontend (uiWanted === uiTouched, resolved
// above the end-verify — see the note there for why the tier does not force it). A CSS/template
// change is exactly where the rendered result, not the diff, is the evidence. A backend-only change
// skips it at every tier: booting the whole stack to look at pages nothing touched is the most
// expensive way to learn nothing.
//
// WHY THIS IS THREE STEPS AND NOT ONE. Measured over 59 stored r:bug-hunter-ui transcripts: median
// 542s, p90 1150s — the largest SERIAL block in the pipeline, since the Phase 2 hunters overlap
// each other while this one runs alone at the end. 66% of it was model time over a median of 86
// turns, because ONE agent did four different jobs end to end: deploy, functional smoke test,
// screenshots, design critique. /test-app is DESIGNED to split that across parallel subagents
// ("one subagent for one focused area… spawn them in parallel") — and it cannot, because since
// 2.1.217 subagents have no Agent tool. 0 of those 59 runs ever spawned one. So the fan-out
// happens HERE, exactly as Phase 2 already does it for find-bugs' hunters:
//   7a deploy (mechanical, one job) -> 7b functional || visual -> 7c teardown.
// Both halves invoke the REAL /test-app on their own focused scope, each in its own isolated
// agent-browser session (AGENT_BROWSER_SESSION), so two live browsers never share a page.
let uiSummary = { skipped: true }
let ui = null
let uiDead = []
let uiReasons = []
let uiMissing = ''
// What 7a actually brought up, and the sessions it started. Hoisted for the same reason `ui` is:
// the teardown runs in a `finally` OUTSIDE the barrier, and a variable scoped inside uiTrack() is
// gone exactly when the teardown needs it most. The defaults come from TRIAGE rather than null
// because a deploy that DIED before returning still has to be torn down with the right instrument:
// `tui-session.sh stop` on a session that was never started is a no-op by contract, while
// `worktree-deploy.sh teardown` on a machine without docker is an exit 127 and three retries.
let uiSurfaceResolved = terminalSurface(triage.testAppSurface) ? triage.testAppSurface : 'web'
let uiSessions = []
// Hoisted for the same reason as `ui` above: the stats row is assembled outside this block, and
// the UI fixer's outcome is part of what that row claims.
let minorFixed = false
// The /test-app presence gate is answered TWICE, and deliberately. Phase 0 (triage step 5b) gives
// the cheap early answer that keeps a project with no /test-app off this path entirely — but it is
// a MODEL answering a one-line `test -f` over a directory that survives its own SKILL.md — the
// gitignored e2e scripts, screenshots and credentials beside it stay when the definition does not.
// Measured: one triage in four answers true over that residue, and the run pays a pre-warm, an 86s
// docker deploy and both halves before they report the file gone. So the deploy step re-checks
// before it spends anything, and an absent file there is a SKIP, not a blocked track.
// Deploy + both halves only. The teardown, the fixes and the issue filing all happen AFTER the
// barrier below, because they must not race the end-verify's own fixers over the same files.
const uiTrack = async () => {
  if (!uiWanted || !triage.hasTestApp) return
  {
    // Report-only agents, so they get the intent as focus (not the fixer "don't undo" block).
    const uiIntent = intent
      ? `\n       This change set out to: ${intent} — verify THAT works; treat an intentional design choice as a feature, not a defect.`
      : ''
    // Collect the pre-warm before deploying, so the build it started can't still be running
    // against the same docker daemon when the deploy asks for the same layers.
    if (prewarmP) await prewarmP

    // 7a — deploy. Its own step, at DEPLOY_RUN: reading a command out of a skill file and
    // running a script is not work that improves with more thinking (it only has to tell a real
    // failure from a slow start), and doing it inside the verifier put a whole docker build log
    // into a judging context. reliable() only re-dispatches a DEAD agent, so an honest
    // {ok:false, reason} comes back once — a broken deploy is never retried three times.
    const dep = await reliable('ui-deploy', 'UI', () => agent(
      `Bring the app up for UI verification and return its base URL. You do NOT test anything.
       0. FIRST, confirm the skill this whole track depends on is actually on disk:
            test -f "$(git rev-parse --show-toplevel)/.claude/skills/test-app/SKILL.md"
          If it is NOT there, return ok=false with missing=true and that path in 'reason', and do
          nothing else — no prewarm, no deploy, no containers. The tier gate that got you here is
          a model's answer to this same one-line test, taken over a directory that outlives the
          skill: the gitignored e2e scripts, screenshots and credentials beside SKILL.md stay put
          when the definition does not, so the directory reads as a live skill when there is none.
          You are the step that needs the file, so you are the one that has to look for it — and
          look for SKILL.md specifically, never for the directory. A gitignored, locally-scaffolded
          SKILL.md counts: this is a disk check, and git has no opinion here.
       0b. Read WHICH SURFACE that skill drives, from its own marker line — one command, not a
          judgement:
            grep -m1 -oE 'test-app-surface: (web|tui|cli)' .claude/skills/test-app/SKILL.md | cut -d' ' -f2
          Prints web/tui/cli -> use it, and report it in \`surface\`. Prints nothing -> the skill
          predates the marker: if it names a base URL (\`grep -q BASE_URL\`) treat it as 'web' and
          say in \`reason\` that you INFERRED it; if it names none, you cannot tell what to start,
          so return ok=false with missing=true and the reason "the /test-app skill declares no
          surface and names no base URL — re-run /r:test-app-create", and do nothing else. Never
          assume, and never start anything to find out. Your answer OVERRIDES whatever the triage
          step guessed; if they disagree, say so in \`reason\`.
       ===== WEB surface — steps 1-3. =====
       1. Read \`.claude/skills/test-app/SKILL.md\` and its \`references/subagent-prompt.md\` for
          the redeploy command (the REBUILD_NOTE), the HEALTH_CHECK_CMD, and the default BASE_URL.
       2. Deploy ONLY through the helper — never the raw redeploy command. The helper is what keeps
          parallel worktrees off each other's ports, containers and volumes:
            WTD="${PACK}/skills/task-review/scripts/worktree-deploy.sh"
            "$WTD" deploy '<the REBUILD_NOTE redeploy command>'
            "$WTD" base-url '<the default BASE_URL>'
          If the test-app skill names a non-default compose file or app service, export
          COMPOSE_FILE / APP_SERVICE / APP_CONTAINER_PORT first so the helper isolates the right one.
       3. Run the health check against the resolved URL. Return ok=true with that url ONLY if the
          app actually answers. Otherwise return ok=false and a one-line reason — never report a
          deploy you did not observe come up.
       On the WEB path only: if you are in a linked git worktree and the helper is missing or not
       executable, return ok=false with that reason — deploying on the project's default port from
       a worktree would collide with the main stack, which is the whole failure this helper exists
       to prevent.
       ===== TERMINAL surface (tui / cli) — these steps REPLACE 1-3, they do not follow them. =====
       There is no compose file, no port and no URL here, and worktree-deploy.sh is NOT involved at
       all: do not call it, do not pre-warm, do not go looking for docker. Two worktrees running a
       terminal app cannot collide over a port, and the state directory they COULD collide over is
       already derived from the checkout root by the driver — so there is nothing to require here
       and nothing to refuse.
       T1. Read \`.claude/skills/test-app/SKILL.md\` and its \`references/subagent-prompt.md\` for the
          BUILD command, the LAUNCH command, the path of the built binary, and — on 'tui' — the
          ready marker its first frame prints.
       T2. BUILD FIRST. If the build fails, return ok=false with the build output in \`reason\` and
          start nothing: an unbuilt binary is silently the PREVIOUS commit, and every check
          downstream would then pass against code this review never saw.
       T3a. 'cli' — that is the whole deploy. Return ok=true, surface=cli, and the ABSOLUTE path of
          the built binary in \`handle\`. Nothing is running, so there is nothing to health-check.
       T3b. 'tui' — start TWO sessions through the driver, one per half, and confirm BOTH are
          drawing before you return. Never bare tmux, and never one shared session: the functional
          half's keystrokes and the visual half's captures would land on the same stateful frame.
            TUI="${PACK}/skills/test-app-create/scripts/tui-session.sh"
            F=$(TUI_SESSION_SUFFIX=func   "$TUI" start --ttl 3600 -- <the launch command>)
            V=$(TUI_SESSION_SUFFIX=visual "$TUI" start --ttl 3600 -- <the launch command>)
            TUI_SESSION_SUFFIX=func   "$TUI" wait-for "$F" '<the ready marker>' --timeout 60
            TUI_SESSION_SUFFIX=visual "$TUI" wait-for "$V" '<the ready marker>' --timeout 60
          Each \`start\` prints exactly ONE line: the handle it created. Use those two strings
          verbatim. Return ok=true, surface=tui, handle="<F> <V>" — both handles, space-separated,
          functional first.
       T4. A session that never draws is ok=false with the driver's exit code in \`reason\`, never a
          deploy you did not observe come up: 127 tmux is missing, 3 the app already exited, 5 the
          capture is EMPTY, 6 a wait-for hit its deadline. This project's /test-app DECLARED a
          terminal, so a terminal is the instrument its verification needs — an absent tmux is a
          BLOCKED track here, exactly as an absent docker is on the web path, and never a skip.
       On a terminal surface, report the handle in \`handle\` and leave \`url\` empty — a session name
       or a binary path in a field called url becomes a verifier curling a tmux handle.`,
      { label: 'ui-deploy', phase: 'UI', schema: DEPLOY, ...GP, ...DEPLOY_RUN }))

    // The deploy's OWN read wins over triage's, for the same reason `missing` exists: triage is a
    // model answering a one-line command, and this is the step that needs the answer. Anything
    // that is not explicitly terminal is web, so an absent field is today's behaviour exactly.
    const depSurface = terminalSurface(dep && dep.surface) ? dep.surface : 'web'
    // Only overwrite the hoisted default when the deploy actually ANSWERED. A dead agent returns
    // null, and reading 'web' out of that would throw away triage's answer and send the teardown
    // after a docker stack that was never built — on a terminal project, three retries of an
    // exit 127. An answering deploy always wins; a silent one changes nothing.
    if (dep && (dep.surface || dep.ok)) uiSurfaceResolved = depSurface
    // One handle per surface. On the web path this IS dep.url, so the guard below reduces to the
    // expression it replaced. On 'tui' the deploy returns both session handles, space-separated.
    const depHandle = depSurface === 'web' ? (dep && dep.url) : (dep && dep.handle)
    const tuiSessions = depSurface === 'tui' ? String(depHandle || '').trim().split(/\s+/).filter(Boolean) : []
    if (depSurface === 'tui') uiSessions = tuiSessions

    if (dep && dep.missing) {
      // An absent prerequisite is a SKIP, not a failure — the same distinction tracksSkipped and
      // tracksBlocked draw everywhere else in this payload. Nothing broke; there is simply no
      // /test-app in this project to run. Recording it as blocked sends a reader after a deploy
      // that never failed, and (the expensive half) the deploy already did not happen.
      uiMissing = (dep.reason || '').trim() || '/test-app is not installed in this project'
      // Names the absent file and stops. How a project came to be without one, and how it wants
      // it back, are that project's business — a review that starts prescribing recovery is
      // guessing about a tree it knows only through one `test -f`.
      log(`post-task-review: UI verification SKIPPED — ${uiMissing}. Nothing was verified in a ` +
          `browser; this is a skip, not a clean bill.`)
      ui = { ran: false, findings: [], coverage: `SKIPPED — ${uiMissing}` }
    } else if (!dep || !dep.ok || !depHandle) {
      // A failed deploy is a blocked TRACK, not a clean UI pass. ran=false makes blocked() true,
      // so tracksBlocked names it and nothing downstream reads this as "the UI was verified".
      const why = (dep && dep.reason) || 'no usable result'
      log(`post-task-review: UI verification NOT run — deploy failed (${why}).`)
      ui = { ran: false, findings: [] }
      // The reason has to go somewhere a reader can find without the transcript. blockedReasons is
      // fed only by the HALVES, so before this a failed deploy stored blocked:true against an empty
      // reason list — the same "a blockage has nowhere to go" shape UIRES.blockedReason exists to
      // prevent. It matters more on a terminal surface, where two new failures (tmux absent, the
      // session died at startup) are otherwise indistinguishable in the store.
      uiReasons = [`ui-deploy: ${why}`]
    } else {
      // Both halves share this: the app is already up and someone else owns its lifecycle. The web
      // branch is unchanged text — a web run must be indistinguishable from before this existed.
      // The terminal branch carries the SAME two load-bearing phrases ("ALREADY deployed", "Do NOT
      // deploy, redeploy, restart or tear down") so both can be asserted the same way.
      const handoff = depSurface !== 'web' ? (depSurface === 'tui' ?
        `The app is ALREADY deployed and running in a tmux session of its own — yours alone. Do NOT
       deploy, redeploy, restart or tear down anything; this run's orchestrator owns every session
       it started, and a second instance of a program that owns a config file or a lock is a
       collision, not a spare. There is NO URL here: do not look for one, and do not export
       TEST_APP_BASE_URL. Export your handle before you start:
         export TEST_APP_SESSION="${'${SESSION}'}"
         export TEST_APP_SURFACE=tui
       That tells /test-app the caller already started the app, so it attaches to that session
       instead of launching a competing one.
       Drive it ONLY through the driver — never bare tmux, never a second process:
         TUI="${PACK}/skills/test-app-create/scripts/tui-session.sh"
         "$TUI" capture  "$TEST_APP_SESSION"                     # the screen, as a file
         "$TUI" send     "$TEST_APP_SESSION" Down Enter          # keys ( -l for literal text )
         "$TUI" wait-for "$TEST_APP_SESSION" '<regex>' --timeout 15
         "$TUI" resize   "$TEST_APP_SESSION" 80x24
       Its exit codes are the contract, and each names something you were unable to observe: 3 the
       app has already exited (it is NOT ignoring your keys), 4 no such session, 5 the capture is
       EMPTY (a pane that painted nothing is not a clean screen), 6 a wait hit its deadline, 7 a
       resize was not applied, 127 tmux is missing. Never read a non-zero code as "passed anyway".
       Do NOT start a session and do NOT stop one — yours was started for you, and your sibling
       half has its own.` :
        `The app is ALREADY deployed — built and ready at ${'${BINPATH}'}. Do NOT deploy, redeploy,
       restart or tear down anything, and do NOT rebuild: this run's orchestrator owns the binary,
       and a rebuild mid-run would swap the thing your sibling half is testing. There is NO URL
       here: do not look for one, and do not export TEST_APP_BASE_URL. Export the binary first:
         export TEST_APP_BIN="${'${BINPATH}'}"
         export TEST_APP_SURFACE=cli
       That tells /test-app the caller already built it, so it tests that binary instead of
       building a competing one. Invoke "$TEST_APP_BIN" directly for every check — never a source
       runner like cargo run or go run, which writes its own lines to stderr and returns its own
       exit code, silently invalidating every assertion you are about to make.`) :
        `The app is ALREADY deployed and healthy at ${dep.url}. Do NOT deploy, redeploy, restart
       or tear down anything — this run's orchestrator owns the stack, and a second stack would
       collide with it. Export the URL before you start:
         export TEST_APP_BASE_URL="${dep.url}"
       That also tells a worktree-aware /test-app the stack is already up, so it tests that URL
       instead of starting a competing one.`
      // ${SESSION} / ${BINPATH} above are placeholders the per-half strings fill in below: the two
      // tui halves each get their OWN session, so the handoff cannot bake one in.
      const fillHandoff = (session) => handoff
        .replace('${SESSION}', session || '')
        .replace(/\$\{BINPATH\}/g, String(depHandle || ''))
      const reportRules =
        `Report-only: no fixes, no tests, no plan mode. Stay diff-scoped — verify the CHANGED
       functionality, not the whole app. Report only defects you have HIGH confidence are real;
       if something is likely intentional or you are unsure, skip it. If everything passed, say
       so — never invent findings. Tag each finding fixSize=minor|major BY THE SIZE AND RISK OF
       ITS FIX, not by severity (a one-line fix for a serious bug is still minor). Your report
       MUST open with the confirmation line — \`✅ Invoked the real /test-app skill …\` if it ran,
       or \`❌ Did NOT run …\` with the reason if it didn't — and set ran=false in that ❌ case.
       If /test-app produces no output within a bounded wait, stop waiting: return the ❌ line
       rather than blocking the run.
       WHEN YOU SET ran=false, PUT THE REASON IN blockedReason AND RETURN findings: []. A blockage
       is NOT a finding. Do not tag it fixSize, do not phrase it as a defect, and do not put the
       missing tool, the dead stack or the absent skill in 'where' — everything in \`findings\` is
       dispatched to a fixer as work and stored as an adjudicated result, so a blockage that
       arrives as a finding is recorded as a defect somebody found and fixed. The orchestrator
       already records a blocked half from your ran flag; blockedReason is what tells it why.
       Findings you genuinely observed still belong in \`findings\` even when ran=false — a half
       that fell back to another route and saw something real should report it.${uiIntent}`
      // Which halves run, by surface. 'cli' collapses to ONE: there is no visual pass on a surface
      // with no rendering, and dispatching an empty second half spends a whole agent to produce
      // "nothing to check". 'tui' keeps both, because a rendered frame is exactly what a visual
      // half is for — and each gets its OWN session, since two agents driving one pane interleave
      // their keystrokes and both then report nonsense.
      const webHalves = [
        { label: 'ui-functional', session: 'ptr-func', prompt:
      `You are the FUNCTIONAL half of the UI verification. A visual half runs in PARALLEL with you
       and owns screenshots, layout and design — do not do its job, and do not wait for it.
       ${handoff}
       Use an isolated browser session so the two halves never share a page or a viewport:
         export AGENT_BROWSER_SESSION=ptr-func
       Invoke the REAL /test-app skill (Skill tool) over the changed functionality, scoped to
       BEHAVIOUR: API responses and status codes, form submits and redirects, end-to-end flows,
       and the app logs (new ERROR entries / stack traces during your window). Say the scope in
       the argument you pass it, e.g.
         test-app <the change> — functional checks only (API, flows, logs), no screenshot pass;
         the app is already running at $TEST_APP_BASE_URL, test against that.
       Never hand-roll curl checks in place of the skill — /test-app is the real tool here.
       ${reportRules}` },
        { label: 'ui-visual', session: 'ptr-visual', prompt:
      `You are the VISUAL half of the UI verification. A functional half runs in PARALLEL with you
       and owns API, flow and log checks — do not repeat them, and do not wait for it.
       ${handoff}
       Use an isolated browser session so the two halves never share a page or a viewport:
         export AGENT_BROWSER_SESSION=ptr-visual
       Invoke the REAL /test-app skill (Skill tool) scoped to the VISUAL pass only — screenshot
       the changed pages and check how they render. Say that in the argument you pass it.
       SCREENSHOT BUDGET — at most 6. Pick the TWO pages this diff changed most and capture each
       at three viewports: desktop (1280x800), tablet (\`set viewport 768 1024\`, iPad portrait)
       and mobile (\`set device "iPhone 14"\`). One changed page => 3 shots. Measured past runs
       took a median of 7 and up to 35; beyond ~6 the extra shots mostly re-show what the first
       ones already showed, and every one of them is an image you then have to read.
       Batch the viewport switch and the capture into ONE call, so a run doesn't spend a whole
       model turn per screenshot:
         agent-browser batch 'set viewport 768 1024' 'open <url>' 'screenshot <durable path>'
       Reset with \`agent-browser set viewport 1280 800\` when you're done.
       On the tablet and mobile shots apply the responsive checklist: no horizontal overflow at
       narrow widths; nav collapses (e.g. to a hamburger) instead of clipping or spilling;
       content reflows to one column rather than being cut off; tap targets not overlapping;
       modals, tables and forms still usable. Tag each responsive finding with the viewport it
       failed at. A slightly tight margin on a phone is not a defect; content you cannot reach
       or read is.
       THEN load the \`frontend-design\` skill (Skill tool) and judge those screenshots against
       its rubric — typography, colour/theme cohesion, spatial composition, and the
       "never generic AI-slop" rules. This is not optional garnish: it is half of why this agent
       exists, and it was measured running in only 11 of 59 past UI verifications. It is a
       different lens from "is it broken" — flag genuine, high-confidence design defects only,
       and skip pure style preference.
       Save every screenshot to a DURABLE path (not an ephemeral temp dir) and return those paths
       in the findings, so the orchestrator can embed them in a report after the stack is gone.
       ${reportRules}` },
      ]
      const tuiHalves = [
        { label: 'tui-functional', session: tuiSessions[0] || '', prompt:
      `You are the FUNCTIONAL half of the terminal verification. A visual half runs in PARALLEL
       with you and owns rendering, geometry and frame captures — do not do its job, and do not
       wait for it.
       ${fillHandoff(tuiSessions[0] || '')}
       Invoke the REAL /test-app skill (Skill tool) over the changed functionality, scoped to
       BEHAVIOUR: drive the real keys through the flows the change touched, assert on what the app
       drew, exercise the failure paths, and read the app logs (new ERROR entries during your
       window — on this surface stdout IS the UI, so the log is a file or a debug channel, never
       stdout). Say the scope in the argument you pass it, e.g.
         test-app <the change> — functional checks only (keys, flows, logs), no rendering pass;
         the app is already running in $TEST_APP_SESSION, attach to that.
       Never hand-roll your own tmux or expect wrapper in place of the skill and the driver — an
       ad-hoc wrapper fails open everywhere the driver fails closed, which is the whole reason the
       driver exists. /test-app is the real tool here.
       ${reportRules}` },
        { label: 'tui-visual', session: tuiSessions[1] || '', prompt:
      `You are the VISUAL half of the terminal verification. A functional half runs in PARALLEL
       with you and owns keys, flows and log checks — do not repeat them, and do not wait for it.
       ${fillHandoff(tuiSessions[1] || '')}
       Invoke the REAL /test-app skill (Skill tool) scoped to the RENDERING pass only — capture the
       changed screens and check how they draw. Say that in the argument you pass it.
       GEOMETRY SWEEP — capture each changed screen at three sizes, via \`resize\`, re-render, then
       \`capture\`: wide (160x50), the app's own default, and 80x24. That last one is the one that
       finds things: it is the size every terminal guarantees, and it is where a layout that
       quietly assumes width falls apart — the same role the mobile viewport plays on a web page.
       Reset to the wide size before you return, so a later capture is not skewed.
       CAPTURE BUDGET — at most 6, and the reason is NOT the reason the web half has one: a capture
       is TEXT, so it costs nothing to read. The cap here is scope discipline — the two screens
       this diff changed most, each at three sizes. Do not paste a capture of a screen the diff
       never touched.
       Judge each frame against this rubric, and report only genuine, high-confidence defects —
       never style preference:
         1. It fits the box — nothing truncated at the right edge or scrolled off the bottom at
            80x24; no wrapped line that breaks a table row or a border.
         2. Columns and borders line up — headers over their data, boxes closed, padding even.
            Wide characters and emoji are the usual culprit.
         3. Colour is never the only signal — a state distinguished only by colour is invisible on
            a monochrome terminal; there must be a glyph or a word too. And no raw escape
            sequences showing as literal text.
         4. Focus and affordance — the focused element is visibly focused, and the keys that work
            HERE are shown or one keypress away.
         5. Empty and error states read as intended — an empty list says it is empty rather than
            showing a blank pane; an error is a legible message, not a raw panic in the frame.
         6. Redraw is clean — after a resize the frame redraws whole: no leftovers from the
            previous geometry, no doubled borders, no stale half-row.
       Do NOT load the \`frontend-design\` skill here. It judges typography, colour cohesion,
       spatial composition, motion and atmosphere; asked to grade an 80x24 text frame it produces
       findings that are not about anything, and this track's precision is what they would land in.
       The rubric above is its replacement on this surface.
       Save every capture to a DURABLE path (not an ephemeral temp dir) and return those paths in
       the findings. A capture is text, which is the advantage: quote the three broken lines rather
       than attaching an image nobody can search, and two geometries can be diffed directly.
       ${reportRules}` },
      ]
      const cliHalves = [
        { label: 'cli-functional', session: '', prompt:
      `You are the sole verifier for this change. There is no visual half: this app renders
       nothing, so there is no frame to judge and nobody else is running.
       ${fillHandoff('')}
       Invoke the REAL /test-app skill (Skill tool) over the changed functionality. Scope it to the
       argv contract and the failure paths, and assert the WHOLE result on every check — the exit
       code, stdout AND stderr — never just the exit code. The defects that actually ship here are
       an error path that prints a message and then returns success, and a diagnostic that leaks
       onto stdout and corrupts whatever the caller was piping it into. Say the scope in the
       argument you pass it, e.g.
         test-app <the change> — argv, exit codes and stream separation; the binary is already
         built at $TEST_APP_BIN, test that one.
       Never hand-roll invocations in place of the skill — /test-app is the real tool here.
       ${reportRules}` },
      ]
      const halves = depSurface === 'tui' ? tuiHalves : depSurface === 'cli' ? cliHalves : webHalves
      const parts = await parallel(halves.map((h) => () =>
        reliable(h.label, 'UI', () => agent(h.prompt,
          { label: h.label, phase: 'UI', schema: UIRES, agentType: 'r:bug-hunter-ui', ...VERIFY }))))
      uiDead = halves.filter((h, i) => blocked(parts[i])).map((h) => h.label)
      uiReasons = halves
        .map((h, i) => (blocked(parts[i]) && parts[i] && parts[i].blockedReason)
          ? `${h.label}: ${parts[i].blockedReason}` : '')
        .filter(Boolean)
      if (uiDead.length) {
        log(`post-task-review: UI half BLOCKED — ${uiDead.join(', ')}. The UI track is INCOMPLETE; ` +
            `the surviving half's findings still flow into triage, but this is not a clean bill.`)
      }
      // ran only if BOTH halves reported — a half that died is a coverage hole, and reading the
      // survivor as a full pass is the same phantom-clean failure the hunter fan-out guards against.
      ui = {
        ran: uiDead.length === 0,
        findings: parts.flatMap((p, i) =>
          // The lens is the label's LAST segment, not the label minus 'ui-': a naive replace turns
          // 'tui-functional' into 'tfunctional', because the first 'ui-' it finds is inside 'tui'.
          ((p && p.findings) || []).map((f) => ({ ...f, lens: halves[i].label.split('-').pop() }))),
      }
    }
  }
}

// --- The barrier: end-verify and the UI track run TOGETHER --------------------
// They were serial, and they are the two longest blocks in the pipeline: the UI step measured a
// median of 542s (p90 1150s) and the end-verify is up to two Codex passes each followed by a fixer.
// They also read different things — one reads the git diff, the other drives a browser against a
// deployed image — and share nothing until their fixes land. So they overlap, and everything that
// WRITES waits for the join: the UI fixes, the issue filing, and the teardown all happen below.
//
// The honesty cost, and the guard that pays it. The UI half verifies an image built before the
// end-verify's fixers ran. When one of those fixers touched a frontend file, what the UI looked at
// is stale — so it looks again, once. That case costs roughly what running the two serially costs
// every time, which is the point: the worst case here is the serial ordering, and the common case
// (end-verify fixes are overwhelmingly backend) is the whole overlap.
if (uiWanted && !triage.hasTestApp) {
  log('post-task-review: the change touches the frontend but /test-app is not on disk — no UI ' +
      'verification ran. Nothing looked at the rendered result; this is a gap, not a clean bill.')
}
if (!uiWanted) {
  log(`post-task-review: no frontend change in this diff (${profile} tier) — skipping UI verification. ` +
      `The static tracks read the change; there is no new rendered result to look at.`)
}
try {
  await parallel([endVerifyTrack, uiTrack])

  if (ui && ui.ran && endVerifyTouchedFrontend) {
    log('post-task-review: an end-verify fix landed in a frontend file AFTER the UI halves read the ' +
        'deployed image — re-deploying and re-verifying once so the UI verdict describes the code ' +
        'that actually ships.')
    await uiTrack()
  }

  const findings = (ui && ui.findings) || []
  const minor = findings.filter(f => f.fixSize === 'minor')
  const major = findings.filter(f => f.fixSize === 'major')
  // Whether the fixer actually came back, not whether the finding was TAGGED minor. Derived from
  // the tag alone, `fixed` says a defect was repaired on every run where the fixer died — the one
  // shape of this record that cannot be checked later, since a dead agent leaves no diff to read.
  let minorFixer = null
  if (minor.length) minorFixer = await agent(`Fix these minor UI/runtime defects (surgical), ${rebuildClause}
    Then redeploy and re-verify once:\n${minor.map(f => `${f.where}: ${f.title} — ${f.suggestedFix}`).join('\n')}${intentBlock}`,
    { label: 'ui-fix-minor', phase: 'UI', ...domainFixer, ...FIX_RUN })
  // Same rule as the fixer above, for the same reason: whether the FILER came back, not whether
  // findings were TAGGED major. A filer that died wrote nothing, and a summary still reporting
  // them filed sends the reader to a backlog entry that does not exist.
  let majorFiler = null
  if (major.length) majorFiler = await agent(`Record every major UI finding as an item in this
    project's issue backlog. Local files only — no \`gh\`, no tracker, nothing outside the repo.

    Write \`issues/ui-review-<YYYY-MM-DD>.md\` (\`mkdir -p issues\` first; take the date and the
    time from \`date +%F\` / \`date +%H:%M\` in your own shell). APPEND, never overwrite: when the
    file already exists, add this run's items under a new \`## <HH:MM> — post-task-review\`
    heading, so a second review the same day does not erase the first one's backlog.

    One UNTICKED \`- [ ]\` item per finding — the title on the item line, the body indented
    beneath it: where (route / \`file:line\`), what it does vs. what it should do, the evidence
    (HTTP status, log line), the suggested fix, and the viewport for a responsive finding. That
    shape is what \`/r:issues-fix\`'s file adapter parses (one item per \`- [ ]\` line, indented
    lines as its body), and the empty box is the write-back it ticks when the item is done.

    Screenshots: copy each durable path named in the findings into \`issues/assets/<slug>/\` and
    link it relatively (\`![](assets/<slug>/step-3.png)\`), so the file still reads after an
    ephemeral worktree is gone.

    Return the path you wrote and how many items you appended. Findings:
    ${JSON.stringify(major)}`, { label: 'ui-file-major', phase: 'UI', ...GP, ...MECHANICAL })
  if (major.length && !majorFiler) {
    log(`post-task-review: the issue filer did NOT come back — ${major.length} major UI ` +
        `finding(s) are NOT in issues/ and exist only in this transcript. File them by hand.`)
  }
  minorFixed = minor.length > 0 && !!minorFixer
  if (uiWanted && triage.hasTestApp) {
    uiSummary = {
      // Which surface this run actually verified. Free to carry: record-run.py JSON-dumps the whole
      // record into `payload` with no field whitelist, and skill-stats.py merges it back.
      surface: uiSurfaceResolved,
      ran: ui && ui.ran, minorFixed: minorFixed ? minor.length : 0,
      majorFiled: majorFiler ? major.length : 0, blocked: blocked(ui),
      // A filer that never returned is a GAP, not a filing. Present only in that case, so a reader
      // (and the stats row) can tell "nothing was major" from "the backlog write never happened".
      ...(major.length && !majorFiler ? { majorUnfiled: major.length } : {}),
      // An absent /test-app, in the deploy step's own words. Set only when the file really was
      // not on disk, so it also records that the early gate and the real check disagreed.
      ...(uiMissing ? { missing: uiMissing } : {}),
      // Which half fell over, so a "UI blocked" line in the stats store can be read without the
      // transcript: a dead visual half and a dead functional half mean very different coverage.
      blockedHalves: uiDead,
      // Why, in the halves' own words. Without it a reader has the fact of a blocked track and
      // no way to tell an absent /test-app from a stack that would not come up — one is setup,
      // the other is a real failure, and they need opposite responses.
      blockedReasons: uiReasons,
    }
  }
} finally {
  // try/finally is the structural version of "teardown on ANY exit path". It sits out here rather
  // than inside the UI track because the track now runs inside parallel(), which swallows a throw
  // into a null — a teardown nested in there would be skipped exactly when it is needed most.
  // Retried, because a teardown that dies leaks the worktree's containers and volumes, and the next
  // run in that worktree then collides with the stack this one left behind.
  if (uiWanted && triage.hasTestApp) {
    // 'cli' started nothing, so there is nothing to tear down and no agent worth spending on it.
    const tuiTeardown = uiSurfaceResolved === 'tui'
    const td = uiSurfaceResolved === 'cli' ? true : await reliable('ui-teardown', 'UI', () => agent(
      tuiTeardown
        ? `Stop every tmux session this run started, unconditionally, and report what you did:
             TUI="${PACK}/skills/test-app-create/scripts/tui-session.sh"
           ${(uiSessions.length ? uiSessions : ['<none recorded>']).map((h) => `  "$TUI" stop '${h}'`).join('\n           ')}
           \`stop\` is a no-op on a session that is already gone, so run it even if you believe the
           run never got that far. Exit 127 means tmux is not installed — say so and return; nothing
           was started, so nothing is leaking. Do NOT run worktree-deploy.sh: it requires docker and
           has nothing to do with a terminal app.`
        : `Run \`"${PACK}/skills/task-review/scripts/worktree-deploy.sh" teardown\`
      unconditionally (no-op in the main tree; tears down the ephemeral stack in a worktree).`,
      { label: 'ui-teardown', phase: 'UI', ...GP, ...ECHO }))
    if (blocked(td)) log(tuiTeardown
      ? 'post-task-review: UI teardown NOT confirmed — a tmux session may still be running. It is invisible to `docker ps`, so list them with `tmux ls` and stop them by hand; the driver\'s TTL will otherwise reap it within the hour.'
      : 'post-task-review: UI teardown NOT confirmed — an ephemeral worktree stack may still be running; tear it down by hand with `worktree-deploy.sh teardown`.')
  }
}

// --- Step 9 boundary: record learnings + compact CLAUDE.md (MAIN AGENT) -------
// Step 9 is deliberately NOT a workflow phase. 9a (record learnings into CLAUDE.md)
// needs this session's reasoning about WHAT was learned and WHY — context a fresh
// workflow subagent doesn't have — so it belongs to the main agent, exactly like
// this workflow already leaves `docDrift` surfacing to the main agent. 9b (compact)
// must run AFTER 9a, because its gate keys off whether CLAUDE.md changed this turn
// (the 9a append is usually what makes that true). So both run in the main agent
// once this returns: append learnings, then if CLAUDE.md changed this turn AND its
// root > ~200 lines, dispatch `/r:claudemd-compact --auto` in a general-purpose
// subagent (unattended, evidence-gated pruning). See Step 9 in SKILL.md.
// `step9: 'main-agent'` is the explicit handoff signal, not an omission.
// 9c (the stats row) is the exception: it needs only values this script already holds and
// nothing from the session's reasoning, so it runs HERE — see the stats sink below. A caller
// that forgot it would silently lose the run, which is the failure the sink exists to avoid.

// ------------------------------------------------------------- consolidate ---
// `docs` is listed in its own right now that it runs outside the Review barrier — it is still a
// dispatched track, and a caller has to be able to see that nothing checked the change against the
// documentation.
const TRACKS = [['codex', codex, wantCodexUpfront],
                [hunterTrack, bugs, profile !== 'light'],
                ['docs', docs, profile !== 'light'],
                ['code-quality', quality, wantQuality]]
// A track fails to certify in two ways, and `blocked()` cannot tell them apart because `ran`
// deliberately collapses both. Split them HERE, at the only point that still knows which hunter
// caused it. Both mean the same thing to a caller deciding whether to merge — the change has a
// surface nothing looked at — so `tracksDrifted` is as disqualifying as `tracksBlocked`, and
// issues-fix's merge gate reads both. What differs is the fix each one asks for.
// A track with no hunter-level detail (codex, docs, code-quality — one agent, not a fan-out)
// keeps the old behaviour and lands in tracksBlocked, which is where its failure has always been.
const hunterDetail = (r) => !!(r && (Array.isArray(r.blockedHunters) || Array.isArray(r.driftedHunters)))
const blockedOf = (r) => (r && r.blockedHunters) || []
const driftedOf = (r) => (r && r.driftedHunters) || []
const tracksBlocked = TRACKS.filter(([, r, ran]) =>
  ran && blocked(r) && (!hunterDetail(r) || blockedOf(r).length)).map(([n]) => n)
// Named per TRACK, like tracksBlocked, but carrying the hunter too: "find-bugs (security)" is
// the whole diagnosis, and without the hunter name a reader has to open the transcript to learn
// which of three or four hunters read the wrong thing. Below full tier the track is already named
// for its single hunter ('security hunter'), so the suffix would only repeat it.
const tracksDrifted = TRACKS.filter(([, r, ran]) => ran && driftedOf(r).length)
  .map(([n, r]) => {
    const who = driftedOf(r).filter((h) => !n.includes(h))
    return who.length ? `${n} (${who.join(', ')})` : n
  })
// Named separately from tracksBlocked so a caller can tell an absent optional prerequisite
// from a tool that failed. Both mean the step did not run; only one is anybody's fault.
//
// The security hunter is appended by hand because its gate is not like the others': `securitySurface`
// is a per-DIFF decision taken above, not a tier decision, so nothing in TRACKS can see it — at full
// tier the hunter simply drops out of HUNTER_SET while `hunterTrack` still reports as having run.
// Recording it matters beyond this payload: the stats report derives a track's denominator from the
// TIER, so without this line every standard/full run counts as an opportunity security had, whether
// or not the hunter dispatched, and its fixes-per-run reads lower than it earned — which is the
// number the retirement list reads. Logging the skip to the user is not recording it.
const tracksSkipped = TRACKS.filter(([, r, ran]) => ran && skipped(r)).map(([n]) => n)
  .concat(!securitySurface && profile !== 'light' ? ['security'] : [])
const endVerifyVerdict = !endVerifyWanted ? 'skipped'
  : endVerifyBlocked ? 'blocked'
  : (endVerifyUnresolved.length ? 'findings-unresolved' : 'passed')

// --- Stats sink: one append-only line per run (BEST EFFORT) ------------------
// Every tier decision in this pipeline was argued from mechanism, never measured — which track
// actually produces the fixes is unknown, so no track can be retired on evidence. This records
// it. `fixedBySource` is the payload that matters; everything else is the context needed to read
// it (a track scores zero on a tier that never dispatched it).
//
// Two rules this must never break:
//   * It CANNOT fail the run. No reliable(), no blocked() check, no halt — bookkeeping about a
//     review must never be able to sink the review. A dead sink loses one row, silently.
//   * Findings are TITLES, never bodies — one short line each, capped at FINDING_CAP. The whole
//     payload travels inside this step's prompt, so an uncapped finding is paid for twice: once
//     in the prompt that carries it and once in every future read of the row.
// The heredoc is quoted, so nothing in the JSON is expanded; JSON.stringify emits one line, so
// the delimiter can't collide with the payload.
const FINDING_CAP = 200
const short = (s) => String(s == null ? '' : s).slice(0, FINDING_CAP)
// `fixList` is null when triage produced nothing, and the finding rows below must still build —
// an empty review has to record an empty list, not throw inside the bookkeeping step.
const fixed = fixList || { correctness: [], readability: [], docDrift: [] }
const statsRow = {
  kind: 'review',
  profile,
  // WITHOUT this, a forced tier is indistinguishable from a classified one, and the tier
  // distribution silently becomes "what the user typed" rather than "what the classifier
  // decided" — the exact question it looks like it answers. The workflow already knows; it
  // just wasn't being written down.
  profileForced: TIERS.includes(opts.profile),
  // The classifier's own justification, so the tier distribution can be audited instead of only
  // counted. 21 of 26 classified runs land on 'full', and a step down from it is worth ~37M
  // tokens measured (71.1M/run at full against 33.8M at standard) — which makes this the cheapest
  // field in the row and the one that decides whether that 21 is a finding or a fact.
  profileReason: short(triage.profileReason) || null,
  // Inferred, not observed: /r:task-run Step 5 is the only caller that passes deferCommit, so its
  // absence means a human invoked this directly. That matters because a direct invocation is
  // often a RE-review of a diff that was already reviewed and fixed once — its findings are not
  // comparable to a first pass, and nothing inside this workflow can detect that on its own.
  invokedBy: opts.deferCommit ? 'run-task' : 'direct',
  // Whether the up-front Codex ran adversarial or the lighter built-in reviewer. Without it, a
  // `full` run whose approach was already challenged at plan time is indistinguishable in the store
  // from one that got the strict pass — and `codex` fixes/run is exactly the number that would
  // answer whether the down-mode was a good trade.
  codexMode: codexMode || 'none',
  uiTouched,
  scope: opts.scope === 'all' ? 'all' : 'diff',
  tracksBlocked,
  tracksDrifted,
  tracksSkipped,
  fixedBySource,
  fixedCorrectness: fixed.correctness.length + endVerifyFixed,
  fixedReadability: fixed.readability.length,
  docDriftCount: fixed.docDrift.length,
  endVerify: endVerifyVerdict,
  endVerifyCount: endVerifyUnresolved.length,
  // Four outcomes that leave the same trace in the store today: a clean review, a review of a
  // DIFFERENT changeset, a tool that died, and a gate that never dispatched it. All 47 recorded
  // dispatches returned findings:[], and with the four collapsed that number cannot tell a clean
  // diff from a track that never reports anything. `tracksBlocked`/`tracksSkipped` carry the
  // MERGED hunter track, never this half of it on its own.
  security: profile === 'light' ? 'not-dispatched'
    : (bugs && bugs.security) ? bugs.security : 'blocked',
  localScan,
  // Whether the scan REWROTE the code, which `localScan` alone cannot say: 'ok' covers both a scan
  // that found nothing and one that self-fixed — and only the second owes a rebuild and forces an
  // end-verify. It is also the only yield signal this track can produce, because local-scan applies
  // its own fixes instead of feeding the triage fix-list, so it can never appear in `fixedBySource`.
  // Reading a zero here as "the scan finds nothing" would be measuring the metric, not the tool.
  // THREE states, deliberately: true/false only when a scan actually completed, null when it did
  // not (n/a, blocked, skipped), and the key ABSENT on rows written before this field existed.
  // Collapsing either of the last two into `false` invents a quiet scan that never ran.
  scanChangedCode: localScan === 'ok' ? scanChangedCode : null,
  build: buildGreen ? 'green' : (triage.buildTool === 'none' ? 'n/a' : 'red'),
  ui: uiSummary,
  // One row per finding, with the verdict triage reached. `fixedBySource` counts only what
  // survived, so on its own a noisy track and a silent one are the same number; these rows are
  // what tell them apart. Text is trimmed hard because the whole payload travels inside the sink
  // agent's prompt — the store keeps counts and short titles, never full finding bodies.
  findings: [
    ...fixed.correctness.map((c) => ({
      track: c.source, verdict: 'confirmed', fixed: true, description: short(c.item),
    })),
    ...dismissedCorrectness.map((c) => ({
      track: (c && c.source) || 'unattributed', verdict: 'dismissed', fixed: false,
      description: short((c && c.item) || c),
    })),
    ...fixed.readability.map((r) => ({
      track: 'code-quality', verdict: 'confirmed', fixed: true, description: short(r),
    })),
    ...dismissedReadability.map((r) => ({
      track: 'code-quality', verdict: 'dismissed', fixed: false, description: short(r),
    })),
    // Doc drift is never triaged — it is handed to the user, not fixed — so it is `unresolved`
    // by construction rather than by anyone declining to judge it.
    ...fixed.docDrift.map((d) => ({
      track: 'docs', verdict: 'unresolved', fixed: false, description: short(d),
    })),
    // The end-verify pass adjudicates its own findings: what it kept is real and was handed to a
    // fixer, and the pass-local rejects never leave the loop.
    ...endVerifyUnresolved.map((e) => ({
      track: 'end-verify', verdict: 'confirmed', fixed: false, description: short(e),
    })),
    // `fixed` comes from whether the UI fixer actually returned, never from the fixSize tag: the
    // tag is the finding's own claim about how big its fix would be, and reading it as "it was
    // fixed" records a repair on every run where the fixer died. A major finding is filed as an
    // issue, not fixed, so it is false by construction here.
    ...((ui && Array.isArray(ui.findings)) ? ui.findings : []).map((f) => ({
      // Terminal findings get their OWN track names and do not merge into the browser ones. Same
      // call the pack already made for `quick-codex` against `codex`: same job, different mode, and
      // merging them makes neither readable. Here it is not even the same tool — a captured frame
      // against agent-browser, a written rubric against `frontend-design`. ui-visual's 11-confirmed
      // /0-dismissed and ui-functional's 6/0 are BROWSER numbers; a terminal run must not be able to
      // borrow them, and nobody must be able to argue them about a TUI. These start at zero, which
      // is the honest place to start. Do not merge them back.
      track: `${uiSurfaceResolved === 'web' ? 'ui' : uiSurfaceResolved}-${f.lens || 'functional'}`,
      severity: f.fixSize,
      verdict: 'confirmed', fixed: f.fixSize === 'minor' && minorFixed,
      description: short(`${f.title || ''} — ${f.where || ''}`),
    })),
  ],
}
await agent(
  `Record one line of review statistics. This is bookkeeping — if anything goes wrong, say so
   and return; do NOT retry, do NOT fix anything, and do NOT treat it as a failure of the review.
   Run exactly this from the repo root, then return the script's stderr line verbatim:

   python3 "${PACK}/lib/record-run.py" <<'PTR_STATS_JSON'
${JSON.stringify(statsRow)}
PTR_STATS_JSON

   The script always exits 0 by design; its stderr says whether the row was recorded.`,
  // The echo tier: this appends one JSONL line and edits nothing, and by design it can never fail
  // the run. run-task's identical sink is pinned the same way. Unpinned it inherits whatever the
  // caller is running at — for a /r:task-run chain, Opus, to run one `python3 script <<EOF`.
  { label: 'stats', phase: 'End-verify', ...GP, ...ECHO })

// Keep the project's reuse index fed. This lives HERE, at the end of the review, rather than in
// run-task's implement half, for three reasons that all point the same way: /r:issues-fix drives
// both pipelines by scriptPath and never loads run-task's SKILL.md, so only a step inside a
// workflow is on every route; the implement half stops at Build, before the fix phase below has
// finished changing the code, so anchors verified there go stale inside the same run; and this
// pipeline always runs under deferCommit, so what it writes lands in the task's single commit
// rather than trailing it.
//
// It is a MERGE, never a rebuild, and it no-ops unless an index already exists — the first build
// does the full clustering pass and is a deliberate `/r:reuse-index` by hand. On a standalone
// review with no new plan it still earns its slot: it re-verifies every anchor against the tree
// the fix phase just changed.
//
// Sonnet/low rather than the stats sink's haiku, because merging a newly-qualifying entry is a
// judgement; far below the hunters, because on most runs there is nothing new to merge.
// try/catch, not reliable(): reliable() RETRIES, and this step must not. It is the last thing
// the script does before handing back its summary, so an untrapped throw here would discard a
// completed review — a blockage recorded as a failure of the work it came after.
try {
await agent(
  `Bookkeeping — if anything goes wrong, say so and return; do NOT retry, do NOT fix anything,
   and do NOT treat it as a failure of the review. Never edit code here.

   Keep this project's reuse index current, if it HAS one. From the repo root:

   1. Find the index: a tracked reference doc named like \`reuse-index.md\` that this project's
      root CLAUDE.md points at, else under docs/. **No index file, or no .task-plans/ corpus =>
      you are done. Say which and return.** Do not create one; the first build is a deliberate
      /r:reuse-index run that does a full clustering pass.
   2. Run the mechanical half over the corpus:

      python3 "${PACK}/skills/reuse-index/scripts/reuse-index.py" \\
        --plans .task-plans --repo . --index <the index you found>

   3. \`changed: false\` => return "index current", write nothing.
      Otherwise MERGE per "${PACK}/skills/reuse-index/references/output-format.md": existing
      entries keep their prose and only their Cited counts refresh; entries in \`new\` are added
      to the right section; \`stale\` anchors are re-resolved from the script's candidates where
      that is unambiguous, and otherwise left in place and marked. Never delete an entry silently
      and never regenerate the file.

   Return one line: entries added, counts moved, anchors re-resolved, anything a human must judge.`,
  { label: 'reuse-index', phase: 'End-verify', ...GP, ...MECHANICAL })
} catch { /* the index is bookkeeping; a review that ran is not undone by it */ }

// The real findings, itemized, for the caller to fold into the plan file. run-task appends these
// as a "## Post-review changes" section on `.task-plans/<slug>.md` (tracked now, and linked from
// the reuse-index), so the committed plan records what the review CHANGED, not only what was
// planned. Reuses the same per-finding objects the stats sink builds, minus the dismissed ones:
// a dismissed finding was judged not real and never touched the code, so it does not belong in
// the plan's record of the build. The stats sink is unchanged — this is a second, richer reader
// of the same roll-up, kept off the store because the store keeps counts, never finding bodies.
const appliedFindings = statsRow.findings
  .filter((f) => f.verdict !== 'dismissed')
  .map(({ track, verdict, fixed, description }) => ({ track, verdict, fixed, description }))

return {
  reviewed: true,
  profile,
  uiTouched,
  // Only tracks this tier dispatched can be reported blocked. A track the tier never ran is not
  // a failure, and naming it here would tell a caller a tool died when nothing did.
  tracksBlocked,
  tracksDrifted,
  tracksSkipped,
  // What each finding track actually bought: correctness items that survived triage, keyed by the
  // track that found them. This is the number that can retire a track on evidence instead of
  // argument; it is also written to ~/.claude/skill-stats.jsonl for accumulation across runs.
  fixedBySource,
  // correctness = the triaged fix-list items + everything the end-verify handed to a fixer. BOTH
  // halves count: without the second, a run that finds and fixes a defect at the end still reports
  // `correctness: 0`, a summary field contradicting what the run just did.
  // Each half is counted only when its fixer LIVED: a triaged list is what someone was asked to
  // do, not what got done, and the whole value of this field is that a caller can merge on it.
  fixed: { correctness: (fixList && fixApplied.correctness ? fixList.correctness.length : 0) + endVerifyFixed,
           readability: fixList && fixApplied.readability ? fixList.readability.length : 0 },
  docDrift: fixList ? fixList.docDrift : [],
  build: buildGreen ? 'green' : (triage.buildTool === 'none' ? 'n/a' : 'red'),
  // ok | skipped (nothing JVM changed) | blocked (scan died/errored — NOT scanned) | n/a (no build tool).
  // Reported because /r:code-scan is mandatory in every tier: a caller has to be able to see that
  // the static pass did not actually happen, rather than infer it from a silent success.
  // Four outcomes that leave the same trace in the store today: a clean review, a review of a
  // DIFFERENT changeset, a tool that died, and a gate that never dispatched it. All 47 recorded
  // dispatches returned findings:[], and with the four collapsed that number cannot tell a clean
  // diff from a track that never reports anything. `tracksBlocked`/`tracksSkipped` carry the
  // MERGED hunter track, never this half of it on its own.
  security: profile === 'light' ? 'not-dispatched'
    : (bugs && bugs.security) ? bugs.security : 'blocked',
  localScan,
  // true when the scan applied its own fixes, so the final diff contains machine-written code the
  // caller never saw in the fix-list; null when no scan completed. Same three states as the stats
  // row, and it is on the return object so a transcript back-fill can recover it.
  scanChangedCode: localScan === 'ok' ? scanChangedCode : null,
  // skipped (nothing to re-read) | blocked (Codex didn't run — the final diff is UNVERIFIED)
  // | findings-unresolved (a pass raised findings that no later pass read clean) | passed.
  // 'passed' REQUIRES a Codex pass that came back with nothing outstanding: it is the word a
  // caller merges on, so it must be unreachable with findings still on the table.
  endVerify: endVerifyVerdict,
  // The unresolved remainder, verbatim. Empty on 'passed'/'skipped'. This is the difference
  // between surfacing a defect to the caller and swallowing it.
  endVerifyFindings: endVerifyUnresolved,
  // Every real finding this review acted on ({ track, verdict, fixed, description }), for the
  // caller to write into the plan file as a "## Post-review changes" section before the commit.
  appliedFindings,
  ui: uiSummary,
  step9: 'main-agent', // record learnings (9a) + gated /r:claudemd-compact --auto (9b) run after this returns
}
