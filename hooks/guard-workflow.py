#!/usr/bin/env python3
"""PreToolUse guard: the review/implement pipelines are IMMUTABLE.

Two pipelines are protected, each runnable ONLY from a canonical file:
  * task-review     -> <pack>/skills/task-review/task-review.workflow.js
  * task-run        -> <pack>/skills/task-run/task-run-implement.workflow.js
Both pipelines carry the same contract — a per-session fork silently redefines
what "reviewed" or "implemented" means — so both get the same protection. This
hook blocks two things:
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

# Where a pipeline script sits INSIDE a pack, relative to the pack root.
PACK_RELATIVE = (
    "skills/task-review/task-review.workflow.js",
    "skills/task-run/task-run-implement.workflow.js",
)

PACK = os.environ.get("CLAUDE_PLUGIN_ROOT", "")
# The allow-list used to also carry the two flat originals under ~/.claude/skills,
# for FR-14's permanent dual-run. Those were deleted once the pack became the only
# copy (validate.py now reports "R-4 closed"), so the entries named files that
# cannot exist. Nothing is relaxed by dropping them: a path that isn't a canonical
# pipeline is judged by its CONTENT, exactly as any other script is.
CANON = {
    os.path.realpath(os.path.expanduser(os.path.join(PACK, rel)))
    for rel in (PACK_RELATIVE if PACK else ())
}


def in_a_copy_of_this_pack(rp):
    """Is `rp` the canonical pipeline file of SOME copy of this pack?

    $CLAUDE_PLUGIN_ROOT names the copy Claude Code loaded — the INSTALLED one.
    The source checkout it was published from holds the same two files at the
    same relative paths, and install.sh's own header calls that checkout the
    place to edit them ("edit here, then re-run this script to publish"). Judging
    only by the installed root therefore blocked maintenance at the one location
    where maintenance happens, and said "forked pipeline" while doing it.

    A copy is identified STRUCTURALLY, by the manifest two directories above the
    script, never by where it happens to live. That keeps the property the guard
    exists for: a stray `cp` of a pipeline into some other directory has no
    manifest above it and is still refused, and so is a directory carrying
    somebody else's plugin.
    """
    for rel in PACK_RELATIVE:
        suffix = os.sep + rel.replace("/", os.sep)
        if not rp.endswith(suffix):
            continue
        manifest = os.path.join(rp[: -len(suffix)], ".claude-plugin", "plugin.json")
        try:
            with open(manifest, encoding="utf-8") as f:
                return json.load(f).get("name") == "r"
        except (OSError, ValueError):
            return False
    return False


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
        if rp in CANON or in_a_copy_of_this_pack(rp):
            sys.exit(0)          # maintaining a canonical file is allowed
        # Deliberately NOT extended to the Workflow branch above: editing the
        # source is maintenance, but RUNNING an uninstalled copy is the thing a
        # fork does, and the two do not have to be relaxed together.
        new_content = ti.get("content") or ti.get("new_string") or ""
        if is_workflow(new_content) or is_workflow(read(rp)):
            block(f"{tool} {fp}")
        sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
