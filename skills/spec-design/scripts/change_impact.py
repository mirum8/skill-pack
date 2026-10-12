#!/usr/bin/env python3
"""What a requirement change touches in a plan that is partly built, and whether re-planning is safe.

    python3 change_impact.py docs/<topic>/todo.md --notes docs/<topic>/interview-notes.md
    python3 change_impact.py docs/<topic>/todo.md --stories "<story>" ["<story>" ...]
    python3 change_impact.py docs/<topic>/todo.md --notes <notes> --check-plan <draft todo.md>

The change record is the `## Changes` section of interview-notes.md, written by /r:spec-brainstorm
--change. Each entry is `### <yyyy-mm-dd> — <title>` with `- Why:` and `- Stories:` lines; the
Stories line lists `changed "<name>"`, `retired "<name>"` and `added "<name>"`, separated by `;`.
An entry is PENDING until the plan lists its handle on a `<!-- changes: … -->` line.

Default mode prints one JSON report and exits 0: the pending changes, each touched story with the
leaves that implement it and their state (built / partly / unbuilt), the unmerged `phase-*`
branches, and `stops` -- everything that makes re-planning unsafe now. --stories asks the same
question for a list of names, before any record exists.

--check-plan is /r:spec-design's gate on a draft: every built leaf of a changed or retired story
is reworked by a later leaf citing that story, and the draft records each pending change as
applied. Exit 1 on any gap or stop.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_todo import applied_changes, phase_blocks, phase_reworks, ticked_items  # noqa: E402

ENTRY = re.compile(r"^###\s+(.+?)\s*$", re.M)
DATED = re.compile(r"^(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+)$")
EFFECT = re.compile(r'^(changed|retired|added)\s+"([^"]+)"$')


def implements(block):
    m = re.search(r"^\*\*Implements:\*\*\s*(.+)$", block, re.M)
    if not m:
        return set()
    return {" ".join(n.split()) for n in re.split(r"\s*[·;]\s*|\s*,\s(?=[A-Z])", m.group(1)) if n.strip()}


def state(slug, block):
    """built: a marker, or every item ticked. partly: some ticked, some not -- landed work and open
    work in one leaf, which is the one shape a change cannot be planned over."""
    ticks = ticked_items(block)
    open_items = re.findall(r"^\s*-\s*\[ \]", block, re.M)
    if slug or (ticks and not open_items):
        return "built"
    return "partly" if ticks else "unbuilt"


def read_changes(notes_text):
    """(entries, problems). An entry that cannot be read is a problem -- a stop -- and never
    skipped: a skipped entry is a change the plan silently never absorbs."""
    sec = re.search(r"^##\s+Changes\s*$(.*?)(?=^##\s|\Z)", notes_text, re.M | re.S)
    if not sec:
        return [], []
    entries, problems = [], []
    heads = list(ENTRY.finditer(sec.group(1)))
    for i, h in enumerate(heads):
        body = sec.group(1)[h.end():heads[i + 1].start() if i + 1 < len(heads) else None]
        raw = " ".join(h.group(1).split())
        d = DATED.match(raw)
        if not d:
            problems.append(f"change entry {raw!r} has no date: the heading is "
                            f"'### <yyyy-mm-dd> — <title>', and that line is its handle")
            continue
        handle = f"{d.group(1)} — {d.group(2)}"
        if not re.search(r"^\s*-\s*Why:\s*\S", body, re.M):
            problems.append(f"change {handle!r} has no 'Why:' line -- the reason is what a later "
                            f"reader needs to judge the rework")
        st = re.search(r"^\s*-\s*Stories:\s*(.+)$", body, re.M)
        effects = {"changed": [], "retired": [], "added": []}
        if not st:
            problems.append(f"change {handle!r} has no 'Stories:' line")
        else:
            for part in [p.strip() for p in st.group(1).split(";") if p.strip()]:
                m = EFFECT.match(part)
                if m:
                    effects[m.group(1)].append(" ".join(m.group(2).split()))
                else:
                    problems.append(f"change {handle!r}: cannot read {part!r} -- each story is "
                                    f'changed "<name>", retired "<name>" or added "<name>", quoted')
        entries.append({"handle": handle, "stories": effects})
    return entries, problems


def leaves_for(story, blocks):
    return [{"phase": n, "title": t, "state": state(slug, b)}
            for n, t, slug, b in blocks if story in implements(b)]


def unmerged_branches(todo_p, notes):
    """`phase-*` branches not yet in HEAD. One with a built marker in its copy of the plan finished
    and was never landed, so the base plan shows that phase as unbuilt; one without is a halted
    run. Either way the base plan is not the whole truth, so both are stops."""
    def git(*a):
        return subprocess.run(["git", "-C", str(todo_p.parent), *a],
                              capture_output=True, text=True)
    top = git("rev-parse", "--show-toplevel")
    if top.returncode != 0:
        notes.append(f"{todo_p.parent} is not in a git repository -- unmerged phase branches "
                     f"not checked")
        return []
    rel = todo_p.resolve().relative_to(Path(top.stdout.strip()).resolve()).as_posix()
    out = []
    for b in git("branch", "--list", "phase-*", "--format=%(refname:short)").stdout.split():
        if git("merge-base", "--is-ancestor", b, "HEAD").returncode == 0:
            continue
        shown = git("show", f"{b}:{rel}").stdout
        out.append({"branch": b,
                    "state": "finished-not-landed" if f"built: {b}" in shown else "halted"})
    return out


def report(todo_p, notes_p, stories):
    notes, stops = [], []
    todo_text = todo_p.read_text(encoding="utf-8", errors="replace") if todo_p.exists() else ""
    if not todo_p.exists():
        notes.append(f"no plan at {todo_p} -- nothing is built, so nothing can be touched")
    blocks = phase_blocks(todo_text)

    entries, pending = [], []
    if stories is None:
        if not notes_p.exists():
            notes.append(f"no interview-notes.md at {notes_p} -- no change record, nothing pending")
        else:
            entries, problems = read_changes(notes_p.read_text(encoding="utf-8", errors="replace"))
            stops += problems
        applied = set(applied_changes(todo_text))
        pending = [e for e in entries if e["handle"] not in applied]
        touched = [(s, eff) for e in pending for eff in ("changed", "retired", "added")
                   for s in e["stories"][eff]]
    else:
        touched = [(s, "touched") for s in stories]

    impact = []
    for story, eff in touched:
        leaves = [] if eff == "added" else leaves_for(story, blocks)
        impact.append({"story": story, "effect": eff, "leaves": leaves})
        for lf in leaves:
            if lf["state"] == "partly":
                stops.append(f"Phase {lf['phase']} — {lf['title']} is partly built and implements "
                             f"{story!r}: finish it (/r:plan-run --from {lf['phase']}) or abandon "
                             f"it (un-tick its items, revert its code) before the change is planned")

    branches = unmerged_branches(todo_p, notes) if todo_p.exists() else []
    for br in branches:
        how = ("finished but never landed -- land it (/r:plan-run --land)"
               if br["state"] == "finished-not-landed" else
               "a halted run -- finish it or delete the branch")
        stops.append(f"branch {br['branch']} is not merged: {how}. Until then the plan on this "
                     f"branch does not show what is built")

    return {"pending": [e["handle"] for e in pending], "changes": pending, "impact": impact,
            "branches": branches, "stops": stops, "notes": notes}


def check_plan(rep, draft_text):
    gaps = list(rep["stops"])
    absorbed = set(applied_changes(draft_text))
    for h in rep["pending"]:
        if h not in absorbed:
            gaps.append(f"the draft does not record {h!r} as applied -- add it to the "
                        f"'<!-- changes: … -->' line under the plan title")
    draft = phase_blocks(draft_text)
    for item in rep["impact"]:
        if item["effect"] not in ("changed", "retired"):
            continue
        for lf in item["leaves"]:
            if lf["state"] != "built":
                continue
            if not any(lf["phase"] in (phase_reworks(b) or ()) and item["story"] in implements(b)
                       for _, _, _, b in draft):
                verb = "remove" if item["effect"] == "retired" else "rework"
                gaps.append(f"Phase {lf['phase']} — {lf['title']} built {item['story']!r}, which "
                            f"the change {item['effect']}, and no leaf reworks it: add a {verb} "
                            f"leaf with 'Implements: {item['story']}' and 'Reworks: Phase "
                            f"{lf['phase']}'")
    return gaps


def main():
    args = sys.argv[1:]
    if not args or args[0].startswith("--"):
        print("usage: change_impact.py <todo.md> (--notes <interview-notes.md> "
              "[--check-plan <draft.md>] | --stories <name>...)")
        return 2
    todo_p = Path(args[0])
    notes_p = Path(args[args.index("--notes") + 1]) if "--notes" in args \
        else todo_p.parent / "interview-notes.md"
    stories = None
    if "--stories" in args:
        stories = [" ".join(s.split()) for s in args[args.index("--stories") + 1:]
                   if not s.startswith("--")]
    rep = report(todo_p, notes_p, stories)

    if "--check-plan" in args:
        draft_p = Path(args[args.index("--check-plan") + 1])
        if not draft_p.exists():
            print(f"missing: {draft_p}")
            return 1
        gaps = check_plan(rep, draft_p.read_text(encoding="utf-8", errors="replace"))
        if gaps:
            print(f"{len(gaps)} problem(s) in {draft_p}\n")
            for g in gaps:
                print(f"  - {g}")
            return 1
        print(f"clean — {draft_p} absorbs {len(rep['pending'])} pending change(s)")
        return 0

    print(json.dumps(rep, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
