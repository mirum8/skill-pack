#!/usr/bin/env python3
"""Check a freshly-written implementation plan against the repo it plans against.

    python3 plan_check.py <plan.md> --report [--criteria '<json array>'] [--repo <dir>] [--tier full]
    python3 plan_check.py <plan.md> --check  [--criteria '<json array>'] [--repo <dir>] [--tier full]

One caller reads this: task-run-implement.workflow.js, between the scribe that puts the plan on
disk and the Codex review that challenges it. It exists because two thirds of what that review
confirms is answerable without judgement. Measured over the 23 runs carrying rubric and severity,
the triage confirms 12.2 plan defects a run: test-adequacy 91, risk 62, coverage 58, grounding 42.
Three of those four -- 191 of 281 -- are questions about whether the plan's own claims line up with
the tree, and the pipeline was paying a 446s Codex pass plus a six-agent judge wave to ask them.
Only `risk` needs a reviewer.

--report always prints one JSON object and exits 0. A plan missing a section is an ANSWER, not an
error. --check is the gate half and exits 1 when `problems` is non-empty, for the same reason
resolve_scope.py's is: a check that cannot fail is not a check. Exit 1 otherwise only for a question
it could not answer at all -- no such file, no mode given.

WHAT THIS DOES NOT DO, stated because the gap is the whole reason the Codex review stays. It cannot
tell whether a [RED] test would REALLY fail today -- that is a claim about running code that does
not exist yet -- and it cannot tell whether a citation that resolves says what the plan claims. The
first is what `C` (handing the planner the real test files) attacks; the second is the citation
pass the caller runs on `citations` straight after this. What lives here is only the half a script
answers better than a model: does the file exist, does the line exist, is there a row for every
criterion, is every test tagged.

FIVE THINGS FAIL CLOSED, and each is a way a plan could tell the run it was sound when it wasn't:

  * a citation that does not resolve is a PROBLEM -- no such file, or a line past the end of one.
    Never "the planner probably meant something nearby": a plan built on a misread of the code is
    the most expensive wrong, and a reference nobody can open is the cheapest possible instance of
    it.
  * a criterion with no coverage row, or a row whose test cell names no test, is UNCOVERED. A cell
    holding prose about how something is proven is not a test; the review's own rubric says a
    criterion covered only in prose is a gap.
  * a [RED] entry with no justification is UNVERIFIED. "It must fail today" is a claim about the
    current code, and an entry that makes it while saying nothing about the current code has not
    made it at all. A justification is a resolving file:LINE or a clause about what the code does
    or lacks today -- an ABSENCE is a legitimate justification and cannot carry a line number, which
    is why a citation alone is not demanded here.
  * an untagged test entry is UNTAGGED, never GREEN. Same direction every other unmarked field in
    this pack fails: toward surfacing. A suite read as green-by-default is one nobody checked.
  * NO --criteria MEANS THE COVERAGE CHECK IS SKIPPED AND SAID SO, never reported clean. Absence of
    a judgement is not a judgement of zero -- the rule the stats store already lives by for a
    blocked track.

WHY THE COVERAGE TABLE IS MATCHED ON `AC-<n>` AND WHAT HAPPENS WITHOUT IT. Plans in the wild key
that table two ways: an `AC-1` id, or a paraphrase of the criterion in the planner's own words.
A paraphrase cannot be matched to a criterion without judgement, and guessing produces exactly the
confident wrong answer this script exists to remove -- so the mode is CHOSEN, reported in
`coverage.mode`, and never inferred silently. With ids, rows are matched by id. Without them the
check falls back to counting rows against criteria, which catches a missing row and cannot catch a
misaligned one, and says so in `coverage.note`.
"""
import json
import os
import re
import sys
from pathlib import Path

# A markdown heading and its text. Both `##` and `###` -- plans nest the TDD plan's own subsections
# under `###`, and a section this script needs has been seen at either depth.
# `[ \t]*$` rather than `\s*$`, and the same below: under re.M, `\s` swallows the newline and the
# blank line after a heading, so the section body then STARTS with a newline and the first list item
# under it reads as indented — which silently dropped the first test entry of every section.
HEADING = re.compile(r"^(#{2,4})[ \t]+(.+?)[ \t]*$", re.M)

# A `path:LINE` reference anywhere in the prose. Plans do not write citations in a fixed slot: they
# trail a sentence ("... internal/store/store.go:108 and internal/store/store.go:125"), sit inside a
# table cell, or hide in backticks. So this matches the SHAPE wherever it appears, and the path must
# carry an extension -- without one, "Phase 36:620" and every "note: 3" reads as a citation.
CITATION = re.compile(r"(?<![\w/.-])([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9_]{1,10}):(\d+)(?:-(\d+))?(?![\w.])")

# A list item, BULLETED OR NUMBERED. Real plans use both and the choice carries no meaning: of the
# 48 plans this was built against, some write "- [RED] `TestFoo`: ..." and others
# "1. **`TestFoo`** (`foo_test.go`) **[RED]** — ...". Reading only the first shape found zero test
# entries in half of them, which is the silent-empty failure this script exists to refuse.
BULLET = re.compile(r"^([ \t]*)(?:[-*]|\d{1,3}[.)])[ \t]+(.+?)[ \t]*$", re.M)
# Searched anywhere in the entry, never anchored: the tag leads some entries and trails others, and
# it is as often bold-wrapped (`**[RED]**`) as bare. The qualifier half is not optional decoration
# either -- plans write `[RED - compile]` and `[RED - runtime]` to say HOW it fails, and a pattern
# demanding a bare `[RED]` reads all 24 entries of such a plan as untagged.
TAG = re.compile(r"\[(RED|GREEN)\b[^\]]*\]")

# A markdown table row, split on unescaped pipes.
TABLE_ROW = re.compile(r"^[ \t]*\|(.+)\|[ \t]*$", re.M)
DIVIDER = re.compile(r"^[\s|:-]+$")

# An `AC-<n>` key, in the criteria list or in a coverage row's first cell.
AC_ID = re.compile(r"\bAC-(\d+)\b", re.I)

# An identifier that could be a test: a CamelCase or snake_case name, or a backticked token. This is
# the same discipline as looksLikeEvidence in the workflow -- a cell has to NAME something, and a
# sentence about how a criterion is proven names nothing a runner could execute.
TEST_NAME = re.compile(r"`[^`]+`|\b(?:[Tt]est|it_|should_)[A-Za-z0-9_]{3,}|\b[A-Za-z_][A-Za-z0-9_]*(?:Test|Spec|_test)\b")

# A clause asserting something about the code as it stands. Deliberately a FLOOR, not a judgement:
# it separates "[RED] TestFoo: asserts the new API returns 404" (which says nothing about today)
# from "... the current checkout has no such API". Whether the claim is TRUE is the citation pass's
# job and then Codex's -- this only refuses an entry that never made one.
JUSTIFIES = re.compile(
    r"\b(current(ly)?|today|at present|as it stands|existing|exists?|has no|have no|there is no|"
    r"does not|doesn'?t|cannot|can'?t|no such|not implemented|missing|absent|fails?|failing|"
    r"must be edited|would fail|will fail|never)\b", re.I)

# What a full or standard plan owes, normalised to lowercase words. The planner prompt asks for all
# of these by name; the light planner asks for four. Matching is on the normalised words the heading
# CONTAINS, because real plans drift the wording ("Files to change and approach" against the
# prompt's "Files to change and the approach") and a section present under a near-miss title is
# present.
SECTIONS = {
    "context": ("context",),
    "files to change": ("files", "change"),
    "reuse map": ("reuse", "map"),
    "test plan": ("test", "plan"),
    "verification steps": ("verification",),
    "coverage contract": ("coverage", "contract"),
}
REQUIRED = {
    "full": tuple(SECTIONS),
    "standard": tuple(SECTIONS),
    "light": ("context", "files to change", "test plan", "coverage contract"),
}


def norm(text):
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text.lower()).split())


def sections_of(text):
    """Every heading in the plan, with the body under it, in document order.

    A body runs to the next heading of the SAME OR SHALLOWER depth, so `## TDD test plan` keeps its
    `### Store tests` subsections. A plan whose sections were split off into siblings would
    otherwise lose every test entry it wrote.
    """
    marks = [(m.start(), len(m.group(1)), m.group(2), m.end()) for m in HEADING.finditer(text)]
    out = []
    for i, (pos, depth, title, body_start) in enumerate(marks):
        end = len(text)
        for later_pos, later_depth, _t, _e in marks[i + 1:]:
            if later_depth <= depth:
                end = later_pos
                break
        out.append({"title": title, "depth": depth, "norm": norm(title), "body": text[body_start:end]})
    return out


def find_section(sections, key):
    """The first section whose title contains every word the key asks for.

    Deepest-shallowest is not considered: a `### Coverage contract` nested inside another section is
    still the coverage contract, and a plan that writes it there is unusual rather than wrong.
    """
    words = SECTIONS[key]
    for s in sections:
        if all(w in s["norm"].split() for w in words):
            return s
    return None


def repo_index(repo_root):
    """basename -> every tracked path carrying it, so a bare `rail.go:72` can be resolved.

    Plans cite a bare basename constantly: the prose around it already said which package, so the
    planner writes `filter.go:17` and means `internal/ui/filter.go:17`. Resolving those against the
    repo root alone marked 2170 of 3574 citations across 48 real plans as broken -- a check that
    wrong is worse than no check, because its output is a wall nobody reads.

    `git ls-files` rather than a walk: it is the tree the plan is planning against, and it costs
    nothing to ask. The walk is the fallback for a plan outside a repo, and it prunes the
    directories whose contents would swamp the index with basenames no plan ever cites.
    """
    import subprocess
    idx = {}
    names = []
    try:
        r = subprocess.run(("git", "-C", str(repo_root), "ls-files"),
                           capture_output=True, text=True, timeout=30)
        if r.returncode == 0:
            names = [n for n in r.stdout.splitlines() if n]
    except (OSError, subprocess.SubprocessError):
        names = []
    if not names:
        skip = {".git", "node_modules", "target", "build", "dist", "vendor", ".venv", "__pycache__"}
        for root, dirs, files in os.walk(repo_root):
            dirs[:] = [d for d in dirs if d not in skip]
            for f in files:
                names.append(os.path.relpath(os.path.join(root, f), repo_root))
    for n in names:
        idx.setdefault(os.path.basename(n), []).append(n)
    return idx


def strip_code_fences(text):
    """Fenced blocks are examples, not claims. A citation inside one is code the plan is SHOWING,
    and holding it to the tree would flag every plan that quotes a diff or a command."""
    return re.sub(r"```.*?```", "", text, flags=re.S)


def citations_in(body, section_title, repo_root, index, seen):
    """Every `path:LINE` in one section, each resolved against the tree.

    `seen` de-duplicates across sections by (path, line): a plan that cites the same line in its
    approach and again in its reuse map made one claim, and reporting it twice would make a tidy
    plan look worse than a vague one.

    Three outcomes, not two. A reference that names exactly one file RESOLVES, whether it was
    written as a full path or a bare basename. One whose basename names several files is AMBIGUOUS
    -- the plan is vague, but the reference is not wrong, and calling it broken would flag a correct
    plan. Only a name the tree does not carry at all, or a line past the end of the file it names,
    is a problem.
    """
    found = []
    for m in CITATION.finditer(strip_code_fences(body)):
        rel, line = m.group(1), int(m.group(2))
        key = (rel, line)
        if key in seen:
            continue
        seen.add(key)
        resolved_as, ambiguous, candidates = rel, False, []
        if not (Path(repo_root) / rel).is_file():
            candidates = index.get(os.path.basename(rel), [])
            # A full path that failed is only retried on its basename when it carried no directory.
            # `internal/ui/rail.go:9` failing while `cmd/rail.go` exists is a MOVED file, and
            # silently re-pointing it at the other one is the confident wrong answer.
            if "/" not in rel and len(candidates) == 1:
                resolved_as = candidates[0]
            elif "/" not in rel and len(candidates) > 1:
                ambiguous = True
        target = Path(repo_root) / resolved_as
        exists = target.is_file()
        lines = 0
        if exists:
            try:
                lines = sum(1 for _ in target.open("r", encoding="utf-8", errors="replace"))
            except OSError:
                exists = False
        # A line past the end of the file is the same defect as a missing file: the reference names
        # nothing. Line 0 is never a real citation either.
        resolves = bool(exists and 0 < line <= lines and not ambiguous)
        if ambiguous:
            why = f"`{os.path.basename(rel)}` names {len(candidates)} files in this repo"
        elif not exists:
            why = "no such file"
        elif resolves:
            why = ""
        else:
            why = f"{resolved_as} has {lines} line(s)"
        found.append({
            "where": f"{rel}:{line}",
            "file": rel,
            "resolvedAs": resolved_as if resolved_as != rel else "",
            "line": line,
            "section": section_title,
            "resolves": resolves,
            "ambiguous": ambiguous,
            "why": why,
            "claim": claim_around(body, m.start()),
        })
    return found


def claim_around(body, pos):
    """The sentence the citation sits in — what the plan is ASSERTING about that line.

    This is what the citation pass downstream checks the line against, so it has to be the claim and
    not a window of characters. Sentence boundaries first, then the enclosing table cell or list
    item, then a bounded fallback.
    """
    start = max(body.rfind(". ", 0, pos), body.rfind("\n", 0, pos), body.rfind("| ", 0, pos))
    start = 0 if start < 0 else start + 1
    tail = body[pos:]
    stop = len(tail)
    for sep in (". ", "\n", " |"):
        i = tail.find(sep)
        if 0 <= i < stop:
            stop = i
    return " ".join(body[start:pos + stop].split())[:400]


def criteria_keys(criteria):
    """`AC-<n>` for each criterion, by the ORDER it was handed in.

    The workflow passes criteria as a list, and the planner is given them in that order, so the nth
    criterion is AC-n whether or not the criterion text says so. A criterion that names its own id
    keeps it -- plans written by /r:spec-design carry "AC-4: ..." in the text itself.
    """
    out = []
    for i, c in enumerate(criteria, start=1):
        m = AC_ID.search(str(c))
        out.append(f"AC-{m.group(1)}" if m else f"AC-{i}")
    return out


def table_rows(body):
    """Data rows of the first markdown table in a section, each as a list of cells."""
    rows = []
    for m in TABLE_ROW.finditer(body):
        raw = m.group(1)
        if DIVIDER.fullmatch(raw):
            continue
        rows.append([c.strip() for c in raw.split("|")])
    return rows[1:] if rows else []


def coverage_of(section, criteria):
    """Does every acceptance criterion have a row, and does that row name a test?

    Two modes, and WHICH ONE RAN IS REPORTED rather than inferred. `ac-ids` matches a row to a
    criterion by the AC id in its first cell and is exact. `positional` is the fallback for a table
    keyed by paraphrase: it can see that a row is MISSING and cannot see that one is misaligned, so
    it says so in `note` instead of quietly claiming the stronger answer.
    """
    if criteria is None:
        return {"mode": "skipped", "rows": [], "uncovered": [],
                "note": "no --criteria were handed in, so nothing was checked against the table — "
                        "this is a skip, not a clean result"}
    if section is None:
        return {"mode": "skipped", "rows": [], "uncovered": list(criteria_keys(criteria)),
                "note": "the plan has no coverage contract section, so every criterion is uncovered"}

    keys = criteria_keys(criteria)
    rows = table_rows(section["body"])
    parsed = []
    for cells in rows:
        first = cells[0] if cells else ""
        m = AC_ID.search(first)
        # The test cell is the one AFTER the implementation seam. Plans head these columns half a
        # dozen ways ("Test evidence", "Test", "Proven by"), so position is the stable read and the
        # heading is not.
        test_cell = cells[2] if len(cells) > 2 else (cells[-1] if len(cells) > 1 else "")
        parsed.append({
            "key": f"AC-{m.group(1)}" if m else None,
            "criterion": first[:200],
            "test": test_cell[:300],
            "namesTest": bool(TEST_NAME.search(test_cell)),
        })

    keyed = [r for r in parsed if r["key"]]
    if keyed and len(keyed) >= len(parsed) / 2:
        mode, note = "ac-ids", ""
        have = {r["key"] for r in keyed if r["namesTest"]}
        uncovered = [k for k in keys if k not in have]
    else:
        mode = "positional"
        note = ("the coverage table is keyed by paraphrase rather than AC ids, so rows were counted "
                "rather than matched — a MISSING row is caught, a misaligned one is not")
        proven = [r for r in parsed if r["namesTest"]]
        uncovered = keys[len(proven):] if len(proven) < len(keys) else []
    return {"mode": mode, "rows": parsed, "uncovered": uncovered, "note": note}


def tests_of(section):
    """Every test entry in the TDD plan, its tag, and whether a [RED] justified itself."""
    if section is None:
        return {"entries": [], "untagged": [], "redUnjustified": [],
                "note": "the plan has no test plan section"}
    body = strip_code_fences(section["body"])
    items = [(len(m.group(1).expandtabs(4)), " ".join(m.group(2).split())) for m in BULLET.finditer(body)]
    # ONLY TOP-LEVEL ITEMS ARE TEST ENTRIES. A plan routinely breaks one test into lettered
    # sub-steps -- "(a) start a drainer goroutine", "(b) assert the window" -- and those are
    # assertions belonging to the entry above, not tests of their own. Counting them made a 12-test
    # plan look like a 37-test plan with 25 of them untagged, which is the report reading as a wall
    # of defects about a plan that had none of them.
    top = min((ind for ind, _ in items), default=0)
    entries, untagged, unjustified = [], [], []
    for ind, item in items:
        if ind > top:
            continue
        tag_m = TAG.search(item)
        tag = tag_m.group(1) if tag_m else None
        cited = bool(CITATION.search(item))
        justified = cited or bool(JUSTIFIES.search(item))
        e = {"tag": tag, "text": item[:300], "cited": cited, "justified": justified}
        entries.append(e)
        if tag is None:
            untagged.append(item[:200])
        elif tag == "RED" and not justified:
            unjustified.append(item[:200])
    return {"entries": entries, "untagged": untagged, "redUnjustified": unjustified, "note": ""}


def build(plan, repo_root, criteria, tier):
    text = plan.read_text(encoding="utf-8", errors="replace")
    sections = sections_of(text)

    present, missing = [], []
    for key in REQUIRED.get(tier, REQUIRED["full"]):
        (present if find_section(sections, key) else missing).append(key)

    index = repo_index(repo_root)
    seen = set()
    citations = []
    # Only the sections that make claims ABOUT THE TREE. A citation in "Alternatives considered"
    # describes a road not taken and is not a claim the plan rests on.
    for key in ("files to change", "reuse map", "test plan"):
        s = find_section(sections, key)
        if s:
            citations += citations_in(s["body"], key, repo_root, index, seen)

    cov = coverage_of(find_section(sections, "coverage contract"), criteria)
    tests = tests_of(find_section(sections, "test plan"))
    unresolved = [c for c in citations if not c["resolves"] and not c["ambiguous"]]
    ambiguous = [c for c in citations if c["ambiguous"]]

    return {
        "plan": str(plan),
        "repoRoot": str(repo_root),
        "tier": tier,
        "sections": {"present": present, "missing": missing},
        "citations": citations,
        "unresolved": unresolved,
        "ambiguous": ambiguous,
        "coverage": cov,
        "tests": tests,
    }


def problems_in(d):
    """The gate's whole answer, computed rather than eyeballed."""
    p = []
    for key in d["sections"]["missing"]:
        p.append(f"the plan has no `{key}` section")
    for c in d["unresolved"]:
        p.append(f"{c['section']}: `{c['where']}` does not resolve ({c['why']})")
    for k in d["coverage"]["uncovered"]:
        p.append(f"{k} has no coverage row naming a test")
    for t in d["tests"]["untagged"]:
        p.append(f"test entry carries neither [RED] nor [GREEN]: {t}")
    for t in d["tests"]["redUnjustified"]:
        p.append(f"[RED] entry says nothing about the current code: {t}")
    return p


def main():
    argv = sys.argv[1:]
    if not argv or argv[0].startswith("-"):
        print("usage: plan_check.py <plan.md> [--report | --check] [--criteria '<json array>'] "
              "[--repo <dir>] [--tier full|standard|light]", file=sys.stderr)
        return 1
    plan = Path(argv[0])
    if not plan.is_file():
        print(f"missing: {plan}", file=sys.stderr)
        return 1

    mode = "check" if "--check" in argv else ("report" if "--report" in argv else None)
    if mode is None:
        print("give one of --report or --check", file=sys.stderr)
        return 1

    def flag(name):
        if name not in argv:
            return None
        i = argv.index(name)
        if i + 1 >= len(argv) or argv[i + 1].startswith("--"):
            print(f"{name} needs a value", file=sys.stderr)
            sys.exit(1)
        return argv[i + 1]

    tier = (flag("--tier") or "full").lower()
    if tier not in REQUIRED:
        print(f"--tier must be one of {', '.join(REQUIRED)}", file=sys.stderr)
        return 1

    criteria = None
    raw = flag("--criteria")
    if raw is not None:
        try:
            parsed = json.loads(raw)
        except ValueError:
            print("--criteria must be a JSON array of strings", file=sys.stderr)
            return 1
        if not isinstance(parsed, list):
            print("--criteria must be a JSON array of strings", file=sys.stderr)
            return 1
        # An EMPTY array is a real answer -- a task with no written criteria -- and it is not the
        # same as no --criteria at all. It leaves nothing to cover rather than skipping the check.
        criteria = [str(c) for c in parsed]

    repo_root = flag("--repo") or os.getcwd()

    d = build(plan, Path(repo_root), criteria, tier)
    if mode == "check":
        d["problems"] = problems_in(d)
    json.dump(d, sys.stdout, indent=2, ensure_ascii=False)
    print()
    return 1 if mode == "check" and d["problems"] else 0


if __name__ == "__main__":
    sys.exit(main())
