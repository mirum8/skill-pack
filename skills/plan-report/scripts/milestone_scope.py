#!/usr/bin/env python3
"""Resolve what a plan's milestones are, which are finished, and what each one actually built.

    python3 milestone_scope.py <todo.md> --list
    python3 milestone_scope.py <todo.md> --complete
    python3 milestone_scope.py <todo.md> --milestone 2 [--repo <dir>]

Always prints one JSON object on stdout, and exits 0 whenever it could answer. A plan with no
"## Milestone N" headings is an ANSWER, not an error: `hasMilestones: false` and an empty list.
Exit 1 is only for a question it could not answer at all -- no such file, no such milestone, no
mode given.

Two callers read this, and they ask different halves of the same question. /r:plan-report asks
"what is milestone N, and where did its code land" before writing a report about it. /r:plan-run
asks "did the phase that just merged finish a milestone" at every phase boundary. One script,
because a report about the wrong phases is a confident wrong answer -- it leaves a document that
reads as authoritative and describes work from somewhere else -- and because two implementations
of "is this milestone done" drift the week one of them is edited.

WHY THE MILESTONE/PHASE/TICK REGEXES ARE COPIED FROM check_todo.py RATHER THAN IMPORTED. They are
fifteen lines, and importing across skills means resolving a sibling skill's directory at run time
from a script that has no ${CLAUDE_PLUGIN_ROOT} substitution. The plan format is a written contract
(spec-design/references/design-contracts.md), so the shape both scripts read is pinned by the
document, not by one of them owning it. A little duplication beats that import.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# Identical to check_todo.py's, deliberately -- a heading one tool locates and the other does not
# is a phase that silently belongs to no milestone. Both spellings of the dash the plan format
# allows, and nothing else: an "##  Milestone 1: Ledger" is not the format and must read as absent
# rather than be quietly accepted here and rejected by the checker.
MILESTONE = re.compile(r"^##\s+Milestone\s+(\d+)\s*[—-]\s*(.+)$", re.M)
PHASE = re.compile(r"^###\s+Phase\s+(\d+)\s*[—-]\s*(.+)$", re.M)
BUILT = re.compile(r"<!--\s*built:\s*([^\s>]+?)\s*-->")
ITEM = re.compile(r"^\s*-\s*\[([ xX])\]\s*(.+)$", re.M)
CONTRACTS = re.compile(r"^Contracts:\s*(.+)$", re.M)


def slugify(text):
    """The milestone's name as a filename segment. Used for the report path, so it must be stable
    across runs: the same name has to produce the same path or a re-run writes a second report
    beside the first instead of updating it."""
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s or "unnamed"


def clean_title(raw):
    """A heading's words, with the built marker and any done tick removed."""
    return " ".join(BUILT.sub("", raw).replace("✅", " ").split())


def field(block, name):
    m = re.search(rf"^\*\*{name}:\*\*\s*(.+)$", block, re.M)
    return " ".join(m.group(1).split()) if m else None


def planned_files(block):
    """Every backticked path on the Files: line. The plan's CLAIM about the footprint -- for a
    committed phase the commit is the measurement, and both are reported so a reader can see the
    gap rather than being handed one number that looks measured."""
    m = re.search(r"^\*\*Files:\*\*\s*((?:.+\n?)+?)(?=^\*\*|^\s*-\s|\Z)", block, re.M)
    if not m:
        return []
    return re.findall(r"`([^`\s]+\.[A-Za-z0-9]{1,6})`", m.group(1))


def parse(text):
    """Every phase in document order, each tagged with the milestone heading above it.

    A phase before the first "## Milestone" heading -- or in a plan with none -- gets milestone
    None. That is the flat plan, and it has to read as "no milestones", never as milestone 0.
    """
    marks = [(m.start(), int(m.group(1)), m.group(2).strip()) for m in MILESTONE.finditer(text)]
    contracts = {}
    for i, (pos, num, _name) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(text)
        head = text[pos:end].split("### ")[0]
        c = CONTRACTS.search(head)
        contracts[num] = " ".join(c.group(1).split()) if c else None

    heads = list(PHASE.finditer(text))
    phases = []
    for i, h in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        block = text[h.start():end]
        owner = None
        for pos, num, _name in marks:
            if pos < h.start():
                owner = num
        marker = BUILT.search(h.group(0))
        items = [{"text": " ".join(t.split()), "ticked": c.lower() == "x"}
                 for c, t in ITEM.findall(block)]
        phases.append({
            "n": int(h.group(1)),
            "title": clean_title(h.group(2)),
            "milestone": owner,
            "slug": marker.group(1) if marker else None,
            "items": items,
            "ticked": sum(1 for i in items if i["ticked"]),
            "total": len(items),
            "implements": field(block, "Implements"),
            "risk": field(block, "Risk"),
            "doneWhen": field(block, "Done when"),
            "plannedFiles": planned_files(block),
        })

    milestones = []
    for _pos, num, name in marks:
        members = [p for p in phases if p["milestone"] == num]
        # A milestone with no phases under it is not complete, it is empty. Calling it complete
        # would fire the report hook on a heading that built nothing.
        done = bool(members) and all(p["total"] > 0 and p["ticked"] == p["total"] for p in members)
        milestones.append({
            "n": num,
            "name": name,
            "slug": slugify(name),
            "contracts": contracts.get(num),
            "phases": [p["n"] for p in members],
            "complete": done,
            "ticked": sum(p["ticked"] for p in members),
            "total": sum(p["total"] for p in members),
        })
    return milestones, phases


def git(repo, *args):
    try:
        r = subprocess.run(("git", "-C", repo) + args, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def landing_commit(repo, plan, slug):
    """The commit that introduced this phase's '<!-- built: <slug> -->' marker into the plan.

    /r:plan-run commits a phase ONCE -- its code, its ticks and this marker together, so that
    "built" and "done" revert together. That single commit is therefore exactly the phase's
    changeset, and searching the plan file's history for the line that added the marker names it
    without needing the branch, which is deleted at merge time.

    Returns (sha, note). A missing sha is always accompanied by a note: an untracked plan, a plan
    outside the repo and a marker nobody ever wrote are three different gaps, and a report that
    prints none of them reads as though it had the code in front of it.
    """
    if not slug:
        return None, "the phase carries no '<!-- built: -->' marker, so nothing names its commit"
    out = git(repo, "log", "--format=%H", "-S", f"built: {slug}", "--", str(plan))
    if out is None:
        return None, f"git could not read the history of {plan}"
    shas = [s for s in out.splitlines() if s]
    if not shas:
        return None, "no commit in this repo adds that marker — the plan may be untracked"
    return shas[-1], None


def changed_files(repo, sha):
    out = git(repo, "show", "--name-only", "--format=", sha)
    return [f for f in (out or "").splitlines() if f]


def report_path(plan, ms):
    return str(Path(plan).parent / "reports" / f"milestone-{ms['n']}-{ms['slug']}.html")


def main():
    argv = sys.argv[1:]
    if not argv or argv[0].startswith("-"):
        print("usage: milestone_scope.py <todo.md> [--list | --complete | --milestone N] "
              "[--repo <dir>]", file=sys.stderr)
        return 1
    plan = Path(argv[0])
    if not plan.is_file():
        print(f"missing: {plan}", file=sys.stderr)
        return 1

    want = None
    if "--milestone" in argv:
        i = argv.index("--milestone")
        if i + 1 >= len(argv) or not argv[i + 1].lstrip("-").isdigit():
            print("--milestone needs a number", file=sys.stderr)
            return 1
        want = int(argv[i + 1])
    elif "--list" not in argv and "--complete" not in argv:
        print("give one of --list, --complete or --milestone N", file=sys.stderr)
        return 1

    repo = argv[argv.index("--repo") + 1] if "--repo" in argv else str(plan.resolve().parent)
    root = git(repo, "rev-parse", "--show-toplevel") if os.path.isdir(repo) else None

    milestones, phases = parse(plan.read_text(encoding="utf-8", errors="replace"))
    for ms in milestones:
        ms["reportPath"] = report_path(plan, ms)
        ms["reportExists"] = os.path.isfile(ms["reportPath"])

    out = {
        "plan": str(plan),
        "hasMilestones": bool(milestones),
        "repoRoot": root,
        "unassignedPhases": [p["n"] for p in phases if p["milestone"] is None],
    }

    if want is not None:
        ms = next((m for m in milestones if m["n"] == want), None)
        if ms is None:
            print(f"no '## Milestone {want}' in {plan}", file=sys.stderr)
            return 1
        members = [p for p in phases if p["milestone"] == want]
        unresolved = 0
        for p in members:
            sha, note = (None, "the plan is not in a git repository") if not root \
                else landing_commit(root, plan.resolve(), p["slug"])
            p["commit"] = sha
            p["commitNote"] = note
            p["changedFiles"] = changed_files(root, sha) if sha else []
            unresolved += 1 if sha is None else 0
        out["milestone"] = ms
        out["phases"] = members
        out["unresolvedCommits"] = unresolved
    elif "--complete" in argv:
        out["milestones"] = [m for m in milestones if m["complete"]]
        out["unreported"] = [m["n"] for m in milestones if m["complete"] and not m["reportExists"]]
    else:
        out["milestones"] = milestones

    json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
