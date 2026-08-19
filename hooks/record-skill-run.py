#!/usr/bin/env python3
"""Record that one of this pack's skills was invoked, into the pack-wide stats store.

Registered on THREE routes, because a skill can be reached three ways and no one of
them sees the others:

  * PostToolUse, matcher Skill     — the model invoked it; the name is in tool_input.skill.
  * PostToolUse, matcher Workflow  — a caller ran one of the two pipelines by its canonical
                                     scriptPath (or its workflow `name`), which is not a
                                     Skill call at all. `/r:issues-fix` drives BOTH pipelines
                                     this way on purpose, and forbids the Skill route, so
                                     without this route the pack's two most expensive skills
                                     are invisible on their primary path: measured
                                     2026-08-19, 4 task-review and 2 task-run results with
                                     zero invoke rows between them, and 82 vs 0 lifetime.
  * UserPromptSubmit               — a person typed `/r:<name>`; there is no tool call at
                                     all, so a PostToolUse hook alone would miss exactly the
                                     invocations that matter most.

The routes are NOT disjoint, and the row records which one it came by so the split stays
visible. Two of them chain: a typed `/r:<name>` also produces a Skill call, and a Skill
call on either pipeline is followed by that skill's markdown dispatching its own Workflow.
Each chain is ONE invocation seen twice, and counting it twice inflates the only number
this store exists to produce — so `is_duplicate` below drops the second sighting. Two rows
by the SAME route are two real invocations and are both kept.

Three rules this hook holds, for the same reason the sink it writes through holds them:

  * ONLY r:-prefixed skills are recorded. The store exists to evaluate THIS pack, and
    every foreign skill on the machine would swamp it.
  * It ALWAYS exits 0 and ALWAYS prints nothing on stdout. On UserPromptSubmit stdout is
    injected into the conversation and a non-zero exit blocks the prompt, so a chatty or
    failing stats hook would corrupt or halt the work it is only supposed to count.
  * The non-matching path does no work at all — no git, no import, no file open.
    UserPromptSubmit fires on every message; only a prompt that starts with /r: is worth
    a subprocess.
"""
import importlib.util
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

# The pack root is this file's grandparent, which is true wherever the pack is installed.
# $CLAUDE_PLUGIN_ROOT is the documented answer but is not guaranteed for every hook event,
# and a stats hook that silently stops recording when an env var is absent is the failure
# this whole store exists to make visible.
SINK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "lib", "record-run.py")

SLASH_RE = re.compile(r"^\s*/(r:[a-z0-9][a-z0-9-]*)\b")

# The two pipelines, by the two handles a Workflow call can name them with: where the script sits
# inside a pack, and the `name:` in its own meta block. Matched by SUFFIX rather than against an
# allow-list built from $CLAUDE_PLUGIN_ROOT, because this hook only has to say WHICH skill ran, not
# whether it was allowed to: guard-workflow.py already refuses every non-canonical copy, so a
# pipeline that got as far as PostToolUse is canonical by construction. Kept here rather than
# imported from the guard — it is four constants, and a shared module between two fail-open hooks
# would couple them for less than it costs.
WORKFLOW_SKILL = {
    "skills/task-review/task-review.workflow.js": "r:task-review",
    "skills/task-run/task-run-implement.workflow.js": "r:task-run",
}
WORKFLOW_NAME_SKILL = {"post-task-review": "r:task-review", "run-task-implement": "r:task-run"}

# How long after an invocation a sighting by a DIFFERENT route is still the same invocation.
# The two chains this has to span are a typed `/r:<name>` reaching the Skill tool (measured at 3
# seconds) and a pipeline's markdown reaching its Workflow dispatch, which is one model turn plus
# whatever prerequisites that markdown checks first. Five minutes covers both with room to spare.
# It is deliberately generous in the direction of UNDER-counting: the cost of a window too long is
# losing a genuine second invocation that arrived by a different route inside five minutes, which
# for these chains is close to unheard of; the cost of one too short is the systematic double-count
# this exists to stop, on every run of the two skills that dominate the pack's cost.
DEDUP_WINDOW_S = 300


def workflow_skill(ti):
    """Which pipeline a Workflow call runs, by scriptPath or by workflow name — else None."""
    sp = ti.get("scriptPath")
    if isinstance(sp, str) and sp:
        norm = os.path.normpath(sp).replace(os.sep, "/")
        for rel, skill in WORKFLOW_SKILL.items():
            if norm.endswith(rel):
                return skill
    return WORKFLOW_NAME_SKILL.get(ti.get("name") or "")


def is_duplicate(db, skill, session_id, via, now):
    """Has this same invocation already been recorded, by one of the other routes?

    Fail-open: any trouble reading the store answers False, so a sighting is recorded rather
    than lost. There is no fallback store — a dropped row is gone — and a duplicate is a
    number that can still be corrected afterwards, while a missing row is not.
    """
    if not session_id or not os.path.exists(db):
        return False
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
        try:
            row = con.execute(
                "SELECT 1 FROM runs WHERE session_id=? AND skill=? AND event='invoke' "
                "AND via IS NOT ? AND ts >= ? LIMIT 1",
                (session_id, skill, via,
                 (now - timedelta(seconds=DEDUP_WINDOW_S)).isoformat(timespec="seconds"))
            ).fetchone()
            return row is not None
        finally:
            con.close()
    except Exception:  # noqa: BLE001 — see the fail-open rule above
        return False


def skill_and_via(payload):
    """(skill, via) for a payload worth recording, else (None, None)."""
    event = payload.get("hook_event_name")
    if event == "PostToolUse":
        tool = payload.get("tool_name")
        ti = payload.get("tool_input") or {}
        if tool == "Workflow":
            return workflow_skill(ti), "workflow"
        if tool != "Skill":
            return None, None
        name = ti.get("skill")
        return (name, "tool") if isinstance(name, str) else (None, None)
    if event == "UserPromptSubmit":
        m = SLASH_RE.match(payload.get("prompt") or "")
        return (m.group(1), "slash") if m else (None, None)
    return None, None


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read())
        if not isinstance(payload, dict):
            return 0
        skill, via = skill_and_via(payload)
        if not skill or not skill.startswith("r:"):
            return 0

        # One-shot import, so the .pyc buys nothing — and writing it drops a __pycache__ into
        # the installed pack on the first prompt of every session.
        sys.dont_write_bytecode = True
        spec = importlib.util.spec_from_file_location("record_run", SINK)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        # The override exists so the behaviour tests can exercise the real hook against a
        # throwaway db instead of the user's own store.
        db = os.path.expanduser(os.environ.get("CLAUDE_SKILL_STATS_DB") or mod.DEFAULT_DB)
        # The session id is what makes the duplicate check possible at all, so read it before
        # deciding, not after. A payload without one is recorded unconditionally — the routes
        # cannot be correlated, and guessing across sessions would be worse than a duplicate.
        session_id = payload.get("session_id")
        now = datetime.now(timezone.utc)
        if is_duplicate(db, skill, session_id, via, now):
            return 0
        rec = {"skill": skill, "event": "invoke", "via": via, "ts": now.isoformat(timespec="seconds")}
        # The hook is handed the session id directly, and it is what joins this invocation to the
        # outcome row the skill writes later — and to the transcript the run left on disk.
        if session_id:
            rec["session_id"] = session_id
        mod.write(mod.normalise(rec), db)
    except Exception as exc:  # noqa: BLE001 — see the exit-0 rule above
        print(f"record-skill-run: not recorded ({exc})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
