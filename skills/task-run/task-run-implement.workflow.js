// =============================================================================
// run-task (implement half) — PROTOTYPE Workflow (deterministic orchestration)
//
// This encodes /r:task-run Steps 0 – 4 as a hardcoded subagent graph: resolve the
// task source, map the code, design the UI when the change touches one, plan it on
// Opus at xhigh, have Codex challenge the plan, implement it test-first through domain
// subagents, and drive the build green.
// It STOPS after the build, leaving the uncommitted diff on the feature branch
// and returning a handoff. Steps 5 (review) and 6 (finish) are the CALLER's.
//
// WHY THIS IS A WORKFLOW AND NOT A SUBAGENT
//   Claude Code 2.1.217 removed the `Agent` tool from subagents (verified: a
//   general-purpose subagent's tool list is Agent,Bash,Edit,Read,Skill,ToolSearch,
//   Write on 2.1.216 and loses `Agent` on 2.1.217+). run-task IS its subagents —
//   the explorers, the Opus planner, the Codex plan reviewer, the domain
//   implementers, the build runner — so run-task nested inside a subagent can no
//   longer fan out at all. It would degrade to one context and still report success.
//   A Workflow script runs in the main thread and spawns every agent ITSELF, so the
//   fan-out survives while the CALLER's context only ever sees the returned handoff.
//   That is the same "move the fan-out up one level" fix post-task-review.workflow.js
//   already applies to the find-bugs hunters.
//
// SINGLE ENCODING — deliberately NOT a mirror of prose.
//   post-task-review carries two engines (script + prose Steps 0-9) and pays a
//   lockstep tax for it. This one does not, and must not grow one: a context with
//   no `Workflow` tool also has no `Agent` tool, so there is nothing a prose
//   fallback could actually orchestrate. SKILL.md Steps 1-4 DELEGATE here; they do
//   not restate the graph. Change the pipeline HERE.
//
// TESTS: tests/control-flow.test.mjs executes this script with agent()/parallel() stubbed and
//   asserts the branches — what stops the run, what is retried, what reaches the handoff. Run it
//   after every edit here:
//     node --test <pack>/skills/task-run/tests/control-flow.test.mjs
//
// HOW TO RUN (from a real project repo root, main thread):
//   Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/task-run/task-run-implement.workflow.js",
//              args: { packRoot: "${CLAUDE_PLUGIN_ROOT}", ...
//              args: { source: "#42", profile: "full", base: "main" } })
// args: { source: string (REQUIRED — "#42" | "#42 #61" (a group of issues that
//                 one change fixes) | "todo.md / Phase 3" | free text),
//         profile?: "light"|"standard"|"full" (omitted => classified here),
//         base?: string (omitted => current branch) }
//   Multiple issue refs in `source` ("#42 #61") are one GROUPED task: every issue
//   is fetched, their acceptance criteria merge into criteria[], and the branch
//   is issues-42-61-<slug>. The caller (e.g. /r:gh-issues-fix) closes all of them.
// returns: { branch, base, profile, profileReason, profileForced, profileEscalated,
//            uiTouched (settled: Phase 0's guess, which the explorers can turn ON),
//            uiVisualChange (does anything RENDER differently — the design phase's own gate),
//            designIntent: string ('' when no design phase ran — see Phase 1b),
//            taskIntent, planPath, criteria,
//            buildGreen: true | 'n/a' (no build tool — NEVER a silent true),
//            planReview: { ran, passes, raised, applied[], dropped[] },
//            testEvidence: string[] (what each test did BEFORE and after the change, as observed
//                          by the implementer — a green-before test is a regression guard, not
//                          proof the fix works; carry it into the PR body) }
//       or { stopped: <reason>, ... } when the run cannot honestly continue. `branch` is always a
//   real feature branch: a run that could not leave `base` stops (branch-not-created) rather than
//   handing back branch === base.
//   profileForced says whether the tier came from the caller's --light/--standard/--full
//   or from this script's own classification. The caller uses it to decide whether to
//   pass `profile` on to /r:task-review: a FORCED tier is the user's word and travels;
//   a CLASSIFIED one was a guess made before any code existed, so it is dropped and
//   post-task-review re-classifies from the real diff it is about to review.
// =============================================================================

export const meta = {
  name: 'run-task-implement',
  description: 'Steps 0-4: plan, Codex plan review, TDD implement, green build',
  phases: [
    { title: 'Source',      detail: 'resolve task + criteria + tier + build tool' },
    { title: 'Explore',     detail: 'read-only fan-out over the change surface', model: 'sonnet' },
    { title: 'Design',      detail: 'UI/UX spec via frontend-design, iff the visuals change', model: 'opus' },
    { title: 'Plan',        detail: 'Opus xhigh planner, written to .task-plans/', model: 'opus' },
    { title: 'Plan-review', detail: 'Codex challenge + one bounded re-review' },
    { title: 'Implement',   detail: 'branch + test-first domain subagents' },
    { title: 'Build',       detail: 'build with tests, bounded retry' },
  ],
}



// ----------------------------------------------------------------- schemas ---
const SOURCE = {
  type: 'object', additionalProperties: false,
  required: ['kind', 'slug', 'branch', 'base', 'taskIntent', 'criteria', 'profile',
             'profileReason', 'uiTouched', 'uiVisualChange', 'hasBackend', 'hasFrontend',
             'buildTool', 'exploreAspects', 'planPath', 'planStatus', 'branchExists'],
  properties: {
    kind: { type: 'string', enum: ['issue', 'todo', 'text'] },
    slug: { type: 'string' },
    branch: { type: 'string' },          // issue-<n>-<slug> | issues-<n1>-<n2>-<slug> | phase-<slug> | task-<slug>
    base: { type: 'string' },            // branch to return to / merge into later
    taskIntent: { type: 'string' },      // 1-3 sentences — threaded into every fixer downstream
    criteria: { type: 'array', items: { type: 'string' } },
    profile: { type: 'string', enum: ['light', 'standard', 'full'] },
    // One sentence naming the deciding factor. Without it the two classification gates are
    // indistinguishable after the fact, and "why is everything full?" has no answer but a guess.
    profileReason: { type: 'string' },
    uiTouched: { type: 'boolean' },
    // The SECOND UI question, and not a duplicate of the first. `uiTouched` asks whether a frontend
    // FILE changes — it buys the review's browser pass, and a font swap that must render identically
    // wants that pass. `uiVisualChange` asks whether anything a user sees or interacts with has to be
    // DECIDED, which is the only thing the design phase can produce. See the gate at Phase 1b.
    uiVisualChange: { type: 'boolean' },
    hasBackend: { type: 'boolean' },
    hasFrontend: { type: 'boolean' },
    buildTool: { type: 'string', enum: ['maven', 'gradle', 'none'] },
    buildCmd: { type: 'string' },        // CLEAN certifying build — used ONCE
    buildCmdFast: { type: 'string' },    // incremental — every rebuild after that
    runnerAgent: { type: 'string' },     // r:maven-build-runner | r:gradle-build-runner
    // 1 aspect for light, 2 for standard, 2-3 for full. Each becomes one read-only Explore agent.
    exploreAspects: { type: 'array', items: { type: 'string' } },
    planPath: { type: 'string' },
    planStatus: { type: 'string', enum: ['none', 'reviewing', 'implementing', 'done'] },
    branchExists: { type: 'boolean' },
    blockedReason: { type: 'string' },   // e.g. gh missing/unauthenticated, source unreadable
  },
}
// The five surfaces Phase 0's tier tree already names (see the classifier prompt below). The
// explorer escalation and the classifier must recognise the SAME set, or Phase 1 escalates on
// things Phase 0 would have called "standard" — which is what made almost every run reach full.
const RISK_SURFACES = ['auth', 'money', 'persistence', 'concurrency', 'security']
// There is deliberately NO schema for the explorers either, and for the same reason there is none
// for the planner below — measured, on three separate runs. The brief is a 6-9k-char markdown
// document, and a tool call that large followed by a SECOND parameter serializes malformed often
// enough to matter: the parser folds the closing tags and the whole riskFlags parameter INTO
// `brief`, so riskFlags is genuinely absent from the parsed input and validation rejects it with
// "must have required property 'riskFlags'". The explorer then rebuilds the same oversized payload
// and fails identically until the StructuredOutput retry cap (5) throws — the rejection looks like
// a disobedient model and is nothing of the kind, which is why the prompt was never the fix.
//
// Worse than the throw, and the reason this is not merely a cost problem: one explorer escaped the
// cap by probing with {"brief":"test","riskFlags":[]}, which VALIDATES. The planner was handed the
// word "test" as one of its three code maps, and that explorer's empty riskFlags counted as a real
// "no risk here" vote in the escalation gate below. Nothing logged it.
//
// A schema-less agent returns its final text verbatim, so the document never round-trips through
// JSON at all. The one structured field left — the risk flags, which gate the tier — rides out on
// a single trailer line parsed here. That is a far smaller thing to get right than an 8k-char JSON
// string, and when the trailer is missing the brief still survives; only the flags are lost, and
// loudly.
const RISKFLAGS_MARKER = 'RISKFLAGS:'
// The second trailer, and the reason it exists: `uiTouched` was decided in Phase 0 from the task
// DESCRIPTION, before anyone had opened a file. A task worded as a backend fix ("stop the import
// from wiping the page") that lands in three templates got no design phase and no UI verification,
// because nothing downstream could correct the guess. The explorers HAVE read the code by now, so
// they name the frontend files this change will touch, exactly as they name risk surfaces.
const UIFILES_MARKER = 'UIFILES:'
// The evidence filter, and the analogue of looksLikeEvidence() below: a vote counts only when it
// cites something that actually looks like a frontend file. Same failure it guards against — a
// placeholder ("a file", "the template") is indistinguishable from a real citation to a gate that
// only checks the field exists, and here it would buy a whole design phase and, downstream, a
// browser deploy in the review.
const FRONTEND_PATH = /\.(html|htm|css|scss|sass|js|jsx|ts|tsx|vue|svelte)$|(^|\/)(templates|static|public|assets)\//i
// A brief this short is not a brief. It is the shape an explorer returns once it has given up —
// "test", "done", an apology. A bare `b.brief` truthiness check lets exactly that through to the
// planner; returning null here instead routes it back through reliable()'s re-dispatch, which is
// what recovers a failed slice.
const MIN_BRIEF_CHARS = 400
// The surface stays an ENUM by way of the countedFlag filter below rather than by way of a schema.
// That was always where it mattered: when this was schema-checked free text an explorer reporting
// "business-logic branching" (true of nearly every change) escalated the run anyway, and the gate
// is what stopped counting it.
// Each trailer's JSON is bounded by the OTHER trailer when that one comes later, so the two parse
// correctly in either order. Without that bound, a `UIFILES:` line written after `RISKFLAGS:` would
// be swallowed by the risk-flag parser's `lastIndexOf(']')`, and both signals would be lost to one
// mis-ordered reply.
const parseTrailerArray = (raw, marker, otherAt) => {
  const at = raw.lastIndexOf(marker)
  if (at === -1) return { at, seen: false, items: [] }
  const end = otherAt > at ? otherAt : raw.length
  const tail = raw.slice(at + marker.length, end).trim()
  // No array at all is a legitimate empty answer ("RISKFLAGS: none"). An array that is there but
  // does not parse — truncated, half-escaped — is not: that is a lost signal, and it says so
  // rather than passing as "no risk here", which is the read that made the original bug silent.
  const s = tail.indexOf('[')
  if (s === -1) return { at, seen: true, items: [] }
  const e = tail.lastIndexOf(']')
  let parsed = null
  if (e > s) { try { parsed = JSON.parse(tail.slice(s, e + 1)) } catch { parsed = null } }
  return Array.isArray(parsed) ? { at, seen: true, items: parsed } : { at, seen: false, items: [] }
}
const parseExplore = (raw) => {
  if (typeof raw !== 'string') return null
  const riskAt = raw.lastIndexOf(RISKFLAGS_MARKER)
  const uiAt = raw.lastIndexOf(UIFILES_MARKER)
  // The brief ends at the FIRST trailer present — with two of them, cutting at the last one would
  // leave the other's line sitting at the bottom of the document the planner reads.
  const cuts = [riskAt, uiAt].filter((i) => i !== -1)
  const brief = (cuts.length ? raw.slice(0, Math.min(...cuts)) : raw).trim()
  if (brief.length < MIN_BRIEF_CHARS) return null
  const risk = parseTrailerArray(raw, RISKFLAGS_MARKER, uiAt)
  const ui = parseTrailerArray(raw, UIFILES_MARKER, riskAt)
  return { brief, riskFlags: risk.items, flagsSeen: risk.seen, uiFiles: ui.items, uiSeen: ui.seen }
}
// The design agent is schema-less for the same reason the explorers and the planner are: its
// output is a markdown document, and a document plus a second parameter is the payload that blows
// the StructuredOutput retry cap. The one short field the caller needs — a sentence or two of
// design intent to hand the review's visual half — rides out on a trailer line, parsed here.
const DESIGN_INTENT_MARKER = 'DESIGN-INTENT:'
// A section shorter than this is not a design section; it is the shape an agent returns once it has
// given up. Returning null routes it back through reliable()'s re-dispatch. The floor is higher
// than the explorers' because this document has eight named subsections to fill.
const MIN_DESIGN_CHARS = 600
const parseDesign = (raw) => {
  if (typeof raw !== 'string') return null
  const at = raw.lastIndexOf(DESIGN_INTENT_MARKER)
  const section = (at === -1 ? raw : raw.slice(0, at)).trim()
  if (section.length < MIN_DESIGN_CHARS) return null
  // A missing trailer costs the intent, never the section: the document is the expensive artifact
  // and it is already on the page. The caller logs the loss rather than re-running the agent for
  // one sentence.
  const intent = at === -1 ? '' : raw.slice(at + DESIGN_INTENT_MARKER.length).trim().split('\n')[0].trim()
  return { section, intent }
}
// There is deliberately NO schema for the planner. A schema means {planMarkdown: string} — a
// single field wrapping a ~250-line markdown document, the largest structured payload in the run
// and the one most likely to fail escaping. Observed on a real run: the planner blew the
// StructuredOutput retry cap (5 failed calls) and the THROW killed the whole workflow before
// anything was written. A schema-less agent returns its final text verbatim, so the document
// never has to survive a round-trip through JSON at all. The cost is that nothing structurally
// forbids a preamble line; the prompts ask for none, and a stray one is visible in the plan file
// rather than fatal. That trade is the point.
//
// WHY THE PLANNER DOES NOT WRITE ITS OWN FILE, though that would save this whole round trip.
// The `Plan` agent type is read-only by CONSTRUCTION — it has no Edit/Write tool, and its built-in
// system prompt bans the mechanism a self-writing planner would need outright: "Using redirect
// operators (>, >>, |) or heredocs to write to files" and "Running ANY commands that change system
// state". Pointing it at a `cat > … <<'EOF'` would set its system prompt against its task prompt on
// the one instruction that matters. The alternative is a planner on a `*`-tools type, and that
// trades a STRUCTURAL guarantee for a sentence: at full tier the entire premise is that Codex
// challenges the plan BEFORE any code exists, and nothing downstream could catch a violation —
// the plan review reads the plan file, not the working tree, and the first `git diff` anyone looks
// at is after the implementers have run. So the write stays a separate, cheap, sandboxed step.
const WROTE = {
  type: 'object', additionalProperties: false,
  required: ['written', 'path'],
  properties: {
    written: { type: 'boolean' }, path: { type: 'string' }, note: { type: 'string' },
  },
}
// The second opinion on WROTE.written, and deliberately the smallest schema in the file: it asks
// for what `tail -1` printed and nothing else, so the check that rescues a plan cannot itself
// fail on a payload the way the step it is checking did.
const PLAN_ON_DISK = {
  type: 'object', additionalProperties: false,
  required: ['exists'],
  properties: { exists: { type: 'boolean' }, lastLine: { type: 'string' } },
}
const REVIEW = {
  type: 'object', additionalProperties: false,
  required: ['ran', 'findings'],
  properties: {
    // false => the REAL Codex did not run. Step 2 has no fallback reviewer, so this
    // flag is the difference between "the plan survived a critique" and "nothing
    // reviewed the plan". Never let findings:[] alone stand in for a clean review.
    ran: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'rubric', 'what'],
        properties: {
          severity: { type: 'string', enum: ['major', 'minor'] },
          // coverage | grounding | test-adequacy | simplicity | risk | ui-design (the last only
          // when the plan carries a design section, i.e. a UI change)
          rubric: { type: 'string' },
          what: { type: 'string' },
        },
      },
    },
    note: { type: 'string' },
  },
}
// One judge, a BATCH of findings that share a rubric — with one verdict returned per finding.
//
// Two rounds of this. Triage began as a single xhigh agent that judged every finding and rewrote
// the plan: 11 minutes and 122k tokens on a measured run, most of it re-deriving a code map the
// explorers had already produced. Splitting it one-agent-per-finding fixed that, and then became
// the widest fan-out in the pipeline — ~24 cold contexts per run, two waves deep at a cap of 16,
// each re-reading the plan and reopening the same files to answer one question. Batching by rubric
// keeps the parallelism and stops paying for the duplicated reading: the findings grouped together
// are the ones checked against the same code in the same way.
//
// The batch is the unit of DISPATCH, never of judgement — hence an array of verdicts keyed back to
// each finding, rather than one verdict for the group.
const VERDICTS = {
  type: 'object', additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['n', 'real', 'why'],
        properties: {
          n: { type: 'integer' },    // which finding in the batch, 1-based, as listed in the prompt
          real: { type: 'boolean' },
          why: { type: 'string' },   // the evidence, as file:LINE — this becomes the dismissal reason
          fix: { type: 'string' },   // what the plan should say instead; only meaningful when real
          // Does applying THIS fix change the approach, rather than a detail? It decides whether
          // Codex gets a second pass over the rewritten plan, so it belongs to the agent that
          // actually read the code and wrote the fix — not to the editor downstream, which sees
          // only a fix list and runs at the lowest depth in this phase. A flag that gates a review
          // has to be set by whoever has the evidence for it.
          changesApproach: { type: 'boolean' },
        },
      },
    },
  },
}
// The editor decides nothing: it applies fixes the judges already stated. `dropped` and
// `approachChanged` are both gone from the schema because both are the judges' call now, and the
// script derives them from the verdicts — an audit trail nobody has to remember to echo back.
const PLANFIX = {
  type: 'object', additionalProperties: false,
  required: ['applied'],
  properties: {
    applied: { type: 'array', items: { type: 'string' } },
  },
}
const IMPL = {
  type: 'object', additionalProperties: false,
  required: ['done', 'summary'],
  properties: {
    done: { type: 'boolean' },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    blockedOn: { type: 'string' }, // set when the plan looked wrong — surfaced, never worked around
    // One line per test written: "<test> — before: RED|GREEN (<the failure, or 'passed on
    // unmodified code'>) — after: GREEN". Red-before-green is asserted HERE, after running the
    // test, not in the plan: a plan is free to claim its tests will fail first when several
    // already pass, and only the full-tier Codex plan review would catch that. A test that passed before the change is a
    // regression guard, which is fine — but it must be LABELLED one, because a suite of green
    // guards proves nothing about the fix. Asking for the observed result makes the claim
    // falsifiable at the point where it can actually be observed: after running the test.
    testEvidence: { type: 'array', items: { type: 'string' } },
  },
}
const BRANCH = {
  type: 'object', additionalProperties: false,
  required: ['onBranch'],
  properties: { onBranch: { type: 'string' }, note: { type: 'string' } },
}
const BUILD = {
  type: 'object', additionalProperties: false,
  required: ['green'],
  properties: {
    green: { type: 'boolean' },              // true ONLY on a fully clean build
    failures: { type: 'string' },
    inScopeFailures: { type: 'string' },     // in code THIS run changed -> ours to fix
    preExistingFailures: { type: 'string' }, // already red on base -> NEVER ours to fix
  },
}

// --------------------------------------------------------------- helpers -----
// The subagent-flow contract in code: a null return means the agent died or was
// skipped. Re-dispatch up to 2 extra times, then hand back a blocked sentinel
// instead of hanging or silently dropping the step. Nothing is ever polled.
//
// A dead agent USUALLY resolves null, but it can also THROW — a StructuredOutput retry cap and an
// exhausted token budget both surface as a rejected promise. Untrapped, that ends the whole
// script: observed on a real run, the planner blew the cap and a 6-agent workflow died with
// `TelemetrySafeError` before writing anything, because this await was bare. A throw is the same
// event as a null return — the step produced nothing — so it gets the same bounded re-dispatch
// rather than taking the run down with it. This also restores the retries for reliable() calls
// nested inside parallel(): parallel converts a thrown thunk to null one level ABOVE this loop,
// and untrapped that swallows the throw and costs the step all three attempts at once.
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
// Blocked = the agent DIED (agent() resolved null/undefined), the runner gave up (the
// reliable() sentinel), or the subagent said its tool never ran. The null case matters even
// though most calls here go through reliable(): `parallel()` resolves a thrown thunk to null,
// so without it `impls.every(blocked)` is FALSE when every implementer died, and the run goes on
// to build code nobody wrote. Every call site treats blocked() as "this track is bad".
const blocked = (x) => !x || !!(x.blocked || x.ran === false)

// A `*`-tools type: it has Skill/Bash/Read/Write/Edit but NOT `Agent` — no agent
// spawned from this script can fan out beneath itself. Every fan-out is therefore
// expressed here, in the script, as parallel()/loops.
const GP = { agentType: 'general-purpose' }
// Run one fixed command and report what it printed. There is no branch, no classification and no
// prose in the output — the comparison that uses it happens in THIS script, not in the agent — so
// the cheapest model is the right one. Effort is moot at this tier and stays low for clarity.
const ECHO = { model: 'haiku', effort: 'low' }
// Runs git and reports the result. Cheap, but NOT the echo tier: the branch step has to report the
// branch the repo is REALLY on rather than the one it was asked to create, which is exactly the
// distinction issue #90 turned on. The equality-vs-base guard below catches a wrong answer, but a
// model that is likelier to echo its own intent leans on that guard harder than it should.
const MECHANICAL = { model: 'sonnet', effort: 'low' }
// The scribe steps: copy a given document to disk, flip one header line, run one fixed command.
// No judgement, so they do not need the session's model — but they are not `low` either: the
// plan file is reproduced VERBATIM from the prompt, and a paraphrased or truncated plan silently
// degrades the Codex review and every implementer that reads it.
const SCRIBE = { model: 'sonnet', effort: 'medium' }
// The stats sink appends counts to a JSONL file. It deliberately does NOT share SCRIBE: it has
// none of the property that makes SCRIBE `medium`, because nothing is reproduced verbatim, so
// there is nothing to truncate or paraphrase. It is a heredoc handed to `python3` — the echo tier, and by design it
// can never fail the run, so it is the cheapest thing here to get wrong.
const SINK = ECHO
// The runner AGENTS are `haiku` — right for the "BUILD SUCCESSFUL" path that is almost every
// dispatch. This call steps back up over the agent's own tier because on a RED build it has to
// split the failures into in-scope and pre-existing, and that split decides whether the run fixes
// them or halts and surfaces them. The green path costs the same either way; the model only
// matters once there is something to classify.
const BUILD_RUN = { model: 'sonnet', effort: 'medium' }
// Phase 0 reads gh/git into a schema; the one real judgement is the tier. Keep the inherited
// model — the tier is a three-way tree decided on calibration examples, which needs real
// discrimination, and an unsure answer lands on "standard" rather than "full", so a weak
// classifier's mistakes go BOTH ways: the expensive direction is under-rating, which ships an
// unchallenged approach rather than merely costing time. Drop the
// inherited xhigh though — it buys nothing on what is otherwise transcription.
const SOURCE_RUN = { effort: 'medium' }
// The Codex agent shells out and collects the run; Codex does the reviewing. Its own reasoning
// adds nothing to the critique. Not `low`, though: this agent owns the background-collection
// protocol that produced false blocks on #82/#55, and that is the wrong place to save 20s.
const CODEX_RUN = { effort: 'medium' }
// Exploration is read-and-map work — extract files/conventions/tests, not judgement — so it
// runs on a cheaper/faster tier than the inherited main-loop model. medium (not low) because
// the one consequential call an explorer makes is riskFlags, which gates the light->FULL
// escalation below; medium leaves it enough budget to spot auth/money/migration/concurrency.
const EXPLORE_RUN = { model: 'sonnet', effort: 'medium' }
// The plan is the highest-leverage artifact in the run, so the standard/full planner gets the most
// capable model at maximum reasoning effort — the inverse of the explorers. agent() exposes a real
// effort lever here (the raw Agent tool does not), so depth is dialed in, not just asked for.
const PLAN_RUN = { model: 'opus', effort: 'xhigh' }
// The LIGHT-tier planner writes a brief for a change that, by the tier's own definition, cannot
// alter behavior. It shared PLAN_RUN because both are "the plan", but maximum reasoning effort on
// a brief buys nothing — and the tier is not load-bearing on its own: the explorers' risk flags
// escalate light->FULL the moment they see auth, money, migrations or concurrency, so a
// misclassified task never actually gets planned here. Same model, one tier down.
const PLAN_LIGHT_RUN = { model: 'opus', effort: 'high' }
// The UI/UX design agent. Opus because this is judgement — what the screen should be, which of the
// app's existing components it is built from, which states it owes the user — and a cheaper model
// reliably produces the generic layout `frontend-design` exists to rule out. `high` rather than the
// planner's `xhigh`: the surface is one screen area against a design system that already exists,
// not the whole change, and this document is reviewed downstream (by Codex at full tier, and by the
// review's visual half against the rendered pages) rather than being the last word.
const DESIGN_RUN = { model: 'opus', effort: 'high' }
// The implementers were the one track that pinned nothing, so their depth came from the SESSION —
// xhigh when entered through /r:task-run (whose frontmatter sets it), but whatever the caller
// happened to be running at when this script is called directly, which SKILL.md explicitly invites
// callers like /r:gh-issues-fix to do. The same workflow wrote code at a different depth depending on
// the entry point, silently. Pin it instead: `high` is a real floor for work that follows a plan
// built at opus/xhigh, challenged by Codex, and re-read afterwards by /r:task-review. The model
// is named here too — the two specialized types already declare opus, so this only lifts the
// `general` fallback to match them rather than letting it inherit the session's model.
const IMPL_RUN = { model: 'opus', effort: 'high' }
// Triage is SPLIT, not one agent, and the two halves want different depths. Collapsed into a
// single xhigh agent that judges every finding and rewrites the plan, it measures 11 minutes and
// 122k tokens on a real run, most of it re-deriving a code map the explorers already produced.
//
// A judge answers ONE narrow question — does this finding hold against the real code — with the
// briefs already in hand, so `high` is depth where it counts without the context that makes the
// collapsed step slow. Nor is it the last word: a dismissal is re-read by Codex in pass 2 (the
// dismissedAll branch below) and the diff is re-read by /r:task-review, which covers what a
// "no reviewer after it" argument for xhigh would be defending against.
const JUDGE_RUN = { effort: 'high' }
// The editor applies fixes that are already written down and flips one header line. There is no
// judgement left in it except "did this change the approach".
const EDIT_RUN = { effort: 'medium' }

// ================================================================ pipeline ===
// Tolerant arg parsing. The Workflow tool passes `args` VERBATIM and its docs ask callers for a
// real JSON value — but in practice they hand over a JSON *string* almost every time (across the
// local transcript history: 0 object args, 39 string ones). A string silently reads back as
// `undefined` for every option, so options don't fail loudly, they just stop existing.
// Parse defensively, and never let a malformed arg take the run down:
//   - valid JSON object  -> use it
//   - array / number / other JSON scalar -> {}, because those can't be an options bag
//   - not JSON at all    -> treat it as the task source. `source` is the only required arg
//                           here, so a bare "#81" is unambiguous — recovering it beats
//                           throwing a SyntaxError that kills an otherwise fine run.
const opts = (() => {
  if (typeof args === 'string') {
    try {
      const v = JSON.parse(args)
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    } catch { return { source: args } }
  }
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {}
})()

// --- Where the pack lives, and why this is a HALT ----------------------------
// It has to come from the CALLER: ${CLAUDE_PLUGIN_ROOT} is substituted in skill MARKDOWN and
// nowhere else — not inside a workflow script the Workflow tool executes (FR-19), and not in a
// subagent's shell, where the variable is unset and bash expands it to the empty string.
//
// Read it off `opts`, NEVER off the raw `args` above the parser. A test like `(args && typeof
// args === 'object' && args.packRoot)` looks equivalent and is not: callers hand over a JSON
// *string* almost every time — 0 object args against 39 string ones across the stored history —
// and a string fails that typeof, so packRoot goes missing even when it WAS passed.
//
// And do not fall back to the placeholder itself on the reasoning that it "either expands or fails
// loudly". Neither half holds: it does not expand, and `python3 /skills/…/record-run.py` is a plain
// not-found in the one step that is best-effort by design, so it fails in silence. Observed on a
// real run of the sibling pipeline, where the same fallback broke seven tool paths at once.
const PACK = (() => {
  const p = typeof opts.packRoot === 'string' ? opts.packRoot.trim() : ''
  // An unsubstituted placeholder is ABSENT, not a path.
  return (!p || p.includes('CLAUDE_PLUGIN_ROOT')) ? '' : p
})()
if (!PACK) {
  log('run-task-implement: no usable `packRoot` in args — the pipeline cannot locate the stats ' +
      'script or any sibling tool. Stopping rather than running with tool paths resolving under ' +
      '"/". Pass packRoot: "${CLAUDE_PLUGIN_ROOT}" from the skill markdown, where that placeholder ' +
      'is actually substituted.')
  return { stopped: 'no-pack-root' }
}

const rawSource = typeof opts.source === 'string' ? opts.source.trim() : ''
if (!rawSource) {
  log('run-task-implement: no `source` in args — nothing to run')
  return { stopped: 'no-source', detail: 'args.source is required ("#42" | "todo.md / Phase 3" | free-text task)' }
}
const TIERS = ['light', 'standard', 'full']
const forcedProfile = TIERS.includes(opts.profile) ? opts.profile : null

// --- Dry-run affordance: classify and stop -----------------------------------
// `classifyOnly` runs Phases 0 and 1 and returns the tier decision instead of planning. It exists
// because the tier is the one output of this script that is worth checking against REAL tasks
// before trusting it — the classifier tree and the escalation gate are prompt-and-enum judgements,
// and a control-flow test with stubbed agents can prove the branches without saying a word about
// whether the tier that comes back is the right one. Everything it runs is read-only: no branch,
// no plan file, no commit.
//
// `repo` names the directory the agents should work in, for the case where the classification is
// being checked from OUTSIDE the target repo. It is honored only under classifyOnly: the later
// phases (branch, plan file, build, implementers) all assume the process cwd is the repo root, so
// a `repo` that silently applied to a real run would scatter half the work into the wrong tree.
const classifyOnly = !!opts.classifyOnly
const repoDir = classifyOnly && typeof opts.repo === 'string' && opts.repo.trim() ? opts.repo.trim() : null
if (opts.repo && !classifyOnly) log('run-task-implement: ignoring `repo` — it is only honored under classifyOnly')
const inRepo = repoDir
  ? `\n   WORK IN THE REPOSITORY AT ${repoDir}. cd there first; every git/gh/file command below is
   relative to it, and nothing outside it is yours to read or touch.\n`
  : ''
// `sourceModel` pins the classifier's model for a dry run so the same issues can be classified by
// two models and the tiers compared. It is the honest way to settle "would a cheaper model do?" —
// the argument at SOURCE_RUN is a prediction, and this is what turns it into a measurement.
// classifyOnly-only, for the same reason `repo` is: a real run that quietly classified on a
// different model than the one the comment reasons about would make the reasoning unfalsifiable.
const sourceModel = classifyOnly && typeof opts.sourceModel === 'string' && opts.sourceModel.trim()
  ? opts.sourceModel.trim() : null
if (sourceModel) log(`run-task-implement: classifier pinned to model "${sourceModel}" for this dry run`)

// --- Phase 0: resolve the source, the tier, and the build tool ---------------
// One agent, because these are all cheap repo reads that share context: reading the
// issue tells you the risk surface, which decides the tier, which decides how many
// explorers Phase 1 spawns. Splitting it would cost round-trips and buy nothing.
phase('Source')
const src = await reliable('source', 'Source', () => agent(
  `You are /r:task-run Steps 0 and 0.5 for this task source: ${JSON.stringify(rawSource)}
${inRepo}
   1. IDENTIFY THE SOURCE, in this order:
      - GitHub issue(s) — one ref ("#42", "42", an issue URL) OR SEVERAL refs in the string
        ("#42 #61", "42 61"), which is one GROUPED task: several issues that a single change
        is meant to fix together. FIRST check \`command -v gh >/dev/null && gh auth status\`.
        If gh is missing or unauthenticated, set blockedReason and STOP — never scrape a fallback.
        Then \`gh issue view <n> --json title,body,labels,comments\` for EACH ref. kind="issue".
        * One ref  -> branch="issue-<n>-<short-slug>".
        * Several   -> branch="issues-<n1>-<n2>[-…]-<short-slug>", the slug naming the shared fix.
      - Todo phase (a markdown path + a phase id, or "next phase"): read the file, locate the
        phase block; "next phase" = the first phase with unchecked "- [ ]" items.
        kind="todo", branch="phase-<slug>".
      - Free text: the argument IS the task; there is no source to fetch. kind="text",
        branch="task-<slug>". If the input is contentless or genuinely ambiguous (no file, no
        issue, no described work), set blockedReason — there is no task to run.
   2. ACCEPTANCE CRITERIA -> criteria[]. For an issue or a phase, take the checklist/bullets that
      describe "done". For a GROUP of issues, merge every issue's criteria into the one criteria[],
      each prefixed with its number ("#42: …") so the planner and implementers can tell which
      issue each requirement belongs to — the fix is done only when EVERY grouped issue's criteria
      are met. For free text there are none written: leave criteria empty — deriving them is the
      planner's job — but still write taskIntent.
   3. taskIntent: 1-3 sentences on what this task sets out to do. It is threaded into every
      downstream implementer and (via the handoff) into the review, so a fixer cannot "fix"
      something the task did on purpose. Write it even when criteria are empty. For a group, state
      the shared change and name the issues it resolves.
   4. TIER (${forcedProfile ? `FORCED to "${forcedProfile}" by the caller — return exactly that, and still write profileReason` : 'classify it'}):
      Classify the CHANGE this task will make — not the subsystem it lives in. Almost every file
      worth editing sits near a query, a permission check or some money math; what decides the
      tier is whether THIS change adds or alters one of them. Work the tree in order:

        a. Can the change alter behavior for any real input?         no  -> "light"
        b. Does it need a design decision — a new or changed approach, several seams, a data
           model or a contract — OR does it add or alter auth/permissions, money/pricing/tax
           math, persistence (a schema change, migration or index; locking or transaction
           semantics; a query whose result shape callers depend on), concurrency/locking, or
           anything security-sensitive?                              no  -> "standard"
        c. otherwise                                                     -> "full"

      When the approach follows a comparable feature already in this repo, say which one in
      profileReason ("mirrors the existing cancel-deal action"); when it does not, say that.
      A tier whose reason names the precedent it checked can be audited by opening that file,
      and a wrong tier is then traceable to a wrong claim instead of a matter of taste.

      READ THE PERSISTENCE ARM NARROWLY. It means schema, migration, index, locking — the
      things you cannot simply revert. Adding an ordinary read-only query, a repository or
      port method over a table that already exists, or a field and its mapping, is NOT this
      arm; it is "standard". A tree that counts every query routes every feature in a
      JPA/ORM codebase to "full", which is how the middle tier stops existing: measured over
      52 real runs of this pipeline, "standard" was chosen ZERO times.

      Calibrate on these, both directions:
        light    — a log message or level, even in PaymentService; renaming a private method; a
                   constant/config VALUE tweak; formatting; a copyright-year bump; a cosmetic
                   template/CSS change; a DTO field that is only serialized.
        standard — a two-line null check added to a validator; a bug fix inside one existing
                   method; a new field plus its mapping; a new endpoint over a service that
                   already does the work; a new read-only query/repository method over an
                   existing table, and the page or DTO that renders it.
        full     — a migration, new index or schema change; anything that alters an
                   auth/permission decision or money math; a change spanning several seams; a
                   new module or a public-API contract; a read-modify-write that needs a lock.
      Scary wording alone does not force "full" (a copyright-year bump in a payment template is
      light); "small" wording alone does not earn "light" (a one-line auth-role change is full).

      When you are unsure, answer "standard" — it keeps a real Codex read of the diff, the real
      /security-review, doc-drift checking, static analysis, build+tests and a Codex read of the
      final diff, and gives up the plan review, the three find-bugs pattern hunters and the
      polish passes. The plan review is what "full" is really for. "full" is a claim that the
      APPROACH needs challenging before code is written, not a shrug. The one case that IS a
      shrug: if after reading the source you still cannot say roughly WHICH LINES will change,
      you have not scoped the task — answer "full" and say so in profileReason.
   4b. profileReason: one sentence naming the deciding factor ("adds a migration", "log-level
      change only, no behavior", "unscoped — the issue names no files"). This is logged and
      carried to the caller, so a wrong tier can be traced to a reason instead of re-guessed.
   5. uiTouched: will this touch a frontend file — templates and *.html, *.css/*.scss, frontend
      *.js/*.ts (and *.jsx/*.tsx/*.vue/*.svelte), anything under templates/, static/, public/ or
      assets/? This is a FIRST guess from the description, and the explorers who actually read the
      code can turn it on afterwards (they cannot turn it off), so answer what the task plainly
      says and do not stretch for it. It decides whether the review later boots the app and looks
      at the rendered pages, so a change that must LOOK the same still counts as touching the UI.
   5b. uiVisualChange: does this change what a user SEES or INTERACTS WITH — a new or changed
      screen, fragment, component, state (empty/loading/error), layout, visual treatment, or user-
      facing copy? Answer for the RENDERED RESULT, not for the file extension: a change that edits
      templates or CSS but is meant to leave every page looking and behaving exactly as it does now
      is "false". Self-hosting a font or an icon set, a CSP or header change, renaming a CSS class
      or a template fragment, a build/asset-pipeline change, adding a test hook or a data-attribute
      — all false, even though every one of them edits .html or .css. An acceptance criterion of
      the form "the appearance does not change" is the giveaway: answer false.
      This buys a UI/UX DESIGN phase before planning, whose entire output is a decision about what
      the screen should be. There is nothing for it to decide when the answer is "the same as now",
      and a design agent given that task writes a section explaining that it has nothing to design.
      It cannot be true when uiTouched is false.
      Also set hasBackend / hasFrontend for implementer routing.
   6. BUILD TOOL from the repo root — return BOTH commands. buildCmd is the CLEAN certifying
      build used exactly ONCE; buildCmdFast is the incremental rebuild used every time after.
      maven -> "mvn clean package" / "mvn package", runnerAgent "r:maven-build-runner".
      gradle -> "./gradlew clean build" / "./gradlew build", runnerAgent "r:gradle-build-runner".
      neither -> buildTool "none".
      NOT \`install\`: a multi-module reactor resolves inter-module dependencies within the same
      session, so writing every module into ~/.m2 buys this run nothing and costs the whole
      install phase. /r:task-review certifies the same tree with \`package\`, and the caller hands
      THIS build's result to it as \`baselineBuilt\`, so the two pipelines agree on what the
      certifying build is.
   7. base: the CURRENT branch (\`git branch --show-current\`)${opts.base ? `, unless it differs from the caller's stated base ${JSON.stringify(opts.base)} — then return that one` : ''}.
   8. RESUME STATE: planPath = ".task-plans/<slug>.md". Report planStatus from its "status:"
      header if the file exists (else "none"), and branchExists from
      \`git rev-parse --verify <branch>\`. Do NOT create the branch or the plan file here.
   9. exploreAspects: the different aspects of the codebase that must be mapped before planning,
      one short instruction each, along the change's NATURAL SEAMS (e.g. "persistence + data model
      + migrations", "the web/UI layer + templates", "the closest existing feature + its tests").
      Scale to the surface, not to your confidence: exactly 1 for "light"; 2 for "standard"; for
      "full", 2 when the work sits inside one subsystem and 3 when it spans several. Never more
      than 3 — beyond that the explorers overlap and return the same files twice.`,
  { label: 'source', phase: 'Source', schema: SOURCE, ...GP, ...SOURCE_RUN, ...(sourceModel ? { model: sourceModel } : {}) }))

if (blocked(src)) return { stopped: 'source-unresolved' }
if (src.blockedReason) {
  log(`run-task-implement: cannot start — ${src.blockedReason}`)
  return { stopped: 'source-blocked', detail: src.blockedReason }
}
let profile = forcedProfile || (TIERS.includes(src.profile) ? src.profile : 'full')
let profileEscalated = false
const planPath = src.planPath || `.task-plans/${src.slug}.md`
log(`run-task-implement: ${src.kind} "${src.slug}" — tier ${profile} (${forcedProfile ? 'forced' : 'classified'}: ${src.profileReason || 'no reason given'}), base ${src.base}, branch ${src.branch}`)

// --- Phase 1: map the code BEFORE planning it --------------------------------
// Unconditional, in every tier. A planner that has not opened the code anchors its plan to
// file:line references it INFERRED, and everything downstream inherits the mistake — the reuse
// map points at utilities that don't do what it claims, and Codex burns its review on
// corrections instead of on the approach.
phase('Explore')
const aspects = (src.exploreAspects || []).slice(0, 3)
const askedAspects = aspects.length ? aspects : ['the files this task will touch, their conventions, and the tests that cover them']
const briefs = await parallel(askedAspects
  .map((aspect, i) => () => reliable(`explore#${i + 1}`, 'Explore', async () => parseExplore(await agent(
    `Read-only exploration for this task: ${src.taskIntent}
${inRepo}
     Your slice: ${aspect}
     Return a focused brief: the key files as path:LINE, the patterns and utilities already
     there, the conventions the code follows, the existing tests that cover it, and the
     constraints a change here must respect. Do not propose a design — map what EXISTS.

     Write the brief as plain prose/markdown and nothing else — it is read verbatim by the planner,
     so there is no JSON to escape and no wrapper to fill in. Your reply IS the brief.

     Then end your reply with these TWO final lines, in this order and with nothing after them:
       UIFILES: ["path/to/template.html", "path/to/styles.css"]
       RISKFLAGS: [{"surface": "...", "where": "path:LINE", "why": "..."}]

     UIFILES lists the FRONTEND files this task's change will touch — templates and *.html, *.css /
     *.scss, frontend *.js/*.ts (and *.jsx/*.tsx/*.vue/*.svelte), anything under templates/,
     static/, public/ or assets/. Same discipline as the risk flags below: list a file only if the
     change will MODIFY it. A template the change merely renders through, or a stylesheet that
     happens to live next door, is not a UI file for this purpose. \`UIFILES: []\` is a real and
     common answer — return it for backend-only work.
     This decides whether the review later boots the app and looks at the rendered pages, and — when
     the task description gave no sign of a frontend at all — whether the run gets a UI/UX design
     phase before planning. It can only turn those ON: the task description already voted, and you
     are correcting it with what you actually read.

     RISKFLAGS carries one entry per risk surface THIS TASK'S CHANGE will add or alter. There
     are exactly five, and 'surface' must be one of them:
       auth        — an authentication, authorization, permission or role decision
       money       — pricing, tax, billing or any other money math
       persistence — a query's semantics, a schema, a migration or an index
       concurrency — locking, threading, async ordering, shared mutable state
       security    — a secret or credential, crypto, deserialization, or input from outside the
                     system that the change causes to be trusted
     Give each a 'where' (path:LINE) and a 'why' saying how the change alters it.

     State what the change DOES to the surface, not what it might need. "if the change adds an
     index", "likely requires a new column" is work the plan has not decided on yet; a 'why'
     written that way is dropped and does not escalate the run.

     Judge each against the task intent above: report a surface only if the change will MODIFY it
     or alter its behavior. Do NOT list risk that merely exists nearby in the files you read —
     money math in the same class as the log line being changed is not a flag, and neither is a
     permission check the change only reads past. Nor are these flags at all: ordinary
     business-logic branching, a read-only query the change does not alter, or an external call
     the change merely calls through. Those are normal in almost every change, and a signal that
     fires on almost every change carries no information.

     Five named surfaces, and no sixth: if what worries you does not fit one of them, it belongs in
     the brief, not here. "security" in particular is the four things listed above, not a mood — a
     catch-all read of it fires on every change that touches a request, which is the same way the
     old free-text version of this list stopped meaning anything.

     This list escalates the run to the heaviest review tier — the one that stops to have its plan
     challenged before code is written — so it should fire when the approach genuinely deserves
     that and stay quiet otherwise. \`RISKFLAGS: []\` is a real and common answer: return it whenever
     the change stays clear of all five surfaces above.`,
    // The label carries the slice INDEX, not just its first 24 characters. Three explorers on one
    // task routinely share an opening phrase ("Map the calculator…"), and when they do, three
    // identical rows in the progress tree make the one that died unidentifiable.
    { label: `explore#${i + 1}:${aspect.slice(0, 24)}`, phase: 'Explore', agentType: 'Explore', ...EXPLORE_RUN })))))

const liveBriefs = briefs.filter((b) => b && !blocked(b) && b.brief)
// Two accountings that would otherwise be silent. A slice that came back unusable is a hole in the code map
// the planner is about to design against, and a missing RISKFLAGS trailer is an escalation vote
// that was never cast — neither is fatal, and both are things you want to read afterwards when the
// plan turns out to have missed the seam nobody explored.
if (liveBriefs.length < askedAspects.length) {
  const lost = askedAspects.filter((_, i) => !(briefs[i] && !blocked(briefs[i]) && briefs[i].brief))
  log(`run-task-implement: ${lost.length} of ${askedAspects.length} explorer slice(s) came back unusable — planning on a partial code map: ${lost.join(' | ').slice(0, 200)}`)
}
const flagless = liveBriefs.filter((b) => !b.flagsSeen)
if (flagless.length) {
  log(`run-task-implement: ${flagless.length} explorer(s) returned no parsable RISKFLAGS line — their risk surfaces did not vote in the tier decision`)
}
if (!liveBriefs.length) {
  log('run-task-implement: every explorer came back blocked — refusing to plan against unread code')
  return { stopped: 'explore-blocked' }
}
const briefText = liveBriefs.map((b, i) => `--- brief ${i + 1} ---\n${b.brief}`).join('\n\n')

// Phase 0 classified from the task DESCRIPTION, before anyone had opened the code. Now someone
// has. A riskFlag means the change itself adds or alters one of the five surfaces named in the
// tree's "full" condition — so light and standard both escalate straight to full. Doing it here
// as control flow rather than as a judgement the model must remember to re-make costs one
// explorer to correct a guess before that guess propagates all the way to a PR.
//
// The filter on RISK_SURFACES is not belt-and-braces over the schema: it is where this gate says
// what it counts. Anything an explorer reports outside the five is not a tier decision — the
// planner still reads it in the brief, it just does not buy a Codex plan review.
//
// This overrides an explicit --light too, because the flag was typed with the same information
// Phase 0 had (the task description) and the explorer has strictly more. The log says so plainly:
// silently ignoring someone's flag is worse than overruling it out loud.
// A flag must point AT something. `required` in the schema forces the three fields to exist, not
// to contain evidence — observed on a real run: an explorer returned {surface:"security",
// where:"a", why:"b"}, a placeholder that is indistinguishable from a finding as far as the gate is
// concerned and would have bought a full Codex plan review on its own. Demanding that `where`
// looks like a path is the cheapest check that a placeholder cannot pass and a real citation
// always does.
const looksLikeEvidence = (w) => typeof w === 'string' && w.trim().length >= 6 && /(\/|\.[A-Za-z]{2,})/.test(w)
// A `where` that cites a real file proves the explorer READ something; it does not prove the
// change DOES anything to it. Measured on issue #73: "existing indexes only cover (…), so IF the
// change adds one it is a new schema object" cites a genuine migration file, passes the check
// above, and buys a full Codex plan review for a maybe — an index the plan had not decided to
// add. The same run under two other promptings produced "LIKELY requires a new index"; three
// rewordings never removed it, because the fault is that the gate counts a hypothesis as a
// finding, not that the sentence was phrased badly.
//
// So the `why` must ASSERT. Hedged flags do not escalate — they fall into ignoredFlags, which is
// logged, so a wrongly-dropped one is visible rather than silent. Checked against every flag this
// gate has really seen: it drops exactly the two speculative ones and keeps all of #122's
// migration/purge/ShedLock flags and #31's money and column flags.
//
// Dropping is the safer direction here on purpose. An over-fire costs a full run on every task —
// which is how the tier collapsed to "always full" in the first place — while a missed escalation
// costs the plan review and the pattern hunters, and standard still runs the real Codex diff read,
// /security-review, static analysis, build + tests and the Codex end-verify.
const HEDGED = /\b(if|may|might|could|likely|possibly|potentially|perhaps|probably|suspect|assuming)\b/i
const asserts = (w) => typeof w === 'string' && w.trim().length >= 6 && !HEDGED.test(w)
const countedFlag = (f) => !!f && RISK_SURFACES.includes(f.surface) && looksLikeEvidence(f.where) && asserts(f.why)
const allFlags = liveBriefs.flatMap((b) => b.riskFlags || [])
const ignoredFlags = allFlags.filter((f) => !countedFlag(f))
if (ignoredFlags.length) {
  log(`run-task-implement: ignored ${ignoredFlags.length} risk flag(s) with no usable surface, no evidence, or a hedged why: ${JSON.stringify(ignoredFlags).slice(0, 200)}`)
}

// QUORUM — two flags, because letting one well-formed flag escalate straight to full makes a
// single opportunistic flag decisive. Issue #73 — a read-only admin page Phase 0 correctly called
// standard — escalated on FOUR consecutive runs, each time on a different rationale: two
// speculative index claims (now dropped as hedged), then "the new route relies on the existing
// /admin/** matcher" (which the prompt already forbids, since no auth decision changes), then
// "bounding an unclamped limit changes the query's semantics". Each fix removed one rationale
// and the next appeared. An explorer asked "does this touch any of five surfaces?" will find a
// yes for anything non-trivial, so no wording makes a lone flag trustworthy.
//
// So a surface must be raised by TWO explorers before it moves the tier. The obvious objection
// is that explorers get DISJOINT slices, so this asks two readers of different rooms to report
// the same fire — a UI-slice explorer never sees a migration. Checked against every flag this
// gate has really produced, it discriminates anyway: #122 got persistence from two slices (the
// V75 migration and the purge semantics), #31 got money from three and persistence from two,
// while #73's two flags sat on two different surfaces and neither reached two. Real risk shows
// up from several angles; the opportunistic flag shows up once.
//
// Distinct EXPLORERS, not flags: one explorer listing three persistence flags is still one
// reader, and counting flags would let it clear the bar alone.
//
// The light tier runs ONE explorer, where a quorum of two is unreachable — there a single flag
// still escalates. That is the tier where a miss costs most (a change that read as trivial and
// turns out to touch auth), and with one reader there is no second opinion to be had.
const wellFormed = liveBriefs.map((b) => (b.riskFlags || []).filter(countedFlag))
const votes = new Map()
for (const flags of wellFormed) {
  for (const surface of new Set(flags.map((f) => f.surface))) {
    votes.set(surface, (votes.get(surface) || 0) + 1)
  }
}
const quorum = liveBriefs.length > 1 ? 2 : 1
const carried = new Set([...votes].filter(([, n]) => n >= quorum).map(([s]) => s))
const foundRisks = wellFormed.flat().filter((f) => carried.has(f.surface))
const shortOfQuorum = wellFormed.flat().filter((f) => !carried.has(f.surface))
if (shortOfQuorum.length) {
  const surfaces = [...new Set(shortOfQuorum.map((f) => f.surface))].join(', ')
  log(`run-task-implement: ${shortOfQuorum.length} well-formed risk flag(s) short of quorum — ${surfaces} raised by only one of ${liveBriefs.length} explorers, so the tier is unchanged: ${JSON.stringify(shortOfQuorum).slice(0, 200)}`)
}
if (profile !== 'full' && foundRisks.length) {
  const overridden = forcedProfile ? ` (overrides your --${forcedProfile})` : ''
  const from = profile
  profile = 'full'
  profileEscalated = true
  const named = foundRisks.slice(0, 3).map((f) => `${f.surface} at ${f.where} — ${f.why}`).join('; ')
  log(`run-task-implement: re-classified ${from} -> FULL${overridden} — the change alters a risk surface: ${named}`)
}

// The same correction, for the OTHER guess Phase 0 made from the description alone. uiTouched
// decides whether this run gets a design phase before planning and, through the handoff, whether
// the review boots the app and looks at the rendered pages — and until now nothing could revise it
// after someone had actually read the code.
//
// ONE DIRECTION ONLY, and not for symmetry's sake: an explorer maps its own slice, not the
// repository, so "my slice has no templates" is not evidence that the change touches none. A
// false POSITIVE from Phase 0 is already corrected downstream — /r:task-review re-classifies
// uiTouched from the real diff whenever the tier was not forced — while a false negative is
// exactly what this gate exists to catch, and nothing else would.
//
// It does NOT move the tier. UI is not one of the five risk surfaces, and routing every template
// change to full would undo the reason `standard` exists.
//
// And no quorum, unlike the risk flags above. The quorum is there because "does this touch one of
// five surfaces?" is a judgement an explorer will answer yes to for anything non-trivial, so one
// reader's yes proves little. This asks for something else: a FILE PATH, which either is a
// frontend file or is not, and the filter below checks that rather than trusting the claim. A
// second explorer agreeing that rates.html is a template adds nothing — and it could not agree
// anyway, since the slices are disjoint and only one of them holds the templates.
const uiVotes = liveBriefs.flatMap((b) => b.uiFiles || [])
  .filter((f) => typeof f === 'string' && f.trim().length >= 4)
const uiFiles = uiVotes.filter((f) => FRONTEND_PATH.test(f))
const uiIgnored = uiVotes.filter((f) => !FRONTEND_PATH.test(f))
if (uiIgnored.length) {
  log(`run-task-implement: ignored ${uiIgnored.length} UIFILES vote(s) that do not name a frontend file: ${JSON.stringify(uiIgnored).slice(0, 200)}`)
}
const uiFileless = liveBriefs.filter((b) => !b.uiSeen)
if (uiFileless.length) {
  log(`run-task-implement: ${uiFileless.length} explorer(s) returned no parsable UIFILES line — their view of the frontend surface did not vote`)
}
let uiTouched = !!src.uiTouched
let uiEscalated = false
if (!uiTouched && uiFiles.length) {
  uiTouched = true
  uiEscalated = true
  log(`run-task-implement: uiTouched false -> TRUE — the explorers found frontend files this change touches: ${uiFiles.slice(0, 5).join(', ')}`)
}
// The design phase's own gate, and the reason it is not `uiTouched`. That flag answers "does a
// frontend FILE change?", which is the right question for the review's browser pass and the wrong
// one here: issue #123 of a real repo ("self-host the fonts, drop Google Fonts from the layouts and
// the CSP") edits three templates and a stylesheet and lists "the appearance does not change
// noticeably" as an acceptance criterion. It bought a full Opus design phase, which opened with
// "this change is visually invisible by design" and then filled eight subsections saying so — ten
// minutes and the run's most expensive agent spent proving there was nothing to decide.
//
// So the design phase asks the narrower question: is there a VISUAL DECISION to make? A change that
// must render exactly as it does now has none, however many .html files it edits.
//
// One exception, and it is the case Phase 1b was built for: when the explorers turned uiTouched on,
// Phase 0 did not know this task had a frontend at all, so its uiVisualChange answer is not a
// judgement about the visuals — it is a consequence of having missed them. Treat it as unanswered
// and run the design phase. That is the "backend-worded task that lands in three templates" the
// UIFILES trailer exists to catch, and it is exactly where nobody has decided the visuals yet.
let uiVisualChange = uiTouched && !!src.uiVisualChange
if (uiEscalated && !uiVisualChange) {
  uiVisualChange = true
  log('run-task-implement: uiVisualChange -> TRUE — the description hid the frontend entirely, so Phase 0 never judged the visuals; the design phase runs')
}

// Dry run stops HERE — after the tier is settled, before the first thing that writes. Phase 2's
// scribe creates .task-plans/, so returning any later would leave a file behind in a repo the
// caller only asked to classify.
if (classifyOnly) {
  log(`run-task-implement: classifyOnly — ${src.kind} "${src.slug}" settled at ${profile}${profileEscalated ? ' (escalated)' : ''}`)
  return {
    classifyOnly: true,
    source: rawSource,
    kind: src.kind,
    profile,
    profileForced: !!forcedProfile,
    profileEscalated,
    // What Phase 0 decided from the description alone, kept next to the settled tier: the gap
    // between the two IS the measurement — it says how often reading the code changes the answer.
    profileFromDescription: src.profile,
    profileReason: src.profileReason || '',
    // Settled, post-escalation — and next to it what Phase 0 thought, for the same reason the two
    // tier fields sit together: the gap is the measurement.
    uiTouched,
    uiFromDescription: !!src.uiTouched,
    uiEscalated,
    // The design phase's gate, kept separate from uiTouched for the same reason the two tier fields
    // sit together: the pair (uiTouched true, uiVisualChange false) is the whole class of change
    // that edits templates without deciding anything, and it is worth being able to count.
    uiVisualChange,
    uiFiles,
    explorers: aspects.length || 1,
    exploreAspects: aspects,
    riskFlags: foundRisks,
    // Well-formed flags that only ONE explorer raised. Not a defect and not silent: this is the
    // number to watch if the gate ever looks too quiet, and the pair (this, riskFlags) is what
    // says whether a quiet run was agreed or merely unwitnessed.
    riskFlagsShortOfQuorum: shortOfQuorum,
    // Flags the explorers returned that the gate did NOT count — an unrecognised surface, or a
    // `where` that cites nothing. Empty is the expected shape; a non-empty one is the early
    // warning that the signal is drifting back toward "everything is risky".
    riskFlagsIgnored: ignoredFlags,
  }
}

// --- The feature branch, started EARLY and collected at Phase 4 --------------
// Creating the feature branch is the explicit opt-in that overrides the global "never create a
// branch unless asked" rule — /r:task-run always runs on one.
//
// It depends on nothing the plan or its review produces, only on Phase 0's branch/base, yet it used
// to sit between the plan editor and the implementers — a whole serial agent round trip on the
// critical path to run one `git checkout -b`. Start it here instead and collect it below. What it
// overlaps with is the plan scribe writing `.task-plans/<slug>.md` and appending to `.gitignore`,
// which is safe in both directions: `git checkout -b <new> <base>` moves HEAD to the same commit
// and therefore does not touch the working tree at all. On a RESUME the checkout is a real one that
// could, but a resume skips planning entirely, so nothing runs alongside it.
//
// The branch is the run's unit of work: the caller merges it into base and closes the issue on it.
// A run that quietly STAYS on base breaks both ends — the diff lands on main, and the caller then
// tries to merge main into main. That happened (issue #90: handoff {branch:'main', base:'main'},
// buildGreen:true, an otherwise normal-looking result) because nothing checked WHICH branch came
// back: BRANCH.onBranch is a plain string, so an agent that failed to check out and honestly
// reported "main" passed the only test there was (non-empty). Two guards close it — a branch name
// that is missing or equal to base never reaches the agent, and a result equal to base is retried
// once and then STOPS the run. `branch === base` is not a degraded success; it is a failed step.
const branchPrefix = src.kind === 'todo' ? 'phase' : src.kind === 'text' ? 'task' : 'issue'
const srcSlug = (src.slug || '').trim()
let wantBranch = (src.branch || '').trim()
if (!wantBranch || wantBranch === src.base) {
  if (srcSlug) {
    wantBranch = srcSlug.startsWith(`${branchPrefix}-`) ? srcSlug : `${branchPrefix}-${srcSlug}`
    log(`run-task-implement: unusable branch name from Phase 0 (${JSON.stringify(src.branch)}) — using "${wantBranch}" instead; this run must not do its work on ${src.base}`)
  } else {
    wantBranch = ''
    log(`run-task-implement: Phase 0 returned no usable branch name (branch=${JSON.stringify(src.branch)}, base=${src.base}) and no slug to build one from`)
  }
}
// Deliberately NOT awaited here. `reliable()` traps throws and returns a sentinel, so this cannot
// reject; the .catch is belt-and-braces, because an unhandled rejection from a floating promise
// would take the whole script down rather than the step.
const branchP = !wantBranch ? null : (async () => {
  let br = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    br = await reliable(attempt === 1 ? 'branch' : 'branch-retry', 'Implement', () => agent(
      `Put the repo on the feature branch ${wantBranch}, based on ${src.base}.
       ${src.branchExists
         ? 'The branch ALREADY EXISTS (this is a resume): just check it out, keep any work on it, and do NOT reset or rebase it.'
         : `Create it off ${src.base} — \`git checkout -b ${wantBranch} ${src.base}\`.`}
       ${attempt === 1 ? '' : `The previous attempt ended on ${src.base}, i.e. the checkout did NOT happen. Run it again and READ ITS EXIT STATUS: if it fails, put the git error in 'note' rather than reporting whichever branch you happen to be on.`}
       Commit nothing, and do not touch any file — another agent may be writing the plan while you
       run. Then run \`git rev-parse --abbrev-ref HEAD\` and return its EXACT output as onBranch —
       the branch the repo is REALLY on now, never the name you intended to create.`,
      { label: attempt === 1 ? 'branch' : 'branch-retry', phase: 'Implement', schema: BRANCH, ...GP, ...MECHANICAL }))
    if (blocked(br) || !br.onBranch) break
    if (String(br.onBranch).trim() !== src.base) break
    log(`run-task-implement: the branch step came back on ${src.base} — the feature branch was not created (attempt ${attempt}/2)`)
  }
  return br
})().catch(() => null)

// --- Phase 1b: the UI/UX design, when there is a UI to design ----------------
// WHY THIS IS ITS OWN PHASE AND NOT A PARAGRAPH IN THE PLANNER'S PROMPT.
// It was a paragraph, and that is the whole problem: the planner owns nine sections — criteria
// coverage, the reuse map, the TDD test plan, the risks — and "also decide how the page should
// look" competed with all of them inside one context. What came back was a plan with markup in it
// and no stated visual intent, so the implementer decided the visuals while writing templates and
// the review's visual half then graded the result against generic taste. Splitting it out buys one
// agent whose entire output is the design, before a line of the plan exists.
//
// It runs in EVERY tier, because the tier says how risky the change is, not whether a page changed
// — a light-tier "cosmetic template change" is precisely the task where design judgement IS the
// work. It is skipped on a resume: the section is already in the plan file on disk. And it is
// gated on `uiVisualChange`, not on `uiTouched`: editing a template is not the same as deciding
// what a page should be, and the gap between the two is where this phase would otherwise burn an
// agent (see the uiVisualChange settle above).
//
// The agent is read-only and writes nothing. The section reaches disk through the same scribe that
// writes the plan, so there is exactly one artifact and one verbatim-copy check.
const resuming = src.planStatus === 'implementing' || src.planStatus === 'done'
// Shared by the design agent, both planners and the implementers: everyone downstream builds
// against the same acceptance criteria, so they are rendered once.
const criteriaText = (src.criteria || []).length
  ? (src.criteria || []).map((c) => `- ${c}`).join('\n')
  : '(none written — DERIVE an explicit acceptance-criteria list from the task description FIRST, then plan against it)'
let designSection = ''
let designIntent = ''
// Wanted, not merely run: it is also what the planner's fallback keys off, so a task with no visual
// decision does not get told to set a visual direction by a planner instead.
const designWanted = uiVisualChange && !resuming
if (uiTouched && !uiVisualChange && !resuming) {
  log('run-task-implement: skipping the UI/UX design phase — this change touches frontend files but decides nothing visual (the rendered result is meant to stay as it is)')
}
if (designWanted) {
  phase('Design')
  const design = await reliable('ui-design', 'Design', async () => parseDesign(await agent(
    `Decide the UI/UX for this task, before it is planned or built. You are read-only: return the
     design section, do not write a file and do not edit anything.

     TASK (${src.kind}): ${rawSource}
     INTENT: ${src.taskIntent}
     ACCEPTANCE CRITERIA:
     ${criteriaText}

     The codebase has already been mapped for you. Design against THESE briefs, and re-open the
     templates, stylesheets and components they cite rather than inferring what they contain:
     ${briefText}
     ${uiFiles.length ? `The explorers named these frontend files as the ones this change touches: ${uiFiles.join(', ')}.` : ''}

     FIRST, load the \`frontend-design\` skill (Skill tool) and design against its rubric. This is
     the same rubric the review's visual half will judge the finished pages against, so a design
     that never read it is designing against an invisible bar.

     THEN find the design system this app already has, and build on it. Look for a written one —
     ui-design.md, DESIGN.md, docs/ui*, a tokens/theme file, the CSS custom properties at the top
     of the main stylesheet — and for the unwritten one in the pages next to the ones you are
     changing. A design that starts a SECOND visual language inside the same app is the expensive
     kind of wrong: it looks fine in isolation and wrong in the product. If the app genuinely has
     no design system, say so and derive the direction from the closest existing page.

     Return ONE markdown section, starting with the heading "## UI/UX design", with exactly these
     subsections:
     - Screens & routes — which pages/fragments change, and how the user reaches them.
     - States — what each changed screen shows for: default, empty, loading, error, success, and
       no-permission. Name the ones that genuinely do not apply and say why. Missing states are the
       most common real UI defect, and they are decided here or not at all.
     - Layout & hierarchy — what dominates, what recedes, what the eye hits first. Include a plain
       text wireframe (ASCII boxes are fine) for each changed screen.
     - Reuse map — the existing components, fragments, utility classes and tokens this is built
       from, each with a file:LINE pointer, plus an explicit "do NOT invent" list: the things an
       implementer might otherwise write from scratch when the app already has them.
     - Responsive — what changes at desktop, tablet and mobile widths. Say what collapses, what
       reflows, and what must not overflow.
     - Accessibility — labels, focus order, keyboard path, contrast, and anything a screen reader
       needs. Concrete requirements, not a reminder to be accessible.
     - Copy — the exact user-facing strings this introduces, using the app's own i18n keys if it
       has them.
     - Decisions & rejected alternatives — the calls you made and, for each, the one or two you
       turned down and why. This is what stops the implementer re-deciding it downstream.

     Stay in your lane: you decide what the user sees, NOT how the code is structured. No class
     names, no controller wiring, no data flow — the planner owns those and will plan against your
     section. Cite file:LINE for every existing thing you claim to reuse; a reuse map built on
     files you did not open is worse than none.

     Scale the section to the change. A one-element tweak gets a short section, not eight headings
     padded to look thorough — but it never drops the states or the reuse map, which are the two
     that stop an implementer inventing something the app already has.

     YOUR ENTIRE REPLY IS THE SECTION, followed by ONE final line and nothing after it:
       DESIGN-INTENT: <at most two sentences saying what this change should look and feel like>
     That line is carried to the reviewer who later looks at the rendered pages, so write the bar
     you want to be held to. Everything above it is copied verbatim into the plan file, so no
     preamble, no "here is the design", and no fenced code block around the whole document.`,
    { label: 'ui-design', phase: 'Design', ...GP, ...DESIGN_RUN })))
  if (blocked(design) || !design.section) {
    // NOT a halt, and deliberately unlike the Codex plan review's `codex-plan-review-unavailable`.
    // There the whole premise of the tier is that the approach was challenged before code existed,
    // and no stand-in reviewer is acceptable. Here there IS a real fallback one line below — the
    // planner loading `frontend-design` itself — so a dead design agent costs depth, not the run.
    log("run-task-implement: the UI/UX design phase came back blocked — falling back to the planner's own frontend-design pass")
  } else {
    designSection = design.section
    designIntent = design.intent
    if (!designIntent) log('run-task-implement: the design section arrived without a DESIGN-INTENT trailer — the section still lands in the plan, but the review gets no stated design intent')
    log(`run-task-implement: UI/UX design decided (${designSection.split('\n').length} lines) — it goes into ${planPath} and the planner plans against it`)
  }
}

// --- Phase 2: the plan -------------------------------------------------------
// Resume: a plan already past review is not re-planned or re-reviewed.
phase('Plan')
if (resuming) log(`run-task-implement: resuming — ${planPath} is already at status "${src.planStatus}", skipping plan + plan-review`)

// What the planner is told about the visuals, in three shapes.
//
// 1. The design phase ran: the section is DECIDED, and the planner's job is to build the
//    implementation around it rather than to re-open it. Handing a planner a design and letting it
//    "improve" the design is how the two artifacts end up disagreeing inside one plan file.
// 2. The design phase was wanted but died: fall back to what this pipeline did before it existed —
//    the planner loads `frontend-design` itself. Thinner, but the run is not graded on a bar
//    nobody read.
// 3. No visual decision in this change — a backend task, or one that edits templates without
//    changing what they render: nothing at all. A planner dragged through a design rubric it does
//    not need spends its attention on a section it will not write, and case 2 is keyed on
//    `designWanted` rather than `uiTouched` for exactly that reason.
const uiDesignNote = designSection
  ? `
       THE UI/UX IS ALREADY DECIDED. A design agent worked it out against the \`frontend-design\`
       rubric and the app's existing design system, ahead of this plan, and its section is
       reproduced below. It is copied into the plan file verbatim, ahead of your plan, and the
       implementers build from it — so plan the IMPLEMENTATION of it: which templates, fragments
       and assets change, and which existing components the reuse map points at. Do NOT re-decide
       the visuals, re-word the section, or design a second version of it. If it genuinely
       contradicts the code you read, say so in "Assumptions & risks" with the file:LINE that
       contradicts it, rather than quietly diverging.

${designSection.split('\n').map((l) => `       ${l}`).join('\n')}
`
  : designWanted
    ? `
       THIS TASK TOUCHES THE UI, and the dedicated design phase could not run — so the visual
       direction is yours to set. Load the \`frontend-design\` skill (Skill tool) and plan the
       visual work against it: layout and hierarchy, typography, spacing, the states a real page
       needs (empty, loading, error), and responsive behaviour. Build on the components, tokens and
       page structure the briefs found — a plan that starts a second visual language inside the
       same app is the expensive kind of wrong. Write the design decisions you made and why into
       the plan, so the implementer inherits direction instead of re-deciding it from scratch, and
       so the reviewer can check the pages against a stated intent.`
    : ''

if (!resuming) {
  let planMarkdown
  // The full planner runs for standard as well as full. What standard gives up is the Codex
  // REVIEW of the plan (Phase 3), not the thinking that produces it — a medium task still
  // deserves a grounded plan, and a cheap plan would just push the cost into the implementers.
  if (profile !== 'light') {
    // Opus at xhigh (PLAN_RUN): the plan is the highest-leverage artifact in the run, so it gets
    // the most capable model at maximum reasoning effort. It is still written and critiqued by
    // DIFFERENT models — Codex reviews it in Phase 3 — so a single model never grades its own plan.
    const plan = await reliable('planner', 'Plan', () => agent(
      `Plan this task at MAXIMUM reasoning depth. You are read-only: return the plan, do not write it.

       TASK (${src.kind}): ${rawSource}
       INTENT: ${src.taskIntent}
       ACCEPTANCE CRITERIA:
       ${criteriaText}

       The codebase has already been mapped for you — plan against THESE briefs, and re-open the
       files yourself rather than inferring what they contain. Re-open the ones you will CITE; the
       briefs cover the rest. THIS PROJECT'S source only — never unpack a dependency to read its
       internals (no \`unzip\`/\`jar -x\` over ~/.m2, no decompiling): a library's private behaviour
       is not something a plan should depend on, and if you genuinely need a version or an API
       shape, use the maven-deps MCP or name it in "Assumptions & risks" for the review to settle.
       ${briefText}
${uiDesignNote}
       Reuse the existing patterns and utilities you find; do not invent new ones. Return the plan
       as markdown with exactly these sections:
       - Context — why this change, and the current state.
       - Files to change and the approach — cite the real code you will touch as file:LINE.
       - Reuse map — the existing utilities/services/patterns this builds on, each with a
         file:LINE pointer. This is the evidence you explored rather than imagined.
       - Assumptions & risks — what the plan takes for granted, and the genuinely risky spots
         (migration, money math, concurrency, auth/permission, external calls). Unstated
         assumptions are the ones that bite.
       - Alternatives considered — ~2 approaches weighed, one line on why this one won. A single
         planner locks onto its first idea; naming the roads not taken forces a real comparison.
       - TDD test plan — the tests that come FIRST, each naming the behaviour or edge case it
         locks, and each TAGGED with what it is expected to do against the CURRENT, unmodified
         code:
           [RED] it must FAIL today — say which assertion fails and why the current code cannot
                 satisfy it. This is the tag that proves the change does something.
           [GREEN] it passes today — a regression guard that locks behaviour the change must not
                 break. A legitimate and common tag; it is only dishonest when it is labelled RED.
         Tag by what the code does, not by what would look better. A plan that calls a green guard
         a red gate produces a suite that appears to prove a fix while it only re-states existing
         behaviour — and the implementer, who runs these tests before writing anything, will find
         out anyway. If a criterion has no [RED] test behind it, say so explicitly in the coverage
         contract and explain what does prove it instead.
       - Verification steps — how to prove it works end to end.
       - Coverage contract — one row per acceptance criterion:
         criterion -> where it's implemented -> the test that proves it -> the verification step.
         A criterion with no test behind it is not covered.

       BEFORE YOU RETURN, DEEPEN ONCE: re-open the 3-5 files most critical to the approach you
       just chose and pressure-test the draft against the real code. Does the approach actually
       fit those files? Do the cited file:LINEs still say what you claim? Does any criterion's
       coverage fall apart on a second read? Revise the plan to fix whatever that surfaces, THEN
       return it. Codex reviews this next — it should see a plan that already survived one honest
       second look, not a first draft.

       YOUR ENTIRE FINAL MESSAGE IS THE PLAN. Return the markdown itself and nothing else — no
       preamble, no "Here is the plan:", no closing remark, no fenced code block around the whole
       document. What you return is copied to disk verbatim and is what Codex reviews and what the
       implementers build from, so anything that is not plan text becomes a line in the plan.`,
      { label: 'planner', phase: 'Plan', agentType: 'Plan', ...PLAN_RUN }))
    if (blocked(plan) || typeof plan !== 'string' || !plan.trim()) return { stopped: 'planner-blocked' }
    planMarkdown = plan.trim()
  } else {
    // Light tier: no Codex plan review, and the plan itself stays BRIEF — but it runs on the same
    // Opus/xhigh planner (PLAN_RUN) and still carries a real coverage contract, so a light plan is
    // a checkable contract rather than loose prose. The light saving is skipping the review pass,
    // not cheapening the planner.
    const lite = await reliable('plan-light', 'Plan', () => agent(
      `Write a BRIEF implementation plan for this low-risk task. Keep it proportionate — this is
       the light tier — but it must still be a contract, not prose.

       TASK (${src.kind}): ${rawSource}
       INTENT: ${src.taskIntent}
       ACCEPTANCE CRITERIA:
       ${criteriaText}
       CODE BRIEF:
       ${briefText}
${uiDesignNote}
       Return markdown with: Context; Files to change (cite file:LINE from the brief); TDD test
       plan — the test that comes first, TAGGED [RED] (it must fail against the current code — say
       which assertion fails) or [GREEN] (it passes today and guards existing behaviour); and a
       Coverage contract — one row per criterion: criterion -> where it's implemented -> the test
       that proves it. Tag honestly: the implementer runs these before writing code, so a green
       guard mislabelled as a red gate is caught there anyway, having wasted the plan.

       YOUR ENTIRE FINAL MESSAGE IS THE PLAN. Return the markdown itself and nothing else — no
       preamble, no closing remark, no fenced code block around the whole document. What you
       return is copied to disk verbatim, so anything that is not plan text becomes a line in the
       plan.`,
      { label: 'plan-light', phase: 'Plan', ...GP, ...PLAN_LIGHT_RUN }))
    if (blocked(lite) || typeof lite !== 'string' || !lite.trim()) return { stopped: 'planner-blocked' }
    planMarkdown = lite.trim()
  }

  // The design section rides into the plan file AHEAD of the plan, as one document with one
  // scribe. Not a second file: the plan path is what Codex reviews, what the implementers read,
  // and what a resume picks up from — a design kept beside it would be the one artifact nobody
  // downstream is already opening. Verbatim, because the planner may paraphrase anything it is
  // asked to repeat, and the point of deciding the design in its own phase is that the words
  // survive to the implementer.
  //
  // Everything the scribe verifies is computed from THIS combined text — the line count, the
  // last-line truncation check, the disk re-check below — so prepending here needs no change to
  // any of it.
  if (designSection) planMarkdown = `${designSection}\n\n${planMarkdown}`

  // The planner is read-only and this script has no filesystem access, so a scribe agent puts
  // the plan on disk. The file is the shared artifact for the Codex reviewer and the
  // implementers — passing it by path is what keeps every downstream context lean.
  //
  // The one job here is a byte-for-byte copy, and it is the step most likely to fail QUIETLY:
  // a scribe that re-wraps prose, "tidies" a heading or drops a section produces a perfectly
  // well-formed plan file that does not match the plan Codex is about to review and the
  // implementers are about to build. So the prompt asks for a quoted heredoc (the plan is full of
  // backticks and file:LINE refs that an unquoted one would hand to the shell) and gives the
  // scribe the ONE fact it cannot fake — the exact line count — to check its own work against.
  const planLineCount = planMarkdown.split('\n').length
  const wrote = await reliable('plan-write', 'Plan', () => agent(
    `Write this plan to ${planPath} in the repo, prefixed with this status header:

     status: ${profile === 'full' ? 'reviewing' : 'implementing'}   # reviewing -> implementing -> done
     tier: ${profile}
     source: ${src.kind === 'issue' ? `issue ${rawSource}` : rawSource}
     base: ${src.base}

     First \`mkdir -p .task-plans\` and make sure ".task-plans/" is listed in .gitignore — append
     the line if it is missing. Plans are scratch space and are never committed. Do not edit any
     other file.

     COPY THE PLAN BODY BYTE FOR BYTE. You are a scribe, not an editor: no re-wrapping, no
     reformatting or "tidying" of markdown, no fixing what looks like a typo, no summarising, no
     eliding a long section with "..." — and never re-type it from memory. Reproduce every line,
     including blank lines and indentation, in its original order. This exact text is what Codex
     reviews and what the implementers build from, so a plan that is merely CLOSE to the original
     is a plan that silently disagrees with the run around it.

     Write it with a QUOTED heredoc so the shell expands nothing — the plan contains backticks,
     \`$\` and file:LINE references, and an unquoted heredoc would execute them:
       cat > ${planPath} <<'RUN_TASK_PLAN_EOF'
       <header, blank line, then the plan body>
       RUN_TASK_PLAN_EOF

     THEN VERIFY, because a truncated copy looks like a successful one. Do NOT count lines by
     hand — run the commands and read what they print:
       tail -1 ${planPath}
       tail -n +6 ${planPath} | wc -l

     The FIRST is the check that matters: the last line of the file must be the last line of the
     plan below. Truncation — the failure this step exists to catch — always changes it.

     The second is a corroborating count: the plan body below is ${planLineCount} line(s), and
     \`tail -n +6\` skips the 4 header lines and the blank line after them. If the last line is
     right but the count is off by a line or two, the body is intact and the boundary arithmetic
     is what disagrees — put both numbers in 'note' and still return written=true. Only return
     written=false when the last line is WRONG or the file is missing: that is a real truncation,
     and it is retried cheaply here. Returning written=false for an intact plan is not a safe
     default — it throws away a document that cost the most expensive agent in the run to produce.

     PLAN (${planLineCount} line(s)):
     ${planMarkdown}`,
    { label: 'plan-write', phase: 'Plan', schema: WROTE, ...GP, ...SCRIBE }))
  // A self-reported failure is a claim about the disk, not the disk itself — so check the disk
  // before throwing the plan away. Observed on a real run: the scribe wrote a complete 247-line
  // plan, miscounted its own body by two lines against the header boundary, and returned
  // written=false; the run stopped at 'plan-not-written', and RESUMING replayed that cached
  // verdict, so the same good plan was discarded twice before a third full attempt rewrote it.
  // Reading the file makes this step idempotent: whatever the scribe believes, a plan whose last
  // line is the planner's last line is a plan, and a poisoned cache entry stops mattering.
  if (blocked(wrote) || !wrote.written) {
    const wantLast = planMarkdown.split('\n').pop().trim()
    const onDisk = await reliable('plan-check', 'Plan', () => agent(
      `Run \`tail -1 ${planPath}\` and report what it printed. Return exists=false if the file is
       missing or empty. Do not write or edit anything — this is a read-only check on work another
       agent already did.`,
      { label: 'plan-check', phase: 'Plan', schema: PLAN_ON_DISK, ...GP, ...ECHO }))
    const intact = !blocked(onDisk) && onDisk.exists && (onDisk.lastLine || '').trim() === wantLast
    if (!intact) return { stopped: 'plan-not-written' }
    log(`run-task-implement: plan-write reported failure${wrote.note ? ` ("${String(wrote.note).slice(0, 120)}")` : ''} but ${planPath} ends on the planner's last line — the plan is intact, continuing`)
  }
}

// --- Phase 3: Codex challenges the plan (full tier only) ---------------------
// Before a line of code is written. There is no diff yet, so this reviews the plan DOCUMENT —
// the adversarial-review run.sh script reviews a diff and is the wrong tool here.
//
// Runs on `general-purpose`, NOT `codex:codex-rescue`. The rescue type auto-loads
// `codex-cli-runtime`, which makes it a one-shot forwarder and forbids `status`/`result` — so it
// physically cannot obey the collect-the-backgrounded-run instruction below, and returns ran=false
// on every review that outlives the 600s Bash cap. Observed on issues #82 and #55.
//
// Audit trail. Everything else in this pipeline refuses to let a track vanish quietly (`ran`
// flags, blocked sentinels, the in-scope/pre-existing split) — and the triage step is the easiest
// place to break that, since it decides which Codex findings were real and edits the plan. Drop
// those two lists and "Codex raised three majors and the triage dismissed all three" reads
// identically to "Codex found nothing". Carry the decisions out, so they reach the caller's PR
// body and a lazy triage has somewhere to show up.
const planReview = { ran: false, passes: 0, raised: 0, applied: [], dropped: [] }
if (!resuming && profile === 'full') {
  phase('Plan-review')
  const rubric = `Work through this fixed rubric and tag every finding major or minor:
     1. Coverage — does every acceptance criterion map to a concrete implementation AND a test
        that proves it? A criterion covered only in prose is a gap.
     2. Grounding — do the cited file:LINE references and the Reuse map actually exist and behave
        as the plan claims? A plan built on a misread of the code is the most expensive wrong.
     3. Test adequacy — do the planned tests really pin the behaviour and its edge cases, or are
        they shallow? Check every [RED] tag against the real code: a test tagged RED must be one
        the CURRENT code genuinely fails. A green guard mislabelled as a red gate is a MAJOR
        finding — it makes a suite look like it proved a fix when it only re-stated what the code
        already did. Say which tag is wrong and what it should be.
     4. Simplicity (YAGNI) — is anything over-built for needs that aren't here? Is there a simpler
        approach that still satisfies every criterion?
     5. Risk — are the risky spots (migration, money math, concurrency, auth, external calls)
        called out and handled, or waved past?${designSection ? `
     6. UI/UX design — the plan opens with a "## UI/UX design" section, decided in its own phase
        before the plan. Does it cover the states a real page owes the user (empty, loading, error,
        no-permission), reuse the components and tokens this codebase already has instead of
        starting a parallel visual language, and state responsive and accessibility behaviour in
        concrete terms? Check its reuse map the way you check the plan's: a file:LINE that does not
        say what the section claims is a MAJOR finding. Then check the plan AGAINST the section —
        a plan that builds something other than what the design says is the failure this pairing
        exists to catch. Tag these findings with rubric "ui-design".` : ''}`
  // Item 6 is added only when there IS a design section in the plan — not merely when the change
  // touches the UI. A rubric item handed to a reviewer with nothing to apply it to does not come
  // back empty: it comes back with invented findings about a section that does not exist, and each
  // one then costs a judge. That is reachable two ways here — a change with no visual decision, and
  // a design phase that died — and `designSection` is the only thing true in neither case.
  //
  // Note what this does NOT reach: the plan review runs at `full` only, so at light and standard
  // the design section goes unchallenged until the review's visual half sees the rendered pages.
  // That is the existing tier trade — the same one that leaves those tiers without a plan review
  // at all — not a hole this phase opened.

  // Pass 2 is NOT a cold re-read. A fresh Codex process with no idea what it said the first time
  // or what the triage did with it wastes the one thing a second pass is uniquely good for. The
  // triage is the only judgement in this run with nothing reviewing it — it decides which of
  // Codex's findings were real and edits the plan accordingly, so left cold its dismissals are
  // answerable by nobody but the human reading the PR much later. Handing pass 2 the delta makes
  // Codex grade what happened to its OWN findings, and lets it re-raise a dismissal it still
  // disagrees with. It is also cheaper than a cold re-read: the reviewer is checking a diff of
  // decisions rather than re-deriving the whole critique.
  const delta = (prior) => {
    if (!prior) return ''
    const applied = prior.applied || []
    const dropped = prior.dropped || []
    const bullets = (xs) => xs.map((x) => `       - ${x}`).join('\n')
    // Two different situations reach a re-review, and telling Codex the wrong one wastes the pass.
    // When the triage kept nothing, the plan in front of it is UNCHANGED — describing that as
    // "revised in response" invites it to hunt for edits that do not exist, and the landed-fix
    // check below has nothing to check.
    const nothingApplied = !applied.length
    const opening = nothingApplied
      ? `THIS IS A RE-REVIEW, not a first look. You reviewed this plan once and the triage dismissed
     EVERY finding you raised, so the plan in front of you is UNCHANGED. Your job is to adjudicate
     those dismissals — not to re-derive the critique.`
      : `THIS IS A RE-REVIEW, not a first look — you reviewed this plan once and it has since been
     revised in response.`
    const checks = []
    if (!nothingApplied) checks.push(
      `Did each accepted fix actually land in the plan, and does it address the finding rather
        than its symptom? A fix recorded as applied but absent from the file — or one that rewords
        the text around the problem and leaves the problem — is a MAJOR finding.`)
    checks.push(
      `Is each dismissal fair? Re-read the plan and judge the reason given on its merits. If it
        holds, let the finding go and do not re-raise it — you do raise false positives, and a
        reviewer that never accepts a correction is no more useful than one that never objects.
        If it does not hold, re-raise the finding at its original severity and say why the stated
        reason fails.`)
    return `

     ${opening}
     Put everything below into the prompt you pass to Codex, and work ${checks.length > 1 ? 'these checks' : 'this check'} BEFORE
     the rubric:

     WHAT YOU RAISED LAST TIME:
${bullets(prior.findings.map((f) => `[${f.severity}][${f.rubric}] ${f.what}`))}
     ${applied.length ? `ACCEPTED and folded into the plan:\n${bullets(applied)}` : 'ACCEPTED: none — the triage applied nothing you raised.'}
     ${dropped.length ? `DISMISSED as false positives, with the reason given:\n${bullets(dropped)}` : 'DISMISSED: none.'}

${checks.map((c, i) => `     ${i + 1}. ${c}`).join('\n')}
     Then apply the rubric to the ${nothingApplied ? 'plan' : 'revised plan'} for anything ${nothingApplied ? 'the first pass missed' : 'the rewrite newly broke'}.`
  }

  const askCodex = (pass, prior) => reliable(`codex-plan-review#${pass}`, 'Plan-review', () => agent(
    `Run the REAL Codex over the PLAN FILE ${planPath} (not a diff) and challenge it.
     Task source: ${rawSource}

     Call the Codex companion DIRECTLY with Bash. Do NOT invoke the adversarial-review skill or
     its run.sh: those review a git diff, and running one from a Codex-backed agent makes Codex
     re-enter the wrapper that launches Codex, inside a read-only sandbox where it dies on mktemp.
       C="$HOME/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs"
       [ -f "$C" ] || C="$(ls -1d "$HOME"/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | sort -V | tail -n1)"
       node "$C" task --wait --effort medium "<the review prompt you build from the rubric below>"
     Pass --wait so Codex runs in the FOREGROUND, --write=false — this is a review, not an edit —
     and --effort medium, set explicitly so the depth is pinned rather than inherited from whatever
     the CLI default happens to be. Medium is the right level for THIS job: the rubric below is a
     fixed five-item checklist against a document and the code it cites, which is concrete checking
     rather than open-ended reasoning. It is also what keeps the run inside the foreground window —
     at high this step routinely ran 16-26 minutes and spilled into the background collection path
     below, which is the slowest and most failure-prone way to get the same critique. ${rubric}${delta(prior)}

     Set ran=true ONLY if the real Codex actually produced a critique. If the CLI is missing, the
     job failed, or it timed out and moved to the background and you could not collect the
     finished review, set ran=false — there is NO fallback reviewer here and no stand-in model is
     acceptable, so a false "clean" is worse than an honest failure. A review longer than the
     ~600s Bash cap WILL be moved to the background — that is expected, not a failure, and giving
     up there is the single most common way this step reports a false block. You ARE permitted to
     poll here: collect the run by polling the worker PID, then read the job record's "rendered"
     field under ~/.claude/plugins/data/codex-openai-codex/state/*/jobs/*.json. Never poll for
     output-size stability, because the log goes quiet for minutes mid-reasoning.`,
    { label: `codex-plan-review#${pass}`, phase: 'Plan-review', schema: REVIEW, ...GP, ...CODEX_RUN }))

  let review = await askCodex(1)
  // Step 2 has no fallback: the plan is critiqued by the real Codex or not at all.
  if (blocked(review)) {
    log('run-task-implement: the Codex plan review could NOT run — stopping. No stand-in reviewer is acceptable here.')
    return { stopped: 'codex-plan-review-unavailable', planPath, detail: (review && review.note) || '' }
  }
  planReview.ran = true

  // Triage + apply, then ONE re-review — and only if the approach actually changed. The cap is
  // the point: this catches a rewrite that opened a fresh hole, it does not loop until the plan
  // is flawless. No approval gate — the run is autonomous, and the human reviews the final PR.
  //
  // Triage is a FAN-OUT, not one agent. A single xhigh agent handed nothing but the finding
  // strings has to re-open every file each finding cites to decide whether it holds, re-deriving a
  // code map the explorers built minutes earlier, and works the findings one after another.
  // Measured: 11 minutes and 122k tokens, more than the Codex review it is triaging. Two things
  // answer that, and they compose:
  //   - each judge gets the EXPLORER BRIEFS, so it starts from the map instead of rebuilding it;
  //   - the judges run in parallel, so the cost is the slowest single finding, not their sum.
  // The editor that follows is then genuinely mechanical: every fix it applies is already written
  // down by the judge that accepted it.
  //
  // The editor also flips the plan's status header, because it is already editing that exact file
  // and a separate agent round-trip to change one line is pure latency. On the rare two-pass path
  // the flip lands before the re-review, so an interrupt in that window resumes at implement on a
  // plan that was reviewed once and triaged once — which is the same outcome the "re-review could
  // not run" branch below already accepts.
  let statusFlipped = false
  for (let pass = 1; pass <= 2; pass++) {
    if (!review.findings || !review.findings.length) {
      log(`run-task-implement: plan review pass ${pass} — Codex raised nothing`)
      break
    }
    planReview.passes = pass
    planReview.raised += review.findings.length

    // BATCHED, not one agent per finding. Judging is genuine work — does this hold against the
    // real code — but the unit of work is the CODE a finding cites, not the finding itself, and a
    // measured ~24 findings per run meant ~24 cold contexts each re-reading the plan and reopening
    // the same files, two waves deep at a concurrency cap of 16. Grouping by rubric puts the
    // findings that are checked the same way in front of one reader: every `grounding` item is
    // "does the cited file:LINE say what the plan claims", every `coverage` item is a walk of the
    // same criteria table. One context read then serves the whole group.
    //
    // What this deliberately does NOT do is judge less. Every finding still gets its own verdict,
    // its own evidence and its own changesApproach flag; a batch that dies leaves its findings
    // UNJUDGED exactly as a dead single judge did. Depth stays at JUDGE_RUN.
    const CHUNK = 5
    const batches = []
    for (const rubric of [...new Set(review.findings.map((f) => f.rubric || 'other'))]) {
      const group = review.findings.filter((f) => (f.rubric || 'other') === rubric)
      // A rubric that ran long is split rather than allowed to swallow the pass: one reader with
      // twelve findings is back to being the serial step this replaced.
      for (let i = 0; i < group.length; i += CHUNK) batches.push({ rubric, items: group.slice(i, i + CHUNK) })
    }
    log(`run-task-implement: plan review pass ${pass} — judging ${review.findings.length} finding(s) in ${batches.length} batch(es) by rubric`)

    const batchVerdicts = await parallel(batches.map((b, bi) => () =>
      reliable(`judge#${pass}.${bi + 1}:${b.rubric}`, 'Plan-review', () => agent(
        `Judge ${b.items.length === 1 ? 'ONE finding' : `these ${b.items.length} findings`} from Codex's review of the plan at ${planPath}. Decide whether each
         holds against the real code, and nothing else — you are not editing the plan.

         They all come from the same rubric (${b.rubric}), so they are checked the same way and
         largely against the same code. Read that code ONCE and answer all of them from it; do not
         restart your reading for each.

         FINDINGS:
${b.items.map((f, n) => `         ${n + 1}. [${f.severity}][${f.rubric}] ${f.what}`).join('\n')}

         The codebase was already mapped for this task. Start from these briefs and open only what
         you still need to confirm — each finding cites specific code, so check THAT:
         ${briefText}

         Read the relevant parts of ${planPath} and the code they point at. Return one verdict per
         finding, with 'n' set to its number above — every finding gets its own verdict, even when
         several turn out to share a cause:
         - real=true if the finding holds. Put the evidence in 'why' as file:LINE, and in 'fix'
           write what the plan should say instead — concretely enough that someone editing the plan
           can apply it without re-doing your reading.
         - real=false if it does not. 'why' is then the dismissal reason, and it is answerable:
           Codex may be shown it and given a chance to push back, so give the evidence that
           convinced you rather than an assertion.
         Codex raises real problems and false positives both. Judge each on what the code actually
         says. Do not let one finding's verdict carry the others: a batch returned all-real or
         all-false without separate evidence is the failure this grouping has to avoid.

         When real=true, also set changesApproach: does applying YOUR fix send the plan down a
         different route — a different design, a different seam, a different data flow — or does it
         adjust a detail? Adding a test, correcting a file:LINE citation, tightening wording or
         filling a coverage gap is a detail. Set it true only for the first kind: it costs the run
         a second full Codex review of the rewritten plan, which is worth paying when the plan
         really did change shape and is pure delay when it did not.`,
        { label: `judge#${pass}.${bi + 1}:${b.rubric}`, phase: 'Plan-review', schema: VERDICTS, ...GP, ...JUDGE_RUN }))))

    // Flatten back to one verdict per finding, in the original order. A missing 'n' — a batch that
    // answered four of its five — leaves that finding with no verdict, which the UNJUDGED branch
    // below then handles exactly as it handles a dead judge.
    const verdicts = new Map()
    batches.forEach((b, bi) => {
      const r = batchVerdicts[bi]
      if (blocked(r) || !Array.isArray(r.verdicts)) return
      for (const v of r.verdicts) {
        const f = b.items[Number(v.n) - 1]
        if (f) verdicts.set(f, v)
      }
    })

    // A judge that died is UNJUDGED — not dismissed. Silently dropping it would let a finding
    // disappear because an agent fell over, which is the failure mode every other track here is
    // built to refuse. It goes to the editor as an explicit "decide on the plan text alone".
    const accepted = [], rejected = [], unjudged = []
    review.findings.forEach((f) => {
      const v = verdicts.get(f)
      if (!v || typeof v.real !== 'boolean') unjudged.push(f)
      else if (v.real) accepted.push({ f, fix: v.fix || v.why, changesApproach: !!v.changesApproach })
      else rejected.push(`${f.what} — ${v.why}`)
    })
    planReview.dropped.push(...rejected)
    log(`run-task-implement: plan review pass ${pass} — ${review.findings.length} finding(s): ${accepted.length} real, ${rejected.length} dismissed${unjudged.length ? `, ${unjudged.length} UNJUDGED (judge died)` : ''}`)
    if (rejected.length) log(`  dismissed as not-real: ${rejected.join(' | ')}`)

    let applied = []
    // Derived from the judges, not reported by the editor. Deliberately NOT gated on Codex's
    // `major` tag: severity is Codex's guess about the FINDING, while this is the judge's read of
    // the FIX it just wrote, which is the better-informed of the two. Gating the informed signal
    // behind the less informed one would be backwards.
    const approachChanged = accepted.some((a) => a.changesApproach)
    if (accepted.length || unjudged.length) {
      const fix = await reliable(`plan-fix#${pass}`, 'Plan-review', () => agent(
        `Apply these accepted plan-review findings to ${planPath}. The judging is done — each fix
         below was already checked against the code, so your job is to fold it into the plan, not
         to re-litigate it.

         ACCEPTED — apply each one:
         ${accepted.map(({ f, fix }) => `- [${f.severity}][${f.rubric}] ${f.what}\n           FIX: ${fix}`).join('\n')}
         ${unjudged.length ? `\n         NOT JUDGED — the judge agent died before it could check these. Decide each on the
         plan text alone: apply it if the plan plainly has the problem, otherwise leave it and say
         so. Do not go read the whole codebase to settle them.
         ${unjudged.map((f) => `- [${f.severity}][${f.rubric}] ${f.what}`).join('\n')}` : ''}

         Edit ONLY the plan file. Fold each fix into the relevant section and, when one changes the
         APPROACH rather than a detail, add a short "Plan review changes" note so the decision stays
         auditable and can be carried into the PR body later.
         Record in 'applied' what actually landed, in the plan's own words.

         In the same edit, set the "status:" header at the top of the file to "implementing" — the
         plan leaves review here, and you are already writing this file.`,
        { label: `plan-fix#${pass}`, phase: 'Plan-review', schema: PLANFIX, ...GP, ...EDIT_RUN }))
      if (blocked(fix)) {
        log(`run-task-implement: plan-fix pass ${pass} BLOCKED — ${accepted.length} accepted${unjudged.length ? ` + ${unjudged.length} unjudged` : ''} finding(s) went unapplied; proceeding on the unrevised plan`)
        break
      }
      statusFlipped = true
      applied = fix.applied || []
      planReview.applied.push(...applied)
      // The judges accepted N findings; the editor reported applying M. They can legitimately
      // differ — a fix is sometimes already in the plan — but the gap should be visible rather
      // than inferred from two numbers nobody prints.
      if (applied.length !== accepted.length + unjudged.length) {
        log(`  note: ${accepted.length + unjudged.length} finding(s) went to the editor, ${applied.length} recorded as applied`)
      }
    }
    // The one shape worth calling out by name: a triage that kept nothing. It may well be
    // right — Codex does raise false positives — but it leaves the plan exactly as the planner
    // wrote it while still counting as "reviewed", so it should be visible rather than inferred.
    if (!accepted.length && rejected.length && !unjudged.length) {
      log(`run-task-implement: plan review pass ${pass} dismissed EVERY finding — the plan is unchanged by the review`)
    }
    // Two things buy the one re-review, and only one of them involves a revised plan:
    //   approachChanged — a judge says the fix it accepted sent the plan down a different route,
    //                     so the rewrite needs a look.
    //   dismissedAll    — the judges kept NOTHING. The plan is untouched and the review has in
    //                     effect been overruled by the party it was reviewing, with no reviewer
    //                     after it. That is the shape most worth one adjudication: it is exactly
    //                     as likely to mean "Codex raised five false positives" as "the triage
    //                     talked itself out of five real ones", and nothing downstream can tell
    //                     the two apart — the plan reads identically either way.
    const dismissedAll = !accepted.length && !unjudged.length && rejected.length > 0
    if ((!approachChanged && !dismissedAll) || pass === 2) break
    log(approachChanged
      ? 'run-task-implement: an accepted fix changed the approach — one re-review of the revised plan'
      : 'run-task-implement: the triage kept none of the findings — one re-review to adjudicate the dismissals')
    // Carry pass 1's findings AND what the triage did with them: the re-review checks the fixes
    // landed and the dismissals were fair, instead of re-deriving the critique from scratch.
    const again = await askCodex(2, { findings: review.findings, applied, dropped: rejected })
    if (blocked(again)) {
      log('run-task-implement: the plan re-review could not run — proceeding on the revised plan (it was already reviewed once)')
      break
    }
    review = again
  }

  // Only when no editor ran is the header still at "reviewing" and worth its own agent: Codex
  // raised nothing, the judges dismissed everything (so there was nothing to apply), or the editor
  // was blocked. The all-dismissed case is why this stays cheap — flipping one header line is the
  // entire remaining job there, and it belongs to a sonnet scribe rather than to an editor agent
  // spawned with an empty worklist.
  if (!statusFlipped) {
    await agent(`Set the "status:" header in ${planPath} to "implementing". Change nothing else.`,
      { label: 'plan-status', phase: 'Plan-review', schema: WROTE, ...GP, ...SCRIBE })
  }
}

// --- Phase 4: implement, test-first -----------------------------------------
phase('Implement')
// Collect the feature branch started back before Phase 2. Nothing below may run on base: the whole
// point of the halt is that the diff would land on `main` and the finish step would then try to
// merge `main` into itself. See the note at the dispatch site for the guards and for issue #90.
if (!branchP) {
  log(`run-task-implement: no usable feature-branch name — stopping rather than working on ${src.base}`)
  return { stopped: 'branch-name-missing', base: src.base, planPath }
}
const br = await branchP
if (blocked(br) || !br.onBranch) return { stopped: 'branch-failed', planPath }
const onBranch = String(br.onBranch).trim()
if (onBranch === src.base) {
  log(`run-task-implement: still on ${src.base} after 2 attempts — stopping. Implementing here would put the whole task on ${src.base} and leave the caller merging ${src.base} into itself.`)
  return { stopped: 'branch-not-created', base: src.base, wanted: wantBranch, detail: br.note || '', planPath }
}
if (onBranch !== wantBranch) log(`run-task-implement: on "${onBranch}", not the requested "${wantBranch}" — continuing (it is a feature branch, not ${src.base}), but the caller merges what the handoff names`)

// Route by area, and split only when the work genuinely spans both — one subagent per area, in
// parallel, each owning a disjoint slice. A subagent handed only "build your slice" will happily
// build the WRONG thing, so every brief carries the plan path, the slice boundary, the criteria,
// and the house rules.
const areas = []
if (src.hasBackend) areas.push({ label: 'backend', agentType: 'r:java-backend-developer', slice: 'the backend code (*.java / *.kt) and its tests' })
if (src.hasFrontend) areas.push({ label: 'frontend', agentType: 'r:htmx-thymeleaf-dev', slice: 'the templates, HTMX wiring, and frontend assets' })
if (!areas.length) areas.push({ label: 'general', agentType: 'general-purpose', slice: 'everything the plan calls for' })

// An implementer's self-check only has to prove its slice COMPILES and that ITS OWN tests pass.
// Phase 4 runs the certifying build the moment every implementer returns, so a full build here is
// a whole hidden test-suite run seconds before the pipeline runs the suite itself — and it is the
// most expensive place in either pipeline to duplicate, because the implementers are the priciest
// agents in the run (measured across 46 of them: 117 turns and 40 shell calls each, of which ~1.7
// are Maven invocations, times ~1.8 implementers per run). Naming the cheap command removes the
// duplication without removing any verification: the TDD tests they wrote still run here, which is
// what red-before-green evidence requires, and everything else runs in Phase 4 immediately after.
// `build-fix` below has carried this exact pair for a while; so does every fixer in /r:task-review.
// No `-o` (offline): on a fresh clone an uncached dependency would make it fail hard.
const selfCheckClause = src.buildTool === 'maven'
  ? 'Self-check by COMPILING, not by building: `mvn -q test-compile` — plus `mvn -q test -Dtest=<TheTestsYouWrote>` for the tests in your own slice.'
  : src.buildTool === 'gradle'
    ? 'Self-check by COMPILING, not by building: `./gradlew -q testClasses` — plus `./gradlew -q test --tests <TheTestsYouWrote>` for the tests in your own slice.'
    : 'Verify your change is syntactically sound before returning.'
const noFullBuild = src.buildTool === 'none' ? ''
  : ' Do NOT run the full build or the whole test suite: the pipeline builds and runs everything the moment you return, and that is what proves your slice is green.'

const implBrief = (a) => `Implement your slice of the plan at ${planPath}. READ THAT FILE FIRST — it holds
   the Context, the acceptance criteria, and the TDD test plan, so you build what the plan intends
   rather than your own reinterpretation.

   YOUR SLICE: ${a.slice}
   ${areas.length > 1 ? `ANOTHER subagent owns ${areas.filter((o) => o.label !== a.label).map((o) => o.slice).join(' and ')} — stay out of it; do not duplicate or collide.` : ''}
   INTENT: ${src.taskIntent}
   ACCEPTANCE CRITERIA your slice must satisfy:
   ${criteriaText}

   ${/* Gated on the section EXISTING, not on uiTouched: when the design phase died the plan has no
        such section, and pointing an implementer at one it cannot find is worse than saying
        nothing. On a resume it is unset here but present in the plan file, which the implementer
        reads first anyway. */
     designSection ? `- The plan opens with a "## UI/UX design" section that was decided before the plan and is
     BINDING for the visual work: the states, the layout, the reuse map and its "do NOT invent"
     list. Build what it says, reusing the components it points at. If you cannot, say so in
     blockedOn — do not substitute your own design.` : ''}
   - WRITE THE TESTS FIRST, per the plan's TDD test plan — load the \`write-tests\` skill
     (Skill tool) so they match house style — then implement until they pass.
   - RUN each new test BEFORE you write any production code, and record what you SAW in
     \`testEvidence\`, one line per test: "<test> — before: RED (<the assertion that failed>) —
     after: GREEN". Red-before-green is something you observe, not something the plan can promise:
     a plan that tags a test [RED] can simply be wrong about what the current code does.
     - A [RED] test that PASSES on unmodified code is a signal, not a formality. Work out why:
       usually the test is too weak to reach the bug (strengthen it until it genuinely fails), and
       sometimes the behaviour already exists (then re-tag it [GREEN] regression guard in your
       evidence and summary, and say so). Never leave it silently labelled RED.
     - A [GREEN] guard is expected to pass before AND after — record it as such. If one turns red
       after your change, you broke something the plan meant to protect.
   - Reuse the existing patterns and utilities the plan's Reuse map points at; do not invent new
     ones. Match the surrounding code: no new comments or Javadocs, @Builder on data classes with
     more than 3 fields.
   - No scope creep beyond the plan.
   - ${selfCheckClause}${noFullBuild}
   - Leave EVERYTHING UNCOMMITTED in the working tree. The whole task lands as ONE commit at the
     very end, after the review — so the reviewer reads the work before any of it is committed.
   - If the plan looks WRONG or blocked, stop and set blockedOn instead of silently deviating. A
     subagent quietly "improving" on the plan is how a run ends up contradicting its own intent.`

const impls = await parallel(areas.map((a) => () =>
  reliable(`implement:${a.label}`, 'Implement', () => agent(
    implBrief(a), { label: `implement:${a.label}`, phase: 'Implement', schema: IMPL, agentType: a.agentType, ...IMPL_RUN }))))

const stuck = impls.filter((r) => r && r.blockedOn).map((r) => r.blockedOn)
if (stuck.length) {
  log(`run-task-implement: an implementer says the plan is wrong or blocked — surfacing instead of working around it`)
  return { stopped: 'implement-blocked', detail: stuck.join(' | '), branch: onBranch, base: src.base, planPath }
}
if (impls.every((r) => blocked(r))) return { stopped: 'implement-blocked', branch: onBranch, base: src.base, planPath }

// --- Phase 5: drive the build green -----------------------------------------
// Bounded: "loop until green" is unbounded, and an unfixable build would grind forever.
phase('Build')
// 'n/a' — not `true` — when the project has no build tool this pipeline knows how to run.
// Initialising to true meant a non-JVM project handed the caller a handoff claiming a green
// build that never ran, and the PR body then reported it as passing. post-task-review already
// reports 'n/a' for the same case; the two now agree. Only ever true | false | 'n/a'.
let buildGreen = 'n/a'
if (src.buildTool !== 'none') {
  buildGreen = false
  const changed = impls.flatMap((r) => (r && r.filesChanged) || []).join(', ')
  const staleRule = `If any source file was DELETED or RENAMED since the last build, run \`${src.buildCmd}\` instead — a removed source can leave a stale .class behind that would let a broken build pass.`
  // A retry only has to re-check a surgical fix to code THIS run wrote, and the modules that code
  // lives in are known by then. On a multi-module reactor, rebuilding everything to re-run one
  // module's tests is most of what a retry costs. `-pl <mods> -am` still builds every upstream
  // dependency, so the fix compiles against the same graph; what it cannot see is a DOWNSTREAM
  // module the change broke — and that is caught by the review's own full build before anything
  // merges, which is the gate that actually matters. The i === 1 baseline is NEVER scoped: it is
  // the clean build this whole run certifies against, and the caller hands it on as `buildGreen`.
  const scopeRule = src.buildTool === 'maven'
    ? `Scope it: add \`-pl <the modules holding the changed files> -am\` so the reactor rebuilds those modules and their upstream dependencies rather than the whole project. If you cannot map the changed files to modules confidently, or the project is single-module, run it unscoped.`
    : `Scope it: run \`:<module>:build\` for the modules holding the changed files rather than the root build. If you cannot map the changed files to modules confidently, or the project is single-module, run it unscoped.`
  for (let i = 1; i <= 3; i++) {
    const b = await agent(
      `Run the build \`${i === 1 ? src.buildCmd : src.buildCmdFast}\` via the ${src.runnerAgent} agent.
       ${i === 1 ? "This is the run's one clean build — it establishes the baseline." : `${staleRule} ${scopeRule}`}
       green=true ONLY on a fully clean success (BUILD SUCCESS / BUILD SUCCESSFUL, exit 0, zero
       failures). The green bar is NEVER relaxed. If red, CLASSIFY every failure:
       - inScopeFailures: compile errors or test failures in code THIS run changed
         (changed files: ${changed || 'derive from git diff'}). Ours to fix.
       - preExistingFailures: failures UNRELATED to this work — a test or class the change never
         touched, the kind that already fails on ${src.base}. List the failing class names.
         These are NEVER ours to fix and never a reason to weaken a test.
       Put a short combined log in 'failures'.`,
      { label: `build#${i}`, phase: 'Build', schema: BUILD, agentType: src.runnerAgent, ...BUILD_RUN })
    if (b && b.green) { buildGreen = true; break }
    const inScope = b && b.inScopeFailures && b.inScopeFailures.trim()
    if (!inScope) {
      log('run-task-implement: build RED from PRE-EXISTING failures only — not fixing them, surfacing to the user')
      return { stopped: 'build-red-preexisting', preExisting: (b && b.preExistingFailures) || (b && b.failures) || 'unknown',
               branch: onBranch, base: src.base, planPath }
    }
    if (i < 3) await agent(
      `The build is red from failures THIS change caused. Fix ONLY these, surgically, and do NOT
       touch any pre-existing or out-of-scope test or class to force a pass:
       ${inScope}
       Intent (do not undo it): ${src.taskIntent}
       Self-check by COMPILING, not by building: \`${src.buildTool === 'maven' ? 'mvn -q test-compile' : './gradlew -q testClasses'}\` plus the one
       test you touched. Do not run the full suite — this loop rebuilds and re-runs it the moment
       you return, and that is what proves the failures are gone.`,
      // IMPL_RUN for the same reason the implementers carry it: this is the same domain agent,
      // editing the code they just wrote. Left unpinned it took its depth from the entry point.
      { label: `build-fix#${i}`, phase: 'Build', agentType: areas[0].agentType, ...IMPL_RUN })
  }
  if (!buildGreen) {
    log('run-task-implement: in-scope build still RED after 3 attempts — stopping and surfacing to the user')
    return { stopped: 'build-red', branch: onBranch, base: src.base, planPath }
  }
}

// --- Handoff -----------------------------------------------------------------
// Steps 5 (post-task-review) and 6 (finish) belong to the CALLER, which runs them in its own
// main thread — post-task-review's canonical engine is a Workflow, and a Workflow call nested
// inside this script's agents would not be reachable.
log(`run-task-implement: done — green build on ${onBranch}, diff left uncommitted for review`)

// --- Stats sink: the implement half's row (BEST EFFORT) ----------------------
// The review's sink records which track found what; this records the OTHER unmeasured thing —
// how tiers get chosen and whether the plan review earns its slot. `profileEscalated` says how
// often the description-based guess was wrong, and applied/dropped says whether Codex's plan
// findings ever survive triage. Same rules as the review sink: it can never fail the run, and it
// carries counts, not text (the one free-text field, profileReason, is what makes a tier
// auditable later, and record-run.py drops it first if the row runs long).
const statsRow = {
  kind: 'implement',
  source: src.kind,
  profile,
  profileForced: !!forcedProfile,
  profileEscalated,
  profileReason: (src.profileReason || '').slice(0, 200),
  explorers: aspects.length || 1,
  uiTouched,
  // The two things worth measuring about the new gate, for the same reason profileEscalated is
  // recorded: uiEscalated says how often the description-based guess was wrong, and designRan says
  // whether the phase it buys actually produced a document.
  uiEscalated,
  // The gap between these two is the measurement the design gate exists for: uiTouched-without-
  // uiVisualChange is the run that would have spent an Opus agent writing "nothing changes visually".
  uiVisualChange,
  designRan: !!designSection,
  buildGreen,
  planReviewRan: !!(planReview && planReview.ran),
  planApplied: (planReview && planReview.applied || []).length,
  planDropped: (planReview && planReview.dropped || []).length,
}
await agent(
  `Record one line of run statistics. This is bookkeeping — if anything goes wrong, say so and
   return; do NOT retry and do NOT treat it as a failure of the run. Run exactly this from the
   repo root, then return the script's stderr line verbatim:

   python3 "${PACK}/skills/task-review/scripts/record-run.py" <<'RTI_STATS_JSON'
${JSON.stringify(statsRow)}
RTI_STATS_JSON

   The script always exits 0 by design; its stderr says whether the row was recorded.`,
  { label: 'stats', phase: 'Build', ...GP, ...SINK })

return {
  branch: onBranch,
  base: src.base,
  profile,
  profileReason: src.profileReason || '',
  // Forced => the user's word, and it travels to the review. Classified => a guess made before
  // any code existed, which post-task-review can beat by classifying from the actual diff.
  profileForced: !!forcedProfile,
  profileEscalated,
  // Settled: Phase 0's guess, which the explorers can turn ON once they have read the code.
  uiTouched,
  // At most two sentences of stated design intent, from the design phase. '' when the change has
  // no UI, when the design agent died, or on a resume (the section is already in the plan file).
  // The caller appends it to the intent it hands /r:task-review, which is what gets the finished
  // pages judged against a stated bar instead of generic taste.
  designIntent,
  // Why designIntent can be '' on a UI change: this says whether a visual decision was even wanted.
  uiVisualChange,
  taskIntent: src.taskIntent,
  planPath,
  criteria: src.criteria || [],
  buildGreen,
  // What the plan review actually decided. `ran:false` means the tier was below full (or this was a
  // resume), NOT that Codex came back clean — a blocked Codex stops the run outright above.
  // The caller carries `applied` into the PR body; `dropped` is there so a dismissal can be
  // questioned instead of disappearing.
  planReview,
  implemented: impls.filter((r) => r && r.summary).map((r) => r.summary),
  // What the implementers OBSERVED when they ran each test before/after the change — the evidence
  // behind "test-first", rather than the plan's claim about it. Carry it into the PR body: a test
  // that was green before the change is a regression guard, not proof the fix works.
  testEvidence: impls.flatMap((r) => (r && r.testEvidence) || []),
}
