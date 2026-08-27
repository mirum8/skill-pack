#!/usr/bin/env python3
"""Resolve the conflicts in an in-progress merge that are PROVABLY additive, and refuse the rest.

    python3 merge-resolve.py [--repo .] [--plan docs/x/todo.md] [--dry-run]

Run it while `git merge` has left the tree conflicted. It stages what it resolves and leaves
everything else unmerged for a person, then reports both. Exit 0 when every conflict was resolved,
2 when at least one was handed over, 1 on usage trouble or no merge in progress.

## The rule

Each conflict is re-materialised with its merge BASE visible (`--conflict=zdiff3`) and asked one
question:

    does every base line still exist on BOTH sides, ignoring whitespace?

Yes means neither side deleted or rewrote anything -- both only added -- so keeping both sides is
correct rather than a guess. No means a side changed shared code, and no union can be trusted.

**The base is the whole trick.** Without it the two sides are just two lists, and "they added a
field" is indistinguishable from "they deleted a field". Measured on one real four-file conflict:
6 of 7 hunks resolve, and the single refusal is the hunk where both sides rewrote one line --
resolving that one by picking a side drops a callback, COMPILES CLEAN, and fails only in the tests.

**Whitespace matters as much as the base.** A formatter realigns a whole block when a longer name
arrives, so every line changes and a strict comparison misreads a pure addition as a rewrite. That
one detail is what moves two of those six hunks from refused to resolved.

## What it will not do

- **Never pick a side.** `-X ours` / `-X theirs` is the failure this exists to prevent, not a
  fallback for when the rule refuses.
- **Never touch a generated artefact** -- a golden file, anything under a `testdata/` segment or
  `.claude/`. Two runs' captures have no merge; whichever wrote last is the answer, and a union of
  two screenshots is nonsense.
- **Never decide it is finished.** The caller formats, builds and runs the FULL test suite before
  accepting, and discards the whole merge on red. The residual risk this cannot see is ordering:
  two sides adding statements at one point produce a union in some order, and only for declarations
  is that order certainly irrelevant. The test run is what covers it, which is why it is not
  optional.

The plan file is the one exception with a written answer: when two phases' ticks collide the
resolution is always BOTH sides' ticks, because each branch ticked what it genuinely built.
"""
import re
import subprocess
import sys
from pathlib import Path

HUNK = re.compile(
    r"^<<<<<<< [^\n]*\n(.*?)\n?^\|\|\|\|\|\|\| [^\n]*\n(.*?)\n?^=======\n(.*?)\n?^>>>>>>> [^\n]*\n",
    re.S | re.M)
TICK = re.compile(r"^(\s*[-*]\s*\[)([ xX])(\]\s*)(.*)$")
BUILT = re.compile(r"\s*<!--\s*built:.*?-->")


def norm(s):
    return re.sub(r"\s+", " ", s.strip())


def git(repo, *args, check=False):
    p = subprocess.run(("git", "-C", str(repo)) + args, capture_output=True, text=True)
    if check and p.returncode != 0:
        return None
    return p.stdout if p.returncode == 0 else None


def generated(path):
    """The same shapes the plan's collision check ignores, for the same reason."""
    parts = Path(path).parts
    return path.endswith(".golden") or "testdata" in parts or ".claude" in parts


def union(ours, base, theirs):
    """Both sides' lines, once each, with `ours` as the spine.

    `ours` already carries every base line (the caller proved it), so starting there keeps the file
    closest to what is on the branch being merged into and appends only what the other side added.
    """
    base_set = {norm(l) for l in base.splitlines() if norm(l)}
    ours_lines = ours.splitlines()
    ours_set = {norm(l) for l in ours_lines}
    adds = [l for l in theirs.splitlines()
            if norm(l) and norm(l) not in base_set and norm(l) not in ours_set]
    return "\n".join(ours_lines + adds) + "\n"


def additive(ours, base, theirs):
    """Does every base line survive on both sides? Whitespace-insensitive, and empty base is yes."""
    b = [norm(l) for l in base.splitlines() if norm(l)]
    o = {norm(l) for l in ours.splitlines()}
    t = {norm(l) for l in theirs.splitlines()}
    return all(l in o for l in b) and all(l in t for l in b)


def merge_ticks(ours, base, theirs):
    """Both sides' ticks. A box either branch ticked is ticked, and neither tick makes the other
    untrue -- each branch ticked what it genuinely built. Taking one side wholesale un-ticks
    finished work, and the next run offers that phase again."""
    ticked = set()
    for side in (ours, theirs):
        for line in side.splitlines():
            m = TICK.match(line)
            if m and m.group(2).lower() == "x":
                ticked.add(norm(m.group(4)))
    # A `built:` marker either side put on a heading rides along: it is what --land maps a branch
    # back to a phase by, and a heading that lost it is a phase --land will decline to merge.
    marked = {}
    for side in (ours, theirs):
        for line in side.splitlines():
            if BUILT.search(line):
                marked[norm(BUILT.sub("", line))] = line

    out = []
    for line in (base or ours).splitlines():
        m = TICK.match(line)
        if m and norm(m.group(4)) in ticked:
            line = f"{m.group(1)}x{m.group(3)}{m.group(4)}"
        out.append(marked.get(norm(line), line))
    return "\n".join(out) + "\n"


def resolve_file(repo, path, plan_name, dry):
    """-> (verdict, resolved-text-or-None, hunks). verdict is 'resolved' or 'refused: <reason>'.

    Re-materialising the conflict with its base is itself a write, so --dry-run puts the original
    bytes back: a mode that reports without deciding must leave the tree byte-identical, or the
    preview has already done half the thing it was asked not to do. A REFUSED file keeps the base
    section, because the person who now has to resolve it needs exactly that.
    """
    if generated(path):
        return "refused: generated artefact", None, 0
    f = Path(repo) / path
    before = f.read_bytes()
    if git(repo, "checkout", "--merge", "--conflict=zdiff3", "--", path) is None:
        return "refused: cannot re-materialise with its base", None, 0
    text = f.read_text(encoding="utf-8", errors="replace")
    if dry:
        f.write_bytes(before)

    hunks = HUNK.findall(text)
    if not hunks:
        return "refused: no readable conflict", None, 0

    # The plan file is the written exception: its conflicts are ticks, which are never a rewrite of
    # shared code even though they read as one -- both sides edited the same box.
    is_plan = Path(path).name == plan_name
    if not is_plan and not all(additive(o, b, t) for o, b, t in hunks):
        return "refused: a side rewrote shared code", None, len(hunks)

    fn = merge_ticks if is_plan else union
    return "resolved", HUNK.sub(lambda m: fn(m.group(1), m.group(2), m.group(3)), text), len(hunks)


def main(argv):
    args = argv[1:]
    repo = Path(args[args.index("--repo") + 1] if "--repo" in args else ".")
    plan = args[args.index("--plan") + 1] if "--plan" in args else ""
    dry = "--dry-run" in args
    plan_name = Path(plan).name if plan else "\0"

    if not (repo / ".git" / "MERGE_HEAD").exists() and git(repo, "rev-parse", "-q", "--verify",
                                                           "MERGE_HEAD") is None:
        print("merge-resolve: no merge in progress — nothing to resolve", file=sys.stderr)
        return 1

    out = git(repo, "diff", "--name-only", "--diff-filter=U")
    paths = [p for p in (out or "").splitlines() if p]
    if not paths:
        print("merge-resolve: the merge has no unmerged paths")
        return 0

    resolved, refused = [], []
    for path in paths:
        verdict, text, hunks = resolve_file(repo, path, plan_name, dry)
        if verdict == "resolved":
            if not dry:
                (repo / path).write_text(text, encoding="utf-8")
                git(repo, "add", "--", path)
            resolved.append((path, hunks))
        else:
            refused.append((path, verdict.split(": ", 1)[1], hunks))

    for path, n in resolved:
        print(f"  resolved  {path}  ({n} hunk{'s' if n != 1 else ''}, kept both sides)")
    for path, why, n in refused:
        print(f"  REFUSED   {path}  ({n} hunk{'s' if n != 1 else ''}) — {why}")

    if refused:
        print(f"\n{len(resolved)} file(s) resolved, {len(refused)} left for a person. "
              f"Resolve those by hand — never with -X ours/theirs, which is the failure this "
              f"refusal exists to prevent.")
        return 2
    print(f"\nall {len(resolved)} conflicted file(s) resolved. "
          f"Format, build and run the FULL test suite before accepting this merge; "
          f"discard the whole merge on red.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
