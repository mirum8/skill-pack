# r-loop — Tech design contracts

Read beside `todo.md`. Nothing here reaches an implementer: the leaf items repeat whatever they
need, because a phase is built from its own block and nothing else.

## Layout shared by every milestone

- **Module** `github.com/mirum8/skill-pack/driver` at `driver/`, Go 1.25. One package per
  component under `driver/internal/`: `events`, `config`, `state`, `plan`, `preflight`, `prompt`,
  `herdr`, `session`, `step`, `review`, `land`, `ask`, `notify`, `report`, `loop`, `ui`, `watch`,
  `watchdog`, `remedy`. The binary is `driver/cmd/r-loop`.
- **Vendor names never appear under `driver/`** except in test fixtures. Anything
  provider-specific is a field of its `providers.<name>` block in `.config/defaults.yaml` or a file
  under `lib/loop-providers/`.
- **Install** — `install.sh` builds into `<DEST>/bin/r-loop`; the source is not part of the payload.
  `go` absent → the build is skipped and named. `validate.sh` names `(cd driver && go test ./...)`
  and `lib/tests/loop-providers.test.sh`.
- **Tests** — every package has `_test.go` beside it; the herdr boundary is the `herdr.Client`
  interface with `herdr.Fake` in-memory, and git is exercised in a temp repository, never mocked.
- **Boundaries** — `loop` is the only package that sequences; `land` the only one that merges,
  ticks or commits in the primary tree (plus `preflight.Resolve`'s one commit); `session` the only
  one that calls herdr to open, prompt, read or interrupt a session — steps, the milestone and the
  watchdog alike — and the only one that commits in a worktree; `plan.Land` and
  `preflight.Resolve` the only writers of the todo; `ask` the only MCP server; `watch` and `remedy`
  the only places a watchdog signal or remedy is judged.

## Milestone 1 — Binary, configuration, state

- **Event** `{Seq, At, Kind, Phase, Step, Fields}`. Kinds: `run-started run-halted run-finished
  run-aborted phase-started phase-landed session-opened step-started step-ok step-failed
  step-stalled step-halted step-restarted waiting-input question-asked question-answered
  question-escalated answer-rejected signal-warn signal-halt signal-rejected remedy-proposed
  remedy-authorised remedy-refused remedy-rejected remedy-window-open remedy-window-closed
  gate-skipped report-skipped notify-failed ask-rejected watchdog-unreachable`. The TUI and
  `--plain` are two subscribers of one bus.
- **Exit codes** `0` landed · `1` failed / gate refused / unclaimed tree · `2` usage, git state,
  config, live run · `3` stalled past backstop · `4` preflight refused (herdr, unclean tree,
  non-primary tree, open Resolve first) · `5` watchdog halt or rejected signal · `127` missing
  binary.
- **Config** — read by `lib/read-config.py`, key by key from `<repo>/.config/skill-pack.yaml` →
  `<pack>/.config/defaults.yaml` → built-in, every substitution named in `notes`. Reached as
  `--step loop.plan|loop.implement|loop.review` and `--block providers|watchdog|notify`.

  | key | shape | rule |
  |---|---|---|
  | `steps.loop.<step>.provider` | string | must name a `providers.<name>` block, else built-in row + note |
  | `steps.loop.<step>.model` | string | passed through |
  | `steps.loop.<step>.effort` | `low\|medium\|high\|xhigh\|max` | enum |
  | `steps.loop.<step>.timeout` | `/^\d+[hm]$/` | defaults `1h` `4h` `2h` |
  | `providers.<name>.kind` | `/^[a-z][a-z0-9]*$/` | required; herdr `--kind` |
  | `providers.<name>.modelFlag` `effortFlag` `mcpFlag` `extraArgs` | string | shlex-split, then `{model} {effort} {mcpUrl} {mcpJson} {dir} {pack}` substituted per token |
  | `providers.<name>.prepare` | string | `sh -c` in the worktree before spawn, `{dir} {pack}` |
  | `providers.<name>.interruptKeys` | string | space-separated herdr key names |
  | `providers.<name>.doneSignal` | `sentinel` | enum |
  | `providers.<name>.fanout` | `native\|sequential\|none` | `native` needs `fanoutTemplate` with `{brief}` |
  | `providers.<name>.ask` | `mcp\|none` | `mcp` needs `mcpFlag` |
  | `providers.<name>.review` | `session:…` \| `cmd:…` \| empty | `{base} {dir}` |
  | `watchdog.provider` `model` `effort` | as a step row | defaults `claude sonnet high` |
  | `watchdog.answerBudget` | `/^\d+[ms]$/` | default `5m` — how long the watchdog has to cite an answer |
  | `watchdog.remedyWindow` | `/^\d+[ms]$/` | default `15m` — how long a halted run waits for a remedy |
  | `watchdog.allow` | flow list | items `deps\|ports\|containers\|locks\|restart\|retry\|provider` |
  | `notify.onHalt` `onWarn` `onDone` | string | one shell command each |

  Rules: `fix` has no row and resolves from `implement`; the milestone report session resolves
  from `plan`. The reader parses flow-style **lists** for list-typed keys only; flow-style
  **mappings** are not read (the shipped defaults are block style). `--check` fails on any value
  outside its rule. `{mcpJson}` = `{"mcpServers":{"rloop":{"type":"http","url":"<mcpUrl>"}}}`.
- **Types** — `config.Row{Provider, Model, Effort string, Timeout time.Duration, Override string}`,
  `config.Provider{Name, Kind, ModelFlag, EffortFlag, McpFlag, ExtraArgs, Prepare, InterruptKeys,
  DoneSignal, Fanout, FanoutTemplate, Ask, Review string}`, `config.WatchdogRow{Provider, Model,
  Effort string, AnswerBudget, RemedyWindow time.Duration, Allow []string}`,
  `config.NotifyRow{OnHalt, OnWarn, OnDone string}`. `LoopConfig.Fix()` → implement row;
  `LoopConfig.Milestone()` → plan row.
- **Run state** `<repo>/.r-loop/`, excluded through `<git common dir>/info/exclude`:

  ```
  .r-loop/current                       run id
  .r-loop/runs/<id>/run.json            {id, todo, baseBranch, runList, startedAt, status, exit, watchdog}
  .r-loop/runs/<id>/config.json         resolved LoopConfig with notes
  .r-loop/runs/<id>/events.jsonl        one Event per line, fsync per record
  .r-loop/runs/<id>/questions.jsonl     {seq, id, phase, step, origin, text, options, askedAt, answeredAt, answeredBy, citation, answer, escalated}
  .r-loop/runs/<id>/signals.jsonl       {seq, phase, step, source, kind, reason, evidence, at, rejected}
  .r-loop/runs/<id>/remedies.jsonl      {seq, phase, step, class, command, why, authorisedBy, result, at}
  .r-loop/runs/<id>/steps/<N>-<kind>/   prompt.md · sentinel · started · log.txt · (review) find/ fix/
  .r-loop/runs/<id>/report.md
  .r-loop/wt/phase-<N>/                 the phase worktree
  ```

  `id = YYYYMMDD-HHMMSS-<6 hex>`; `<id6>` is the hex. Every transition is recorded before the
  action it describes; `run.json.status` and `exit` are rewritten by `SetStatus` at every run
  transition and are the source of `Live()` and finished-run detection. `LastStep()` = the most
  recent `step-started` whose latest terminal event is absent or is not `step-ok`, carrying
  `{Phase, Kind, Attempt, State, CommitSHA}`. `History()` = every finished step's
  `{Phase, Kind, Duration, DiffLines}`.

## Milestone 2 — Sessions and steps

- **Plan** — a phase is `### Phase N — title`; `Files:` is every backticked path on that line;
  `Done when:` is the text after the marker up to the next `**` field or heading. Run list =
  unticked phases in numeric order, narrowed by `--from` / `--phases`. `plan.Land` ticks one
  block and appends ` <!-- built: phase-<N>-<kebab> -->` to its heading — the marker
  `milestone_scope.py` finds the landing commit by (`git log -S "built: <slug>"`).
- **Git** — `baseBranch` = the primary tree's branch at run start. Each phase branch
  `r-loop/phase-<N>` is cut from primary `HEAD` when the phase starts, and that sha is the
  phase's `PhaseBase`. The worktree `.r-loop/wt/phase-<N>` checks the branch out (not detached).
  The driver commits after **every** step, whatever its outcome — `r-loop: phase N <kind>
  (ok|failed|stalled|halted)` — and records the resulting `CommitSHA` on the step's terminal
  event. Landing: `merge --no-ff --no-commit` → `Done when` in the primary tree → `plan.Land` →
  one commit `r-loop: phase N — title`; any failure → `merge --abort`. The worktree is removed
  after a landing; the branch stays. On failure both stand.
- **herdr** — names `rl-<id6>-p<N>-<kind>` (step), `rl-<id6>-m<M>` (milestone), `rl-<id6>-wd`
  (watchdog); labels `r-loop p<N> <kind>`. Spawn order in `session.Manager.Open`: branch +
  worktree (steps only) → `prepare` → placement (workspace create with `--env R_LOOP_SENTINEL
  R_LOOP_RUN --no-focus`, or for `Split` a `pane split` right of the current pane at 0.4 with a
  workspace as the fallback) → shell handshake (process-info shows a shell and nothing else, then
  `pane run "printf ok > <stepdir>/started"` within 15 s) → record `session-opened` → `agent start
  … -- <Provider.Args>` (120 s) → `agent prompt` once. Errors are herdr's JSON `error.code`;
  liveness is decided on `agent_not_found` / `pane_not_found` only. Every `herdr.Client` method
  returns an error.
- **Sentinel** — path in `R_LOOP_SENTINEL` and in the prompt. First line `ok` | `failed`; rest is
  the summary. Anything else is `failed sentinel-unreadable`.
- **Step** `step.Step{Phase, Kind, Attempt, Row, Provider, Worktree, Branch, BaseBranch, PhaseBase,
  Timeout, Dir, SentinelPath, PlanPath, FindingsPath, VerdictPath, ReportPath, Prompt, McpURL}`;
  `step.Deps{Manager, Store, Bus, Questions, Halt, Now, Poll}`; `Questions` is `Open(phase int,
  kind string) bool`; `Halt <-chan string` is how anything outside the runner stops a step.
  Kinds: `plan`, `implement`, `review-find`, `review-fix`, `milestone`; `watchdog` is a session
  kind only. `Outcome{State, Reason, CommitSHA, Duration, DiffLines}`.
- **Evidence** (the second signal, checked after a sentinel and after the step's commit):

  | kind | evidence | failure reason |
  |---|---|---|
  | plan | `PlanPath` (`.task-plans/phase-<N>-<kebab>.md`) exists with a `^status:` line | `plan-missing` |
  | implement | `git diff --quiet <PhaseBase>..HEAD -- . ':(exclude).task-plans'` reports a change | `no-diff` |
  | review-find | the findings file exists (empty allowed) | `findings-missing` |
  | review-fix | `verdict.md` first line `clean` (ok) / `unresolved` (failed) | `review-unresolved` · `verdict-missing` |
  | milestone | sentinel `ok` **and** `ReportPath` (from `milestone_scope.py --milestone M`) exists and is non-empty | `report-missing`, turned into `report-skipped` by the gate — never a halt |

- **Step states** `queued → spawned → running → ok | failed | stalled | halted`, plus
  `waiting-input` (backstop paused) which returns to `running`. Poll every 10 s. `stalled` =
  `idle|blocked` on two consecutive polls with no sentinel and no open question, or the backstop
  elapsed. `failed` / `stalled` / `halted` leave everything standing; the report carries
  `r-loop resume`.
- **Review** — one `review` step, two sessions. Find half by `providers.<p>.review`: `cmd:` →
  subprocess, stdout → `find/findings.md`; `session:` → `review-native.md` on the review row;
  empty → `review.md` on the review row (templated fan-out). Empty findings skip the fix half and
  write `fix/verdict.md` = `clean\nno findings`. Fix half → `fix.md` on the implement row in the
  worktree. `findings.md` lines: `- <file>:<line> — <severity> — <claim>`. `verdict.md`: line 1
  `clean|unresolved`, then `confirmed|dismissed|fixed — <reason>` per finding.
- **Prompt variables** `phaseBlock phaseNumber phaseTitle todoPath planPath branch worktree base
  sentinelPath acceptance findingsPath verdictPath reviewCommand reportPath runDir addendum`
  (`base` is the base branch name); `{{agent:<name>}}` reads `agents/<name>.md`. Lookup:
  `<repo>/.config/loop-prompts/<name>.md` else `<pack>/lib/loop-prompts/<name>.md`; the banner and
  the step record name the file used. Shipped: `plan implement review review-native fix
  milestone watchdog` and `agents/{logic,data,silent,docs}`.

## Milestone 3 — The ask channel

- **Transport** — MCP over streamable HTTP on `127.0.0.1:<ephemeral>`, one server per run
  (`github.com/modelcontextprotocol/go-sdk`). Surfaces are paths with a 32-hex token:
  `/mcp/step/<token>` (one per step) and `/mcp/watchdog/<token>` (one per run). The URL reaches a
  session through `Provider.Args` as `{mcpUrl}` / `{mcpJson}`.
- **Tools** — step surface: `ask_user(question string, options []string) → {answer}` (blocks).
  Watchdog surface: `ask_user`, `signal(kind, step, reason, evidence)`, `answer_question(id,
  answer, citation)`, and from Milestone 6 `propose_remedy(class, command, why) → {decision}`,
  `restart_step(step, addendum, provider)`.
- **Question** `{id: q<seq>, phase, step, origin: session|driver, text, options, askedAt,
  answeredAt, answeredBy: maintainer|watchdog, citation, answer, escalated}`. A session question
  sets `waiting-input` and pauses the backstop; a question never expires. `Server.AskMaintainer`
  is the driver-originated form (Resolve-first entries, consent prompts): same record and bus,
  never routed to the watchdog. Routing of session questions: watchdog first when a watchdog
  surface exists; `citation` must match `^[^:\s]+:\d+`; rejected or past `answerBudget` →
  `escalated`, shown to the maintainer. The maintainer may answer any question at any time.
- **Faces' input** — the TUI banner, started before `preflight.Resolve` so its entries are the
  first questions shown; `--plain` with a terminal on stdin reads `answer <qid> <text>` (consent
  prompts take `yes` / `no` as the text). Without a terminal, open questions wait; Resolve-first
  entries exit `4`.
- **Resolve first** — `resolve_scope.py --outstanding --phases` decides what blocks; the entry is
  the `- [ ] **<name>**` line plus its indented continuation lines under `## Resolve first`; the
  stamp is `Resolved: <YYYY-MM-DD> — <answer>` inserted after the last continuation line, the
  box ticked, committed as `r-loop: resolve — <name>` before the loop starts; re-checked to
  `gate: clear`.

## Milestone 4 — The run

- **Sequence** — `config.Load` → `preflight.Run` → `state.Create` → `ask.Serve` → the face (TUI,
  or `events.Plain` + `ask.PlainInput`) → `preflight.Resolve` → (watchdog start, Milestone 6) →
  `loop.Run` → `report.Write` → exit. Per phase: record `phase-started` with `PhaseBase` → `plan`
  → `implement` → `review` → `land.Phase` → `phase-landed`.
- **Halt and the remedy window** — a `failed|stalled|halted` step records `run-halted`,
  `SetStatus("halted", code)`, fires `onHalt`, then waits on `Control{Restart, Quit}`: a
  `Restart{Phase, Kind, Addendum, Provider}` reopens that step as `Attempt+1` and the walk
  continues; `Quit` returns the code. With a watchdog present the wait is `remedyWindow`; with
  only a TUI it lasts until a key; with neither it is skipped.
- **Step construction** (in `loop/steps.go`): `Branch r-loop/phase-<N>`, `Worktree
  .r-loop/wt/phase-<N>`, `Row = Cfg.Steps[kind]` (`review-fix` → `Cfg.Fix()`), `Provider =
  Cfg.Resolve(Row)`, `Timeout = Row.Timeout`, `Dir = StepDir(N, kind)`, `SentinelPath =
  Dir/sentinel`, `PlanPath = <Worktree>/.task-plans/<Slug>.md`, `FindingsPath`/`VerdictPath`
  under `Dir/find/` and `Dir/fix/`, `McpURL = StepSurface(N, kind)` when `Provider.Ask == mcp`,
  `Prompt = Render("<kind>.md", vars, Provider)`.
- **Notify** — `sh -c <hook>`, 60 s timeout, env `R_LOOP_RUN R_LOOP_TODO R_LOOP_OUTCOME
  R_LOOP_PHASE R_LOOP_STEP R_LOOP_REASON R_LOOP_REPORT`; failure recorded as `notify-failed` and
  ignored. `onHalt` on every halt, `onDone` on exit `0`, `onWarn` on every warn signal.
- **Resume** — re-runs `LastStep()` (the most recent step that did not end `ok`) with `Attempt+1`
  on the same worktree and branch, then continues the walk. Refuses (`resume-unclaimed-tree`,
  exit `1`) when the worktree is dirty or `HEAD` ≠ the step's recorded `CommitSHA`; refuses (exit
  `2`) when the step's session is still live or the run is still `running`; a finished run is a
  no-op. `abort` records `run-aborted`, `SetStatus("aborted", 1)`, leaves everything standing.
- **Report** `report.md`: phases landed with shas; every step's provider/model/effort/prompt
  source/attempt/duration/outcome; gate and report skips; degradations; questions with answerer
  and citation; signals with source and rejection; remedies verbatim with who allowed them; exit
  code. `report.Status` is the `key: value` form `status` and the TUI header share.

## Milestone 5 — The TUI

- **Arrangement** — rail-and-detail, as the root `DESIGN.md` records: 24-column rail; detail pane
  and watchdog feed stacked to its right; full-width question banner above a one-line key bar.
  Tokens (Instrument): surface `#0F1115`, raised `#171A20`, on-surface `#D6DAE0`, dim `#8A929E`,
  primary `#6E9FC4`, secondary `#E0A458`, tertiary `#8FA87F`, error `#E0736A`, outline `#2E343D`;
  gutter 2, pad 1, margin 2, rail 24. Single-line box drawing; bold only on the live phase; amber
  means something waits for a person and nothing else.
- **Keys** `j`/`k` rail · `enter` detail · `a` answer · `1`–`9` option · `y`/`n` consent · `q`
  confirm abort.
- **Faces** — the TUI and `--plain` are two subscribers of one `events.Bus`; nothing is rendered
  that was not an event, and `report.Status` is the header's source. The TUI is started before
  `preflight.Resolve` and stays up through the remedy window; it exits on a key after the run's
  terminal event, with the run's exit code.

## Milestone 6 — The watchdog

- **Tiers** — veto (`warn`, `halt`) unilateral; remedy (`deps ports containers locks restart retry
  provider`) with consent; approve never. Enforcement is in `watch` and `remedy`, not in the prompt.
- **Signal** `{seq, phase, step, source: driver|watchdog, kind: warn|halt, reason, evidence, at,
  rejected}`. `warn` → banner + `onWarn`, run continues. `halt` → a reason on the step runner's
  `Halt` channel; the runner calls `Session.Interrupt()`, commits the tree, and the step ends
  `halted`; run exits `5`. Any forward-moving payload → `signal-rejected`, treated as a halt, run
  exits `5` with the payload in the report. A watchdog `halt` needs non-empty `evidence`.
- **Deterministic checks** (every 30 s, once per step, run with or without the watchdog session):
  `files-outside-scope` warn · `plan-touched` halt · `slow-step` warn (>2× median duration of the
  kind over ≥2 earlier phases) · `large-diff` warn (>3× median implement `DiffLines` over ≥2) ·
  `tests-modified` warn.
- **Session** — opened through `session.Manager.Open` with `Kind: watchdog, Split: true, Cwd:
  repo` on the `watchdog` row: the manager splits right of the driver's pane at 0.4 or falls back
  to a workspace, runs `prepare`, the handshake and `rl-<id6>-wd`. Told one line per event
  (`run-started`, `step-started`, `question`, `step-failed`, `step-stalled`, `run-halted`)
  through `Session.Tell`. Reads sessions with `herdr agent read`, never writes to one. Gone →
  `warn watchdog-gone`, run continues, questions escalate at once, no remedy window.
- **Remedy** `{seq, phase, step, class, command, why, authorisedBy: allow|maintainer|"", result,
  at}`, recorded verbatim before the decision. Allow-listed → authorised; else a consent prompt
  through `AskMaintainer`. The watchdog runs the command; the driver never does. `restart_step`
  is accepted only for `LastStep()` in `failed|stalled|halted`, classed `restart|retry|provider`,
  consent-checked like a remedy, and delivered as `loop.Restart` into the remedy window, which
  reopens the step as `Attempt+1` with `{{addendum}}` and the override row.

## Open questions

Decisions the spec did not settle, taken here so the plan could be built. Each names the
alternative and what would have to be true for it to win.

- **The landing sequence.** The spec's goal row says the phase's `Done when:` "exits 0 in the
  primary tree before `git merge` runs". Taken literally that tests the base without the phase's
  code, so the plan runs `merge --no-ff --no-commit`, then the gate, then ticks and makes the one
  commit — no merge commit exists until the gate passes. Alternative: run the gate in the phase
  worktree before any merge. It wins if a `--no-commit` merge in the primary tree turns out to
  disturb tools that read the index while the gate command runs.
- **The milestone report session's row.** The spec configures `plan`, `implement` and `review`
  and says the fix half resolves from `implement`; it does not say what the milestone session
  runs on. Taken: the `plan` row, since it reads the plan and the repo and writes markdown.
  Alternative: its own `steps.loop.milestone` row. It wins the first time a report wants a
  cheaper or deeper model than the planner.
- **`fanout: sequential` against `fanout: none`.** The spec's enum carries both and describes only
  `none` as a degradation. Taken: both render the briefs one after another in the session;
  `sequential` is a declared choice and is not flagged, `none` is recorded as a degradation.
  Alternative: drop `sequential`. It wins if no provider block ever declares it.
- **Answering under `--plain`.** The spec gives `--plain` no input surface. Taken: when stdin is a
  terminal, `answer <qid> <text>` lines answer questions and `yes`/`no` answer consent prompts;
  without a terminal, questions wait and Resolve-first entries exit `4`. Alternative: an
  `r-loop answer <qid> <text>` subcommand writing into the run directory. It wins when a run is
  driven from a script that cannot hold stdin.
- **The remedy window.** The spec says a remedied step "restarts in a fresh session" but a failed
  step also halts the run; nothing says how long the driver stays up for the remedy. Taken:
  `watchdog.remedyWindow` (default 15 m) after a halt while a watchdog is present, and until a
  key while the TUI is up. Alternative: no window, `restart_step` only ever through `r-loop
  resume`. It wins if the window is found holding runs that nobody was going to remedy.
- **The v1 count in the spec.** Part 1 says "sixteen of the eighteen" stories ship, but its own
  table names seventeen (only *Add a provider the driver has never seen* is deferred, and the
  spec says its read-and-validate half ships). The plan cites the deferred story on the three
  config leaves for exactly that half. The spec's sentence should say seventeen.
