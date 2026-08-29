# Process surfaces — TUI and CLI

Read this only when Step 0 of `detection-guide.md` resolved the surface to `tui` or `cli`. It is
kept out of that file on purpose: Step 0 runs for every project, and the common compose-backed
Maven scaffold should not pay to read two hundred lines of ratatui signatures.

Everything here fills the *process pair* half of the placeholder map. Where a signal is missing,
fall back as noted — and where the fallback is "ask", ask rather than guessing.

## Framework signatures

These identify **candidates**. On their own they settle nothing — the discriminator in
`detection-guide.md` decides. A dependency is not a surface: `ratatui` sits in
`[dev-dependencies]`, `rich` prints coloured tables from a plain CLI, `bubbles` gets vendored for
one spinner.

| language | TUI candidates | CLI candidates |
| --- | --- | --- |
| Rust | `ratatui`, `tui`, `crossterm`, `termion`, `cursive` | `clap`, `structopt`, `argh`, `pico-args` |
| Go | `charmbracelet/bubbletea`, `charmbracelet/bubbles`, `rivo/tview`, `gocui`, `gdamore/tcell` | `spf13/cobra`, `urfave/cli`, `alecthomas/kong`, stdlib `flag` |
| Python | `textual`, `urwid`, `prompt_toolkit`, `blessed`, `py-cui`, stdlib `curses` | `argparse`, `click`, `typer`, `docopt`, `rich` (printing only) |
| Node | `ink`, `blessed`, `neo-blessed`, `terminal-kit` | `commander`, `yargs`, `oclif`, `cac` |
| C/C++ | `ncurses`, `curses.h`, `termios.h` | `getopt.h`, `argp.h` |
| Java/Kotlin | `com.googlecode.lanterna`, `org.jline` | `info.picocli`, `jcommander`, `args4j` |

## `{{LAUNCH_CMD}}` and `{{BIN_PATH}}` — two values, and the difference matters

`{{LAUNCH_CMD}}` starts the app from the project root with **no arguments**. `{{BIN_PATH}}` is the
**built executable**. They are separate because every exit-code, stdout/stderr and piping check
has to invoke `{{BIN_PATH}}`: a source runner writes its own lines to stderr and returns its own
exit code, so a check that ran `cargo run -- --bad-flag` and saw exit 101 learned something about
cargo, not the app. Fold them into one and the whole CLI catalog silently tests the wrong program.

```
grep -nA2 '^\[\[bin\]\]' Cargo.toml 2>/dev/null; ls src/main.rs src/bin/*.rs 2>/dev/null
ls cmd/*/main.go 2>/dev/null; grep -rln 'func main()' --include=*.go . 2>/dev/null | head
grep -n '"bin"' package.json 2>/dev/null
grep -nA3 '\[project.scripts\]\|\[tool.poetry.scripts\]\|console_scripts' pyproject.toml setup.cfg setup.py 2>/dev/null
grep -n 'mainClass' pom.xml build.gradle build.gradle.kts 2>/dev/null
grep -nE '^(run|start|dev|build):' Makefile justfile Taskfile.yml 2>/dev/null
```

| stack | `{{LAUNCH_CMD}}` | `{{BIN_PATH}}` | `{{BUILD_CMD}}` |
| --- | --- | --- | --- |
| Rust | `cargo run --quiet` | `target/release/<bin>` | `cargo build --release` |
| Go | `go run ./cmd/<app>` | `bin/<app>` | `go build -o bin/<app> ./cmd/<app>` |
| Python (script) | `python3 -m <pkg>` | the console-script name | `pip install -e .` |
| Node | `node dist/cli.js` | `dist/cli.js` (or the `bin` name) | `npm run build` |
| a Makefile target | `make run` | whatever `make build` writes | `make build` |

When the source runs directly with no build step, `{{BUILD_CMD}}` is `true` — a literal no-op, not
an empty string, so the generated skill's shell block still parses.

## `{{STATE_DIR}}` and `{{STATE_ISOLATION_BLOCK}}`

Isolation on this surface is a **state directory**, never a port — which is why the generated
skill has no "refuse to run from a worktree" case: two worktrees running a terminal program cannot
collide over a port they do not open, but they will corrupt each other's config, history or
embedded database.

```
grep -rn 'XDG_CONFIG_HOME\|XDG_DATA_HOME\|dirs::config_dir\|os.UserConfigDir\|platformdirs\|appdirs\|envPaths' --include='*.rs' --include='*.go' --include='*.py' --include='*.ts' --include='*.js' . 2>/dev/null
grep -rn '\.config/\|\.local/share/\|APP_HOME\|--config' --include='*.rs' --include='*.go' --include='*.py' . 2>/dev/null | head
```

- Standard XDG paths → `{{STATE_ISOLATION_BLOCK}}` exports `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
  `XDG_STATE_HOME`, `XDG_CACHE_HOME` at a throwaway directory.
- The app's own environment knob (`APP_HOME`, `<APP>_CONFIG`) → export that instead; it is more
  precise and does not depend on the app honouring XDG at all.
- A `--config` flag with a default → pass the flag.
- Nothing found → `{{STATE_DIR}}` is `~/.config/<app>` as a stated guess, and the summary marks it
  guessed. **Do not** override `HOME` as a blanket answer: it also hides the toolchain's own caches
  from the build, and the build failure that follows reads as an app failure.

## `{{KEYMAP_BLOCK}}` — the TUI's analogue of the web pair's routes

Without it a subagent guesses `q`, gets nothing, and reports the app unresponsive — the commonest
false finding on this surface, and preventable by reading the table.

```
grep -rn 'KeyCode::\|key.String()\|BINDINGS\|Binding(\|bind(\|keymap\|key_bindings' --include='*.rs' --include='*.go' --include='*.py' . 2>/dev/null | head -40
grep -rn 'BINDINGS *=\|def key_\|on_key\|handle_key\|KeyEvent' --include='*.py' --include='*.rs' . 2>/dev/null | head -20
```

Read it from the binding table in code first, the help screen (`?` / `F1`) second, the README last.
Fill `{{KEYMAP_BLOCK}}` as a short table of key → what it does → which screen it applies to. Where
bindings are screen-specific, say so — a key that quits the app from the list and closes a modal
from inside it is two behaviours, and a test that conflates them fails for the wrong reason.

## `{{CLI_INVOCATION_BLOCK}}` and `{{EXIT_CODE_TABLE}}`

```
grep -rn 'Command::new\|SubCommand\|#\[derive(Parser\|#\[command(' --include='*.rs' . 2>/dev/null | head -30
grep -rn 'AddCommand\|cobra.Command{\|flag\.\(String\|Bool\|Int\)' --include='*.go' . 2>/dev/null | head -30
grep -rn 'add_argument\|add_parser\|@click.\|@app.command\|typer.Typer' --include='*.py' . 2>/dev/null | head -30
grep -rn '\.command(\|\.option(\|yargs\.\|@Command(' --include='*.ts' --include='*.js' --include='*.java' . 2>/dev/null | head -30
```

Read the **parser definition**, never `--help`. `--help` accuracy is itself a catalog item, so
taking it as the specification means a wrong help text can never be found — the check would compare
the app against itself and always pass.

`{{EXIT_CODE_TABLE}}`: look for named constants, a `sysexits.h` include, or a documented table in
the README. Found → set `{{IF_EXIT_CODES}}` true and list them. Not found → leave it false; the
catalog item degrades to "0 on success, and a **distinct** non-zero per failure class", which still
catches the real defect (an error path that prints a message and then returns success).

## Native harnesses → `{{IF_NATIVE_HARNESS}}` / `{{NATIVE_HARNESS_BLOCK}}`

| framework | detect | invocation to put in the block |
| --- | --- | --- |
| textual | `pytest-textual-snapshot` in dev deps, a `snap_compare` fixture, `App.run_test()` | `pytest tests/ -k snapshot` |
| ratatui | `TestBackend::new(`, `Terminal::new(TestBackend`, `insta` | `cargo test` |
| bubbletea | `charmbracelet/x/exp/teatest`, `NewTestModel`, golden files | `go test ./...` |
| ink | `ink-testing-library`, `lastFrame()` | `npm test` |

**Never put the baseline-updating flag in the block** — not `--snapshot-update`, not `-update`.
Those rewrite the golden file to match whatever the code now does, turning a regression into a
pass — the one way a snapshot harness can hide the defect it exists to catch.

**A harness never replaces the terminal track**, and the generated skill says so. It renders into a
fake backend, so it cannot observe the three things that break most often: the alternate screen
left on at exit, the terminal not restored after a panic, and behaviour under a real TTY versus a
pipe. It *is* better than a captured frame at deterministic assertions on paths it covers, which is
why both run.

## The remaining conditional flags

Scope every grep to the app's own source and exclude test and vendor trees, so a fixture cannot
flip a flag on.

- `{{IF_COLOR}}` — the app styles its output: `SetForegroundColor`, `Style::default().fg`,
  `lipgloss.`, `chalk.`, `rich.console`, `colorama`, or any `\033[3` literal. Enables the colour
  and `NO_COLOR` checks.
- `{{IF_MOUSE}}` — `EnableMouseCapture`, `tea.WithMouseCellMotion`, `screen.EnableMouse()`,
  `mouse=True`. Enables the mouse item, deliberately written as *covered by the harness or recorded
  as not covered* — a mouse report cannot be honestly synthesized into a pane, and a check that
  cannot fail is worse than an admitted gap.
- `{{IF_STDIN}}` — the app reads stdin: a `-` argument, `io.stdin`, `os.Stdin`, `process.stdin`,
  `sys.stdin`. Enables the piping and EOF checks.
- `{{IF_SIGNALS}}` — `signal.Notify`, `ctrlc::set_handler`, `signal.signal(`, a `SIGINT` trap.
  Enables the signal checks.
- `{{IF_REMOTE_AUTH}}` — the app authenticates to something remote: a token in its config, an
  `Authorization` header, an OAuth flow, a keyring call. Enables the client-side token checks.
- `{{IF_SHELLS_OUT}}` — `Command::new("sh")`, `exec.Command("sh", "-c"`, `os.system`,
  `subprocess(..., shell=True)`, `child_process.exec`, backticks in a built string. Enables the
  injection checks, which matter more here than on a web app: the shell is right there.
- `{{IF_PATH_ARGS}}` — the app takes a filesystem path as an argument or a config value. Enables
  the traversal checks, this surface's analogue of a cross-user access bug.

## `{{TERM_GEOMETRY}}` and `{{GEOMETRY_SWEEP}}`

`{{TERM_GEOMETRY}}` is the size the app is designed for — from a minimum-size guard
(`if width < N`), its layout constraints, or its README. Default `120x40`.

`{{GEOMETRY_SWEEP}}` is always three sizes: something wide (`160x50`), `{{TERM_GEOMETRY}}`, and
**`80x24`**. Keep that last one when trimming: it is the size every terminal guarantees, and where
a layout that quietly assumes width falls apart — the mobile viewport of the web pair, for the same
reason.

## `{{LOGS_CMD}}` — almost never stdout

On a TUI, stdout **is** the UI, so a log line printed there corrupts the frame. Look for a logfile
path, a `--log-file` flag, a `RUST_LOG`/`DEBUG`/`<APP>_LOG` env var whose output is redirected, or
a `journalctl` unit. If the app has no log channel, say so in the summary rather than pointing
`{{LOGS_CMD}}` at stdout: the generated skill would then tell a subagent to grep the rendered
screen for stack traces, which is not the same check and quietly always passes.
