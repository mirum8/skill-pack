#!/usr/bin/env python3
"""Check a generated todo.md for the defects a read-through misses.

    python3 check_todo.py docs/<topic>/todo.md [--spec docs/<topic>/spec.html]
                                               [--design docs/<topic>/design.md]
    python3 check_todo.py docs/<topic>/todo.md --against <the-plan-being-replaced.md>
    python3 check_todo.py docs/<topic>/todo.md --slice 5,9

With --spec, also checks that every user story in the spec reaches a phase.
With --design, checks the plan's spine against the contracts file beside it.
With --against, checks that a REWRITE preserved every leaf that already carries landed work -- the
ticks, the numbers and the built markers a half-executed plan is the only record of.
With --slice, answers one question instead: may these leaves run CONCURRENTLY, each in its own
worktree? That is /r:plan-run's preflight, and it is a different question from "is this plan any
good" -- so it reports only the two things that make a slice unsafe (an unbuilt dependency, a
shared file) and stays quiet about plan quality.

Exit 0 when clean, 1 when anything is reported.
"""
import html
import re
import sys
from pathlib import Path

VAGUE = ["set up the thing", "implement the service", "add the logic", "wire it up",
         "make it work", "handle errors", "finish the feature", "various"]
RISK_SURFACES = ["auth", "money", "persistence", "concurrency", "security", "migration", "payment"]
# A leaf's checklist is ALL /r:task-run sees: it locates the "### Phase N" block and lifts that
# block's items into criteria[]. It does not read the milestone above, and it follows no links out.
# So an item that defers to something outside its own block reaches the planner as a dangling
# pointer -- the contract it names is simply absent. The milestone's Design section is for the
# human and for the generator that derived these items from it, never for the implementer.
NOT_SELF_CONTAINED = [
    r"\b(?:per|see|following|under|from) the (?:milestone|design|overview|contract|spec)\b",
    r"\bas (?:described|defined|specified|listed|above)\b",
    r"\baccording to the (?:milestone|design|overview|spec)\b",
    r"\b(?:the )?(?:milestone|design|overview) (?:section|contract|above)\b",
    r"\bsee above\b",
]
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


def phase_deps(block):
    """The leaf's authored edges. "-" / "none" / absent all mean no dependency."""
    m = re.search(r"^\*\*Depends on:\*\*\s*(.+)$", block, re.M)
    if not m:
        return None                       # absent is different from "declared none"
    body = m.group(1).strip()
    if body in {"-", "\u2014", "\u2013", "none", "None", "--"}:
        return set()
    return {int(n) for n in re.findall(r"(?:Phase\s*)?(\d+)", body)}


def phase_files(block):
    """Every backticked path on the Files: line. Used for the same-wave collision check, so it
    takes ALL of them -- the (new)/(modify) suffix the lifecycle check needs is optional here."""
    m = re.search(r"^\*\*Files:\*\*\s*((?:.+\n?)+?)(?=^\*\*|^\s*-\s|\Z)", block, re.M)
    if not m:
        return set()
    return {f for f in re.findall(r"`([^`\s]+\.[A-Za-z0-9]{1,6})`", m.group(1))}


def comparable(path):
    """Is this path worth comparing two phases over?

    A collision check answers "would these two edit the same thing", and a generated artefact
    answers it wrongly in both directions: a captured terminal frame or a golden file is rewritten
    wholesale by whichever run touched it last, so two phases sharing one have no conflict to
    resolve, while the volume of them buries the handful of source files that do. One project
    carries 140 captures under `.claude/`, which turn an 11-file phase into a 48-file one.

    Excluded by shape, never by a whitelist of source extensions. A whitelist silently drops a
    language nobody listed, and a dropped file is a collision this check does not report -- it
    would fail open, which is the one direction a safety check may not fail.
    """
    parts = Path(path).parts
    return not (path.endswith(".golden")
                or "testdata" in parts
                or any(p == ".claude" for p in parts))


def compute_waves(deps):
    """wave(p) = 0 with no dependency, else 1 + max(wave(d)). Longest-path layering, so a leaf
    never shares a wave with anything it depends on. Returns (waves, cycle_members)."""
    wave, resolving = {}, set()
    cyclic = set()

    def w(n):
        if n in wave:
            return wave[n]
        if n in resolving:                # walked into ourselves -- a cycle
            cyclic.add(n)
            return 0
        resolving.add(n)
        parents = [d for d in deps.get(n, set()) if d in deps]
        wave[n] = 0 if not parents else 1 + max(w(d) for d in parents)
        resolving.discard(n)
        return wave[n]

    for n in deps:
        w(n)
    return wave, cyclic


def declared_waves(text):
    """The generated wave summary, if the document carries one. Verified against the computed
    graph rather than trusted: a summary that has drifted from the edges is worse than none,
    because it is the half a human reads when deciding what to run at once."""
    block = re.search(r"^##\s+Waves\b(.*?)(?=^##\s|\Z)", text, re.M | re.S)
    if not block:
        return None
    out = {}
    for m in re.finditer(r"^\s*[-*]?\s*Wave\s+(\d+)\s*[:\u2014-]\s*(.+)$", block.group(1), re.M):
        out[int(m.group(1))] = {int(n) for n in re.findall(r"(?:Phase\s*)?(\d+)", m.group(2))}
    return out


def wave_table(by_wave, done_of, files_of, plan_name):
    """The graph, as something a person can act on.

    A wave is the set of leaves whose dependencies are all satisfied at the same depth, so its
    members may run at once -- one /r:plan-run session each, each in its own detached worktree.
    A wave of one is printed too: it says plainly that there is nothing to parallelise there,
    which is the answer most waves have and the one a table full of hopeful numbers would hide.
    """
    lines = ["", "waves (derived from the Depends on edges):"]
    for w in sorted(by_wave):
        members = sorted(by_wave[w])
        todo = [n for n in members if not done_of.get(n)]
        mark = "" if todo else "   (all done)"
        lines.append(f"  wave {w}: {', '.join(f'Phase {n}' for n in members)}{mark}")
        if len(todo) > 1:
            lines.append(f"           {len(todo)} can run concurrently — one session each, "
                         f"then --land from the primary tree")
    return "\n".join(lines)


BUILT = re.compile(r"<!--\s*built:\s*([^\s>]+?)\s*-->")
MILESTONE = re.compile(r"^##\s+Milestone\s+(\d+)\s*[—-]\s*(.+)$", re.M)


def phase_blocks(text):
    """(num, title, slug, block) per leaf, in document order. `title` has the built-marker and any
    done tick stripped; `slug` is the marker's value, which /r:plan-run writes when a leaf lands."""
    heads = re.findall(r"^###\s+Phase\s+(\d+)\s*[—-]\s*(.+)$", text, re.M)
    blocks = re.split(r"(?=^###\s+Phase\s+\d+)", text, flags=re.M)[1:]
    out = []
    for (n, raw), b in zip(heads, blocks):
        m = BUILT.search(raw)
        title = " ".join(BUILT.sub("", raw).replace("✅", " ").split())
        out.append((int(n), title, m.group(1) if m else None, b))
    return out


def ticked_items(block):
    """Ticked item text, inner whitespace collapsed. Collapsed rather than byte-identical because a
    rewrite may re-wrap a line -- but the WORDS are the identity, the same rule /r:plan-run uses to
    re-locate an item it is about to tick."""
    return [" ".join(i.split()) for i in re.findall(r"^\s*-\s*\[[xX]\]\s*(.+)$", block, re.M)]


# The `## Resolve first` field contract, duplicated from plan-unblock/scripts/resolve_scope.py on
# purpose: that script is the ENFORCER and this one is the author's mirror of it, and a runtime
# import across two skill directories is more fragile than two lists someone must keep in step.
# Change one, change the other.
RF_FIELDS = ("Owner", "Blocks", "Timebox", "Output", "Resolved", "Alternative", "Outstanding")
RF_LABEL = re.compile(r"\b([A-Z][A-Za-z]{2,}):")


def resolve_first_notes(text):
    """What `/r:plan-run`'s gate will make of each `## Resolve first` entry, said at authoring time.

    The contract is enforced by resolve_scope.py when a run starts, and only there -- so a plan
    could be written, pass this gate, and stop a run a week later on an entry nobody could still
    remember writing. Observed: three entries carrying `Blocks: nothing. Informs: ...` halted a
    fan-out on a plan authored nine days earlier. These are NOTES rather than problems: the same
    text has been valid under an older shape of this contract, and failing a plan already on disk
    over a rule that postdates it would reject documents nobody may rewrite -- an agent is
    forbidden by name from editing this section.
    """
    m = re.search(r"^##\s+Resolve\s+first\b(.*?)(?=^#{1,6}\s|\Z)", text, re.M | re.S | re.I)
    if not m:
        return []
    notes = []
    for chunk in re.split(r"(?=^ {0,1}[-*]\s)", m.group(1), flags=re.M):
        if not chunk.strip() or not re.match(r"^\s*[-*]\s", chunk):
            continue
        flat = " ".join(chunk.split())
        name = (re.search(r"\*\*(.+?)\*\*", flat) or re.match(r"^[-*]\s*(.{0,40})", flat))
        label = (name.group(1) if name else flat[:40]).strip()
        if not re.match(r"^\s*[-*]\s*\[[ xX]\]", chunk):
            notes.append(f"Resolve first {label!r}: a plain bullet, not a '- [ ]' checkbox — "
                         "nothing can tick it as it stands; /r:plan-unblock migrates it to the "
                         "checkbox form and closes it in the same edit")
        found = {mm.group(1).lower(): mm for mm in RF_LABEL.finditer(flat)}
        known = {f.lower() for f in RF_FIELDS}
        for key, mm in found.items():
            if key not in known:
                notes.append(f"Resolve first {label!r}: '{mm.group(1)}:' is not a field of this "
                             f"contract ({', '.join(RF_FIELDS)}) — it is ignored")
        if "owner" not in found:
            notes.append(f"Resolve first {label!r}: no 'Owner:' — nothing says who may close it")
        if "blocks" not in found:
            notes.append(f"Resolve first {label!r}: no 'Blocks:' — it blocks the ENTIRE run list, "
                         "because nothing can tell what it was guarding")
        else:
            marks = sorted(found.values(), key=lambda x: x.start())
            nxt = [x for x in marks if x.start() > found["blocks"].start()]
            end = nxt[0].start() if nxt else len(flat)
            value = flat[found["blocks"].end():end]
            if not re.search(r"(?:Phase\s*)?\d+", value):
                shown = value.strip().rstrip('.').strip()
                notes.append(f"Resolve first {label!r}: 'Blocks: {shown}' names no phase — it "
                             "blocks the ENTIRE run list until /r:plan-unblock settles it")
    return notes


def resolved_entries(text):
    """The subject line of every CLOSED `## Resolve first` entry, whitespace collapsed.

    A resolution is a decision somebody made, and the entry's `Resolved:` line is the only place
    the plan keeps it -- deliberately, because a copy in design.md would be destroyed by the very
    rewrite this function guards. So a closed entry is frozen for the same reason a ticked leaf is:
    dropping it loses the record, and the plan then reads as though the question is still open.
    """
    m = re.search(r"^##\s+Resolve\s+first\b(.*?)(?=^#{1,6}\s|\Z)", text, re.M | re.S | re.I)
    if not m:
        return []
    out = []
    for chunk in re.split(r"(?=^ {0,1}[-*]\s)", m.group(1), flags=re.M):
        if not re.match(r"^\s*[-*]\s*\[[xX]\]", chunk):
            continue
        head = " ".join(chunk.split())
        name = re.search(r"\*\*(.+?)\*\*", head)
        out.append(name.group(1).strip() if name else head[:60])
    return out


def check_against(prev_text, new_text, out):
    """The mechanical guard on the freeze rule.

    A leaf carrying a tick, or a '<!-- built: -->' marker, is the record of work that shipped: its
    number is what '--from N', the branch and the PR all name, and its ticks are what stop
    /r:plan-run rebuilding it. A rewrite may re-split, renumber or drop anything UNBUILT freely --
    that is the point of rewriting -- so this reads only the frozen set, and says nothing about the
    rest.
    """
    kept = {n.lower() for n in resolved_entries(new_text)}
    for name in resolved_entries(prev_text):
        if name.lower() not in kept:
            out(f"a resolved 'Resolve first' entry is gone from the rewrite: {name[:60]!r}. Its "
                f"Resolved: line is the only record of that decision -- carry it over, or the plan "
                f"reads as though nobody ever settled it.")

    prev = phase_blocks(prev_text)
    if not prev:
        # An unnumbered plan (a hand-written backlog) has no leaves to match, but its ticks still
        # record landed work. Check survival globally: the numbering did not exist to preserve.
        survived = set(ticked_items(new_text))
        for it in ticked_items(prev_text):
            if it not in survived:
                out(f"a ticked item from the previous plan is gone: {it[:60]!r}. It records work "
                    f"that landed -- a rewrite carries every tick over, or the plan claims the "
                    f"work is still to do.")
        return

    new = phase_blocks(new_text)
    by_num = {n: (t, b) for n, t, _, b in new}
    by_title, by_slug = {}, {}
    for n, t, slug, _ in new:
        by_title.setdefault(t.lower(), n)
        if slug:
            by_slug[slug] = n

    for n, title, slug, b in prev:
        ticks = ticked_items(b)
        if not ticks and not slug:
            continue                      # unbuilt: free to be re-split, renumbered or dropped
        # Matched on the built marker first, then the title. A frozen leaf that answers to neither
        # is gone -- and a frozen leaf that was merely RETITLED reads exactly the same way, which
        # is correct: both lose the identity '--from N', the branch and the PR body all name, and
        # both are fixed by putting it back.
        if slug and slug in by_slug:
            tgt = by_slug[slug]
        elif title.lower() in by_title:
            tgt = by_title[title.lower()]
        else:
            out(f"Phase {n} — {title}: carries landed work and is gone from the rewrite (dropped, "
                f"or retitled, which is the same loss). A leaf with a tick is frozen: it is the "
                f"record of what shipped, not a proposal.")
            continue
        if tgt != n:
            out(f"Phase {n} — {title}: renumbered to Phase {tgt}. A frozen leaf keeps its number "
                f"-- '--from {n}', the branch and the PR body all name it.")
        nb = by_num[tgt][1]
        kept = ticked_items(nb)
        for it in ticks:
            if it not in kept:
                out(f"Phase {n} — {title}: ticked item {it[:52]!r} is gone or un-ticked in the "
                    f"rewrite. /r:plan-run reads the items to decide what is already built.")
        if slug and not BUILT.search(nb.splitlines()[0]):
            out(f"Phase {n} — {title}: the '<!-- built: {slug} -->' marker was dropped. It is how "
                f"the plan says where the change went.")


def check_design(plan_text, design_p, out):
    """The plan is the spine; the contracts live beside it, one '## Milestone N' section each.

    Nothing MACHINE-readable is in the design file -- /r:task-run lifts a leaf block and never reads
    upward or outward -- so a drift here costs a human reader, never a build. That is exactly why it
    needs checking: nothing else would ever notice.
    """
    if not design_p.exists():
        out(f"missing: {design_p} — the contracts live beside the plan, one '## Milestone N' "
            f"section per milestone")
        return
    plan_ms = {int(n): " ".join(t.split()) for n, t in MILESTONE.findall(plan_text)}
    des_ms = {int(n): " ".join(t.split()) for n, t in
              MILESTONE.findall(design_p.read_text(encoding="utf-8", errors="replace"))}
    if not plan_ms:
        out(f"--design was given but the plan has no '## Milestone N — name' headings to match "
            f"{design_p.name} against")
    for n, t in sorted(plan_ms.items()):
        if n not in des_ms:
            out(f"Milestone {n} — {t}: no '## Milestone {n}' section in {design_p.name}. Its "
                f"leaves were derived from contracts a reader now cannot find.")
        elif des_ms[n].lower() != t.lower():
            out(f"Milestone {n}: the plan calls it {t!r}, {design_p.name} calls it {des_ms[n]!r} "
                f"— one of them was renamed alone.")
    for n, t in sorted(des_ms.items()):
        if n not in plan_ms:
            out(f"{design_p.name} has a '## Milestone {n} — {t}' section with no milestone in the "
                f"plan — contracts for leaves that do not exist.")
    if re.search(r"^\*\*Design\*\*", plan_text, re.M):
        out(f"the plan still carries an inline '**Design**' section while {design_p.name} sits "
            f"beside it — two copies of one contract drift apart silently. Move it.")


def main():
    args = sys.argv[1:]
    if not args:
        print("usage: check_todo.py <todo.md> [--spec <spec.html>] [--design <design.md>] "
              "[--against <previous-todo.md>] [--slice <n,n>]")
        return 2
    todo_p = Path(args[0])
    spec_p, slice_req, design_p, prev_p = None, None, None, None
    if "--slice" in args:
        slice_req = {int(n) for n in re.findall(r"\d+", args[args.index("--slice") + 1])}
    if "--design" in args:
        design_p = Path(args[args.index("--design") + 1])
    if "--against" in args:
        prev_p = Path(args[args.index("--against") + 1])
    if "--spec" in args:
        spec_p = Path(args[args.index("--spec") + 1])
    elif todo_p.parent.joinpath("spec.html").exists():
        spec_p = todo_p.parent / "spec.html"

    if not todo_p.exists():
        print(f"missing: {todo_p}")
        return 1
    t = todo_p.read_text(encoding="utf-8", errors="replace")
    problems, notes = [], []

    def out(msg):
        problems.append(msg)

    def note(msg):
        # Informational, never a defect. A note that counts as a problem makes "clean" unreachable
        # and suppresses everything printed on the clean path.
        notes.append(msg)

    for n in resolve_first_notes(t):
        note(n)

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
    # --- per-phase --------------------------------------------------------------
    blocks = re.split(r"(?=^###\s+Phase\s+\d+)", t, flags=re.M)[1:]
    # Scoped to the PHASE blocks, never the whole file. `## Resolve first` entries carry checkboxes
    # of their own, so a whole-file search would find one there and pass a plan whose leaves have no
    # acceptance criteria at all -- which is the only thing this check was ever about.
    if not re.search(r"^\s*-\s*\[ \]", "".join(blocks), re.M):
        out("no '- [ ]' checkboxes under any phase — /r:task-run reads these as acceptance criteria")
    if not re.search(r"^##\s", t, re.M):
        out("no v1 / Advanced headings")

    created, referenced = set(), []
    deps, files_of, title_of, done_of = {}, {}, {}, {}
    for num, b in zip(nums, blocks):
        title = b.splitlines()[0].strip()
        title_of[num] = title
        files_of[num] = phase_files(b)
        # "done" is every item ticked -- the same rule /r:plan-run uses to skip a leaf, and what
        # --slice reads to decide whether a dependency has actually been built.
        open_items = re.findall(r"^\s*-\s*\[ \]\s*(.+)$", b, re.M)
        done_of[num] = bool(re.search(r"^\s*-\s*\[[xX]\]", b, re.M)) and not open_items
        d = phase_deps(b)
        if d is None:
            out(f"{title}: no 'Depends on' line -- every leaf declares its edges, '—' when it has none. "
                f"Without it the wave graph cannot be built and nothing can run concurrently.")
            deps[num] = set()
        else:
            deps[num] = d
        for it in re.findall(r"^\s*-\s*\[[ xX]\]\s*(.+)$", b, re.M):
            for pat in NOT_SELF_CONTAINED:
                if re.search(pat, it, re.I):
                    out(f"{title}: item defers outside its own block ({it[:48]!r}...). /r:task-run lifts "
                        f"ONLY this block into criteria[] — write the contract into the item itself.")
                    break
        items = open_items
        # A plan under execution is a normal input now -- /r:plan-run ticks as it lands each leaf
        # and re-runs this on the way past. So "no items" means no checkbox of EITHER state; a
        # fully ticked leaf is a finished one, not a defective one.
        if not items and not re.search(r"^\s*-\s*\[[xX]\]", b, re.M):
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

    # --- the graph: edges are authored, waves are derived ------------------------
    known = set(nums)
    for n in nums:
        for d in sorted(deps[n]):
            if d not in known:
                out(f"{title_of[n]}: depends on Phase {d}, which does not exist")
            elif d == n:
                out(f"{title_of[n]}: depends on itself")
            elif d > n:
                # Numeric order has to BE a topological order: it is what lets /r:plan-run run the
                # plan straight down the page and still respect every edge. A backward edge breaks
                # that silently -- the run builds on something it has not built yet.
                out(f"{title_of[n]}: depends on Phase {d}, which comes AFTER it. A leaf may depend "
                    f"only on lower-numbered leaves, so that numeric order is a valid build order.")

    wave, cyclic = compute_waves(deps)
    if cyclic:
        out(f"dependency cycle through phase(s): {', '.join(str(c) for c in sorted(cyclic))}")

    by_wave = {}
    for n in nums:
        by_wave.setdefault(wave.get(n, 0), []).append(n)

    # Two leaves in one wave may run at the same time, in separate worktrees. If they name the
    # same file they cannot -- and the fix is an edge, which pushes one into the next wave.
    # The plan file itself is excluded: every leaf ticks it, so it is shared by construction, and
    # git merges the ticks (they sit in different regions of the document).
    plan_name = todo_p.name
    for w in sorted(by_wave):
        members = sorted(by_wave[w])
        for i, a in enumerate(members):
            for b_ in members[i + 1:]:
                shared = {f for f in files_of[a] & files_of[b_]
                          if Path(f).name != plan_name and comparable(f)}
                if shared:
                    out(f"Phase {a} and Phase {b_} are both in wave {w} but touch {', '.join(sorted(shared))} "
                        f"— they cannot run concurrently. Add a 'Depends on' edge between them.")

    if slice_req is not None:
        # /r:plan-run's preflight. A DIFFERENT question from "is this plan good": these leaves are
        # about to run at the same time in separate worktrees, and only two things make that
        # unsafe. Plan-quality problems collected above are deliberately discarded -- refusing to
        # start concurrent work over a missing 'Implements' line would be noise at the worst moment.
        unsafe = []
        for n in sorted(slice_req):
            if n not in known:
                unsafe.append(f"Phase {n} does not exist in {todo_p.name}")
                continue
            if done_of[n]:
                unsafe.append(f"Phase {n} is already done — nothing to run")
            for d in sorted(deps[n]):
                if d in slice_req:
                    unsafe.append(f"Phase {n} depends on Phase {d}, which is in the same slice — "
                                  f"they cannot run at the same time")
                elif d in known and not done_of[d]:
                    unsafe.append(f"Phase {n} depends on Phase {d}, which is not built yet")
        for i, a in enumerate(sorted(slice_req)):
            for b_ in sorted(slice_req)[i + 1:]:
                if a not in known or b_ not in known:
                    continue
                shared = {f for f in files_of[a] & files_of[b_]
                          if Path(f).name != todo_p.name and comparable(f)}
                if shared:
                    unsafe.append(f"Phase {a} and Phase {b_} both touch {', '.join(sorted(shared))}")
        if unsafe:
            print(f"slice {sorted(slice_req)} is NOT safe to run concurrently:\n")
            for u in unsafe:
                print(f"  - {u}")
            return 1
        n_leaf = len(slice_req)
        print(f"slice {sorted(slice_req)} is safe to run concurrently "
              f"({n_leaf} {'leaf' if n_leaf == 1 else 'leaves'}, no shared files, every dependency built)")
        return 0

    # --- the two files, and the plan this one replaces ---------------------------
    if design_p is not None:
        check_design(t, design_p, out)
    if prev_p is not None:
        if not prev_p.exists():
            out(f"missing: {prev_p} — nothing to compare the rewrite against")
        else:
            check_against(prev_p.read_text(encoding="utf-8", errors="replace"), t, out)

    stated = declared_waves(t)
    if stated is not None:
        computed = {w: set(m) for w, m in by_wave.items()}
        if stated != computed:
            out("the '## Waves' summary does not match the 'Depends on' edges — the summary is "
                "generated from them, so regenerate it rather than editing it by hand. "
                f"computed: {{{', '.join(f'{w}: {sorted(m)}' for w, m in sorted(computed.items()))}}}")

    # --- traceability -----------------------------------------------------------
    # Implements: lines carry story names verbatim, separated by " · ". Matching is exact
    # because a paraphrase is indistinguishable from a story nobody planned.
    stories = spec_stories(spec_p)
    if stories is None:
        note(f"no spec found next to {todo_p.name} — story coverage not checked")
    elif not stories:
        note("the spec has no User stories section with <h3> names — story coverage not checked")
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

    # The wave table prints either way. It is the graph, not a verdict on the plan, and a caller
    # deciding what to run concurrently needs it just as much when the plan has warts.
    if problems:
        print(f"{len(problems)} problem(s) in {todo_p}\n")
        for pr in problems:
            print(f"  - {pr}")
    else:
        print(f"clean — {todo_p} ({len(blocks)} phases)")
    for n in notes:
        print(f"  note: {n}")
    print(wave_table(by_wave, done_of, files_of, todo_p.name))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
