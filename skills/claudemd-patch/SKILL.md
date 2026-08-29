---
description: >-
  Patch the project's CLAUDE.md with the user's common reusable rules: insert (or replace older
  versions of) the Test-Writing Policy block and the Code Conventions rules, *remove* any post-task
  auto-run block (`/r:task-review` runs only via `/r:task-run` or when the user asks), and install
  a PreToolUse `Write|Edit` hook into the project's `.claude/settings.json` that injects a
  write-tests reminder whenever a JVM test file is edited — the deterministic enforcement advisory
  CLAUDE.md text can't guarantee. Use on "/r:claudemd-patch", "patch claude.md", "patch the claude
  md", "sync claude.md with my standard rules", "add my common rules to claude.md", "bring
  claude.md up to date with my guidelines". The user keeps these blocks consistent across many
  projects, so prefer this skill even for vague asks like "fix up claude.md" or "make claude.md
  match my usual setup". NOT for: general CLAUDE.md editing, /init, project bootstrap, adding
  project-specific guidance, or commit-message rules.
effort: low
---

# claudemd-patch

Insert the user's canonical reusable rule blocks into a project's `CLAUDE.md`. Idempotent: a block already present — or a similar older version of it — is replaced so the latest wording becomes canonical. The skill maintains two `CLAUDE.md` blocks — **Test-Writing Policy** and **Code Conventions** — plus one **enforcement hook** in `.claude/settings.json`, and **strips** any post-task auto-run block it finds. Code Conventions is *merged* bullet-by-bullet, never replaced wholesale, so project-specific conventions survive.

**Why a hook, not just text.** CLAUDE.md text (and a skill's "MUST be consulted automatically" description) is *advisory* — the harness runs `r:tests-write` only when the model chooses to, so it gets silently skipped at the end of a long turn. A hook is the only mechanism the harness executes *deterministically*: a `PreToolUse` hook on `Write|Edit` fires a write-tests reminder whenever a test file is touched. It cannot force the `/r:tests-write` Skill tool to run, but a reminder in context on every test-file edit is the closest deterministic enforcement available.

**No post-task pointer is installed.** The review routine lives in `/r:task-review` (`${CLAUDE_PLUGIN_ROOT}/skills/task-review/`) and is **not** automatic: it fires only inside `/r:task-run`, which calls it as a mandatory step, or when the user explicitly invokes it. A static pointer in `CLAUDE.md` would make the review run on every regular session, so the skill **deletes** any post-task auto-run pointer or inline review checklist it finds (detection hints in step 4). It installs no workflow files or subagents.

The user keeps these rules in sync across many projects. Treat invocation as authority to make `CLAUDE.md` match the canonical text below, without preserving older phrasings.

## Workflow

1. **Locate `CLAUDE.md`.**
   - Run `git rev-parse --show-toplevel` to find the repo root. If not in a git repo, use the current working directory.
   - Target file: `<root>/CLAUDE.md`.
   - If it does not exist, create a stub:
     ```markdown
     # CLAUDE.md

     This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
     ```

2. **Apply the Test-Writing Policy section (replace-or-append).** It is a full section.

   a. **Find an existing canonical match** — search CLAUDE.md for a heading matching the block's primary heading regex (table below). If found:
      - Extract the region from that heading through the next sibling heading of equal or higher level (or end of file).
      - Replace that region with the freshly-rendered template (no prompt — same block, updated).

   b. **If no canonical heading was found, look for similar-but-different content** — older or differently-named sections covering the same ground:
      - Heading text from the "similar headings" column.
      - Test guidance phrased as "write the test FIRST", "regression guard", "reproduce the bug".

      If found: show the user the matched region (a few lines of context) and ask **"Replace this with the canonical block?"** before doing anything.

   c. **Otherwise (no match at all)**: append the rendered block at the end of `CLAUDE.md`, under a `## Development Guidelines` heading — create it first if missing.

3. **For the Code Conventions block, merge bullet-by-bullet (do NOT wholesale-replace):** this section carries project-specific conventions that must survive.

   a. **Find the section** — search for a heading matching the Code Conventions primary heading regex (table below).
   b. **If found**: for each canonical bullet, check whether an equivalent already exists (match on intent, e.g. a bullet already mandating `@Builder`). Append any canonical bullet that is missing; leave every existing bullet — project-specific or otherwise — untouched. If a stale older phrasing of a canonical bullet exists, update just that bullet in place.
   c. **If not found**: append a `## Code Conventions` section at the end of `CLAUDE.md` containing the canonical bullets.

4. **Remove any post-task auto-run block and any `/verify-diff` leftovers — both must be stripped so the review never fires automatically in regular sessions.** Whenever you patch a project:
   - **Delete any post-task auto-run section.** Search for a heading matching the Post-Task primary heading regex (table below), or similar-but-different content: a short pointer telling anyone to "run `/r:task-review`"; an inline checklist mentioning the review tooling (`r:code-bugs`, `/codex:adversarial-review`, `/sonar`, `/security-review`, `gradle-build-runner`, `maven-build-runner`) or a chained "run these checks in order" routine; or a reference to `/verify-diff`. Extract the region from that heading through the next sibling heading of equal or higher level (or end of file) and **remove it entirely** (no replacement). If the section also carries genuinely project-specific notes (e.g. a custom build command), show the user the region and confirm before deleting.
   - **Delete the `/verify-diff` files.** Delete `<root>/.claude/workflows/verify-diff.js` if its `meta.name` is `verify-diff`, and `<root>/.claude/agents/verify-diff-agent.md` if its frontmatter `name` is `verify-diff-agent`. If a different owner holds either path, leave it and tell the user.
   - After this step, no `CLAUDE.md` text should tell anyone to "run `/r:task-review`" or "run `/verify-diff`".

5. **Install the write-tests enforcement hook into the project's `.claude/settings.json`** — the committed, team-shared settings, same scope as `CLAUDE.md`, so the text rule and its enforcement ship together. Procedure under "Enforcement hook" below: idempotent (keyed off a marker comment), merges into existing `hooks`/`permissions`/other settings, never clobbers unrelated hooks. After writing, validate with `jq -e`. **If `.claude/settings.json` does not exist, create it** — and if the project gitignores it, tell the user the hook won't be shared until they track it (don't un-ignore it yourself).

6. **Report what changed.** Print a short summary like:
   ```
   ✓ Test-Writing Policy: replaced existing section (was at line 142)
   ✓ Post-Task Completion: removed obsolete auto-run block (was at line 168) — none found if absent
   ✓ Code Conventions: merged 1 missing bullet
   ✓ write-tests hook: installed PreToolUse Write|Edit hook in .claude/settings.json
   ✓ Removed obsolete /verify-diff (verify-diff.js + verify-diff-agent.md) — only if it was present
   ```
   Do not run `git add` / `git commit` — the user reviews with `git diff` first.

## Block markers

| Block | Primary heading regex | Similar-heading hints (ask before replacing) |
|-------|------------------------|----------------------------------------------|
| Test-Writing Policy (replace-or-append) | `^#{2,4}\s+(Always Write Tests\|Test(ing)?\s+(Policy\|Approach(es)?\|Rules\|Strategy))\b` | "Testing", "Test guidance", "Test discipline", or any bullet list with "write the test FIRST" / "regression guard" / "reproduce the bug" |
| Post-Task auto-run block (DELETE if found, never install) | `^#{2,4}\s+(After Task Completion\|Post[-\s]Task\|Definition of Done\|Quality Gates\|Completion Checklist\|After You Finish)\b` | any text telling someone to "run `/r:task-review`", any list that mentions `r:code-bugs` AND `/security-review` together, chains the checks (`r:code-bugs`, `/codex:adversarial-review`, `/sonar`, `/security-review`) inline, or invokes the removed `/verify-diff` |
| Code Conventions (merge bullets, don't replace) | `^#{2,4}\s+Code Conventions?\b` | "Coding Guidelines", "Coding Standards", "Code Style", or any bullet mentioning Lombok `@Builder` |

## Canonical block templates

Insert these exactly. Do not paraphrase; there are no substitutions. There is no post-task template — that block is removed if found, never written (step 4).

### Test-Writing Policy

```markdown
### Always Write Tests
Every code change ships with tests. Use the `r:tests-write` skill.

- **New code (features, new methods, new endpoints)**: write tests covering the happy path and at least the obvious edge cases. Unit tests for pure logic, integration tests for anything crossing a boundary (DB, HTTP, AI, Telegram).
- **Bug fix**: write the test FIRST. It must reproduce the bug — fail before the fix, pass after. A test that already passes does not prove the bug exists or that your change fixed it.
- **Refactor / behavior-preserving change**: write the test FIRST as a regression guard. It locks in current correct behavior and passes both before and after.
- **Intentional behavior change**: write the test FIRST encoding the NEW expected behavior — fails against the old code, passes against the new.
- Skip only for non-behavioral edits (formatting, renames, comments, config-only tweaks with no logic).
```

### Code Conventions

Merge these bullets into the project's Code Conventions section (don't replace the whole section — see step 3).

```markdown
- **Add the Lombok `@Builder` annotation to data classes with more than 3 fields** — keeps construction readable and avoids long positional argument lists.
```

### Enforcement hook (`.claude/settings.json`)

A `PreToolUse` hook on `Write|Edit` whose **command** self-filters to JVM test files (`*Test.java`, `*Tests.java`, `*Test.kt`, `*Tests.kt`, anything under `src/test/`) and, only for those, prints a `hookSpecificOutput.additionalContext` reminder pointing at the `r:tests-write` skill. On every other file the command is a no-op that **exits 0** (a non-zero exit would surface a spurious hook error on every Write/Edit). The matcher is only `Write|Edit` — path filtering happens inside the command, because `matcher` matches tool names, not paths.

Install it idempotently with `jq` (it handles the JSON-escaping of the command string, and the marker comment `# claudemd-patch:write-tests` lets a re-run replace the prior copy instead of stacking duplicates):

```bash
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
mkdir -p "$ROOT/.claude"
SETTINGS="$ROOT/.claude/settings.json"
[ -f "$SETTINGS" ] || printf '{}\n' > "$SETTINGS"

HOOK_CMD=$(cat <<'EOF'
f=$(jq -r '(.tool_input.file_path // .tool_input.path) // empty'); printf '%s' "$f" | grep -qE 'Tests?\.(java|kt)$|/src/test/' && printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"About to edit test code — follow the write-tests skill: Given/When/Then, AssertJ, JUnit 5, self-contained tests, hard-coded expected values, KISS > DRY. For a bug fix, write the failing test FIRST (fail before the fix, pass after)."}}' || true
EOF
)
HOOK_CMD="$HOOK_CMD # claudemd-patch:write-tests"

tmp=$(mktemp)
jq --arg cmd "$HOOK_CMD" '
  .hooks //= {} | .hooks.PreToolUse //= [] |
  .hooks.PreToolUse |= map(select((.hooks // []) | any((.command? // "") | contains("claudemd-patch:write-tests")) | not)) |
  .hooks.PreToolUse += [{ "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": $cmd }] }]
' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"

jq -e '.hooks.PreToolUse[] | select(.matcher=="Write|Edit") | .hooks[].command | select(contains("claudemd-patch:write-tests"))' "$SETTINGS" >/dev/null \
  && echo "✓ write-tests hook installed" || echo "✗ hook install failed — inspect $SETTINGS"
```

Notes on this hook:
- **It's a fast local shell pipe — `jq` + `grep` — not an extra LLM call.** It runs in milliseconds, spawns no model, and emits text into the *next* turn's context only when a test file is touched.
- The `additionalContext` is intentionally one sentence; keep it terse so the per-edit context cost stays negligible.
- On a non-JVM project the `Tests?\.(java|kt)$|/src/test/` filter never matches and the hook stays silent — harmless. Adjust the regex only if the user asks.
- The settings watcher picks up `.claude/settings.json` changes mid-session only if a settings file existed there at session start. If you created it fresh, tell the user to open `/hooks` once (or restart) to load it.

## Examples

### Example 1 — append into a stub file

**Before** `CLAUDE.md`:
```markdown
# CLAUDE.md
Project notes for the billing service.
```

**After** invoking `/r:claudemd-patch`, `CLAUDE.md` gains the Test-Writing Policy section (no post-task block is added):
```markdown
# CLAUDE.md
Project notes for the billing service.

## Development Guidelines

### Always Write Tests
Every code change ships with tests. Use the `r:tests-write` skill.
...
```

### Example 2 — delete an older inline checklist

**Before** (relevant slice):
```markdown
## Quality Gates
- run /r:code-bugs, then build
- maybe a security review if you remember
- run sonar at the end
```

The skill detects `r:code-bugs` + a security review in a checklist-style section and **removes the whole section** — the review is not wired to run automatically. If the section carried a genuinely project-specific note, it asks **"Remove this 'Quality Gates' section?"** first; otherwise it deletes it outright.

### Example 3 — already canonical, no change

If the blocks already match the canonical text verbatim (e.g. re-running `/r:claudemd-patch` on a freshly-patched file), the skill reports "no changes needed" for those blocks and exits.

## Record the run

One line into the pack-wide store — counts only, never a rule's text or the project's own content.

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:claudemd-patch","blocksInserted":0,"blocksReplaced":0,"blocksAlreadyCurrent":0,
 "autoRunBlocksRemoved":0,"createdFile":false,"wrote":false,"blockedReason":null}
STATS_JSON
```

**`blocksAlreadyCurrent` says whether this skill is still needed on a project.** A project where
a run replaces and inserts nothing does not need patching again; a run that keeps replacing the
same block means something else keeps reverting it.

**`autoRunBlocksRemoved` must not quietly go to zero.** Removing a post-task auto-run block is a
correctness fix, not tidying: `/r:task-review` is not wired to run automatically, and a block that
says it is makes every session pay for a review nobody asked for.

The script always exits `0` — a lost row is a lost row, never a failed run, and it must never change
what was written. Never retry it.

## Non-negotiables

- This skill **never** runs git commands beyond the read-only `git rev-parse --show-toplevel`. Reviewing and committing is the user's call.
- Blocks are inserted as `###` (h3) headings. Nested under a non-`##` parent is fine — leave the user to reorganize headings if they want.
- The skill maintains two `CLAUDE.md` blocks **and one `.claude/settings.json` hook** — no workflow files, subagents or separate script files; the hook command is inline in settings.json. Extending the `CLAUDE.md` side means a row in the "Block markers" table and a new "Canonical block templates" subsection; the hook is a single idempotent `jq` merge.
- The Test-Writing Policy is a full-section replacement; Code Conventions is a bullet-level merge; any post-task auto-run block is deleted, never installed. **The review routine itself lives in `/r:task-review`, not in `CLAUDE.md`** — its pipeline is documented and maintained in `${CLAUDE_PLUGIN_ROOT}/skills/task-review/SKILL.md`.
