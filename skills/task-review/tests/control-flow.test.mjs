// Control-flow tests for task-review.workflow.js.
//
// The script is pure orchestration — every side effect goes through agent()/parallel(), which
// the runtime injects. So it can be executed here with those stubbed, and the BRANCHES can be
// asserted directly: what halts the run, what is retried, what reaches the returned summary.
//
// The class of bug most of these lock down: a subagent that DIES resolves agent() to `null`,
// and unguarded a null reads as a good result at every call site not wrapped in reliable(). A dead
// track is then byte-identical to a clean one, which is the single failure this pipeline is least
// able to detect and most damaged by — an unattended caller banks it as verified.
//
// Death has a second shape: agent() also REJECTS (a StructuredOutput retry cap, an exhausted
// token budget), and an untrapped throw ends the whole script rather than the step. reliable()
// traps it and re-dispatches, so both shapes converge on the same bounded retry.
//
//   run:  node --test <pack>/skills/task-review/tests/control-flow.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const WF = path.join(import.meta.dirname, '..', 'task-review.workflow.js')
const SRC = fs.readFileSync(WF, 'utf8').replace('export const meta', 'const meta', 1)

// Top-level `return` is legal inside the async IIFE the real runtime wraps the script in.
const makeWf = () => new Function('args', 'agent', 'parallel', 'phase', 'log',
  `return (async () => {\n${SRC}\n})()`)

const CHANGED = 'src/main/java/com/acme/RateSheetImporter.java'

function baseTriage(over = {}) {
  return {
    reviewNeeded: true, reason: 'source files changed',
    profile: 'full', uiTouched: false, hasTestApp: false,
    changeIntent: 'Stop a rejected rate-sheet import from wiping the versions table.',
    buildTool: 'maven', buildCmd: 'mvn clean package', buildCmdFast: 'mvn package',
    runnerAgent: 'r:maven-build-runner',
    changedFiles: [CHANGED], hasBackend: true, hasFrontend: false,
    ...over,
  }
}

const CLEAN = { ran: true, findings: [] }
const finding = (what = 'off-by-one on the last row') =>
  ({ file: CHANGED, line: 42, category: 'logic', what, real: true })

// `overrides` maps a label PREFIX to what that label returns — a value, or a function of the
// call count. Anything not overridden takes the happy-path default below.
async function run({ triage = baseTriage(), args = {}, overrides = {} } = {}) {
  const logs = []
  const prompts = {}
  const counts = {}
  const opts = {}
  const order = []
  const log = (m) => logs.push(m)
  const phase = () => {}
  const parallel = async (thunks) =>
    Promise.all(thunks.map(async (t) => { try { return await t() } catch { return null } }))

  const agent = async (prompt, o = {}) => {
    const l = o.label || ''
    counts[l] = (counts[l] || 0) + 1
    prompts[l] = prompt
    opts[l] = o
    order.push(l)
    for (const [prefix, val] of Object.entries(overrides)) {
      if (!l.startsWith(prefix)) continue
      return typeof val === 'function' ? val(counts[l]) : val
    }
    if (l === 'triage') return triage
    if (l === 'diff-pack') return { ok: true, path: '/tmp/review.patch', files: 1, lines: 40 }
    if (l === 'codex' || l === 'code-quality' || l.startsWith('find-bugs:')) return CLEAN
    if (l === 'fix-triage') return { correctness: [], readability: [], docDrift: [] }
    if (l === 'stats') return { ok: true }
    if (l.startsWith('build#') || l.startsWith('rebuild#')) return { green: true }
    if (l === 'local-scan') return { status: 'ok', changedCode: false }
    if (l.startsWith('end-verify#')) return CLEAN
    if (l === 'ui-deploy') return { ok: true, url: 'http://localhost:18080' }
    if (l === 'ui-functional' || l === 'ui-visual') return { ran: true, findings: [] }
    return {}
  }

  const wfArgs = args && typeof args === 'object' ? { packRoot: '/pack', ...args } : args
  const out = await makeWf()(wfArgs, agent, parallel, phase, log)
  return { out, logs, counts, prompts, opts, order, logText: logs.join('\n') }
}

// ---------------------------------------------------------------- happy paths ---

test('full tier, nothing found: reviewed, green, end-verify correctly skipped', async () => {
  const { out } = await run()
  assert.equal(out.reviewed, true)
  assert.equal(out.profile, 'full')
  assert.equal(out.build, 'green')
  assert.equal(out.localScan, 'ok')
  assert.equal(out.endVerify, 'skipped') // nothing was fixed and the scan changed nothing
  assert.deepEqual(out.tracksBlocked, [])
})

test('doc-only diff returns skipped, and skipped is NOT a halt', async () => {
  const { out } = await run({ triage: baseTriage({ reviewNeeded: false, reason: 'doc-only diff' }) })
  assert.equal(out.skipped, true)
  assert.equal(out.stopped, undefined)
  assert.match(out.reason, /doc-only/)
})

test('light tier skips the up-front fan-out but always end-verifies', async () => {
  const { out, counts, logText } = await run({ args: { profile: 'light' } })
  assert.equal(out.profile, 'light')
  assert.equal(counts['codex'], undefined)
  assert.equal(counts['find-bugs:security'], undefined)
  assert.equal(counts['code-quality'], undefined)
  assert.equal(counts['end-verify#1'], 1) // the sole review of a light change
  assert.equal(out.localScan, 'ok')       // static analysis is mandatory in EVERY tier
  assert.match(logText, /light tier/)
})

test('standard tier runs Codex --mode review + the security hunter only', async () => {
  const { out, counts, prompts, logText } = await run({ args: { profile: 'standard' } })
  assert.equal(out.profile, 'standard')
  // Security is the hunter standard keeps while trading away its siblings: a missed N+1 degrades
  // a page, a missed injection or authorization hole is exploitable and nothing later re-derives
  // it. The docs hunter also runs here, but outside the barrier — it feeds a list handed to the
  // user, so nothing downstream waits on it.
  assert.equal(counts['find-bugs:security'], 1)
  assert.equal(counts['find-bugs:docs'], 1)
  // The pattern hunters are what standard trades for the Codex read.
  assert.equal(counts['find-bugs:logic'], undefined)
  assert.equal(counts['find-bugs:runtime-and-failures'], undefined)
  assert.equal(counts['codex'], 1)               // a real Codex now reads the PRE-FIX diff
  assert.equal(counts['code-quality'], undefined)
  assert.equal(counts['end-verify#1'], 1)        // still unconditional: it reads the FINAL diff
  assert.equal(out.localScan, 'ok')
  assert.match(logText, /standard tier/)
  // The mode is the whole point of this tier's Codex pass — the lighter built-in reviewer, not
  // the strict adversarial one. It must reach the subagent as a literal command.
  assert.match(prompts['codex'], /--mode review/)
  // ...and the built-in reviewer hard-errors on trailing focus text, so the prompt has to say so.
  assert.match(prompts['codex'], /REJECTS trailing focus text/)
  // The end-verify must know a Codex already read the pre-fix diff, or it spends the pass
  // re-reporting findings that were already triaged and fixed.
  assert.match(prompts['end-verify#1'], /already read the PRE-FIX diff/)
  assert.doesNotMatch(prompts['end-verify#1'], /ONLY Codex review/)
  // Nothing reviewed readability at this tier, so the bucket must stay empty rather than be
  // back-filled from the other reports — /r:code-refactor would otherwise chase unflagged code.
  // Nothing reviewed readability at this tier, so no readability triage agent is spawned at all —
  // an empty bucket needs no adjudicating, and an agent given one would fill it from the other
  // reports and send /r:code-refactor after code no reviewer flagged.
  assert.equal(counts['fix-triage-readability'], undefined)
  assert.match(prompts['fix-triage'], /codex \(review\)/)
})

test('full tier keeps every hunter and the ADVERSARIAL codex — never the light reviewer', async () => {
  const { counts, prompts } = await run() // baseTriage is full, and no plan review is certified
  for (const h of ['logic', 'runtime-and-failures', 'security', 'docs']) {
    assert.equal(counts[`find-bugs:${h}`], 1, `full must dispatch the ${h} hunter`)
  }
  // The merged hunter must still own BOTH pattern files. Merging was a cost decision (two fresh
  // contexts re-reading the same diff for 0.37 fixes/run between them); dropping a pattern set
  // would make it a coverage decision, which it is not.
  assert.match(prompts['find-bugs:runtime-and-failures'], /concurrency-data-and-performance\.md/)
  assert.match(prompts['find-bugs:runtime-and-failures'], /silent-failures-and-java\.md/)
  assert.match(prompts['find-bugs:runtime-and-failures'], /single pass over the diff/)
  assert.equal(counts['codex'], 1)
  assert.equal(counts['code-quality'], 1)
  // The lock that matters: full's up-front pass must NOT silently downgrade to `--mode review`.
  // The two modes are different machines, and only the adversarial one challenges the approach.
  assert.doesNotMatch(prompts['codex'], /--mode review/)
  assert.match(prompts['codex'], /adversarial\/challenge review/)
  // Both triage halves run at full, because both their inputs exist.
  assert.equal(counts['fix-triage'], 1)
  assert.equal(counts['fix-triage-readability'], 1)
})

test('a caller that already had Codex review the PLAN gets the lighter up-front pass', async () => {
  // /r:task-run's full tier challenges the approach BEFORE any code exists — measured at ~24
  // findings raised and ~20 folded in, every run. Challenging it again over the finished diff is
  // the most duplicated expensive step in the chain, so the pass spends itself on the code instead.
  // Every other full-tier track is untouched.
  const { out, counts, prompts, logText } = await run({ args: { planReviewed: true } })
  assert.equal(out.profile, 'full')
  assert.match(prompts['codex'], /--mode review/)
  assert.doesNotMatch(prompts['codex'], /adversarial\/challenge review/)
  assert.match(logText, /already reviewed the PLAN/)
  for (const h of ['logic', 'runtime-and-failures', 'security', 'docs']) {
    assert.equal(counts[`find-bugs:${h}`], 1, `the ${h} hunter is unaffected`)
  }
  assert.equal(counts['code-quality'], 1)
})

test('planReviewed is fail-open — anything but an explicit true keeps the adversarial pass', async () => {
  for (const v of [undefined, false, 'yes', 1]) {
    const { prompts } = await run({ args: v === undefined ? {} : { planReviewed: v } })
    assert.match(prompts['codex'], /adversarial\/challenge review/,
      `planReviewed=${JSON.stringify(v)} must not buy the lighter pass`)
  }
})

test('a track the tier never dispatched is not reported as blocked', async () => {
  // `blocked(undefined)` is true, so without the dispatched-set check a tier-skipped track is
  // indistinguishable from a tool that died — telling the caller codex failed when it was simply
  // never asked to run.
  const { out } = await run({ args: { profile: 'standard' } })
  assert.deepEqual(out.tracksBlocked, [])
})

test('UI verification is gated on uiTouched in EVERY tier, full included', async () => {
  // This step is the most expensive thing in the pipeline (median 542s over 59 stored runs, two
  // `high` agents, up to six screenshots read back as images), so `full` must NOT force it
  // unconditionally. What routes a diff to `full` — auth, money, persistence, concurrency — says
  // nothing about whether a page changed, so on that gate a backend-only `full` run boots the
  // whole stack to grade pages the diff never touched. The evidence for a UI defect is a NEW rendered
  // result, and there is one only when a frontend file changed.
  for (const profile of ['standard', 'full']) {
    const backend = await run({ args: { profile }, triage: baseTriage({ hasTestApp: true }) })
    assert.equal(backend.counts['ui-deploy'], undefined, `${profile}: backend-only must not deploy`)
    assert.equal(backend.counts['ui-prewarm'], undefined, `${profile}: no UI => nothing to pre-warm`)
    assert.match(backend.logText, /no frontend change in this diff/)

    const frontend = await run({
      args: { profile },
      triage: baseTriage({ hasTestApp: true, uiTouched: true, hasFrontend: true }),
    })
    assert.equal(frontend.counts['ui-deploy'], 1, `${profile}: a frontend change must still verify`)
  }
})

// ------------------------------------------------------------ UI: the split ---
// Phase 7 is a deploy plus TWO halves, never one agent doing deploy + smoke test + screenshots +
// design critique end to end. Measured over 59 stored transcripts, that single agent is the
// largest serial block in the pipeline (median 542s, 66% of it model time over ~86 turns), and 0
// of those runs ever managed /test-app's own parallel fan-out, because subagents have no Agent
// tool. These lock the split.

test('the UI step deploys ONCE, then runs both halves', async () => {
  const { counts } = await run({ triage: baseTriage({ hasTestApp: true, uiTouched: true }) })
  assert.equal(counts['ui-deploy'], 1)
  assert.equal(counts['ui-functional'], 1)
  assert.equal(counts['ui-visual'], 1)
  assert.equal(counts['ui-verify'], undefined) // never one end-to-end agent
})

test('the two halves drive ISOLATED browser sessions', async () => {
  // One shared agent-browser session means one shared page and one shared viewport: the visual
  // half switching to iPhone 14 would silently reshape what the functional half is clicking.
  const { prompts } = await run({ triage: baseTriage({ hasTestApp: true, uiTouched: true }) })
  assert.match(prompts['ui-functional'], /AGENT_BROWSER_SESSION=ptr-func/)
  assert.match(prompts['ui-visual'], /AGENT_BROWSER_SESSION=ptr-visual/)
})

test('neither half may deploy or tear down — the orchestrator owns the stack', async () => {
  const { prompts } = await run({ triage: baseTriage({ hasTestApp: true, uiTouched: true }) })
  for (const l of ['ui-functional', 'ui-visual']) {
    assert.match(prompts[l], /ALREADY deployed/)
    assert.match(prompts[l], /Do NOT deploy, redeploy, restart\s+or tear down/)
    assert.match(prompts[l], /TEST_APP_BASE_URL="http:\/\/localhost:18080"/)
  }
})

test('both halves still invoke the REAL /test-app, each on its own scope', async () => {
  // The split must not become "two agents imitating a scan". Each half drives the real skill;
  // only the scope it is pointed at differs.
  const { prompts } = await run({ triage: baseTriage({ hasTestApp: true, uiTouched: true }) })
  assert.match(prompts['ui-functional'], /REAL \/test-app skill \(Skill tool\)/)
  assert.match(prompts['ui-functional'], /functional checks only/)
  assert.match(prompts['ui-visual'], /REAL \/test-app skill \(Skill tool\)/)
  assert.match(prompts['ui-visual'], /VISUAL pass only/)
})

test('the visual half carries a screenshot budget and the frontend-design lens', async () => {
  // Measured: a median of 7 screenshots per run, up to 35 — each an image read at high effort.
  // And frontend-design ran in only 11 of 59 runs, so it needs saying, not assuming.
  const { prompts } = await run({ triage: baseTriage({ hasTestApp: true, uiTouched: true }) })
  assert.match(prompts['ui-visual'], /SCREENSHOT BUDGET — at most 6/)
  assert.match(prompts['ui-visual'], /agent-browser batch/)
  assert.match(prompts['ui-visual'], /frontend-design/)
})

test('the verifiers are pinned at high, the deploy lower still', async () => {
  const { opts } = await run({ triage: baseTriage({ hasTestApp: true, uiTouched: true }) })
  assert.equal(opts['ui-functional'].effort, 'high')
  assert.equal(opts['ui-visual'].effort, 'high')
  assert.equal(opts['ui-deploy'].effort, 'medium')
  assert.equal(opts['ui-prewarm'].effort, 'low')
})

// The pins below are what makes the review's depth a property of the PIPELINE rather than of how
// it was invoked: the frontmatter's effort only applies via the Skill tool, and /r:gh-issues-fix calls
// this script by scriptPath. An unpinned agent there silently runs at the session's effort.

test('the Codex tracks run at wrapper depth — Codex does the reviewing, not the agent', async () => {
  const { opts } = await run({
    overrides: { codex: { ran: true, findings: [finding()] }, 'fix-triage': { correctness: [finding()], readability: [], docDrift: [] } },
  })
  assert.equal(opts['codex'].effort, 'medium')
  assert.equal(opts['end-verify#1'].effort, 'medium')
})

test('Phase 0 triage reads the diff into a schema, so it runs at medium', async () => {
  const { opts } = await run()
  assert.equal(opts['triage'].effort, 'medium')
})

test('fixers never run deeper than the implementers; the agents that JUDGE keep the top tier', async () => {
  const { opts } = await run({
    overrides: { 'fix-triage': { correctness: [finding()], readability: [], docDrift: [] } },
  })
  // A patch is strictly less than the plan-following change it patches, so this tracks IMPL_RUN in
  // task-run-implement.workflow.js as a ceiling — never above it.
  assert.equal(opts['fix-correctness'].effort, 'medium')
  // fix-triage decides what is a false positive — that judgement is re-formed by nothing
  // downstream, so it is never pinned below the inherited tier.
  assert.equal(opts['fix-triage'].effort, undefined)
  assert.equal(opts['code-quality'].effort, undefined)
  assert.equal(opts['local-scan'].effort, undefined)
})

test('every pattern hunter runs below the top tier, security included', async () => {
  // A pattern hunter is asked whether the diff matches shapes in the one reference file it was
  // handed — real judgement, but bounded by that file, unlike fix-triage (what is a false
  // positive?) or code-quality (what reads well?). Yield says the same: 0.71 / 0.31 fixes per run
  // against 0.79 for codex, which already runs at `medium` because Codex does its thinking.
  const { opts } = await run()
  assert.equal(opts['find-bugs:logic'].effort, 'high')
  assert.equal(opts['find-bugs:runtime-and-failures'].effort, 'high')
  // Doc drift is never auto-fixed — it resolves to a decision the USER owns — so this hunter
  // matches code against written statements rather than adjudicating anything.
  assert.equal(opts['find-bugs:docs'].effort, 'medium')
  // Asserted as 'high', never as undefined: r:bug-hunter-pattern's own frontmatter already pins
  // `high`, so an unpinned row would land at the right depth for the wrong reason and this
  // assertion would stay green on it. The pin is what makes the claim and the run agree — and what
  // holds this row still the day the agent's own frontmatter moves.
  assert.equal(opts['find-bugs:security'].effort, 'high')
})

test('the docs hunter is the one hunter pinned to a cheaper MODEL, not just a lower effort', async () => {
  // Every hunter agent carries `model: opus` in its frontmatter, so an effort pin alone leaves the
  // top model in place. That is right where a track adjudicates. The docs hunter does not: it
  // matches a diff against written statements, and its output is never auto-fixed, so a false
  // positive costs a user one read. The hunters that DO decide what is broken keep the tier.
  const { opts } = await run()
  assert.equal(opts['find-bugs:docs'].model, 'sonnet')
  assert.equal(opts['find-bugs:logic'].model, undefined)
  assert.equal(opts['find-bugs:runtime-and-failures'].model, undefined)
  assert.equal(opts['find-bugs:security'].model, undefined)
})

test('the pattern hunters use the lean sweep agent, never the single-bug investigator', async () => {
  // `r:bug-hunter` is the /r:code-bugs root-cause persona — reproduce first, trace the data flow —
  // and it fights this job: under it the median `logic` run reads twelve whole files before it
  // ever runs git diff. These hunters do a sweep, and the agent has to agree with the prompt.
  const { opts } = await run()
  for (const h of ['logic', 'runtime-and-failures', 'security']) {
    assert.equal(opts[`find-bugs:${h}`].agentType, 'r:bug-hunter-pattern',
      `the ${h} hunter must sweep, not investigate`)
  }
  // The docs hunter is the one specialist left: it reads the doc tree as well as the diff.
  assert.equal(opts['find-bugs:docs'].agentType, 'r:bug-hunter-docs')
})

test('the security hunter reads its own pattern file, not a bundled skill', async () => {
  // The failure this replaced: the track used to hand the bundled /security-review skill a scope
  // argument. That skill builds its diff from four bash commands substituted into its prompt
  // before the model ever runs, all pinned to `git diff origin/HEAD...`, and its body carries no
  // argument placeholder at all — so the argument was discarded and the track judged the branch
  // commits instead of this diff. 49 dispatches, 0 findings. Nothing may reach for it again.
  const { prompts } = await run()
  assert.match(prompts['find-bugs:security'], /references\/security\.md/)
  assert.match(prompts['find-bugs:security'], /Your categories: Injection & Untrusted Input/)
  assert.doesNotMatch(prompts['find-bugs:security'], /security-review/)
})

// ------------------------------------------------------ the shared diff pack ---
// Each hunter is a fresh context, so unpointed each derives the change itself — 10–17 shell calls
// apiece, and NOT to the same answer: stored runs show `git diff HEAD`, `git diff` and
// `git diff origin/main..HEAD` inside one review. Capturing it once answers the cost and the
// disagreement together.

test('the diff is captured once, after triage, and every hunter is pointed at that file', async () => {
  const { counts, prompts, opts, order } = await run()
  assert.equal(counts['diff-pack'], 1)
  // AFTER triage: triage's `git add -N` is what makes an untracked new file visible to git diff
  // at all, so a capture taken any earlier would silently omit brand-new files.
  assert.ok(order.indexOf('triage') < order.indexOf('diff-pack'))
  assert.ok(order.indexOf('diff-pack') < order.indexOf('find-bugs:logic'))
  // Cheapest tier: it runs one fixed command and reports a path. It decides nothing.
  assert.equal(opts['diff-pack'].model, 'haiku')
  for (const h of ['security', 'logic', 'runtime-and-failures', 'docs']) {
    assert.match(prompts[`find-bugs:${h}`], /\/tmp\/review\.patch/,
      `the ${h} hunter must read the shared capture`)
    assert.match(prompts[`find-bugs:${h}`], /Do NOT re-derive it/)
  }
})

test('a failed capture falls back to fetch-it-yourself — it never blocks the scan', async () => {
  const { out, counts, prompts, logText } = await run({
    overrides: { 'diff-pack': { ok: false, reason: 'not a git repo' } },
  })
  assert.equal(out.reviewed, true)
  assert.equal(counts['find-bugs:logic'], 1)
  assert.match(prompts['find-bugs:logic'], /Run `git diff HEAD` yourself/)
  assert.match(logText, /did not produce a file/)
})

test('a DEAD capture agent is the same fallback, not a halt', async () => {
  const { out, prompts } = await run({ overrides: { 'diff-pack': null } })
  assert.equal(out.reviewed, true)
  assert.match(prompts['find-bugs:logic'], /Run `git diff HEAD` yourself/)
})

test('nothing is captured when there is no diff to capture, or no hunter to hand it to', async () => {
  const whole = await run({ args: { scope: 'all' } })
  assert.equal(whole.counts['diff-pack'], undefined)
  const light = await run({ args: { profile: 'light' } })
  assert.equal(light.counts['diff-pack'], undefined)
})

test('the codex wrapper is told not to re-review the diff itself', async () => {
  // Codex does the reviewing; the wrapper shells out and parses. Its own reading of the source
  // adds nothing to the critique and is measured at ~30k characters of tool output per run.
  const { prompts } = await run()
  assert.match(prompts['codex'], /Do not review the diff yourself/)
  assert.match(prompts['codex'], /git diff --stat` to name the scope is enough/)
})

test('a hunter that stops short is heard — its coverage note survives the merge', async () => {
  // The budget is only safe because a hunter must SAY when it ran out with something unconfirmed.
  // If the merge keeps only the security note, that admission vanishes, and silence from a finding
  // track reads as "looked, found nothing" — the one claim this pipeline must never manufacture.
  const { prompts } = await run({
    overrides: {
      'find-bugs:logic': { ran: true, findings: [], coverage: 'possible N+1 at OrderRepo:88, not confirmed' },
      'find-bugs:security': { ran: true, findings: [], coverage: 'read the captured diff; excludes DoS and capacity rate limiting' },
    },
  })
  // Both reach triage, and the security note still leads (skipped() tests it with an anchored ^).
  assert.match(prompts['fix-triage'], /excludes DoS/)
  assert.match(prompts['fix-triage'], /logic: possible N\+1 at OrderRepo:88/)
})

test('the hunt is ordered and bounded — diff first, then a budget', async () => {
  // The clauses that pay for themselves: cost here is turns × context, and the stored runs spent
  // both on orientation before the change was ever opened.
  const { prompts } = await run()
  for (const h of ['security', 'logic', 'runtime-and-failures']) {
    const p = prompts[`find-bugs:${h}`]
    assert.match(p, /Read the change FIRST/)
    assert.match(p, /about 12 tool calls/)
    assert.match(p, /offset\/limit/)
    // A budget that silently truncates the scan would be worse than no budget at all.
    assert.match(p, /NAME IT in 'coverage'/)
  }
})

test('the docs hunter is handed triage\'s doc list instead of re-globbing the tree', async () => {
  const { prompts } = await run({
    triage: baseTriage({ docFiles: ['CLAUDE.md', 'docs/spec.md'] }),
  })
  assert.match(prompts['find-bugs:docs'], /docs\/spec\.md/)
  assert.match(prompts['find-bugs:docs'], /do not spend shell calls re-discovering/)
})

test('no doc list from triage means the hunter locates them itself, as before', async () => {
  // Fail-open: an empty or missing list is a triage that found nothing to hand over, never an
  // instruction to skip the doc side of the check.
  const { prompts } = await run({ triage: baseTriage({ docFiles: [] }) })
  assert.match(prompts['find-bugs:docs'], /Glob over the filesystem/)
})

test('a failed deploy blocks the UI track — it never tests whatever is already running', async () => {
  const { out, counts, logText } = await run({
    triage: baseTriage({ hasTestApp: true, uiTouched: true }),
    overrides: { 'ui-deploy': { ok: false, reason: 'app unhealthy after 90s' } },
  })
  assert.equal(counts['ui-functional'], undefined)
  assert.equal(counts['ui-visual'], undefined)
  assert.equal(out.ui.ran, false)
  assert.equal(out.ui.blocked, true)
  assert.match(logText, /UI verification NOT run — deploy failed \(app unhealthy/)
  assert.equal(counts['ui-teardown'], 1) // teardown on ANY exit path, including this one
})

test('a dead half marks the UI track incomplete, not clean', async () => {
  const { out, logText, counts } = await run({
    triage: baseTriage({ hasTestApp: true, uiTouched: true }),
    overrides: { 'ui-visual': null },
  })
  assert.equal(out.ui.ran, false)
  assert.deepEqual(out.ui.blockedHalves, ['ui-visual'])
  assert.match(logText, /UI half BLOCKED — ui-visual/)
  assert.equal(counts['ui-functional'], 1) // the survivor's findings still flow through
})

test('findings are stamped with the half that found them', async () => {
  const { out, counts } = await run({
    triage: baseTriage({ hasTestApp: true, uiTouched: true }),
    overrides: {
      'ui-visual': { ran: true, findings: [{ title: 'nav clips on mobile', where: '/deals', fixSize: 'minor' }] },
    },
  })
  assert.equal(out.ui.ran, true)
  assert.equal(counts['ui-fix-minor'], 1)
  assert.equal(out.ui.minorFixed, 1)
})

test('a major finding is written to the issues/ backlog, never to a tracker', async () => {
  const { out, counts, prompts } = await run({
    triage: baseTriage({ hasTestApp: true, uiTouched: true }),
    overrides: {
      'ui-functional': { ran: true, findings: [{ title: 'checkout flow needs a redesign', where: '/checkout', fixSize: 'major' }] },
    },
  })
  assert.equal(counts['ui-file-major'], 1)
  assert.equal(counts['ui-fix-minor'], undefined) // nothing minor to fix
  assert.equal(out.ui.majorFiled, 1)
  assert.equal(out.ui.majorUnfiled, undefined)
  assert.match(prompts['ui-file-major'], /issues\/ui-review-<YYYY-MM-DD>\.md/)
  assert.doesNotMatch(prompts['ui-file-major'], /gh issue create/) // a local write, never a tracker
})

test('a filer that never returns is an UNFILED gap, not a filing', async () => {
  // The shape this step actually fails in: the agent dies before its first tool call, so nothing
  // reaches issues/. Derived from the `major` TAG alone, the summary would report it filed and
  // send the reader to a backlog entry that does not exist.
  const { out, logText } = await run({
    triage: baseTriage({ hasTestApp: true, uiTouched: true }),
    overrides: {
      'ui-functional': { ran: true, findings: [{ title: 'checkout flow needs a redesign', where: '/checkout', fixSize: 'major' }] },
      'ui-file-major': null,
    },
  })
  assert.equal(out.ui.majorFiled, 0)
  assert.equal(out.ui.majorUnfiled, 1)
  assert.match(logText, /issue filer did NOT come back/)
})

// ------------------------------------------------------------- UI: pre-warm ---

test('the image pre-warm is launched with the end-verify, not after it', async () => {
  // The docker build is 42% of the UI step's tool time, all of it on the critical path unless it
  // is started early. It only helps if it starts BEFORE the deploy that consumes its cache.
  const { counts, order } = await run({ triage: baseTriage({ hasTestApp: true, uiTouched: true }) })
  assert.equal(counts['ui-prewarm'], 1)
  assert.ok(order.indexOf('ui-prewarm') < order.indexOf('ui-deploy'))
})

test('REGRESSION: a failed pre-warm costs a cold build, never the review', async () => {
  // It is an optimisation. If it could halt or block the run it would be a liability, since it
  // runs concurrently with fixers that are still editing the code it builds.
  const { out, counts } = await run({
    triage: baseTriage({ hasTestApp: true, uiTouched: true }),
    overrides: { 'ui-prewarm': null },
  })
  assert.equal(out.reviewed, true)
  assert.equal(out.stopped, undefined)
  assert.equal(counts['ui-deploy'], 1)
  assert.equal(out.ui.ran, true)
})

test('an unrecognized profile falls back to full — nothing classified the diff', async () => {
  const { out } = await run({ args: { profile: 'medium' }, triage: baseTriage({ profile: 'nonsense' }) })
  assert.equal(out.profile, 'full')
})

test('a blocked hunter marks find-bugs incomplete instead of clean', async () => {
  const { out, logText } = await run({ overrides: { 'find-bugs:security': null } })
  assert.ok(out.tracksBlocked.includes('find-bugs'))
  assert.match(logText, /hunter\(s\) BLOCKED — security/)
})

test('at standard the blocked track is named for what actually ran, not "find-bugs"', async () => {
  // Reporting `r:code-bugs` blocked for a tier that never dispatched find-bugs tells the caller a
  // tool died when nothing did — and sends whoever reads the summary after the wrong failure.
  const { out, logText } = await run({
    args: { profile: 'standard' }, overrides: { 'find-bugs:security': null },
  })
  assert.ok(out.tracksBlocked.includes('security hunter'))
  assert.ok(!out.tracksBlocked.includes('find-bugs'))
  assert.match(logText, /security hunter: hunter\(s\) BLOCKED — security/)
})

test('a security hunter that read a DIFFERENT changeset is not a clean bill', async () => {
  // The failure this locks down: a hunter whose prepared capture was missing derives the change
  // itself, lands on a different changeset, and comes back real, complete, ran=true and
  // findings:[] — about code this review is not certifying. Alive is not the same as on-scope,
  // and only `scopeMatched` can tell them apart.
  const { out, logText } = await run({
    overrides: {
      'find-bugs:security': {
        ran: true, scopeMatched: false, findings: [],
        coverage: 'was handed the working-tree capture; judged the 8 unpushed branch commits instead',
      },
    },
  })
  assert.equal(out.security, 'scope-mismatch')
  assert.match(logText, /reviewed a DIFFERENT changeset than the one they were given — security/)
  // Distinct from BLOCKED on purpose: a dead tool has to be made to run, a drifted one has to be
  // made to read the right thing, and one log line for both sends the reader after the wrong fix.
  assert.ok(!/hunter\(s\) BLOCKED — security/.test(logText))
  // The RECORD has to make that same distinction, not just the log. Collapsed into tracksBlocked
  // this reads as "the bug scan failed" — sending a reader after a tool that is not broken, while
  // hiding that the pattern and docs hunters completed and produced findings.
  assert.deepEqual(out.tracksDrifted, ['find-bugs (security)'])
  assert.ok(!out.tracksBlocked.includes('find-bugs'))
})

test('a drifted track is still disqualifying — it just says so in its own field', async () => {
  // tracksDrifted is not a softer tracksBlocked. Both mean the change has a surface nothing
  // looked at, and issues-fix's merge gate reads both; only the fix each one asks for differs.
  const { out } = await run({
    overrides: {
      'find-bugs:security': { ran: true, scopeMatched: false, findings: [], coverage: 'read the branch commits' },
    },
  })
  assert.equal(out.reviewed, true)
  assert.ok(out.tracksDrifted.length > 0, 'the drift is recorded somewhere a caller can gate on')
})

test('a track that is BOTH blocked and drifted is named in both lists', async () => {
  // Two hunters failing two different ways is not one failure. Reporting only the first would
  // leave the other unfixed, and they need opposite fixes.
  const { out } = await run({
    overrides: {
      'find-bugs:security': { ran: true, scopeMatched: false, findings: [], coverage: 'wrong changeset' },
      'find-bugs:logic': null,
    },
  })
  assert.ok(out.tracksBlocked.includes('find-bugs'), 'the dead hunter still blocks the track')
  assert.deepEqual(out.tracksDrifted, ['find-bugs (security)'])
})

test('below full tier the drifted entry does not repeat the hunter it is already named for', async () => {
  const { out } = await run({
    args: { profile: 'standard' },
    overrides: {
      'find-bugs:security': { ran: true, scopeMatched: false, findings: [], coverage: 'wrong changeset' },
    },
  })
  assert.deepEqual(out.tracksDrifted, ['security hunter'])
  assert.ok(!out.tracksBlocked.includes('security hunter'))
})

test('a track with no hunter fan-out keeps landing in tracksBlocked', async () => {
  // codex, docs and code-quality are one agent each, not a fan-out, so they carry no hunter-level
  // detail. The split must not quietly drop them out of the list their failure has always been in.
  const { out } = await run({ overrides: { codex: null } })
  assert.ok(out.tracksBlocked.includes('codex'))
  assert.deepEqual(out.tracksDrifted, [])
})

test('scopeMatched absent leaves the track clean — an unanswered field invents no mismatch', async () => {
  // Fail-open, the same rule securitySurface uses. A hunter that did not check is a gap in the
  // record; reading it as a mismatch would block every run made before the field existed.
  const { out } = await run({
    overrides: { 'find-bugs:security': { ran: true, findings: [], coverage: 'reviewed the working-tree diff' } },
  })
  assert.ok(!out.tracksBlocked.includes('find-bugs'))
  assert.equal(out.security, 'clean')
})

test('the four security outcomes are distinguishable in the summary', async () => {
  // All four leave findings:[] behind. Collapsed, a run of dispatches that each returned nothing
  // cannot say whether the diffs were clean or the track never reports anything at all — the
  // question 49 dispatches of the previous tool could not answer.
  const gated = await run({ triage: baseTriage({ securitySurface: false }) })
  assert.equal(gated.out.security, 'not-dispatched')
  const dead = await run({ overrides: { 'find-bugs:security': null } })
  assert.equal(dead.out.security, 'blocked')
  const light = await run({ args: { profile: 'light' } })
  assert.equal(light.out.security, 'not-dispatched')
})

test('the docs hunter is reported on its own, because it runs outside the barrier', async () => {
  // It is still a dispatched track: a caller has to be able to see that nothing checked the change
  // against the documentation. Being off the critical path is not the same as being optional.
  const { out, logText } = await run({ overrides: { 'find-bugs:docs': null } })
  assert.ok(out.tracksBlocked.includes('docs'))
  assert.ok(!out.tracksBlocked.includes('find-bugs'), 'the blocking hunters were fine')
  assert.match(logText, /docs hunter track BLOCKED/)
  assert.match(logText, /coverage hole, not a clean bill/)
})

test('doc drift comes straight from the docs hunter, never through triage', async () => {
  // It is a list handed to the USER — never a fix, never an input to the build — so routing it
  // through a filter that cannot act on it only made the fix phase wait for it.
  const { out, prompts } = await run({
    overrides: {
      'find-bugs:docs': { ran: true, findings: [
        { file: 'README.md', line: 4, category: 'doc-drift', what: 'documents the old flag name' }] },
    },
  })
  assert.deepEqual(out.docDrift, ['README.md:4 documents the old flag name'])
  assert.doesNotMatch(prompts['fix-triage'], /docDrift/,
    'correctness triage must not be handed a bucket it does not own')
})

// --------------------------------------------- the security hunter's own gate ---
// The hunt is a full parallel subagent — 1.53M cache tokens and about 200s — matching a diff
// against injection sinks, authorization checks, credential handling and data exposure. On a CSS
// or copy diff there is no hunk any of those patterns can apply to, so the gate saves the whole
// dispatch. It fails OPEN, which matters more now that this track can actually return findings.

test('no security surface in the diff means the security hunter is not dispatched', async () => {
  const { counts, logText } = await run({ triage: baseTriage({ securitySurface: false }) })
  assert.equal(counts['find-bugs:security'], undefined)
  assert.equal(counts['find-bugs:docs'], 1)      // the other hunters are untouched
  assert.equal(counts['find-bugs:logic'], 1)
  assert.match(logText, /security hunter SKIPPED/)
  assert.match(logText, /this is a skip, not a clean bill/)
})

test('REGRESSION: the gate FAILS OPEN — an unanswered question runs the hunter', async () => {
  // securitySurface is optional on purpose. A model that forgets the field, or an older caller
  // that never knew about it, must not be the reason a security review silently stopped running.
  for (const t of [baseTriage(), baseTriage({ securitySurface: undefined }),
                   baseTriage({ securitySurface: true })]) {
    const { counts } = await run({ triage: t })
    assert.equal(counts['find-bugs:security'], 1)
  }
})

test('a skipped security hunter is reported as a SKIP, never as coverage', async () => {
  // findings:[] has three meanings — reviewed and clean, blocked, never asked. They must not
  // collapse into one, because only the first is a reason to merge.
  const { prompts } = await run({
    triage: baseTriage({ securitySurface: false }),
    overrides: { 'fix-triage': { correctness: [], readability: [], docDrift: [] } },
  })
  assert.match(prompts['fix-triage'], /NOT DISPATCHED/)
  assert.match(prompts['fix-triage'], /skip, not a clean bill/)
})

test('a security hunter closed by its per-diff gate is RECORDED as skipped', async () => {
  // Not cosmetic. The stats report derives a track's denominator from the TIER, so a skip it
  // cannot see counts as a run the hunter had a chance on and produced nothing — which is the
  // number that puts a track on the retirement list. `securitySurface` is the one gate that is
  // per-diff rather than per-tier, so it is the one the tier cannot account for.
  const { out } = await run({ triage: baseTriage({ securitySurface: false }) })
  assert.ok(out.tracksSkipped.includes('security'))
  assert.ok(!out.tracksBlocked.includes('security'), 'a closed gate is not a tool failure')

  // The other direction: a hunter that RAN must never be recorded as skipped, or the denominator
  // shrinks below what the track was actually asked to do and its fixes/run reads too high.
  const ran = await run({ triage: baseTriage({ securitySurface: true }) })
  assert.ok(!ran.out.tracksSkipped.includes('security'))
})

test('at standard with no security surface, no hunter is dispatched inside the barrier', async () => {
  // Both members of the standard set are gone — the security hunter by its own surface gate, the
  // docs hunter because it never belonged to this barrier. The name has to say that plainly rather
  // than report a tool failure.
  const { out, counts, logText } = await run({
    args: { profile: 'standard' },
    triage: baseTriage({ securitySurface: false }),
  })
  assert.equal(counts['find-bugs:security'], undefined)
  assert.equal(counts['find-bugs:docs'], 1, 'the docs hunter still runs, off the barrier')
  assert.deepEqual(out.tracksBlocked, [])
  assert.match(logText, /security hunter SKIPPED/)
})

test('the security hunter must report what it did NOT look for', async () => {
  // This track's empty result is the one that gets read as a verdict on the whole change, so its
  // brief has to name the boundary and not just the scope. The categories after "What NOT to
  // report" in security.md are real risks other tracks own; nobody may read findings:[] here as
  // "this change is secure".
  const p = (await run()).prompts['find-bugs:security']
  assert.match(p, /'coverage' MUST name what you did NOT look for/)
  for (const excluded of [/denial of service/i, /rate limiting/i, /not a clean bill of health/i]) {
    assert.match(p, excluded)
  }
})

// ------------------------------------------------- stats sink + attribution ---

test('correctness fixes are attributed to the track that found them', async () => {
  const { out, prompts } = await run({
    overrides: {
      'fix-triage': {
        correctness: [{ item: 'A.java:10 off-by-one', source: 'codex' },
                      { item: 'B.java:20 missing authz check', source: 'security' },
                      { item: 'C.java:30 unbounded fetch', source: 'concurrency' }],
        readability: [], docDrift: [],
      },
    },
  })
  assert.deepEqual(out.fixedBySource, { codex: 1, security: 1, concurrency: 1 })
  assert.equal(out.fixed.correctness, 3)
  // The fixer must see the item and NOT the source — knowing which track flagged something
  // should not colour how it gets fixed.
  assert.match(prompts['fix-correctness'], /off-by-one/)
  assert.doesNotMatch(prompts['fix-correctness'], /source/)
})

test('the hunters stamp their own label onto every finding they merge', async () => {
  // After the dedup merge, a security finding and a logic finding are otherwise identical in
  // shape — this stamp is the only thing that survives into the attribution.
  const { prompts } = await run({
    overrides: { 'find-bugs:security': { ran: true, findings: [finding('leaks a token')] } },
  })
  assert.match(prompts['fix-triage'], /"source":"security"/)
})

test('a triage that returns bare strings still yields a fixable list', async () => {
  // Attribution is worth less than the fix phase: a degraded/older-shaped response must not
  // crash the run, it must just lose the labels.
  const { out } = await run({
    overrides: { 'fix-triage': { correctness: ['A.java:10 off-by-one'], readability: [], docDrift: [] } },
  })
  assert.equal(out.fixed.correctness, 1)
  assert.deepEqual(out.fixedBySource, { unattributed: 1 })
})

test('end-verify fixes are attributed to end-verify', async () => {
  const { out } = await run({
    overrides: {
      'fix-triage': { correctness: [{ item: 'A.java:1 x', source: 'codex' }], readability: [], docDrift: [] },
      'end-verify#1': { ran: true, findings: [finding('regression from the fix')] },
      'end-verify#2': CLEAN,
    },
  })
  assert.equal(out.fixedBySource['end-verify'], 1)
  assert.equal(out.fixedBySource.codex, 1)
})

// --------------------------------------------------- Phase 3 writes one at a time ---
// These two fixers are scoped to the SAME changed files by construction, and they ran inside
// parallel(). The failure that motivated serializing them is silent by nature: the refactorer
// writes a file from a read taken before the correctness fix landed, the fix is gone, the build
// is still green, and the run reports it as fixed. Nothing downstream re-reads it — the full-tier
// end-verify is framed regression-only and told to skip anything already triaged.

const ONE_OF_EACH = {
  correctness: [{ item: 'A.java:10 off-by-one', source: 'codex' }],
  readability: ['A.java:1 extract a method'],
  docDrift: [],
}

test('REGRESSION: the readability refactor never runs while the correctness fixer is still editing', async () => {
  let readabilityStarted = false
  let overlapped = null
  const { counts, order } = await run({
    overrides: {
      // Hold the correctness fixer open across many microtask turns. Under parallel() both thunks
      // were invoked before either resolved, so the readability agent would have been dispatched
      // by the time this reads the flag. Serially it cannot have been.
      'fix-correctness': async () => {
        for (let i = 0; i < 20; i++) await Promise.resolve()
        overlapped = readabilityStarted
        return 'fixed 1 item'
      },
      'fix-readability': async () => { readabilityStarted = true; return 'refactored' },
      'fix-triage': ONE_OF_EACH,
    },
  })
  assert.equal(counts['fix-correctness'], 1)
  assert.equal(counts['fix-readability'], 1)
  assert.equal(overlapped, false, 'the readability refactor started while the correctness fixer still held the tree')
  // Correctness first is also the cheaper order: refactoring code that is about to be surgically
  // fixed is wasted work.
  assert.ok(order.indexOf('fix-correctness') < order.indexOf('fix-readability'))
})

test('REGRESSION: a correctness fixer that DIES is not counted as work the run completed', async () => {
  const { out, logText } = await run({
    overrides: { 'fix-triage': { ...ONE_OF_EACH, readability: [] }, 'fix-correctness': null },
  })
  // The triaged list is what someone was ASKED to do. Reporting it as done is the same
  // false-confidence failure serializing the fixers exists to prevent, by another route.
  assert.equal(out.fixed.correctness, 0)
  assert.deepEqual(out.fixedBySource, {})
  assert.match(logText, /correctness fixer DIED/)
  assert.match(logText, /off-by-one/)  // the lost items are named, not just counted
})

test('a readability refactor that dies costs polish only — correctness is unaffected', async () => {
  const { out, logText } = await run({
    overrides: { 'fix-triage': ONE_OF_EACH, 'fix-readability': null },
  })
  assert.equal(out.fixed.readability, 0)
  assert.equal(out.fixed.correctness, 1)
  assert.deepEqual(out.fixedBySource, { codex: 1 })
  assert.match(logText, /readability refactor DIED/)
})

test('a fixer that THROWS does not end a run with the build, scan and end-verify still to do', async () => {
  // parallel() converts a thrown thunk to null one level above these calls, but these are awaited
  // directly, so the catch has to be explicit — without it a StructuredOutput cap in a fixer takes
  // down a review that has not yet built, scanned or verified anything.
  const { out } = await run({
    overrides: {
      'fix-triage': ONE_OF_EACH,
      'fix-correctness': () => { throw new Error('structured-output retry cap') },
    },
  })
  assert.equal(out.reviewed, true)
  assert.equal(out.build, 'green')
  assert.equal(out.localScan, 'ok')
  assert.equal(out.fixed.correctness, 0)
})

// -------------------------------------------------------- reuse-index refresh ---
//
// The refresh is bookkeeping that runs at the END of the review on purpose: the fix phase above
// has just changed the code its anchors point at. These lock the two things that make it safe to
// have in the pipeline at all — it is dispatched, and it cannot take the review down with it.

test('the reuse-index refresh runs once, after the fix phase, at the mechanical tier', async () => {
  const { counts, opts, order } = await run()
  assert.equal(counts['reuse-index'], 1)
  // Sonnet/low: above the stats sink's haiku because merging a new entry is a judgement, far
  // below the hunters because on most runs there is nothing new to merge.
  assert.equal(opts['reuse-index'].model, 'sonnet')
  assert.equal(opts['reuse-index'].effort, 'low')
  assert.equal(opts['reuse-index'].agentType, 'general-purpose')
  // Ordering is the whole reason this step lives here rather than in run-task's implement half.
  assert.ok(order.indexOf('reuse-index') > order.indexOf('local-scan'),
    'the refresh must read the tree the fix phase and scan left behind, not the one before them')
})

test('the refresh is told to MERGE and to no-op without an index — never to create one', async () => {
  const { prompts } = await run()
  const p = prompts['reuse-index']
  assert.match(p, /reuse-index\/scripts\/reuse-index\.py/)
  assert.match(p, /--plans \.task-plans/)
  assert.match(p, /MERGE/)
  assert.match(p, /No index file[\s\S]*?you are done/)
  assert.match(p, /Do not create one/)
  assert.match(p, /[Nn]ever delete an entry silently\s+and never regenerate/)
  // It must never be mistaken for a fixer: this runs after end-verify, and an "improvement" here
  // would land unreviewed in the task's single commit.
  assert.match(p, /Never edit code here/)
})

test('a dead refresh (null) never fails the review', async () => {
  const { out } = await run({ overrides: { 'reuse-index': null } })
  assert.equal(out.reviewed, true)
  assert.equal(out.stopped, undefined)
  assert.equal(out.build, 'green')
  assert.deepEqual(out.tracksBlocked, [])
})

test('a THROWING refresh never fails the review either', async () => {
  const { out } = await run({
    overrides: { 'reuse-index': () => { throw new Error('no python3 on PATH') } },
  })
  assert.equal(out.reviewed, true)
  assert.equal(out.stopped, undefined)
  assert.deepEqual(out.tracksBlocked, [])
})

test('the refresh is not a track — it never appears in the stats row', async () => {
  const { prompts } = await run()
  const row = JSON.parse(prompts['stats'].match(/\{"kind":"review".*\}/)[0])
  assert.ok(!(row.findings || []).some((f) => (f.track || '').includes('reuse')),
    'bookkeeping is not a finding source; recording it would invent a track with no verdicts')
})

test('the stats row is written once, with counts rather than finding text', async () => {
  const { counts, prompts } = await run()
  assert.equal(counts['stats'], 1)
  const row = JSON.parse(prompts['stats'].match(/\{"kind":"review".*\}/)[0])
  assert.equal(row.kind, 'review')
  assert.equal(row.profile, 'full')
  assert.equal(row.build, 'green')
  assert.ok('fixedBySource' in row)
  assert.equal(typeof row.docDriftCount, 'number')  // a count, not the drift text
  assert.ok(!('docDrift' in row))
})

test('what triage REJECTED reaches the stats row, and never the fixer', async () => {
  // The whole point of recording dismissals: a track whose findings are all rejected scores the
  // same zero in `fixedBySource` as a track that found nothing. Only the verdicts separate a
  // noisy track (retire it) from a quiet one (it may just have had a clean diff).
  const { prompts } = await run({
    overrides: {
      // Listed first: `overrides` matches a label PREFIX, so the readability entry has to be
      // spelled out or the correctness stub answers for both agents.
      'fix-triage-readability': { readability: [], dismissed: [] },
      'fix-triage': {
        correctness: [{ item: 'RateSheetImporter:42 guard the last row', source: 'logic' }],
        dismissed: [{ item: 'RateSheetImporter:88 unreachable branch', source: 'security' }],
        readability: [], docDrift: [],
      },
    },
  })
  const row = JSON.parse(prompts['stats'].match(/\{"kind":"review".*\}/)[0])
  const kept = row.findings.filter((f) => f.verdict === 'confirmed')
  const dropped = row.findings.filter((f) => f.verdict === 'dismissed')
  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].track, 'security')
  assert.equal(dropped[0].fixed, false)
  assert.ok(kept.some((f) => f.track === 'logic' && f.fixed === true))
  // A rejected finding must not reach the agent that applies fixes — it was judged NOT real.
  assert.doesNotMatch(prompts['fix-correctness'] || '', /unreachable branch/)
})

test('appliedFindings returns the real findings for the plan, dismissed ones filtered out', async () => {
  // The caller (run-task) writes these into the plan file as a "## Post-review changes" section
  // so the tracked, index-linked plan records what the review CHANGED. A dismissed finding never
  // touched the code, so putting it in the plan would claim a change that did not happen — it must
  // be dropped here, exactly as it is kept OUT of the fixer. The stats row keeps counts; this
  // carries the finding bodies the plan needs, from the same roll-up.
  const { out } = await run({
    overrides: {
      'fix-triage-readability': { readability: [], dismissed: [] },
      'fix-triage': {
        correctness: [{ item: 'RateSheetImporter:42 guard the last row', source: 'logic' }],
        dismissed: [{ item: 'RateSheetImporter:88 unreachable branch', source: 'security' }],
        readability: [], docDrift: [],
      },
    },
  })
  assert.ok(Array.isArray(out.appliedFindings))
  assert.ok(out.appliedFindings.every((f) => f.verdict !== 'dismissed'),
    'a dismissed finding in the plan would record a change that never happened')
  const kept = out.appliedFindings.find((f) => f.track === 'logic')
  assert.ok(kept && kept.fixed === true && /guard the last row/.test(kept.description))
  assert.ok(!out.appliedFindings.some((f) => /unreachable branch/.test(f.description)))
})

test('a BLOCKED triage records no verdicts rather than "rejected nothing"', async () => {
  // Absence of a judgement and a judgement of zero rejections are different claims, and only one
  // of them is evidence about a track.
  const { prompts } = await run({ overrides: { 'fix-triage': null } })
  const row = JSON.parse(prompts['stats'].match(/\{"kind":"review".*\}/)[0])
  assert.equal(row.findings.filter((f) => f.verdict === 'dismissed').length, 0)
})

test('the row records whether the tier was FORCED, not just what it was', async () => {
  // Without this the tier distribution silently reports what someone typed as though the
  // classifier had decided it — and a forced re-review pollutes the classifier's own numbers.
  const forced = await run({ args: { profile: 'standard' } })
  const fRow = JSON.parse(forced.prompts['stats'].match(/\{"kind":"review".*\}/)[0])
  assert.equal(fRow.profileForced, true)
  assert.equal(fRow.invokedBy, 'direct')

  const classified = await run()  // triage picks the tier; no caller profile
  const cRow = JSON.parse(classified.prompts['stats'].match(/\{"kind":"review".*\}/)[0])
  assert.equal(cRow.profileForced, false)
})

test('a run driven by /r:task-run is distinguishable from a direct invocation', async () => {
  // deferCommit is only ever set by run-task Step 5, so its absence is the one available signal
  // that a human invoked this by hand — which is where re-reviews come from.
  const { prompts } = await run({ args: { deferCommit: true } })
  const row = JSON.parse(prompts['stats'].match(/\{"kind":"review".*\}/)[0])
  assert.equal(row.invokedBy, 'run-task')
})

test('the row separates a scan that self-fixed from one that found nothing', async () => {
  // localScan:'ok' collapses both, and local-scan can never appear in fixedBySource (it applies
  // its own fixes instead of feeding the fix-list) — so without this field the track has NO yield
  // signal at all, and its permanent zero would read as a quiet tool rather than an unmeasured one.
  const clean = await run()
  assert.equal(JSON.parse(clean.prompts['stats'].match(/\{"kind":"review".*\}/)[0]).scanChangedCode, false)
  assert.equal(clean.out.scanChangedCode, false)

  const selfFixed = await run({ overrides: { 'local-scan': { status: 'ok', changedCode: true } } })
  assert.equal(JSON.parse(selfFixed.prompts['stats'].match(/\{"kind":"review".*\}/)[0]).scanChangedCode, true)
  assert.equal(selfFixed.out.scanChangedCode, true)
})

test('a scan that never completed records null, never false', async () => {
  // false would claim a scan ran and found nothing. Every one of these ran no scan at all, and
  // counting them as clean is exactly how a track gets retired on evidence that does not exist.
  for (const [why, opt] of [
    ['blocked', { overrides: { 'local-scan': null } }],
    ['errored', { overrides: { 'local-scan': { status: 'error', changedCode: false } } }],
    ['skipped', { overrides: { 'local-scan': { status: 'skipped', changedCode: false } } }],
    ['no build tool', { triage: baseTriage({ buildTool: 'none', buildCmd: '', buildCmdFast: '' }) }],
  ]) {
    const { out, prompts } = await run(opt)
    const row = JSON.parse(prompts['stats'].match(/\{"kind":"review".*\}/)[0])
    assert.equal(row.scanChangedCode, null, `${why}: stats row must be null`)
    assert.equal(out.scanChangedCode, null, `${why}: return object must be null`)
  }
})

test('REGRESSION: a dead stats sink never fails the review', async () => {
  // Bookkeeping about a review must not be able to sink the review. No reliable(), no blocked()
  // check, no halt — the row is simply lost.
  const { out } = await run({ overrides: { stats: null } })
  assert.equal(out.reviewed, true)
  assert.equal(out.stopped, undefined)
  assert.equal(out.build, 'green')
})

test('the light tier still records a row (with nothing attributed)', async () => {
  const { out, counts } = await run({ args: { profile: 'light' } })
  assert.equal(counts['stats'], 1)
  assert.deepEqual(out.fixedBySource, {})
})

test('build red from PRE-EXISTING failures halts and is never fixed', async () => {
  const { out, counts } = await run({
    overrides: { 'build#': { green: false, preExistingFailures: 'LegacyPricingTest' } },
  })
  assert.equal(out.stopped, 'build-red-preexisting')
  assert.equal(counts['build-fix#1'], undefined)
})

// ------------------------------------------------- baselineBuilt (build reuse) ---
// The caller (run-task / fix-gh-issues) has just run a clean green build in this same tree.
// Without the flag this review opens by doing it again from an empty target/ — the most
// expensive duplicated step in the chain. What must NOT drift: the flag may only ever be
// honored as a build-command choice, never as permission to skip the build or relax green.

test('without baselineBuilt the first build is the CLEAN one', async () => {
  const { prompts } = await run()
  assert.match(prompts['build#1'], /mvn clean package/)
  assert.match(prompts['build#1'], /run's one clean build/)
})

test('baselineBuilt starts incremental — the caller already paid for the clean build', async () => {
  const { prompts, logText } = await run({ args: { baselineBuilt: true } })
  assert.match(prompts['build#1'], /Run the build `mvn package`/)
  assert.doesNotMatch(prompts['build#1'], /Run the build `mvn clean package`/)
  assert.doesNotMatch(prompts['build#1'], /run's one clean build/)
  assert.match(logText, /caller certified a clean green build/)
})

test('baselineBuilt still carries the deleted-or-renamed escape hatch', async () => {
  // The one case incremental can lie: a removed source leaves a stale .class behind.
  const { prompts } = await run({ args: { baselineBuilt: true } })
  assert.match(prompts['build#1'], /DELETED or RENAMED/)
  assert.match(prompts['build#1'], /mvn clean package/)   // named as the fallback, not the command
})

test('baselineBuilt never weakens the green bar, and a red build still halts', async () => {
  const { out, prompts } = await run({
    args: { baselineBuilt: true },
    overrides: { 'build#': { green: false, preExistingFailures: 'LegacyPricingTest' } },
  })
  assert.match(prompts['build#1'], /green=true ONLY on a fully clean success/)
  assert.equal(out.stopped, 'build-red-preexisting')
})

test('baselineBuilt on a project with no build tool changes nothing', async () => {
  const { out, counts } = await run({
    triage: baseTriage({ buildTool: 'none', buildCmd: '', buildCmdFast: '' }),
    args: { baselineBuilt: true },
  })
  assert.equal(counts['build#1'], undefined)
  assert.equal(out.build, 'n/a')
})

// ------------------------------------------- regression locks: dead-agent leaks --

test('REGRESSION: a dead triage HALTS — it must never look like "nothing to review"', async () => {
  // The worst failure in the pipeline: `{skipped: true}` tells /r:gh-issues-fix the review found
  // nothing owed, so it merges the branch and closes the issue on a review that never started.
  const { out, counts } = await run({ overrides: { triage: null } })
  assert.equal(out.stopped, 'triage-blocked')
  assert.notEqual(out.skipped, true)
  assert.equal(counts['triage'], 3) // reliable() retried, bounded at 3
})

test('REGRESSION: a dead fix-triage with findings halts instead of dropping them', async () => {
  const { out } = await run({
    overrides: { codex: { ran: true, findings: [finding()] }, 'fix-triage': null },
  })
  assert.equal(out.stopped, 'fix-triage-blocked')
  assert.equal(out.rawFindings.length, 1)
  assert.match(out.rawFindings[0].what, /off-by-one/)
})

test('a dead fix-triage with NO findings anywhere loses nothing, so the run continues', async () => {
  const { out, logText } = await run({ overrides: { 'fix-triage': null } })
  assert.equal(out.stopped, undefined)
  assert.equal(out.reviewed, true)
  assert.deepEqual(out.fixed, { correctness: 0, readability: 0 })
  assert.match(logText, /nothing was lost/)
})

test('REGRESSION: a dead local-scan reports blocked, never a silent clean pass', async () => {
  const { out, logText } = await run({ overrides: { 'local-scan': null } })
  assert.equal(out.localScan, 'blocked')
  assert.match(logText, /local-scan BLOCKED/)
  assert.match(logText, /NOT statically scanned/)
})

test('a local-scan that errors is treated exactly like a dead one', async () => {
  const { out } = await run({
    overrides: { 'local-scan': { status: 'error', changedCode: false, reason: 'spotbugs crashed', uncovered: ['spotbugs'] } },
  })
  assert.equal(out.localScan, 'blocked')
})

test('REGRESSION: a dead end-verify is "blocked", never "passed"', async () => {
  const { out, logText } = await run({
    overrides: {
      'fix-triage': { correctness: [`${CHANGED}:42 guard the empty batch`], readability: [], docDrift: [] },
      'end-verify#': null,
    },
  })
  assert.equal(out.endVerify, 'blocked')
  assert.notEqual(out.endVerify, 'passed')
  assert.match(logText, /final diff is UNVERIFIED/)
})

test('REGRESSION: an end-verify finding with no `real` flag reaches a fixer, it is not dropped', async () => {
  // `real` is OPTIONAL in the FINDINGS schema, so a Codex pass that returned a genuine defect
  // without adjudicating it was filtered to nothing, read as "converged", and the run reported
  // endVerify:'passed' / fixed.correctness:0. Observed for real: a verified P2 race was found,
  // never handed to anyone, and shipped. An unmarked finding is a finding.
  const unflagged = { file: CHANGED, line: 7, category: 'correctness', what: 'the swap targets a detached node' }
  const { out, counts } = await run({
    overrides: {
      'fix-triage': { correctness: [`${CHANGED}:42 guard the empty batch`], readability: [], docDrift: [] },
      'end-verify#1': { ran: true, findings: [unflagged] },
      'end-verify#2': CLEAN,
    },
  })
  assert.equal(counts['end-verify-fix#1'], 1)   // it reached a fixer
  assert.equal(out.endVerify, 'passed')          // and pass 2 re-read the diff clean
  assert.equal(out.fixed.correctness, 2)         // 1 triaged + 1 end-verify — the count is honest
})

test('REGRESSION: end-verify findings that survive 2 passes are surfaced, never "passed"', async () => {
  const still = { file: CHANGED, line: 7, category: 'correctness', what: 'still races on the badge swap', real: true }
  const { out, logText } = await run({
    overrides: {
      'fix-triage': { correctness: [`${CHANGED}:42 guard the empty batch`], readability: [], docDrift: [] },
      'end-verify#': { ran: true, findings: [still] },
    },
  })
  assert.notEqual(out.endVerify, 'passed')
  assert.equal(out.endVerify, 'findings-unresolved')
  assert.equal(out.endVerifyFindings.length, 1)
  assert.match(out.endVerifyFindings[0], /still races/)
  assert.match(logText, /NOT re-verified/)
})

// Each end-verify pass shells out to a FRESH Codex thread (run.sh -> runAppServerReview starts an
// ephemeral thread; `review` has no --resume). So the prompt is the only channel through which
// pass 2 can learn what pass 1 said. Without it pass 2 re-read the diff cold and could not tell
// code it had never seen from code just rewritten in answer to its own finding.
test('pass 2 is told what pass 1 raised and that a fixer edited the code', async () => {
  const first = { file: CHANGED, line: 7, category: 'correctness', what: 'races on the badge swap', real: true }
  const { prompts, counts } = await run({
    overrides: {
      'fix-triage': { correctness: [`${CHANGED}:42 guard the empty batch`], readability: [], docDrift: [] },
      'end-verify#1': { ran: true, findings: [first] },
    },
  })
  assert.equal(counts['end-verify#2'], 1)
  const p2 = prompts['end-verify#2']
  assert.match(p2, /races on the badge swap/)
  assert.match(p2, new RegExp(`${CHANGED}:7`))
  assert.match(p2, /INCLUDES those edits/)
  // Pass 1 has nothing to carry, and inventing a prior pass would be a lie about the diff's history.
  assert.doesNotMatch(prompts['end-verify#1'], /races on the badge swap/)
})

test('pass 2 is told when the pass-1 fixer died, so re-finding the item is correct', async () => {
  const first = { file: CHANGED, line: 7, category: 'correctness', what: 'races on the badge swap', real: true }
  const { prompts } = await run({
    overrides: {
      'fix-triage': { correctness: [`${CHANGED}:42 guard the empty batch`], readability: [], docDrift: [] },
      'end-verify#1': { ran: true, findings: [first] },
      'end-verify-fix#1': null,
    },
  })
  assert.match(prompts['end-verify#2'], /DIED before touching them/)
  assert.doesNotMatch(prompts['end-verify#2'], /INCLUDES those edits/)
})

test('an end-verify finding explicitly marked real:false is still dropped', async () => {
  // The fix must not over-correct: an adjudicated false positive is exactly what real:false is for.
  const fp = { file: CHANGED, line: 7, category: 'correctness', what: 'false alarm', real: false }
  const { out, counts } = await run({
    overrides: {
      'fix-triage': { correctness: [`${CHANGED}:42 guard the empty batch`], readability: [], docDrift: [] },
      'end-verify#': { ran: true, findings: [fp] },
    },
  })
  assert.equal(out.endVerify, 'passed')
  assert.equal(counts['end-verify-fix#1'], undefined)
  assert.equal(out.fixed.correctness, 1) // only the triaged item
})

test('end-verify still runs when only local-scan wrote code', async () => {
  // The fix-list is empty, but local-scan applied its own fixes — that machine-written code is
  // exactly what the end-verify exists to read, so gating on the fix-list alone would miss it.
  const { out, counts } = await run({
    overrides: { 'local-scan': { status: 'ok', changedCode: true } },
  })
  assert.equal(counts['end-verify#1'], 1)
  assert.equal(out.endVerify, 'passed')
})

test('REGRESSION: UI teardown is retried and its failure is surfaced, not swallowed', async () => {
  const { out, counts, logText } = await run({
    triage: baseTriage({ hasTestApp: true, uiTouched: true, hasFrontend: true }),
    overrides: { 'ui-teardown': null },
  })
  assert.equal(counts['ui-teardown'], 3)
  assert.match(logText, /teardown NOT confirmed/)
  assert.equal(out.reviewed, true) // a leaked stack is a warning, not a halt
})

test('teardown still runs when BOTH UI halves die (the finally block)', async () => {
  const { out, counts } = await run({
    triage: baseTriage({ hasTestApp: true, uiTouched: true }),
    overrides: { 'ui-functional': null, 'ui-visual': null },
  })
  assert.equal(counts['ui-teardown'], 1)
  assert.equal(out.ui.blocked, true)
  assert.deepEqual(out.ui.blockedHalves, ['ui-functional', 'ui-visual'])
})

// ----------------------------------------------------- local-scan scope (fix #4) --

test('REGRESSION: local-scan computes its own branch-wide class list, not the Phase-0 diff', async () => {
  // Handed triage.changedFiles — the diff as it looked BEFORE the fix phase — it would never scan
  // anything the fixers wrote. SKILL.md Step 6b specifies branch-wide.
  const { prompts } = await run()
  const p = prompts['local-scan']
  assert.match(p, /merge-base/)
  assert.match(p, /compute the list YOURSELF/)
  assert.ok(!p.includes(CHANGED), 'the Phase-0 changed-file list must not be injected into the scan prompt')
})

// ------------------------------------------------- the post-scan rebuild loop ---
// A single red here halts the whole run, and the group's finished work goes unmerged. So the red
// is bounded the way Phase 4's is, and a red that names nothing — the shape a misread log takes —
// costs a re-run rather than a fixer let loose on a green tree.

test('a rebuild that goes green on a later attempt does NOT stop the run', async () => {
  let n = 0
  const { out, counts } = await run({
    overrides: {
      'local-scan': { status: 'ok', changedCode: true },
      'rebuild#': () => (++n === 1 ? { green: false, inScopeFailures: 'PricingTest' } : { green: true }),
    },
  })
  assert.equal(out.stopped, undefined)
  assert.equal(counts['rebuild#2'], 1)
  assert.equal(counts['rebuild-fix#1'], 1, 'a NAMED failure earns one surgical fix before the retry')
})

test('a red that names no failure re-runs the build instead of dispatching a fixer', async () => {
  let n = 0
  const { out, counts, logText } = await run({
    overrides: {
      'local-scan': { status: 'ok', changedCode: true },
      'rebuild#': () => (++n === 1 ? { green: false } : { green: true }),
    },
  })
  assert.equal(out.stopped, undefined)
  assert.equal(counts['rebuild#2'], 1)
  assert.equal(counts['rebuild-fix#1'], undefined, 'nothing was named — there is nothing to fix')
  assert.match(logText, /named no failure/)
})

test('a DEAD rebuild agent is the same case: re-run, never a fixer on nothing', async () => {
  let n = 0
  const { out, counts } = await run({
    overrides: {
      'local-scan': { status: 'ok', changedCode: true },
      'rebuild#': () => (++n === 1 ? null : { green: true }),
    },
  })
  assert.equal(out.stopped, undefined)
  assert.equal(counts['rebuild-fix#1'], undefined)
})

test('still red after three attempts halts, and says a RESUME will not retry it', async () => {
  // resumeFromRunId replays a cached agent result rather than re-running it, so a resume of a
  // rebuild-red run replays the red verdict; the recovery is a fresh review on the branch.
  const { out, counts, logText } = await run({
    overrides: {
      'local-scan': { status: 'ok', changedCode: true },
      'rebuild#': { green: false, inScopeFailures: 'PricingTest' },
    },
  })
  assert.equal(out.stopped, 'rebuild-red')
  assert.equal(counts['rebuild#3'], 1)
  assert.equal(counts['rebuild#4'], undefined, 'bounded — never "loop until green"')
  assert.equal(counts['rebuild-fix#2'], 1)
  assert.equal(counts['rebuild-fix#3'], undefined, 'the last attempt is a build, not another fix')
  assert.match(logText, /RESUMING this run replays the cached red verdict/)
})

// ---------------------------------------------------------------- arg parsing ---

test('a JSON-string arg is parsed, so deferCommit is not silently lost', async () => {
  const { prompts } = await run({
    args: JSON.stringify({ deferCommit: true, profile: 'full', packRoot: '/pack' }),
    overrides: { 'fix-triage': { correctness: [], readability: ['A.java:1 extract a method'], docDrift: [] } },
  })
  assert.match(prompts['fix-readability'], /WITHOUT committing/)
})

test('a malformed arg is survived, then halts cleanly on the missing pack root', async () => {
  // The property being locked is that a SyntaxError never takes the review down — the parser
  // still falls back to {}. What CHANGED is what happens next: with no packRoot recoverable there
  // is no run.sh, no deploy helper, no reference files, so the run stops instead of dispatching
  // agents at paths under "/". The old "run with defaults is strictly better" reasoning quietly
  // assumed PACK had a working fallback, and it never did.
  const { out } = await run({ args: 'not json at all {{{' })
  assert.equal(out.stopped, 'no-pack-root')
  assert.equal(out.reviewed, undefined)
})

// ------------------------------------------- end-verify is retried, not merely reported ---
// These pin the avtoportal G4 failure of 2026-07-28: the review Workflow ran perfectly and
// returned endVerify:"blocked" because the Codex wrapper inside it produced no report. The six
// fixes applied earlier in that same run had therefore been reviewed by nothing, and only a
// caller noticing that "blocked" is not "passed" kept an unreviewed diff off main.

const NEEDS_FIX = { correctness: [`${CHANGED}:42 guard the empty batch`], readability: [], docDrift: [] }

test('REGRESSION: an end-verify that reports ran:false is re-dispatched before the diff is called unverified', async () => {
  // Exit 4 means the wrapper burned its OWN three Codex attempts on an environment error. Running
  // it again buys three more — and on the real occurrence a manual re-run minutes later returned
  // a clean review, so the diff was reviewable the whole time. reliable() cannot catch this on its
  // own: the agent succeeded, it was the tool underneath that didn't run.
  const { out, counts, logText } = await run({
    overrides: {
      'fix-triage': NEEDS_FIX,
      // The retry key must come FIRST: overrides match by startsWith in insertion order, and
      // 'end-verify#1.retry' also starts with 'end-verify#1'.
      'end-verify#1.retry': CLEAN,
      'end-verify#1': { ran: false, findings: [] },
    },
  })
  assert.equal(counts['end-verify#1.retry'], 1, 'the not-run report earns exactly one more dispatch')
  assert.equal(out.endVerify, 'passed', 'and the retry is what verifies the diff')
  assert.match(logText, /reported it did NOT run — re-dispatching once/)
})

test('an end-verify that reports ran:false TWICE is blocked — the retry is bounded', async () => {
  // One retry, not a loop: if Codex genuinely cannot read this diff, the honest answer is that the
  // final diff is unverified. Better a caller that stops than one that grinds.
  const { out, counts } = await run({
    overrides: { 'fix-triage': NEEDS_FIX, 'end-verify#': { ran: false, findings: [] } },
  })
  assert.equal(counts['end-verify#1.retry'], 1)
  assert.equal(counts['end-verify#1.retry.retry'], undefined, 'the retry is not itself retried')
  assert.equal(out.endVerify, 'blocked')
})

test('a DEAD end-verify agent gets reliable()\'s 3 attempts, then blocks', async () => {
  // Two different failures that look identical from here unless both are handled: the agent dying
  // (null) and the agent reporting its tool didn't run. The first is reliable()'s job, so this
  // step must not be dispatched bare with no retry.
  const { out, counts, logText } = await run({
    overrides: { 'fix-triage': NEEDS_FIX, 'end-verify#1': null },
  })
  assert.equal(counts['end-verify#1'], 3, 'a dead end-verify is re-dispatched, not accepted')
  assert.equal(out.endVerify, 'blocked')
  assert.match(logText, /final diff is UNVERIFIED/)
})

test('a first-attempt failure that recovers does NOT count as a blocked review', async () => {
  // The point of the retry: a transient wrapper failure must not cost the caller the merge.
  const { out } = await run({
    overrides: {
      'fix-triage': NEEDS_FIX,
      'end-verify#1': (n) => (n === 1 ? null : CLEAN),
    },
  })
  assert.equal(out.endVerify, 'passed')
})

test('FR-22: an absent codex plugin is reported skipped, and never as a clean review', async () => {
  const SKIP = { ran: false, findings: [], coverage: 'SKIPPED — codex plugin not installed' }
  const { out, logText } = await run({ profile: 'full', overrides: { codex: SKIP } })
  assert.deepEqual(out.tracksSkipped, ['codex'])
  assert.ok(!out.tracksBlocked.includes('codex'), 'a skip is not a tool failure')
  assert.match(logText, /codex SKIPPED/)
  assert.match(logText, /NOT faked/)
})

// ------------------------- end-verify and the UI track share one barrier ---
// They were serial and they are the two longest blocks in the pipeline (UI: median 542s, p90
// 1150s; end-verify: up to two Codex passes each followed by a fixer). They read different
// things — the git diff versus a deployed image — so they overlap, and everything that WRITES
// waits for the join.

const uiTriage = (over = {}) => baseTriage({
  uiTouched: true, hasTestApp: true, hasFrontend: true, ...over,
})
const feFinding = {
  file: 'src/main/resources/templates/rates.html', line: 10,
  category: 'ui', what: 'the empty state renders the raw key', real: true,
}

test('the UI deploy starts before the end-verify has finished fixing', async () => {
  // The lock on the overlap itself. Serially the deploy would come strictly after every
  // end-verify pass AND its fixer; here it must not wait for them.
  const { order } = await run({
    triage: uiTriage(), args: { profile: 'light' },
    overrides: { 'end-verify#1': { ran: true, findings: [finding()] } },
  })
  assert.ok(order.includes('ui-deploy'), 'the UI track must have run')
  assert.ok(order.indexOf('ui-deploy') < order.indexOf('end-verify-fix#1'),
    'the UI deploy must not wait on the end-verify fixer')
})

test('an end-verify fix in a FRONTEND file re-deploys and re-verifies once', async () => {
  // The honesty cost of overlapping: the halves read an image built before that fix landed, so
  // what they verified is stale. One more pass — never a loop — and the worst case is exactly
  // the serial ordering this replaced.
  const { counts, logText } = await run({
    triage: uiTriage(), args: { profile: 'light' },
    overrides: { 'end-verify#1': (n) => n === 1 ? { ran: true, findings: [feFinding] } : CLEAN },
  })
  assert.equal(counts['ui-deploy'], 2, 'the stale verdict must be re-taken')
  assert.equal(counts['ui-functional'], 2)
  assert.equal(counts['ui-visual'], 2)
  assert.match(logText, /re-deploying and re-verifying once/)
})

test('an end-verify fix in a BACKEND file does not re-run the UI track', async () => {
  // The common case, and the whole point of the overlap: end-verify fixes are overwhelmingly
  // backend, and nothing about them changes what the browser saw.
  const { counts, logText } = await run({
    triage: uiTriage(), args: { profile: 'light' },
    overrides: { 'end-verify#1': (n) => n === 1 ? { ran: true, findings: [finding()] } : CLEAN },
  })
  assert.equal(counts['ui-deploy'], 1)
  assert.doesNotMatch(logText, /re-deploying and re-verifying/)
})

test('a DEAD end-verify fixer cannot trigger a re-verify — it changed nothing', async () => {
  const { counts } = await run({
    triage: uiTriage(), args: { profile: 'light' },
    overrides: {
      'end-verify#1': (n) => n === 1 ? { ran: true, findings: [feFinding] } : CLEAN,
      'end-verify-fix#1': null,
    },
  })
  assert.equal(counts['ui-deploy'], 1, 'no edit landed, so nothing the halves read went stale')
})

test('an absent /test-app at deploy time is a SKIP, not a blocked track', async () => {
  // `hasTestApp` is a model's answer to a one-line `test -f`, and one triage in four answers true
  // over a tree with no SKILL.md — the directory is still there, full of screenshots. That run pays
  // a pre-warm, an 86s docker deploy and both halves before finding out. The deploy step looks for
  // the file itself, and an absent prerequisite is nobody's failure.
  const { out, logText, counts } = await run({
    triage: baseTriage({ uiTouched: true, hasTestApp: true, hasFrontend: true }),
    overrides: {
      'ui-deploy': { ok: false, missing: true, reason: '/test-app SKILL.md is not on disk' },
    },
  })
  assert.equal(counts['ui-functional'], undefined, 'neither half is dispatched')
  assert.equal(counts['ui-visual'], undefined)
  assert.equal(out.ui.blocked, false, 'an absent prerequisite is not a broken tool')
  assert.match(out.ui.missing, /not on disk/)
  assert.match(logText, /UI verification SKIPPED/)
  // The distinction the whole payload draws elsewhere: skipped is not blocked, and a reader must
  // not be sent after a deploy that never failed.
  assert.ok(!/UI verification NOT run — deploy failed/.test(logText))
})

test('a deploy that genuinely FAILED is still a blocked track, not a skip', async () => {
  const { out, logText } = await run({
    triage: baseTriage({ uiTouched: true, hasTestApp: true, hasFrontend: true }),
    overrides: { 'ui-deploy': { ok: false, reason: 'health check never returned 200' } },
  })
  assert.equal(out.ui.blocked, true)
  assert.equal(out.ui.missing, undefined)
  assert.match(logText, /UI verification NOT run — deploy failed/)
})

test('a UI half that could not run contributes no finding row', async () => {
  // The failure this locks down: a half with nowhere to say "I could not run" returns
  // "VERIFICATION TRACK BLOCKED, /test-app is not installed" as a finding tagged fixSize=minor.
  // It is then dispatched to the UI fixer as work, counted in minorFixed, and stored as
  // verdict=confirmed/fixed=true — the only ui-functional row the store holds, which makes a
  // blocked track read as a 100%-precision one. The blockage has its own field instead.
  const { out } = await run({
    triage: baseTriage({ uiTouched: true, hasTestApp: true, hasFrontend: true }),
    overrides: {
      'ui-functional': { ran: false, blockedReason: '/test-app is not installed', findings: [] },
      'ui-visual': { ran: true, findings: [] },
    },
  })
  assert.equal(out.ui.ran, false)
  assert.ok(out.ui.blockedHalves.includes('ui-functional'))
  // The reason is recorded, so a reader can tell an absent /test-app from a stack that would not
  // come up — one is setup, the other a real failure, and they need opposite responses.
  assert.match(out.ui.blockedReasons.join(' '), /test-app is not installed/)
  assert.equal(out.ui.minorFixed, 0, 'nothing was fixed — nothing was found')
})

test('minorFixed reflects the fixer returning, not the fixSize tag', async () => {
  // Read off the tag alone, `fixed` claims a repair on every run where the fixer died — the one
  // shape of this record that cannot be checked later, since a dead agent leaves no diff to read.
  const uiFinding = { title: 'hint wraps at 390px', where: 'form.html:205', fixSize: 'minor' }
  const live = await run({
    triage: baseTriage({ uiTouched: true, hasTestApp: true, hasFrontend: true }),
    overrides: { 'ui-visual': { ran: true, findings: [uiFinding] } },
  })
  assert.equal(live.out.ui.minorFixed, 1)

  const deadFixer = await run({
    triage: baseTriage({ uiTouched: true, hasTestApp: true, hasFrontend: true }),
    overrides: {
      'ui-visual': { ran: true, findings: [uiFinding] },
      'ui-fix-minor': null,
    },
  })
  assert.equal(deadFixer.out.ui.minorFixed, 0, 'a dead fixer fixed nothing')
})

test('teardown still runs when a UI half dies inside the barrier', async () => {
  // parallel() swallows a thrown thunk into a null, so a teardown nested inside the UI track
  // would be skipped exactly when it is needed most. It lives in a finally around the barrier.
  const { counts, logText } = await run({
    triage: uiTriage(), overrides: { 'ui-visual': null },
  })
  assert.equal(counts['ui-teardown'], 1)
  assert.match(logText, /UI half BLOCKED — ui-visual/)
})

test('teardown runs even when the deploy itself failed', async () => {
  const { out, counts } = await run({
    triage: uiTriage(), overrides: { 'ui-deploy': { ok: false, reason: 'port in use' } },
  })
  assert.equal(counts['ui-teardown'], 1)
  assert.equal(counts['ui-functional'], undefined, 'nothing may test a stack that never came up')
  assert.equal(out.ui.blocked, true)
})

test('no teardown agent is spawned when the UI track never ran', async () => {
  const { counts } = await run() // backend-only diff: uiTouched false
  assert.equal(counts['ui-teardown'], undefined)
  assert.equal(counts['ui-prewarm'], undefined)
})

test('the docker pre-warm starts at triage, not alongside the end-verify', async () => {
  // Started here it overlaps the review, the fix phase, the build and the scan as well — the
  // deploy is 42% of the UI step's tool time and took over two minutes in 17 of 56 stored runs.
  const { order, opts } = await run({ triage: uiTriage() })
  assert.equal(opts['ui-prewarm'].phase, 'Triage')
  assert.ok(order.indexOf('ui-prewarm') < order.indexOf('build#1'),
    'the image build must be warming while the review and build run')
})

// ------------------------------------------- model tiers, not just effort ---
// Both pipelines pinned `effort` almost everywhere and `model` almost nowhere, so an agent marked
// "nothing to decide" still ran on whatever the session was on — through a /r:task-run chain, Opus,
// to run one shell script. These lock the split: what only echoes a command runs cheapest, and
// everything that classifies or composes stays where it is.

test('the pure command-runners run on haiku', async () => {
  const { opts } = await run({ triage: baseTriage({ uiTouched: true, hasTestApp: true, hasFrontend: true }) })
  for (const l of ['ui-prewarm', 'ui-teardown', 'stats']) {
    assert.equal(opts[l].model, 'haiku', `${l} runs one fixed command and reports its output`)
    assert.equal(opts[l].effort, 'low')
  }
})

test('the post-scan rebuild steps up over the runner agent\'s haiku', async () => {
  // It has nothing to classify — the tree was green before local-scan ran, so any failure here is
  // in-scope by construction and the prompt says so. It still decides green vs red, and that
  // verdict halts the run outright with no tier above it to disagree, which is what it is paid
  // for: the tier that captures `$?` rather than judging an exit-0 build by its [ERROR] lines.
  const { opts, prompts } = await run({
    overrides: { 'local-scan': { status: 'ok', changedCode: true } },
  })
  assert.equal(opts['rebuild#1'].model, 'sonnet')
  assert.match(prompts['rebuild#1'], /ANY failure here is a regression from local-scan's own self-fixes/)
})

test('every build prompt decides green from the exit code, not the log text', async () => {
  // The fast commands are `-q`, under which there is no BUILD SUCCESS line to grep — so a prompt
  // that does not name the exit code leaves the agent judging on `[ERROR]` lines alone.
  const { prompts } = await run({
    overrides: {
      'local-scan': { status: 'ok', changedCode: true },
      'find-bugs:logic': { ran: true, findings: [finding()] },
      'fix-triage': { correctness: [{ item: `${CHANGED}:42 fix it`, source: 'logic' }] },
    },
  })
  for (const l of ['build#1', 'rebuild#1']) {
    assert.match(prompts[l], /Decide green from the process EXIT CODE, never from the log text/, l)
    assert.match(prompts[l], /its absence proves NOTHING/, l)
  }
})

test('the build that DOES classify steps up over the runner agent\'s haiku', async () => {
  // in-scope vs pre-existing is load-bearing both ways: wrongly "in-scope" edits somebody else's
  // failing test, wrongly "pre-existing" halts a run that should have proceeded. The runner agents
  // are haiku for the "BUILD SUCCESSFUL" path; this call is the one that has to read a red build.
  const { opts } = await run({ triage: baseTriage({ uiTouched: true, hasTestApp: true }) })
  assert.equal(opts['build#1'].model, 'sonnet')
  // The deploy carries its own tier, so a change to the build's cannot move it by accident.
  assert.equal(opts['ui-deploy'].model, 'sonnet', 'it must tell a real failure from a slow start')
})

test('every judging track still inherits the session model', async () => {
  const { opts } = await run({
    overrides: {
      'find-bugs:logic': { ran: true, findings: [finding()] },
      'code-quality': { ran: true, findings: [finding('long method')] },
      'fix-triage': { correctness: [{ item: `${CHANGED}:42 fix it`, source: 'logic' }] },
      'fix-triage-readability': { readability: ['extract a method'] },
    },
  })
  for (const l of ['find-bugs:logic', 'find-bugs:security', 'code-quality', 'fix-triage',
                   'fix-triage-readability', 'fix-correctness', 'local-scan']) {
    assert.equal(opts[l].model, undefined, `${l} forms an opinion — it must not be down-tiered`)
  }
})

// ------------------------------------------------ locating the pack itself ---
// GUARDS: a run whose every tool path resolves to `/skills/...` because ${CLAUDE_PLUGIN_ROOT} is
// substituted in skill MARKDOWN, never inside a workflow script and never in a subagent's shell.
// Seven paths come off PACK — both Codex tracks, deploy, teardown, the hunters' reference files
// and the stats sink — and only the sink reports its own stderr, so it is the only one that says
// anything when this breaks.

test('args as a JSON STRING still resolves the pack root', async () => {
  // The case that actually bites: PACK is computed from the RAW args, hundreds of lines before the
  // tolerant parser every other option goes through — and callers hand over a JSON string almost
  // every time (0 object args vs 39 string ones across the stored history). A string fails
  // `typeof args === 'object'`, so packRoot went missing even when the caller passed it.
  const { prompts } = await run({ args: '{"packRoot":"/pack","profile":"standard"}' })
  assert.match(prompts['codex'], /\/pack\/skills\/code-adversarial\/scripts\/run\.sh/)
  assert.doesNotMatch(prompts['codex'], /CLAUDE_PLUGIN_ROOT/,
    'an unsubstituted placeholder reaches a shell as the empty string')
})

test('no usable pack root is a HALT, not a run with seven broken paths', async () => {
  const { out, counts } = await run({ args: '{"profile":"standard"}' })
  assert.equal(out.stopped, 'no-pack-root')
  assert.equal(counts['triage'], undefined, 'nothing may run before the tools can be located')
})

test('the literal placeholder is treated as absent, not as a path', async () => {
  // A caller that copy-pasted the invocation out of the markdown without substitution.
  const { out } = await run({ args: JSON.stringify({ packRoot: '${CLAUDE_PLUGIN_ROOT}' }) })
  assert.equal(out.stopped, 'no-pack-root')
})

// ------------------------------------------------- UI: the terminal surfaces ---
// Phase 7 verifies whatever the generated /test-app declares it drives. The surface is READ off
// that skill's marker line, never guessed from this repo's file extensions: `.go` under a view
// package is a rendered result and `.go` under a store package is not, and no extension test
// separates them. These lock the three things that go wrong — the gate firing for the wrong
// diffs, the deploy handing a verifier a handle it cannot use, and a web run drifting.

const tuiTriage = (over = {}) => baseTriage({
  hasTestApp: true, uiTouched: true, testAppSurface: 'tui',
  buildTool: 'none', changedFiles: ['internal/ui/table.go'],
  hasBackend: false, hasFrontend: false, ...over,
})
const TUI_DEPLOY = { ok: true, surface: 'tui', handle: 'ta-a1b2-func ta-a1b2-visual' }
const TUI_HALVES = { 'tui-functional': CLEAN, 'tui-visual': CLEAN, 'cli-functional': CLEAN }

test('a terminal /test-app fires the UI gate on a Go-only diff, and never pre-warms', async () => {
  const { counts } = await run({
    triage: tuiTriage(), overrides: { 'ui-deploy': TUI_DEPLOY, ...TUI_HALVES } })
  assert.equal(counts['ui-deploy'], 1)
  assert.equal(counts['tui-functional'], 1)
  assert.equal(counts['tui-visual'], 1)
  // Nothing to warm, and worktree-deploy.sh require_bin's docker before it reads its subcommand,
  // so a pre-warm here is not a slow no-op — it is an exit 127.
  assert.equal(counts['ui-prewarm'], undefined)
  assert.equal(counts['ui-functional'], undefined) // the browser halves never ran
})

test('a backend-only terminal diff still does NOT fire — the surface is not a second door in', async () => {
  const { counts, logText } = await run({
    triage: tuiTriage({ uiTouched: false, changedFiles: ['internal/store/db.go'] }) })
  assert.equal(counts['ui-deploy'], undefined)
  assert.match(logText, /no frontend change in this diff/)
})

test('the DEPLOY step, not triage, decides the surface — in both directions', async () => {
  // Triage said terminal; the deploy came back with a URL and no surface. The URL wins.
  const a = await run({ triage: tuiTriage(), overrides: {
    'ui-deploy': { ok: true, url: 'http://localhost:18080' }, ...TUI_HALVES } })
  assert.equal(a.counts['ui-functional'], 1)
  assert.equal(a.counts['tui-functional'], undefined)
  assert.match(a.prompts['ui-functional'], /TEST_APP_BASE_URL/)

  // Triage said nothing; the deploy came back terminal. The deploy wins.
  const b = await run({ triage: baseTriage({ hasTestApp: true, uiTouched: true }), overrides: {
    'ui-deploy': TUI_DEPLOY, ...TUI_HALVES } })
  assert.equal(b.counts['tui-functional'], 1)
  assert.equal(b.counts['ui-functional'], undefined)
})

test('a terminal deploy hands each half its OWN session, and never a URL', async () => {
  const { prompts } = await run({
    triage: tuiTriage(), overrides: { 'ui-deploy': TUI_DEPLOY, ...TUI_HALVES } })
  assert.match(prompts['tui-functional'], /TEST_APP_SESSION="ta-a1b2-func"/)
  assert.match(prompts['tui-visual'], /TEST_APP_SESSION="ta-a1b2-visual"/)
  for (const l of ['tui-functional', 'tui-visual']) {
    assert.doesNotMatch(prompts[l], /export TEST_APP_BASE_URL="/, `${l} must not be handed a URL`)
    // The property most at risk when a branch is added: both halves still call the real tool.
    assert.match(prompts[l], /REAL \/test-app skill \(Skill tool\)/)
    assert.match(prompts[l], /Do NOT\s+deploy, redeploy, restart or tear down/)
  }
})

test('the terminal visual half carries the geometry sweep and NOT frontend-design', async () => {
  const t = await run({ triage: tuiTriage(), overrides: { 'ui-deploy': TUI_DEPLOY, ...TUI_HALVES } })
  assert.match(t.prompts['tui-visual'], /80x24/)
  assert.match(t.prompts['tui-visual'], /at most 6/)
  // frontend-design grades typography, colour cohesion and motion; over an 80x24 text frame it
  // produces findings that are not about anything, in a track whose precision they would land in.
  assert.match(t.prompts['tui-visual'], /Do NOT load the .?frontend-design/)
  assert.doesNotMatch(t.prompts['tui-visual'], /THEN load the .?frontend-design/)

  // ...and the web half is untouched by that subtraction.
  const w = await run({ triage: baseTriage({ hasTestApp: true, uiTouched: true }) })
  assert.match(w.prompts['ui-visual'], /frontend-design/)
  assert.match(w.prompts['ui-visual'], /SCREENSHOT BUDGET — at most 6/)
})

test('a cli surface dispatches ONE half — there is no visual pass on nothing rendered', async () => {
  const { counts, prompts } = await run({
    triage: tuiTriage({ testAppSurface: 'cli' }),
    overrides: { 'ui-deploy': { ok: true, surface: 'cli', handle: '/repo/target/release/app' }, ...TUI_HALVES } })
  assert.equal(counts['cli-functional'], 1)
  assert.equal(counts['tui-visual'], undefined)
  assert.equal(counts['ui-visual'], undefined)
  assert.match(prompts['cli-functional'], /TEST_APP_BIN="\/repo\/target\/release\/app"/)
  assert.doesNotMatch(prompts['cli-functional'], /export TEST_APP_BASE_URL="/)
})

test('a terminal deploy that could not start is BLOCKED, and says why', async () => {
  const { out, logText } = await run({ triage: tuiTriage(), overrides: {
    'ui-deploy': { ok: false, surface: 'tui', reason: 'tmux not installed (tui-session.sh exited 127)' } } })
  assert.equal(out.ui.blocked, true)
  assert.equal(out.ui.missing, undefined)  // a missing TOOL is not a missing prerequisite skill
  assert.match(logText, /UI verification NOT run — deploy failed/)
  // The reason has to reach the store. blockedReasons is fed by the halves, which never ran.
  assert.match(out.ui.blockedReasons.join(' '), /tmux not installed/)
})

test('an absent /test-app is still a SKIP on the terminal path, never a blockage', async () => {
  const { out, counts, logText } = await run({ triage: tuiTriage(), overrides: {
    'ui-deploy': { ok: false, missing: true, reason: '.claude/skills/test-app/SKILL.md is not on disk' } } })
  assert.equal(counts['tui-functional'], undefined)
  assert.equal(out.ui.blocked, false)
  assert.match(out.ui.missing, /not on disk/)
  assert.match(logText, /UI verification SKIPPED/)
  assert.doesNotMatch(logText, /deploy failed/)
})

test('an unresolvable surface is a named skip, and the deploy brief still says so', async () => {
  const { out, prompts } = await run({ triage: baseTriage({ hasTestApp: true, uiTouched: true }), overrides: {
    'ui-deploy': { ok: false, missing: true,
      reason: 'the /test-app skill declares no surface and names no base URL — re-run /r:test-app-create' } } })
  assert.match(out.ui.missing, /declares no surface/)
  // Lock the INSTRUCTION, not only the routing: without it the step could quietly start guessing.
  assert.match(prompts['ui-deploy'], /declares no\s+surface and names no base URL/)
  assert.match(prompts['ui-deploy'], /test-app-surface: \(web\|tui\|cli\)/)
})

test('terminal teardown stops the sessions and never calls worktree-deploy', async () => {
  const { counts, prompts } = await run({
    triage: tuiTriage(), overrides: { 'ui-deploy': TUI_DEPLOY, ...TUI_HALVES } })
  assert.equal(counts['ui-teardown'], 1)
  assert.match(prompts['ui-teardown'], /tui-session\.sh/)
  assert.match(prompts['ui-teardown'], /stop 'ta-a1b2-func'/)
  assert.match(prompts['ui-teardown'], /stop 'ta-a1b2-visual'/)
  assert.doesNotMatch(prompts['ui-teardown'], /worktree-deploy\.sh" teardown/)
})

test('a terminal half that dies inside the barrier still reaches the TERMINAL teardown', async () => {
  // Proves the hoisted surface survives a throw out of parallel() — a variable scoped inside
  // uiTrack() would be gone exactly when the teardown needs it.
  const { counts, prompts } = await run({ triage: tuiTriage(), overrides: {
    'ui-deploy': TUI_DEPLOY, 'tui-functional': CLEAN, 'tui-visual': null } })
  assert.equal(counts['ui-teardown'], 1)
  assert.match(prompts['ui-teardown'], /tui-session\.sh/)
})

test('a DEAD terminal deploy still reaches the terminal teardown, from triage alone', async () => {
  // The default-from-triage branch, and the reason `stop` on a session nobody started must be a
  // no-op: this run may have started nothing at all.
  const { counts, prompts } = await run({ triage: tuiTriage(), overrides: { 'ui-deploy': null } })
  assert.equal(counts['ui-teardown'], 1)
  assert.match(prompts['ui-teardown'], /tui-session\.sh/)
  assert.doesNotMatch(prompts['ui-teardown'], /worktree-deploy\.sh" teardown/)
})

test('REGRESSION: a web run is bit-for-bit what it was before the surfaces existed', async () => {
  const { counts, prompts } = await run({ triage: baseTriage({ hasTestApp: true, uiTouched: true }) })
  assert.equal(counts['ui-prewarm'], 1)
  assert.match(prompts['ui-deploy'], /WTD="[^"]*worktree-deploy\.sh"/)
  assert.match(prompts['ui-deploy'], /"\$WTD" deploy/)
  assert.match(prompts['ui-deploy'], /"\$WTD" base-url/)
  assert.match(prompts['ui-teardown'], /worktree-deploy\.sh" teardown/)
  for (const l of ['ui-functional', 'ui-visual']) {
    assert.match(prompts[l], /TEST_APP_BASE_URL="http:\/\/localhost:18080"/)
    assert.match(prompts[l], new RegExp(`AGENT_BROWSER_SESSION=ptr-${l === 'ui-functional' ? 'func' : 'visual'}`))
  }
  // The negative half is what catches a prompt builder that leaks the terminal block into the
  // web branch — a positive-only check would pass on a prompt carrying both.
  for (const l of ['ui-deploy', 'ui-functional', 'ui-visual', 'ui-teardown']) {
    assert.doesNotMatch(prompts[l], /tui-session/, `${l} leaked the terminal driver`)
    assert.doesNotMatch(prompts[l], /TEST_APP_SESSION/, `${l} leaked the session handle`)
  }
})

test('the run records WHICH surface it verified, and the tracks do not borrow browser numbers', async () => {
  const t = await run({ triage: tuiTriage(), overrides: {
    'ui-deploy': TUI_DEPLOY,
    'tui-functional': { ran: true, findings: [{ title: 'row clipped at 80x24', where: 'table.go', fixSize: 'minor' }] },
    'tui-visual': CLEAN } })
  assert.equal(t.out.ui.surface, 'tui')
  assert.ok(t.out.appliedFindings.some((f) => f.track === 'tui-functional'),
    'terminal findings must not merge into ui-functional, whose 6/0 precision is a browser number')

  const w = await run({ triage: baseTriage({ hasTestApp: true, uiTouched: true }), overrides: {
    'ui-functional': { ran: true, findings: [{ title: 'toast never shows', where: '/widgets', fixSize: 'minor' }] } } })
  assert.equal(w.out.ui.surface, 'web')
  assert.ok(w.out.appliedFindings.some((f) => f.track === 'ui-functional'))
})

test('the effort pins hold on the terminal surface too', async () => {
  const { opts } = await run({
    triage: tuiTriage(), overrides: { 'ui-deploy': TUI_DEPLOY, ...TUI_HALVES } })
  assert.equal(opts['tui-functional'].effort, 'high')
  assert.equal(opts['tui-visual'].effort, 'high')
  assert.equal(opts['tui-functional'].agentType, 'r:bug-hunter-ui')
  assert.equal(opts['ui-teardown'].model, 'haiku')
})

test('a non-JVM UI fix does not go to the Java agent', async () => {
  const t = await run({ triage: tuiTriage(), overrides: {
    'ui-deploy': TUI_DEPLOY,
    'tui-functional': { ran: true, findings: [{ title: 'x', where: 'table.go', fixSize: 'minor' }] },
    'tui-visual': CLEAN } })
  assert.equal(t.opts['ui-fix-minor'].agentType, 'general-purpose')

  const w = await run({ triage: baseTriage({ hasTestApp: true, uiTouched: true }), overrides: {
    'ui-functional': { ran: true, findings: [{ title: 'x', where: '/w', fixSize: 'minor' }] } } })
  assert.equal(w.opts['ui-fix-minor'].agentType, 'r:java-backend-developer')
})
