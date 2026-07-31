#!/usr/bin/env python3
"""Check a generated todo.md for the defects a read-through misses.

    python3 check_todo.py docs/<topic>/todo.md [--spec docs/<topic>/spec.html]

With --spec, also checks that every user story in the spec reaches a phase.
Exit 0 when clean, 1 when anything is reported.
"""
import html
import re
import sys
from pathlib import Path

VAGUE = ["set up the thing", "implement the service", "add the logic", "wire it up",
         "make it work", "handle errors", "finish the feature", "various"]
RISK_SURFACES = ["auth", "money", "persistence", "concurrency", "security", "migration", "payment"]
# /r:task-run branches, implements test-first, builds and opens a PR for anything under a "### Phase"
# heading. Work that produces a decision or a signature instead of a diff must not carry one.
NOT_BUILDABLE = [
    (r"\bspike\b", "a spike produces a decision, not a diff"),
    (r"\binvestigat|\bresearch\b|\bevaluate\b|\bexplore whether\b", "an investigation produces a decision"),
    (r"\bdecide whether\b|\bchoose between\b", "a decision is not a pull request"),
    (r"\bhir(e|ing)\b|\bstaff(ing)?\b|\brota\b|on-call cover", "staffing is not engineering work"),
    (r"\bprocure|\bpurchase\b|\blicen[cs]e agreement\b|\bcontract\b|\bsign(ing)? (a|the)\b", "procurement needs a person"),
    (r"\btrain(ing)? the team\b|\bworkshop\b|\bonboard the\b", "training is not a build phase"),
]


def strip(t):
    t = re.sub(r"<script\b.*?</script>", " ", t, flags=re.S | re.I)
    t = re.sub(r"<style\b.*?</style>", " ", t, flags=re.S | re.I)
    return html.unescape(re.sub(r"<[^>]+>", " ", t))


def spec_stories(p):
    """Story names are the <h3> headings inside the spec's User stories section, and a phase's
    Implements: line carries them verbatim. Returns None when there is no spec to check against."""
    if not p or not p.exists():
        return None
    t = p.read_text(encoding="utf-8", errors="replace")
    heads = [(m.start(), m.end(), strip(m.group(1)).lower()) for m in
             re.finditer(r"<h2\b[^>]*>(.*?)</h2>", t, re.S | re.I)]
    for i, (_, end, title) in enumerate(heads):
        if "user stor" in title or "stories" in title:
            nxt = heads[i + 1][0] if i + 1 < len(heads) else len(t)
            return [" ".join(strip(m.group(1)).split())
                    for m in re.finditer(r"<h3\b[^>]*>(.*?)</h3>", t[end:nxt], re.S | re.I)]
    return []


def main():
    args = sys.argv[1:]
    if not args:
        print("usage: check_todo.py <todo.md> [--spec <spec.html>]")
        return 2
    todo_p = Path(args[0])
    spec_p = None
    if "--spec" in args:
        spec_p = Path(args[args.index("--spec") + 1])
    elif todo_p.parent.joinpath("spec.html").exists():
        spec_p = todo_p.parent / "spec.html"

    if not todo_p.exists():
        print(f"missing: {todo_p}")
        return 1
    t = todo_p.read_text(encoding="utf-8", errors="replace")
    problems = []

    def out(msg):
        problems.append(msg)

    # --- structural contract /r:task-run depends on -------------------------------
    heads = re.findall(r"^###\s+Phase\s+(\d+)\s*[—-]\s*(.+)$", t, re.M)
    if not heads:
        out("no '### Phase N — title' headings — /r:task-run cannot locate a phase")
        print("\n".join(f"  - {p}" for p in problems))
        return 1
    nums = [int(n) for n, _ in heads]
    if nums[0] != 1:
        out(f"first phase is {nums[0]} — numbering starts at 1; unknowns and non-engineering work "
            f"belong in an unnumbered '## Resolve first' section, not Phase 0")
    if nums != list(range(nums[0], nums[0] + len(nums))):
        out(f"phase numbers have gaps or repeats: {nums}")
    if not re.search(r"^\s*-\s*\[ \]", t, re.M):
        out("no '- [ ]' checkboxes — /r:task-run reads these as acceptance criteria")
    if not re.search(r"^##\s", t, re.M):
        out("no v1 / Advanced headings")

    # --- per-phase --------------------------------------------------------------
    blocks = re.split(r"(?=^###\s+Phase\s+\d+)", t, flags=re.M)[1:]
    created, referenced = set(), []
    for b in blocks:
        title = b.splitlines()[0].strip()
        items = re.findall(r"^\s*-\s*\[ \]\s*(.+)$", b, re.M)
        if not items:
            out(f"{title}: no checklist items")
        elif len(items) > 12:
            out(f"{title}: {len(items)} checklist items — too big for one session, split it")
        if "**Done when:**" not in b:
            out(f"{title}: no 'Done when' check")
        else:
            dw = re.search(r"\*\*Done when:\*\*\s*(.+?)(?=\n\*\*|\n###|\n##|\Z)", b, re.S)
            body = " ".join(dw.group(1).split()) if dw else ""
            if not re.search(r"`[^`]+`|\b(?:curl|mvn|npm|pytest|go test|gradle|docker|psql)\b", body):
                out(f"{title}: 'Done when' names no runnable command or observable response")
        if "**Implements:**" not in b:
            out(f"{title}: no 'Implements' line — nothing ties it to a story")

        for v in VAGUE:
            if re.search(rf"\b{re.escape(v)}\b", b, re.I):
                out(f"{title}: vague task text '{v}'")

        for pat, why in NOT_BUILDABLE:
            if re.search(pat, title, re.I):
                out(f"{title}: not buildable — {why}. Move it to '## Resolve first' "
                    f"(unnumbered) so /r:task-run doesn't try to open a PR for it.")
                break

        # file lifecycle: don't modify what nothing created
        for m in re.finditer(r"`([^`\s]+\.[A-Za-z0-9]{1,5})`\s*\((new|modify)\)", b):
            path, kind = m.group(1), m.group(2)
            if kind == "new":
                created.add(path)
            else:
                referenced.append((title, path))

        risky = [s for s in RISK_SURFACES if re.search(rf"\b{s}", b, re.I)]
        if risky and "**Risk:**" not in b:
            out(f"{title}: touches {', '.join(sorted(set(risky))[:3])} but has no 'Risk:' line — "
                f"/r:task-run will under-tier it")

    # --- traceability -----------------------------------------------------------
    # Implements: lines carry story names verbatim, separated by " · ". Matching is exact
    # because a paraphrase is indistinguishable from a story nobody planned.
    stories = spec_stories(spec_p)
    if stories is None:
        out(f"note: no spec found next to {todo_p.name} — story coverage not checked")
    elif not stories:
        out("note: the spec has no User stories section with <h3> names — story coverage not checked")
    else:
        cited = set()
        for line in re.findall(r"^\*\*Implements:\*\*\s*(.+)$", t, re.M):
            cited |= {" ".join(n.split()) for n in re.split(r"\s*[·;]\s*|\s*,\s(?=[A-Z])", line) if n.strip()}
        missing = [s for s in stories if s not in cited]
        if missing:
            out(f"stories in the spec with no phase: {', '.join(missing)}")
        extra = sorted(cited - set(stories))
        if extra:
            out(f"phases cite stories the spec doesn't define (check for a reworded name): "
                f"{', '.join(extra)}")

    if not problems:
        print(f"clean — {todo_p} ({len(blocks)} phases)")
        return 0
    print(f"{len(problems)} problem(s) in {todo_p}\n")
    for p in problems:
        print(f"  - {p}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
