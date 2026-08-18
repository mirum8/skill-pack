# Issue sources — the adapter contract

A backlog is a backlog wherever it is written down. Everything in `/r:issues-fix` from verification
onward works off an item's *text*, its `touches` and its `risk` — none of which know where the item
came from. Exactly four things vary by source, and this file is the whole of that variation.

| | **GitHub** | **File** (markdown / text) | **Inline** |
|---|---|---|---|
| discover | `gh issue list --state open --label <l> --limit <n> --json number,title,url,labels,body,comments` | read the file; take every item not already done | the argument's own lines |
| fetch | `gh issue view <n> --json number,title,url,labels,body,comments` | already in hand from the read | already in hand |
| identity | `#42` | `<file>:<line>` , shown as the item's own text | position in the list |
| handoff `source` | `"#42 #90"` | `"<path> / <locator> \| <locator>"` | the item text verbatim |
| write-back | `gh issue close <n>` | tick `- [ ]` → `- [x]` | **none** — report only |

The row that matters is the last one. A source you cannot write back to cannot record that the work
is done, so the *next* run offers the same item again. That is why the inline shape is the degraded
one and why the report has to say so out loud.

## Resolving which source this run has

Detected in this order, from the argument:

1. **An existing file path** (`issues.md`, `docs/bugs.md`, `@backlog.md` — strip a leading `@` and a
   trailing `/`) → the **file** source.
2. **Issue refs** — `#42`, `42`, an issue URL → the **GitHub** source, with discovery skipped.
3. **No argument** → GitHub when the repo has a GitHub remote *and* `command -v gh >/dev/null &&
   gh auth status` passes. Otherwise look for a list file at the repo root — `issues.md`, `bugs.md`,
   `todo.md`, `backlog.md`, in that order — and **name the file you found before using it**, because
   silently picking one of four files is how a run edits a document nobody meant to hand you.
4. **Multi-line text that reads as a list** → the **inline** source.

Neither a file nor a usable tracker, or two candidates with nothing to choose between them: **ask**.
This is the one place the run stops for input; after the gate it never asks again.

## The file adapter

**What counts as an item.** One item per line for checklist and bullet lines — `- [ ] …`,
`* [ ] …`, `- …`, `1. …` — with any lines indented beneath it taken as that item's body, which is
where acceptance criteria usually live. A `##`/`###` heading followed by prose is also one item,
the heading being its title and the prose its body. A file may mix both; read what is there rather
than forcing one shape onto it.

**What counts as already done, and is therefore never a candidate:** a ticked box (`- [x]`, `- [X]`),
text struck through with `~~…~~`, a line carrying a resolution marker this skill wrote (below), or
anything under a `Done`, `Completed`, `Fixed`, `Shipped` or `Archive` heading. When in doubt, treat
it as open and let verification decide — a still-open item costs one read-only verifier, while a
wrongly-skipped one silently never gets fixed.

**Identity is `<file>:<line>`**, and the line number is only good until the file is edited. So carry
the item's **verbatim text** alongside it and re-locate by text at write-back time; never write back
to a remembered line number.

## Handing a file-backed group to the implement Workflow

`task-run-implement.workflow.js` resolves a source string. For file-backed items that string is:

```
<path> / <locator>              # one item
<path> / <locator> | <locator>  # a group — every item one change fixes together
```

A **locator** is a short, unique prefix of the item's own text — enough to find the line again and
no more. Prefixes rather than whole lines because an item containing a `|` (a markdown table, a
shell pipe) would otherwise split into two locators that match nothing.

```
issues.md / Login 500s on '+' in email | Signup rejects unicode names
```

The workflow reads the file, locates each item, and takes its text and nested bullets as
`criteria[]`, exactly as it merges several GitHub issues' criteria for a grouped fix. **Hand it the
locator, never the item body** — pasting the body in as free text is read as `kind: "text"`, whose
whole contract is that criteria are left empty for the planner to derive. That is the same loss the
"refs, not bodies" rule prevents on the GitHub side.

The workflow never marks an item done. The caller owns write-back, because only the caller knows
whether the review passed and the merge landed.

## Writing back to a file

After the review returns and the branch is confirmed, before staging:

- `- [ ]` → `- [x]`, and append the branch on the line so the file says where the change went:

  ```
  - [x] Login 500s on '+' in email  <!-- fixed: items-login-escaping -->
  ```

- An item with no checkbox gets the same trailing marker and nothing else — never restructure
  someone's document, never move it under a heading it was not under, never reflow the file.
- **Idempotent**: an item already ticked, or already carrying the marker, is left exactly as it is.
- Re-locate by the item's verbatim text. If the text is gone — someone edited the file mid-run —
  **do not guess**: leave the file alone and report the item as fixed-but-unmarked, naming it.
- The tick is staged into the group's single commit, so "fixed" and "marked done" revert together.
  When the file is **outside the repo, or untracked**, there is no commit to fold it into: edit it
  in place and say so in the report, because that is the one case where a `git revert` of the fix
  leaves the list claiming the work is still done.
- `--dry-run` writes nothing, ever.
