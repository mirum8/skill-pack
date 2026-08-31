// =============================================================================
// run-task (implement half) — PROTOTYPE Workflow (deterministic orchestration)
//
// This encodes /r:task-run Steps 0 – 4 as a hardcoded subagent graph: resolve the
// task source, map the code, design the UI when the change touches one, plan it on
// Opus at high, have Codex challenge the plan, implement it test-first through domain
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
//                 one change fixes) | "todo.md / Phase 3" | "issues.md / Login 500s"
//                 (a list item, several joined by " | ") | free text),
//         profile?: "light"|"standard"|"full" (omitted => classified here),
//         base?: string (omitted => current branch) }
//   Multiple issue refs in `source` ("#42 #61") are one GROUPED task: every issue
//   is fetched, their acceptance criteria merge into criteria[], and the branch
//   is issues-42-61-<slug>. The caller (e.g. /r:issues-fix) closes all of them.
//   A file-backed backlog groups the same way — "issues.md / Login 500s | Signup
//   rejects unicode" is one task over two items of one list, branch items-<slug>.
//   Either way the caller passes REFERENCES and this script re-reads the source
//   for the criteria; a body pasted in as free text arrives with none, which is
//   the whole difference between the "item" and "text" kinds below.
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
//       or { stopped: <reason>, ... } when the run cannot honestly continue. Any stop that happens
//   AFTER the plan review carries `planReview` too, so an interrupted run can still say whether
//   the approach was challenged. `branch` is always a
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
    { title: 'Plan',        detail: 'Opus planner, written to .task-plans/', model: 'opus' },
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
    kind: { type: 'string', enum: ['issue', 'todo', 'item', 'text'] },
    slug: { type: 'string' },
    branch: { type: 'string' },          // issue-<n>-<slug> | issues-<n1>-<n2>-<slug> | phase-<slug> | item(s)-<slug> | task-<slug>
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
          // An ENUM, not a free string. Left open, the reviewer writes composites — `coverage /
          // test-adequacy`, `risk / test-adequacy`, `simplicity (YAGNI) / project rules` — and each
          // spelling lands in the stats store as a track of its own, so one rubric's findings sit
          // in three rows that nothing can add back together. That defeats the reason the rows are
          // recorded at all (see the sink below: WHICH rubric keeps raising findings nobody buys),
          // and it splits the judge batching, which groups by this value precisely so the code
          // behind a group is read once. An enum is enforced at the tool-call layer, so a composite
          // comes back as a retry rather than as a row. `ui-design` is only reachable when the plan
          // carries a design section, i.e. a UI change.
          rubric: { type: 'string',
                    enum: ['coverage', 'grounding', 'test-adequacy', 'simplicity', 'risk',
                           'ui-design'] },
          what: { type: 'string' },
          // The one line this finding is about, as file:LINE — in the code, or in the plan. It is
          // what routes the finding: a well-formed citation on a high-precision rubric sends it to
          // the cheap citation lane, where the check IS re-reading that line. Optional on purpose,
          // and empty is a legitimate answer — some findings are about a whole section or an
          // absence, and a reviewer pressed for a citation it does not have invents one. An empty
          // or malformed `where` routes to a full judge, so the failure direction is depth, never
          // a lookup against a line that does not exist.
          where: { type: 'string' },
        },
      },
    },
    note: { type: 'string' },
  },
}
// One judge, a BATCH of findings that share a rubric — with one verdict returned per finding.
//
// Two rounds of this. Judge findings in batches, never with ONE agent over all of them: a single
// agent at the inherited tier that judges every finding and rewrites the plan measures 11 minutes
// and 122k tokens on a real run, most of it re-deriving a code map the explorers already produced. Splitting it one-agent-per-finding fixed that, and then became
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
          // The citation lane's escape hatch: this finding needs a judge, not a lookup. Set when
          // the reference cannot be resolved, or when the line says something neither the plan nor
          // the finding claims — the two cases where a cheap reader answering anyway is worse than
          // no answer. `real` is then ignored and the finding goes to a judge batch in the same
          // pass. Judges never set it: they ARE the escalation.
          escalate: { type: 'boolean' },
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
const TREE = {
  type: 'object', additionalProperties: false,
  required: ['filesPresent'],
  properties: { filesPresent: { type: 'array', items: { type: 'string' } } },
}
const BUILD = {
  type: 'object', additionalProperties: false,
  required: ['green'],
  properties: {
    green: { type: 'boolean' },              // true ONLY on a fully clean build
    failures: { type: 'string' },
    // The BRANCH is this boolean, never the prose beside it. Emptiness is not a usable signal for
    // "nothing in scope failed": an agent asked to classify failures answers "None." as readily as
    // it answers "", and a non-empty string that MEANS none inverts the test. That is what
    // wf_b1da7de4-36a did — `inScopeFailures: "None. All modules/tests related to the change set
    // compiled and passed."` read as in-scope work, so a red-on-base build dispatched three fixers
    // at a failure nobody owned and then stopped as `build-red`, which tells the caller the change
    // broke the build. Matching English words instead would just move the guess: "No in-scope
    // failures were found" contains one, and so does half of what a runner writes.
    inScopeGreen: { type: 'boolean' },       // did everything THIS run changed build and pass?
    inScopeFailures: { type: 'string' },     // in code THIS run changed -> ours to fix
    preExistingFailures: { type: 'string' }, // already red on base -> NEVER ours to fix
  },
}
// What lib/read-config.py resolved for the implementers. `notes` is the load-bearing field: it
// carries every substitution the reader made — a key outside its enum, a typo nobody reads, a
// `provider: codex` on a machine with no Codex plugin — and this script logs every line of it.
// Without that a typo'd setting is indistinguishable from a working one, which is exactly the
// failure a config file invites.
const CONFIG = {
  type: 'object', additionalProperties: false,
  required: ['provider', 'model', 'effort'],
  properties: {
    step: { type: 'string' },
    provider: { type: 'string', enum: ['claude', 'codex'] },
    model: { type: 'string' },
    effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
    // The Claude subagent that drives the Codex CLI under `provider: codex`. Not required: a row
    // that predates these keys, or an agent that drops them, falls back to IMPL_CODEX_RUN rather
    // than dispatching a wrapper with no model and no depth.
    wrapperModel: { type: 'string' },
    wrapperEffort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
    sources: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
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
// Appended to the prompts of steps that dispatch a BUILT-IN agent (Explore, general-purpose, Plan).
// The bundled agents under agents/ carry this rule in their own definition; the built-ins have no
// file to carry it, so their only channel is the dispatch prompt. Cost in a subagent is
// turns × context — every turn re-reads everything accumulated so far, a median of ~77k tokens —
// so a call that could have ridden along with the previous one pays a full re-read to return one
// grep. `explore` is where this bites hardest: it is the pack's most-dispatched step, and 22% of
// its shell calls return under 200 characters.
const BATCH_CLAUSE = `
     Batch independent tool calls: when the next calls do not depend on each other's results —
     several greps, several reads, a \`git diff\` beside a \`git status\` — issue them in ONE
     block rather than one per turn. Calls that genuinely need a previous result stay serial.`
// The background-collect protocol, in ONE place because it is one protocol: the plan review, the
// implementers and the build fixer all drive the Codex CLI and all outlive the ~600s Bash cap.
//
// It is a single BLOCKING call rather than a poll per turn, for two reasons that point the same
// way. Cost: a subagent pays turns x context, every turn re-reading everything accumulated so far,
// so a 20-minute wait spent one `ps` at a time pays a full re-read per check and buys nothing —
// read off two implementers on one run, 14 extra minutes of waiting cost ~40k tokens. Correctness:
// every poll is another moment at which the model gets to decide the run looks stuck, and deciding
// that over a live PID is precisely the false block the preambles below spend paragraphs
// forbidding. A shell loop has no opinion. The bound sits INSIDE the loop and below the cap on
// purpose: a call the harness kills comes back as a tool ERROR, and a tool error is exactly what
// talks a wrapper into halting over work Codex had nearly finished.
const collect = (pad) => `Collect it by WAITING ON THE WORKER PID IN ONE BASH CALL rather than
${pad}checking it once per turn:
${pad}  for i in $(seq 1 57); do ps -p <pid> >/dev/null 2>&1 || break; sleep 10; done
${pad}dispatched with the Bash tool's own timeout set to 590000. It returns the moment the PID is
${pad}gone; if it returns while the PID is still alive, run it again — that is the wait continuing,
${pad}never a signal that anything is wrong. Then read the job record's "rendered" field under
${pad}~/.claude/plugins/data/codex-openai-codex/state/*/jobs/*.json. Never wait on output-size
${pad}stability — the log goes quiet for minutes mid-reasoning.`
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
// inherited depth though — it buys nothing on what is otherwise transcription.
const SOURCE_RUN = { effort: 'medium' }
// The Codex agent shells out and collects the run; Codex does the reviewing. Its own reasoning
// adds nothing to the critique, so the model is PINNED rather than inherited: unnamed, the tier is
// whatever the caller happens to be running, which is not a tier anyone chose — 119 dispatches and
// 112M tokens sit under this step, mostly opus, for an agent that reviews nothing.
//
// Haiku, the same as every other Codex wrapper in the pack: one job, one tier — shell out, wait,
// hand back what the CLI produced. THE RISK THAT IS SPECIFIC TO THIS ONE, and the reason to read
// the store rather than argue from here: the implement and fix wrappers have a working tree to
// check their answer against, where this one has none. The critique IS the artifact, and the job
// is marshalling a long free-text report into REVIEW without dropping or merging findings —
// which nothing downstream catches, since there is no second reviewer and the run stops outright
// if Codex could not run. It shows up as findings-per-plan-review falling while Codex still
// reports fine, never as an error. `medium` is not negotiable alongside it: this agent owns the
// background-collection protocol that produced false blocks on #82/#55.
const CODEX_RUN = { model: 'haiku', effort: 'medium' }
// Exploration is read-and-map work — extract files/conventions/tests, not judgement — so it
// runs on a cheaper/faster tier than the inherited main-loop model. medium (not low) because
// the one consequential call an explorer makes is riskFlags, which gates the light->FULL
// escalation below; medium leaves it enough budget to spot auth/money/migration/concurrency.
//
// This and the two constants below are the FALLBACK for `steps.plan` — what the run uses when the
// config agent could not be reached at all. File and fallback agree, so a run that never read the
// config behaves like one that did rather than quietly changing tiers.
const EXPLORE_RUN = { model: 'sonnet', effort: 'medium' }
// The plan is the highest-leverage artifact in the run, so the standard/full planner runs at the
// top tier — the inverse of the explorers, which run a cheaper model still. agent() exposes a real
// effort lever here (the raw Agent tool does not), so depth is pinned rather than inherited from
// whatever the caller was running. `steps.plan` in the config decides it; this is the fallback.
//
// Planning is not the cheap half of this pipeline — measured per run that reaches a plan, the
// judges cost 11.0M tokens, this planner 10.3M, the explorers 7.5M and the plan-fix editor 3.9M,
// ~39M against the implementers' 33.1M, and ~97% of it is cache reads rather than output. So when
// a run is too expensive these are the values to move, and `plan depth` in lib/skill-stats.py is
// what says whether moving them cost anything: it buckets runs by the recorded row and prints the
// paired review's correctness fixes beside it, because a cheaper planner that pushes work into
// fix-correctness has moved cost rather than saved it.
const PLAN_RUN = { model: 'opus', effort: 'high' }
// The LIGHT-tier planner writes a BRIEF for a change that, by the tier's own definition, cannot
// alter behavior — and that contract, not the depth, is what separates it from PLAN_RUN: the two
// share a model and a tier, and the split lives in the prompt. Its own constant exists so the brief can be
// costed separately from the full plan. The tier is not load-bearing on its own either: the
// explorers' risk flags escalate light->FULL the moment they see auth, money, migrations or
// concurrency, so a misclassified task never actually gets planned here.
const PLAN_LIGHT_RUN = { model: 'opus', effort: 'high' }
// The UI/UX design agent. Opus because this is judgement — what the screen should be, which of the
// app's existing components it is built from, which states it owes the user — and a cheaper model
// reliably produces the generic layout `frontend-design` exists to rule out. It is pinned, not
// inherited: the surface is one screen area against a design system that already exists, not the
// whole change, and this document is reviewed downstream (by Codex at full tier, and by the
// review's visual half against the rendered pages) rather than being the last word.
const DESIGN_RUN = { model: 'opus', effort: 'high' }
// The implementers' provider, model and depth come from `steps.implement` in the config — never
// inherited from the session. Unpinned, the same workflow writes code at `high` when entered
// through /r:task-run (whose frontmatter sets it) and at whatever the caller happened to be running
// when the script is invoked directly, which SKILL.md explicitly invites callers like /r:issues-fix
// to do. One resolved row, whatever the entry — and it is resolved INSIDE this script rather than
// in SKILL.md precisely because those callers come in by scriptPath and would skip a markdown read.
//
// The shipped default is this row exactly — claude/opus/medium — so the file and this fallback
// agree, and a run that could not reach the config behaves like one that read it rather than
// quietly changing tiers. The whole question of depth is still a claim UNDER MEASUREMENT:
// these agents follow a plan built at opus/high, challenged by Codex and re-read afterwards by
// /r:task-review, so the argument is that the judgement left to them is bounded. What the plan
// cannot do for them is real too — observing red-before-green, deciding a [RED] test that passes
// is a weak test rather than a formality, and setting blockedOn when the plan is wrong — so the
// question is empirical. `implement depth` in lib/skill-stats.py answers it: it buckets every
// implement run by the effort mined off its items and prints what the review found afterwards
// beside it. The baseline it is measured against is `high`: 2.11 correctness and 3.48 readability
// fixes per paired review, at 20.9M tokens and 1022s per implementer agent — the pack's most
// expensive step. READ THAT TABLE before moving the default either way; a cheaper implementer that
// pushes work into fix-correctness and end-verify-fix has moved cost rather than saved it. The
// table cannot compare PROVIDERS yet, which is why the resolved row is written into the stats
// payload: after a handful of codex runs it can bucket by provider instead of guessing.
//
// These two values are the FALLBACK: what the run uses when the config agent could not be reached
// at all. lib/read-config.py holds the same row for the case where it CAN be reached but the file
// cannot, including a `provider: codex` on a machine with no Codex plugin — that lands here rather
// than dispatching an agent that dies. The model is named rather than inherited because the two
// specialized Claude types already declare opus, so this only lifts the `general` fallback to
// match them.
const IMPL_RUN = { model: 'opus', effort: 'medium' }
// The WRAPPER under `provider: codex` — the Claude subagent that shells out to the Codex CLI, not
// the writer. `steps.implement.wrapperModel`/`wrapperEffort` decide it; this is the fallback.
// Separate from CODEX_RUN, which the plan reviewer carries, so tuning one cannot re-tier the other
// even while the two agree: that one marshals a free-text critique into a schema with no working
// tree to check it against, where this one passes a brief through verbatim and then reads
// `git status --porcelain` and `git diff` to fill filesChanged, testEvidence and blockedOn. The
// evidence here is the tree, not the agent's reading — which is why the cheap tier has less room
// to be wrong on this step than on that one.
//
// HAIKU IS AN EXPERIMENT UNDER MEASUREMENT, not a settled tier, and the failure it invites is
// specific: this agent owns the background-collect protocol that produced false blocks on #82/#55,
// and one that gives up early does not save 20s — it halts the run over work Codex actually
// finished. wf_9c4f981b-d68 did exactly that: every slice set blockedOn while both codex-companion
// PIDs were still alive, and one of them owned the plan's whole backend half. What makes the
// cheaper tier defensible is that `collect()` above no longer leaves that judgement to the model —
// the wait is one blocking shell loop with no opinion about whether a live PID looks stuck, so the
// decision the tier used to have to get right is not a decision any more. `medium` stays: depth is
// not what the collect needs, but the tree read at the end is a real one.
//
// Read it off the store rather than defending it from here: the wrapper's tier is the `model` on
// the mined `implement` items, and a regression shows up as blocked slices over a non-empty tree.
const IMPL_CODEX_RUN = { model: 'haiku', effort: 'medium' }
// Triage is SPLIT, not one agent, and the two halves want different depths. Collapsed into one
// agent at the inherited tier that judges every finding and rewrites the plan, it measures 11
// minutes and 122k tokens on a real run, most of it re-deriving a code map the explorers already
// produced.
//
// A judge answers ONE narrow question — does this finding hold against the real code — with the
// briefs already in hand, so `high` is depth where it counts without the context that makes the
// collapsed step slow. Nor is it the last word: a dismissal is re-read by Codex in pass 2 (the
// dismissedAll branch below) and the diff is re-read by /r:task-review, which covers what a
// "no reviewer after it" argument for a deeper tier would be defending against.
//
// `steps.plan.judgeModel`/`judgeEffort` decide it; this is the fallback. The standing rule the
// config file states and does not enforce: the judges must never run DEEPER than the planner whose
// plan they check. Depth spent here is depth taken from the artifact everything downstream is
// built on.
//
// The model is NAMED rather than inherited, and named as what the judges have actually been
// running: 223 judge items in the store, every one of them claude-opus-5/high. A config row has to
// carry a concrete value — it cannot express "whatever the caller was" — so the shipped one is the
// measured status quo, and dropping the judges to sonnet becomes a change someone makes and reads
// off `plan depth` rather than one this row makes for them.
const JUDGE_RUN = { model: 'opus', effort: 'high' }
// The citation lane. Most plan findings never reach a judge: a finding from a rubric measured at
// ~91% precision (grounding, test-adequacy, ui-design) that names a file:LINE needs a LOOKUP, not
// a judgement — does that line say what the finding claims — and a lookup does not want a judge's
// tier. Measured over 435 judged findings on 28 runs, those three rubrics are 252 of them, and the
// judges cost 11.0M tokens a run to remove a 12% false-positive rate overall.
//
// haiku/low is the whole point and also the whole risk, which is why the lane fails CLOSED in
// three directions: a finding with no well-formed citation never enters it, an agent that cannot
// resolve the reference escalates to a real judge, and a dead one leaves its findings UNJUDGED
// exactly as a dead judge does. Silence must never read as agreement.
const CITATION_RUN = { model: 'haiku', effort: 'low' }
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
// loudly". Neither half holds: it does not expand, and `python3 /lib/record-run.py` is a plain
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
      - List item(s) — a markdown/text file path, " / ", then one or more ITEM LOCATORS
        joined by " | " ("issues.md / Login 500s on '+' | Signup rejects unicode"). A locator is
        a short unique PREFIX of the item's own text, not its body. Read the file and find each
        item: a checklist/bullet line ("- [ ] …", "- …", "1. …") plus any lines indented under it,
        or a heading plus the prose beneath it. kind="item".
        * One locator -> branch="item-<short-slug>".
        * Several     -> branch="items-<short-slug>", the slug naming the shared fix. Several
          locators are ONE GROUPED task, exactly as several issue refs are.
        Do NOT tick, edit or reorder anything in that file — the caller marks items done after
        its review passes and its merge lands. If a locator matches no item or matches more than
        one, set blockedReason rather than guessing: the wrong item fixed is worse than a stop.
        TODO PHASE vs LIST ITEM, since both are "<markdown path> / <something>": it is a PHASE
        when what the locator names is a section CONTAINING a checklist (the whole block is the
        task); it is an ITEM when what it names is a single line of one (that line is the task).
        Decide by what you actually find in the file, never by the file's name.
      - Free text: the argument IS the task; there is no source to fetch. kind="text",
        branch="task-<slug>". If the input is contentless or genuinely ambiguous (no file, no
        issue, no described work), set blockedReason — there is no task to run.
   2. ACCEPTANCE CRITERIA -> criteria[]. For an issue, a phase or a list item, take the
      checklist/bullets that describe "done" — for an item that is its own text plus whatever is
      nested under it. For a GROUP (several issue refs, or several locators), merge every member's
      criteria into the one criteria[], each prefixed with its identity ("#42: …", "Login 500s: …")
      so the planner and implementers can tell which member each requirement belongs to — the fix
      is done only when EVERY grouped member's criteria are met. For free text there are none
      written: leave criteria empty — deriving them is the planner's job — but still write
      taskIntent. This is the ONLY difference that matters between "item" and "text": an item has
      written criteria to lift, so never downgrade one to free text.
   3. taskIntent: 1-3 sentences on what this task sets out to do. It is threaded into every
      downstream implementer and (via the handoff) into the review, so a fixer cannot "fix"
      something the task did on purpose. Write it even when criteria are empty. For a group, state
      the shared change and name the issues or items it resolves.
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
      the security hunter, doc-drift checking, static analysis, build+tests and a Codex read of the
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
      Also set hasBackend (*.java / *.kt files change) and hasFrontend (Thymeleaf templates, CSS
      or frontend JS change) for implementer routing. These are about THOSE FILE KINDS, not about
      whether the project has a backend or a user interface: a Go, Rust or Node project answers
      false to both, and a terminal UI is not a frontend. They are read only when step 6 finds a
      JVM build tool; elsewhere the routing ignores them.
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

// --- the implementers' settings ----------------------------------------------
// Read here rather than in SKILL.md because /r:issues-fix and /r:plan-run invoke this script by
// scriptPath, and a config read in the markdown would silently skip them. Workflow scripts have no
// filesystem access, so the file is read the way every other file in this pipeline is: an agent
// runs the reader and hands back its JSON. The reader itself never fails — it substitutes and says
// what it substituted — so the only thing that reaches this `null` branch is a dead agent.
//
// Two rows, two agents, one wave. `implement` decides who writes the code; `plan` decides the
// planner, the explorers and the judges that come before it. Separate agents rather than one
// reading twice, because the CONFIG schema describes ONE resolved row — a combined shape would
// have to be nullable in halves, and a half that came back empty would be indistinguishable from
// one that resolved to the built-in values.
const readCfg = (step) => agent(
  `Resolve the pack's ${step} settings. Run exactly this from the repo root and return the
   object it prints on stdout, VERBATIM — do not re-derive, re-order or "correct" any field:

     python3 "${PACK}/lib/read-config.py" --step ${step} --pack "${PACK}"

   The script always exits 0 by design; a value it could not read comes back as the built-in
   default with a line in \`notes\` saying so. Return \`notes\` even when it is empty.`,
  { label: step === 'implement' ? 'config' : `config-${step}`, phase: 'Source', schema: CONFIG, ...GP, ...SINK })
const [implCfg, planCfg] = await parallel([
  () => readCfg('implement').catch(() => null),
  () => readCfg('plan').catch(() => null),
])

for (const note of (implCfg && implCfg.notes) || []) log(`run-task-implement: config — ${note}`)
for (const note of (planCfg && planCfg.notes) || []) log(`run-task-implement: config — ${note}`)
if (!implCfg) log(`run-task-implement: the config could not be read — implementers fall back to ${IMPL_RUN.model}/${IMPL_RUN.effort} on claude`)
const implProvider = (implCfg && implCfg.provider) || 'claude'
// Under `claude` these are the writer's own model and depth. Under `codex` the writer's pair goes
// to the CLI instead (see codexPreamble) and this dispatches the WRAPPER, which is configured
// apart from it — the two do different work, and a cheap wrapper fails by halting rather than by
// writing worse code.
const implRun = !implCfg ? { ...IMPL_RUN }
  : implProvider === 'codex'
    ? { model: implCfg.wrapperModel || IMPL_CODEX_RUN.model, effort: implCfg.wrapperEffort || IMPL_CODEX_RUN.effort }
    : { model: implCfg.model, effort: implCfg.effort }
log(`run-task-implement: implementers — ${implCfg ? (implProvider === 'codex'
      ? `codex ${implCfg.model} / ${implCfg.effort}, driven by ${implRun.model} / ${implRun.effort}`
      : `claude ${implCfg.model} / ${implCfg.effort}`)
    : `claude ${IMPL_RUN.model} / ${IMPL_RUN.effort}`}${(implCfg && implCfg.sources || []).length ? ` (from ${implCfg.sources.join(', ')})` : ' (built-in)'}`)

// --- the planning half's settings --------------------------------------------
// The planner, its explorers and the judges that triage the plan review, resolved from the same
// file. Each falls back to its own constant, so a run that could not read the config runs the same
// tiers as one that read the shipped defaults — the file and the fallbacks say the same thing.
// The three are deliberately independent: raising the planner must not drag the judges up with it.
const pick = (a, b, key) => (planCfg && planCfg[a]) || b[key]
const planRun = { model: pick('model', PLAN_RUN, 'model'), effort: pick('effort', PLAN_RUN, 'effort') }
const exploreRun = { model: pick('exploreModel', EXPLORE_RUN, 'model'), effort: pick('exploreEffort', EXPLORE_RUN, 'effort') }
const judgeRun = { model: pick('judgeModel', JUDGE_RUN, 'model'), effort: pick('judgeEffort', JUDGE_RUN, 'effort') }
if (!planCfg) log(`run-task-implement: the plan config could not be read — planning falls back to planner ${PLAN_RUN.model}/${PLAN_RUN.effort}, explorers ${EXPLORE_RUN.model}/${EXPLORE_RUN.effort}, judges ${JUDGE_RUN.model}/${JUDGE_RUN.effort}`)
log(`run-task-implement: planning — planner ${planRun.model}/${planRun.effort}, explorers ${exploreRun.model}/${exploreRun.effort}, judges ${judgeRun.model}/${judgeRun.effort}${(planCfg && planCfg.sources || []).length ? ` (from ${planCfg.sources.join(', ')})` : ' (built-in)'}`)

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

     KEEP IT UNDER 200 LINES, and cite \`path:LINE\` with a sentence on what the code there does
     rather than pasting the code itself. This brief is carried whole into the Opus planner and,
     on a UI task, into the design agent as well — so every line of padding is paid twice at the
     most expensive tier in the run, and it competes for the planner's attention with the files it
     actually has to reason about. A slice that genuinely cannot be mapped in 200 lines is a sign
     the slice is too broad: say so at the top and map the part that matters most to this task.

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
     the change stays clear of all five surfaces above.${BATCH_CLAUSE}`,
    // The label carries the slice INDEX, not just its first 24 characters. Three explorers on one
    // task routinely share an opening phrase ("Map the calculator…"), and when they do, three
    // identical rows in the progress tree make the one that died unidentifiable.
    { label: `explore#${i + 1}:${aspect.slice(0, 24)}`, phase: 'Explore', agentType: 'Explore', ...exploreRun })))))

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
// the security hunter, static analysis, build + tests and the Codex end-verify.
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
// overlaps with is the plan scribe writing `.task-plans/<slug>.md`,
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
const branchPrefix = src.kind === 'todo' ? 'phase' : src.kind === 'text' ? 'task' : src.kind === 'item' ? 'item' : 'issue'
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
// The design agent is told to stay in its lane — what the user sees, never how the code is
// structured — so a brief that maps a service layer or a repository is context it has no use for.
// It arrives at Opus rates and competes for attention with the templates and stylesheets it does
// have to open. Hand it the slices whose explorer actually named frontend files.
//
// The fallback to every brief is not defensive padding: `uiVisualChange` can be decided in Phase 0
// from the task description alone, before any explorer has voted, and a design agent with no code
// map at all invents against a system it never read — which is the exact failure this phase exists
// to prevent, and strictly worse than carrying one slice too many.
const uiBriefs = liveBriefs.filter((b) => (b.uiFiles || []).some((f) => FRONTEND_PATH.test(f)))
const designBriefText = uiBriefs.length
  ? uiBriefs.map((b, i) => `--- brief ${i + 1} ---\n${b.brief}`).join('\n\n')
  : briefText
if (designWanted) {
  phase('Design')
  if (uiBriefs.length && uiBriefs.length < liveBriefs.length) {
    log(`run-task-implement: the design phase reads ${uiBriefs.length} of ${liveBriefs.length} brief(s) — the slices that named frontend files`)
  }
  const design = await reliable('ui-design', 'Design', async () => parseDesign(await agent(
    `Decide the UI/UX for this task, before it is planned or built. You are read-only: return the
     design section, do not write a file and do not edit anything.

     TASK (${src.kind}): ${rawSource}
     INTENT: ${src.taskIntent}
     ACCEPTANCE CRITERIA:
     ${criteriaText}

     The codebase has already been mapped for you. Design against THESE briefs, and re-open the
     templates, stylesheets and components they cite rather than inferring what they contain:
     ${designBriefText}
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

// --- What every exit reports -------------------------------------------------
// Declared above Phase 2 so that EVERY stop from the planner onwards can carry it and record it.
// Phase 3 fills it in; a stop that happens before then reports `ran: false`, which is a claim the
// caller can act on ("the tier bought no plan review") where an absent block is one it has to
// guess about. The plan review runs before the branch, the implementers and the build, so a run
// that stops in any of those WAS reviewed, and a stop that omits the block reads as "Codex never
// challenged this plan" — a different and much worse claim.
const planReview = { ran: false, reason: 'stopped before the plan review', passes: 0, raised: 0, applied: [], dropped: [], judged: [] }

// The branch, as two facts rather than one. `branchOn` is what the repo was really on the last
// time anything asked git; `branchDrifted` says the answer changed under the run. They are plain
// `let`s declared HERE, above the sink, rather than read off the Phase 4 const below: recordRun is
// called by every stop above that line, and a const in its temporal dead zone would throw inside
// the try/catch that exists to keep bookkeeping from costing a run its result — silently losing
// the whole row, which is the one thing that recorder may not do.
let branchOn = ''
let branchDrifted = false

// One row per run, recorded whether the run FINISHES or STOPS. A stop is the outcome most worth
// measuring — it spent explorers, a planner and (at full tier) a Codex plan review and produced no
// diff — and while the sink sat below the handoff every one of them was invisible: one Go project
// showed 7 implement rows against 10 real runs, and the three missing ones were exactly the
// pathology worth finding. `stopped` is '' on the happy path, so the store can tell a halt from a
// completed run instead of inferring it from a missing buildGreen.
//
// BEST EFFORT, in both directions and both load-bearing: it can never fail the run (the agent is
// caught, and so is anything thrown while building the row), and it is never retried. Bookkeeping
// is not worth losing a green run — or a stop's reason — over.
const recordRun = async ({ stopped = '', buildGreen = 'n/a' } = {}) => {
  try {
    const statsRow = {
      kind: 'implement',
      // '' on the happy path; the stop reason otherwise. record-run.py keeps the whole record in
      // `payload` verbatim, so this is queryable without a column of its own.
      stopped,
      source: src.kind,
      // The branch the run finished on, and whether it moved under the run. Recorded because
      // nothing else could see it: `branch` sat in the return value only, so 0 of 68 implement
      // rows carried one, and "how often did a run hand back a branch it was not on" was a
      // question the store could not answer. '' before Phase 4 has claimed a branch at all.
      branch: branchOn,
      base: src.base,
      branchDrifted,
      profile,
      profileForced: !!forcedProfile,
      profileEscalated,
      profileReason: (src.profileReason || '').slice(0, 200),
      explorers: aspects.length || 1,
      uiTouched,
      // The two things worth measuring about the design gate, for the same reason profileEscalated
      // is recorded: uiEscalated says how often the description-based guess was wrong, and
      // designRan says whether the phase it buys actually produced a document.
      uiEscalated,
      // The gap between these two is the measurement the design gate exists for: uiTouched-without-
      // uiVisualChange is the run that would have spent an Opus agent writing "nothing changes".
      uiVisualChange,
      designRan: !!designSection,
      buildGreen,
      // The resolved implementer row. `implement depth` in lib/skill-stats.py mines effort off the
      // items, which cannot tell a codex run from a claude one — the items record the SUBAGENT's
      // tier, and on codex that is the driver's, not the writer's. Recording the row here is what
      // lets the table bucket by provider rather than averaging two different writers together.
      implProvider,
      implModel: implCfg ? implCfg.model : IMPL_RUN.model,
      implEffort: implCfg ? implCfg.effort : IMPL_RUN.effort,
      // The wrapper's own tier, recorded only where it means something. On claude there is no
      // wrapper, and a value here would read as one that ran.
      ...(implProvider === 'codex' ? { implWrapperModel: implRun.model, implWrapperEffort: implRun.effort } : {}),
      // The resolved PLANNING row — the planner, its explorers and the judges. Recorded rather
      // than mined for a reason the items make plain: the planner's own items come back at xhigh
      // while this row asks for high, because the subagent reports the tier it resolved to and not
      // the one it was dispatched with. `plan depth` in lib/skill-stats.py buckets on what is
      // written here, so a run is bucketed by the setting somebody chose.
      planModel: planRun.model,
      planEffort: planRun.effort,
      exploreModel: exploreRun.model,
      exploreEffort: exploreRun.effort,
      judgeModel: judgeRun.model,
      judgeEffort: judgeRun.effort,
      planReviewRan: !!planReview.ran,
      planApplied: planReview.applied.length,
      planDropped: planReview.dropped.length,
      // One row per finding Codex raised against the plan, with the judges' verdict. The two counts
      // above say how many landed and how many were thrown out; these say WHICH rubric keeps
      // producing findings nobody buys, which is the number that decides whether a plan-review pass
      // earns its slot. `track` is the rubric because that is the only dimension this reviewer
      // varies along.
      findings: planReview.judged.map((j) => ({
        track: j.rubric || 'plan-review',
        // The lane that answered it — 'citation' or 'judge'. Two instruments triage these findings
        // and they cost two orders of magnitude apart, so a precision number that averages them
        // describes neither. Rows written before the lanes existed carry no category, and
        // skill-stats.py prints those apart rather than folding them into either.
        category: j.by,
        severity: j.severity,
        verdict: j.verdict,
        fixed: j.verdict === 'confirmed',
        description: j.what,
      })),
    }
    await agent(
      `Record one line of run statistics. This is bookkeeping — if anything goes wrong, say so and
   return; do NOT retry and do NOT treat it as a failure of the run. Run exactly this from the
   repo root, then return the script's stderr line verbatim:

   python3 "${PACK}/lib/record-run.py" <<'RTI_STATS_JSON'
${JSON.stringify(statsRow)}
RTI_STATS_JSON

   The script always exits 0 by design; its stderr says whether the row was recorded.`,
      { label: 'stats', phase: 'Build', ...GP, ...SINK }).catch(() => null)
  } catch { /* a sink that throws must not cost the run its result or a stop its reason */ }
}

// Every halt from here down goes through this, so a stop cannot silently lose the plan-review
// audit trail or its stats row by one site forgetting to add them — which is exactly how
// `implement-blocked` came to report a phase as unreviewed when Codex had in fact reviewed it.
const stop = async (reason, extra = {}, buildGreen) => {
  await recordRun({ stopped: reason, ...(buildGreen === undefined ? {} : { buildGreen }) })
  return { stopped: reason, planPath, planReview, ...extra }
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
    // planRun: the plan is the highest-leverage artifact in the run, so it names its own model
    // and depth (from `steps.plan`, PLAN_RUN as the fallback) rather than inheriting them. It is still written and critiqued by
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
       implementers build from, so anything that is not plan text becomes a line in the plan.${BATCH_CLAUSE}`,
      { label: 'planner', phase: 'Plan', agentType: 'Plan', ...planRun }))
    if (blocked(plan) || typeof plan !== 'string' || !plan.trim()) return await stop('planner-blocked')
    planMarkdown = plan.trim()
  } else {
    // Light tier: no Codex plan review, and the plan itself stays BRIEF — but PLAN_LIGHT_RUN sits
    // at the same depth as the full planner and the brief still carries a real coverage contract,
    // so a light plan is a checkable contract rather than loose prose. The light saving is skipping
    // the review pass, not cheapening the planner.
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
    if (blocked(lite) || typeof lite !== 'string' || !lite.trim()) return await stop('planner-blocked')
    planMarkdown = lite.trim()
  }

  // The design section rides into the plan file AHEAD of the plan, as one document with one
  // scribe. Not a second file: the plan path is what Codex reviews, what the implementers read,
  // and what a resume picks up from — a design kept beside it would be the one artifact nobody
  // downstream is already opening. Verbatim, because the planner may paraphrase anything it is
  // asked to repeat, and the point of deciding the design in its own phase is that the words
  // survive to the implementer.
  //
  // Everything the scribe is measured against is computed from THIS combined text — its size
  // label, the last-line truncation check, the disk re-check below — so prepending here needs no
  // change to any of it.
  if (designSection) planMarkdown = `${designSection}\n\n${planMarkdown}`

  // The planner is read-only and this script has no filesystem access, so a scribe agent puts
  // the plan on disk. The file is the shared artifact for the Codex reviewer and the
  // implementers — passing it by path is what keeps every downstream context lean.
  //
  // The one job here is a byte-for-byte copy, and it is the step most likely to fail QUIETLY:
  // a scribe that re-wraps prose, "tidies" a heading or drops a section produces a perfectly
  // well-formed plan file that does not match the plan Codex is about to review and the
  // implementers are about to build. So the prompt asks for a quoted heredoc (the plan is full of
  // backticks and file:LINE refs that an unquoted one would hand to the shell) and makes the
  // scribe check its own work against the one fact it cannot fake: what `tail -1` prints.
  const planLineCount = planMarkdown.split('\n').length
  const wrote = await reliable('plan-write', 'Plan', () => agent(
    `Write this plan to ${planPath} in the repo, prefixed with this status header:

     status: ${profile === 'full' ? 'reviewing' : 'implementing'}   # reviewing -> implementing -> done
     tier: ${profile}
     source: ${src.kind === 'issue' ? `issue ${rawSource}` : rawSource}
     base: ${src.base}

     First \`mkdir -p .task-plans\`. Do NOT add ".task-plans/" to .gitignore — plans are tracked
     now: this file is committed with the rest of the task at finish, and the reuse-index links
     back to it, so a gitignored plan would be a dead link for everyone but you. If a prior run
     left ".task-plans/" in .gitignore, remove that line so the plan can be committed.
     Do not edit any other file (beyond the plan and that one .gitignore line).

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
     hand — run the command and read what it prints:
       tail -1 ${planPath}

     The last line of the file must be the last line of the plan below. That is the whole check:
     truncation — the failure this step exists to catch — always moves the last line. A line COUNT
     is deliberately not part of it. Counting the body means arithmetic across the header boundary,
     which comes out short on a file that is completely intact, so it raises false alarms and
     catches nothing the last line does not already catch.

     Return written=false only when the last line is WRONG or the file is missing: that is a real
     truncation, and it is retried cheaply here. Returning written=false for an intact plan is not
     a safe default — it throws away a document that cost the most expensive agent in the run to
     produce.

     PLAN (${planLineCount} line(s)):
     ${planMarkdown}`,
    { label: 'plan-write', phase: 'Plan', schema: WROTE, ...GP, ...SCRIBE }))
  // A self-reported failure is a claim about the disk, not the disk itself — so check the disk
  // before throwing the plan away. A scribe that writes a complete plan and then misjudges its own
  // work costs the run more than the miswrite it is reporting: 'plan-not-written' stops the run,
  // and RESUMING replays the cached verdict, so the same good plan is discarded twice before a
  // third full attempt rewrites it. Reading the file makes this step idempotent: whatever the
  // scribe believes, a plan whose last line is the planner's last line is a plan, and a poisoned
  // cache entry stops mattering.
  if (blocked(wrote) || !wrote.written) {
    const wantLast = planMarkdown.split('\n').pop().trim()
    const onDisk = await reliable('plan-check', 'Plan', () => agent(
      `Run \`tail -1 ${planPath}\` and report what it printed. Return exists=false if the file is
       missing or empty. Do not write or edit anything — this is a read-only check on work another
       agent already did.`,
      { label: 'plan-check', phase: 'Plan', schema: PLAN_ON_DISK, ...GP, ...ECHO }))
    const intact = !blocked(onDisk) && onDisk.exists && (onDisk.lastLine || '').trim() === wantLast
    if (!intact) return await stop('plan-not-written')
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
// `judged` keeps one object per adjudicated finding — what Codex raised, under which rubric and
// severity, and whether the judges bought it. `dropped` stays a flat string list because the PR
// body prints it; the objects are what the stats row records, and they are the only place the
// rubric and severity survive the loop below.
// Why it did not run, carried in the handoff itself. `ran:false` and a review that ran and raised
// nothing both render to a caller as "no findings", and /r:issues-fix is told to report what the
// review decided for every item in a group — so a caller that cannot tell those apart reports an
// unchallenged plan as a clean one. A BLOCKED Codex never reaches here: at full tier that stops
// the run outright above, so on a run that completed these two causes are the whole list, and the
// field says which rather than leaving the caller to infer it from the tier.
if (resuming || profile !== 'full') {
  planReview.reason = resuming
    ? 'resume — the plan was reviewed in the original run'
    : `not run at the ${profile} tier — the Codex plan review is full-tier only`
}

if (!resuming && profile === 'full') {
  phase('Plan-review')
  const rubric = `Work through this fixed rubric. Tag every finding major or minor, and tag it
     with EXACTLY ONE rubric, spelled verbatim from this list:
       coverage | grounding | test-adequacy | simplicity | risk${designSection ? ' | ui-design' : ''}
     One tag, never two joined by a slash, and never a name of your own: a finding that seems
     to span two rubrics belongs to the one that would have caught it first.

     Give every finding a \`where\`: the ONE line it is about, as file:LINE — the source line the
     plan misreads, or the plan's own line. This is what a finding is checked against downstream,
     so cite the line that would settle it. Leave it EMPTY when the finding is genuinely about a
     whole section, an absence, or the shape of the approach — an invented citation is worse than
     none, and an empty one simply routes the finding to a deeper reader.
     1. Coverage — does every acceptance criterion map to a concrete implementation AND a test
        that proves it? A criterion covered only in prose is a gap.
     2. Grounding — do the cited file:LINE references and the Reuse map actually exist and behave
        as the plan claims? A plan built on a misread of the code is the most expensive wrong.
     3. Test adequacy — do the planned tests really pin the behaviour and its edge cases, or are
        they shallow? Check every [RED] tag against the real code: a test tagged RED must be one
        the CURRENT code genuinely fails. A green guard mislabelled as a red gate is a MAJOR
        finding — it makes a suite look like it proved a fix when it only re-stated what the code
        already did. Say which tag is wrong and what it should be.
     4. Simplicity (YAGNI) — is anything over-built for needs that aren't here? Raise this ONLY
        with both halves in hand: name the concrete simpler approach, and name the acceptance
        criterion it still satisfies. A finding that asserts over-building without saying what to
        build instead is the shape triage throws out — measured, this rubric's minors are dismissed
        44% of the time, more than any other rubric here.
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
     wait here. ${collect('     ')}`,
    { label: `codex-plan-review#${pass}`, phase: 'Plan-review', schema: REVIEW, ...GP, ...CODEX_RUN }))

  let review = await askCodex(1)
  // Step 2 has no fallback: the plan is critiqued by the real Codex or not at all.
  if (blocked(review)) {
    log('run-task-implement: the Codex plan review could NOT run — stopping. No stand-in reviewer is acceptable here.')
    return await stop('codex-plan-review-unavailable', { detail: (review && review.note) || '' })
  }
  planReview.ran = true
  // The initializer's reason described a run that stopped before this point; a reason surviving
  // beside ran:true would read as a caveat on a review that actually happened.
  delete planReview.reason

  // Triage + apply, then ONE re-review — and only if the approach actually changed. The cap is
  // the point: this catches a rewrite that opened a fresh hole, it does not loop until the plan
  // is flawless. No approval gate — the run is autonomous, and the human reviews the final PR.
  //
  // Triage is a FAN-OUT, not one agent. One agent handed nothing but the finding
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

    // TWO LANES, then batches by the CODE a finding cites — never one agent per finding, and
    // never one agent over all of them. A single agent at the inherited tier that judges every
    // finding and rewrites the plan measures 11 minutes and 122k tokens, most of it re-deriving a
    // code map the explorers already produced. Splitting it one-agent-per-finding fixed that and
    // then became the widest fan-out in the pipeline — ~24 cold contexts a run, two waves deep at
    // a concurrency cap of 16, each re-reading the plan and reopening the same files to answer one
    // question.
    //
    // The lane split is the newer half, and it is argued from the store rather than from
    // mechanism. Over 435 judged plan findings on 28 runs, precision is not uniform:
    // test-adequacy 95%, grounding 89% and ui-design 89% against coverage 76%, risk 79% and
    // simplicity 62%. The first three are 252 of the 435, and what they need is a LOOKUP — does
    // the cited line say what the finding claims — not a judgement. A lookup does not want a
    // judge's tier, and the judges are the most expensive step in the planning half at 11.0M
    // tokens a run, 7.5x the Codex review they are triaging.
    //
    // So a finding goes to the cheap citation lane only when BOTH hold: its rubric is one of the
    // three, and it named a line specific enough to re-read. Everything else — the low-precision
    // rubrics, and anything whose `where` is missing or vague — goes to a full judge. The lane
    // fails closed in three directions: no citation means no lane, a reader that cannot resolve
    // the reference escalates to a judge in the same pass, and a dead one leaves its findings
    // UNJUDGED exactly as a dead judge does. Silence must never read as agreement.
    //
    // Batching is by the FILE a finding cites, not by its rubric. The unit of work is the code,
    // and grouping by rubric made a rubric with one minor finding buy a whole batch — measured 8.0
    // batches a run for ~15.5 findings. Findings that point at the same file are read together
    // whatever rubric raised them; a finding with no file falls back to grouping by rubric, which
    // is the best proxy left. What none of this does is judge LESS: every finding still gets its
    // own verdict, its own evidence and its own changesApproach flag.
    const CHUNK = 5
    const CITATION_RUBRICS = new Set(['grounding', 'test-adequacy', 'ui-design'])
    // The file half of a `file:LINE`. Deliberately loose about the line — a finding citing a file
    // with no line still groups with its neighbours, which is the whole point of grouping by code.
    const fileOf = (w) => {
      const m = /([^\s:()[\]<>"'`,]+\.[A-Za-z0-9_]+)/.exec(String(w || ''))
      return m ? m[1] : ''
    }
    // `looksLikeEvidence` is the same gate the explorers' risk flags pass through — a citation has
    // to name a path or an extension and be long enough to mean something. One test, not two.
    const laneOf = (f) => (CITATION_RUBRICS.has(f.rubric) && looksLikeEvidence(f.where)) ? 'citation' : 'judge'
    const batchesFor = (findings, lane) => {
      const out = []
      const keyOf = (f) => fileOf(f.where) || (f.rubric || 'other')
      for (const key of [...new Set(findings.map(keyOf))]) {
        const group = findings.filter((f) => keyOf(f) === key)
        // A file that ran long is split rather than allowed to swallow the pass: one reader with
        // twelve findings is back to being the serial step this replaced.
        for (let i = 0; i < group.length; i += CHUNK) out.push({ lane, key, items: group.slice(i, i + CHUNK) })
      }
      return out
    }

    const citePrompt = (b) => `Check ${b.items.length === 1 ? 'ONE finding' : `these ${b.items.length} findings`} from Codex's review of the plan at ${planPath} against the
         line each one cites. This is a LOOKUP, not a judgement call: open the cited line, read it,
         and say whether it says what the finding claims. You are not editing the plan.

         FINDINGS:
${b.items.map((f, n) => `         ${n + 1}. [${f.severity}][${f.rubric}] ${f.what}\n            CITED: ${f.where}`).join('\n')}

         Open each CITED reference and enough around it to read it honestly — the function it sits
         in, not the whole file. They mostly point at the same file, so read it ONCE and answer all
         of them from it. Do NOT go exploring the codebase: everything you need is the plan at
         ${planPath} and the lines above.

         Return one verdict per finding, with 'n' set to its number above:
         - real=true if the cited line supports the finding. Put the evidence in 'why' as
           file:LINE, and in 'fix' write what the plan should say instead — concretely enough that
           someone editing the plan can apply it without re-doing your reading.
         - real=false if the line does not support it — the plan's claim is accurate, or the code
           says what the plan says it says. 'why' is then the dismissal reason, and it is
           answerable: Codex may be shown it and given a chance to push back, so quote the line
           that convinced you rather than asserting.
         - escalate=true if you CANNOT settle it here: the reference does not resolve, the line has
           moved, or what you read is something neither the plan nor the finding describes. It then
           goes to a deeper reader in this same pass, which is the right outcome — a guess from
           here is worse than no answer. Leave 'real' out when you escalate.
         Never set changesApproach. That flag buys a second full Codex review, and it belongs to a
         reader who worked out the fix from the whole approach, not to this check.${BATCH_CLAUSE}`

    const judgePrompt = (b) => `Judge ${b.items.length === 1 ? 'ONE finding' : `these ${b.items.length} findings`} from Codex's review of the plan at ${planPath}. Decide whether each
         holds against the real code, and nothing else — you are not editing the plan.

         They are grouped by the code they point at, so they are largely checked against the same
         file. Read that code ONCE and answer all of them from it; do not restart your reading for
         each.

         FINDINGS:
${b.items.map((f, n) => `         ${n + 1}. [${f.severity}][${f.rubric}] ${f.what}${f.where ? `\n            CITED: ${f.where}` : ''}`).join('\n')}

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
         really did change shape and is pure delay when it did not.${BATCH_CLAUSE}`

    // Which lane actually answered each finding, so the store can read the two apart. Without it
    // the precision table averages two instruments into one number and this split is unmeasurable.
    const laneUsed = new Map()
    const verdicts = new Map()
    // Dispatch a wave and fold its answers back into `verdicts`, one verdict per finding, in the
    // original order. A missing 'n' — a batch that answered four of its five — leaves that finding
    // with no verdict, which the UNJUDGED branch below then handles exactly as a dead batch.
    const runWave = async (waveBatches, offset) => {
      const out = await parallel(waveBatches.map((b, bi) => () => {
        const n = offset + bi + 1
        const label = `${b.lane === 'citation' ? 'cite' : 'judge'}#${pass}.${n}:${b.key}`
        return reliable(label, 'Plan-review', () => agent(
          b.lane === 'citation' ? citePrompt(b) : judgePrompt(b),
          { label, phase: 'Plan-review', schema: VERDICTS, ...GP, ...(b.lane === 'citation' ? CITATION_RUN : judgeRun) }))
      }))
      waveBatches.forEach((b, bi) => {
        for (const f of b.items) laneUsed.set(f, b.lane)
        const r = out[bi]
        if (blocked(r) || !Array.isArray(r.verdicts)) return
        for (const v of r.verdicts) {
          const f = b.items[Number(v.n) - 1]
          // Enforced here rather than trusted from the prompt: a cheap reader that never worked
          // out the fix has no evidence for a flag that buys a second full Codex review.
          if (f) verdicts.set(f, b.lane === 'citation' ? { ...v, changesApproach: false } : v)
        }
      })
    }

    const cited = review.findings.filter((f) => laneOf(f) === 'citation')
    const judged = review.findings.filter((f) => laneOf(f) !== 'citation')
    const batches = [...batchesFor(cited, 'citation'), ...batchesFor(judged, 'judge')]
    log(`run-task-implement: plan review pass ${pass} — ${review.findings.length} finding(s) in ${batches.length} batch(es) by cited file: ${cited.length} checked against their citation, ${judged.length} judged`)
    await runWave(batches, 0)

    // A citation reader that could not settle its finding sends it to a judge, in this same pass.
    // The verdict it returned is discarded rather than kept alongside: an escalation is the reader
    // saying it has no answer, and a half-answer left in the map would be read as one.
    const escalated = cited.filter((f) => { const v = verdicts.get(f); return v && v.escalate })
    if (escalated.length) {
      for (const f of escalated) verdicts.delete(f)
      const extra = batchesFor(escalated, 'judge')
      log(`run-task-implement: plan review pass ${pass} — ${escalated.length} finding(s) escalated from the citation check to a judge`)
      await runWave(extra, batches.length)
    }

    // A judge that died is UNJUDGED — not dismissed. Silently dropping it would let a finding
    // disappear because an agent fell over, which is the failure mode every other track here is
    // built to refuse. It goes to the editor as an explicit "decide on the plan text alone".
    const accepted = [], rejected = [], unjudged = []
    let dismissedMajor = false
    review.findings.forEach((f) => {
      const v = verdicts.get(f)
      if (!v || typeof v.real !== 'boolean') unjudged.push(f)
      else if (v.real) accepted.push({ f, fix: v.fix || v.why, changesApproach: !!v.changesApproach })
      else {
        rejected.push(`${f.what} — ${v.why}`)
        if (f.severity === 'major') dismissedMajor = true
      }
    })
    planReview.dropped.push(...rejected)
    review.findings.forEach((f) => {
      const v = verdicts.get(f)
      planReview.judged.push({
        what: String(f.what || '').slice(0, 200),
        rubric: f.rubric,
        severity: f.severity,
        // A judge that died leaves `unresolved`, which is a different claim from `dismissed` —
        // one says nobody decided, the other says someone decided against it.
        verdict: (!v || typeof v.real !== 'boolean') ? 'unresolved' : (v.real ? 'confirmed' : 'dismissed'),
        // WHICH instrument answered — the cheap citation check or a full judge. It rides into the
        // findings table's `category`, so precision can be read per lane. Averaged together the two
        // are one number that describes neither, and the lane split would be unmeasurable.
        by: laneUsed.get(f) || 'judge',
      })
    })
    log(`run-task-implement: plan review pass ${pass} — ${review.findings.length} finding(s): ${accepted.length} real, ${rejected.length} dismissed${unjudged.length ? `, ${unjudged.length} UNJUDGED (the reader died)` : ''}`)
    if (rejected.length) log(`  dismissed as not-real: ${rejected.join(' | ')}`)

    let applied = []
    // Derived from the judges, not reported by the editor. Deliberately NOT gated on Codex's
    // `major` tag: severity is Codex's guess about the FINDING, while this is the judge's read of
    // the FIX it just wrote, which is the better-informed of the two. Gating the informed signal
    // behind the less informed one would be backwards. `dismissedMajor` below DOES read severity,
    // and for the same reason: there the judge wrote no fix, so the tag is all there is.
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
    // Three things buy the one re-review, and only the first involves a revised plan:
    //   approachChanged — a judge says the fix it accepted sent the plan down a different route,
    //                     so the rewrite needs a look.
    //   dismissedAll    — the judges kept NOTHING. The plan is untouched and the review has in
    //                     effect been overruled by the party it was reviewing, with no reviewer
    //                     after it. That is the shape most worth one adjudication: it is exactly
    //                     as likely to mean "Codex raised five false positives" as "the triage
    //                     talked itself out of five real ones", and nothing downstream can tell
    //                     the two apart — the plan reads identically either way.
    //   dismissedMajor  — the same overruling, one finding at a time. A pass that accepts three
    //                     findings and throws out a major reads downstream exactly like a clean
    //                     review of a good plan, and the triage is the only judgement in this run
    //                     with nothing after it. Whole-pass agreement is not what makes a
    //                     dismissal answerable; the finding's weight is.
    //
    // Severity gates THIS and not `approachChanged`, and the two rules only look contradictory.
    // Where a judge accepted a finding it wrote a fix, and its read of that fix is better informed
    // than Codex's guess about the finding — so `changesApproach` wins there. A DISMISSED finding
    // has no fix: the judge produced a reason and nothing else, and Codex's tag is then the only
    // ranking signal in existence. Ranking matters here because the alternative — re-reviewing on
    // any dismissal at all — buys a second Codex pass on most full-tier runs (a measured 58
    // dismissals across 26 implement runs, ~2.2 a run, against 360 findings folded in).
    //
    // Argued from mechanism, not yet from measurement: only 14 plan findings carry a rubric and
    // severity in the store so far, 2 of them dismissals. Every judged finding now records both,
    // so `skill-stats.py`'s precision-by-track rows are what say whether this pass earns its slot.
    const dismissedAll = !accepted.length && !unjudged.length && rejected.length > 0
    if ((!approachChanged && !dismissedAll && !dismissedMajor) || pass === 2) break
    log(approachChanged
      ? 'run-task-implement: an accepted fix changed the approach — one re-review of the revised plan'
      : dismissedAll
        ? 'run-task-implement: the triage kept none of the findings — one re-review to adjudicate the dismissals'
        : 'run-task-implement: the triage dismissed a MAJOR finding — one re-review to adjudicate it')
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
  return await stop('branch-name-missing', { base: src.base })
}
const br = await branchP
if (blocked(br) || !br.onBranch) return await stop('branch-failed')
const onBranch = String(br.onBranch).trim()
branchOn = onBranch
if (onBranch === src.base) {
  log(`run-task-implement: still on ${src.base} after 2 attempts — stopping. Implementing here would put the whole task on ${src.base} and leave the caller merging ${src.base} into itself.`)
  return await stop('branch-not-created', { base: src.base, wanted: wantBranch, detail: br.note || '' })
}
if (onBranch !== wantBranch) log(`run-task-implement: on "${onBranch}", not the requested "${wantBranch}" — continuing (it is a feature branch, not ${src.base}), but the caller merges what the handoff names`)

// Route by area, and split only when the work genuinely spans both — one subagent per area, in
// parallel, each owning a disjoint slice. A subagent handed only "build your slice" will happily
// build the WRONG thing, so every brief carries the plan path, the slice boundary, the criteria,
// and the house rules.
// The two bundled implementers are a Spring/JPA persona and a Thymeleaf/HTMX persona, and their
// slice strings name *.java / *.kt and templates LITERALLY. On a project with no JVM build there
// is no honest third one, so the routing collapses to a single general-purpose agent that reads
// the project's own conventions instead of importing somebody else's. This guard is the whole
// difference between a working run and a false stop: `hasFrontend` is true for any change that
// touches what the project renders — a terminal UI counts — so without it the Thymeleaf agent is
// handed "the templates, HTMX wiring, and frontend assets" in a Go repo, reports blockedOn (which
// is the correct answer), and one blockedOn stops the run even when the other implementer did the
// whole job. Three phases of one Go project stopped exactly that way with the work already
// complete on disk. /r:task-review guards its own fixers on the same condition (`domainFixer`).
const areas = []
if (src.buildTool === 'none') {
  if (src.hasBackend || src.hasFrontend) log('run-task-implement: no JVM build tool — routing to ONE general-purpose implementer rather than the Spring/Thymeleaf personas, whatever hasBackend/hasFrontend say')
  areas.push({ label: 'general', agentType: 'general-purpose', slice: 'everything the plan calls for' })
} else {
  if (src.hasBackend) areas.push({ label: 'backend', agentType: 'r:java-backend-developer', slice: 'the backend code (*.java / *.kt) and its tests' })
  if (src.hasFrontend) areas.push({ label: 'frontend', agentType: 'r:htmx-thymeleaf-dev', slice: 'the templates, HTMX wiring, and frontend assets' })
  if (!areas.length) areas.push({ label: 'general', agentType: 'general-purpose', slice: 'everything the plan calls for' })
}
// On the codex provider the slices stay — they still divide the work and keep two writers off the
// same files — but the persona does not: the Claude implementer types would carry their own model
// and their prompts describe an agent that edits directly, and here the agent only drives the CLI.
if (implProvider === 'codex') for (const a of areas) a.agentType = 'general-purpose'

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

// On the codex provider the subagent does not write the code — it drives the Codex CLI, which
// does, and then reports what landed. Same shape as the codex-plan-review step above, and for the
// same reason: `codex:codex-rescue` auto-loads codex-cli-runtime, becomes a one-shot forwarder that
// cannot poll, and reports failure on every run that outlives the ~600s Bash cap. Implementers
// average 963s, so that cap is the normal case here rather than the exception — which makes the
// background-and-collect protocol the whole point of this preamble, not a fallback within it.
const codexPreamble = (a) => `YOU ARE NOT WRITING THIS CODE YOURSELF. Drive the Codex CLI and let IT make the edits, then
   report what landed. Call the companion DIRECTLY with Bash — do NOT invoke the adversarial-review
   skill or its run.sh, which review a diff and would re-enter the wrapper that launches Codex:
     C="$HOME/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs"
     [ -f "$C" ] || C="$(ls -1d "$HOME"/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | sort -V | tail -n1)"
     node "$C" task --model ${implCfg.model} --effort ${implCfg.effort} --write "<the full brief below, verbatim>"
   Writes are ENABLED here — unlike the plan review, this run edits the repo. Pass the ENTIRE brief
   below through to Codex, including the plan path, the acceptance criteria and the TDD rules: a
   summarized brief is how an implementer ends up building its own reinterpretation of the plan.

   THIS RUN WILL ALMOST CERTAINLY OUTLIVE THE ~600s Bash CAP AND MOVE TO THE BACKGROUND. That is
   expected, not a failure, and giving up there is the single most common way this step reports a
   false block. ${collect('   ')}

   A LIVE WORKER PID IS NEVER A BLOCK. While \`ps -p <pid>\` still answers, that run is working and
   your job is to keep waiting — implementers average 963s and the long ones pass 40 minutes.
   \`blockedOn\` is the field this pipeline HALTS on, and the halt is not free: it stops the run for
   every other slice too, and what it reports about the tree is read at that moment. Writing "still
   running" into it and explaining in prose that it is not a real block does not work — nothing
   downstream reads the prose, the structured field is what acts, and the caller's own rules tell it
   to record a failure and restore a clean base over a diff Codex had nearly finished.

   When Codex finishes, VERIFY against the working tree rather than trusting its summary: read
   \`git status --porcelain\` and \`git diff\` for the files in your slice, and fill filesChanged and
   testEvidence from what you can SEE there. If Codex never ran, the CLI is missing, or you could
   not collect a run whose worker PID is GONE, set blockedOn saying so — a fabricated success here is
   worse than an honest halt, because the review that follows would certify code nobody wrote.
   Those three are the whole list. A run still in flight is not one of them.

   `
// The build fixer runs on the same provider as the implementers — a codex run whose red build is
// repaired by a Claude agent has two writers on one change, which is the thing the slices exist to
// prevent. Shorter than the implementers' preamble because the job is bounded: the failures are
// named, so this is far less likely to reach the background cap.
const codexFixClause = `Drive the Codex CLI for this fix rather than editing yourself — it wrote this code:
     C="$HOME/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs"
     [ -f "$C" ] || C="$(ls -1d "$HOME"/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | sort -V | tail -n1)"
     node "$C" task --model ${implCfg ? implCfg.model : ''} --effort ${implCfg ? implCfg.effort : ''} --write "<everything below, verbatim>"
   If it outlives the ~600s Bash cap it moves to the background, the same as the implementers.
   ${collect('   ')} If Codex cannot
   be reached at all, say so plainly — do NOT quietly fix the build yourself, because the next
   build is what decides whether this loop stops and a silent substitution hides which writer
   produced the code the review is about to certify.

   `
const implBrief = (a) => `${implProvider === 'codex' ? codexPreamble(a) : ''}Implement your slice of the plan at ${planPath}. READ THAT FILE FIRST — it holds
   the Context, the acceptance criteria, and the TDD test plan, so you build what the plan intends
   rather than your own reinterpretation.

   YOUR SLICE: ${a.slice}
   ${areas.length > 1 ? `ANOTHER subagent owns ${areas.filter((o) => o.label !== a.label).map((o) => o.slice).join(' and ')} — stay out of it; do not duplicate or collide.

   OWNERSHIP IS BY FILE TYPE, NEVER BY PLAN ITEM. The plan divides the work by ITEM; this run
   divides it by FILE, and where the two cross the FILE decides. A *.java or *.kt test that asserts
   on rendered template output is a Java file and belongs to the backend slice, whichever item it
   serves — the frontend slice owns the template, not the test that reads it. Never hand a file to
   the other slice because another ITEM owns it: a file both slices believe is the other's gets
   written by neither, and neither agent is doing anything wrong when that happens. Take the
   expected values from the PLAN's acceptance criteria rather than from what the other slice has
   produced so far — the plan states what the template will render, and that is exactly what lets
   the two slices run at the same time.

   THE PLAN'S COVERAGE CONTRACT IS A DELIVERABLE, not a description of one. Every row whose test
   file falls in your slice must EXIST when you return, including a test class the plan names that
   is not on disk yet. Get this wrong in the two directions it fails in and only one is ever
   caught: a stale assertion turns the build red and the build phase fixes it, while a test nobody
   wrote fails nothing, so no later phase in this pipeline can notice it is missing.` : ''}
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
     subagent quietly "improving" on the plan is how a run ends up contradicting its own intent.${implProvider === 'codex' ? BATCH_CLAUSE : ''}`

const impls = await parallel(areas.map((a) => () =>
  reliable(`implement:${a.label}`, 'Implement', () => agent(
    implBrief(a), { label: `implement:${a.label}`, phase: 'Implement', schema: IMPL, agentType: a.agentType, ...implRun }))))

// A blocked slice HALTS the run, and that stays true: half a plan implemented is not a finished
// task, and the caller has to re-plan rather than build on it. What changes is that the halt no
// longer throws away the other implementers' work. When the areas split, the ones that finished
// have left a real diff UNCOMMITTED on the feature branch — a stop reporting only the blockage
// reads as "nothing happened" over that diff, and the next run then plans against a tree it
// believes is clean. So the halt carries what landed, and the caller reports both halves.
// What a halt says about the tree is read FROM THE TREE, never assembled from the agents that
// halted. `landed` can only ever carry slices that returned clean, so a run where every slice sets
// blockedOn hands back `filesChanged: []` over a working tree that already holds most of the
// change — the same "reads as nothing happened" failure the comment above exists to prevent,
// arriving through the other door. Observed on wf_9c4f981b-d68: every implementer reported blocked
// while its Codex was still writing, the handoff said `implemented: []` and `filesChanged: []`, and
// `git diff --stat <base>` in that same tree at that same moment showed 8 files. A caller cannot
// act on a field its own repo contradicts, and this one is acted on hard — /r:issues-fix restores a
// clean base over it.
//
// MECHANICAL, not the echo tier, for the reason the branch re-read gives: this answer decides
// whether the caller believes any work exists. It fails OPEN and says so — an unread tree is
// reported as unread, never as empty, because "nothing was written" and "nobody looked" are the
// two readings this whole field exists to keep apart.
const treeAtHalt = async () => {
  const t = await agent(
    `Run \`git status --porcelain\` and \`git diff --name-only ${src.base}\` in the repo, and return
     every path either one names, deduplicated, as filesPresent. Read only — change nothing, check
     nothing out, commit nothing, stage nothing, stash nothing. The working tree holds uncommitted
     work and must stay exactly as it is. Return an empty array ONLY if both commands genuinely
     printed no paths.`,
    { label: 'halt-tree', phase: 'Implement', schema: TREE, ...GP, ...MECHANICAL }).catch(() => null)
  return t && Array.isArray(t.filesPresent) ? t.filesPresent : null
}

const haltingStop = async (detail, landed) => {
  const landedFiles = landed.flatMap((r) => r.filesChanged || [])
  const probed = await treeAtHalt()
  if (probed) {
    const unclaimed = probed.filter((f) => !landedFiles.includes(f)).length
    log(`run-task-implement: the tree at the halt holds ${probed.length} changed file(s) on ${onBranch}${unclaimed ? `, ${unclaimed} of them claimed by no implementer that returned — a slice that halted had already written code` : ''}; reporting what is THERE, uncommitted`)
  } else {
    log(`run-task-implement: could not read the working tree at the halt — reporting only what the implementers that returned claimed (${landedFiles.length} file(s)). The tree may hold more; treeRead is false so the caller does not read this as an empty diff.`)
  }
  return await stop('implement-blocked', {
    detail,
    branch: onBranch,
    base: src.base,
    implemented: landed.map((r) => r.summary),
    filesChanged: probed || landedFiles,
    treeRead: !!probed,
    testEvidence: landed.flatMap((r) => r.testEvidence || []),
  })
}

const stuck = impls.filter((r) => r && r.blockedOn).map((r) => r.blockedOn)
if (stuck.length) {
  const landed = impls.filter((r) => r && !r.blockedOn && r.summary)
  log(`run-task-implement: an implementer says the plan is wrong or blocked — surfacing instead of working around it`)
  if (landed.length) log(`run-task-implement: ${landed.length} of ${areas.length} implementer(s) finished first — their work is UNCOMMITTED on ${onBranch}; the halt reports it rather than discarding it`)
  return await haltingStop(stuck.join(' | '), landed)
}
if (impls.every((r) => blocked(r))) return await haltingStop('every implementer returned blocked or died', [])

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
  let lastBuild = null
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
       - inScopeGreen: ALWAYS set it, and set it as a boolean rather than describing it. true when
         NOTHING in the changed files failed — every in-scope module compiled and every in-scope
         test passed — even while the build is red from pre-existing failures. false when this
         change broke something. This flag is what the pipeline branches on; the two strings above
         are the detail a human reads, so do not answer "None." in one and leave this unset.
       Put a short combined log in 'failures'.`,
      { label: `build#${i}`, phase: 'Build', schema: BUILD, agentType: src.runnerAgent, ...BUILD_RUN })
    lastBuild = b || lastBuild
    if (b && b.green) { buildGreen = true; break }
    const inScope = b && b.inScopeFailures && b.inScopeFailures.trim()
    // The boolean decides. It falls back to the old emptiness test only when the runner did not
    // answer at all — a dead or malformed result is no worse off than before, and both readings
    // stop the run either way, so the cost of the fallback being wrong is a misattribution rather
    // than a merge.
    const inScopeClean = b && typeof b.inScopeGreen === 'boolean' ? b.inScopeGreen : !inScope
    if (inScopeClean) {
      if (inScope) log(`run-task-implement: the runner reported inScopeGreen with in-scope prose beside it ("${inScope.slice(0, 60)}") — believing the flag`)
      log('run-task-implement: build RED from PRE-EXISTING failures only — not fixing them, surfacing to the user')
      return await stop('build-red-preexisting', { preExisting: (b && b.preExistingFailures) || (b && b.failures) || 'unknown',
                                                   branch: onBranch, base: src.base }, buildGreen)
    }
    if (i < 3) await agent(
      `${implProvider === 'codex' ? codexFixClause : ''}The build is red from failures THIS change caused. Fix ONLY these, surgically, and do NOT
       touch any pre-existing or out-of-scope test or class to force a pass:
       ${inScope}
       Intent (do not undo it): ${src.taskIntent}
       Self-check by COMPILING, not by building: \`${src.buildTool === 'maven' ? 'mvn -q test-compile' : './gradlew -q testClasses'}\` plus the one
       test you touched. Do not run the full suite — this loop rebuilds and re-runs it the moment
       you return, and that is what proves the failures are gone.`,
      // The resolved implementer settings, for the same reason the implementers carry them: this
      // is the same agent on the same provider, editing the code it just wrote. Left unpinned it
      // took its depth from the entry point, and left on Claude it would quietly hand a codex run's
      // code to a different writer.
      { label: `build-fix#${i}`, phase: 'Build', agentType: areas[0].agentType, ...implRun })
  }
  if (!buildGreen) {
    log('run-task-implement: in-scope build still RED after 3 attempts — stopping and surfacing to the user')
    // Carry the triage out with the halt. A caller acts hard on `build-red` — /r:issues-fix records
    // the group as failed and restores a clean base — and "this change broke the build" is a very
    // different thing to hand a user than "these three tests still fail, and these others were
    // already red on base". The workflow has both strings in hand here; dropping them made the
    // caller re-derive from a tree it is about to discard.
    return await stop('build-red', {
      branch: onBranch, base: src.base,
      inScope: (lastBuild && lastBuild.inScopeFailures) || 'unknown',
      preExisting: (lastBuild && lastBuild.preExistingFailures) || '',
      buildLog: (lastBuild && lastBuild.failures) || '',
    }, buildGreen)
  }
}

// --- Handoff -----------------------------------------------------------------
// Steps 5 (post-task-review) and 6 (finish) belong to the CALLER, which runs them in its own
// main thread — post-task-review's canonical engine is a Workflow, and a Workflow call nested
// inside this script's agents would not be reachable.
// THE BRANCH IS RE-READ, never remembered. `onBranch` was settled at the top of Phase 4 and is
// hundreds of agent-minutes old by now, and the run's diff is UNCOMMITTED the whole way — so the
// feature branch and its base hold identical trees, and any `git checkout <base>` in between
// succeeds and carries the working tree across with it. A handoff naming a branch the repo left
// is the expensive kind of wrong, because both callers act on the name: /r:plan-run Step 3.6
// merges it into base, and this skill's own `--skip-pr` finish runs
// `git checkout <base> && git merge --no-ff <branch>` — which, on a stale name, is base merged
// into itself. That is the failure the Phase 4 halt exists to prevent, arriving after it.
//
// So report the TRUTH rather than the intent, and do not halt on it: the work exists and is
// uncommitted, and `stop()` drops `implemented` and `testEvidence`, so halting here would throw
// away the run's only record of what it did. The callers already refuse to merge from base —
// plan-run Step 3.6 re-reads HEAD itself — and `branchDrifted` names it for them rather than
// leaving it to be discovered. A re-read that cannot run leaves the remembered value and says so:
// a guess about which branch to merge is worse than an admitted gap.
const finalBr = await agent(
  `Run \`git rev-parse --abbrev-ref HEAD\` in the repo and return its EXACT output as onBranch.
   Read only — change nothing, check nothing out, commit nothing. The working tree has uncommitted
   work in it and must stay exactly as it is.`,
  { label: 'head-check', phase: 'Build', schema: BRANCH, ...GP, ...ECHO }).catch(() => null)
const realBranch = (finalBr && String(finalBr.onBranch || '').trim()) || ''
if (!realBranch) {
  log(`run-task-implement: could not re-read HEAD at the handoff — reporting the branch this run claimed (${onBranch}); the caller re-checks before it merges`)
} else if (realBranch !== onBranch) {
  branchDrifted = true
  branchOn = realBranch
  log(`run-task-implement: HEAD MOVED under the run — claimed "${onBranch}", really on "${realBranch}"${realBranch === src.base ? ` (that is the base branch: the diff is sitting on ${src.base}, uncommitted)` : ''}. Reporting the branch the repo is really on; do NOT merge on the claimed name.`)
}
const handoffBranch = realBranch || onBranch

log(`run-task-implement: done — green build on ${handoffBranch}, diff left uncommitted for review`)

// The run's own row — the same recorder every stop above uses, so a completed run and a halt are
// recorded the same way and can be compared in the store.
await recordRun({ buildGreen })

return {
  // What the repo is REALLY on, re-read above — never the name Phase 4 asked for. `branchDrifted`
  // says the two disagreed, so a caller can tell a moved HEAD from an ordinary run rather than
  // inferring it from a name that looks fine.
  branch: handoffBranch,
  branchDrifted,
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
  // resume), NOT that Codex came back clean — a blocked Codex stops the run outright above. It
  // carries `reason` saying which, because to a caller an unchallenged plan and a plan the review
  // passed both read as "no findings", and the first is the one worth saying out loud.
  // The caller carries `applied` into the PR body; `dropped` is there so a dismissal can be
  // questioned instead of disappearing.
  planReview,
  implemented: impls.filter((r) => r && r.summary).map((r) => r.summary),
  // What the implementers OBSERVED when they ran each test before/after the change — the evidence
  // behind "test-first", rather than the plan's claim about it. Carry it into the PR body: a test
  // that was green before the change is a regression guard, not proof the fix works.
  testEvidence: impls.flatMap((r) => (r && r.testEvidence) || []),
}
