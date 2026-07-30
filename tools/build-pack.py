#!/usr/bin/env python3
"""Build the packed skills/ and agents/ trees from the flat originals.

    python3 tools/build-pack.py [--source ~/.claude] [--refresh-drift-baseline]

One shot and idempotent: it wipes skills/ and agents/ and rebuilds them from
~/.claude/skills and ~/.claude/agents, applying the rename map (BR-2), the
bounded reference rewrite (BR-3/BR-5), the path de-absolutisation (FR-19) and
the frontmatter normalisation (FR-7, FR-8, FR-10, FR-16).

It runs under Bash on purpose. The currently-registered global guard hook
refuses any Write/Edit whose content declares a guarded workflow `meta.name`,
so the two packed workflow files can only be produced this way until the pack's
own guard replaces it (FR-20).

Writes build-report.md (every rewritten occurrence, for the R-1 hand review)
and tools/drift-baseline.json (sha256 of each flat original, the R-4 detector).
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import textwrap

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rename_rules as R  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_NAMES = {"__pycache__", ".DS_Store"}

# ---------------------------------------------------------------------------
# FR-8 — run-task's description is 2,174 chars against a 1,536 cap, so 638
# chars including its --light/--standard/--full triggers never reach the router.
# Rewritten to fit, key use case first, triggers and the NOT-for clause kept.
DESCRIPTIONS = {
    "task-run": (
        "Run one unit of work end to end — a GitHub issue (or several related refs that one change "
        "fixes, e.g. `#42 #61`), a single phase of a todo/plan file, or a free-text description — "
        "through plan → plan-review → implement (TDD) → /r:task-review → finish. Finishing opens a "
        "PR (`Closes #N`, one line per issue; a todo phase also gets its checkboxes ticked); "
        "`--skip-pr` merges the branch back into its base instead. Use whenever the user says "
        "\"/r:task-run\", \"run issue #42\", \"implement this GH issue\", \"do issue <n>\", \"work "
        "the next phase\", \"implement Phase 3 of todo.md\", \"run this task: …\", \"build <feature> "
        "end to end\", or hands over an issue URL, a plan phase, or a plain description of work and "
        "wants it actually built, reviewed and shipped rather than just planned. Always runs on a "
        "feature branch and never pauses for approval. Accepts `--light` / `--standard` / `--full` "
        "to force the review depth; otherwise it auto-classifies — light for a change that cannot "
        "alter behavior, standard for ordinary work that can (the default whenever the call is "
        "unclear), full when the approach itself needs reviewing or the change touches auth, money, "
        "persistence, concurrency or security. Every tier builds, tests, runs mandatory static "
        "analysis, and gets a Codex review of the final diff. NOT for: writing a plan only (that's "
        "/r:spec-brainstorm or /r:spec-plan), reviewing an existing diff (that's /r:task-review), "
        "or one-off edits you'd just make directly."
    ),
}

# ---------------------------------------------------------------------------
# FR-22 — the codex plugin is the pack's one OPTIONAL prerequisite (ADR-16).
# Today its absence is exit 3, which every caller is told to treat as a STOP.
# It becomes a reported SKIP instead: the run continues, the report names the
# step as skipped, and no model-written substitute is ever allowed to stand in
# for it. This is a behaviour change, not a repackaging one, so it lands in its
# own commit and both encodings of the pipeline move together (R-11).
SH_PATCHES = {
    "code-adversarial/scripts/run.sh": [
        ('  echo "ERROR: codex companion script not found. The OpenAI Codex plugin is not installed." >&2\n'
         '  echo "Install/repair it, then retry — do NOT fake the review." >&2\n'
         '  exit 3',
         '  # The Codex plugin is OPTIONAL. Absent, this is a SKIP the caller records\n'
         '  # and moves past — not a failure that stops it. Exit 0 so no caller can\n'
         '  # mistake it for a hard error; the CODEX SKIPPED marker on the first line\n'
         '  # is what tells a skip apart from a clean review.\n'
         '  echo "CODEX SKIPPED: the OpenAI Codex plugin is not installed, so NO Codex review ran."\n'
         '  echo "CODEX SKIPPED: add it with  /plugin marketplace add openai-codex  then  /plugin install codex@openai-codex"\n'
         '  echo "CODEX SKIPPED: report this step as skipped. Do NOT fake a review or substitute an LLM imitation." >&2\n'
         '  exit 0'),
    ],
}

FR22_MD = {
    "code-adversarial/SKILL.md": [
        ("- **`3`** — the Codex companion script wasn't found, i.e. the OpenAI Codex plugin isn't "
         "installed. Do **not** fake a review or substitute an LLM imitation — STOP and tell the user "
         "the prerequisite is missing so it can be installed/repaired. (Retrying won't help — a "
         "missing plugin won't fix itself.)",
         "- **`0` with `CODEX SKIPPED:` as the first stdout line** — the OpenAI Codex plugin isn't "
         "installed. This is the pack's one **optional** prerequisite, so it is a **skip, not a "
         "failure**: return a skipped result, let the caller carry on with its other reviewers, and "
         "say plainly in the report that no Codex review ran and how to add the plugin. Retrying "
         "won't help — a missing plugin won't fix itself. **A skipped step must never decay into a "
         "faked one:** do not fake a review or substitute an LLM imitation, and never report the "
         "step as completed. A skipped step reported as a review is worse than no review at all.\n"
         "- **`3`** — no longer returned for a missing plugin; retained only so an older caller "
         "that still maps it keeps treating it as not-run."),
    ],
    "task-review/references/prose-pipeline.md": [
        ("- **`3`** — the Codex CLI/plugin is genuinely missing → **STOP and tell the user it's "
         "blocked** (missing-prerequisite non-negotiable); never fake the review.",
         "- **`0` with `CODEX SKIPPED:` first on stdout** — the Codex plugin is not installed. It is "
         "the one **optional** prerequisite, so this is a **skip, not a block**: print "
         "`post-task-review: codex SKIPPED — the OpenAI Codex plugin is not installed; every other "
         "step ran` and continue with the remaining tracks. Record the step as **skipped** in the "
         "report — never as reviewed, and never fake it. At standard that costs the correctness "
         "reader, so say which tracks actually survived rather than reporting the tier as reviewed."),
    ],
}

FR22_JS = {
    "task-review/task-review.workflow.js": [
        ("     Exit codes: 0 => it ran;\n"
         "     3 (CLI missing) => blocked; 4 / timeout => not-run, drop the \"Review blocked\" text",
         "     Exit codes: 0 with a first stdout line starting \"CODEX SKIPPED:\" => the Codex plugin\n"
         "     is NOT installed: return ran=false, findings [], and coverage starting with the exact\n"
         "     word SKIPPED followed by the reason — never a clean review, never an imitation of one;\n"
         "     0 otherwise => it ran;\n"
         "     3 (CLI missing) => blocked; 4 / timeout => not-run, drop the \"Review blocked\" text"),
        ("for (const [name, r, ran] of [['codex', codex, wantCodexUpfront],\n"
         "                              [hunterTrack, bugs, true],\n"
         "                              ['code-quality', quality, wantQuality]]) {\n"
         "  if (ran && blocked(r)) log(`post-task-review: ${name} track BLOCKED — proceeding with the others (not faked)`)\n"
         "}",
         "for (const [name, r, ran] of [['codex', codex, wantCodexUpfront],\n"
         "                              [hunterTrack, bugs, true],\n"
         "                              ['code-quality', quality, wantQuality]]) {\n"
         "  if (ran && skipped(r)) log(`post-task-review: ${name} SKIPPED — the OpenAI Codex plugin is not ` +\n"
         "    `installed, so no Codex review ran; every other track proceeded. Add it with ` +\n"
         "    `/plugin install codex@openai-codex. The step was NOT faked and is NOT reported as reviewed.`)\n"
         "  else if (ran && blocked(r)) log(`post-task-review: ${name} track BLOCKED — proceeding with the others (not faked)`)\n"
         "}"),
        ("const blocked = (x) => !x || !!(x.blocked || x.ran === false)",
         "// FR-22: an optional prerequisite that is simply absent. Distinct from blocked (a tool that\n"
         "// died) and from clean (a review that ran and found nothing) — collapsing the three is how a\n"
         "// step nobody ran gets reported as a step that passed.\n"
         "const skipped = (x) => !!(x && typeof x.coverage === 'string' && /^SKIPPED\\b/.test(x.coverage))\n"
         "const blocked = (x) => !skipped(x) && (!x || !!(x.blocked || x.ran === false))"),
        ("const tracksBlocked = [['codex', codex, wantCodexUpfront],\n"
         "                       [hunterTrack, bugs, profile !== 'light'],\n"
         "                       ['code-quality', quality, wantQuality]]\n"
         "  .filter(([, r, ran]) => ran && blocked(r)).map(([n]) => n)",
         "const TRACKS = [['codex', codex, wantCodexUpfront],\n"
         "                [hunterTrack, bugs, profile !== 'light'],\n"
         "                ['code-quality', quality, wantQuality]]\n"
         "const tracksBlocked = TRACKS.filter(([, r, ran]) => ran && blocked(r)).map(([n]) => n)\n"
         "// Named separately from tracksBlocked so a caller can tell an absent optional prerequisite\n"
         "// from a tool that failed. Both mean the step did not run; only one is anybody's fault.\n"
         "const tracksSkipped = TRACKS.filter(([, r, ran]) => ran && skipped(r)).map(([n]) => n)"),
        ("  tracksBlocked,\n", "  tracksBlocked,\n  tracksSkipped,\n"),
    ],
}

FR22_TEST = {
    "task-review/tests/control-flow.test.mjs": ["""
test('FR-22: an absent codex plugin is reported skipped, and never as a clean review', async () => {
  const SKIP = { ran: false, findings: [], coverage: 'SKIPPED — codex plugin not installed' }
  const { out, logText } = await run({ profile: 'full', overrides: { codex: SKIP } })
  assert.deepEqual(out.tracksSkipped, ['codex'])
  assert.ok(!out.tracksBlocked.includes('codex'), 'a skip is not a tool failure')
  assert.match(logText, /codex SKIPPED/)
  assert.match(logText, /NOT faked/)
})
"""],
}

# ---------------------------------------------------------------------------
# Files whose name carries the old skill name.
FILE_RENAMES = {
    ("post-task-review", "post-task-review.workflow.js"): "task-review.workflow.js",
    ("run-task", "run-task-implement.workflow.js"): "task-run-implement.workflow.js",
}

# A dangling reference that predates the pack: the agent points at `/find-bug`,
# which has never existed — the skill is find-bugs, packed as code-bugs. FR-9
# allows no reference that resolves to nothing, and the validator caught it.
AGENT_PATCHES = {
    "bug-hunter": [("/find-bug ", "/r:code-bugs "),
                   ("/find-bug skill", "/r:code-bugs skill")],
}

# The guard moves out of the skill and becomes the plugin's own hook (FR-20).
DROP_FILES = {("post-task-review", "scripts/guard-workflow.py")}

# ---------------------------------------------------------------------------
# FR-19 for the two workflow scripts. ${CLAUDE_PLUGIN_ROOT} is substituted in
# skill markdown, not inside a *.workflow.js the Workflow tool executes, so the
# pack root arrives as an argument instead and these become JS interpolations.
# Every entry must apply at least once or the build fails — a silent no-op here
# would leave a $HOME path in the shipped pack.
JS_PATCHES = {
    "task-review/task-review.workflow.js": [
        ("//     node --test ~/.claude/skills/post-task-review/tests/control-flow.test.mjs",
         "//     node --test <pack>/skills/task-review/tests/control-flow.test.mjs"),
        ('//   Workflow({ scriptPath: "~/.claude/skills/post-task-review/post-task-review.workflow.js" })',
         '//   Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/task-review/task-review.workflow.js",\n'
         "//              args: { packRoot: \"${CLAUDE_PLUGIN_ROOT}\" } })"),
        ("""const REFS = '"$HOME"/.claude/skills/find-bugs/references'""",
         "const REFS = `${PACK}/skills/code-bugs/references`"),
        ('"$HOME/.claude/skills/adversarial-review/scripts/run.sh"',
         '"${PACK}/skills/code-adversarial/scripts/run.sh"'),
        ('"$HOME/.claude/skills/post-task-review/scripts/worktree-deploy.sh"',
         '"${PACK}/skills/task-review/scripts/worktree-deploy.sh"'),
        ('"$HOME/.claude/skills/post-task-review/scripts/record-run.py"',
         '"${PACK}/skills/task-review/scripts/record-run.py"'),
    ],
    "task-run/task-run-implement.workflow.js": [
        ("//     node --test ~/.claude/skills/run-task/tests/control-flow.test.mjs",
         "//     node --test <pack>/skills/task-run/tests/control-flow.test.mjs"),
        ('//   Workflow({ scriptPath: "~/.claude/skills/run-task/run-task-implement.workflow.js",',
         '//   Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/task-run/task-run-implement.workflow.js",\n'
         "//              args: { packRoot: \"${CLAUDE_PLUGIN_ROOT}\", ..."),
        ('"$HOME/.claude/skills/post-task-review/scripts/record-run.py"',
         '"${PACK}/skills/task-review/scripts/record-run.py"'),
    ],
}

# Inserted right after the meta block so PACK is in scope everywhere below it.
PACK_PREAMBLE = """
// The pack root arrives from the caller, because ${CLAUDE_PLUGIN_ROOT} is
// substituted in skill markdown but not inside a workflow script the Workflow
// tool executes (FR-19). The SKILL.md invocation always passes it.
// The fallback is the placeholder itself, never an empty string: `args` may
// legitimately arrive as a bare source string, and an empty root would turn
// every sibling path into a plausible-looking /skills/... that silently points
// nowhere. Left as the placeholder it either expands or fails loudly.
const PACK = (args && typeof args === 'object' && args.packRoot) || '${CLAUDE_PLUGIN_ROOT}'
"""

# The tests resolve their target from their own location instead of $HOME, and
# supply the packRoot every run now needs. Injecting it at the single call site
# keeps the ~30 per-test `args` literals untouched, and the spread is guarded so
# the two tests that pass `args` as a bare string still exercise that path.
TEST_PATCHES = {
    "task-review/tests/control-flow.test.mjs": [
        ("//   run:  node --test ~/.claude/skills/post-task-review/tests/control-flow.test.mjs",
         "//   run:  node --test <pack>/skills/task-review/tests/control-flow.test.mjs"),
        ("const WF = path.join(os.homedir(), '.claude/skills/post-task-review/post-task-review.workflow.js')",
         "const WF = path.join(import.meta.dirname, '..', 'task-review.workflow.js')"),
        ("  const out = await makeWf()(args, agent, parallel, phase, log)",
         "  const wfArgs = args && typeof args === 'object' "
         "? { packRoot: '/pack', ...args } : args\n"
         "  const out = await makeWf()(wfArgs, agent, parallel, phase, log)"),
        # No assertion is patched here on purpose. All three that name an old
        # skill match log or prompt text that stays bare in the workflow —
        # `local-scan BLOCKED`, like the `post-task-review:` log prefixes
        # around it, is prose, and ADR-12 keeps prose out of the rename diff.
        # protect_assertions() is what stops the rewrite touching them.
    ],
    "task-run/tests/control-flow.test.mjs": [
        ("//   run:  node --test ~/.claude/skills/run-task/tests/control-flow.test.mjs",
         "//   run:  node --test <pack>/skills/task-run/tests/control-flow.test.mjs"),
        ("const WF = path.join(os.homedir(), '.claude/skills/run-task/run-task-implement.workflow.js')",
         "const WF = path.join(import.meta.dirname, '..', 'task-run-implement.workflow.js')"),
        ("  const out = await makeWf()(args, agent, parallel, phase, log)",
         "  const wfArgs = args && typeof args === 'object' "
         "? { packRoot: '/pack', ...args } : args\n"
         "  const out = await makeWf()(wfArgs, agent, parallel, phase, log)"),
    ],
}

# The generated /test-app skill is project-local, so ${CLAUDE_PLUGIN_ROOT} would
# not resolve inside it. The generator substitutes the real path instead, the
# same way it already substitutes {{CREDS_PATH}} and {{E2E_DIR}}.
TEMPLATE_PATCHES = {
    "test-app-create/assets/test-app.SKILL.md.template": [
        ("$HOME/.claude/skills/post-task-review/scripts/worktree-deploy.sh", "{{WTD_PATH}}"),
    ],
}

# Plain markdown patches: the guard moved to the plugin root (FR-20), and one
# placeholder row has to be documented for the generator.
PR = "${CLAUDE_PLUGIN_ROOT}"
MD_PATCHES = {
    "task-review/SKILL.md": [
        ("(`scripts/guard-workflow.py`)", "(the pack's `hooks/guard-workflow.py`)"),
        ('Workflow({ scriptPath: "$HOME/.claude/skills/post-task-review/'
         'post-task-review.workflow.js" })',
         f'Workflow({{ scriptPath: "{PR}/skills/task-review/task-review.workflow.js",\n'
         f'           args: {{ packRoot: "{PR}" }} }})'),
    ],
    "task-run/SKILL.md": [
        ('  scriptPath: "$HOME/.claude/skills/run-task/run-task-implement.workflow.js",\n'
         '  args: { source:',
         f'  scriptPath: "{PR}/skills/task-run/task-run-implement.workflow.js",\n'
         f'  args: {{ packRoot: "{PR}",\n'
         '          source:'),
    ],
    "gh-issues-fix/SKILL.md": [
        ('Workflow({ scriptPath: "$HOME/.claude/skills/run-task/'
         'run-task-implement.workflow.js",\n              args: { source:',
         f'Workflow({{ scriptPath: "{PR}/skills/task-run/task-run-implement.workflow.js",\n'
         f'              args: {{ packRoot: "{PR}", source:'),
        ('Workflow({ scriptPath: "$HOME/.claude/skills/post-task-review/'
         'post-task-review.workflow.js",\n              args: { deferCommit:',
         f'Workflow({{ scriptPath: "{PR}/skills/task-review/task-review.workflow.js",\n'
         f'              args: {{ packRoot: "{PR}", deferCommit:'),
    ],
    "task-review/references/prose-pipeline.md": [
        ("(`scripts/guard-workflow.py`)", "(the pack's `hooks/guard-workflow.py`)"),
    ],
    "test-app-create/SKILL.md": [
        ("| `{{CREDS_PATH}}` |",
         "| `{{WTD_PATH}}` | Always `${CLAUDE_PLUGIN_ROOT}/skills/task-review/scripts/"
         "worktree-deploy.sh` — the generated skill is project-local, so the real path is "
         "substituted here rather than left as a variable |\n| `{{CREDS_PATH}}` |"),
    ],
}


# ---------------------------------------------------------------------------
def frontmatter_split(text):
    """-> (before, fm_lines, after) or None when there is no frontmatter."""
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 3)
    if end == -1:
        return None
    return "---\n", text[4:end + 1].splitlines(), text[end + 5:]


def read_scalar(lines, i):
    """Read the YAML scalar starting at lines[i] ('key: value' or a block).
    -> (value_text, next_index)."""
    head = lines[i]
    key, _, rest = head.partition(":")
    rest = rest.strip()
    j = i + 1
    if rest in (">", ">-", ">+", "|", "|-", "|+"):
        body = []
        while j < len(lines) and (not lines[j].strip() or lines[j][:1] in " \t"):
            body.append(lines[j].strip())
            j += 1
        while body and not body[-1]:
            body.pop()
        return " ".join(b for b in body if b), j
    # plain scalar, possibly continued on more-indented lines
    body = [rest]
    while j < len(lines) and lines[j][:1] in " \t" and lines[j].strip():
        body.append(lines[j].strip())
        j += 1
    return " ".join(b for b in body if b), j


def emit_block(key, value):
    wrapped = textwrap.wrap(value, width=96, break_long_words=False, break_on_hyphens=False)
    return [f"{key}: >-"] + [f"  {line}" for line in wrapped]


def normalise_frontmatter(text, new_name):
    """FR-7 (block scalars), FR-10 (drop version:), FR-16 (no-auto-fire),
    plus the pack convention of letting the directory carry the name."""
    parts = frontmatter_split(text)
    if not parts:
        raise SystemExit(f"{new_name}: SKILL.md has no frontmatter")
    _, lines, body = parts

    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        key = line.split(":", 1)[0].strip() if ":" in line and line[:1] not in " \t#" else None
        if key in ("version", "name"):          # FR-10, and the dir is the name
            _, i = read_scalar(lines, i)
            continue
        if key in ("description", "when_to_use"):
            value, i = read_scalar(lines, i)
            if key == "description" and new_name in DESCRIPTIONS:
                value = DESCRIPTIONS[new_name]
            out += emit_block(key, value)
            continue
        if key == "disable-model-invocation":   # re-added below, canonically
            _, i = read_scalar(lines, i)
            continue
        out.append(line)
        i += 1

    if new_name in R.NO_AUTO_FIRE:              # FR-16
        out.append("disable-model-invocation: true")

    return "---\n" + "\n".join(out) + "\n---\n" + body


# ---------------------------------------------------------------------------
def apply_exact(text, patches, label, report):
    for old, new in patches:
        if old == new:
            continue
        n = text.count(old)
        if n == 0:
            raise SystemExit(f"{label}: patch no longer matches, source has drifted:\n  {old[:120]}")
        text = text.replace(old, new)
        report.append((label, f"{n}x exact patch", old.splitlines()[0][:100]))
    return text


# A JS regex literal opens with `/`, which BR-3's slash-command pattern cannot
# tell apart from a command. `assert.match(p, /code-quality did NOT run/)` was
# rewritten to `/r:code-quality did NOT run/` while the workflow text it matches
# stayed bare — a test that still ran, and no longer checked anything real.
ASSERT_LINE = re.compile(r"^.*assert\.(?:match|doesNotMatch)\(.*$", re.M)


def protect_assertions(text):
    saved = []

    def hide(m):
        saved.append(m.group(0))
        return f"\x00ASSERT{len(saved) - 1}\x00"

    return ASSERT_LINE.sub(hide, text), saved


def restore_assertions(text, saved):
    for i, line in enumerate(saved):
        text = text.replace(f"\x00ASSERT{i}\x00", line)
    return text


def is_vendored(rel):
    return any(v in rel for v in R.VENDORED)


def build(source_root, report):
    skills_src = os.path.join(source_root, "skills")
    agents_src = os.path.join(source_root, "agents")

    missing = [o for o in R.RENAME if not os.path.isdir(os.path.join(skills_src, o))]
    if missing:
        raise SystemExit("source skills missing: " + ", ".join(missing))

    for d in ("skills", "agents"):
        shutil.rmtree(os.path.join(REPO, d), ignore_errors=True)
    # Everything below is regenerated from the flat originals. Anything the
    # pack owns and the originals do not — the thirteen new eval suites, most
    # obviously — is destroyed by that, which is why main() refuses to run
    # without --force once skills/ exists.

    prose_before, prose_after = {}, {}
    self_refs = cross_refs = 0

    for old, new in sorted(R.RENAME.items()):
        src, dst = os.path.join(skills_src, old), os.path.join(REPO, "skills", new)
        for root, dirs, files in os.walk(src):
            dirs[:] = [d for d in dirs if d not in SKIP_NAMES]
            for f in sorted(files):
                if f in SKIP_NAMES or f.endswith(".pyc"):
                    continue
                sp = os.path.join(root, f)
                rel = os.path.relpath(sp, src)
                if (old, rel) in DROP_FILES:
                    continue
                rel = os.path.join(os.path.dirname(rel), FILE_RENAMES.get((old, rel), f))
                dp = os.path.join(dst, rel)
                os.makedirs(os.path.dirname(dp), exist_ok=True)

                if is_vendored(rel) or not f.endswith(R.TEXT_SUFFIXES):
                    shutil.copy2(sp, dp)
                    continue

                text = open(sp, encoding="utf-8").read()
                for o in R.RENAME:
                    prose_before[o] = prose_before.get(o, 0) + R.count_prose(text, o)

                # Order matters. Absolute paths go first, while they still look
                # like the source: `.claude/skills/post-task-review/...` would
                # otherwise be mistaken for a `/name` slash-command reference.
                key = f"{new}/{rel}"
                for table in (JS_PATCHES, TEST_PATCHES, TEMPLATE_PATCHES, MD_PATCHES,
                              SH_PATCHES, FR22_MD, FR22_JS):
                    if key in table:
                        text = apply_exact(text, table[key], key, report)
                if key in JS_PATCHES:
                    text = insert_preamble(text, key)
                if key in FR22_TEST:
                    text += FR22_TEST[key][0]
                # Generic FR-19 substitution covers plain skill markdown; the
                # workflow scripts, the tests and the project-local template
                # each need a different mechanism and were patched above.
                if f.endswith((".md", ".txt")) and key not in TEMPLATE_PATCHES:
                    text, s, c = R.rewrite_paths(text, old)
                    self_refs, cross_refs = self_refs + s, cross_refs + c
                    if s or c:
                        report.append((f"{new}/{rel}", f"{s} self / {c} cross", "FR-19 path variables"))

                saved = []
                if f.endswith(".mjs"):
                    text, saved = protect_assertions(text)
                text, hits = R.rewrite_refs(text)
                text = restore_assertions(text, saved)
                for o, n in hits.items():
                    report.append((f"{new}/{rel}", f"{n}x reference", f"{o} -> {R.qualified(o)}"))
                if f == "SKILL.md":
                    text = normalise_frontmatter(text, new)

                open(dp, "w", encoding="utf-8").write(text)
                for o in R.RENAME:
                    prose_after[o] = prose_after.get(o, 0) + R.count_prose(text, o)

    os.makedirs(os.path.join(REPO, "agents"), exist_ok=True)
    for a in R.AGENTS:
        sp = os.path.join(agents_src, a + ".md")
        if not os.path.isfile(sp):
            raise SystemExit(f"agent missing: {sp}")
        # An agent has no skill of its own, so every path it carries is a
        # cross-reference. ${CLAUDE_PLUGIN_ROOT} resolves in agent content too.
        text, _, c = R.rewrite_paths(open(sp, encoding="utf-8").read(), owner_old=None)
        cross_refs += c
        if c:
            report.append((f"agents/{a}.md", f"0 self / {c} cross", "FR-19 path variables"))
        if a in AGENT_PATCHES:
            text = apply_exact(text, AGENT_PATCHES[a], f"agents/{a}.md", report)
        text, hits = R.rewrite_refs(text)
        for o, n in hits.items():
            report.append((f"agents/{a}.md", f"{n}x reference", f"{o} -> {R.qualified(o)}"))
        fixed = normalise_agent_frontmatter(text, a)
        if fixed != text:
            report.append((f"agents/{a}.md", "frontmatter", "quoted an unparsable description"))
            text = fixed
        open(os.path.join(REPO, "agents", a + ".md"), "w", encoding="utf-8").write(text)

    return prose_before, prose_after, self_refs, cross_refs


def normalise_agent_frontmatter(text, name):
    """Agents get the same correctness fix as skills (FR-7 in spirit).

    maven-build-runner and gradle-build-runner carry an unquoted description
    containing `user: "run maven clean install"`, which is not valid YAML. The
    consequence is not cosmetic: `claude plugin validate` reports that such an
    agent "loads with empty metadata (all frontmatter fields silently dropped)",
    so its name, tools and model are lost and FR-5's promise that the agent
    resolves rather than failing as unknown does not hold. The other six agents
    already double-quote their descriptions; this makes those two match.
    """
    if not text.startswith("---\n"):
        return text
    end = text.find("\n---\n", 3)
    if end == -1:
        return text
    fm, body = text[4:end + 1], text[end + 5:]
    try:
        yaml.safe_load(fm)
        return text
    except yaml.YAMLError:
        pass
    out = []
    for line in fm.splitlines():
        if line.startswith("description:") and not line[12:].lstrip().startswith(('"', "'", ">", "|")):
            value = line[12:].strip().replace("\\", "\\\\").replace('"', '\\"')
            out.append(f'description: "{value}"')
        else:
            out.append(line)
    fixed = "---\n" + "\n".join(out) + "\n---\n" + body
    yaml.safe_load(fixed[4:fixed.find("\n---\n", 3) + 1])   # must parse now, or fail loudly
    return fixed


def insert_preamble(text, label):
    m = re.search(r"^export const meta = \{.*?^\}$", text, re.S | re.M)
    if not m:
        raise SystemExit(f"{label}: no meta block to anchor the packRoot preamble to")
    return text[:m.end()] + "\n" + PACK_PREAMBLE + text[m.end():]


def drift_baseline(source_root):
    out = {}
    for old in sorted(R.RENAME):
        base = os.path.join(source_root, "skills", old)
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if d not in SKIP_NAMES]
            for f in sorted(files):
                if f in SKIP_NAMES or f.endswith(".pyc"):
                    continue
                p = os.path.join(root, f)
                h = hashlib.sha256(open(p, "rb").read()).hexdigest()
                out[os.path.relpath(p, os.path.join(source_root, "skills"))] = h
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=os.path.expanduser("~/.claude"))
    ap.add_argument("--refresh-drift-baseline", action="store_true")
    ap.add_argument("--force", action="store_true",
                    help="rebuild over an existing skills/, discarding anything the pack "
                         "added on top of the originals (the eval suites, above all)")
    args = ap.parse_args()

    if os.path.isdir(os.path.join(REPO, "skills")) and not args.force:
        raise SystemExit(
            "skills/ already exists. This is a one-shot migration: after the first build the\n"
            "pack is the source, and rebuilding would discard every file it owns that the flat\n"
            "originals do not — starting with the thirteen eval suites. Pass --force if that is\n"
            "genuinely what you want.")

    report = []
    before, after, self_refs, cross_refs = build(args.source, report)

    # The gate that cannot be passed by accident: no BR-3 reference to an old
    # name may survive anywhere in the built pack (FR-4, BR-5). Counting prose
    # instead would compare incomparable things — a path segment and a
    # `r:`-prefixed rewrite both move the number without anything being wrong —
    # so the prose figures below are *reported* for the hand review (R-1)
    # rather than asserted.
    leftovers = []
    for root, dirs, files in os.walk(os.path.join(REPO, "skills")):
        dirs[:] = [d for d in dirs if d not in SKIP_NAMES]
        for f in files:
            p = os.path.join(root, f)
            rel = os.path.relpath(p, REPO)
            if is_vendored(rel) or not f.endswith(R.TEXT_SUFFIXES):
                continue
            text = open(p, encoding="utf-8", errors="ignore").read()
            if f.endswith(".mjs"):
                text, _ = protect_assertions(text)   # regex literals, not references
            for o in R.RENAME:
                for pat, _ in R.ref_patterns(o):
                    for m in pat.finditer(text):
                        leftovers.append(f"{rel}: {m.group(0)!r}")
    if leftovers:
        raise SystemExit("unrewritten references remain:\n  " + "\n  ".join(leftovers[:20]))

    baseline_path = os.path.join(REPO, "tools", "drift-baseline.json")
    if args.refresh_drift_baseline or not os.path.exists(baseline_path):
        json.dump(drift_baseline(args.source), open(baseline_path, "w"), indent=1, sort_keys=True)

    refs = sum(int(k.split("x")[0]) for _, k, _ in report if k.endswith("reference"))
    lines = [
        "# build report", "",
        f"- references rewritten (BR-3): **{refs}**",
        f"- FR-19 path variables: **{self_refs} self**, **{cross_refs} cross**",
        "- unrewritten references left in the pack: **0** (hard gate)", "",
        "## Non-reference occurrences left alone (R-1)", "",
        "Read this table. Every number here is an old skill name that still appears in the pack as",
        "ordinary text. `commit` and `refactor` are English verbs far more often than they are skill",
        "names, so a rewrite that moved these would be corruption, not progress.", "",
        "| old name | in source | in pack |", "|---|---|---|",
    ]
    lines += [f"| `{o}` | {before.get(o, 0)} | {after.get(o, 0)} |" for o in sorted(R.RENAME)]
    lines += ["", "## Every rewrite applied", "", "| file | what | detail |", "|---|---|---|"]
    lines += [f"| `{a}` | {b} | `{c}` |" for a, b, c in report]
    open(os.path.join(REPO, "build-report.md"), "w").write("\n".join(lines) + "\n")

    print(f"built 15 skills, {len(R.AGENTS)} agents")
    print(f"  {refs} references rewritten, 0 left unrewritten")
    print(f"  FR-19: {self_refs} self, {cross_refs} cross")
    print("  read build-report.md before committing (R-1)")


if __name__ == "__main__":
    main()
