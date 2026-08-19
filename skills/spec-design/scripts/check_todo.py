#!/usr/bin/env python3
"""Check a generated todo.md for the defects a read-through misses.

    python3 check_todo.py docs/<topic>/todo.md [--spec docs/<topic>/spec.html]
    python3 check_todo.py docs/<topic>/todo.md --slice 5,9

With --spec, also checks that every user story in the spec reaches a phase.
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


def main():
    args = sys.argv[1:]
    if not args:
        print("usage: check_todo.py <todo.md> [--spec <spec.html>] [--slice <n,n>]")
        return 2
    todo_p = Path(args[0])
    spec_p, slice_req = None, None
    if "--slice" in args:
        slice_req = {int(n) for n in re.findall(r"\d+", args[args.index("--slice") + 1])}
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
                shared = {f for f in files_of[a] & files_of[b_] if Path(f).name != plan_name}
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
                shared = {f for f in files_of[a] & files_of[b_] if Path(f).name != todo_p.name}
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
