# Detection guide

Read-only probes for filling the placeholder map. Run from the project root. Record what you find; where a signal is missing or ambiguous, fall back as noted — and ask the user for the base URL rather than guessing.

## Step 0 — which surface

Run this **first**, before anything below. Its answer picks the template pair and decides whether
the base-URL section is read at all. Fill `{{SURFACE}}` with exactly one of `web`, `tui` or `cli`.

### Stage A — collect candidates, never answers

Web signals: a compose file, a server framework in the manifest, a `templates/` or `static/`
directory, a published port, a `deploy` skill.

Terminal signals: an executable entrypoint, plus a framework from the tables in
`process-surfaces.md`.

```
ls docker-compose*.yml compose*.yml 2>/dev/null
grep -nE '"?[0-9]+:[0-9]+"?' docker-compose*.yml 2>/dev/null | head
grep -nA2 '^\[\[bin\]\]' Cargo.toml 2>/dev/null; ls cmd/*/main.go src/main.rs 2>/dev/null
grep -n '"bin"' package.json 2>/dev/null
grep -nA3 '\[project.scripts\]\|console_scripts' pyproject.toml setup.py 2>/dev/null
```

Record everything; a hit here is a candidate.

### Stage B — the discriminator, and it is the load-bearing probe

**A dependency is not a surface.** `ratatui` can sit in `[dev-dependencies]`; `rich` prints
coloured tables from a plain CLI; `bubbles` gets vendored for one spinner; `prompt_toolkit` in its
default `PromptSession` mode is a readline replacement, not a TUI. What decides is whether the
program **takes over the terminal**. Getting this wrong picks the wrong template pair for the
whole generated skill, and every check in it asks the wrong questions of the right program.

**B1 — static evidence, at the call site rather than the import.** The rawest signal first,
because it is language- and framework-independent:

```
grep -rn '?1049h\|?1049l\|smcup\|\[?25l' --include='*' . 2>/dev/null
```

Then the calls that make a framework full-screen — not the import, the call:

| framework | the line that makes it a TUI |
| --- | --- |
| ratatui / crossterm | `EnterAlternateScreen`, `enable_raw_mode()`, `ratatui::init()`, `Terminal::new(CrosstermBackend` |
| termion | `into_raw_mode()`, `AlternateScreen::from(` |
| cursive | `Cursive::default()` then `.run()` |
| bubbletea | `tea.NewProgram(` **with** `tea.WithAltScreen()`; `p.Run()` |
| tview | `tview.NewApplication()` then `.Run()` |
| gocui | `gocui.NewGui(` then `g.MainLoop()` |
| tcell | `tcell.NewScreen()` then `screen.Init()` |
| textual | `class X(App)` then `.run()` / `.run_async()` |
| urwid | `urwid.MainLoop(` |
| curses | `curses.wrapper(`, `initscr()`, `cbreak()`, `noecho()` |
| prompt_toolkit | `Application(` **with** `full_screen=True` — `prompt()` and `PromptSession` are **not** |
| ink | `render(<App` from `ink` |
| blessed (node) | `blessed.screen({` with `smartCSR` |
| ncurses (C) | `initscr()`, `newterm(`, a `tcsetattr` clearing `ICANON` |
| lanterna | `createScreen()` then `screen.startScreen()` |
| jline | `terminal.enterRawMode()` |

CLI evidence is the absence of all of that plus an arg parser at the entrypoint —
`Parser::parse()`, `rootCmd.Execute()`, `parse_args()`, `program.parse(`,
`new CommandLine(...).execute(` — with explicit exits and a `--help` string.

**B2 — the runtime probe, which settles it.** Static evidence gets this wrong in both
directions. Start the program and ask the terminal what it did:

```
${CLAUDE_SKILL_DIR}/scripts/tui-session.sh probe --timeout 8 -- <the launch command, no arguments>
```

It prints one word — `tui`, `cli` or `unknown` — and always tears down its own session.

**Probe the real entrypoint, never `--help`.** No TUI enters the alternate screen to print its
help, so probing `--help` reports `cli` for every program.

The ladder inside `probe`, first hit wins:

1. tmux reports the pane is on the alternate screen → **`tui`**. Definitive, and the one signal
   that owes nothing to the language or the framework.
2. The program exited inside the deadline, with a status recorded → **`cli`**. Definitive the
   other way: it terminated without any input.
3. Still alive, no alternate screen — one harmless key is sent and the frame re-read. **Changed,
   with no line appended** → **`tui`**: an inline TUI (bubbletea without `WithAltScreen`, ink's
   default render) repaints in place.
4. Still alive, frame unchanged, a prompt on the last line → **`cli`**, a REPL. Say so in the
   summary; a REPL is a CLI wearing a loop, and the CLI catalog fits it.
5. Anything else → **`unknown`**, exit 9. It never guesses, and neither should you.

If the driver exits `127`, tmux is absent and the ladder degrades to B1 alone. **When B1 is not
unanimous, ask the user.** Never fall back to `web`: a repo with a `Cargo.toml`, no compose file
and no HTTP framework is not a web app with a missing base URL, and the web pair for it is a skill
whose every placeholder is a guess.

### Stage C — both surfaces present → ASK (don't auto-pick)

When Stage A finds a web signal **and** a terminal entrypoint that Stage B classifies as `tui` or
`cli`, they are two products with two verifications, and nothing in the tree says which one the
user wants tested. List what you found — surface → entrypoint → framework → how it launches → what
it looks like it is for — and **ask which one `/test-app` should target**. Take the whole
placeholder map from the matching column.

The common shape is a server binary plus an admin CLI in one repo; the answer is usually the
server, and only the user knows. Same rule as the multiple-compose-files ask below: several
plausible targets, no way to rank them from the code, and a wrong pick that is invisible until
someone reads the generated skill.

Record the outcome: `surfaceDetectedBy` is `static` when B1 was unanimous, `probe` when B2
decided, `asked` when Stage C or a non-unanimous B1 sent you to the user; `surfaceCandidates` is
how many surfaces Stage A found.

**Everything below this line is the `web` pair.** For `tui` or `cli`, read
`process-surfaces.md` instead and skip to "Credentials", which both pairs share.

## `{{APP_NAME}}`

Dir name of the root, or a real name from `pom.xml` `<name>`, `package.json` `"name"`, `pyproject.toml` `[project] name`. Used only in prose.

## Build tool / stack

First match wins, but record everything (multi-module repos have several):

- `pom.xml` → Maven. `grep -l spring-boot pom.xml */pom.xml` → Spring Boot.
- `build.gradle` / `build.gradle.kts` → Gradle (+ same Spring check).
- `package.json` → Node. Inspect `dependencies`/`scripts` for `next`, `vite`, `express`, `nest`.
- `manage.py` / `wsgi.py` → Django. `requirements.txt` / `pyproject.toml` → other Python (Flask/FastAPI).
- `go.mod` → Go. `Cargo.toml` → Rust. `Gemfile` → Rails.

## How the app runs + `{{BASE_URL}}` / `{{RUN_MODEL}}` (the careful one)

The base URL is **not** mechanically derivable from compose ports — a project can publish `8080:8080` and still be tested through a Cloudflare tunnel. Published ports are candidates; confirm with the user when anything is unclear.

1. **Compose?** `ls docker-compose*.yml compose*.yml 2>/dev/null`. Parse published ports of the app service:
   `grep -nE '"?[0-9]+:[0-9]+"?' docker-compose.yml`. Host (left) port → candidate `http://localhost:<host>`. `{{RUN_MODEL}}=docker compose stack`, `{{HEALTH_CHECK_CMD}}=docker compose ps`, `{{LOGS_CMD}}=docker compose logs app`.
   - **Several compose files → ASK (don't auto-pick).** If that `ls` returns more than one file (e.g. `docker-compose.yml` + `docker-compose.dev.yml` + `docker-compose.prod.yml`, or a `*.override.yml`), they describe different deployments — local dev, a tunnel/staging deploy, prod — with different URLs, ports, and `compose -f` invocations, and the skill cannot know which one the user tests against. List the candidates (file → app URL/port → what it looks like it's for) and **ask the user which deployment `/test-app` should target**. Bake the answer into `{{BASE_URL}}`, `{{RUN_MODEL}}`, and the `{{HEALTH_CHECK_CMD}}`/`{{LOGS_CMD}}`/`{{REBUILD_NOTE}}` commands (include the right `-f <file>` if it's not the default `docker-compose.yml`).
2. **Tunnel / public URL?** `grep -rIl "cloudflared\|trycloudflare\|tunnel\|\.space\|ngrok" docker-compose*.yml *.yml .env* 2>/dev/null`; check `APP_BASE_URL`/`BASE_URL` in `.env*`. A stable public URL (e.g. `app.example.com`) wins over the localhost candidate **only when there's a single compose file**; when several exist, fold it into the ask above (the tunnel usually belongs to one specific deployment). → `{{RUN_MODEL}}=tunnel over compose`, `{{BASE_URL}}=https://<that-host>`.
3. **`deploy` skill?** `ls .claude/skills/deploy 2>/dev/null`. If present, the generated skill must note "containers are managed via `/deploy`; this skill never starts/stops them — if they're down, tell the user."
4. **In-container port (informational):** `grep -rn "server.port\|SERVER_PORT" src/main/resources/application*.yml *.properties docker-compose*.yml 2>/dev/null`. The host port from step 1 still wins for the URL.
5. **No compose (plain dev server):** default to the framework port (Spring `8080`, Django `8000`, FastAPI/Uvicorn `8000`, Vite `5173`, Express commonly `3000`) → `{{RUN_MODEL}}=local dev server`, `{{HEALTH_CHECK_CMD}}` = a health curl or a `pgrep`/`lsof -i:<port>` process check, `{{LOGS_CMD}}` = the app's logfile or stdout.
6. **Ambiguous / multiple candidates / tunnel uncertain → ASK.** If the user can't say, write `{{BASE_URL}}=TODO` with a prominent note.

### `{{REBUILD_NOTE}}`
Write it as a complete sentence starting with a capital letter (it gets inlined after a `.` in the templates):
- Compose + the app image is built from the repo (Dockerfile) → "Uncommitted changes don't reach the running app until you rebuild: `docker compose up -d --build app` (check image age with `docker compose ps` first). This is the only Docker action the skill performs."
- Bind-mounted source / live-reload dev server → "Changes are picked up automatically; no rebuild needed."
- Otherwise → describe the project's actual rebuild step, or "No rebuild needed."
- If a `/deploy` skill manages the stack, append: "Containers are managed via `/deploy`; this skill never starts/stops them — if they're down, tell the user." (Do not also repeat a separate down-check note; this line covers it.)

## Worktree-isolation knobs → `{{IF_COMPOSE}}` / `{{COMPOSE_FILE}}` / `{{APP_SERVICE}}` / `{{APP_CONTAINER_PORT}}` / `{{REDEPLOY_CMD}}`

These feed the generated skill's *Where the app runs* section, which delegates to the shared `worktree-deploy.sh` helper so the skill is parallel-safe across git worktrees (isolated ephemeral stack per worktree, default behavior in the main tree). Relevant only when the app runs as a **docker compose** stack.

- `{{IF_COMPOSE}}` — `true` when the run model is docker compose (a compose file exists and is the test target, including `tunnel over compose`). `false` for plain dev servers, non-web projects, or anything not fronted by compose → the whole isolation block is dropped and the skill keeps its single-target behavior.
- `{{COMPOSE_FILE}}` — the compose file the test target uses, as the helper should see it (compose-native, colon-separated for multiple): usually `docker-compose.yml`, or the file the user chose when several exist (e.g. `docker-compose.dev.yml`). The helper passes it to `docker compose` via the `COMPOSE_FILE` env var.
- `{{APP_SERVICE}}` — the compose **service** that serves the app (the one the base URL points at): the service with a `build:` section, or the one publishing the app's host port. The helper republishes this service on an ephemeral port.
- `{{APP_CONTAINER_PORT}}` — the **container-side** port the app listens on (the `target` of the app service's port mapping, or `server.port` / `SERVER_PORT` inside the container — e.g. `8080` even when the host publishes `8088:8080`). Not the host port.
- `{{REDEPLOY_CMD}}` — the command that rebuilds + restarts the running app, i.e. the actionable command inside `{{REBUILD_NOTE}}` (e.g. `docker compose up -d --build app`). The helper runs it verbatim in the main tree and ignores it in a worktree (where it builds its own isolated stack). If nothing needs rebuilding (bind-mounted / live-reload), use a no-op like `true`.

When several compose files exist, the deployment the user chose (above) also fills `{{COMPOSE_FILE}}` and the matching `-f` in `{{REDEPLOY_CMD}}`. For a `tunnel over compose` deployment, `{{IF_COMPOSE}}` is still `true` (the helper isolates the local compose stack); the tunnel URL stays the main-tree `{{BASE_URL}}` default.

## In-repo HTTP helpers to prefer over curl

```
ls scripts/*.py bin/* tools/* 2>/dev/null
grep -nE "test|api|smoke|e2e" Makefile justfile Taskfile.yml 2>/dev/null
```

**Important — keep login out of `{{HTTP_TOOL_BLOCK}}`.** The block holds **probes only** (GET examples, a raw/escape-hatch call, an HTMX-header example). The login flow lives once in `{{LOGIN_EXAMPLE}}` (see Auth model), so the generated prompt never shows the same login snippet twice.

- **A REST client like `scripts/api.py`** → `{{HTTP_TOOL_NAME}}=scripts/api.py`; `{{HTTP_TOOL_BLOCK}}` = help-discovery + `raw` escape hatch (no login); `{{CURL_FORBIDDEN_NOTE}}` = "Do **not** reach for curl — prefer the helper and extend it rather than reaching for curl; it keeps auth/tenant handling consistent, which avoids flaky tests and missed auth bugs." Phrase the note as a full sentence (the template puts a space before it).
- **None** → `{{HTTP_TOOL_NAME}}=curl`; `{{HTTP_TOOL_BLOCK}}` = GET probes + the HMX-header example (no login); `{{CURL_FORBIDDEN_NOTE}}` = empty. python e2e scripts (requests) carry the persisted flows.

### Second helper → `{{IF_E2E_HELPER}}` / `{{E2E_HELPER_BLOCK}}`
If a **distinct end-to-end helper** exists beyond the REST client — e.g. a chat client (`scripts/chat.py`), a seeding/fixture script, a synthetic-user driver — set `{{IF_E2E_HELPER}}=true` and fill `{{E2E_HELPER_BLOCK}}` with a short "### `<name>`" usage section (discover via `--help`, one example). This is how RAG/chat apps keep their end-to-end driver in the prompt. None found → `{{IF_E2E_HELPER}}=false`.

These are the **project's own** helpers — the generated skill uses them in place but never modifies the project's `scripts/`. Newly generated e2e scripts go under `{{E2E_DIR}}` (the skill's own `e2e/`), never into the project's `scripts/`.

## `{{UI_IN_SCOPE}}` (web pair only)

A **web-pair placeholder**. It gates the `/agent-browser` blocks and nothing else — every
`{{#IF_UI}}` block in both web templates is browser material. The process pair does not have it,
and a terminal app never sets it: a TUI is a user interface, but not one a browser can open. Use
`{{SURFACE}}` to choose the pair, and this only to decide whether the *web* pair keeps its browser
blocks; unifying the two produces a skill that tells a subagent to open a URL against a program
with no HTTP server.

```
find . -type d -name templates -path "*resources*" 2>/dev/null     # Thymeleaf/JTE/Freemarker
grep -lE "thymeleaf|jte|freemarker|mustache" pom.xml */pom.xml build.gradle 2>/dev/null
# package.json deps: react|vue|svelte|@angular  → SPA
ls -d */templates templates 2>/dev/null                            # Django templates
```
- Server-rendered templates or a front-end framework present → `{{UI_IN_SCOPE}}=true` (keep agent-browser flows + the UI/UX, broken-assets, accessibility sections).
- Pure JSON API (no templates, no front-end deps) → `false`. Keep agent-browser only if a docs/admin UI exists (`grep -rl "springdoc\|swagger-ui\|/swagger" . 2>/dev/null`).

## Credentials → `{{CREDS_PATH}}` = `.claude/skills/test-app/test_creds.txt`

The generated skill standardizes on its **own** creds file (skill-dir, conflict-free), wherever the project keeps credentials.

- `ls .claude/skills/test-app/test_creds.txt` — if missing, the generator writes the stub (workflow step 7).
- If the project already has creds (repo-root `test_creds.txt`, `.env` `ADMIN_EMAIL`/`ADMIN_PASSWORD`, a `test_tenant_creds.txt`), read the **format and role list** (not the secrets) to shape the stub and the prompt's role list, and offer to seed the new file from it.
- The generated skill also prompts the user for any missing role at run time and appends it to `{{CREDS_PATH}}`.

## Auth model → `{{AUTH_MODEL}}` / `{{LOGIN_EXAMPLE}}` / `{{ROUTES_BLOCK}}`

Scope probes to `*/src/main` and exclude scratch/worktree copies, so test code and duplicated trees don't match:

```
find . -path '*/src/main/*SecurityConfig*.java' -o -path '*/src/main/*SecurityConfiguration*.java' 2>/dev/null
grep -rn "formLogin\|csrf\|oauth2ResourceServer\|httpBasic\|BearerToken\|addFilter.*Jwt" \
  --include=*.java --exclude-dir=worktrees --exclude-dir=.claude */src/main 2>/dev/null
grep -rn "permitAll\|hasRole\|hasAuthority\|authenticated()" \
  --include=*.java --exclude-dir=worktrees --exclude-dir=.claude */src/main 2>/dev/null
```

Classify by what carries the credential on each request, **not** by whether a helper auto-loads creds:
- A **session cookie + CSRF** (`formLogin`, `CookieCsrfTokenRepository`, a login endpoint that sets a session) → `{{AUTH_MODEL}}=Spring Security session/form login + CSRF`; `{{LOGIN_EXAMPLE}}` = the cookies + `_csrf`/`X-XSRF-TOKEN` login snippet. This is still session auth even if a helper or `.env` supplies the username/password.
- A real **bearer token** (`oauth2ResourceServer`, a JWT/`Authorization: Bearer` filter, the client sends `Authorization: Bearer …`) → `{{AUTH_MODEL}}=JWT bearer`; `{{LOGIN_EXAMPLE}}` = the bearer-token snippet (often via the in-repo helper). Do **not** call it JWT just because a token is cached on disk — look for `Bearer` on the wire.
- Django → session login via the login form (CSRF token in the form); shape accordingly.
- No auth → `{{AUTH_MODEL}}=none`; drop the login example and the authorization pass.
- `{{ROUTES_BLOCK}}`: from the `permitAll` / `hasRole` matchers, list public vs role-gated routes (the shape of a project's own Routes section). If undiscoverable, emit a generic "log in, then exercise the affected routes."

## Conditional catalog signals

Scope every grep below to `*/src/main` and add `--exclude-dir=worktrees --exclude-dir=.claude --exclude-dir=test` so test-only and duplicated-tree matches don't flip a flag on.

- `{{IF_IDOR}}` — multi-tenant or per-user ownership in production code: `grep -rln "tenant\|TenantId\|ownerId\|getCurrentUser" --include=*.java --exclude-dir=worktrees --exclude-dir=.claude */src/main 2>/dev/null`. Present → enable the IDOR check.
- `{{IF_RATELIMIT}}` — a rate limiter on the **auth/login path**, actually active. `grep -rln "bucket4j\|RateLimit\|resilience4j.*ratelimiter" --include=*.java */src/main 2>/dev/null`. A match alone isn't enough: confirm the limiter is registered/enabled on the chain and applies to login (not `registration.setEnabled(false)`, not only a widget/chat throttle). Only then enable the login rate-limiting check; otherwise leave it off rather than test a disabled feature.
- `{{IF_I18N}}` — `find . -path '*/src/main/*messages*.properties' 2>/dev/null; grep -rln "LocaleResolver\|react-i18next\|vue-i18n" */src/main 2>/dev/null`. Present with ≥2 locales → enable the localization check.

## `{{EXTRA_SERVICES}}`

Grep compose for supporting services and add a short block:
- `mailhog` → "Mailhog UI at `http://localhost:8025` (`/api/v2/messages`) for verifying emails when an auth/email flow is in scope."
- `minio` → object storage note. `redis`, `kafka`, etc. → mention only if relevant to the change.
