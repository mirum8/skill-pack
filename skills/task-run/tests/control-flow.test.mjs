// Control-flow tests for run-task-implement.workflow.js.
//
// The script is pure orchestration — every side effect goes through agent()/parallel(), which
// the runtime injects. So it can be executed here with those stubbed, and the BRANCHES can be
// asserted directly: what stops the run, what gets retried, what reaches the handoff.
//
// Death model matches the real runtime, which has TWO shapes and not one. Usually a subagent
// that dies resolves agent() to `null`. But agent() also REJECTS — a StructuredOutput retry cap
// and an exhausted token budget both throw — and an untrapped throw ends the whole script, not
// just the step. A thunk that throws is resolved to null by parallel(); a throw on a bare await
// is caught by reliable(). All of these are covered.
//
//   run:  node --test <pack>/skills/task-run/tests/control-flow.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const WF = path.join(import.meta.dirname, '..', 'task-run-implement.workflow.js')
const SRC = fs.readFileSync(WF, 'utf8').replace('export const meta', 'const meta', 1)

// Top-level `return` is legal inside the async IIFE the real runtime wraps the script in.
const makeWf = () => new Function('args', 'agent', 'parallel', 'phase', 'log',
  `return (async () => {\n${SRC}\n})()`)

const THROW = Symbol('agent throws')

// The planner returns plain text, not {planMarkdown}. Its last line is what the disk check
// compares against when the scribe self-reports failure, so tests reuse this constant rather
// than restating it.
const PLAN_TEXT = '## Context\nfix it\n## Coverage contract\ncriterion -> test'

// The explorers are schema-LESS too: an 8k-char brief plus a second parameter is the payload that
// blew the StructuredOutput retry cap on three real runs, so the brief now comes back as plain
// text with the risk flags on a trailer line the script parses. The stub returns that shape, and
// the brief is padded past MIN_BRIEF_CHARS (400) because anything shorter is now treated as a
// failed explorer rather than a short one.
const BRIEF_TEXT = 'AdminRatesController.java:167 returns the fragment. '.repeat(9)
const exploreText = (riskFlags) => `${BRIEF_TEXT}\nRISKFLAGS: ${JSON.stringify(riskFlags)}`

function baseSource(over = {}) {
  return {
    kind: 'issue', slug: 'issue-81-import', branch: 'issue-81-import', base: 'main',
    taskIntent: 'Stop the rate-sheet import from wiping the admin page.',
    criteria: ['rejected import keeps the versions table'],
    profile: 'full', profileReason: 'rewrites the import error path', uiTouched: true,
    hasBackend: true, hasFrontend: false,
    buildTool: 'maven', buildCmd: 'mvn clean package', buildCmdFast: 'mvn package',
    runnerAgent: 'maven-build-runner',
    exploreAspects: ['controller + templates', 'existing tests'],
    planPath: '.task-plans/issue-81-import.md', planStatus: 'none', branchExists: false,
    ...over,
  }
}

// `overrides` maps a label PREFIX to the value that label should return — or THROW, or a
// function of the call count. Anything not overridden takes the happy-path default.
async function run({ source = baseSource(), riskFlags = [], review, planfix, verdict,
                     args = { source: '#81' }, overrides = {}, build } = {}) {
  const logs = []
  const prompts = {}
  const log = (m) => logs.push(m)
  const phase = () => {}
  const parallel = async (thunks) =>
    Promise.all(thunks.map(async (t) => { try { return await t() } catch { return null } }))

  const counts = {}
  const optsBy = {}
  let codexPass = 0
  const agent = async (prompt, opts = {}) => {
    const l = opts.label || ''
    counts[l] = (counts[l] || 0) + 1
    prompts[l] = prompt
    optsBy[l] = opts
    for (const [prefix, val] of Object.entries(overrides)) {
      if (!l.startsWith(prefix)) continue
      if (val === THROW) throw new Error(`simulated terminal failure in ${l}`)
      return typeof val === 'function' ? val(counts[l]) : val
    }
    if (l === 'source') return source
    if (l.startsWith('explore')) return exploreText(riskFlags)
    // The planner is schema-LESS — it returns its plan as plain text, so the stub does too.
    if (l === 'planner' || l === 'plan-light') return PLAN_TEXT
    if (l === 'plan-write' || l === 'plan-status') return { written: true, path: source.planPath }
    // Only reached when plan-write reported failure: the run checks the disk before believing it.
    if (l === 'plan-check') return { exists: true, lastLine: PLAN_TEXT.split('\n').pop() }
    if (l.startsWith('codex-plan-review')) { codexPass++; return typeof review === 'function' ? review(codexPass) : review }
    // `judge#<pass>.<batch>:<rubric>` — findings are BATCHED by rubric and one agent returns a
    // verdict per finding. The stub recovers which findings its batch holds by reading the
    // numbered list out of the prompt (every test finding is literally named "finding K"), so a
    // `verdict(pass, i)` stub still answers per finding exactly as it did per agent.
    if (l.startsWith('judge#')) {
      const p = Number(l.slice('judge#'.length).split('.')[0])
      const items = [...prompt.matchAll(/^\s*(\d+)\. \[[^\]]*\]\[[^\]]*\] finding (\d+)/gm)]
        .map((m) => ({ n: Number(m[1]), i: Number(m[2]) }))
      const one = (i) => typeof verdict === 'function' ? verdict(p, i)
        : (verdict === undefined ? { real: true, why: 'holds', fix: `fix for finding ${i}` } : verdict)
      return { verdicts: items.map(({ n, i }) => ({ n, ...one(i) })) }
    }
    // `plan-fix#N` — the pass number comes off the label, so a function stub can answer
    // differently on the re-review without the harness holding extra state.
    if (l.startsWith('plan-fix')) return typeof planfix === 'function' ? planfix(Number(l.split('#')[1]) || 1) : planfix
    if (l === 'branch') return { onBranch: source.branch }
    if (l.startsWith('implement')) return { done: true, summary: 'returned VERSIONS_VIEW on error paths', filesChanged: ['AdminRatesController.java'] }
    if (l.startsWith('build#')) return build ? build(counts[l]) : { green: true }
    return {}
  }

  const wfArgs = args && typeof args === 'object' ? { packRoot: '/pack', ...args } : args
  const out = await makeWf()(wfArgs, agent, parallel, phase, log)
  return { out, logs, counts, prompts, optsBy, logText: logs.join('\n') }
}

const F = (n) => Array.from({ length: n }, (_, i) =>
  ({ severity: i === 0 ? 'major' : 'minor', rubric: 'coverage', what: `finding ${i + 1}` }))
const OK_REVIEW = { ran: true, findings: F(2) }
const OK_FIX = { applied: ['added a test for the empty-file branch'] }
// Judges decide; the editor only applies. A mixed verdict — finding 1 holds, finding 2 does not —
// is the ordinary shape, so most tests below use it.
const MIXED = (_pass, i) => i === 1
  ? { real: true, why: 'AdminRatesController.java:167 confirms it', fix: 'add the empty-file test' }
  : { real: false, why: 'misreads the template, the fragment is re-rendered' }

// ---------------------------------------------------------------- happy paths ---

test('full tier: mixed triage reaches the handoff with the plan-review audit trail', async () => {
  const { out } = await run({ review: OK_REVIEW, planfix: OK_FIX, verdict: MIXED })
  assert.equal(out.stopped, undefined)
  assert.equal(out.branch, 'issue-81-import')
  assert.equal(out.profile, 'full')
  assert.equal(out.buildGreen, true)
  assert.equal(out.planReview.ran, true)
  assert.equal(out.planReview.raised, 2)
  assert.deepEqual(out.planReview.applied, OK_FIX.applied)
  // The dismissal is built by the SCRIPT from the judge's verdict, not echoed back by the agent
  // that edits the plan — so a finding cannot go missing by being left out of a return value.
  assert.deepEqual(out.planReview.dropped, ['finding 2 — misreads the template, the fragment is re-rendered'])
})

test('every finding is judged, in rubric batches, and the judges get the explorer briefs', async () => {
  // Two regressions in one. Triage used to be ONE agent handed nothing but the finding strings, so
  // it re-read the codebase to answer the first one and worked through the rest serially — hence
  // the briefs. Then it became one agent PER finding, which at a measured ~24 findings a run was
  // ~24 cold contexts re-reading the same plan and the same files. Findings that share a rubric are
  // checked the same way, so they now share a reader — and still get separate verdicts.
  const { out, counts, prompts, optsBy } = await run({
    review: { ran: true, findings: F(3) }, planfix: OK_FIX, verdict: MIXED,
  })
  const judges = Object.keys(counts).filter((l) => l.startsWith('judge#'))
  assert.deepEqual(judges, ['judge#1.1:coverage'], 'one rubric, one batch — not one agent per finding')
  const p = prompts['judge#1.1:coverage']
  assert.match(p, /AdminRatesController\.java:167 returns the fragment/,
    'a judge that starts without the briefs will re-derive them')
  for (const i of [1, 2, 3]) assert.match(p, new RegExp(`\\[coverage\\] finding ${i}`), `finding ${i} must be judged`)
  assert.match(p, /Read that code ONCE and answer all of them from it/)
  assert.match(p, /Do not let one finding's verdict carry the others/,
    'the batch is the unit of dispatch, never of judgement')
  assert.equal(optsBy['judge#1.1:coverage'].effort, 'high', 'batching must not buy depth back')
  // Each finding still lands on its own side of the ledger.
  assert.deepEqual(out.planReview.applied, OK_FIX.applied)
  assert.equal(out.planReview.dropped.length, 2, 'findings 2 and 3 were dismissed individually')
  // The editor is handed the fix the judge already wrote, so it never re-does the reading.
  assert.match(prompts['plan-fix#1'], /FIX: add the empty-file test/)
})

test('a rubric with more findings than one reader can hold is split, not swallowed', async () => {
  // The failure mode batching could reintroduce: twelve findings of one rubric handed to a single
  // agent is the serial triage this fan-out replaced.
  const findings = Array.from({ length: 12 }, (_, i) =>
    ({ severity: 'minor', rubric: 'coverage', what: `finding ${i + 1}` }))
  const { counts } = await run({ review: { ran: true, findings }, planfix: OK_FIX })
  const judges = Object.keys(counts).filter((l) => l.startsWith('judge#'))
  assert.equal(judges.length, 3, '12 findings at 5 per batch = 3 batches')
})

test('findings are grouped by rubric, so one batch is one kind of check', async () => {
  const findings = [
    { severity: 'major', rubric: 'coverage', what: 'finding 1' },
    { severity: 'minor', rubric: 'grounding', what: 'finding 2' },
    { severity: 'minor', rubric: 'grounding', what: 'finding 3' },
  ]
  const { counts, prompts } = await run({ review: { ran: true, findings }, planfix: OK_FIX })
  const judges = Object.keys(counts).filter((l) => l.startsWith('judge#')).sort()
  assert.deepEqual(judges, ['judge#1.1:coverage', 'judge#1.2:grounding'])
  assert.doesNotMatch(prompts['judge#1.1:coverage'], /finding 2/)
  assert.match(prompts['judge#1.2:grounding'], /finding 3/)
})

test('a judge batch that dies leaves its findings UNJUDGED, never quietly dismissed', async () => {
  const { out, counts, prompts, logText } = await run({
    review: { ran: true, findings: F(1) }, planfix: OK_FIX,
    overrides: { 'judge#1.1': null },
  })
  assert.equal(counts['judge#1.1:coverage'], 3, 'reliable() retries a dead judge, bounded at 3')
  assert.deepEqual(out.planReview.dropped, [], 'a dead agent is not a dismissal')
  assert.match(logText, /1 UNJUDGED/)
  assert.match(prompts['plan-fix#1'], /NOT JUDGED/, 'the editor must still see it')
  assert.equal(out.stopped, undefined)
})

test('a batch that answers only some of its findings leaves the rest UNJUDGED', async () => {
  // The new failure shape batching introduces: a partial verdict array. A finding whose 'n' never
  // came back must be treated exactly like one whose judge died — never as dismissed.
  const { out, prompts, logText } = await run({
    review: { ran: true, findings: F(3) }, planfix: OK_FIX,
    overrides: { 'judge#1.1': { verdicts: [{ n: 1, real: false, why: 'fp' }] } },
  })
  assert.deepEqual(out.planReview.dropped, ['finding 1 — fp'])
  assert.match(logText, /2 UNJUDGED/)
  assert.match(prompts['plan-fix#1'], /finding 2/)
  assert.match(prompts['plan-fix#1'], /finding 3/)
})

test('a triage that dismisses EVERY finding is logged, and buys one adjudication re-review', async () => {
  // Nothing was applied, so the plan is UNCHANGED and the review has in effect been overruled by
  // the party it was reviewing. Codex gets one pass to defend its findings or let them go — here
  // it lets them go, which is a real outcome and must end the loop rather than extend it.
  const { out, logText, counts, prompts } = await run({
    review: (pass) => ({ ran: true, findings: pass === 1 ? F(3) : [] }),
    verdict: (_p, i) => ({ real: false, why: `fp ${i}` }),
  })
  assert.equal(out.planReview.raised, 3)
  assert.equal(out.planReview.applied.length, 0)
  assert.equal(counts['plan-fix#1'], undefined,
    'nothing was accepted, so there is nothing to edit — the header flip is the cheap scribe\'s job')
  assert.equal(counts['plan-status'], 1)
  assert.match(logText, /dismissed EVERY finding/)
  assert.match(logText, /adjudicate the dismissals/)
  assert.equal(counts['codex-plan-review#2'], 1, 'the dismissals must be answerable by the reviewer')
  assert.match(prompts['codex-plan-review#2'], /the plan in front of you is UNCHANGED/,
    'a re-review of an untouched plan must not be described as a revision')
  assert.equal(counts['plan-fix#2'], undefined, 'Codex dropped its findings — nothing left to triage')
  assert.equal(out.stopped, undefined)
})

test('a re-review that re-raises a dismissed finding sends it back through triage', async () => {
  const { out, counts } = await run({
    review: (pass) => ({ ran: true, findings: pass === 1 ? F(2) : F(1) }),
    verdict: (pass) => pass === 1
      ? { real: false, why: 'the plan already covers this' }
      : { real: true, why: 'on a second look it does not', fix: 'add the missing test' },
    planfix: { applied: ['the dismissal was wrong — added the missing test'] },
  })
  assert.equal(counts['codex-plan-review#2'], 1)
  assert.equal(counts['plan-fix#2'], 1)
  assert.equal(counts['codex-plan-review#3'], undefined, 'still capped at two passes')
  assert.equal(out.planReview.raised, 3, 'both passes count toward what the review raised')
  assert.deepEqual(out.planReview.applied, ['the dismissal was wrong — added the missing test'])
})

test('implementers pin model+effort, so depth cannot depend on the calling session', async () => {
  // SKILL.md invites callers (e.g. /r:gh-issues-fix) to run this script directly, which never loads
  // the skill frontmatter — so anything left inherited here silently varies by entry point.
  const both = await run({
    source: baseSource({ hasBackend: true, hasFrontend: true }),
    review: OK_REVIEW, planfix: OK_FIX,
  })
  for (const l of ['implement:backend', 'implement:frontend']) {
    assert.equal(both.optsBy[l].effort, 'high', `${l} must pin effort`)
    assert.equal(both.optsBy[l].model, 'opus', `${l} must pin model`)
  }

  const fallback = await run({
    source: baseSource({ hasBackend: false, hasFrontend: false }),
    review: OK_REVIEW, planfix: OK_FIX,
  })
  assert.equal(fallback.optsBy['implement:general'].agentType, 'general-purpose')
  assert.equal(fallback.optsBy['implement:general'].effort, 'high')
  assert.equal(fallback.optsBy['implement:general'].model, 'opus')
})

test('the scribe steps pin sonnet, so a copy job never costs the session model', async () => {
  // plan-write / plan-status copy a document and flip one header line — nothing to judge. medium
  // rather than low, though: plan-write's copy is what Codex reviews and what the implementers
  // build from, so a paraphrased or truncated plan degrades everything downstream of it.
  const { counts, optsBy } = await run({ review: { ran: true, findings: [] } })
  for (const l of ['plan-write', 'plan-status']) {
    assert.equal(counts[l], 1, `${l} must have run`)
    assert.equal(optsBy[l].model, 'sonnet', `${l} must pin the scribe model`)
    assert.equal(optsBy[l].effort, 'medium', `${l} must pin the scribe effort`)
  }
})

test('the stats sink is cheaper than a scribe — it reproduces nothing', async () => {
  const { counts, optsBy } = await run({ review: { ran: true, findings: [] } })
  assert.equal(counts['stats'], 1)
  assert.equal(optsBy['stats'].model, 'haiku')
  assert.equal(optsBy['stats'].effort, 'low')
})

test('the light-tier planner keeps the model but not the top effort', async () => {
  // A light change cannot alter behavior, so its plan is a brief. The full planner is unaffected.
  const { optsBy } = await run({
    source: baseSource({ profile: 'light', exploreAspects: ['the one seam'] }),
    args: { source: '#81', profile: 'light' },
  })
  assert.equal(optsBy['plan-light'].model, 'opus')
  assert.equal(optsBy['plan-light'].effort, 'high')
  assert.equal(optsBy['planner'], undefined)   // the full planner keeps xhigh; it just didn't run
})

test('plan-write gets the plan\'s real line count and a QUOTED heredoc to write it with', async () => {
  // Truncation is the failure mode that looks exactly like success, so the scribe is handed the
  // one fact it cannot fake and asked to check itself against it. The heredoc must be quoted:
  // plans are full of backticks, `$` and file:LINE refs that an unquoted one would execute.
  const planMarkdown = [
    '## Context', 'the rejected import wipes the versions table', '',
    '## Files to change', '- AdminRatesController.java:167', '',
    '## TDD test plan', '- [RED] a rejected import keeps the versions table',
  ].join('\n')
  const lines = planMarkdown.split('\n').length
  assert.ok(lines > 1, 'the fixture must be multi-line for the count to mean anything')

  const { prompts } = await run({
    review: OK_REVIEW, planfix: OK_FIX, overrides: { planner: planMarkdown },
  })
  const p = prompts['plan-write']
  assert.match(p, new RegExp(`PLAN \\(${lines} line\\(s\\)\\)`), 'the body must be labelled with its real count')
  assert.match(p, new RegExp(`below is ${lines} line`), 'the verify step must name the same count')
  assert.match(p, /<<'RUN_TASK_PLAN_EOF'/, 'the heredoc delimiter must be quoted')
  assert.match(p, /COPY THE PLAN BODY BYTE FOR BYTE/)
  assert.match(p, /written=false/, 'a real truncation must be reported, not papered over')
  assert.ok(p.includes(planMarkdown), 'the plan body itself must reach the scribe verbatim')
})

test('the scribe is told to VERIFY by command, not by counting lines itself', async () => {
  // The count it used to be asked to do by hand — "everything after the 4 header lines and the
  // blank line that follows them" — is boundary arithmetic, and on a real run it came out two
  // short on a plan that was completely intact. The scribe returned written=false and a good
  // 247-line plan was thrown away. So the check is a command whose output it reads, the LAST
  // LINE is the authority (truncation always moves it, an off-by-one never does), and a count
  // mismatch alone is a note rather than a failure.
  const { prompts } = await run({ review: OK_REVIEW, planfix: OK_FIX })
  const p = prompts['plan-write']
  assert.match(p, /tail -1 /, 'the last-line check must be a command')
  assert.match(p, /tail -n \+6 .* \| wc -l/, 'the count must come from wc, not from the model')
  assert.match(p, /Do NOT count lines by\s+hand/, 'hand-counting is what miscounted')
  assert.match(p, /still return written=true/, 'a count-only mismatch must not fail the step')
})

test('the editor folds in the status flip, so no separate plan-status agent is spawned', async () => {
  const { out, counts, prompts, optsBy } = await run({ review: OK_REVIEW, planfix: OK_FIX })
  assert.equal(counts['plan-fix#1'], 1)
  // The editor applies fixes the judges already wrote down — the judging depth lives on judge#N.
  assert.equal(optsBy['plan-fix#1'].effort, 'medium')
  assert.equal(counts['plan-status'], undefined)
  assert.match(prompts['plan-fix#1'], /status:.*implementing/s)
  assert.equal(out.stopped, undefined)
})

test('plan-status still runs on its own when no triage touched the plan file', async () => {
  const clean = await run({ review: { ran: true, findings: [] } })
  assert.equal(clean.counts['plan-fix#1'], undefined)
  assert.equal(clean.counts['plan-status'], 1)

  const blockedFix = await run({ review: OK_REVIEW, overrides: { 'plan-fix': null } })
  assert.equal(blockedFix.counts['plan-status'], 1)
  // The judges did their work; it is the editor that fell over, so the plan is unrevised —
  // which is exactly what the log has to say rather than letting the findings look handled.
  assert.match(blockedFix.logText, /went unapplied/)
})

test('classifyOnly returns the tier and writes nothing', async () => {
  // The dry run exists to check the tier against real tasks. It must stop before the plan scribe,
  // which creates .task-plans/ — a classification check that litters the repo it is checking is
  // not one you can run against someone else's working tree.
  const { out, counts, prompts } = await run({
    args: { source: '#81', classifyOnly: true, repo: '/tmp/some-repo' },
    source: baseSource({ profile: 'standard', exploreAspects: ['the one seam'] }),
    riskFlags: [{ surface: 'money', where: 'PricingService.java:88', why: 'changes the tax rate' }],
  })
  assert.equal(out.classifyOnly, true)
  assert.match(prompts['source'], /WORK IN THE REPOSITORY AT \/tmp\/some-repo/)
  assert.equal(out.profile, 'full')
  assert.equal(out.profileEscalated, true)
  // The pair is the measurement: the description said standard, the code said full.
  assert.equal(out.profileFromDescription, 'standard')
  assert.deepEqual(out.riskFlagsIgnored, [])
  for (const l of ['planner', 'plan-write', 'branch', 'implement:backend', 'build#1', 'stats']) {
    assert.equal(counts[l], undefined, `${l} must not run for a classification`)
  }
})

test('classifyOnly reports flags the gate ignored, so a drifting enum is visible', async () => {
  const { out } = await run({
    args: { source: '#81', classifyOnly: true },
    source: baseSource({ profile: 'standard', exploreAspects: ['one'] }),
    riskFlags: [{ surface: 'business-logic', where: 'A.java:1', why: 'a new if' }],
  })
  assert.equal(out.profile, 'standard', 'an unrecognised surface must not escalate')
  assert.equal(out.profileEscalated, false)
  assert.deepEqual(out.riskFlags, [])
  assert.equal(out.riskFlagsIgnored.length, 1)
})

test('sourceModel pins the classifier for a dry run, and only for a dry run', async () => {
  const ab = await run({
    args: { source: '#81', classifyOnly: true, sourceModel: 'sonnet' },
    source: baseSource({ exploreAspects: ['one'] }),
  })
  assert.equal(ab.optsBy['source'].model, 'sonnet')
  assert.equal(ab.optsBy['source'].effort, 'medium', 'the override changes the model, not the depth')

  const real = await run({
    args: { source: '#81', sourceModel: 'sonnet' },
    review: OK_REVIEW, planfix: OK_FIX,
  })
  assert.equal(real.optsBy['source'].model, undefined,
    'a real run must classify on the model its calibration was reasoned about')
})

test('`repo` is ignored on a real run, so half the work cannot land in the wrong tree', async () => {
  const { prompts, logText } = await run({
    args: { source: '#81', repo: '/tmp/some-repo' },
    review: OK_REVIEW, planfix: OK_FIX,
  })
  assert.doesNotMatch(prompts['source'], /WORK IN THE REPOSITORY AT/)
  assert.match(logText, /ignoring `repo`/)
})

test('light tier runs no Codex plan review at all', async () => {
  const { out, counts, logText } = await run({
    source: baseSource({ profile: 'light', exploreAspects: ['the one seam'] }),
    args: { source: '#81', profile: 'light' },
  })
  assert.equal(out.profile, 'light')
  assert.equal(out.planReview.ran, false)
  assert.equal(counts['codex-plan-review#1'], undefined)
  assert.equal(counts['plan-light'], 1)
  // The regression this locks: riskFlags used to report every risk surface PRESENT in the files
  // the explorer read, so an empty list was near-impossible and light always escalated away.
  assert.doesNotMatch(logText, /re-classified/)
})

test('standard tier: full planner, but no Codex plan review', async () => {
  const { out, counts } = await run({
    source: baseSource({ profile: 'standard', exploreAspects: ['the service', 'its tests'] }),
    args: { source: '#81', profile: 'standard' },
  })
  assert.equal(out.profile, 'standard')
  assert.equal(counts['planner'], 1)          // the full Opus/xhigh planner, not the brief one
  assert.equal(counts['plan-light'], undefined)
  assert.equal(counts['codex-plan-review#1'], undefined)
  assert.equal(out.planReview.ran, false)
})

test('a UI task sends the planner to the frontend-design skill, in every tier', async () => {
  // The plan is the last cheap place to set visual direction, and post-task-review's visual half
  // grades the finished pages against this same rubric — a planner that never read it is planning
  // against an invisible bar.
  const { prompts } = await run({ review: OK_REVIEW, planfix: OK_FIX })
  assert.match(prompts['planner'], /THIS TASK TOUCHES THE UI/)
  assert.match(prompts['planner'], /load the `frontend-design` skill/)

  const light = await run({
    source: baseSource({ profile: 'light', exploreAspects: ['the template'] }),
    args: { source: '#81', profile: 'light' },
  })
  assert.match(light.prompts['plan-light'], /load the `frontend-design` skill/,
    'a cosmetic template change is exactly where design judgement IS the task')
})

test('a backend-only task does not drag the planner through the design rubric', async () => {
  const { prompts } = await run({
    source: baseSource({ uiTouched: false }),
    review: OK_REVIEW, planfix: OK_FIX,
  })
  assert.doesNotMatch(prompts['planner'], /frontend-design/)
})

test('explorers escalate to full when the CHANGE alters a risk surface', async () => {
  for (const from of ['light', 'standard']) {
    const { out, logText } = await run({
      source: baseSource({ profile: from, exploreAspects: ['the one seam'] }),
      args: { source: '#81', profile: from },
      riskFlags: [{ surface: 'auth', where: 'AdminRatesController.java:180', why: 'adds a role check' }],
      review: { ran: true, findings: F(1) },
      planfix: { applied: ['x'] },
    })
    assert.equal(out.profile, 'full', `${from} must escalate`)
    assert.equal(out.profileEscalated, true)
    assert.equal(out.planReview.ran, true)
    assert.match(logText, new RegExp(`re-classified ${from} -> FULL`))
    // Overruling someone's explicit flag is defensible; doing it silently is not.
    assert.match(logText, new RegExp(`overrides your --${from}`))
    assert.match(logText, /auth at AdminRatesController\.java:180 — adds a role check/,
      'an escalation that overrules a flag must name the evidence, not just the fact')
  }
})

test('REGRESSION: a placeholder flag does not buy a full tier', async () => {
  // Observed on a real classification run: an explorer returned {surface:"security", where:"a",
  // why:"b"}. The schema can require the fields; only the gate can require that they mean
  // something. One placeholder used to be worth a whole Codex plan review.
  const { out, logText } = await run({
    source: baseSource({ profile: 'standard', exploreAspects: ['the one seam'] }),
    args: { source: '#81', classifyOnly: true },
    riskFlags: [{ surface: 'security', where: 'a', why: 'b' }],
  })
  assert.equal(out.profile, 'standard')
  assert.equal(out.profileEscalated, false)
  assert.equal(out.riskFlagsIgnored.length, 1)
  assert.match(logText, /no usable surface or evidence/)
})

test('a real file:LINE citation still counts as evidence', async () => {
  for (const where of ['SecurityConfig.java:123', 'core/src/main/java/A.java:1-9', 'app/src/x.py']) {
    const { out } = await run({
      source: baseSource({ profile: 'standard', exploreAspects: ['one'] }),
      args: { source: '#81', classifyOnly: true },
      riskFlags: [{ surface: 'auth', where, why: 'adds a role check' }],
    })
    assert.equal(out.profile, 'full', `${where} must count`)
  }
})

test('a risk surface outside the five the tier tree names does NOT escalate', async () => {
  // The escalation used to fire on any non-empty riskFlags, and the explorer prompt invited
  // "business-logic branching" and "an external call" — true of nearly every change, so nearly
  // every run reached full and paid for a Codex plan review. The gate now counts only what the
  // classifier tree itself counts.
  const { out, logText } = await run({
    source: baseSource({ profile: 'standard', exploreAspects: ['the one seam'] }),
    args: { source: '#81', profile: 'standard' },
    riskFlags: [{ surface: 'business-logic', where: 'RateSheetService.java:44', why: 'a new if' }],
  })
  assert.equal(out.profile, 'standard')
  assert.equal(out.profileEscalated, false)
  assert.equal(out.planReview.ran, false)
  assert.doesNotMatch(logText, /re-classified/)
})

test('the handoff says whether the tier was forced, so the caller knows what to pass on', async () => {
  const forced = await run({
    args: { source: '#81', profile: 'full' }, review: OK_REVIEW, planfix: OK_FIX,
  })
  assert.equal(forced.out.profileForced, true)

  const classified = await run({ review: OK_REVIEW, planfix: OK_FIX })
  assert.equal(classified.out.profileForced, false)
  assert.equal(classified.out.profileEscalated, false)
  // A classified tier without a reason is the un-auditable case this field exists to remove.
  assert.equal(classified.out.profileReason, 'rewrites the import error path')
  assert.match(classified.logText, /classified: rewrites the import error path/)
})

test('the classifier and the explorers are told to judge the CHANGE, not its neighbourhood', async () => {
  // Both fixes are prompt-only, so the prompts are where the regression would land.
  const { prompts } = await run({ review: OK_REVIEW, planfix: OK_FIX })
  const explore = prompts['explore#1:controller + templates']
  assert.match(explore, /will add or alter/)
  assert.match(explore, /merely exists nearby/)
  // "security" is the one surface that could quietly become a catch-all and re-broaden the signal
  // the enum just narrowed, so it is defined by naming what counts, and by refusing a sixth slot.
  assert.match(explore, /secret or credential, crypto, deserialization/)
  assert.match(explore, /no sixth/)
  assert.match(prompts['source'], /Classify the CHANGE this task will make/)
  assert.match(prompts['source'], /cannot say roughly WHICH LINES will change/)
  assert.match(prompts['source'], /When you are unsure, answer "standard"/)
})

test('a fix that changes the approach buys exactly ONE re-review, never a loop', async () => {
  const { out, counts } = await run({
    review: (pass) => ({ ran: true, findings: pass === 1 ? F(2) : F(1) }),
    verdict: { real: true, why: 'holds', fix: 'rework the error path', changesApproach: true },
    planfix: { applied: ['reworked the error path'] },
  })
  assert.equal(counts['codex-plan-review#1'], 1)
  assert.equal(counts['codex-plan-review#2'], 1)
  assert.equal(counts['codex-plan-review#3'], undefined)
  assert.equal(out.stopped, undefined)
})

test('the re-review is bought by the JUDGE, not by the editor that applies the fix', async () => {
  // approachChanged gates a second full Codex pass. It used to be reported by the editor — the
  // lowest-depth agent in the phase, which sees a fix list and never opened the code. It belongs to
  // the judge that read the code and wrote the fix, so an editor claim about it must not count.
  const { counts } = await run({
    review: OK_REVIEW,
    verdict: { real: true, why: 'holds', fix: 'a detail' },        // no changesApproach
    planfix: { approachChanged: true, applied: ['x'] },            // the editor says otherwise
  })
  assert.equal(counts['codex-plan-review#2'], undefined,
    'the editor does not get to buy a Codex pass')
})

test('the re-review is handed the triage decisions, so a dismissal is answerable by Codex', async () => {
  // The triage is the only judgement in the run with nothing reviewing it. A COLD re-read cannot
  // tell that a finding was dismissed, let alone whether the reason given was fair — so pass 2
  // gets pass 1's findings plus what the triage did with each one.
  const planfix = { applied: ['reworked the error path so the versions table survives'] }
  const { prompts } = await run({
    review: (pass) => ({ ran: true, findings: pass === 1 ? F(2) : [] }),
    verdict: (_p, i) => i === 1
      ? { real: true, why: 'confirmed', fix: 'rework the error path', changesApproach: true }
      : { real: false, why: 'misreads the template, the fragment is re-rendered' },
    planfix,
  })
  const first = prompts['codex-plan-review#1']
  const second = prompts['codex-plan-review#2']

  assert.doesNotMatch(first, /THIS IS A RE-REVIEW/, 'the first pass has no prior decisions to grade')
  assert.match(second, /THIS IS A RE-REVIEW/)
  assert.match(second, /\[major\]\[coverage\] finding 1/, "pass 1's own findings must be carried over")
  assert.ok(second.includes(planfix.applied[0]), 'the accepted fix must be named so Codex can check it landed')
  // The dismissal reason now comes from the judge that made it, so what Codex is asked to
  // adjudicate is the actual evidence rather than a paraphrase by the agent editing the plan.
  assert.ok(second.includes('finding 2 — misreads the template, the fragment is re-rendered'),
    'the dismissal and its reason must be named so Codex can push back')
})

test('the Codex plan review pins --effort medium, so it stays inside the foreground window', async () => {
  // At high this step measured 16-26 minutes and spilled past the ~600s Bash cap into the
  // background-collection path — the slowest and most failure-prone way to get the same critique.
  const { prompts } = await run({ review: OK_REVIEW, planfix: OK_FIX })
  assert.match(prompts['codex-plan-review#1'], /--effort medium/)
  assert.doesNotMatch(prompts['codex-plan-review#1'], /--effort high/)
})

// ------------------------------------------------------------------- halts ------

test('Codex plan review unavailable is a hard stop — no stand-in reviewer', async () => {
  const { out } = await run({ review: { ran: false, findings: [], note: 'codex CLI missing' } })
  assert.equal(out.stopped, 'codex-plan-review-unavailable')
})

test('no source in args stops before anything is spawned', async () => {
  const { out, counts } = await run({ args: {} })
  assert.equal(out.stopped, 'no-source')
  assert.deepEqual(counts, {})
})

test('every explorer dead => refuses to plan against unread code', async () => {
  const { out, counts } = await run({ overrides: { explore: null } })
  assert.equal(out.stopped, 'explore-blocked')
  assert.equal(counts['explore#1:controller + templates'], 3) // reliable() retried, bounded at 3
})

test('build red from PRE-EXISTING failures only is surfaced, never fixed', async () => {
  const { out, counts } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    build: () => ({ green: false, preExistingFailures: 'LegacyPricingTest', failures: 'x' }),
  })
  assert.equal(out.stopped, 'build-red-preexisting')
  assert.equal(out.preExisting, 'LegacyPricingTest')
  assert.equal(counts['build-fix#1'], undefined) // never handed to a fixer
})

// The baseline build certifies the whole run (the caller banks it as `buildGreen`), so it stays
// clean and full-reactor. A RETRY only re-checks a surgical fix to code this run just wrote, and
// on a multi-module reactor rebuilding everything to re-run one module's tests is most of what
// the retry costs — so retries are scoped. What a scoped build can't see is a downstream module
// the change broke; the review's own full build catches that before anything merges.
test('the baseline build is clean, full-reactor, and never scoped', async () => {
  const { prompts } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    build: (n) => ({ green: n > 1, inScopeFailures: n === 1 ? 'RateSheetImportTest' : '' }),
  })
  assert.match(prompts['build#1'], /Run the build `mvn clean package`/)
  assert.doesNotMatch(prompts['build#1'], /-pl /)
})

test('a build RETRY is incremental and scoped to the changed modules', async () => {
  const { prompts } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    build: (n) => ({ green: n > 1, inScopeFailures: n === 1 ? 'RateSheetImportTest' : '' }),
  })
  assert.match(prompts['build#2'], /Run the build `mvn package`/)
  assert.match(prompts['build#2'], /-pl <the modules holding the changed files> -am/)
  assert.match(prompts['build#2'], /single-module, run it unscoped/)  // the escape hatch
})

test('the build fixer runs at the implementers\' pinned depth, not the entry point\'s', async () => {
  const { optsBy } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    build: (n) => ({ green: n > 1, inScopeFailures: n === 1 ? 'RateSheetImportTest' : '' }),
  })
  assert.equal(optsBy['build-fix#1'].model, optsBy['implement:backend'].model)
  assert.equal(optsBy['build-fix#1'].effort, optsBy['implement:backend'].effort)
})

test('in-scope red build is bounded at 3 attempts, then stops', async () => {
  const { out, counts } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    build: () => ({ green: false, inScopeFailures: 'RateSheetImportTest' }),
  })
  assert.equal(out.stopped, 'build-red')
  assert.equal(counts['build#3'], 1)
  assert.equal(counts['build#4'], undefined)
})

// ------------------------------------------- regression locks: dead-agent leaks --

test('REGRESSION: implementers that all die (thrown) stop the run instead of building nothing', async () => {
  // parallel() resolves a throwing thunk to null. blocked(null) used to be FALSE, so the run
  // walked past `impls.every(blocked)` and went on to build code that nobody had written.
  const { out, counts } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    overrides: { implement: THROW },
  })
  assert.equal(out.stopped, 'implement-blocked')
  assert.equal(counts['build#1'], undefined)
})

test('implementers that return null are retried, then stop the run', async () => {
  const { out, counts } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    overrides: { implement: null },
  })
  assert.equal(out.stopped, 'implement-blocked')
  assert.equal(counts['implement:backend'], 3)
})

test('an implementer that says the plan is wrong is surfaced, not worked around', async () => {
  const { out } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    overrides: { implement: { done: false, summary: '', blockedOn: 'the plan targets a deleted class' } },
  })
  assert.equal(out.stopped, 'implement-blocked')
  assert.match(out.detail, /deleted class/)
})

// -------------------------------------------- red-before-green must be observed --

test('the plan tags every test RED/GREEN and the implementers must RUN them to prove it', async () => {
  // A plan claimed red-before-green for tests that already passed; only the full-tier Codex plan
  // review noticed. An assertion in a plan is not evidence — the observation is.
  const { prompts } = await run({ review: OK_REVIEW, planfix: OK_FIX })
  assert.match(prompts['planner'], /\[RED\]/)
  assert.match(prompts['planner'], /\[GREEN\]/)
  assert.match(prompts['implement:backend'], /RUN each new test BEFORE/)
  assert.match(prompts['implement:backend'], /testEvidence/)
  assert.match(prompts['codex-plan-review#1'], /tagged RED must be one/)
})

test('the handoff carries the observed test evidence, not the plan\'s claim about it', async () => {
  const { out } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    overrides: { implement: { done: true, summary: 'done', filesChanged: ['A.java'],
      testEvidence: ['ImportTest#rejectsEmpty — before: RED (expected 1 version, was 0) — after: GREEN'] } },
  })
  assert.equal(out.testEvidence.length, 1)
  assert.match(out.testEvidence[0], /before: RED/)
})

// ------------------------------------------------- regression locks: the branch --

test('REGRESSION: a run that never left the base branch STOPS — branch === base is impossible', async () => {
  // Observed on issue #90: the branch agent failed to cut the feature branch, honestly reported
  // the branch it was on ("main"), and nothing checked. The handoff came back {branch:'main',
  // base:'main'} with buildGreen:true, so the caller committed onto main and went to merge main
  // into itself. BRANCH.onBranch is a plain string — being non-empty proved nothing.
  const { out, counts, logText } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    overrides: { branch: { onBranch: 'main' } },
  })
  assert.equal(out.stopped, 'branch-not-created')
  assert.notEqual(out.branch, 'main')
  assert.equal(counts['branch'], 1)
  assert.equal(counts['branch-retry'], 1)     // one bounded retry before giving up
  assert.equal(counts['implement:backend'], undefined) // nothing was implemented on base
  assert.match(logText, /still on main/)
})

test('a branch attempt that lands on base is retried once, and the retry can save the run', async () => {
  const { out, counts } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    overrides: { 'branch-retry': { onBranch: 'issue-81-import' }, branch: { onBranch: 'main' } },
  })
  assert.equal(out.stopped, undefined)
  assert.equal(out.branch, 'issue-81-import')
  assert.equal(counts['branch-retry'], 1)
})

test('an unusable branch name from Phase 0 is replaced, never silently resolved to base', async () => {
  const { out, prompts, logText } = await run({
    source: baseSource({ branch: '' }),
    review: OK_REVIEW, planfix: OK_FIX,
    overrides: { branch: { onBranch: 'issue-81-import' } },
  })
  assert.equal(out.stopped, undefined)
  assert.match(prompts['branch'], /issue-81-import/)
  assert.match(logText, /unusable branch name/)
})

test('the branch agent is asked for the branch git is REALLY on, not the one it intended', async () => {
  const { prompts } = await run({ review: OK_REVIEW, planfix: OK_FIX })
  assert.match(prompts['branch'], /rev-parse --abbrev-ref HEAD/)
})

test('REGRESSION: no build tool reports buildGreen "n/a", never a green build that never ran', async () => {
  const { out } = await run({
    source: baseSource({ buildTool: 'none' }),
    review: OK_REVIEW, planfix: OK_FIX,
  })
  assert.equal(out.stopped, undefined)
  assert.equal(out.buildGreen, 'n/a')
  assert.notEqual(out.buildGreen, true)
})

// ---------------------------------------------------------------- arg parsing ---

test('a JSON-string arg is parsed, not silently read as undefined options', async () => {
  const { out } = await run({
    args: JSON.stringify({ source: '#81', profile: 'light' }),
    source: baseSource({ profile: 'light', exploreAspects: ['one'] }),
  })
  assert.equal(out.profile, 'light')
})

test('a bare non-JSON string arg is recovered as the task source', async () => {
  const { out } = await run({ args: '#81', review: OK_REVIEW, planfix: OK_FIX })
  assert.equal(out.stopped, undefined)
  assert.equal(out.branch, 'issue-81-import')
})

test('resume: a plan already at "implementing" skips planning and plan-review', async () => {
  const { out, counts, logText } = await run({
    source: baseSource({ planStatus: 'implementing', branchExists: true }),
  })
  assert.equal(counts['planner'], undefined)
  assert.equal(counts['codex-plan-review#1'], undefined)
  assert.equal(out.planReview.ran, false)
  assert.match(logText, /resuming/)
})

// ------------------------------------------------- agent() throws, not just dies ---
// Every test below pins a real failure from the avtoportal run of 2026-07-27/28, where a
// six-agent workflow died with `TelemetrySafeError: agent({schema}): StructuredOutput retry cap
// (5) exceeded` and the same task then burned two more attempts on the recovery path.

test('REGRESSION: a planner that THROWS is retried, not fatal to the run', async () => {
  // The planner is a bare `await reliable(...)`, not inside parallel(), so its throw used to
  // propagate straight out of the script and end the workflow — status `failed`, nothing written,
  // an hour of the task's wall-clock lost to an infrastructure error. reliable() now traps it, so
  // the worst case is a bounded 3 attempts and an honest `planner-blocked`.
  const { out, counts, logText } = await run({
    review: OK_REVIEW, planfix: OK_FIX, overrides: { planner: THROW },
  })
  assert.equal(counts['planner'], 3, 'a throwing planner gets all 3 reliable() attempts')
  assert.equal(out.stopped, 'planner-blocked', 'and stops the run honestly rather than killing it')
  assert.match(logText, /planner: threw on attempt 1\/3/)
})

test('a planner that throws ONCE still produces a plan on the retry', async () => {
  // The point of trapping the throw: a transient schema/budget failure costs one attempt, not the
  // run. This is the case that actually happened — the third full attempt succeeded unaided.
  const { out, counts } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    overrides: { planner: (n) => { if (n === 1) throw new Error('StructuredOutput retry cap (5) exceeded'); return PLAN_TEXT } },
  })
  assert.equal(counts['planner'], 2)
  assert.equal(out.stopped, undefined, 'the run reaches the handoff on the retry')
})

test('an explorer that THROWS inside parallel() still gets its 3 reliable() attempts', async () => {
  // The explore fan-out is parallel(… () => reliable(… agent(…))). parallel() converts a thrown
  // thunk to null ABOVE the retry loop, so a throw used to cost the explorer all three attempts
  // silently. With the throw trapped inside reliable(), the retries happen where they were meant to.
  const { counts } = await run({
    review: OK_REVIEW, planfix: OK_FIX, overrides: { 'explore#1:controller': THROW },
  })
  assert.equal(counts['explore#1:controller + templates'], 3)
})

// ----------------------------------------- the plan on disk beats the scribe's opinion ---

test('REGRESSION: plan-write reporting failure over an INTACT file does not stop the run', async () => {
  // What happened: the scribe wrote a complete 247-line plan, miscounted its own body by two
  // lines against the header boundary, and returned written=false. The run stopped at
  // 'plan-not-written' — and resuming replayed that cached verdict, so the same good plan was
  // discarded twice. The disk is the source of truth now, which also makes the step idempotent.
  const { out, counts, logText } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    overrides: { 'plan-write': { written: false, path: '.task-plans/x.md', note: 'counted 242, stated 244' } },
  })
  assert.equal(counts['plan-check'], 1, 'the run checks the file before believing the self-report')
  assert.equal(out.stopped, undefined, 'an intact plan continues the run')
  assert.match(logText, /the plan is intact, continuing/)
})

test('plan-write failure with a TRUNCATED file still stops the run', async () => {
  // The check must not become a rubber stamp: a last line that is not the planner's last line is
  // exactly the truncation the verify step exists to catch, and it still halts.
  const { out } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    overrides: {
      'plan-write': { written: false, path: '.task-plans/x.md' },
      'plan-check': { exists: true, lastLine: '## Coverage cont' },
    },
  })
  assert.equal(out.stopped, 'plan-not-written')
})

test('plan-write failure with a MISSING file stops the run', async () => {
  const { out } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    overrides: {
      'plan-write': { written: false, path: '.task-plans/x.md' },
      'plan-check': { exists: false },
    },
  })
  assert.equal(out.stopped, 'plan-not-written')
})

test('a plan-check that itself dies leaves the halt in place', async () => {
  // No evidence the file is good is not the same as evidence it is good — an unreadable check
  // must fall back to the conservative answer, not to "probably fine".
  const { out } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    overrides: { 'plan-write': { written: false, path: '.task-plans/x.md' }, 'plan-check': null },
  })
  assert.equal(out.stopped, 'plan-not-written')
})

// --------------------------------------------- the planner returns text, not a schema ---

test('the planner is dispatched with NO schema — the plan never round-trips through JSON', async () => {
  // A ~250-line markdown document wrapped in {planMarkdown: string} is the largest structured
  // payload in the run and the one that blew the retry cap. A schema-less agent returns its final
  // text verbatim, so the document has no escaping to survive.
  const { optsBy } = await run({ review: OK_REVIEW, planfix: OK_FIX })
  assert.equal(optsBy['planner'].schema, undefined)
  assert.equal(optsBy['planner'].agentType, 'Plan', 'still the architect type, just unschema-d')
})

test('the planner CANNOT write — the file lands via a separate sandboxed scribe', async () => {
  // The invariant, not a style preference. At full tier the whole premise is that Codex challenges
  // the plan BEFORE any code exists, and nothing downstream could catch a planner that jumped the
  // gun: the plan review reads the plan FILE, not the working tree, and the first `git diff` anyone
  // looks at is after the implementers have run. The `Plan` type has no Edit/Write tool and its
  // built-in system prompt bans redirect operators and heredocs outright, so "don't write code" is
  // structural here rather than a sentence in a prompt that nothing verifies.
  const { optsBy, prompts } = await run({ review: OK_REVIEW, planfix: OK_FIX })
  assert.equal(optsBy['planner'].agentType, 'Plan')
  assert.equal(optsBy['plan-light'], undefined)
  assert.match(prompts['planner'], /You are read-only: return the plan, do not write it/)
  // The write is its own step, on a cheap type that only ever touches the plan file.
  assert.equal(optsBy['plan-write'].model, 'sonnet')
  assert.match(prompts['plan-write'], /Do not edit any\s+other file/)
})

test('the LIGHT planner is general-purpose, and that is only safe because light has no plan review', async () => {
  // Worth stating rather than assuming: the structural read-only guarantee covers the standard/full
  // planner, not this one — `plan-light` has always run on a `*`-tools type. It happens to be the
  // tier where it does not matter: light runs no Codex plan review, so there is no "challenge the
  // approach before code exists" premise for an early write to violate, and the tier's own
  // definition is a change that cannot alter behavior. If a plan review is ever added at light,
  // this is the line that has to move first.
  const { optsBy, prompts, counts } = await run({
    source: baseSource({ profile: 'light', uiTouched: false }),
  })
  assert.equal(optsBy['plan-light'].agentType, 'general-purpose')
  assert.equal(counts['plan-write'], 1, 'the write is still a separate step, not folded in')
  assert.match(prompts['plan-light'], /YOUR ENTIRE FINAL MESSAGE IS THE PLAN/,
    'it is told to return the plan, not to write it')
})

test('the light-tier planner is schema-less too', async () => {
  const { optsBy } = await run({ source: baseSource({ profile: 'light', uiTouched: false }) })
  assert.equal(optsBy['plan-light'].schema, undefined)
})

test('an empty or whitespace-only plan is treated as no plan', async () => {
  // The trade for dropping the schema is that nothing structurally guarantees a payload, so the
  // guard has to. A blank final message is a dead planner wearing a string.
  for (const empty of ['', '   \n  ']) {
    const { out } = await run({ review: OK_REVIEW, planfix: OK_FIX, overrides: { planner: empty } })
    assert.equal(out.stopped, 'planner-blocked', `"${empty}" must not pass as a plan`)
  }
})

test('the planner is told its whole final message IS the plan', async () => {
  // Without a schema field, a preamble line becomes a line of the plan — the scribe copies it
  // verbatim and Codex reviews it. Cheap to prevent in the prompt, invisible if not.
  const { prompts } = await run({ review: OK_REVIEW, planfix: OK_FIX })
  assert.match(prompts['planner'], /YOUR ENTIRE FINAL MESSAGE IS THE PLAN/)
  assert.match(prompts['planner'], /no\s+preamble/)
  assert.match(prompts['plan-light'] ?? '', /^$/, 'the full tier does not dispatch the light planner')
})

// ------------------------------------------------ the brief never round-trips through JSON ---
// Measured on three runs: an 8k-char brief plus a riskFlags parameter serialized malformed, the
// parser folded riskFlags INTO brief, and validation rejected the call with "must have required
// property 'riskFlags'" five times in a row. The tests below lock the two halves of the fix — the
// payload no longer goes through a schema, and a brief that comes back empty-handed can no longer
// pass itself off as exploration.

test('explorers are dispatched with NO schema — the brief never round-trips through JSON', async () => {
  const { optsBy } = await run({ review: OK_REVIEW, planfix: OK_FIX })
  assert.equal(optsBy['explore#1:controller + templates'].schema, undefined)
  assert.equal(optsBy['explore#1:controller + templates'].agentType, 'Explore')
})

test('REGRESSION: a "test"-sized brief is a failed explorer, not a short one', async () => {
  // What happened: an explorer that had blown four StructuredOutput calls escaped the cap on the
  // fifth by probing with {"brief":"test","riskFlags":[]} — which validates. The old truthiness
  // check passed it through, so the planner was handed the word "test" as one of its code maps
  // and that explorer's empty riskFlags voted in the tier decision. Nothing logged it.
  const { out, counts } = await run({ overrides: { explore: 'test\nRISKFLAGS: []' } })
  assert.equal(out.stopped, 'explore-blocked', 'a stub brief must not count as a read of the code')
  assert.equal(counts['explore#1:controller + templates'], 3, 'and it is re-dispatched like any death')
})

test('one dead slice is survivable, but the partial code map is on the record', async () => {
  const { out, logs, logText } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    overrides: { 'explore#2': 'test' },       // slice 2 gives up; slice 1 is fine
  })
  assert.equal(out.stopped, undefined, 'the run continues on the briefs it did get')
  assert.match(logText, /1 of 2 explorer slice\(s\) came back unusable/)
  assert.match(logs.join('\n'), /existing tests/, 'the log names the slice nobody explored')
})

test('the risk flags ride out on a trailer line the script parses', async () => {
  const flag = { surface: 'auth', where: 'SecurityConfig.java:12', why: 'adds a role check' }
  const { out } = await run({
    args: { source: '#81', classifyOnly: true },
    source: baseSource({ profile: 'standard', exploreAspects: ['one'] }),
    overrides: { explore: `${BRIEF_TEXT}\nRISKFLAGS: [${JSON.stringify(flag)}]` },
  })
  assert.equal(out.profile, 'full', 'a trailer flag still escalates the tier')
  assert.deepEqual(out.riskFlags, [flag])
})

test('a missing or unparsable trailer costs the flags, never the brief', async () => {
  for (const [tail, why] of [['', 'no trailer at all'], ['\nRISKFLAGS: [{oops', 'a truncated array']]) {
    const { out, logText } = await run({
      args: { source: '#81', classifyOnly: true },
      source: baseSource({ profile: 'standard', exploreAspects: ['one'] }),
      overrides: { explore: BRIEF_TEXT + tail },
    })
    assert.equal(out.profile, 'standard', why)
    assert.match(logText, /no parsable RISKFLAGS line/,
      'a vote that was never cast must not read as "no risk here"')
  }
})

test('"RISKFLAGS: none" is the empty answer, and is not reported as a lost vote', async () => {
  // The common case is genuinely no risk. If that answer looked like a parse failure, every clean
  // exploration would file a warning and the warning would stop meaning anything.
  const { out, logText } = await run({
    args: { source: '#81', classifyOnly: true },
    source: baseSource({ profile: 'standard', exploreAspects: ['one'] }),
    overrides: { explore: `${BRIEF_TEXT}\nRISKFLAGS: none` },
  })
  assert.equal(out.profile, 'standard')
  assert.doesNotMatch(logText, /no parsable RISKFLAGS line/)
})

test('the explorer is told its reply IS the brief, with the flags on the last line', async () => {
  const { prompts } = await run({ review: OK_REVIEW, planfix: OK_FIX })
  const explore = prompts['explore#1:controller + templates']
  assert.match(explore, /Your reply IS the brief/)
  assert.match(explore, /RISKFLAGS: \[/)
})

test('the explorer label carries its slice index, so the one that died is identifiable', async () => {
  // Three explorers on one task routinely share an opening phrase ("Map the calculator…"), and
  // slice(0, 24) made three identical rows in the progress tree.
  const { counts } = await run({ review: OK_REVIEW, planfix: OK_FIX })
  assert.equal(counts['explore#1:controller + templates'], 1)
  assert.equal(counts['explore#2:existing tests'], 1)
})

// ------------------------------------------- model tiers, not just effort ---
// These pinned `effort` but not MODEL, so a step marked "nothing to judge" still ran on whatever
// the session was on. The split: what only echoes a command runs cheapest; the git step does not,
// because it has to report reality rather than its own intent.

test('the pure command-runners run on haiku', async () => {
  const { optsBy } = await run({
    review: OK_REVIEW, planfix: OK_FIX,
    overrides: { 'plan-write': { written: false, path: '.task-plans/x.md' } },
  })
  for (const l of ['plan-check', 'stats']) {
    assert.equal(optsBy[l].model, 'haiku', `${l} runs one fixed command and reports its output`)
  }
})

test('the branch step is sonnet, NOT the echo tier', async () => {
  // It must report the branch the repo is REALLY on, not the one it was asked to create — the
  // distinction issue #90 turned on. The equality-vs-base guard catches a wrong answer, but a model
  // likelier to echo its own intent leans on that guard harder than it should.
  const { optsBy } = await run({ review: OK_REVIEW, planfix: OK_FIX })
  assert.equal(optsBy['branch'].model, 'sonnet')
  assert.equal(optsBy['branch'].effort, 'low', 'cheap, just not the cheapest')
})

test('the plan scribe stays sonnet/medium — it transcribes a document verbatim', async () => {
  // The one cheap step that is NOT an echo: a paraphrased or truncated plan silently degrades the
  // Codex review and every implementer that reads it.
  const { optsBy } = await run({ review: OK_REVIEW, planfix: OK_FIX })
  assert.equal(optsBy['plan-write'].model, 'sonnet')
  assert.equal(optsBy['plan-write'].effort, 'medium')
})

test('every judging track still keeps its own model and depth', async () => {
  const { optsBy } = await run({ review: OK_REVIEW, planfix: OK_FIX, verdict: MIXED })
  assert.equal(optsBy['planner'].model, 'opus')
  assert.equal(optsBy['planner'].effort, 'xhigh')
  assert.equal(optsBy['implement:backend'].model, 'opus')
  for (const l of ['source', 'judge#1.1:coverage', 'plan-fix#1', 'build#1']) {
    assert.equal(optsBy[l].model, undefined, `${l} classifies — it must not be down-tiered`)
  }
})
