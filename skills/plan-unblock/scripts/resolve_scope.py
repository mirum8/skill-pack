#!/usr/bin/env python3
"""Resolve a plan's `## Resolve first` block — what is still open, and what it blocks.

    python3 resolve_scope.py <todo.md> --outstanding [--phases 3,4,5]
    python3 resolve_scope.py <todo.md> --check

Two callers read this and they ask different halves of one question. /r:plan-unblock asks "what is
still open, and what kind of thing is each one" before it probes or asks anything. /r:plan-run asks
"does anything under that heading block the phases I am about to build" at its Step 1 gate. One
script, because reading that section as prose means deciding tick state, ownership and which phases
are blocked -- three judgements that fail by returning a confident wrong answer, at the last point
between an unresolved blocker and a build that assumes it was settled.

--outstanding always prints one JSON object and exits 0. A plan with no `## Resolve first` is an
ANSWER (hasSection: false), not an error, and so is a section with nothing left in it. --check is
the gate half and exits 1 when it reports anything, because /r:spec-design's Step 7 is a
fix-and-re-run loop against check_todo.py, which exits 1 on any finding; a check that cannot fail
is not a check. Exit 1 otherwise only for a question it could not answer at all -- no such file, no
mode given.

FOUR THINGS HERE FAIL CLOSED, and each is a way the section could silently unblock a build:

  * an entry with no checkbox is OUTSTANDING. Plans written before this shape carry a plain
    `- **Name** -- ...` bullet with nothing to tick, and /r:plan-run has always gated on "anything
    unticked". Reading an untickable bullet as settled would close every one of them at once.
  * an entry whose `Blocks:` line is missing or names no phase blocks the ENTIRE run list. Nothing
    has ever validated that line, so entries in the wild carry prose or nothing; parsing that to
    "blocks no phases" puts the entry outside every --phases narrowing, and a run sails past a
    blocker the script itself could see was broken.
  * a tick with no `Resolved:` line is resolved for gating and reported, never silently accepted.
    Somebody closed it; nothing records what they decided.
  * an entry this script cannot classify is a PERSON's, not a decision. The two differ in who may
    close them, and only one of them can be closed by asking a model.

WHY THE PHASE REGEXES ARE COPIED FROM check_todo.py RATHER THAN IMPORTED. That script belongs to
another skill, and a cross-skill import breaks the moment either one is installed alone. What is
duplicated is the phase heading and the tick -- two short lines, asserted in both suites, whose
drift shows up as a phase this script cannot see rather than as a wrong answer about one it can.
"""
import json
import re
import sys
from pathlib import Path

# Copied from check_todo.py: the leaf heading, and the tick that makes a leaf done.
PHASE_HEAD = re.compile(r"^###\s+Phase\s+(\d+)\s*[—-]\s*(.+)$", re.M)
PHASE_SPLIT = r"(?=^###\s+Phase\s+\d+)"
OPEN_ITEM = re.compile(r"^\s*-\s*\[ \]", re.M)
DONE_ITEM = re.compile(r"^\s*-\s*\[[xX]\]", re.M)

# The section ends at the NEXT HEADING OF ANY LEVEL, not at the next `## `. A plan whose
# `## Resolve first` is followed straight by `### Phase 1` -- no milestone heading between --
# would otherwise run to end of file and read every phase's checkboxes as entries.
SECTION = re.compile(r"^##\s+Resolve\s+first\b(.*?)(?=^#{1,6}\s|\Z)", re.M | re.S | re.I)
ENTRY_SPLIT = r"(?=^ {0,1}[-*]\s)"
TICKED = re.compile(r"^\s*[-*]\s*\[[xX]\]")
UNTICKED = re.compile(r"^\s*[-*]\s*\[ \]")
NAME = re.compile(r"\*\*(.+?)\*\*")

# The fields an entry carries, in the order /r:spec-design writes them. Everything between one
# label and the next belongs to the first -- which is why they are sliced by position rather than
# matched one regex at a time: `Output: a line in the spec's Risks.` holds a period of its own, and
# a non-greedy match to the next full stop would cut it in half.
FIELDS = ("Owner", "Blocks", "Timebox", "Output", "Resolved", "Alternative", "Outstanding")
# A field ends at the NEXT LABEL, and "label" cannot mean "label this script knows about". An entry
# carrying a field outside FIELDS -- `Informs: Phases 32 and 33.` was the observed one -- ran the
# PREVIOUS field to the end of the entry, and since `Blocks:` is the load-bearing edge, the phase
# regex then harvested 32 and 33 out of the Informs clause. The entry was reported as blocking
# exactly the phases its author had listed as merely informed, and `gate` is the value /r:plan-run
# is told to obey without second-guessing.
#
# So slice on anything SHAPED like a label and keep only the known ones. An unknown label is then
# named in `malformed` rather than silently eaten: it is not a field this contract has, and an
# author who wrote one needs to be told that, not to have it folded into their neighbour.
LABEL = re.compile(r"\b(" + "|".join(FIELDS) + r"):", re.I)
ANY_LABEL = re.compile(r"\b([A-Z][A-Za-z]{2,}):")
KNOWN = {f.lower() for f in FIELDS}

# Which side of the section an entry falls on, derived rather than judged fresh each run. The
# patterns are check_todo.py's NOT_BUILDABLE, read for the question it answers one document later:
# there, the table keeps this work out of a numbered phase; here, the same split says who is
# allowed to close it. Rows 1-3 there produce a DECISION, rows 4-6 need a PERSON.
#
# PERSON is tested first, and that ordering is the fail-closed direction: "decide whether to sign
# the DPA" is a signature wearing a decision's grammar, and only one of the two readings can be
# closed by asking a model a question.
PERSON = [
    r"\bhir(e|ing)\b|\bstaff(ing)?\b|\brota\b|on-call cover",
    r"\bprocure|\bpurchase\b|\blicen[cs]e agreement\b|\bcontract\b|\bsign(ing)? (a|the)\b",
    r"\btrain(ing)? the team\b|\bworkshop\b|\bonboard the\b",
    r"\bapprovals?\b|\bapprove\b|\bbudget\b|\blegal\b|\bDPA\b|\bNDA\b|\bprocurement\b",
]
DECISION = [
    r"\bspike\b",
    r"\binvestigat|\bresearch\b|\bevaluate\b|\bexplore whether\b|\bbenchmark\b",
    r"\bdecide whether\b|\bchoose between\b|\bpick between\b",
    r"\bcan (?:we|it|they|the)\b|\bdoes (?:it|the)\b|\bis (?:it|the)\b|\bwhether\b|\bwhich\b",
]
# An owner is weak evidence on its own -- "platform" says nothing about who may close the entry --
# but these four name functions that do not write code, and an entry owned by one of them is not a
# decision an engineer can take by reading the repo.
PERSON_OWNER = re.compile(r"\b(legal|finance|procurement|hr|people|compliance|security council)\b",
                          re.I)


def phases(text):
    """(num -> block) for every leaf, plus the numbers in document order."""
    heads = PHASE_HEAD.findall(text)
    blocks = re.split(PHASE_SPLIT, text, flags=re.M)[1:]
    nums = [int(n) for n, _ in heads]
    return nums, dict(zip(nums, blocks))


def built(block):
    """A leaf is built when it has ticks and nothing left open -- the rule /r:plan-run uses to skip
    one, and check_todo.py's `done_of`. A phase with no checkboxes at all is not built."""
    return bool(DONE_ITEM.search(block)) and not OPEN_ITEM.search(block)


def fields(chunk):
    """Every `Label:` in the entry, sliced from one label to the next.

    Returns (head, known_fields, unknown_labels). Slicing uses EVERY label-shaped token, so a
    field this contract does not define still terminates the one before it; only the known ones
    are returned as fields, and the rest come back named so the caller can say so.
    """
    flat = " ".join(chunk.split())
    marks = [m for m in ANY_LABEL.finditer(flat)]
    # A label-shaped token inside prose is possible, so the head is still cut at the first KNOWN
    # label: that is where the fields provably begin.
    first_known = LABEL.search(flat)
    out, unknown = {}, []
    for i, m in enumerate(marks):
        if first_known and m.start() < first_known.start():
            continue
        end = marks[i + 1].start() if i + 1 < len(marks) else len(flat)
        key = m.group(1).lower()
        value = flat[m.end():end].strip().rstrip(".").strip()
        if key in KNOWN:
            out[key] = value
        else:
            unknown.append(m.group(1))
    head = flat[:first_known.start()] if first_known else flat
    return head, out, unknown


def classify(name, question, owner):
    """decision | person | unclassified. Unclassified is treated as person by every caller: the
    two outcomes differ in who may close the entry, and guessing 'decision' hands a signature to
    an interview."""
    subject = f"{name} {question}"
    if owner and PERSON_OWNER.search(owner):
        return "person"
    for pat in PERSON:
        if re.search(pat, subject, re.I):
            return "person"
    for pat in DECISION:
        if re.search(pat, subject, re.I):
            return "decision"
    return "unclassified"


def parse_entries(body):
    entries = []
    for i, chunk in enumerate(re.split(ENTRY_SPLIT, body, flags=re.M), start=0):
        if not chunk.strip() or not re.match(r"^\s*[-*]\s", chunk):
            continue
        head, f, unknown = fields(chunk)
        malformed = []
        if unknown:
            malformed.append(f"unknown field(s) {', '.join(unknown)}: — not part of this contract "
                             f"(the fields are {', '.join(FIELDS)}); it is ignored, not merged "
                             "into the field before it")
        legacy = not (TICKED.match(chunk) or UNTICKED.match(chunk))
        ticked = bool(TICKED.match(chunk))
        m = NAME.search(head)
        name = m.group(1).strip() if m else ""
        if not name:
            # No bold subject: take the head after the marker, to the first dash or period.
            bare = re.sub(r"^\s*[-*]\s*(\[[ xX]\]\s*)?", "", head)
            name = re.split(r"\s+[—–-]\s+|\.\s", bare)[0].strip()
            malformed.append("no **name**")
        question = head[m.end():].strip(" —–-.") if m else ""
        owner = f.get("owner") or None
        if not owner:
            malformed.append("no Owner:")
        raw_blocks = f.get("blocks")
        if raw_blocks is None:
            blocks = None
            malformed.append("no Blocks: — it blocks the entire run list")
        else:
            found = [int(n) for n in re.findall(r"(?:Phase\s*)?(\d+)", raw_blocks)]
            blocks = found or None
            if not found:
                malformed.append(f"Blocks: {raw_blocks!r} names no phase — it blocks the "
                                 "entire run list")
        resolution = f.get("resolved") or None
        if ticked and not resolution:
            malformed.append("ticked with no Resolved: line — nothing records what settled it")
        entries.append({
            "i": len(entries) + 1,
            "name": name,
            "question": question,
            "owner": owner,
            "blocks": blocks,
            "kind": classify(name, question, owner),
            "timebox": f.get("timebox") or None,
            "output": f.get("output") or None,
            "resolved": ticked,
            "resolution": resolution,
            "legacyShape": legacy,
            "malformed": malformed,
        })
    return entries


def analyse(plan, scope_arg):
    text = plan.read_text(encoding="utf-8", errors="replace")
    nums, blocks = phases(text)
    sec = SECTION.search(text)
    entries = parse_entries(sec.group(1)) if sec else []
    open_e = [e for e in entries if not e["resolved"]]

    blocked, unknown, blocks_everything = set(), set(), False
    for e in open_e:
        if e["blocks"] is None:
            blocks_everything = True
            continue
        for n in e["blocks"]:
            (blocked if n in blocks else unknown).add(n)

    scope = scope_arg if scope_arg is not None else list(nums)
    in_scope = sorted(blocked & set(scope))
    moot = sorted(n for n in blocked if n in blocks and built(blocks[n]))
    live = [n for n in in_scope if n not in moot]

    return {
        "plan": str(plan),
        "hasSection": sec is not None,
        "phases": nums,
        "entries": entries,
        "outstanding": [e["i"] for e in open_e],
        "blockedPhases": sorted(blocked),
        "blockedPhasesBuilt": moot,
        "blocksEverything": blocks_everything,
        "unknownPhaseRefs": sorted(unknown),
        "tickedWithoutResolution": [e["i"] for e in entries
                                    if e["resolved"] and not e["resolution"]],
        "legacyShape": [e["i"] for e in entries if e["legacyShape"]],
        "scope": sorted(scope),
        "blockedInScope": live,
        # The gate's whole answer, computed rather than eyeballed. "stop" when an open entry blocks
        # something this run would build; an entry with no readable Blocks: stops any non-empty
        # run, because there is no way to tell what it was guarding.
        "gate": "stop" if (live or (blocks_everything and scope)) else "clear",
    }


def problems(d):
    out = []
    for e in d["entries"]:
        for why in e["malformed"]:
            out.append(f"entry {e['i']} ({e['name'] or 'unnamed'}): {why}")
        if e["legacyShape"]:
            out.append(f"entry {e['i']} ({e['name'] or 'unnamed'}): no '- [ ]' checkbox, so it can "
                       "never be closed — /r:plan-run gates on unticked entries")
    for n in d["unknownPhaseRefs"]:
        out.append(f"Blocks: Phase {n}, which this plan does not have")
    for n in d["blockedPhasesBuilt"]:
        out.append(f"an open entry blocks Phase {n}, which is already built — resolve it or drop it")
    return out


def main():
    argv = sys.argv[1:]
    if not argv:
        print("usage: resolve_scope.py <todo.md> [--outstanding | --check] [--phases 3,4,5]",
              file=sys.stderr)
        return 1
    plan = Path(argv[0])
    if not plan.exists():
        print(f"missing: {plan}", file=sys.stderr)
        return 1
    mode = "check" if "--check" in argv else "outstanding" if "--outstanding" in argv else None
    if mode is None:
        print("no mode: pass --outstanding or --check", file=sys.stderr)
        return 1
    scope = None
    if "--phases" in argv:
        i = argv.index("--phases")
        if i + 1 >= len(argv):
            print("--phases needs a comma-separated list", file=sys.stderr)
            return 1
        scope = [int(n) for n in re.findall(r"\d+", argv[i + 1])]

    d = analyse(plan, scope)
    if mode == "check":
        d["problems"] = problems(d)
    json.dump(d, sys.stdout, indent=2, ensure_ascii=False)
    print()
    return 1 if mode == "check" and d["problems"] else 0


if __name__ == "__main__":
    sys.exit(main())
