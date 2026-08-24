---
description: >-
  Scaffold a project-local /test-app skill into the CURRENT project by detecting which surface it
  presents — a web app, a full-screen terminal UI, or a command-line tool — and then its stack
  (build tool, how it runs and how it is driven, base URL or launch command, in-repo helpers, auth
  model, credentials, security signals), writing a tailored `.claude/skills/test-app/SKILL.md` plus
  `references/subagent-prompt.md`. Use whenever the user wants to "create the test-app skill",
  "scaffold test-app", "set up /test-app for this project", "generate a test skill for this repo",
  "make a test skill for this TUI/CLI", or runs `/r:test-app-create` — even if they don't name the
  files. This GENERATES the test skill; it does NOT itself test the app (running the tests is the
  job of the generated `/test-app`). So if the user wants to "test the app" / "verify the changes"
  right now, that is the `test-app` skill, not this one.
---

# Create Test App

Generates a `/test-app` skill tailored to the current project. The generated skill verifies that recent changes to the running app actually work, and *how* it does that depends on what the app is: a web app is driven through HTTP and a browser, a terminal app through a real terminal and its own binary. Either way it reports concrete pass/fail.

The two-file shape is the same for every project, and so is your job: detect the details and fill them into the templates. What changes is **which** pair of templates, and that is one decision made once, at the start.

## What gets written

```
<project-root>/.claude/skills/test-app/
├── SKILL.md                       # from the SKILL template for this surface
├── references/
│   └── subagent-prompt.md         # from the subagent-prompt template for this surface
├── test_creds.txt                 # from assets/test_creds.txt.template — only if missing
└── e2e/                           # created on first run, holds the generated e2e scripts
```

The pair comes from `{{SURFACE}}`, which Step 2 resolves before anything else:

| `{{SURFACE}}` | templates | what it means |
| --- | --- | --- |
| `web` | `assets/test-app.SKILL.md.template` + `assets/subagent-prompt.md.template` | reached over HTTP at a base URL |
| `tui` | `assets/test-app.SKILL.md.process.template` + `assets/subagent-prompt.md.process.template` | takes over the terminal — alternate screen, raw mode, or a full-screen event loop |
| `cli` | the same **process** pair | reads argv, writes stdout/stderr, exits |

TUI and CLI share one pair because they share a spine — build the binary, run it, assert on what
came out, isolate its state — and differ only in how you drive it, which the `{{#IF_TUI}}` and
`{{#IF_CLI}}` guards cover. They do **not** share the web pair: its base URL, login, HTTP security
and browser material is most of its body and none of it applies to a program with no server.

Everything the generated skill owns lives **under its own directory** (`.claude/skills/test-app/`) — the credentials file and the generated `e2e/*.py` scripts. This is deliberate: it keeps generated artifacts from colliding with the project's real `scripts/` (e.g. an existing `scripts/api.py`) or a repo-root creds file, and makes the skill self-contained and portable. The generated skill always references these by the project-root-relative path `.claude/skills/test-app/…`.

## Workflow

### 1. Resolve the project root

```
git rev-parse --show-toplevel
```

If that fails (not a git repo), use the current working directory as the root and note that the generated skill's no-argument git-diff scoping will be limited — it will lean on conversation history instead. Everything below is relative to this root.

### 2. Detect the surface, then the shape

Read `references/detection-guide.md`. **Step 0 there resolves `{{SURFACE}}`, and it runs before
everything else** — it picks the template pair, so every other value is filled from the matching
column below. It is also the one detection whose failure is invisible: a wrong base URL produces a
skill that obviously does not work, while a wrong surface produces a plausible skill that asks the
wrong questions of the right program.

For `tui` or `cli`, read `references/process-surfaces.md` for the rest. It is a separate file
because Step 0 runs for every project and the common case should not pay to read it.

The placeholder map is three tables. One table with a surface column would read as "fill all of
these", and the point is that a terminal project has no base URL to guess at.

#### Shared

| Placeholder | What it is |
| --- | --- |
| `{{APP_NAME}}` | Human name — dir name, pom `<name>`, `package.json` `name`, `Cargo.toml` `name` |
| `{{SURFACE}}` | `web` \| `tui` \| `cli` — picks the pair. The one value that must be right |
| `{{RUN_MODEL}}` | "docker compose stack" / "local dev server" / "tunnel over compose" / "cargo-built binary" / "installed console script" |
| `{{HEALTH_CHECK_CMD}}` | How to confirm it works at all (`docker compose ps`, a health curl; for a process surface `{{BIN_PATH}} --version` exiting 0) |
| `{{REBUILD_NOTE}}` | How uncommitted code reaches the running app, or "no rebuild needed". One complete sentence |
| `{{LOGS_CMD}}` | `docker compose logs app` / a logfile / stdout. **On a TUI, stdout *is* the UI**, so this is a logfile or a debug channel, never stdout |
| `{{CREDS_PATH}}` | Always `.claude/skills/test-app/test_creds.txt` (skill-owned, conflict-free) |
| `{{E2E_DIR}}` | Always `.claude/skills/test-app/e2e` |
| `{{AUTH_MODEL}}` | Web: "Spring Security form login + CSRF", "JWT bearer", "none". Process: how a credential reaches the app — config file, keyring, env var, flag, or "none" |
| `{{EXTRA_SERVICES}}` / `{{IF_EXTRA_SERVICES}}` | Mailhog `:8025`, MinIO, a local daemon a CLI talks to |
| `{{IF_I18N}}` | i18n present with ≥2 locales |

#### Web pair only

| Placeholder | What it is |
| --- | --- |

| Placeholder | What it is |
| --- | --- |
| `{{BASE_URL}}` | Where the running app is tested (e.g. `http://localhost:8088`, a tunnel URL) |
| `{{HTTP_TOOL_NAME}}` | `scripts/api.py` if an in-repo REST helper exists, else `curl` |
| `{{HTTP_TOOL_BLOCK}}` | The matching **probes-only** usage block (no login — login lives in `{{LOGIN_EXAMPLE}}`) |
| `{{CURL_FORBIDDEN_NOTE}}` | Full sentence when a preferred helper exists, else empty |
| `{{E2E_HELPER_BLOCK}}` | A `### \`<name>\`` usage section for a second in-repo helper (chat/seed/e2e driver); wrapped in `{{#IF_E2E_HELPER}}` — drop when none |
| `{{WTD_PATH}}` | Always `${CLAUDE_PLUGIN_ROOT}/skills/task-review/scripts/worktree-deploy.sh` — the generated skill is project-local, so the real path is substituted here rather than left as a variable |
| `{{LOGIN_EXAMPLE}}` | Form-login+CSRF snippet or JWT-bearer snippet |
| `{{ROUTES_BLOCK}}` | Public vs role-gated routes, when discoverable |
| `{{IF_COMPOSE}}` | Whether the app runs as a docker compose stack — drives the `{{#IF_COMPOSE}}` worktree-isolation block (drop it for non-compose run models) |
| `{{COMPOSE_FILE}}` | The compose file the test target uses (e.g. `docker-compose.yml`, or the chosen one when several exist) |
| `{{APP_SERVICE}}` | The compose service that serves the app (the one the base URL points at) |
| `{{APP_CONTAINER_PORT}}` | The **container-side** port the app listens on (e.g. `8080`, not the host port) |
| `{{REDEPLOY_CMD}}` | The actionable rebuild+restart command from `{{REBUILD_NOTE}}` (e.g. `docker compose up -d --build app`), or `true` if nothing needs rebuilding |
| `{{UI_IN_SCOPE}}` | `true`/`false` — drives the `{{#IF_UI}}…{{/IF_UI}}` guards. **Web-pair only**: it means "there is a browser UI worth driving", not "this app has a user interface". A TUI has a user interface and never sets it |
| `{{IF_IDOR}}`, `{{IF_RATELIMIT}}`, `{{IF_E2E_HELPER}}` | Whether multi-tenant/per-user ownership, an active login rate-limiter, and a second in-repo e2e helper were detected |

#### Process pair only (`tui` and `cli`)

Filled from `references/process-surfaces.md`.

| Placeholder | What it is |
| --- | --- |
| `{{LAUNCH_CMD}}` | The exact argv that starts the app from the project root with **no arguments** |
| `{{BIN_PATH}}` | The **built** executable. Every exit-code, stdout/stderr and piping check invokes this, never `{{LAUNCH_CMD}}` — a source runner writes its own lines to stderr and returns its own exit code, which silently destroys those assertions |
| `{{BUILD_CMD}}` | How uncommitted code reaches `{{BIN_PATH}}`, or `true` when the source runs directly |
| `{{STATE_DIR}}` | Where the app keeps config/state/cache. Isolation here is a state dir, not a container |
| `{{STATE_ISOLATION_BLOCK}}` | The export block pointing the app at a throwaway dir |
| `{{TUI_DRIVER_PATH}}` | Always `${CLAUDE_PLUGIN_ROOT}/skills/test-app-create/scripts/tui-session.sh` — substituted literally, exactly as `{{WTD_PATH}}` is |
| `{{REPORT_EVIDENCE_NOTE}}` | One sentence naming what evidence looks like here — a frame file, or an argv/exit/stdout/stderr triple |
| `{{IF_TUI}}` / `{{IF_CLI}}` | Derived from `{{SURFACE}}`; **exactly one is true** |
| `{{TUI_FRAMEWORK}}` | `ratatui + crossterm`, `bubbletea`, `textual`, `ink`, `ncurses`, … |
| `{{TERM_GEOMETRY}}` | The size the app is designed for, `COLSxROWS`; default `120x40` |
| `{{GEOMETRY_SWEEP}}` | The three sweep sizes — wide, `{{TERM_GEOMETRY}}`, and **`80x24`**, which is the one that finds things |
| `{{KEYMAP_BLOCK}}` | The app's real bindings. The TUI analogue of `{{ROUTES_BLOCK}}` — without it a subagent guesses `q`, gets nothing, and reports "unresponsive" |
| `{{CLI_INVOCATION_BLOCK}}` | The subcommand/flag surface, read from the **parser definition** — never from `--help`, which is itself under test |
| `{{EXIT_CODE_TABLE}}` / `{{IF_EXIT_CODES}}` | The app's documented exit codes, when it has any |
| `{{IF_NATIVE_HARNESS}}` / `{{NATIVE_HARNESS_BLOCK}}` | A framework-native harness and its invocation, when one exists |
| `{{IF_MOUSE}}`, `{{IF_COLOR}}`, `{{IF_STDIN}}`, `{{IF_SIGNALS}}` | Mouse capture, styled output, stdin reading, signal handlers |
| `{{IF_REMOTE_AUTH}}`, `{{IF_SHELLS_OUT}}`, `{{IF_PATH_ARGS}}` | Drive the security pass — remote auth, shelling out with user input, filesystem paths as arguments |

**On the web pair, the base URL is the one value you must not guess.** A compose file can publish `8080:8080` and still be tested through a tunnel, so a published port is a candidate, not an answer. When the URL or run model is ambiguous, ask (step 4).

**On the process pair, the surface itself is that value**, and it is decided by running the program rather than reading it — `references/detection-guide.md` Step 0 B2. A dependency is not a surface: `ratatui` sits in `[dev-dependencies]`, `rich` prints coloured tables from a plain CLI. When the static evidence is not unanimous and the runtime probe cannot answer, ask.

**If the repo has more than one compose file** (`docker-compose.yml` + a `.dev.yml`/`.prod.yml`/`.override.yml`), they are different deployments with different URLs and `compose -f` commands — the skill can't know which one is the test target. List the candidates and **ask the user which deployment `/test-app` should run against**, then bake their choice into the URL/run-model and the compose commands.

### 3. Summarize what you found

Show the user a compact table. **Surface is the first row**, with how it was decided — read
statically, settled by the runtime probe, or asked — because it is the choice everything else
hangs off and the only one whose error is invisible in the result.

Then, for `web`: stack, run model + base URL, HTTP tool (helper vs curl), UI in scope?, auth
model, creds-file status, extra services, and which conditional catalog items will activate (IDOR
/ rate-limiting / localization).

For `tui` / `cli`: stack, framework, launch command, built binary path, build command, state
directory, keymap or command surface found, whether a native harness exists, whether tmux is
available, and which conditional items will activate (mouse / colour / stdin / signals / the three
security flags).

**Explicitly mark anything you guessed** — the base URL and the surface above all.

### 4. Confirm and fill gaps

If the URL, run model, surface, or creds format is ambiguous, ask one batched round of questions
and use the answers. Two asks are **mandatory**, and they are the same rule twice: several
plausible targets, no way to rank them from the code, and a wrong pick that stays invisible until
someone reads the generated skill.

- **Several compose files exist** — which deployment is the test target.
- **Both a web signal and a terminal entrypoint exist** — which surface `/test-app` should target.
  The common shape is a server binary plus an admin CLI in one repo; the answer is usually the
  server, and the user is the only one who knows.

Don't invent a public URL — if the user doesn't know it, write the skill with a `BASE_URL: TODO`
marker and a prominent "set this before the first run" note.

### 5. Handle a pre-existing test-app skill (incl. upgrading to worktree isolation)

Both reference projects already have a hand-tuned `test-app`. If `.claude/skills/test-app/` already exists, **do not overwrite silently**: show what would change (a short diff of intent), and overwrite only on the user's explicit confirmation. If they decline, stop.

**The other upgrade case, and it is now the common one:** a skill with no `<!-- test-app-surface: … -->` marker predates it. `/r:task-review` then has to infer the surface from whether a base URL appears in the file, which is right for every skill that exists today and stops being right the moment terminal ones do. Re-running fixes it in one line — and while you are there, re-detect: a project that grew a CLI since the skill was written has a second surface nobody asked about.

**The worktree upgrade case:** a skill generated before worktree isolation existed has no *Where the app runs* section, so its **manual** `/test-app` runs still hit the fixed default port and collide across worktrees. (The automated verifier path is already safe — `/r:task-review` Step 8a deploys through the shared helper regardless of the skill's age.) When you detect a compose-based skill missing that block, offer the upgrade: re-detect the compose knobs (step 2) and rewrite the skill with the `{{#IF_COMPOSE}}` section added, leaving the rest of the user's tailoring intact. This is the one-command way an existing project's manual runs become parallel-safe.

### 6. Write the files

`mkdir -p .claude/skills/test-app/references`, then copy the pair `{{SURFACE}}` selected,
substituting placeholders and resolving the section guards: a `{{#IF_UI}} … {{/IF_UI}}` block (and
every other `{{#IF_*}}` block) is kept verbatim when its flag is true and deleted entirely when
false. Strip every `{{#IF_*}}` / `{{/IF_*}}` marker from the output — the generated files must
contain no template syntax.

**Both pairs carry the surface marker**, an HTML comment under the H1:

```
<!-- test-app-surface: web -->
```

`/r:task-review` Step 8 greps that line to decide what to start and what handle to give its
verifier. It is a comment rather than a frontmatter key deliberately: an unknown frontmatter key on
a project-local skill risks the loader rejecting the block, and a skill that silently stops routing
is a worse failure than the one this marker fixes. Write it on every skill you generate, including
the web ones — absent, the marker is ambiguous between "an older skill" and "a web skill", and the
pipeline has to fall back to inferring from whether a base URL appears anywhere in the file.

### 7. Write the creds stub if needed

If `.claude/skills/test-app/test_creds.txt` is absent, write it from `assets/test_creds.txt.template`, add `.claude/skills/test-app/test_creds.txt` to `.gitignore` (it holds secrets — ask first), and tell the user to fill in real accounts. Never copy real secrets into the skill files — they only ever reference the creds path. If the project already keeps credentials elsewhere (e.g. a repo-root `test_creds.txt` or `.env`), note it in the summary but still standardize the generated skill on its own skill-dir creds file to stay conflict-free; you can seed the new file from the existing one with the user's OK.

### 8. Report

List the files you created, name the surface you resolved and how, summarize the tailoring in a sentence or two, and show how to use the result:
- `/test-app` — no argument: tests the added/changed behavior from the git diff.
- `/test-app <description or @module>` — tests exactly that (e.g. `/test-app auth process`, `/test-app @web-adapter`, `/test-app the new filter pane`).

Suggest a first run. On a `tui` project where tmux was missing, say that in the same breath: the skill is written and correct, and the terminal checks stay unrun until tmux is installed.

## Record the run

One line into the pack-wide store — counts and detection outcomes only, never a credential, a base
URL, a hostname, or anything read out of the project's config.

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:test-app-create","buildTool":"cargo","surface":"tui",
 "surfaceDetectedBy":"probe","surfaceCandidates":1,
 "tuiFramework":"ratatui","nativeHarness":null,"tmuxAvailable":true,
 "authModel":"token","detectedFromCode":0,"askedTheUser":0,"httpHelpersFound":0,
 "credentialsFound":false,"filesWritten":0,"overwroteExisting":false,"blockedReason":null}
STATS_JSON
```

**`detectedFromCode` against `askedTheUser` is what this skill is tuned on.** Detection is the whole
point — a scaffolder that asks the user for the base URL, the build command and the login route has
only rephrased the questions. Read it per `buildTool` and `surface`: a stack that always falls back
to asking is a detection gap with a name, not a general one.

**`surface` is `web` | `tui` | `cli`, and `surfaceDetectedBy` is `static` | `probe` | `asked`.**
The second is `detectedFromCode` against `askedTheUser` asked at the single point where a wrong
answer costs the most: the surface picks the template pair for the whole generated skill, so an
error there is not one bad placeholder but a skill that asks the wrong questions of the right
program. A framework that always ends up `asked` is a discriminator gap with a name.
`surfaceCandidates` of 2 or more means the hybrid ask fired, which is how you see whether that ask
is over- or under-triggering. `tmuxAvailable` makes "the terminal checks did not run" countable
rather than inferred, so a run of them on one machine is visible instead of looking like a quiet
pass.

**`credentialsFound: false` is a normal outcome, never a blockage.** The generated skill works
without test credentials; it just cannot log in. Recording it as a block would put a scaffold that
succeeded into the same bucket as one that never ran.

The script always exits `0` — a lost row is a lost row, never a failed run, and it must never change
what was written. Never retry it.

## Edge cases

- **No docker** — drop the rebuild/compose-logs material; `{{LOGS_CMD}}` becomes the app's logfile or stdout, `{{HEALTH_CHECK_CMD}}` a health curl or process check.
- **Pure JSON API** (no templates, no front-end deps) — still `{{SURFACE}}=web`, with `{{UI_IN_SCOPE}}=false`; the UI/UX checks degrade to API response-shape validation; keep agent-browser only if an admin/docs UI (e.g. Swagger) exists.
- **A library with no executable entrypoint** — no surface at all. **Stop and say so** rather than emitting a web skeleton full of `TODO`s. A library is verified by its own test runner, and a `/test-app` that wraps `mvn test` or `cargo test` is a rename, not a skill. Tell the user what you looked for and what would change the answer (a `[[bin]]`, a `cmd/*/main.go`, a console script).
- **tmux is absent on a `tui` project** — write the skill anyway, and say plainly what it will and will not do: the terminal checks are recorded as not run and named, the rest still run. Do not fall back to the web pair and do not fall back to `cli`; the surface is a fact about the app, not about this machine.
- **Worktrees need the skill on their branch.** The generated skill is loaded at session start from the checkout's own `.claude/skills/`. Track it in git so worktrees carry it — but tracking alone isn't enough: a worktree branched off a commit from *before* the skill landed won't have it, so `/test-app` silently won't load there. Tell the user to commit the skill and to base/rebase worktrees on a commit that includes it. (`r:task-review`'s Step 8 detects this stale-worktree case and says so rather than reporting "no skill configured.")
