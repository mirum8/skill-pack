#!/usr/bin/env python3
"""PreToolUse guard: the review/implement pipelines are IMMUTABLE.

Two pipelines are protected, each runnable ONLY from a canonical file:
  * task-review     -> <pack>/skills/task-review/task-review.workflow.js
  * task-run        -> <pack>/skills/task-run/task-run-implement.workflow.js
plus the two flat originals under ~/.claude/skills, which stay installed and
runnable for good (FR-14). Both pipelines carry the same contract — a
per-session fork silently redefines what "reviewed" or "implemented" means — so
both get the same protection. This hook blocks two things:
  1. Workflow invocations that would run a FORK of either — an inline script, or
     a scriptPath pointing at a copy anywhere other than a canonical file.
  2. Write/Edit calls that would CREATE such a fork.

Editing a canonical file itself is allowed (that is deliberate maintenance).

TWO THINGS DIFFER FROM THE COPY THIS REPLACED, and both are why the pack ships
its own (FR-20, ADR-15):

  * The allow-list is built at run time from $CLAUDE_PLUGIN_ROOT, so it follows
    the pack wherever it is installed. The version registered globally in
    ~/.claude/settings.json hard-coded two ~/.claude/skills paths, which meant
    the packed copies could neither run NOR be built — a fresh clone on any
    machine was inert, and nothing in it said why. install.sh removes that
    registration; leaving it in place re-blocks the pack no matter what this
    file permits.

  * The match is narrowed to files that are ACTUALLY workflow scripts — a .js
    or .mjs whose text declares `export const meta` with a guarded name. The old
    version blocked by content alone, so any file quoting a guarded name in its
    declared form was refused: while the pack was being specified it blocked an
    edit to a prose .md in an unrelated repository. A guard that blocks
    documentation of the thing it protects is over-matching, not protecting.

A blocked call exits 2 with an explanation on stderr, which Claude Code feeds
back to the model. Any parse/IO trouble exits 0 (fail-open) so the guard can
never wedge unrelated tool calls.
"""
import sys, json, os, re

GUARDED = ("post-task-review", "run-task-implement")
NAME_DECL = re.compile(r"""name:\s*['"](?:%s)['"]""" % "|".join(GUARDED))
META_DECL = re.compile(r"export\s+const\s+meta\s*=")

PACK = os.environ.get("CLAUDE_PLUGIN_ROOT", "")
CANON = {
    os.path.realpath(os.path.expanduser(p))
    for p in (
        os.path.join(PACK, "skills/task-review/task-review.workflow.js"),
        os.path.join(PACK, "skills/task-run/task-run-implement.workflow.js"),
        # The flat originals. FR-14 keeps them installed and working forever, so
        # an allow-list that dropped them would break the dual-run it promises.
        "~/.claude/skills/post-task-review/post-task-review.workflow.js",
        "~/.claude/skills/run-task/run-task-implement.workflow.js",
    ) if p
}


def read(path):
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    except OSError:
        return ""


def is_workflow(text):
    """A guarded pipeline script, as opposed to prose that mentions one."""
    return bool(META_DECL.search(text) and NAME_DECL.search(text))


def block(where):
    sys.stderr.write(
        "BLOCKED: refusing to create or run a FORKED task-review / task-run "
        f"workflow ({where}).\n"
        "Both pipelines are IMMUTABLE. Run them ONLY from their canonical paths:\n"
        + "".join(f"  {p}\n" for p in sorted(CANON)) +
        "Never copy, edit, or fork a pipeline script to change its behavior. If the "
        "pipeline halts on a RED build, that is CORRECT — STOP and surface the "
        "red build to the user. A pre-existing red `main` is the user's to fix or "
        "quarantine; the review must never edit the pipeline to tolerate failures, "
        "and must never touch tests/code outside the change's scope to force green.\n"
    )
    sys.exit(2)


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool = data.get("tool_name", "")
    ti = data.get("tool_input", {}) or {}

    if tool == "Workflow":
        if (ti.get("name") or "") in GUARDED:
            sys.exit(0)          # the canonical NAMED invocation is always fine
        sp = ti.get("scriptPath")
        if sp:
            rp = os.path.realpath(os.path.expanduser(sp))
            if rp in CANON:
                sys.exit(0)
            if is_workflow(read(rp)):
                block(f"scriptPath={sp}")
            sys.exit(0)          # some other, unrelated workflow
        if is_workflow(ti.get("script") or ""):
            block("inline script")
        sys.exit(0)

    if tool in ("Write", "Edit"):
        fp = ti.get("file_path") or ""
        if not fp or not fp.endswith((".js", ".mjs")):
            sys.exit(0)          # only a script can be a forked pipeline
        rp = os.path.realpath(os.path.expanduser(fp))
        if rp in CANON:
            sys.exit(0)          # maintaining a canonical file is allowed
        new_content = ti.get("content") or ti.get("new_string") or ""
        if is_workflow(new_content) or is_workflow(read(rp)):
            block(f"{tool} {fp}")
        sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
