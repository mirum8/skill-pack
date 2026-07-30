---
description: >-
  Use when the user wants to patch the project's CLAUDE.md with the user's common reusable rules.
  Triggers on "/r:claudemd-patch", "patch claude.md", "patch the claude md", "sync claude.md with
  my standard rules", "add my common rules to claude.md", "bring claude.md up to date with my
  guidelines". Inserts (or replaces existing similar versions of) the Test-Writing Policy block
  and the Code Conventions rules, and *removes* any post-task auto-run block it finds (the
  `/r:task-review` skill is no longer wired to run automatically — it runs only via `/r:task-run`
  or when the user asks). It also installs a PreToolUse `Write|Edit` hook into the project's
  `.claude/settings.json` that injects a write-tests reminder whenever a JVM test file is edited —
  the deterministic enforcement that advisory CLAUDE.md text alone can't guarantee. The user keeps
  these blocks consistent across many projects, so even when they say something vague like "fix up
  claude.md" or "make claude.md match my usual setup", prefer this skill. NOT for: general
  CLAUDE.md editing, /init, project bootstrap, adding project-specific guidance, or commit-message
  rules.
effort: low
---

# claudemd-patch

Insert the user's canonical reusable rule blocks into a project's `CLAUDE.md`. Idempotent: if a block (or a similar older version) is already present, replace it so the latest wording becomes canonical. Maintains two `CLAUDE.md` blocks — **Test-Writing Policy** and **Code Conventions** — plus one **enforcement hook** in `.claude/settings.json`, and **strips** any post-task auto-run block it finds (see below). The Code Conventions block is *merged* bullet-by-bullet rather than replaced wholesale, so project-specific conventions in that section survive.

**Why a hook, not just text.** CLAUDE.md text (and a skill's "MUST be consulted automatically" description) is *advisory* — the harness only runs the `r:tests-write` skill when the model chooses to, so it gets silently skipped at the end of a long turn. A hook is the only mechanism the harness executes *deterministically*. So this skill installs a `PreToolUse` hook on `Write|Edit` that fires a write-tests reminder every time a test file is touched, making the Test-Writing Policy enforceable rather than hopeful. The hook still can't literally force the `/r:tests-write` Skill tool to run, but it injects the reminder into context on every test-file edit, which is the closest deterministic enforcement available.

The full post-task review routine lives in the `/r:task-review` skill (at `${CLAUDE_PLUGIN_ROOT}/skills/task-review/`) and is **not** run automatically: it fires only inside `/r:task-run` (autonomous mode, which calls it as a mandatory step) or when the user explicitly invokes it. So `r:claudemd-patch` installs **no** post-task pointer into `CLAUDE.md` — a static pointer there would make the review run on every regular session, which the user does not want. Instead, whenever it patches a project, the skill **deletes** any existing post-task auto-run pointer or inline review checklist it finds (detection hints in step 4). This skill installs no workflow files or subagents.

The user keeps these rules in sync across many projects. Treat invocation as authority to make the project's `CLAUDE.md` match the canonical text below — without preserving older phrasings of the same rules.

## Workflow

1. **Locate `CLAUDE.md`.**
   - Run `git rev-parse --show-toplevel` to find the repo root. If not in a git repo, use the current working directory.
   - Target file: `<root>/CLAUDE.md`.
   - If it does not exist, create a stub:
     ```markdown
     # CLAUDE.md

     This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
     ```

2. **Apply the Test-Writing Policy section (replace-or-append):**

   The Test-Writing Policy is a full section. (The post-task block is no longer installed — it is *removed* if present; see step 4.)

   a. **Find an existing canonical match** — read CLAUDE.md and search for a heading matching the block's primary heading regex (table below). If found:
      - Extract the region from that heading through the next sibling heading of equal or higher level (or end of file).
      - Replace that region with the freshly-rendered template (no prompt — this is the same block, just updated).

   b. **If no canonical heading was found, look for similar-but-different content** — older or differently-named sections covering the same ground. Indicators:
      - Heading text from the "similar headings" column.
      - Test guidance phrased as "write the test FIRST", "regression guard", "reproduce the bug".

      If found: show the user the matched region (a few lines of context) and ask **"Replace this with the canonical block?"** before doing anything.

   c. **Otherwise (no match at all)**: append the rendered block at the end of `CLAUDE.md`, under a `## Development Guidelines` heading. If that heading doesn't exist yet, create it first.

3. **For the Code Conventions block, merge bullet-by-bullet (do NOT wholesale-replace):** this section usually carries project-specific conventions that must survive.

   a. **Find the section** — search for a heading matching the Code Conventions primary heading regex (table below).
   b. **If found**: for each canonical bullet, check whether an equivalent already exists (match on the rule's intent, e.g. a bullet already mandating `@Builder`). Append any canonical bullet that is missing; leave every existing bullet — project-specific or otherwise — untouched. If a stale older phrasing of a canonical bullet exists, update just that bullet in place.
   c. **If not found**: append a `## Code Conventions` section at the end of `CLAUDE.md` containing the canonical bullets.

4. **Remove any post-task auto-run block and any `/verify-diff` leftovers — both must be stripped so the review never fires automatically in regular sessions.** The review routine lives in the `/r:task-review` skill and is invoked only by `/r:task-run` or on explicit request. Whenever you patch a project:
   - **Delete any post-task auto-run section.** Search for a heading matching the Post-Task primary heading regex (table below), or similar-but-different content: a short pointer telling anyone to "run `/r:task-review`"; or an inline checklist mentioning the review tooling (`r:code-bugs`, `/codex:adversarial-review`, `/sonar`, `/security-review`, `gradle-build-runner`, `maven-build-runner`) or a chained "run these checks in order" routine; or a reference to the removed `/verify-diff`. Extract the region from that heading through the next sibling heading of equal or higher level (or end of file) and **remove it entirely** (no replacement). If the matched section also carries genuinely project-specific notes (e.g. a custom build command worth keeping), show the user the region and confirm before deleting rather than silently dropping it.
   - Earlier versions used a `/verify-diff` dynamic workflow. If `<root>/.claude/workflows/verify-diff.js` exists and carries this skill's header (`meta.name` is `verify-diff`), delete it. Likewise delete `<root>/.claude/agents/verify-diff-agent.md` if its frontmatter `name` is `verify-diff-agent`. If a different owner holds either path, leave it and tell the user.
   - After this step, no `CLAUDE.md` text should tell anyone to "run `/r:task-review`" or "run `/verify-diff`".

5. **Install the write-tests enforcement hook into the project's `.claude/settings.json`** (the committed, team-shared settings — same scope as the committed `CLAUDE.md` you just patched, so the text rule and its enforcement ship together). This is the deterministic counterpart to the advisory Test-Writing Policy text. See "Enforcement hook" below for the exact procedure. It is idempotent (keyed off a marker comment), merges into any existing `hooks`/`permissions`/other settings, and never clobbers unrelated hooks. After writing, validate with `jq -e`. **If `.claude/settings.json` does not already exist, create it** — and if the project gitignores it, tell the user the hook won't be shared until they track it (don't un-ignore it yourself).

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

Insert these exactly. Do not paraphrase. There are no substitutions. (There is no post-task template — that block is removed if found, never written; see step 4.)

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

A `PreToolUse` hook on `Write|Edit` whose **command** self-filters to JVM test files (`*Test.java`, `*Tests.java`, `*Test.kt`, `*Tests.kt`, anything under `src/test/`) and, only for those, prints a `hookSpecificOutput.additionalContext` reminder pointing at the `r:tests-write` skill. On every non-test file the command is a no-op that **exits 0** (a non-zero exit would surface a spurious hook error on every single Write/Edit). The matcher is only `Write|Edit` — the file-path filtering happens inside the command, because `matcher` matches tool names, not paths.

Install it idempotently with `jq` (this handles all JSON-escaping of the command string, and the marker comment `# claudemd-patch:write-tests` lets a re-run replace the prior copy instead of stacking duplicates):

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
- **It's a fast local shell pipe — `jq` + `grep` — not an extra LLM call.** It runs in milliseconds and only emits text into the *next* model turn's context when a test file is actually touched. It does not spawn a model, so it cannot "overload" anything; the only cost is a one-line reminder added to context on test-file edits.
- The `additionalContext` is intentionally short (one sentence). Keep it terse so the per-edit context cost stays negligible.
- If a project is not JVM, the `Tests?\.(java|kt)$|/src/test/` filter simply never matches and the hook stays silent — harmless. Adjust the regex only if the user asks.
- The settings watcher only picks up `.claude/settings.json` changes mid-session if a settings file existed there at session start. If you created it fresh, tell the user to open `/hooks` once (or restart) to load it.

## Examples

### Example 1 — append into a stub file

**Before** `CLAUDE.md`:
```markdown
# CLAUDE.md
Project notes for the billing service.
```

**After** invoking `/r:claudemd-patch`, `CLAUDE.md` gains the Test-Writing Policy section (no post-task block is added — the `/r:task-review` skill runs only via `/r:task-run` or explicit request):
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

The skill detects `r:code-bugs` + a security review in a checklist-style section and **removes the whole section** — the review is no longer wired to run automatically. If that section carried a genuinely project-specific note worth keeping, it asks **"Remove this 'Quality Gates' section?"** first; otherwise it deletes it outright.

### Example 3 — already canonical, no change

If the blocks already match the canonical text verbatim (e.g., re-running `/r:claudemd-patch` on a freshly-patched file), the skill reports "no changes needed" for those blocks and exits.

## Notes

- This skill **never** runs git commands beyond the read-only `git rev-parse --show-toplevel`. Reviewing and committing is the user's call.
- Blocks are inserted as `###` (h3) headings. If they end up nested under a non-`##` parent, that's fine — leave the user to reorganize headings if they want.
- The skill maintains two `CLAUDE.md` blocks **and one `.claude/settings.json` hook** (no workflow files, no subagents, no separate script files — the hook command is inline in settings.json). Extending the `CLAUDE.md` side is a matter of adding a row to the "Block markers" table and a new "Canonical block templates" subsection; the hook is a single idempotent `jq` merge.
- The Test-Writing Policy is a full-section replacement; the Code Conventions block is a bullet-level merge so project-specific conventions are preserved; any post-task auto-run block is deleted, never installed.
- **The post-task review routine lives in the `/r:task-review` skill, not in `CLAUDE.md`, and it is not run automatically.** It fires only inside `/r:task-run` (which invokes it as a mandatory step) or when the user explicitly asks. `r:claudemd-patch` installs nothing for it and removes any leftover pointer/checklist that would make it auto-run in regular sessions. The routine itself (real reviewers `/r:code-bugs` + `r:code-adversarial` + `/security-review` → fix → build → `/r:code-scan` → rebuild, Maven/Gradle auto-detected, no faking, STOP on missing prerequisites) is documented and maintained in `${CLAUDE_PLUGIN_ROOT}/skills/task-review/SKILL.md`.
