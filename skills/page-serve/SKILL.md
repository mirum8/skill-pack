---
description: >-
  Put one local HTML file — or the directory around it — on a small http server, reachable only
  from this machine by default or from every device on the network with `--lan`, then hand back
  the URL and a way to stop it. For opening a `compare.html`, a `spec.html`, a `plan-report`
  milestone or any generated page on a phone, a tablet or a second screen without copying files
  around or pushing anything anywhere. The URL lands on the clipboard, ready to paste into a
  browser. Use on "/r:page-serve <file>", "/r:page-serve <file> --lan", "serve this page", "open
  this on my phone", "put this html on a local web server", "/r:page-serve --stop". The server
  refuses every dotfile and every symlink leaving the served directory, so `.git` and `.env` are
  unreachable even on the LAN, it always uses port 8000 so one firewall rule keeps matching, and
  it prints a URL only after the page has actually answered.
  Nothing is uploaded and nothing leaves the local network. NOT for publishing a page to
  claude.ai (that is `/r:ui-prototype --share`), running a project's own dev server or app (that
  is its `/test-app`), or driving a page in a browser (`agent-browser`).
disable-model-invocation: true
---

# page-serve — one local page, on this machine or on the LAN

`/r:page-serve <file> [--lan]` puts a generated page somewhere a browser can reach it — this
machine's, or a phone's — and leaves the URL on the clipboard. That is the whole skill; everything
below is the small number of things that must not be got wrong.

**Not automatic.** It opens a listening socket, and `--lan` makes that socket reachable from every
device on the network. Nobody wants that arrived at by inference, which is why the frontmatter
blocks the Skill tool rather than a sentence asking the model to be careful. Type it, or invoke its
script directly — that is how `/r:ui-prototype` Step 5 offers a LAN URL for its prototype page.

## Invocation

```
/r:page-serve <file|dir> [--lan] [--port N] [--no-copy]   start it (port 8000)
/r:page-serve --stop [<handle>]                           stop one, or all of them
/r:page-serve --list                                      what is running
```

Every form is one call to the script:

```bash
"${CLAUDE_SKILL_DIR}/scripts/serve.sh" start docs/design/variants/compare.html --lan
"${CLAUDE_SKILL_DIR}/scripts/serve.sh" stop p8137        # or: stop --all
"${CLAUDE_SKILL_DIR}/scripts/serve.sh" list
```

Report its output as it stands. It already prints the served directory, the URLs and the stop
command; re-describing them is how a URL that was never printed gets into a summary anyway.

## The four rules

**`--lan` is the consent, so state it and do not ask it.** One line of fact before running —
*"this puts the page on the local network at `http://<ip>:<port>`"* — then run it. Asking a
question the user answered by typing the flag is the behaviour `--share` already refuses in
`/r:ui-prototype`. Without the flag the server binds `127.0.0.1` and nothing outside this machine
can reach it.

**The URL goes on the clipboard, and under `--lan` it is the LAN one.** A LAN address works from
this machine as well as from the phone, so once `--lan` has been asked for it is strictly the more
useful of the two to have copied. Say which URL was copied — the script prints it — rather than
leaving the user to guess between the two lines above it. `--no-copy` leaves the clipboard alone,
and a machine with no `pbcopy`/`wl-copy`/`xclip`/`xsel` is **named**: the page is served either
way, and failing a working server over a missing clipboard tool would be the tail wagging the dog.

**The port is 8000 and it does not move.** A firewall rule names a port, so a server that
quietly took the next free one would land outside the rule that was opened for it and be dropped
with nothing to read — a page that does not load, from a run that reported success. A busy 8000 is
therefore an error (`3`) naming what holds it, never a silent move; `--port N` overrides it
deliberately, and `PAGE_SERVE_PORT` moves the default on a host that has allowed a different one.

Allow it **once per host**, scoped to the LAN rather than to everything:

```bash
sudo ufw allow from 192.168.88.0/24 to any port 8000 proto tcp   # ufw
sudo firewall-cmd --add-port=8000/tcp                            # firewalld
```

The script names the firewall it can see when `--lan` is given, because that check is the one it
cannot make for you: traffic from the host to its own address goes over loopback, so the server
answers itself perfectly while every other device is being dropped. Reading the rules needs root,
so it names the firewall and the command and never claims a verdict.

**A URL is printed only when the page answered.** The script polls after spawning and exits `5`
with no URL if nothing responds. Never fill that gap in from the port it was going to use: a URL
nothing is listening on is indistinguishable from a working one until somebody taps it on another
device, and by then they are looking at a browser error rather than the page you meant to show
them.

**What it serves is the directory, and what it refuses is not negotiable.** A page's relative
assets have to resolve, so the target's directory is the root — and the handler refuses every path
segment beginning with `.` and every symlink resolving outside that root. `python3 -m http.server`
would hand `.git`, `.env` and an `.ssh` symlink to whoever asks, which on `--lan` is everyone on
the network. That refusal is the reason this is a script and not a one-line shell-out, so do not
substitute the one-liner when the script is inconvenient.

## Exit codes are the contract

| code | means |
|---|---|
| `0` | serving, and the page answered |
| `2` | the target is missing, unreadable, a dotfile, or outside the working directory |
| `3` | port 8000 is taken — by another page-serve, or by something else |
| `5` | it started and never answered — **nothing was served, and no URL exists** |
| `64` | usage |

There is no skip code. `python3` is a mandatory prerequisite of this pack, so an absent
interpreter is a broken machine rather than a coverage gap to name.

`2` on a target outside the working directory is deliberate: serving a directory the run was never
pointed at is a different offer from serving a page, and on `--lan` it is a much larger one. Move
the file in, or serve from the directory that holds it.

## Handles

A start writes `~/.claude/page-serve/<handle>.json` and returns; the server outlives the session.
That is why `--stop` works tomorrow from a different session, and why it is worth offering when the
page has been looked at. `--list` prunes handles whose process is gone, so `--stop` can never
report a kill over something that died on its own.

## Record the run

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:page-serve","outcome":"serving|stopped|listed|dead|refused",
 "bind":"local|lan","copied":true,"exit":0}
STATS_JSON
```

`dead` is exit 5 and `refused` is exit 2, and they are kept apart because they need opposite fixes:
one is a server that would not start, the other is a target the run should not have been pointed
at.
