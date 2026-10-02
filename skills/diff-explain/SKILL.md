---
description: >-
  Turn a git diff into one self-contained HTML page a person reviews from: what the change does,
  a map of the files it touches, the logic of each change as a pseudocode diff or another view
  from the external `show-me` skill — call-tree and file-tree diffs, Mermaid sequences, component
  trees — with real code shown only where the exact text matters, and a short "look closely here"
  list of the lines a reviewer should not skim. All prose is ASD-STE100 Simplified Technical
  English. Use on "/r:diff-explain", "/r:diff-explain --staged", "/r:diff-explain HEAD~3..HEAD", "/r:diff-explain <commit>", "/r:diff-explain --base main". Report-only: it
  explains and points, it never fixes, and the page is written outside the repo. NOT for finding
  defects (`/r:code-bugs`), the review-and-fix pipeline (`/r:task-review`), a readability verdict
  (`/r:code-quality`), or a finished milestone's report (`/r:plan-report`).
disable-model-invocation: true
---

# diff-explain — a diff, drawn for the person reviewing it

`/r:diff-explain [scope]` reads one diff and writes one HTML page that shows what changed: not the
lines, which `git diff` already shows, but the **shape** — which calls moved, which file took over
which job, which branch of a flow is new. A line diff hides exactly that, and it is what a reviewer
spends most of their time rebuilding in their head.

It is **report-only**. It explains and it points at places worth a second look; it does not hunt
bugs, judge style, or edit a file. A pointer here is "read this carefully", never "this is wrong" —
the verdicts belong to `/r:code-bugs` and `/r:task-review`, which verify what they claim.

**Not automatic.** The frontmatter blocks the Skill tool, so it runs only when typed.

**All prose is ASD-STE100.** Read `${CLAUDE_SKILL_DIR}/references/ste100.md` before writing a word
of the page. Every sentence a person reads — the summary, each concern, each pointer, the terminal
reply — follows it: approved simple words, one meaning per word, active voice, at most 25 words a
sentence. Code, identifiers and paths are technical names and stay as written. A reviewer reads
this page fast and beside the code, often in a second language; a sentence that needs a second read
costs the time the page exists to save.

## Invocation

| form | diff it reads |
|---|---|
| `/r:diff-explain` | `git diff HEAD` — staged and unstaged work against the last commit |
| `/r:diff-explain --staged` | `git diff --cached` |
| `/r:diff-explain A..B` | `git diff A..B` (also `A...B`, passed through as written) |
| `/r:diff-explain <ref>` | `git diff <ref>^..<ref>` — one commit (`git show` for a root commit) |
| `/r:diff-explain --base <branch>` | `git diff $(git merge-base <branch> HEAD)` — the branch so far, uncommitted work included |

## Steps

### 1. Resolve the scope

Turn the argument into **one** `git diff` command from the table and print it — every later step
reads that command and nothing else, so the page and the terminal summary describe the same change.
An argument that resolves to no ref (`git rev-parse --verify` fails) is reported as such and the run
stops; guessing a nearby ref explains a change nobody asked about.

Run it with `--stat` first. **An empty diff stops the run**: say "no changes in `<command>`", write
no page, record `empty`. Untracked files are not in `git diff HEAD`; if `git status --porcelain`
shows any, name them in the reply so a reviewer knows the page left them out.

### 2. Read what the views need

Read the full diff, then only the code around it that a view depends on: the caller of a changed
function, the owner of a changed field, the component a new one is mounted in. Targeted reads —
the whole point of the page is the change, and a page drawn from whole files drifts into explaining
the codebase.

Sort the touched files into **explained** and **listed only**: lockfiles, generated code, vendored
files, binaries and pure renames are listed, never explained. Nothing is dropped silently — a file
missing from the page reads to a reviewer as a file that did not change.

### 3. Load `show-me`

Invoke the `show-me` skill with the Skill tool and follow it for every view on the page. It is the
instrument this skill exists to use. If it is not installed, stop: say `show-me` is missing and how
to add it (`npx skills add humanlayer/skills --skill show-me`), write no page, record `no-show-me`.
A page drawn without it is a different skill's output under this one's name.

### 4. Build the page

One HTML file — `show-me`'s HTML branch — its prose in STE, with these sections, each only when it carries something:

- **Summary.** Two to four sentences on what the change does and why, then the scope command and
  `N files, +A −D`.
- **Change map.** A file-tree `diff` view of the touched files — added, removed, renamed — each with
  a one-line role. Listed-only files sit here, marked as such.
- **One section per concern.** Group hunks by the behaviour they change, not by file: a change that
  spans a controller, a service and a test is one section. Lead with a **pseudocode diff** —
  `show-me`'s `+`/`-` view of the logic in plain steps — or whichever `show-me` view fits better: a
  call-tree diff, a state-flow diff, a Mermaid sequence, a component tree. Real code is the
  exception, not the content; see *Pseudocode first, code where it counts* below. End the section
  with its full hunks in a collapsed `<details>` block labelled `Source — file:line`.
- **Look closely here.** At most seven entries, each `file:line` and the reason a reviewer should
  slow down: a behaviour change inside what reads as a refactor, a check that was removed, a new
  path no test reaches, an edge the old code handled and the new one does not visibly handle. Each
  is a pointer, worded as one. An empty list is allowed and said plainly — padding it teaches the
  reader to skip it.
- **Not explained.** The listed-only files and why each was not drawn.

#### Pseudocode first, code where it counts

A page of raw hunks is `git diff` with styling: the reviewer still rebuilds the logic in their head,
which is the work the page exists to do for them. So each concern shows the logic as pseudocode,
and real code appears only where the exact text **is** the thing to review:

- a line in the "look closely here" list — the reviewer must judge the code itself there;
- a changed public signature, API contract, schema or migration line, or config key — there the
  exact text is the change;
- a security or data-boundary check — validation, auth, escaping, a transaction boundary — where a
  paraphrase can hide the one character that matters;
- a hunk of about six lines or fewer, where pseudocode would be as long as the code.

At most about **15 lines of visible real code per section**; cut a longer excerpt to the lines that
matter and label it `file:line`. Everything else stays in the collapsed `Source` block, so nothing
is hidden — only out of the way.

**Pseudocode is a summary of the code, never a rewrite of it.** Name the real functions, fields and
types as written; keep every branch, check, early return and side effect the code has, in the same
order. Drop only syntax: types, imports, logging, boilerplate. A pseudocode view that leaves out a
condition is worse than the raw hunk, because the reviewer trusts it and stops reading. Write its
step text in STE, like the rest of the prose.

The page is self-contained: inline CSS and JS, Mermaid and highlight.js from `cdnjs.cloudflare.com`,
light and dark, readable on a phone. **HTML-escape every byte of diff and source text** before it
goes into the page — a diff routinely contains `<`, `&` and `</script>`, and an unescaped one
silently cuts the page off at that hunk.

### 5. Write it outside the repo and open it

```bash
out="${TMPDIR:-/tmp}/diff-explain/$(basename "$(git rev-parse --show-toplevel)")-$(git rev-parse --short HEAD)-$(date +%Y%m%d-%H%M).html"
mkdir -p "$(dirname "$out")"
```

Outside the repo because the page is for the reviewer, not the project: inside it, it shows up in
`git status`, and the next commit can carry it. Then `open "$out"` (macOS) or `xdg-open "$out"`,
and print the path. For a phone or a second screen, mention `/r:page-serve "$out" --lan` — mention
it, do not run it; that skill opens a socket and is typed by the person who wants one.

### 6. Reply

In the terminal, in the same STE: the path, the scope command, and the "look closely here" list as plain
`file:line — reason` lines, so the reply is useful to someone who never opens the page. Nothing
else from the page is restated.

## Record the run

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:diff-explain","outcome":"written|empty|no-show-me|bad-scope",
 "files":0,"explained":0,"flags":0}
STATS_JSON
```

`files` is every file in the diff and `explained` the ones the page drew; the gap is the listed-only
share. `flags` is the length of the "look closely here" list — a run that always reports seven is a
list nobody should trust.
