#!/usr/bin/env python3
"""Warn when a slice the plan calls safe is one history calls a collision.

    python3 footprint-warn.py <plan> --slice 23,24,34 [--base main] [--repo .]

`check_todo.py --slice` compares the plan's `Files:` lines. Those lines are written before any code
exists, so they name the files a feature CARRIES -- the new ones a planner can foresee -- and never
the ones it must touch to be wired in. One phase declared three files and changed eleven; the eight
it did not declare were the hub files every other phase in that package also reaches. The checker
cleared that slice honestly and the wave would not merge.

This asks the question the plan cannot: for the packages this slice lands in, WHAT HAS EVERY PHASE
BEFORE IT ACTUALLY TOUCHED? That is a fact in git rather than a prediction, which is the whole
reason this runs unasked -- a guess would need a model, a budget and a human to believe it.

It never edits the plan and never decides anything. Exit 0 when the slice looks clean or when there
is not enough history to judge, 2 when it found a risk, 1 on usage or git trouble. The caller
decides what a 2 means: /r:plan-run warns and continues on a serial run, and refuses under --cmux,
where being wrong costs the whole wave rather than one merge.
"""
import re
import subprocess
import sys

# Loading the checker below would otherwise drop a __pycache__ into whichever tree the pack is
# installed in. A read-only preflight that leaves a directory behind is not read-only, and here it
# also makes the installed payload stop matching the repo it was copied from.
sys.dont_write_bytecode = True
from collections import Counter, defaultdict
from importlib import util as importlib_util
from pathlib import Path

# ONE parser for the plan, shared with the checker whose answer this second-guesses. A private copy
# here could drift from it, and two parsers disagreeing about which files a phase declares is a
# worse failure than either being wrong -- the warning would be about a phase the checker never saw.
_CHECK = Path(__file__).resolve().parents[2] / "spec-design" / "scripts" / "check_todo.py"

# How many of a package's commits a file must appear in before it is worth naming. Below this it is
# a file some phase happened to touch; at or above it, it is where that package is wired together.
HUB_SHARE = 0.25
HUB_MIN = 3


def load_checker():
    spec = importlib_util.spec_from_file_location("check_todo", _CHECK)
    if spec is None or spec.loader is None:
        return None
    mod = importlib_util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception:
        return None
    return mod


def git(repo, *args):
    p = subprocess.run(("git", "-C", str(repo)) + args,
                       capture_output=True, text=True)
    return p.stdout if p.returncode == 0 else None


def history(repo, base):
    """file -> how many commits on base touched it. The measurement the plan cannot make.

    Every commit counts, not only a phase's merge: a phase lands as one commit under --no-merge and
    as a merge under the serial loop, and a plan half-built each way would otherwise report two
    different histories for the same repo.
    """
    out = git(repo, "log", "--format=%H", "--name-only", base)
    if out is None:
        return None
    counts, seen = Counter(), set()
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        if re.fullmatch(r"[0-9a-f]{40}", line):
            seen = set()          # a new commit; a file it touches twice still counts once
            continue
        if line not in seen:
            seen.add(line)
            counts[line] += 1
    return counts


def package_of(path):
    parent = str(Path(path).parent)
    return "" if parent == "." else parent


def hubs(counts, package, comparable):
    """The files this package is wired together in, most-touched first."""
    own = {f: n for f, n in counts.items() if package_of(f) == package and comparable(f)}
    if not own:
        return []
    ceiling = max(own.values())
    floor = max(HUB_MIN, ceiling * HUB_SHARE)
    return sorted((f for f in own if own[f] >= floor), key=lambda f: (-own[f], f))


def main(argv):
    args = argv[1:]
    if "--slice" not in args or not args or args[0].startswith("--"):
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 1
    plan = Path(args[0])
    want = {int(n) for n in re.findall(r"\d+", args[args.index("--slice") + 1])}
    base = args[args.index("--base") + 1] if "--base" in args else "HEAD"
    repo = Path(args[args.index("--repo") + 1] if "--repo" in args else ".")

    if not plan.exists():
        print(f"footprint-warn: no such plan: {plan}", file=sys.stderr)
        return 1

    check = load_checker()
    if check is None:
        print(f"footprint-warn: skipped — cannot load the plan parser at {_CHECK}")
        return 0

    text = plan.read_text(encoding="utf-8", errors="replace")
    blocks = re.split(r"^(?=###\s+Phase\s+\d+)", text, flags=re.M)
    files_of, built = {}, set()
    for b in blocks:
        m = re.match(r"###\s+Phase\s+(\d+)", b)
        if not m:
            continue
        n = int(m.group(1))
        files_of[n] = {f for f in check.phase_files(b) if check.comparable(f)}
        if check.BUILT.search(b.split("\n", 1)[0]) or re.search(r"^- \[x\]", b, re.M):
            built.add(n)

    unknown = sorted(want - set(files_of))
    if unknown:
        print(f"footprint-warn: not in {plan.name}: {', '.join(f'Phase {n}' for n in unknown)}",
              file=sys.stderr)
        return 1

    running = sorted(want - built)
    if len(running) < 2:
        print(f"slice {sorted(want)}: nothing to compare — "
              f"{len(running)} unbuilt leaf in it")
        return 0

    counts = history(repo, base)
    if counts is None:
        print(f"footprint-warn: skipped — cannot read git history of '{base}' in {repo}")
        return 0
    if not counts:
        print(f"footprint-warn: skipped — '{base}' has no history to measure against")
        return 0

    claimed = defaultdict(list)
    for n in running:
        for pkg in {package_of(f) for f in files_of[n]}:
            claimed[pkg].append(n)

    risky = {p: ns for p, ns in claimed.items() if len(ns) > 1}
    if not risky:
        print(f"slice {sorted(want)}: no package is claimed by two of these leaves — "
              f"history agrees with the plan")
        return 0

    declared = set().union(*(files_of[n] for n in running))
    lines = [f"slice {sorted(want)} declares no shared file, but history disagrees:", ""]
    found = False
    for pkg in sorted(risky):
        h = hubs(counts, pkg, check.comparable)
        if not h:
            continue
        found = True
        undeclared = [f for f in h if f not in declared]
        lines.append(f"  {pkg or '<root>'} is claimed by "
                     f"{', '.join(f'Phase {n}' for n in risky[pkg])}")
        lines.append("    most-touched files there: "
                     + " · ".join(f"{Path(f).name} ({counts[f]})" for f in h[:4]))
        if undeclared:
            lines.append("    not declared by any of them: "
                         + " · ".join(Path(f).name for f in undeclared[:4]))
        lines.append("")

    if not found:
        print(f"slice {sorted(want)}: leaves share a package, but it has no established hub files — "
              f"nothing history can add")
        return 0

    lines.append("  A phase reaches its package's hub files to be wired in, whatever its Files: line")
    lines.append("  says. Run at most one leaf per package at a time, or correct the Files: lines")
    lines.append("  from the code that now exists and re-run the preflight.")
    print("\n".join(lines))
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
