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
//   The hunter fan-out USED to differ between the engines (this script spawned the
//   hunters itself; the prose nested them under one find-bugs subagent). It no
//   longer does: nobody can nest them anymore, so the prose engine now spawns the same
//   hunters directly too. The engines agree here - keep them that way, including WHICH
//   hunters each tier dispatches (full: all four; standard: security + docs only).
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
    coverage: { type: 'string' }, // e.g. what /security-review actually reviewed
  },
}
const TRIAGE = {
  type: 'object', additionalProperties: false,
  required: ['reviewNeeded', 'reason', 'profile', 'uiTouched', 'hasTestApp'],
  properties: {
    reviewNeeded: { type: 'boolean' },
    profile: { type: 'string', enum: ['light', 'standard', 'full'] }, // review tier — 'standard' absorbs uncertainty
    uiTouched: { type: 'boolean' },         // any frontend file changed -> the UI gate, in EVERY tier
    reason: { type: 'string' },
    changeIntent: { type: 'string' }, // 1-3 sentences: what this change is trying to do (fix subagents get it so they don't undo intentional work)
    buildTool: { type: 'string', enum: ['maven', 'gradle', 'none'] },
    buildCmd: { type: 'string' },           // CLEAN, certifying build — used once, for the run's first build
    buildCmdFast: { type: 'string' },       // incremental rebuild — every build AFTER the first one in this run
    runnerAgent: { type: 'string' },        // maven-build-runner | gradle-build-runner
    changedFiles: { type: 'array', items: { type: 'string' } },
    hasBackend: { type: 'boolean' },
    hasFrontend: { type: 'boolean' },
    hasTestApp: { type: 'boolean' },        // /test-app present ON DISK — the Phase 7 gate, folded in here to save a hop
    // Does the diff touch anything /security-review could have an opinion about? Deliberately
    // NOT required, and read as `!== false` below: an unanswered gate runs the hunter. A missing
    // field must never be the reason a security review was skipped.
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
const CORRECTNESS_LIST = {
  type: 'object', additionalProperties: false,
  required: ['correctness'],
  properties: {
    // {item, source} rather than a bare string: without the source, every downstream count is
    // "the review fixed 8 things" and no one can ever ask WHICH track found them — which is the
    // only question that can retire a track for not earning its keep. The fixer is still shown
    // `item` alone, so knowing who flagged it can't bias how it gets fixed.
    correctness: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['item', 'source'],
        properties: {
          item: { type: 'string' },                            // file:line + intended fix
          source: { type: 'string', enum: FIX_SOURCES },
        },
      },
    },
  },
}
const READABILITY_LIST = {
  type: 'object', additionalProperties: false,
  required: ['readability'],
  properties: {
    readability: { type: 'array', items: { type: 'string' } }, // always /r:code-quality
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
// one level ABOVE this loop and so used to cost the step all three attempts.
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
// The null case is the one that used to leak. `!!(x && …)` made blocked(null) === FALSE, so
// every call NOT wrapped in reliable() read a dead agent as a good result: a null end-verify
// had no findings and "converged", a null triage skipped the whole review, a null fix-triage
// dropped every finding on the floor. Nothing downstream ever treats blocked() as anything but
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
// The script itself can spawn agents, so the fan-out moves up one level and the workflow plays
// the coordinator role that find-bugs' Phase 2 describes. Since Claude Code 2.1.217 ordinary
// subagents lost `Agent` too, so the prose engine in SKILL.md now spawns these same five
// hunters directly as well — the engines AGREE here. Keep them agreeing: whoever is
// orchestrating owns the fan-out, because no level below it can perform one.
//
// `refs` is where each hunter's pattern file lives; hunters read only their own file, which is
// what keeps five parallel reads cheap. bug-hunter has Bash/Glob/Grep/Read (enough to run
// `git diff` itself), bug-hunter-security additionally has `Skill` (that is why the security
// track is its own type — it must invoke the REAL /security-review, never a checklist read).
//
// PER-HUNTER EFFORT, and why the pattern hunters are not at the top tier. A pattern hunter is
// handed one reference file of known failure shapes and asked whether the diff matches any of
// them — real judgement, but bounded by the file it was given, which is a different job from
// deciding what is a false positive (fix-triage) or what "well-designed" means (code-quality).
// The measured yield says the same thing: over 10 instrumented runs, logic returned 0.88 fixes
// per run, concurrency 0.25 and silent-failures 0.12, against 1.33 for codex and 1.56 for the
// end-verify — both of which run at `medium` because CODEX does their thinking. `high` keeps the
// hunt and stops paying the top tier for a bounded pattern match.
//
// The `docs` hunter goes lower still, to `medium`, because its output is not a judgement the
// pipeline acts on: doc drift resolves to update-doc / update-code / confirm-intent, which is the
// USER's call, so these findings are surfaced and never auto-fixed. It is comparing the diff
// against written statements — a matching job, not an adjudicating one. (Its 0.00 fixes/run in
// the stats is NOT evidence against the track: the metric counts fixes, and this track is
// deliberately excluded from the fix-list. Retiring it on that number would be measuring the
// metric, not the hunter.)
//
// `security` deliberately keeps the inherited top tier: its cost is the real /security-review
// skill it invokes, not the wrapper's own reasoning, and it is already gated twice (tier +
// securitySurface). Trimming depth there would save little and risks the one track whose misses
// are the most expensive.
const PATTERN_HUNT = { effort: 'high' }
const DOC_HUNT = { effort: 'medium' }
// A function, not a constant: PACK is resolved after the arg parser below, and this is only
// ever evaluated inside hunterPrompt() at dispatch time — long after that.
const refsDir = () => `${PACK}/skills/code-bugs/references`
// `concurrency` and `silent-failures` used to be two separate hunters. They are one now, and the
// reason is how fan-out is billed: every extra subagent is a fresh context that re-reads the diff
// and the surrounding source from scratch, and with no shared prefix it re-writes its whole cache
// (the security hunter alone was measured at ~232k cache-write tokens per dispatch). Two agents
// therefore cost roughly twice one for the same diff — while together these two returned 0.37
// fixes per run, the weakest pair in the pipeline. Merging keeps BOTH pattern files and both
// category sets, and pays the diff-reading cost once. Splitting a hunter is worth it when each
// half has enough to find that the second read pays for itself; here it did not.
const HUNTERS = [
  { label: 'logic', agentType: 'bug-hunter', ref: 'logic-and-flow.md',
    focus: 'Wrong Business Logic, Implementation Mistakes, Broken Flows', ...PATTERN_HUNT },
  { label: 'runtime-and-failures', agentType: 'bug-hunter',
    ref: ['concurrency-data-and-performance.md', 'silent-failures-and-java.md'],
    focus: 'Data Corruption, Concurrency Issues, Resource & Connection Issues, Performance & Scalability (N+1, unbounded fetches, pool exhaustion), Silent Failures, Language-Specific Patterns',
    ...PATTERN_HUNT },
  { label: 'security', agentType: 'bug-hunter-security', ref: null, focus: 'Security' },
  { label: 'docs', agentType: 'bug-hunter-docs', ref: 'documentation-consistency.md',
    focus: 'Documentation Consistency', ...DOC_HUNT },
]
const hunterPrompt = (h, scope) => {
  const common = `You are one hunter of a parallel bug scan over ${scope}. Run \`git diff HEAD\`
     yourself to see the change; read enough surrounding source to judge it in context.
     Report ONLY findings you have HIGH confidence are actually broken — no style, no
     naming, no "could be better", no theoretical risks. Each finding: file, line,
     category, and 'what' = what the code does now vs what it should do + the production
     impact, in one line. Report-only: write no tests, fix nothing.${RAN_CLAUSE}`
  if (h.label === 'security') {
    return `You are the SECURITY hunter of a parallel bug scan over ${scope}.
     Invoke the REAL /security-review skill (Skill tool) and PASS THE SCOPE AS ITS ARGUMENT:
       Skill(skill: "security-review", args: ${JSON.stringify(scope)})
     Passing it matters. Called with no argument the skill works its scope out for itself and
     inlines the whole branch history — git status, the full changed-file list, every commit
     message — into its own prompt: measured at ~27k characters per run, worst case 47k. That is
     most of what has made this the most expensive track in the review.
     Do NOT hand-roll a "security analysis" and do NOT substitute a pattern checklist — a
     checklist is not a security review, and returning one is the failure this dedicated hunter
     exists to prevent. Equally, do NOT re-derive the diff yourself with git/bash once the skill
     has run: it already holds the changeset, and re-reading it by hand was measured at ~13 extra
     shell calls per run that produced no extra finding. One \`git diff --stat\` to name the scope
     is enough. Report its vulnerabilities as findings with category 'security'.
     'coverage' MUST SAY WHAT THIS TOOL WILL NOT REPORT, not just what it read. An empty result
     here is not a clean bill, and it has already been misread as one: the skill reports only
     HIGH/MEDIUM issues it is >80% sure are exploitable, only for what the change NEWLY
     introduces (never pre-existing concerns), and it EXCLUDES denial of service, resource
     exhaustion, rate limiting, and secrets stored on disk outright. So name the scope it really
     covered (e.g. "the uncommitted working-tree diff", "the 15 unpushed commits") AND those
     limits, so nobody reads findings:[] as "this change is secure". Those excluded categories
     are real risks — codex, the runtime-and-failures hunter and /r:code-scan cover them.${RAN_CLAUSE}`
  }
  if (h.label === 'docs') {
    return `You are the DOCUMENTATION-CONSISTENCY hunter of a parallel bug scan over ${scope}.
     Read ${refsDir()}/${h.ref} for what to look for. Run in DIFF mode: compare only the changed
     code against the project's written intent — spec.md/spec.html, todo.md, docs/*,
     DESIGN.md/ui-design.md, the **/CLAUDE.md hierarchy incl. nested module rules, README/ARCHITECTURE —
     and report divergences plus violations of stated CLAUDE.md rules. Use category
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
       ? ` They are two lists of failure shapes for ONE hunt: make a single pass over the diff
     looking for anything in either list, rather than two passes. Weight them by what the change
     actually does — a diff with no shared state or threading has little for the concurrency
     patterns, and a diff full of swallowed exceptions has a lot for the silent-failure ones.`
       : ''}
     Your categories: ${h.focus}.
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
      // h.effort is per-hunter (see HUNTERS): the pattern hunters run at `high` and docs at
      // `medium`, while security keeps the inherited top tier. Spread conditionally so a hunter
      // with no effort of its own still inherits rather than being pinned to undefined.
      { label: `find-bugs:${h.label}`, phase: 'Review', schema: FINDINGS, agentType: h.agentType,
        ...(h.effort ? { effort: h.effort } : {}) }))))
  const missing = hunters.filter((h, i) => blocked(hunts[i])).map((h) => h.label)
  if (missing.length) {
    log(`${trackName}: hunter(s) BLOCKED — ${missing.join(', ')}. The scan is INCOMPLETE; ` +
        `the other hunters' findings are still carried into triage, but this track is not a clean bill.`)
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
  return {
    ran: missing.length === 0,
    findings,
    // Three different states share one empty findings list, and they mean opposite things.
    // Whoever reads this summary must be able to tell them apart without the transcript.
    coverage: secIdx < 0
      ? 'security hunter NOT DISPATCHED — no security surface in this diff. Nothing was ' +
        'security-reviewed. This is a skip, not a clean bill.'
      : (sec && sec.coverage) ||
        (missing.includes('security') ? 'security hunter BLOCKED — nothing was security-reviewed' : ''),
  }
}

// Effort tiers. The skill's frontmatter sets effort:xhigh, which every subagent would otherwise
// inherit — including ones whose whole job is running a shell command. Depth belongs where the
// JUDGEMENT is, and the test is not "does this step matter" (they all do) but "does THIS AGENT
// decide anything?". A wrapper around a tool that decides for it does not; nor does a fixer whose
// finding was already judged real by someone else. What still inherits the top tier is the set
// that forms an opinion nothing downstream re-forms: the security hunter, code-quality, fix-triage
// (which decides what is a false positive), /r:code-scan's own triage of its findings, and the
// readability refactor. The pattern hunters and the docs hunter are pinned below it — see the
// PATTERN_HUNT / DOC_HUNT note above HUNTERS for why a bounded pattern match is a different job
// from an adjudication.
//
// A second reason to pin rather than inherit: the frontmatter only applies when this skill is
// entered through the Skill tool. Called by scriptPath — which /r:gh-issues-fix does for every group
// — nothing sets it, and these agents silently take the SESSION's effort instead. Pinning makes the
// review's depth a property of the pipeline rather than of how it happened to be invoked.
// Run one fixed command and report what it printed. No branch, no classification, no prose —
// whatever decides anything about the result decides it in THIS script, not in the agent. These
// pinned effort but not MODEL, so a step marked "nothing to decide" was still running whatever the
// session was on; through a /r:task-run chain that is Opus, to run `worktree-deploy.sh teardown`.
const ECHO = { model: 'haiku', effort: 'low' }
// Cheap, but not the echo tier: it composes prose (a GitHub issue body) or has a fallback path to
// choose between.
const MECHANICAL = { model: 'sonnet', effort: 'low' }
const BUILD_RUN = { effort: 'medium' }  // runs the build, but must classify in-scope vs pre-existing failures
// The post-local-scan rebuild is a build too, but not a classifying one: the build was fully green
// before local-scan ran, so the prompt can tell it that ANY failure here is in-scope by
// construction. That is the whole judgement BUILD_RUN exists to protect, and it is already made.
const REBUILD_RUN = { model: 'sonnet', effort: 'medium' }
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
// it. That is strictly less than an implementer, which follows a whole plan — and run-task pins its
// implementers at `high`. So `high` is the floor here, not a cut: what it removes is the top tier
// on work whose hard thinking (is this finding real? what should change?) already happened in
// triage. Deliberately not applied to fix-triage, which is where that thinking lives.
const FIX_RUN = { effort: 'high' }
// The UI verifiers are the one JUDGING track where xhigh does not pay for itself. Measured over
// 59 stored bug-hunter-ui transcripts: 66% of their wall time was model time, spread over a median
// of 86 turns (p90 144) at ~4.2s of thinking each — and the large majority of those turns drive a
// browser or read a page, not adjudicate a defect. `high` keeps the judgement that decides "is this
// a real problem or an intentional design choice" while cutting the per-turn cost of the mechanical
// majority. Deliberately NOT MECHANICAL: these agents still have to make that call.
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
// It used to be read off the RAW `args`, above the tolerant parser: `(args && typeof args ===
// 'object' && args.packRoot)`. Callers hand over a JSON *string* almost every time — 0 object args
// against 39 string ones across the stored history — and a string fails that typeof, so packRoot
// went missing even when it WAS passed. Reading it from `opts` is the actual fix; everything below
// is about failing honestly when it is genuinely absent.
//
// The old fallback was the placeholder itself, on the reasoning that it "either expands or fails
// loudly". Neither half held. It does not expand, and it does not fail loudly: `python3
// /skills/…/record-run.py` is a plain not-found, and the one track that surfaced it is the stats
// sink — best-effort by design, so the row was lost in silence while every other path was equally
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
       on any untracked changed source files. Otherwise the diff-scoped tracks — especially
       /security-review, which keys strictly off \`git diff\` — silently see NOTHING for a
       brand-new file. Intent-to-add stages no content and is reversible (\`git reset\`).
   2. Decide reviewNeeded: false ONLY if every changed file is doc/config-only
      (*.md,*.txt,docs/**,LICENSE,.gitignore,images). Any source/build/runtime-config
      file => true. A comment/format-only edit inside source still => true.
   3. Detect the build tool and return BOTH build commands — the run does exactly ONE clean
      build (the first) and every rebuild after it is incremental over that same run's output:
        pom.xml        => buildTool 'maven',  buildCmd \`mvn clean package\`,   buildCmdFast \`mvn package\`,      runnerAgent maven-build-runner
        build.gradle*  => buildTool 'gradle', buildCmd \`./gradlew clean build\`, buildCmdFast \`./gradlew build\`, runnerAgent gradle-build-runner
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
           persistence (query, schema, migration, index), concurrency/locking, or
           security-sensitive code (crypto, input parsing, file/network IO, deserialization,
           secrets, headers)?                                       no  -> 'standard'
        c. otherwise                                                    -> 'full'
      Calibrate: a getter, a constant/config VALUE tweak, a log message, a rename, formatting, a
      comment or a cosmetic template/CSS change is 'light'; a bug fix inside one method, a
      two-line null check, a new field plus its mapping, a new endpoint over an existing service
      is 'standard'; a migration, an auth-rule change, money math, or a change spanning several
      seams is 'full'. Scary wording alone doesn't force 'full' (a copyright-year bump in a
      template is light); "small" wording alone doesn't earn 'light' (a one-line auth-role change
      is full). When you are unsure, answer 'standard': it keeps a real Codex read of the diff
      (--mode review), the security hunter running the real /security-review, the docs hunter,
      static analysis and build+tests, and only gives up the /r:code-bugs pattern hunters plus
      the up-front adversarial + readability passes. A caller-provided profile OVERRIDES your call
      — echo it if given. Caller-provided profile: ${TIERS.includes(opts.profile) ? opts.profile : '(none — classify it)'}
   7. uiTouched — true iff any changed file is frontend: *.html/templates, *.css/*.scss,
      *.js/frontend *.ts, or under templates/, static/, resources/templates/, webapp/.
      Answer this carefully: it is the SOLE gate on the UI/runtime step in EVERY tier (the tier
      no longer forces it), and that step is the single most expensive thing in the pipeline —
      a false 'true' boots the whole stack and drives a browser for nothing, a false 'false'
      ships a rendered change that nothing looked at.
      Caller-provided uiTouched: ${typeof opts.uiTouched === 'boolean' ? opts.uiTouched : '(none — determine it)'}
   8. securitySurface — does this diff touch anything a security review could have an opinion
      about? true if ANY of: auth / permissions / session / CSRF, a new or changed HTTP endpoint
      or controller mapping, upload or file/path IO, SQL/JPQL/native queries or a migration,
      crypto / secrets / tokens / credentials, deserialization or parsing of untrusted input,
      raw/unescaped template output (th:utext, innerHTML, eval), outbound network calls, or
      security/framework configuration. false only when the change is plainly none of those —
      copy and CSS, a log message, a rename, a badge count, a test-only edit.
      This gate exists because /security-review is expensive and structurally narrow: measured
      over 19 dispatches it returned zero findings while costing ~232k cache-write tokens each,
      and most of those diffs were text wrapping and notification counts it could say nothing
      about. Answer conservatively — when in doubt say true. A skipped security review is a
      coverage hole, so it must be earned by a diff that genuinely has no security surface, not
      by a guess. If you cannot tell, omit the field: an unanswered gate runs the hunter.
   Return the structured result.`,
  { label: 'triage', schema: TRIAGE, ...GP, ...TRIAGE_RUN }
))
// A DEAD triage and a diff that genuinely needs no review are opposite outcomes, and they used
// to return the same `{skipped: true}`. That is the worst failure this pipeline has: an
// unattended caller (/r:gh-issues-fix) reads `skipped` as "reviewed, nothing owed" and goes on to
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
//    on the critical path at the very end. This used to start alongside the end-verify, which
//    overlapped it with one phase; started here it overlaps the review, the fix phase, the build
//    and the static scan as well. Build-only — nothing starts, so it cannot serve stale code, and
//    a fixer editing a file below simply invalidates the layers that file touches, which the real
//    deploy then rebuilds. The cache is an optimisation, never the artifact under test. The helper
//    always exits 0 and Phase 7 never reads this result, so a failed pre-warm costs a cold build
//    and nothing else.
//
// 2. The docs hunter. Its findings feed `docDrift`, which is a list handed to the USER — never a
//    fix, never an input to the build. Keeping it inside the Review barrier meant the fix phase
//    waited on a track whose output it does not consume.
const uiWanted = uiTouched
const prewarmP = (uiWanted && triage.hasTestApp)
  ? agent(
      `Run \`"${PACK}/skills/task-review/scripts/worktree-deploy.sh" prewarm\` from the
       repo root and report its stderr line verbatim. It builds the app image WITHOUT starting
       anything, to warm the docker layer cache for a deploy that happens later in this run.
       It always exits 0 by design. Do NOT start containers, do NOT deploy, do NOT touch the repo,
       and do NOT treat a skip or a failed build as a problem — a cold cache is slow, not wrong.`,
      { label: 'ui-prewarm', phase: 'Triage', ...GP, ...ECHO }).catch(() => null)
  : null

const DOCS_HUNTER = HUNTERS.find((h) => h.label === 'docs')
const docsP = profile === 'light' ? null
  : reliable('find-bugs:docs', 'Review', () => agent(
      hunterPrompt(DOCS_HUNTER, scope),
      { label: 'find-bugs:docs', phase: 'Review', schema: FINDINGS,
        agentType: DOCS_HUNTER.agentType, ...DOC_HUNT })).catch(() => null)

// A fixer's self-check only has to prove the code COMPILES. The prompt used to say just "verify it
// compiles" with no command, so a fixer could plausibly reach for the full clean build — a whole
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
// plus the one hunter a diff review cannot stand in for — the security hunter, which invokes the
// real /security-review. What standard trades away are the PATTERN hunters (logic, and
// runtime-and-failures = concurrency/performance + silent failures) and the code-quality pass, a
// polish concern rather than a correctness one. The trade is an independent tool over the
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
// at all. /security-review only reports HIGH/MEDIUM issues it is >80% sure are exploitable, only
// for what the change NEWLY introduces, and it excludes DoS, resource exhaustion, rate limiting
// and secrets-on-disk outright — so on a CSS or copy change there is nothing it can say. Measured:
// 19 dispatches, 0 findings, ~232k cache-write tokens each. `!== false` is the fail-open: only an
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
     Report-only. Return its findings; [] if it ran clean. Put the wrapper's trailing
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
     "worth fixing" readability/idiom findings as file:line + one line each.${RAN_CLAUSE}`,
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
      'security hunter (the real /security-review). The docs hunter ran too, off the barrier. Skipped at this tier: the ' +
      '/r:code-bugs pattern hunters (logic; runtime-and-failures = concurrency/performance + silent failures), the ' +
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
// docDrift is no longer triaged at all: it comes straight from the docs hunter. Routing a list that
// is only ever handed to the user through a filter that cannot act on it bought nothing, and it was
// the reason the docs hunter had to finish before this phase could start.
phase('Fix-triage')
const triageIntro = `You are Step 3 triage. REPORT-ONLY: do NOT edit, write, or run any code — your
   ONLY output is your part of the fix-list. A report marked "(not run at this tier)" is a
   deliberate tier decision, not a missing input to work around. A finding that contradicts the
   intent below is a false positive — drop it.`

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

// A dead triage used to read as `nothingToFix` — so every finding the tracks just paid for was
// dropped on the floor and the run reported `fixed: 0/0, reviewed: true`. Whether that is a halt
// depends on whether there was anything to lose:
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
    const agentType = triage.hasFrontend && !triage.hasBackend ? 'htmx-thymeleaf-dev' : 'java-backend-developer'
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
    // Same rule the end-verify fixer already follows: only count what a live fixer took. A dead
    // one used to leave `fixed.correctness` reporting the full triaged list, which is the same
    // false-confidence failure the serialization above exists to prevent — arriving by a different
    // route. The items stay visible in the log either way.
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
       wins ${commitClause}:\n${fixList.readability.join('\n')}${intentBlock}`,
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
// 2–4 clean builds a fixing review used to do into 1 clean + N incremental, with the green
// invariant untouched: the bar is still a fully green build with tests, never relaxed.
const cleanCmd = triage.buildCmd || ''
const fastCmd = (triage.buildCmdFast || cleanCmd.replace(/\bclean\s+/, '')) || cleanCmd
// `baselineBuilt` — the caller certifies that a CLEAN, fully green build already ran in THIS
// working tree, on THIS branch, moments ago. That is exactly what run-task-implement hands back
// as `buildGreen: true`, and when /r:gh-issues-fix chains implement -> review the two clean builds
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
// Handed to the later fixers (end-verify, UI minor) so they rebuild incrementally too, instead of
// picking their own command — those fixers used to be told only "ensure the build is green".
const rebuildClause = triage.buildTool !== 'none'
  ? `then rebuild via the ${triage.runnerAgent} agent with \`${fastCmd}\` (incremental — a clean baseline build already ran in this working tree) until green. ${staleRule}`
  : 'then verify nothing is broken (no build tool was detected for this project).'
phase('Build')
let buildGreen = false
if (triage.buildTool !== 'none') {
  const changed = (triage.changedFiles || []).join(', ')
  for (let i = 1; i <= 3; i++) {
    const b = await agent(
      `Run the build \`${i === 1 && !baselineBuilt ? cleanCmd : fastCmd}\` via the ${triage.runnerAgent} agent.
       ${i === 1 && !baselineBuilt ? 'This is the run\'s one clean build — it establishes the baseline.' : staleRule}
       green=true ONLY on a fully clean success (BUILD SUCCESS / BUILD SUCCESSFUL, exit 0,
       zero failures). The green bar is NEVER relaxed. If red, CLASSIFY every failure:
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
      { label: `build-fix#${i}`, phase: 'Build', agentType: 'java-backend-developer' })
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
    // The scan agent computes its OWN class list, at scan time. It used to be handed
    // triage.changedFiles — the working-tree diff as it looked in PHASE 0, before the fix phase
    // ran — so anything the fixers or /r:code-refactor touched (a new test class, a second file pulled
    // into a fix) was never scanned, and a class deferred from an earlier turn on this branch
    // never was either. SKILL.md Step 6b always specified the branch-wide, scan-time list; only
    // the script disagreed. Cost of asking here instead of reusing Phase 0: one round trip on a
    // JVM project with no JVM change, which the agent reports back as status 'skipped'.
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
       any code, and which tools were skipped/errored.`,
      { label: 'local-scan', phase: 'Local-scan', schema: SCAN, ...GP }))
    // Fail-closed, both ways. A dead scan agent used to fall through BOTH branches with no log
    // at all — a step the non-negotiables call mandatory became a silent no-op, and the run
    // still reported clean. Blocked and status:'error' are the same thing here: not scanned.
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
      const rb = await agent(`Rebuild via ${triage.runnerAgent}: \`${fastCmd}\` (incremental — the
        clean baseline build already ran in this working tree). ${staleRule}
        green=true ONLY on a fully clean success. The build was fully green before local-scan
        ran, so ANY failure here is a regression from local-scan's own self-fixes (in-scope) —
        report it; do not touch out-of-scope tests/code.`,
        { label: 'rebuild', phase: 'Local-scan', schema: BUILD, agentType: triage.runnerAgent, ...REBUILD_RUN })
      if (!rb || !rb.green) { log('post-task-review: rebuild after local-scan RED — stopping'); return { stopped: 'rebuild-red' } }
    } else {
      localScan = 'ok' // scanned clean, changed nothing — no rebuild owed
    }
  }
}

// The UI gate. It is resolved much earlier now (right after the tier, alongside the docker
// pre-warm) so the image build can start there — see the note at that dispatch site.
//
// The gate is `uiTouched` in EVERY tier, full included. It used to be `full || uiTouched`, and the
// unconditional half was the most expensive unearned step in the pipeline: measured over 59 stored
// runs this step ran a median of 542s (p90 1150s) with two thirds of that model time across ~86
// serial turns, two `high` agents and up to six screenshots the visual half must then READ back as
// images. What routes a change to `full` is auth, money, persistence, concurrency or an approach
// worth challenging — none of which implies a rendered page changed. So a backend-only `full` run
// was booting the whole stack, driving a browser and grading the design of pages the diff never
// touched. The evidence for a UI defect is the rendered result, and there is a new rendered result
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
// What the LAST pass raised and nothing re-read clean. This used to have nowhere to go, and the
// findings simply vanished — two ways, both observed:
//   * `real` is OPTIONAL in FINDINGS, so `filter(f => f.real)` dropped every finding a pass
//     returned WITHOUT adjudicating it. The loop then read "no real findings" as converged and
//     the run reported endVerify:'passed', fixed.correctness:0 — for a Codex pass that had found
//     a genuine defect and said so. Nothing downstream ever saw it.
//   * even an explicitly real finding raised by pass 2 was handed to a fixer whose work no pass
//     ever re-read, and the run still reported 'passed'.
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
let endVerifyTouchedFrontend = false
const endVerifyTrack = async () => {
  if (!endVerifyWanted) return
  const fixAgent = triage.hasFrontend && !triage.hasBackend ? 'htmx-thymeleaf-dev' : 'java-backend-developer'
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
      { label: `end-verify-fix#${pass}`, phase: 'End-verify', agentType: fixAgent, ...FIX_RUN })
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
      if (real.some((f) => FRONTEND_FILE.test(String(f.file || '')))) endVerifyTouchedFrontend = true
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
// above the end-verify — see the note there for why the tier no longer forces it). A CSS/template
// change is exactly where the rendered result, not the diff, is the evidence. A backend-only change
// skips it at every tier: booting the whole stack to look at pages nothing touched is the most
// expensive way to learn nothing.
//
// WHY THIS IS THREE STEPS AND NOT ONE. Measured over 59 stored bug-hunter-ui transcripts: median
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
// The /test-app presence gate was answered back in Phase 0 (triage step 5b) — it is one `test -f`,
// and spending a whole subagent round-trip on it put a needless hop on the critical path.
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

    // 7a — deploy. Its own step, at BUILD_RUN effort: reading a command out of a skill file and
    // running a script is not work that improves with more thinking (it only has to tell a real
    // failure from a slow start), and doing it inside the verifier put a whole docker build log
    // into an xhigh context. reliable() only re-dispatches a DEAD agent, so an honest
    // {ok:false, reason} comes back once — a broken deploy is never retried three times.
    const dep = await reliable('ui-deploy', 'UI', () => agent(
      `Bring the app up for UI verification and return its base URL. You do NOT test anything.
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
       If you are in a linked git worktree and the helper is missing or not executable, return
       ok=false with that reason: deploying on the project's default port from a worktree would
       collide with the main stack, which is the whole failure this helper exists to prevent.`,
      { label: 'ui-deploy', phase: 'UI', schema: DEPLOY, ...GP, ...BUILD_RUN }))

    if (!dep || !dep.ok || !dep.url) {
      // A failed deploy is a blocked TRACK, not a clean UI pass. ran=false makes blocked() true,
      // so tracksBlocked names it and nothing downstream reads this as "the UI was verified".
      log(`post-task-review: UI verification NOT run — deploy failed (${(dep && dep.reason) || 'no usable result'}).`)
      ui = { ran: false, findings: [] }
    } else {
      // Both halves share this: the stack is already up and someone else owns its lifecycle.
      const stackUp =
        `The app is ALREADY deployed and healthy at ${dep.url}. Do NOT deploy, redeploy, restart
       or tear down anything — this run's orchestrator owns the stack, and a second stack would
       collide with it. Export the URL before you start:
         export TEST_APP_BASE_URL="${dep.url}"
       That also tells a worktree-aware /test-app the stack is already up, so it tests that URL
       instead of starting a competing one.`
      const reportRules =
        `Report-only: no fixes, no tests, no plan mode. Stay diff-scoped — verify the CHANGED
       functionality, not the whole app. Report only defects you have HIGH confidence are real;
       if something is likely intentional or you are unsure, skip it. If everything passed, say
       so — never invent findings. Tag each finding fixSize=minor|major BY THE SIZE AND RISK OF
       ITS FIX, not by severity (a one-line fix for a serious bug is still minor). Your report
       MUST open with the confirmation line — \`✅ Invoked the real /test-app skill …\` if it ran,
       or \`❌ Did NOT run …\` with the reason if it didn't — and set ran=false in that ❌ case.
       If /test-app produces no output within a bounded wait, stop waiting: return the ❌ line
       rather than blocking the run.${uiIntent}`
      const halves = [
        { label: 'ui-functional', session: 'ptr-func', prompt:
      `You are the FUNCTIONAL half of the UI verification. A visual half runs in PARALLEL with you
       and owns screenshots, layout and design — do not do its job, and do not wait for it.
       ${stackUp}
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
       ${stackUp}
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
      const parts = await parallel(halves.map((h) => () =>
        reliable(h.label, 'UI', () => agent(h.prompt,
          { label: h.label, phase: 'UI', schema: UIRES, agentType: 'bug-hunter-ui', ...VERIFY }))))
      uiDead = halves.filter((h, i) => blocked(parts[i])).map((h) => h.label)
      if (uiDead.length) {
        log(`post-task-review: UI half BLOCKED — ${uiDead.join(', ')}. The UI track is INCOMPLETE; ` +
            `the surviving half's findings still flow into triage, but this is not a clean bill.`)
      }
      // ran only if BOTH halves reported — a half that died is a coverage hole, and reading the
      // survivor as a full pass is the same phantom-clean failure the hunter fan-out guards against.
      ui = {
        ran: uiDead.length === 0,
        findings: parts.flatMap((p, i) =>
          ((p && p.findings) || []).map((f) => ({ ...f, lens: halves[i].label.replace('ui-', '') }))),
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
// is stale — so it looks again, once. That case costs roughly what the old serial ordering cost
// every time, which is the point: the worst case here is the previous behaviour, and the common
// case (end-verify fixes are overwhelmingly backend) is the whole overlap.
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
  if (minor.length) await agent(`Fix these minor UI/runtime defects (surgical), ${rebuildClause}
    Then redeploy and re-verify once:\n${minor.map(f => `${f.where}: ${f.title} — ${f.suggestedFix}`).join('\n')}${intentBlock}`,
    { label: 'ui-fix-minor', phase: 'UI', agentType: triage.hasFrontend ? 'htmx-thymeleaf-dev' : 'java-backend-developer', ...FIX_RUN })
  if (major.length) await agent(`File one GitHub issue per major UI finding via \`gh issue create\`
    (preflight gh auth + a github remote; best-effort --label bug, retry without on failure). If gh
    is unusable, write a grouped HTML report under .claude/skills/test-app/bugs/ instead. Findings:
    ${JSON.stringify(major)}`, { label: 'ui-file-major', phase: 'UI', ...GP, ...MECHANICAL })
  if (uiWanted && triage.hasTestApp) {
    uiSummary = {
      ran: ui && ui.ran, minorFixed: minor.length, majorFiled: major.length, blocked: blocked(ui),
      // Which half fell over, so a "UI blocked" line in the stats store can be read without the
      // transcript: a dead visual half and a dead functional half mean very different coverage.
      blockedHalves: uiDead,
    }
  }
} finally {
  // try/finally is the structural version of "teardown on ANY exit path". It sits out here rather
  // than inside the UI track because the track now runs inside parallel(), which swallows a throw
  // into a null — a teardown nested in there would be skipped exactly when it is needed most.
  // Retried, because a teardown that dies leaks the worktree's containers and volumes, and the next
  // run in that worktree then collides with the stack this one left behind.
  if (uiWanted && triage.hasTestApp) {
    const td = await reliable('ui-teardown', 'UI', () => agent(
      `Run \`"${PACK}/skills/task-review/scripts/worktree-deploy.sh" teardown\`
      unconditionally (no-op in the main tree; tears down the ephemeral stack in a worktree).`,
      { label: 'ui-teardown', phase: 'UI', ...GP, ...ECHO }))
    if (blocked(td)) log('post-task-review: UI teardown NOT confirmed — an ephemeral worktree stack may still be running; tear it down by hand with `worktree-deploy.sh teardown`.')
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
const tracksBlocked = TRACKS.filter(([, r, ran]) => ran && blocked(r)).map(([n]) => n)
// Named separately from tracksBlocked so a caller can tell an absent optional prerequisite
// from a tool that failed. Both mean the step did not run; only one is anybody's fault.
const tracksSkipped = TRACKS.filter(([, r, ran]) => ran && skipped(r)).map(([n]) => n)
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
//   * The row carries COUNTS, not finding text. That keeps it well under the 4 KiB single-write
//     atomicity limit, which is what lets parallel worktree runs append to one file safely.
// The heredoc is quoted, so nothing in the JSON is expanded; JSON.stringify emits one line, so
// the delimiter can't collide with the payload.
const statsRow = {
  kind: 'review',
  profile,
  // WITHOUT this, a forced tier is indistinguishable from a classified one, and the tier
  // distribution silently becomes "what the user typed" rather than "what the classifier
  // decided" — the exact question it looks like it answers. The workflow already knows; it
  // just wasn't being written down.
  profileForced: TIERS.includes(opts.profile),
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
  tracksSkipped,
  fixedBySource,
  fixedCorrectness: (fixList ? fixList.correctness.length : 0) + endVerifyFixed,
  fixedReadability: fixList ? fixList.readability.length : 0,
  docDriftCount: fixList ? fixList.docDrift.length : 0,
  endVerify: endVerifyVerdict,
  endVerifyCount: endVerifyUnresolved.length,
  localScan,
  build: buildGreen ? 'green' : (triage.buildTool === 'none' ? 'n/a' : 'red'),
  ui: uiSummary,
}
await agent(
  `Record one line of review statistics. This is bookkeeping — if anything goes wrong, say so
   and return; do NOT retry, do NOT fix anything, and do NOT treat it as a failure of the review.
   Run exactly this from the repo root, then return the script's stderr line verbatim:

   python3 "${PACK}/skills/task-review/scripts/record-run.py" <<'PTR_STATS_JSON'
${JSON.stringify(statsRow)}
PTR_STATS_JSON

   The script always exits 0 by design; its stderr says whether the row was recorded.`,
  // The echo tier: this appends one JSONL line and edits nothing, and by design it can never fail
  // the run. run-task's identical sink is pinned the same way. It used to inherit whatever the
  // caller was running at — for a /r:task-run chain, Opus, for a `python3 script <<EOF`.
  { label: 'stats', phase: 'End-verify', ...GP, ...ECHO })

return {
  reviewed: true,
  profile,
  uiTouched,
  // Only tracks this tier dispatched can be reported blocked. A track the tier never ran is not
  // a failure, and naming it here would tell a caller a tool died when nothing did.
  tracksBlocked,
  tracksSkipped,
  // What each finding track actually bought: correctness items that survived triage, keyed by the
  // track that found them. This is the number that can retire a track on evidence instead of
  // argument; it is also written to ~/.claude/review-stats.jsonl for accumulation across runs.
  fixedBySource,
  // correctness = the triaged fix-list items + everything the end-verify handed to a fixer. The
  // second half used to be missing, so a run that found and fixed a defect at the end still
  // reported `correctness: 0` — a summary field that contradicted what the run had just done.
  // Each half is counted only when its fixer LIVED: a triaged list is what someone was asked to
  // do, not what got done, and the whole value of this field is that a caller can merge on it.
  fixed: { correctness: (fixList && fixApplied.correctness ? fixList.correctness.length : 0) + endVerifyFixed,
           readability: fixList && fixApplied.readability ? fixList.readability.length : 0 },
  docDrift: fixList ? fixList.docDrift : [],
  build: buildGreen ? 'green' : (triage.buildTool === 'none' ? 'n/a' : 'red'),
  // ok | skipped (nothing JVM changed) | blocked (scan died/errored — NOT scanned) | n/a (no build tool).
  // Reported because /r:code-scan is mandatory in every tier: a caller has to be able to see that
  // the static pass did not actually happen, rather than infer it from a silent success.
  localScan,
  // skipped (nothing to re-read) | blocked (Codex didn't run — the final diff is UNVERIFIED)
  // | findings-unresolved (a pass raised findings that no later pass read clean) | passed.
  // 'passed' now REQUIRES a Codex pass that came back with nothing outstanding: it is the word a
  // caller merges on, so it can no longer be reached with findings still on the table.
  endVerify: endVerifyVerdict,
  // The unresolved remainder, verbatim. Empty on 'passed'/'skipped'. This is the difference
  // between surfacing a defect to the caller and swallowing it.
  endVerifyFindings: endVerifyUnresolved,
  ui: uiSummary,
  step9: 'main-agent', // record learnings (9a) + gated /r:claudemd-compact --auto (9b) run after this returns
}
