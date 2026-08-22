---
description: >-
  Scaffold a project-local /test-app skill into the CURRENT project by detecting its stack (build
  tool, how it runs, base URL, in-repo HTTP helpers, UI vs JSON-API, auth model, credentials,
  security signals) and writing a tailored `.claude/skills/test-app/SKILL.md` plus
  `references/subagent-prompt.md`. Use whenever the user wants to "create the test-app skill",
  "scaffold test-app", "set up /test-app for this project", "generate a test skill for this repo",
  "make a test-app skill here", or runs `/r:test-app-create` — even if they don't name the files.
  This GENERATES the test skill; it does NOT itself test the app (running the tests is the job of
  the generated `/test-app`). So if the user wants to "test the app" / "verify the changes" right
  now, that is the `test-app` skill, not this one.
---

# Create Test App

Generates a `/test-app` skill tailored to the current project. The generated skill verifies that recent changes to the running app actually work — by exercising it through HTTP (curl or an in-repo helper), persisted python e2e scripts, the `/agent-browser` skill, and the app's logs — and reports concrete pass/fail.

Both reference projects (`ai-support`, `avtoportal`) prove the same two-file shape, differing only in project-specific details. Your job is to detect those details and fill them into the templates.

## What gets written

```
<project-root>/.claude/skills/test-app/
├── SKILL.md                       # from assets/test-app.SKILL.md.template
├── references/
│   └── subagent-prompt.md         # from assets/subagent-prompt.md.template
├── test_creds.txt                 # from assets/test_creds.txt.template — only if missing
└── e2e/                           # created on first run, holds the generated python e2e scripts
```

Everything the generated skill owns lives **under its own directory** (`.claude/skills/test-app/`) — the credentials file and the generated `e2e/*.py` scripts. This is deliberate: it keeps generated artifacts from colliding with the project's real `scripts/` (e.g. an existing `scripts/api.py`) or a repo-root creds file, and makes the skill self-contained and portable. The generated skill always references these by the project-root-relative path `.claude/skills/test-app/…`.

## Workflow

### 1. Resolve the project root

```
git rev-parse --show-toplevel
```

If that fails (not a git repo), use the current working directory as the root and note that the generated skill's no-argument git-diff scoping will be limited — it will lean on conversation history instead. Everything below is relative to this root.

### 2. Detect the project's shape

Read `references/detection-guide.md` and run the read-only probes. You're filling in this set of values (the placeholder map):

| Placeholder | What it is |
| --- | --- |
| `{{APP_NAME}}` | Human name — dir name, pom `<name>`, or package.json `name` |
| `{{BASE_URL}}` | Where the running app is tested (e.g. `http://localhost:8088`, a tunnel URL) |
| `{{RUN_MODEL}}` | "docker compose stack" / "local dev server" / "tunnel over compose" |
| `{{HEALTH_CHECK_CMD}}` | How to confirm it's up (`docker compose ps`, a health curl) |
| `{{REBUILD_NOTE}}` | How uncommitted code reaches the running app, or "no rebuild needed" |
| `{{HTTP_TOOL_NAME}}` | `scripts/api.py` if an in-repo REST helper exists, else `curl` |
| `{{HTTP_TOOL_BLOCK}}` | The matching **probes-only** usage block (no login — login lives in `{{LOGIN_EXAMPLE}}`) |
| `{{CURL_FORBIDDEN_NOTE}}` | Full sentence when a preferred helper exists, else empty |
| `{{E2E_HELPER_BLOCK}}` | A `### \`<name>\`` usage section for a second in-repo helper (chat/seed/e2e driver); wrapped in `{{#IF_E2E_HELPER}}` — drop when none |
| `{{WTD_PATH}}` | Always `${CLAUDE_PLUGIN_ROOT}/skills/task-review/scripts/worktree-deploy.sh` — the generated skill is project-local, so the real path is substituted here rather than left as a variable |
| `{{CREDS_PATH}}` | Always `.claude/skills/test-app/test_creds.txt` (skill-owned, conflict-free) |
| `{{E2E_DIR}}` | Always `.claude/skills/test-app/e2e` (where generated python e2e scripts are saved) |
| `{{LOGIN_EXAMPLE}}` | Form-login+CSRF snippet or JWT-bearer snippet |
| `{{AUTH_MODEL}}` | "Spring Security form login + CSRF", "JWT bearer", "none" |
| `{{ROUTES_BLOCK}}` | Public vs role-gated routes, when discoverable |
| `{{LOGS_CMD}}` | `docker compose logs app` / a logfile / stdout |
| `{{EXTRA_SERVICES}}` | Mailhog `:8025`, MinIO, etc.; wrapped in `{{#IF_EXTRA_SERVICES}}` — drop the block when none |
| `{{IF_COMPOSE}}` | Whether the app runs as a docker compose stack — drives the `{{#IF_COMPOSE}}` worktree-isolation block (drop it for non-compose run models) |
| `{{COMPOSE_FILE}}` | The compose file the test target uses (e.g. `docker-compose.yml`, or the chosen one when several exist) |
| `{{APP_SERVICE}}` | The compose service that serves the app (the one the base URL points at) |
| `{{APP_CONTAINER_PORT}}` | The **container-side** port the app listens on (e.g. `8080`, not the host port) |
| `{{REDEPLOY_CMD}}` | The actionable rebuild+restart command from `{{REBUILD_NOTE}}` (e.g. `docker compose up -d --build app`), or `true` if nothing needs rebuilding |
| `{{UI_IN_SCOPE}}` | `true`/`false` — drives the `{{#IF_UI}}…{{/IF_UI}}` guards |
| `{{IF_IDOR}}`, `{{IF_RATELIMIT}}`, `{{IF_I18N}}`, `{{IF_E2E_HELPER}}` | Whether multi-tenant/per-user ownership, an active login rate-limiter, i18n, and a second in-repo e2e helper were detected — drive the matching `{{#IF_*}}` guards |

The base URL is the one value you must not guess. ai-support publishes `8080:8080` in compose yet is tested via a Cloudflare tunnel — so a published port is a candidate, not an answer. When the URL or run model is ambiguous, ask (step 4).

**If the repo has more than one compose file** (`docker-compose.yml` + a `.dev.yml`/`.prod.yml`/`.override.yml`), they are different deployments with different URLs and `compose -f` commands — the skill can't know which one is the test target. List the candidates and **ask the user which deployment `/test-app` should run against**, then bake their choice into the URL/run-model and the compose commands.

### 3. Summarize what you found

Show the user a compact table: stack, run model + base URL, HTTP tool (helper vs curl), UI in scope?, auth model, creds-file status, extra services, and which conditional catalog items will activate (IDOR / rate-limiting / localization). **Explicitly mark anything you guessed**, the URL above all.

### 4. Confirm and fill gaps

If the URL, run model, or creds format is ambiguous, ask one batched round of questions and use the answers. **Always ask when several compose files exist** — which deployment is the test target. Don't invent a public URL — if the user doesn't know it, write the skill with a `BASE_URL: TODO` marker and a prominent "set this before the first run" note.

### 5. Handle a pre-existing test-app skill (incl. upgrading to worktree isolation)

Both reference projects already have a hand-tuned `test-app`. If `.claude/skills/test-app/` already exists, **do not overwrite silently**: show what would change (a short diff of intent), and overwrite only on the user's explicit confirmation. If they decline, stop.

**The common upgrade case:** a skill generated before worktree isolation existed has no *Where the app runs* section, so its **manual** `/test-app` runs still hit the fixed default port and collide across worktrees. (The automated verifier path is already safe — `/r:task-review` Step 8a deploys through the shared helper regardless of the skill's age.) When you detect a compose-based skill missing that block, offer the upgrade: re-detect the compose knobs (step 2) and rewrite the skill with the `{{#IF_COMPOSE}}` section added, leaving the rest of the user's tailoring intact. This is the one-command way an existing project's manual runs become parallel-safe.

### 6. Write the files

`mkdir -p .claude/skills/test-app/references`, then copy each template, substituting placeholders and resolving the section guards: a `{{#IF_UI}} … {{/IF_UI}}` block (and the other `{{#IF_*}}` blocks) is kept verbatim when its flag is true and deleted entirely when false. Strip every `{{#IF_*}}` / `{{/IF_*}}` marker line from the output — the generated files must contain no template syntax.

### 7. Write the creds stub if needed

If `.claude/skills/test-app/test_creds.txt` is absent, write it from `assets/test_creds.txt.template`, add `.claude/skills/test-app/test_creds.txt` to `.gitignore` (it holds secrets — ask first), and tell the user to fill in real accounts. Never copy real secrets into the skill files — they only ever reference the creds path. If the project already keeps credentials elsewhere (e.g. a repo-root `test_creds.txt` or `.env`), note it in the summary but still standardize the generated skill on its own skill-dir creds file to stay conflict-free; you can seed the new file from the existing one with the user's OK.

### 8. Report

List the files you created, summarize the tailoring in a sentence or two, and show how to use the result:
- `/test-app` — no argument: tests the added/changed behavior from the git diff.
- `/test-app <description or @module>` — tests exactly that (e.g. `/test-app auth process`, `/test-app @web-adapter`).

Suggest a first run.

## Record the run

One line into the pack-wide store — counts and detection outcomes only, never a credential, a base
URL, a hostname, or anything read out of the project's config.

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:test-app-create","buildTool":"maven","surface":"ui","authModel":"form",
 "detectedFromCode":0,"askedTheUser":0,"httpHelpersFound":0,"credentialsFound":false,
 "filesWritten":0,"overwroteExisting":false,"blockedReason":null}
STATS_JSON
```

**`detectedFromCode` against `askedTheUser` is what this skill is tuned on.** Detection is the whole
point — a scaffolder that asks the user for the base URL, the build command and the login route has
only rephrased the questions. Read it per `buildTool` and `surface`: a stack that always falls back
to asking is a detection gap with a name, not a general one.

**`credentialsFound: false` is a normal outcome, never a blockage.** The generated skill works
without test credentials; it just cannot log in. Recording it as a block would put a scaffold that
succeeded into the same bucket as one that never ran.

The script always exits `0` — a lost row is a lost row, never a failed run, and it must never change
what was written. Never retry it.

## Edge cases

- **No docker** — drop the rebuild/compose-logs material; `{{LOGS_CMD}}` becomes the app's logfile or stdout, `{{HEALTH_CHECK_CMD}}` a health curl or process check.
- **Pure JSON API** (no templates, no front-end deps) — `{{UI_IN_SCOPE}}=false`; the UI/UX checks degrade to API response-shape validation; keep agent-browser only if an admin/docs UI (e.g. Swagger) exists.
- **Non-web project** (CLI/library) — `{{UI_IN_SCOPE}}=false`; the generated skill tests via CLI invocation + exit codes + stdout/stderr and the project's own runner; tell the user the UI checks were omitted and why.
- **Worktrees need the skill on their branch.** The generated skill is loaded at session start from the checkout's own `.claude/skills/`. Track it in git so worktrees carry it — but tracking alone isn't enough: a worktree branched off a commit from *before* the skill landed won't have it, so `/test-app` silently won't load there. Tell the user to commit the skill and to base/rebase worktrees on a commit that includes it. (`r:task-review`'s Step 8 detects this stale-worktree case and says so rather than reporting "no skill configured.")
