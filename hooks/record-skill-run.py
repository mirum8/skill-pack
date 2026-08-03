#!/usr/bin/env python3
"""Record that one of this pack's skills was invoked, into the pack-wide stats store.

Registered on TWO events, because a skill can be reached two ways and the two are
disjoint in the transcript:

  * PostToolUse, matcher Skill  — the model invoked it; the name is in tool_input.skill.
  * UserPromptSubmit            — a person typed `/r:<name>`; there is no tool call at
                                  all, so a PostToolUse hook alone would miss exactly the
                                  invocations that matter most.

Neither event sees the other's path, so no de-duplication is needed; the row records
which route it came by so the split stays visible.

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
import sys

# The pack root is this file's grandparent, which is true wherever the pack is installed.
# $CLAUDE_PLUGIN_ROOT is the documented answer but is not guaranteed for every hook event,
# and a stats hook that silently stops recording when an env var is absent is the failure
# this whole store exists to make visible.
SINK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "lib", "record-run.py")

SLASH_RE = re.compile(r"^\s*/(r:[a-z0-9][a-z0-9-]*)\b")


def skill_and_via(payload):
    """(skill, via) for a payload worth recording, else (None, None)."""
    event = payload.get("hook_event_name")
    if event == "PostToolUse":
        if payload.get("tool_name") != "Skill":
            return None, None
        name = (payload.get("tool_input") or {}).get("skill")
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
        # throwaway file instead of the user's own store.
        path = os.path.expanduser(os.environ.get("CLAUDE_SKILL_STATS_PATH")
                                  or mod.DEFAULT_PATH)
        mod.append({"skill": skill, "event": "invoke", "via": via}, path)
    except Exception as exc:  # noqa: BLE001 — see the exit-0 rule above
        print(f"record-skill-run: not recorded ({exc})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
