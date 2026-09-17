# r-loop — Implementation Plan

Spec: `spec.html` · Sources: `spec.html`, `interview-notes.md` · Status: draft
Milestones 1–6 deliver v1. Each leaf is scoped to roughly one focused session.
Everything under "Resolve first" is closed by a person, or by `/r:plan-unblock` asking one.

The driver is a Go module under `driver/` (`github.com/mirum8/skill-pack/driver`); `install.sh` builds
it into `<install target>/bin/r-loop`. Shipped prompts live under `lib/loop-prompts/`, the one
provider-specific helper under `lib/loop-providers/`, and the settings in `.config/defaults.yaml`.

## Resolve first

## Waves
<!-- generated from the Depends on edges — regenerate, never hand-edit -->
- Wave 0: Phase 1, Phase 2
- Wave 1: Phase 3, Phase 4, Phase 5, Phase 9
- Wave 2: Phase 6, Phase 7, Phase 10, Phase 16
- Wave 3: Phase 8, Phase 11
- Wave 4: Phase 12, Phase 13, Phase 14
- Wave 5: Phase 15
- Wave 6: Phase 17
- Wave 7: Phase 18, Phase 21
- Wave 8: Phase 19, Phase 22
- Wave 9: Phase 20, Phase 23
- Wave 10: Phase 24

## Milestone 1 — Binary, configuration, state
Contracts: `tech-design.md#milestone-1--binary-configuration-state`

### Phase 1 — Go module, CLI skeleton and the event stream
**Implements:** See where a run is
**Depends on:** —
**Files:** `driver/go.mod` (new) · `driver/cmd/r-loop/main.go` (new) · `driver/cmd/r-loop/main_test.go` (new) · `driver/internal/events/events.go` (new) · `driver/internal/events/plain.go` (new) · `driver/internal/events/events_test.go` (new) · `install.sh` (modify) · `check-prereqs.sh` (modify) · `validate.sh` (modify)
- [ ] `driver/go.mod` declares module `github.com/mirum8/skill-pack/driver` on `go 1.25`; no dependency yet
- [ ] `r-loop` parses `run <todo>` (the bare `r-loop <todo>` form), `status`, `resume`, `abort` and the flags `--from N`, `--phases n,n`, `--provider <step>=<name>` (repeatable), `--no-watchdog`, `--plain`, `--dry-run`; anything else prints one usage line on stderr and exits `2`
- [ ] `events.Event{Seq int, At time.Time, Kind string, Phase int, Step string, Fields map[string]string}` and `events.Bus` with `Publish(Event)` and `Subscribe() <-chan Event`; every subscriber sees every event in order, and `Seq` is assigned by the bus
- [ ] `events.Plain` writes one line per event to an `io.Writer`: `15:04:05  <kind>  phase <N>  <step>  k=v k=v`, keys sorted, values with spaces quoted
- [ ] `main` maps an outcome to the exit table: `0` landed, `1` step failed or gate refused, `2` usage/git/config, `3` stalled past backstop, `4` preflight refused, `5` watchdog halt or rejected signal, `127` missing binary
- [ ] `install.sh` runs `(cd "$REPO/driver" && go build -o "$DEST/bin/r-loop" ./cmd/r-loop)` after the payload copy, prints `add $DEST/bin to PATH` when that directory is not on `$PATH`, and when `go` is absent names the skipped build and still exits 0
- [ ] `check-prereqs.sh` reports `go` as mandatory with the install line `brew install go`
- [ ] `validate.sh` runs `(cd driver && go test ./...)` as a named suite with the same pass/fail reporting as the shell suites
- [ ] `main_test.go` asserts an unknown subcommand and a malformed `--provider` value exit `2`; `events_test.go` asserts ordering across two subscribers and the plain line format
**Done when:** `cd driver && go vet ./... && go test ./cmd/... ./internal/events/...` is green, and `./install.sh --dry-run` prints the build step.

### Phase 2 — The config reader learns the loop's keys
**Implements:** Choose the agent for each step · Be told when a run halts · Add a provider the driver has never seen
**Depends on:** —
**Files:** `lib/read-config.py` (modify) · `lib/tests/config.test.sh` (modify)
- [ ] `SPEC` gains the rows `loop.plan`, `loop.implement`, `loop.review`, each `{provider: string, model: string, effort: enum low|medium|high|xhigh|max, timeout: /^\d+[hm]$/}` with built-in defaults `claude/opus/high/1h`, `codex/gpt-5.6-sol/medium/4h`, `claude/sonnet/high/2h`; `--step loop.plan` resolves `steps.loop.plan` key by key through the same three layers and `notes`
- [ ] `--block providers|watchdog|notify` prints that top-level block resolved as one JSON object with `notes` and `sources`
- [ ] the parser gains flow-style lists `[a, b]` of scalars for keys declared list-typed and nowhere else; flow-style mappings `{ a: b }` stay unread and are named in `notes`
- [ ] a `providers.<name>` block carries `kind` (required, `/^[a-z][a-z0-9]*$/`; a block without it is dropped and named), `modelFlag`, `effortFlag`, `mcpFlag`, `extraArgs`, `prepare`, `interruptKeys`, `doneSignal` (enum `sentinel`), `fanout` (enum `native|sequential|none`), `fanoutTemplate`, `ask` (enum `mcp|none`), `review` (`/^(session:|cmd:).+$/` or empty); an unknown field is named and ignored, and a missing string field is the empty string
- [ ] `watchdog` resolves `{provider: string default claude, model default sonnet, effort enum default high, answerBudget: /^\d+[ms]$/ default 5m, remedyWindow: /^\d+[ms]$/ default 15m, allow: list}` where every `allow` item is one of `deps|ports|containers|locks|restart|retry|provider` and an item outside that set is dropped and named; `notify` resolves `{onHalt, onWarn, onDone}` as strings defaulting to empty
- [ ] a `loop.*` row whose `provider` names no `providers.<name>` block in either file resolves to the built-in row and names the missing block; the codex-plugin presence check is not applied to loop rows (the loop starts the Codex CLI through herdr, not the plugin)
- [ ] `--check FILE` walks the new rows and blocks and exits non-zero on any value outside its rule
- [ ] `config.test.sh` covers: `--step loop.implement` from a project file overriding only `effort` keeps the shipped model; an unknown provider name notes it and falls back; `allow: [deps, ports]` yields two items; `allow: deps` notes it; `timeout: 90` notes it and keeps the default; `review: foo:x` notes it; `--block providers` drops a block without `kind` and names it; a flow-style mapping is named, not read
**Done when:** `bash lib/tests/config.test.sh` is green.

### Phase 3 — The shipped provider blocks and the trust helper
**Implements:** Choose the agent for each step · Add a provider the driver has never seen
**Depends on:** Phase 2
**Files:** `.config/defaults.yaml` (modify) · `lib/loop-providers/claude-trust.py` (new) · `lib/tests/loop-providers.test.sh` (new) · `validate.sh` (modify)
**Risk:** security
- [ ] `.config/defaults.yaml` gains, in block style (the reader does not read flow mappings), each key commented with its meaning:
      ```yaml
      steps:
        loop:
          plan:
            provider: claude
            model: opus
            effort: high
            timeout: 1h
          implement:
            provider: codex
            model: gpt-5.6-sol
            effort: medium
            timeout: 4h
          review:
            provider: claude
            model: sonnet
            effort: high
            timeout: 2h
      providers:
        claude:
          kind: claude
          modelFlag: "--model {model}"
          effortFlag: "--effort {effort}"
          mcpFlag: "--mcp-config {mcpJson}"
          extraArgs: "--permission-mode auto --add-dir {pack}"
          prepare: "python3 {pack}/lib/loop-providers/claude-trust.py {dir}"
          interruptKeys: "esc"
          doneSignal: sentinel
          fanout: native
          fanoutTemplate: "Dispatch this brief to a subagent with the Agent tool, alongside the other briefs, and wait for its report: {brief}"
          ask: mcp
          review: "session:/code-review --base {base}"
        codex:
          kind: codex
          modelFlag: "-c model={model}"
          effortFlag: "-c model_reasoning_effort={effort}"
          mcpFlag: "-c mcp_servers.rloop.url={mcpUrl}"
          extraArgs: "--full-auto"
          prepare: ""
          interruptKeys: "esc"
          doneSignal: sentinel
          fanout: native
          fanoutTemplate: "Spawn a Codex sub-agent for this brief and wait for its report: {brief}"
          ask: mcp
          review: "cmd:codex review --base {base}"
      watchdog:
        provider: claude
        model: sonnet
        effort: high
        answerBudget: 5m
        remedyWindow: 15m
        allow: []
      notify:
        onHalt: ""
        onWarn: ""
        onDone: ""
      ```
- [ ] the file's comments say the `fix` half has no row and resolves from `steps.loop.implement`, and the milestone report session resolves from `steps.loop.plan`
- [ ] `lib/loop-providers/claude-trust.py <dir>` marks `<dir>` — both `os.path.abspath` and `os.path.realpath` — as `hasTrustDialogAccepted: true` under `projects` in `~/.claude.json` (`$CLAUDE_CONFIG` overrides the path), re-reading immediately before writing and renaming a temp file into place; exit 1 with one stderr line when the file is unreadable
- [ ] `lib/tests/loop-providers.test.sh` runs the helper against a temp config: both paths marked, other keys untouched, unreadable file exits 1
- [ ] `validate.sh` names `lib/tests/loop-providers.test.sh` beside the other shell suites
**Done when:** `python3 lib/read-config.py --check .config/defaults.yaml` exits 0 and `bash lib/tests/loop-providers.test.sh` is green.

### Phase 4 — ConfigReader and ProviderRegistry
**Implements:** Choose the agent for each step · Try a different provider for one run · Add a provider the driver has never seen
**Depends on:** Phase 1, Phase 2
**Files:** `driver/internal/config/config.go` (new) · `driver/internal/config/provider.go` (new) · `driver/internal/config/config_test.go` (new) · `driver/internal/config/testdata/reader.sh` (new)
- [ ] `config.Load(repo, pack string, overrides map[string]string) (*LoopConfig, error)` runs `python3 <pack>/lib/read-config.py --step loop.<s> --repo <repo> --pack <pack>` for `plan`, `implement`, `review` and `--block providers|watchdog|notify`, parses the JSON, and carries every `notes` line and every `sources` entry
- [ ] `LoopConfig{Steps map[string]Row, Providers map[string]Provider, Watchdog WatchdogRow, Notify NotifyRow, Notes []string}`; `Row{Provider, Model, Effort string, Timeout time.Duration, Override string}`; `WatchdogRow{Provider, Model, Effort string, AnswerBudget, RemedyWindow time.Duration, Allow []string}`; `NotifyRow{OnHalt, OnWarn, OnDone string}`
- [ ] `LoopConfig.Fix() Row` returns the implement row; `LoopConfig.Milestone() Row` returns the plan row
- [ ] `--provider <step>=<name>` is applied after the read: `Row.Override` keeps the file value it replaced, and a step or name that does not exist is an error naming both
- [ ] `Provider{Name, Kind, ModelFlag, EffortFlag, McpFlag, ExtraArgs, Prepare, InterruptKeys, DoneSignal, Fanout, FanoutTemplate, Ask, Review string}`; `LoopConfig.Resolve(Row) (Provider, error)` fails when `Row.Provider` names no block, naming the step and the name
- [ ] `Provider.Args(model, effort, mcpURL, dir, pack string) []string` shlex-splits `ModelFlag`, `EffortFlag`, `McpFlag`, `ExtraArgs` in that order, then substitutes `{model} {effort} {mcpUrl} {mcpJson} {dir} {pack}` inside each token, where `{mcpJson}` is `{"mcpServers":{"rloop":{"type":"http","url":"<mcpUrl>"}}}`; a substituted value stays one argv element; an empty flag or an empty `mcpURL` contributes nothing
- [ ] `Provider.Validate() []string` reports: `Kind` outside `/^[a-z][a-z0-9]*$/`, `Fanout == native` without `{brief}` in `FanoutTemplate`, a `Review` value with neither `session:` nor `cmd:` prefix, `Ask == mcp` with an empty `McpFlag`, and names `kind executable` as the one field it cannot check
- [ ] `LoopConfig.Banner() []string`: one line per step `plan: claude opus high 1h — <source file>`, an `(override of <file value>)` suffix where set, `fix: resolves from implement — <provider model effort>`, `watchdog: <provider model effort> allow=[…]`, and every `Notes` line
- [ ] `config_test.go` drives `Load` against `testdata/reader.sh`, a fake reader printing fixture JSON: overrides, a missing block, `{mcpJson}` staying one argv, empty `mcpURL` adding nothing, `Validate` on each bad shape, `Banner` wording
**Done when:** `cd driver && go test ./internal/config/...` is green.

### Phase 5 — StateStore
**Implements:** Resume a run that stopped · Stop a run without losing work
**Depends on:** Phase 1
**Files:** `driver/internal/state/store.go` (new) · `driver/internal/state/store_test.go` (new)
**Risk:** persistence
- [ ] `state.Create(repo string) (*Store, error)` makes `<repo>/.r-loop/runs/<id>/` with `id = YYYYMMDD-HHMMSS-<6 hex>` (`Store.ID6()` is the hex), writes the id to `<repo>/.r-loop/current`, and appends `.r-loop/` to `<git common dir>/info/exclude` when absent — never to `.gitignore`
- [ ] `run.json` holds `{id, todo, baseBranch, runList []int, startedAt, status: created|running|halted|finished|aborted, exit int, watchdog: on|off}`; `SetStatus(status string, exit int)` and `SetWatchdog(on bool)` rewrite it atomically (temp file + rename); `config.json` holds the resolved `LoopConfig` including `Notes`
- [ ] `Record(Event) error` appends one JSON line to `events.jsonl` and returns only after `fsync`; callers record a transition before performing it
- [ ] `Question`, `Signal`, `Remedy` records append to `questions.jsonl`, `signals.jsonl`, `remedies.jsonl` with the same fsync rule, each carrying `seq` and `at`; `UpdateRemedy(seq, fields)` and `UpdateQuestion(id, fields)` rewrite one record in place
- [ ] `StepDir(N int, kind string) string` = `steps/<N>-<kind>/`, created on demand; the review step additionally gets `find/` and `fix/` beneath it
- [ ] `state.Open(repo)` loads the run named by `current`; `LastStep() *StepRef` is the most recent `step-started` whose latest terminal event is absent or is `step-failed|step-stalled|step-halted` — never one that ended `step-ok` — carrying `{Phase, Kind, Attempt, State, CommitSHA}`; `Live()` is true when `run.json.status == running`
- [ ] `History() []StepRecord` returns every finished step with `{Phase, Kind, Duration, DiffLines}` read from the events, for the deterministic checks
- [ ] `store_test.go` asserts: a record written and a crash before the action reads back as that step to re-run; a failed step is `LastStep()` and an ok step is not; `current` moves to the new run; `Live()` is false after `SetStatus("halted", 1)`; the exclude line is written once; `UpdateRemedy` changes one record
**Done when:** `cd driver && go test ./internal/state/...` is green.

## Milestone 2 — Sessions and steps
Contracts: `tech-design.md#milestone-2--sessions-and-steps`

### Phase 6 — Plan reading and preflight
**Implements:** Run every remaining phase of a plan
**Depends on:** Phase 4, Phase 5
**Files:** `driver/internal/plan/plan.go` (new) · `driver/internal/plan/plan_test.go` (new) · `driver/internal/plan/testdata/todo.md` (new) · `driver/internal/preflight/preflight.go` (new) · `driver/internal/preflight/preflight_test.go` (new) · `driver/cmd/r-loop/main.go` (modify)
- [ ] `plan.Parse(path) (*Plan, error)` reads phases with the heading `^###\s+Phase\s+(\d+)\s*[—-]\s*(.+)$`, each `Phase{N, Title, Block, Files []string, Risk, DoneWhen string, Items []Item{Text, Ticked bool}, Milestone int}`; `Files` is every backticked path on the `**Files:**` line; `DoneWhen` is the text after `**Done when:**` up to the next `**` field or heading
- [ ] `plan.RunList(p, from int, only []int) ([]int, error)`: unticked phases in numeric order; `from` keeps those ≥ N; `only` keeps exactly those and errors on a ticked or unknown number
- [ ] `plan.Slug(N int, title string) string` = `phase-<N>-<kebab title>` truncated to 60 characters
- [ ] `plan.Land(path string, N int) error` flips every `- [ ]` to `- [x]` inside phase N's block and appends ` <!-- built: phase-<N>-<kebab title> -->` to that phase's heading line, rewriting nothing else byte for byte
- [ ] `preflight.Run(cfg, repo, runList) (code int, err error)` checks in order: `git`, `python3`, `herdr` on `PATH` (else `127`, naming the binary); `herdr workspace list` answers with a JSON `result` (else `4`); the tree is primary — `git rev-parse --git-dir` equals `--git-common-dir` (else `4`); `git status --porcelain` is empty (else `4`); no live run per `state.Live` (else `2`); every run-list step's provider resolves (else `2`) and its `Kind` is on `PATH` (else `127`)
- [ ] `--dry-run` prints the banner and the run list as `phase N — title` lines and exits `0` before any spawn
- [ ] `plan_test.go` uses `testdata/todo.md` (five phases, two ticked, one with no `Done when:`): run list, `--from`, `--phases` on a ticked phase, `Land` leaves every other block byte-identical and puts the marker on the heading; `preflight_test.go` covers each refusal with a temp repo and a fake `PATH`
**Done when:** `cd driver && go test ./internal/plan/... ./internal/preflight/...` is green.

### Phase 7 — PromptRenderer
**Implements:** Override the prompts for this project · Fan out reviewers using my own mechanism
**Depends on:** Phase 4
**Files:** `driver/internal/prompt/render.go` (new) · `driver/internal/prompt/render_test.go` (new) · `driver/internal/prompt/testdata/pack/loop-prompts/step.md` (new) · `driver/internal/prompt/testdata/pack/loop-prompts/agents/logic.md` (new) · `driver/internal/prompt/testdata/repo/.config/loop-prompts/step.md` (new)
- [ ] `prompt.Render(repo, pack, name string, vars map[string]string, p config.Provider) (Rendered, error)` reads `<repo>/.config/loop-prompts/<name>.md` when it exists, else `<pack>/lib/loop-prompts/<name>.md`; `Rendered{Text, Source string, Degraded bool}` names the file used
- [ ] `prompt.Vars` is the exact set `phaseBlock phaseNumber phaseTitle todoPath planPath branch worktree base sentinelPath acceptance findingsPath verdictPath reviewCommand reportPath runDir addendum`; a `{{name}}` outside it, or a variable used by the template that the caller did not supply, is an error naming it and the template
- [ ] `{{agent:<name>}}` reads `agents/<name>.md` under the same override rule and expands by `p.Fanout`: `native` → `p.FanoutTemplate` with `{name}` and `{brief}` substituted; `sequential` → `Then, in this session, carry out this review yourself:` followed by the brief; `none` → the sequential text with `Degraded = true`; a missing brief file is an error naming it
- [ ] `render_test.go` on the `testdata` pack and repo: the project override wins and `Source` names it; the pack file is used when the override is absent; an unknown variable, an unsupplied variable and a missing brief each error by name; `native` expansion of `{{agent:logic}}`; `Degraded` under `none` and not under `sequential`
**Done when:** `cd driver && go test ./internal/prompt/...` is green.

### Phase 8 — The shipped templates and reviewer briefs
**Implements:** Override the prompts for this project · Fan out reviewers using my own mechanism
**Depends on:** Phase 7
**Files:** `lib/loop-prompts/plan.md` (new) · `lib/loop-prompts/implement.md` (new) · `lib/loop-prompts/review.md` (new) · `lib/loop-prompts/review-native.md` (new) · `lib/loop-prompts/fix.md` (new) · `lib/loop-prompts/milestone.md` (new) · `lib/loop-prompts/watchdog.md` (new) · `lib/loop-prompts/agents/logic.md` (new) · `lib/loop-prompts/agents/data.md` (new) · `lib/loop-prompts/agents/silent.md` (new) · `lib/loop-prompts/agents/docs.md` (new) · `driver/internal/prompt/shipped_test.go` (new)
- [ ] every step template ends with the same instruction: as the last action, write `ok` or `failed` as the first line of `{{sentinelPath}}` followed by a one-paragraph summary; the `ask_user` tool is named as the way to ask when the phase, the plan or the code does not answer a question
- [ ] `plan.md` asks for `{{planPath}}` with a first line `status: planned`, test-first slices derived from `{{phaseBlock}}` and `{{acceptance}}`, and reads `spec.html` and `tech-design.md` beside `{{todoPath}}` when present
- [ ] `implement.md` asks for `{{planPath}}` to be followed test-first in `{{worktree}}` on `{{branch}}`, no commits (the driver commits), no edit to `{{todoPath}}` or any checkbox, and `ask_user` whenever the plan does not say
- [ ] `review.md` reviews `git diff {{base}}...HEAD` in `{{worktree}}` through `{{agent:logic}} {{agent:data}} {{agent:silent}} {{agent:docs}}` and writes `{{findingsPath}}` as one `- <file>:<line> — <severity> — <claim>` line per finding, or an empty file when there are none; `review-native.md` runs `{{reviewCommand}}` in `{{worktree}}` and writes its output to `{{findingsPath}}` verbatim
- [ ] `fix.md` verifies each finding in `{{findingsPath}}` against the code, fixes the confirmed ones in `{{worktree}}`, and writes `{{verdictPath}}` with first line `clean` or `unresolved` followed by one `confirmed|dismissed|fixed — <reason>` line per finding
- [ ] `milestone.md` asks for the report at `{{reportPath}}`, written from `{{todoPath}}`, the merged code in `{{worktree}}` and the spec beside the plan; `watchdog.md` states the three tiers (veto unilaterally, remedy with consent, never approve), the `path:line` citation rule for `answer_question`, a two-minute `herdr agent read <agent> --lines 200` cadence during a live step, that `signal(halt)` is emitted only after `git diff` in the worktree agrees with what was read, and that `propose_remedy` carries the exact command
- [ ] the four agent briefs each describe one reviewer's lens in under 200 words: logic and flow; data races, shared state and performance; silent failures and language traps; documentation and stated rules
- [ ] `shipped_test.go` renders every file under `lib/loop-prompts/` through `prompt.Render` against the real pack root with a full variable set and both `native` and `none` providers, asserting no error and that `review.md` is the only template whose `Degraded` flips
**Done when:** `cd driver && go test ./internal/prompt/...` is green.

### Phase 9 — herdr client
**Implements:** See where a run is
**Depends on:** Phase 1
**Files:** `driver/internal/herdr/client.go` (new) · `driver/internal/herdr/fake.go` (new) · `driver/internal/herdr/client_test.go` (new)
- [ ] `herdr.Client` interface, every method returning `error` last: `WorkspaceCreate(cwd, label string, env []string) (ws, pane string, err error)`, `WorkspaceClose(ws string) error`, `WorkspaceList() error`, `PaneProcessInfo(pane string) (shellPID int, foreground []string, err error)`, `PaneRun(pane, cmd string) error`, `PaneCurrent() (string, error)`, `PaneSplit(pane, direction string, ratio float64, cwd string) (string, error)`, `AgentStart(name, kind, pane string, args []string, timeout time.Duration) error`, `AgentPrompt(name, text string) error`, `AgentStatus(name string) (string, error)`, `AgentWait(name string, until []string, timeout time.Duration) (string, error)`, `AgentRead(name string, lines int) (string, error)`, `SendKeys(name string, keys ...string) error`
- [ ] `herdr.CLI` runs `herdr <args>` with the environment inherited, parses `{"id","result"}` or `{"error":{"code","message"}}` into a value or `*herdr.Error{Code, Message}`; a non-JSON answer is `*herdr.Error{Code: "unparseable"}` carrying the first 200 bytes
- [ ] `herdr.IsNotFound(err) bool` is true exactly for the codes `agent_not_found` and `pane_not_found` (herdr 0.9.0's answers to `agent get` and `pane get` on an unknown target)
- [ ] `WorkspaceCreate` maps `--cwd --label --env … --no-focus` and reads `result.workspace.workspace_id` and `result.root_pane.pane_id`; `PaneProcessInfo` reads `result.process_info.shell_pid` and `foreground_processes[].argv0`; `PaneSplit` maps `--pane --direction --ratio --cwd` and reads the new pane id; `AgentStart` passes `--kind --pane --timeout <ms> -- <args…>`; `AgentStatus` reads `agent_status` from `agent get`
- [ ] `herdr.Fake` is an in-memory `Client` with scripted `AgentStatus` sequences per agent, a `NotFound` set, a `Fail` map of method → error, and a record of every call in order — the double every later suite uses
- [ ] `client_test.go` parses both JSON shapes, the unparseable case, the two not-found codes, and the argv each method builds
**Done when:** `cd driver && go test ./internal/herdr/...` is green.

### Phase 10 — SessionManager
**Implements:** Report a step's outcome so the driver can act · See where a run is
**Depends on:** Phase 4, Phase 5, Phase 9
**Files:** `driver/internal/session/manager.go` (new) · `driver/internal/session/manager_test.go` (new)
**Risk:** concurrency
- [ ] `session.Spec{Phase int, Kind string, Attempt int, Worktree, Branch, BaseBranch, Cwd string, Split bool, Provider config.Provider, Model, Effort, McpURL, Prompt, SentinelPath, StepDir, RunID, ID6, Pack string}`; `Kind` is `plan|implement|review-find|review-fix|milestone|watchdog`
- [ ] `session.Manager{Herdr herdr.Client, Store *state.Store, Repo string}.Open(ctx, spec) (*Session, error)`: for a step kind, `git branch <Branch> <BaseBranch>` in the primary tree when the branch is absent and `git worktree add <Worktree> <Branch>` when the worktree is absent (checked out, not detached, so commits land on the branch); `milestone` and `watchdog` specs have no branch or worktree and run in `Cwd`
- [ ] `Provider.Prepare` non-empty → run with `sh -c` in the worktree (or `Cwd`) with `{dir}` and `{pack}` substituted before any pane exists; a non-zero exit fails the open naming the command
- [ ] placement: `Split == false` → `WorkspaceCreate(cwd, "r-loop p<N> <kind>", ["R_LOOP_SENTINEL=<SentinelPath>", "R_LOOP_RUN=<RunID>"])` with `--no-focus`; `Split == true` → `PaneCurrent()` then `PaneSplit(pane, "right", 0.4, cwd)`, falling back to `WorkspaceCreate(cwd, "r-loop <kind>", nil)` when there is no current pane
- [ ] the pane is a shell when `PaneProcessInfo` shows a shell pid with no other foreground process (polled each second, 15 s), then `PaneRun("printf ok > <StepDir>/started")` must land the file within 15 s
- [ ] `Session{Name, Workspace, Pane, Worktree, Branch, StartedAt}` with `Name = rl-<ID6>-p<N>-<kind>` (`rl-<ID6>-m<N>` for a milestone, `rl-<ID6>-wd` for the watchdog) is recorded to the store as `session-opened` before `AgentStart(Name, Provider.Kind, Pane, Provider.Args(Model, Effort, McpURL, <worktree or Cwd>, Pack), 120s)`, then `AgentPrompt(Name, Prompt)` exactly once, never retried
- [ ] a failure after the pane exists and before the prompt is delivered closes the workspace this call created, removes the worktree only when this call created it, and returns the herdr code and message
- [ ] `Session.Status() (string, error)`; `Session.Interrupt() error` sends `Provider.InterruptKeys` split on spaces; `Session.Gone() bool` is true only on `herdr.IsNotFound`; `Session.Read(lines int) (string, error)`; `Session.Tell(text string) error` is one more `AgentPrompt`
- [ ] `Session.Commit(msg string) (sha string, committed bool, err error)` runs `git add -A && git commit -q -m <msg>` in the worktree when `git status --porcelain` is non-empty and returns `HEAD`'s sha either way
- [ ] `manager_test.go` on `herdr.Fake` and a temp repo: the branch is cut from `BaseBranch`; the split path and its workspace fallback; rollback on a failed start; `Gone` only on not-found; `Commit` returns `committed=false` on a clean tree; `session-opened` lands before `AgentStart` in the Fake's call record
**Done when:** `cd driver && go test ./internal/session/...` is green.

### Phase 11 — Step runner: the two-signal rule, stalls and backstops
**Implements:** Report a step's outcome so the driver can act · Run every remaining phase of a plan
**Depends on:** Phase 5, Phase 7, Phase 10
**Files:** `driver/internal/step/runner.go` (new) · `driver/internal/step/evidence.go` (new) · `driver/internal/step/runner_test.go` (new)
**Risk:** concurrency
- [ ] `step.Step{Phase int, Kind string, Attempt int, Row config.Row, Provider config.Provider, Worktree, Branch, BaseBranch, PhaseBase string, Timeout time.Duration, Dir, SentinelPath, PlanPath, FindingsPath, VerdictPath, ReportPath string, Prompt prompt.Rendered, McpURL string}`; `step.Deps{Manager *session.Manager, Store *state.Store, Bus *events.Bus, Questions Questions, Halt <-chan string, Now func() time.Time, Poll time.Duration}`; `Questions` is the interface `Open(phase int, kind string) bool`; `Halt` delivers a reason when something outside the runner stops the step
- [ ] `step.Run(ctx, deps, s) Outcome` with `Outcome{State: ok|failed|stalled|halted, Reason, CommitSHA string, Duration time.Duration, DiffLines int}`; `step-started` (fields `attempt`, `provider`, `model`, `effort`, `prompt`) is recorded before `Manager.Open`, and the terminal event `step-ok|step-failed|step-stalled|step-halted` before returning
- [ ] the sentinel is read as: first line `ok` or `failed`, remaining lines the summary; a missing first line or any other word is `failed sentinel-unreadable`
- [ ] every `Poll` (10 s) the runner checks in order: a reason on `Halt` → `Session.Interrupt()`, then `halted <reason>`; sentinel present → commit and evidence; `Questions.Open` → `waiting-input` recorded once, backstop paused; `Session.Gone()` → `failed session-gone`; `AgentStatus` in `idle|blocked` on two consecutive polls with no sentinel and no open question → `stalled quiet`; `Timeout` elapsed (waiting-input time excluded) → `stalled backstop`
- [ ] after any sentinel, halt or stall and before evidence, `Session.Commit("r-loop: phase <N> <kind> (<ok|failed|stalled|halted>)")` in the worktree; `Outcome.CommitSHA` is the worktree `HEAD` afterwards and is written on the terminal event, so every recorded step claims the tree it left behind (`milestone` and `watchdog` kinds commit nothing here)
- [ ] plan evidence: `PlanPath` exists in the worktree and contains a line matching `^status:`; otherwise `failed plan-missing`
- [ ] implement evidence: `git diff --quiet <PhaseBase>..HEAD -- . ':(exclude).task-plans'` in the worktree reports a change; otherwise `failed no-diff` (`PhaseBase` is the sha the phase branch was cut from, never the run's start); `DiffLines` is that diff's added plus removed lines
- [ ] review-find evidence: `FindingsPath` exists (empty allowed) else `failed findings-missing`; review-fix evidence: `VerdictPath` first line `clean` → `ok`, `unresolved` → `failed review-unresolved`, missing → `failed verdict-missing`; milestone evidence: `ReportPath` exists and is non-empty else `failed report-missing`
- [ ] an `ok` sentinel with missing evidence is recorded `failed` naming the evidence, never `ok`; a `failed` sentinel is `failed` with its summary as the reason
- [ ] `failed`, `stalled` and `halted` leave the session and the worktree standing; `stalled` maps to exit `3`, `failed` to `1`, `halted` to `5`
- [ ] `runner_test.go` on `herdr.Fake`, a fake `Questions` and a temp repo: sentinel `ok` with no evidence fails for plan, implement, review-fix and milestone; an open question pauses the backstop; `idle` twice with no sentinel stalls; `Gone` fails; a reason on `Halt` interrupts, commits and halts; a failed implement still commits and records `CommitSHA`; the terminal event is recorded before return
**Done when:** `cd driver && go test ./internal/step/...` is green.

### Phase 12 — The review step's two halves
**Implements:** Run every remaining phase of a plan · Choose the agent for each step
**Depends on:** Phase 7, Phase 11
**Files:** `driver/internal/review/review.go` (new) · `driver/internal/review/review_test.go` (new)
- [ ] `review.Worktree{Path, Branch, BaseBranch, PhaseBase string}` is declared in `review.go`; `review.Run(ctx, deps step.Deps, cfg *config.LoopConfig, ph plan.Phase, wt Worktree, render func(name string, vars map[string]string, p config.Provider) (prompt.Rendered, error), mcpURL func(kind string) string) step.Outcome` runs the find half then the fix half under `steps/<N>-review/find/` and `steps/<N>-review/fix/` and reports as one `review` step to its caller
- [ ] find half by the review provider's `Review` value: `cmd:<c>` → `<c>` with `{base}` (`wt.BaseBranch`) and `{dir}` (`wt.Path`) substituted, run with `sh -c` in the worktree under the review row's timeout, stdout written to `find/findings.md`, a non-zero exit is `failed review-cmd-failed` carrying stderr; `session:<c>` → a `review-find` step on the review row rendering `review-native.md` with `reviewCommand = c`; empty → a `review-find` step on the review row rendering `review.md`
- [ ] the renderer's `Degraded` flag is recorded on the find step as `fanout: none` and surfaces in the run report
- [ ] `findings.md` empty → the fix half is skipped and the driver writes `fix/verdict.md` as `clean` followed by `no findings`, recording `review-fix skipped`
- [ ] the fix half is a `review-fix` step on `cfg.Fix()` (the implement row), rendering `fix.md` with `findingsPath` and `verdictPath` in the worktree; its evidence is the verdict file
- [ ] `review_test.go` on `herdr.Fake`: `cmd:` captures stdout and fails on non-zero; empty findings skip the fix half; the fix half's `step-started` carries the implement row's provider, model and effort; `Degraded` is recorded
**Done when:** `cd driver && go test ./internal/review/...` is green.

### Phase 13 — LandGate and the milestone boundary
**Implements:** Run every remaining phase of a plan
**Depends on:** Phase 6, Phase 7, Phase 10, Phase 11
**Files:** `driver/internal/land/gate.go` (new) · `driver/internal/land/gate_test.go` (new)
**Risk:** persistence
- [ ] `land.Deps{Repo, Todo, Pack string, Store *state.Store, Manager *session.Manager, Cfg *config.LoopConfig, Step step.Deps, Render func(name string, vars map[string]string, p config.Provider) (prompt.Rendered, error)}`; `land.Phase(ctx, d Deps, ph plan.Phase, branch, worktree string, gateTimeout time.Duration) (Landing, error)` runs in the primary tree: `git merge --no-ff --no-commit <branch>`; a conflict runs `git merge --abort` and returns `failed merge-conflict`
- [ ] `ph.DoneWhen` non-empty → run as `sh -c` in the primary tree with `gateTimeout` (the implement row's timeout); a non-zero exit or timeout runs `git merge --abort` and returns `failed gate-failed` with the command's combined output; `DoneWhen` empty → `gate-skipped` recorded and the landing continues
- [ ] on a passed gate: `plan.Land(todo, N)` (ticks the block and puts `<!-- built: phase-<N>-<kebab> -->` on the heading), `git add <todo>`, `git commit -m "r-loop: phase <N> — <title>"`, so one merge commit carries the code, the ticks and the marker `milestone_scope.py` later finds with `git log -S`
- [ ] `Landing{Phase, MergeSHA string, GateSkipped bool}` is recorded as `phase-landed`; then `git worktree remove <worktree>` and the branch is kept
- [ ] `python3 <pack>/skills/plan-report/scripts/milestone_scope.py <todo> --complete` is read before and after; a milestone complete only afterwards runs one `milestone` step through `step.Run` with `Kind: milestone`, `Cwd: repo`, the row `Cfg.Milestone()` (the plan row), `ReportPath` from `--milestone <M>`'s `reportPath`, and `milestone.md` rendered with `reportPath`, `todoPath`, `worktree = repo`
- [ ] the milestone step's `Outcome` other than `ok` → `report-skipped` recorded with its reason, never a halt; `ok` → `git add <report> && git commit -m "r-loop: milestone <M> report"` in the primary tree
- [ ] `gate_test.go` in a temp repo with a fixture plan carrying one milestone: a failing gate aborts and leaves `git status` clean and the todo unticked; a passing gate yields one commit containing the code, the ticks and the marker; no `Done when:` records the skip; the completed milestone opens exactly one session on `herdr.Fake` and a missing report is a recorded skip
**Done when:** `cd driver && go test ./internal/land/...` is green.

## Milestone 3 — The ask channel
Contracts: `tech-design.md#milestone-3--the-ask-channel`

### Phase 14 — AskServer
**Implements:** Ask the person a question · Answer an agent's question without leaving the loop
**Depends on:** Phase 11
**Files:** `driver/internal/ask/server.go` (new) · `driver/internal/ask/server_test.go` (new) · `driver/go.mod` (modify)
**Risk:** concurrency
- [ ] `ask.Serve(ctx, store *state.Store, bus *events.Bus) (*Server, error)` listens on `127.0.0.1:0` and serves MCP over streamable HTTP with `github.com/modelcontextprotocol/go-sdk`, pinned in `go.mod` at its current release when this phase is built
- [ ] `Server.StepSurface(phase int, kind string) (url string)` registers `/mcp/step/<32-hex token>` exposing one tool, `ask_user(question string, options []string) → {answer string}`, which blocks until answered; the token maps the call to `(phase, kind)`
- [ ] on `ask_user`: `Question{ID: q<seq>, Phase, Step, Text, Options, AskedAt, Origin: session}` is appended to `questions.jsonl` before anything else, then `question-asked` is published on the bus
- [ ] `Server.Open(phase int, kind string) bool` reports whether a question from that step is unanswered — the `step.Questions` interface
- [ ] `Server.Answer(id, text, by, citation string) error` resolves the blocked call, updates the record with `{answeredAt, answeredBy: maintainer|watchdog, citation, answer}`, publishes `question-answered`; an unknown or already-answered id is an error
- [ ] `Server.AskMaintainer(ctx, phase int, kind, text string, options []string) (string, error)` creates a `Question` with `Origin: driver` through the same record and bus path and blocks until `Answer` — the route consent prompts and Resolve-first entries use, never offered on any MCP surface
- [ ] `Server.Pending() []Question` lists unanswered questions oldest first, for the faces
- [ ] a request on an unknown token is answered `404` and recorded as `ask-rejected` with the path
- [ ] `ask.PlainInput(ctx, server *Server, r io.Reader)` reads lines `answer <qid> <text>` and calls `Answer(qid, text, "maintainer", "")`, reporting a bad line on stderr; `events.Plain` prints a question as `question q3 [phase 4 implement]: <text> options: a | b`
- [ ] `server_test.go` with the SDK's client: a round trip blocks until `Answer`; two steps get distinct tokens; an unknown token is `404`; `Open` flips on ask and off on answer; `AskMaintainer` round trip; `PlainInput` answers from a pipe; the question record precedes the bus event
**Done when:** `cd driver && go test ./internal/ask/...` is green.

### Phase 15 — The Resolve-first gate at startup
**Implements:** Close a blocking plan decision at startup
**Depends on:** Phase 6, Phase 14
**Files:** `driver/internal/preflight/resolve.go` (new) · `driver/internal/preflight/resolve_test.go` (new) · `driver/internal/preflight/testdata/resolve-todo.md` (new)
- [ ] `preflight.Resolve(ctx, pack, repo, todo string, runList []int, ask Asker, interactive bool) (code int, err error)` where `Asker` is the interface `AskMaintainer(ctx, phase int, kind, text string, options []string) (string, error)`; it runs `python3 <pack>/skills/plan-unblock/scripts/resolve_scope.py <todo> --outstanding --phases <n,n>` and keeps the `blockedInScope` entries, plus every outstanding entry when `blocksEverything` is true
- [ ] each entry is put through `AskMaintainer(ctx, 0, "resolve-first", <text>, nil)` with the text `<name>: <body> — Owner: <owner> · Blocks: <blocks> · Output: <output>` built from the script's fields; the watchdog has no route to these
- [ ] on an answer the todo is rewritten in place: under the `## Resolve first` heading, the entry is the `- [ ] **<name>**` line and its indented continuation lines; the `[ ]` on that line becomes `[x]` and a line `      Resolved: <YYYY-MM-DD> — <answer>` is inserted after the last continuation line; every other byte is preserved; the todo is committed in the primary tree as `r-loop: resolve — <name>` before the loop starts
- [ ] after stamping, `--outstanding --phases` is re-run and must report `gate: clear` for the run list; otherwise exit `4` naming what still blocks
- [ ] `interactive == false` (plain mode with no terminal on stdin) → the entries are printed with `run /r:plan-unblock <todo>` and the code is `4` without asking
- [ ] `resolve_test.go` with `testdata/resolve-todo.md` (two entries, one blocking phase 2, one already resolved) and a fake `Asker`: the stamp shape, the commit, the re-check, the non-interactive exit, the resolved entry not re-asked
**Done when:** `cd driver && go test ./internal/preflight/...` is green and `python3 skills/plan-unblock/scripts/resolve_scope.py driver/internal/preflight/testdata/resolve-todo.md --check` names exactly the one open entry.

## Milestone 4 — The run
Contracts: `tech-design.md#milestone-4--the-run`

### Phase 16 — Notify hooks and the run report
**Implements:** Be told when a run halts · See where a run is
**Depends on:** Phase 5
**Files:** `driver/internal/notify/notify.go` (new) · `driver/internal/notify/notify_test.go` (new) · `driver/internal/report/report.go` (new) · `driver/internal/report/report_test.go` (new)
- [ ] `notify.Run(ctx, store *state.Store, hook string, env Env)` runs `sh -c <hook>` with a 60 s timeout and `R_LOOP_RUN R_LOOP_TODO R_LOOP_OUTCOME R_LOOP_PHASE R_LOOP_STEP R_LOOP_REASON R_LOOP_REPORT` in its environment; an empty hook is a no-op; a non-zero exit or timeout records `notify-failed` with the hook's stderr and returns nothing — the caller's outcome is unchanged
- [ ] `notify.Env{Run, Todo, Outcome, Phase, Step, Reason, Report string}`
- [ ] `report.Write(store *state.Store) (path string, err error)` assembles `<rundir>/report.md` from the store's records: phases landed with merge shas; each step with provider, model, effort, prompt source, attempt, duration and outcome; gate and report skips; `fanout: none` and `ask: none` degradations; every question with who answered it and the citation; every signal with source and whether it was rejected; every remedy verbatim with who allowed it; the exit code
- [ ] `report.Status(store) []string` renders `key: value` lines: run, phase, step, provider, workspace, time live, open questions, warnings — the same facts `r-loop status` and the TUI header show
- [ ] `notify_test.go`: env variables reach the hook; a failing hook records and returns; a hanging hook is cut at the timeout; `report_test.go`: a fixture store renders every section and a rejected signal is marked
**Done when:** `cd driver && go test ./internal/notify/... ./internal/report/...` is green.

### Phase 17 — RunLoop
**Implements:** Run every remaining phase of a plan · Be told when a run halts
**Depends on:** Phase 6, Phase 8, Phase 11, Phase 12, Phase 13, Phase 14, Phase 15, Phase 16
**Files:** `driver/internal/loop/loop.go` (new) · `driver/internal/loop/steps.go` (new) · `driver/internal/loop/loop_test.go` (new) · `driver/cmd/r-loop/main.go` (modify)
- [ ] `loop.Deps{Repo, Pack, Todo string, Cfg *config.LoopConfig, Store *state.Store, Bus *events.Bus, Herdr herdr.Client, Manager *session.Manager, Ask *ask.Server, Render func(name string, vars map[string]string, p config.Provider) (prompt.Rendered, error), Flags{From int, Only []int, NoWatchdog, Plain bool}, Control{Restart <-chan Restart, Quit <-chan struct{}}}` with `Restart{Phase int, Kind, Addendum, Provider string}`
- [ ] `loop.Run(ctx, d Deps) int` records `run-started` and `SetStatus("running", 0)`, walks the run list in order and each phase as `plan → implement → review → land`, recording `phase-started` with `PhaseBase = git rev-parse HEAD` in the primary tree at that moment, and `phase-landed`
- [ ] `steps.go` builds each `step.Step` for phase N: `Branch r-loop/phase-<N>`, `Worktree <repo>/.r-loop/wt/phase-<N>`, `Row` from `Cfg.Steps[kind]` (`review-fix` from `Cfg.Fix()`), `Provider` from `Cfg.Resolve(Row)`, `Timeout = Row.Timeout`, `Dir = Store.StepDir(N, kind)`, `SentinelPath = Dir/sentinel`, `PlanPath = <Worktree>/.task-plans/<plan.Slug(N, title)>.md`, `FindingsPath`/`VerdictPath` under `Dir/find/` and `Dir/fix/`, `McpURL = Ask.StepSurface(N, kind)` when `Provider.Ask == mcp` else empty with `ask: none` recorded, `Prompt = Render("<kind>.md", vars, Provider)` with `vars` = `phaseBlock phaseNumber phaseTitle todoPath planPath branch worktree base sentinelPath acceptance findingsPath verdictPath reviewCommand reportPath runDir addendum` filled from the phase, the run and the step (empty strings where a variable does not apply)
- [ ] a `failed|stalled|halted` step records `run-halted` with the reason and the line `r-loop resume`, `SetStatus("halted", <1|3|5>)`, fires `notify.onHalt`, then waits: a `Restart` naming that step reopens it as `Attempt+1` with `addendum` appended to the prompt's variables and the named provider's row for this attempt, records `step-restarted`, `SetStatus("running", 0)`, and the walk continues from that step; `Quit` returns the exit code; with neither a watchdog nor a TUI the wait is skipped and the code is returned at once
- [ ] every phase landed → `run-finished`, `SetStatus("finished", 0)`, `notify.onDone`, return `0`
- [ ] `main.go` wires `r-loop <todo>`: `config.Load` → `preflight.Run` → `state.Create` → `ask.Serve` → the face (`events.Plain` on stdout plus `ask.PlainInput` on stdin when it is a terminal, under `--plain`) → `preflight.Resolve` → `loop.Run` → `report.Write` → exit code; `--plain` prints the banner first, event lines during, then `report: <path>` and the resume line on a halt; `--dry-run` stops after the banner and run list
- [ ] `loop_test.go` on `herdr.Fake` with scripted sentinels and a temp repo: two phases land as two merge commits, each carrying its ticks and marker, exit `0`, `onDone` fired; a failed implement halts with exit `1`, `onHalt` fired, `run.json.status == halted`, the resume line in the report, and phase two untouched; a `Restart` after a failed implement re-runs it as attempt 2 and the walk continues; a `fanout: none` provider lands with the degradation in the report
**Done when:** `cd driver && go test ./internal/loop/...` is green.

### Phase 18 — resume, abort and status
**Implements:** Resume a run that stopped · Stop a run without losing work · See where a run is
**Depends on:** Phase 17
**Files:** `driver/internal/loop/resume.go` (new) · `driver/internal/loop/resume_test.go` (new) · `driver/cmd/r-loop/main.go` (modify)
- [ ] `r-loop resume` opens the run named by `.r-loop/current`, takes `LastStep()` (the most recent step that did not end `ok`), and re-runs it with `Attempt+1` in a fresh session on the same worktree and branch, then continues the walk from there; every earlier step is skipped, so a phase whose plan step completed is not re-planned
- [ ] before re-running, the worktree is checked: `git status --porcelain` non-empty, or `HEAD` not equal to the `CommitSHA` the last step recorded → stop with exit `1` and reason `resume-unclaimed-tree`, naming the worktree (an ordinary failed step recorded its commit, so it resumes)
- [ ] `run.json.status == finished` → prints `run <id> finished` and exits `0`; the last step's session still live per `herdr agent get` → refuses with exit `2` naming the session; `status == running` → refuses with exit `2` naming the run
- [ ] `r-loop abort` records `run-aborted`, `SetStatus("aborted", 1)`, stops scheduling, leaves the live session and worktree standing, prints both names, and `LastStep()` still answers for the next `resume`
- [ ] `r-loop status` prints `report.Status` lines under `--plain`, and under the TUI (Milestone 5) the same facts in its header
- [ ] `resume_test.go`: a halted implement resumes without a second plan session and with `attempt=2`; a dirty worktree stops; a worktree with an extra commit stops; a finished run is a no-op; `abort` then `resume` picks the same step
**Done when:** `cd driver && go test ./internal/loop/...` is green.

## Milestone 5 — The TUI
Contracts: `tech-design.md#milestone-5--the-tui`

### Phase 19 — The TUI model and view
**Implements:** See where a run is
**Depends on:** Phase 17, Phase 18
**Files:** `driver/internal/ui/model.go` (new) · `driver/internal/ui/view.go` (new) · `driver/internal/ui/styles.go` (new) · `driver/internal/ui/view_test.go` (new) · `driver/go.mod` (modify)
- [ ] `ui.Model` is a `tea.Model` built by `ui.New(sub <-chan events.Event, p *plan.Plan, status func() []string) Model`, fed by the same bus subscription `--plain` uses; `github.com/charmbracelet/bubbletea` and `github.com/charmbracelet/lipgloss` are pinned in `go.mod` at their current releases when this phase is built
- [ ] the model keeps per-phase state (`queued|planning|implementing|reviewing|landed|failed|halted`), the live step (kind, provider, model, effort, workspace, started at), the signal feed and the answered questions, all derived from events and nothing else
- [ ] layout at any width from 80 to 200 columns: a 24-column phase rail on the left (one line per phase: number, title truncated, state glyph), a detail pane to its right (live step with elapsed ticking every second, the phase's `Files:` and `Done when:`), a watchdog feed pane below it (signals, cited answers, remedies, newest last), a full-width banner row above a one-line key bar; no row ever wraps
- [ ] `styles.go` carries the root `DESIGN.md` tokens: surface `#0F1115`, raised `#171A20`, text `#D6DAE0`, dim `#8A929E`, primary `#6E9FC4` for the live step and the selected row, secondary `#E0A458` for an open question or a warning, tertiary `#8FA87F` for a landed phase, error `#E0736A` for a failed step or a halt, outline `#2E343D` for borders; single-line box drawing; bold on the live phase only; gutter 2, pad 1, margin 2
- [ ] `j`/`k` move the rail cursor and `enter` shows the selected phase's steps in the detail pane; `status()` fills the header line
- [ ] `view_test.go` renders the view at 80×24 and 120×40 against a scripted event sequence and asserts no line exceeds the width, the live phase is the one bold row, a landed phase is `#8FA87F`, a warning row is `#E0A458`
**Done when:** `cd driver && go test ./internal/ui/...` is green.

### Phase 20 — The TUI's questions, consent and lifecycle
**Implements:** Answer an agent's question without leaving the loop · Close a blocking plan decision at startup
**Depends on:** Phase 19
**Files:** `driver/internal/ui/input.go` (new) · `driver/internal/ui/input_test.go` (new) · `driver/cmd/r-loop/main.go` (modify)
- [ ] `ui.WithInput(m Model, pending func() []ask.Question, answer func(id, text string) error, quit func()) Model` adds the banner and the keys `a` (focus the answer input), `1`–`9` (pick a listed option), `y`/`n` (answer a yes/no question), `q` (asks `abort the run? y/n` and on `y` calls `quit`)
- [ ] the banner shows the oldest pending question with its options and its origin (the step that asked, `resolve-first`, or `remedy`) in `#E0A458`; submitting calls `answer(id, text)` and the banner moves to the next pending question or clears
- [ ] `main.go` starts the TUI right after `ask.Serve` and before `preflight.Resolve`, so Resolve-first entries and every later question appear in the banner; the program runs with `tea.WithAltScreen()` and `quit` closes `Control.Quit`
- [ ] on `run-halted`, `run-finished` or `run-aborted` the TUI shows the outcome and the report path in the banner and keeps running until a key is pressed, so a `restart_step` during the remedy window is visible; the process exits with the run's exit code
- [ ] `input_test.go`: an open question paints the banner; `1` answers with the first option; `y` answers a yes/no; `q` then `y` calls `quit`; a Resolve-first question shows its origin
**Done when:** `cd driver && go test ./internal/ui/...` is green.

## Milestone 6 — The watchdog
Contracts: `tech-design.md#milestone-6--the-watchdog`

### Phase 21 — Watch: signals, deterministic checks and the rejection rule
**Implements:** Halt a step that has gone the wrong way
**Depends on:** Phase 11, Phase 17
**Files:** `driver/internal/watch/watch.go` (new) · `driver/internal/watch/checks.go` (new) · `driver/internal/watch/watch_test.go` (new) · `driver/internal/loop/loop.go` (modify)
**Risk:** concurrency
- [ ] `watch.Signal{Seq int, Phase int, Step string, Source: driver|watchdog, Kind: warn|halt, Reason, Evidence string, Rejected bool}` appended to `signals.jsonl` before it is acted on
- [ ] `watch.Watch{Store *state.Store, Bus *events.Bus, OnWarn func(), Halt chan<- string}.Emit(sig) Decision`: `warn` publishes `signal-warn` and calls `OnWarn`, the run continues; `halt` publishes `signal-halt` and sends `halt: <reason>` on `Halt` — the step runner's channel — so the live step ends `halted` and the loop exits `5`
- [ ] a signal whose `Kind` is outside `warn|halt`, or whose `Reason` or payload asks to mark a step ok, land a phase, tick a box or lift a halt, is recorded with `Rejected: true` as `signal-rejected` carrying the full payload, and is treated as a halt with reason `rejected-signal` — the run exits `5` and the report shows the rejected signal
- [ ] `checks.Run(ctx, w *Watch, s step.Step, hist []state.StepRecord)` every 30 s during a live step, each check firing at most once per step: a file changed in the worktree outside the phase's `Files:` → `warn files-outside-scope <paths>`; the todo or any `- [x]` changed in the worktree → `halt plan-touched`; elapsed over twice the median duration of the same step kind across at least two earlier phases of this run → `warn slow-step`; implement diff lines over three times the median `DiffLines` of earlier implement steps (at least two) → `warn large-diff`; a test file the base already tracked, not named in `Files:`, modified → `warn tests-modified <paths>`
- [ ] `loop.Run` creates one `Watch` with `OnWarn` firing `notify.onWarn`, hands its `Halt` channel to every step, and runs `checks.Run` beside every step with `Store.History()`; `--no-watchdog` leaves these checks running — only the watchdog session is absent
- [ ] `watch_test.go`: each check on a temp repo fixture; `warn` continues and `halt` delivers on the channel; a forward-moving payload is rejected and recorded; a check fires once per step
**Done when:** `cd driver && go test ./internal/watch/... ./internal/loop/...` is green.

### Phase 22 — The watchdog surface and question routing
**Implements:** Answer from the whole run's context · Halt a step that has gone the wrong way
**Depends on:** Phase 14, Phase 21
**Files:** `driver/internal/ask/watchdog_surface.go` (new) · `driver/internal/ask/watchdog_surface_test.go` (new) · `driver/internal/ask/server.go` (modify)
**Risk:** security
- [ ] `Server.WatchdogSurface(w *watch.Watch, budget time.Duration) (url string)` registers `/mcp/watchdog/<32-hex token>` exposing `ask_user`, `signal(kind, step, reason, evidence string)` and `answer_question(id, answer, citation string)`; none of these exist on a step surface, and a step surface answers `signal` or `answer_question` with a tool-not-found error
- [ ] `signal` builds `watch.Signal{Source: watchdog, Phase/Step parsed from step as "<N> <kind>"}` and passes it to `w.Emit`; a `halt` with empty `evidence` is rejected as `halt-without-evidence`, recorded, and nothing is emitted
- [ ] question routing: when a watchdog surface exists, `question-asked` on a session question starts a `budget` timer; `answer_question` with a `citation` matching `^[^:\s]+:\d+` calls `Answer(id, answer, "watchdog", citation)`; an empty or malformed citation is recorded `answer-rejected` and the question escalates at once; the budget expiring escalates it unanswered
- [ ] `Question.Escalated bool` and the event `question-escalated` mark a question as the maintainer's; `Pending()` returns driver-originated and escalated questions while a watchdog surface exists, and every unanswered question otherwise; the maintainer's `Answer` is accepted at any moment, escalated or not
- [ ] `watchdog_surface_test.go` with the SDK client: a cited answer resolves the question with `answeredBy: watchdog`; a malformed citation escalates; the budget escalates; a step surface refuses `signal`; a halt without evidence is rejected; a warn reaches `Emit`
**Done when:** `cd driver && go test ./internal/ask/...` is green.

### Phase 23 — The watchdog session
**Implements:** Halt a step that has gone the wrong way · Answer from the whole run's context
**Depends on:** Phase 17, Phase 22
**Files:** `driver/internal/watchdog/watchdog.go` (new) · `driver/internal/watchdog/watchdog_test.go` (new) · `driver/internal/loop/loop.go` (modify)
- [ ] `watchdog.Start(ctx, run Run{ID, ID6, Repo, Pack, Todo, RunDir, BaseBranch string}, row config.WatchdogRow, p config.Provider, m *session.Manager, url string, render func(name string, vars map[string]string, p config.Provider) (prompt.Rendered, error)) (*Watchdog, error)` opens the session through `m.Open(session.Spec{Kind: "watchdog", Split: true, Cwd: run.Repo, Provider: p, Model: row.Model, Effort: row.Effort, McpURL: url, ID6: run.ID6, RunID: run.ID, Pack: run.Pack, Prompt: <watchdog.md rendered with todoPath, runDir, base>})` — the manager supplies the split-or-workspace placement, `prepare`, the handshake and the `rl-<ID6>-wd` name
- [ ] `Watchdog.Tell(line string)` forwards one line per event through `Session.Tell`: `run-started <id> todo=<path> run=<dir>`, `step-started <N> <kind> agent=<name> worktree=<dir>`, `question <id> [phase N kind]: <text> options: a | b`, `step-failed <N> <kind> <reason>`, `step-stalled <N> <kind>`, `run-halted <reason>`; a failed prompt is recorded `watchdog-unreachable` and never retried
- [ ] `loop.Run` starts the watchdog after `preflight.Resolve` unless `Flags.NoWatchdog`, subscribes it to the bus for the six events above, calls `Store.SetWatchdog(on)`, and the run report reads `watchdog: off` when absent
- [ ] `Watchdog.Gone()` (`Session.Gone()`) checked every 30 s → `warn watchdog-gone` through `Watch.Emit`, the run continues without it, questions escalate at once, and the remedy window after a halt is skipped
- [ ] `watchdog_test.go` on `herdr.Fake`: the spec passed to the manager carries `Split`, the watchdog URL and the `watchdog` kind; each of the six events produces one prompt with the stated shape; `--no-watchdog` starts nothing; a gone watchdog emits the warn
**Done when:** `cd driver && go test ./internal/watchdog/... ./internal/loop/...` is green.

### Phase 24 — Remedies and the remedy window
**Implements:** Fix what is blocking a step · Pre-authorise the blockers worth fixing automatically
**Depends on:** Phase 23
**Files:** `driver/internal/remedy/remedy.go` (new) · `driver/internal/remedy/remedy_test.go` (new) · `driver/internal/ask/watchdog_surface.go` (modify) · `driver/internal/loop/loop.go` (modify)
**Risk:** security
- [ ] `remedy.Remedies{Store *state.Store, Allow []string, Ask Asker, Last func() *state.StepRef, Restart chan<- loop.Restart}` where `Asker` is `AskMaintainer(ctx, phase int, kind, text string, options []string) (string, error)`
- [ ] `Propose(ctx, class, command, why string, phase int, kind string) (decision string, err error)`: a `class` outside `deps|ports|containers|locks|restart|retry|provider` is recorded `remedy-rejected` and returns `refused`; otherwise `Remedy{Seq, Class, Command, Why, Phase, Step, AuthorisedBy: "", Result}` is appended to `remedies.jsonl` with the command verbatim before any decision is taken
- [ ] a class in `Allow` returns `authorised` with `AuthorisedBy: allow`; any other class calls `Ask.AskMaintainer(ctx, phase, kind, "remedy [<class>]: <command> — <why>", ["yes","no"])` and returns `authorised` (`AuthorisedBy: maintainer`) or `refused`; `Store.UpdateRemedy` writes the decision into the record
- [ ] the driver never runs the command — the watchdog runs it after `authorised`, and the record is the command as proposed
- [ ] `RestartStep(ctx, step string, addendum, provider string) error` is accepted only when `Last()` names that step (`"<N> <kind>"`) and its `State` is `failed|stalled|halted`; bare → class `restart`, with `addendum` → `retry`, with `provider` → `provider`, each consent-checked exactly like a remedy through `Propose`; accepted → send `loop.Restart{Phase, Kind, Addendum, Provider}` on `Restart`, which the loop's halt wait turns into `Attempt+1` of that step
- [ ] the loop's wait after a halt is the **remedy window**: with a watchdog present it lasts `Cfg.Watchdog.RemedyWindow` (default 15m) or until `Quit`, then returns the exit code; a `Restart` inside it continues the walk; the window's start and end are recorded as `remedy-window-open` / `remedy-window-closed`
- [ ] `WatchdogSurface` gains `propose_remedy(class, command, why) → {decision}` and `restart_step(step, addendum, provider)` mapped onto `Propose` and `RestartStep`; the step surface never exposes them
- [ ] `remedy_test.go`: allow-listed class authorised without a prompt; other class waits for consent and a refusal is recorded; unknown class rejected; `restart_step` on a running step rejected; a `provider` restart sends the named row; the record exists before the decision; `loop_test.go` gains: a failed step with a watchdog waits the window and a `Restart` inside it continues, the window expiring returns `1`
**Done when:** `cd driver && go test ./internal/remedy/... ./internal/ask/... ./internal/loop/...` is green.
