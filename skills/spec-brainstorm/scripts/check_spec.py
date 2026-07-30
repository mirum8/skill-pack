#!/usr/bin/env python3
"""Check a generated spec.html / architecture.html pair for the defects a read-through misses.

    python3 check_spec.py docs/<topic>/

Exit 0 when clean, 1 when anything is reported. Every check here is mechanical; judgment
calls (is this proportionate? does the domain section explain the domain?) stay with the model.
"""
import html
import re
import sys
from pathlib import Path

# (pattern, case_sensitive). TODO/FIXME/XXX are conventionally shouted, and matching them
# case-insensitively would flag every mention of the file "todo.md".
PLACEHOLDERS = [(r"\bTBD\b", True), (r"\bTODO\b(?!\.md)", True), (r"\bFIXME\b", True), (r"\bXXX\b", True),
                (r"your-app", False), (r"example\.com", False), (r"lorem ipsum", False),
                (r"<your[- ]", False), (r"\[insert\b", False)]
FILLER = ["robust", "seamless", "leverage", "cutting-edge", "best practices", "as needed",
          "streamline", "state-of-the-art", "world-class"]
TAG = re.compile(r"\[(verified|likely|unverified|assumption)\b([^\]]*)\]", re.I)
FILEISH = re.compile(r"\b[\w][\w./-]*\.(?:java|kt|kts|py|ts|tsx|js|jsx|sql|go|rb|rs|cs|php|"
                     r"yaml|yml|xml|json|gradle|toml|md|html|css|tf|proto)\b(:\d+)?")


def strip(h):
    h = re.sub(r"<script\b.*?</script>", " ", h, flags=re.S | re.I)
    h = re.sub(r"<style\b.*?</style>", " ", h, flags=re.S | re.I)
    return html.unescape(re.sub(r"<[^>]+>", " ", h))


def check_tags(prose, lines, out):
    """research.md §3: every third-party claim carries exactly one confidence tag. The tags are a
    convention rather than a slot, so they degrade as the document grows — which is what this counts."""
    tags = [(m.group(1).lower(), m.group(2)) for m in TAG.finditer(prose)]
    cites_third_parties = re.search(r"prior art|candidates|comparison matrix", prose, re.I)

    if cites_third_parties and not tags:
        out("spec.html", "no confidence tags anywhere — every price, limit, version or third-party claim "
                         "carries one of [verified: <url>, read <date>] / [likely: …] / [unverified] / "
                         "[assumption]. See research.md §3")
    elif tags and lines > 800 and len(tags) < 5:
        out("spec.html", f"only {len(tags)} confidence tag(s) in a {lines}-line spec — the tagging almost "
                         f"certainly stopped partway; re-check every section that names a product")

    # research.md §3: [verified: <url>, read <date>]. A bare domain is a fine citation, a product name
    # is not — enumerating TLDs loses, so accept any dotted host-or-path shape.
    sourced = re.compile(r"https?://|\b[\w-]+\.[a-z]{2,}(?:\.[a-z]{2,})*(?:/|\b)", re.I)
    verified = [r for k, r in tags if k == "verified"]
    unsourced = [r for r in verified if not sourced.search(r)]
    undated = [r for r in verified if sourced.search(r) and not re.search(r"\d{4}-\d{2}-\d{2}", r)]
    if unsourced:
        out("spec.html", f"{len(unsourced)} [verified …] tag(s) name no source, e.g. "
                         f"[verified{unsourced[0][:60]}] — verified means you fetched a url this session; "
                         f"downgrade to [likely: …] if you didn't")
    if undated:
        out("spec.html", f"{len(undated)} [verified …] tag(s) have a url but no read date, e.g. "
                         f"[verified{undated[0][:60]}] — the date is what tells a reader the price or limit "
                         f"has since moved")
    if [r for k, r in tags if k == "likely" and len(r.strip(" :—-")) < 3]:
        out("spec.html", "[likely] with no stated inference — write [likely: <what you reasoned from>]")


def check_requirements(prose, ids, out):
    """The v1 line and the FR ids are the contract with /r:spec-plan: it orders phases against them."""
    if not re.search(r"\bv1\b", prose, re.I):
        out("spec.html", "no v1 line — say which FR ids are must-have for a first working version; "
                         "/r:spec-plan has nothing to order phases against without it")

    # A requirement is *stated* in EARS form, so 'shall' follows its id. An id that never has one is
    # referenced (in the v1 line, a traceability row, a diagram) but defined nowhere.
    stated = {m.group(1) for m in re.finditer(r"\bFR-(\d+)\b", prose)
              if re.search(r"\bshall\b", prose[m.end():m.end() + 300], re.I)}
    dangling = sorted(set(ids.get("FR", [])) - stated, key=int)
    if ids.get("FR") and dangling:
        out("spec.html", f"{', '.join('FR-' + d for d in dangling)}: no requirement stated with 'shall' — "
                         f"either the id is referenced (v1 line, traceability, a diagram) but defined nowhere, "
                         f"or the requirement is not in EARS form. See spec-sections.md §9")

    # interview.md §9: an open question without a default is a decision nobody can make later. The
    # mandated field name settles it for a whole table at once — a column header sits above its rows,
    # not beside them, so only fall back to per-id proximity when the field name is absent entirely.
    oqs = {m.group(1) for m in re.finditer(r"\bOQ-(\d+)\b", prose)}
    if oqs and not re.search(r"default if unanswered", prose, re.I):
        defaulted = {m.group(1) for m in re.finditer(r"\bOQ-(\d+)\b", prose)
                     if re.search(r"default", prose[m.end():m.end() + 400], re.I)}
        undefaulted = sorted(oqs - defaulted, key=int)
        if undefaulted:
            out("spec.html", f"open question(s) with no default: "
                             f"{', '.join('OQ-' + q for q in undefaulted)} — every open question carries a "
                             f"'Default if unanswered', or it is a decision nobody can make later")


def check_codebase_facts(t, out):
    """interview.md §6: no claim about the existing system enters the spec without a path:line citation."""
    blk = re.search(r"Codebase facts(.*?)(?=<h[123]\b|\Z)", t, re.S | re.I)
    if not blk:
        return
    hits = FILEISH.findall(strip(blk.group(1)))
    cited = [h for h in hits if h]
    if len(hits) >= 4 and len(cited) * 2 < len(hits):
        out("spec.html", f"Codebase facts cites {len(hits)} file(s) but only {len(cited)} with a line number — "
                         f"a claim about existing code needs path:line, or it is an open question, not a fact")


def check_spec(t, out):
    if not t:
        return
    prose = strip(t)

    if re.search(r"<script\b", t, re.I):
        out("spec.html", "contains a <script> — the spec is static; interactivity belongs in architecture.html")
    for bad in ("html.dark", "localStorage", "themeToggle"):
        if bad in t:
            out("spec.html", f"contains `{bad}` — the spec is light-mode only")
    for v in re.findall(r"--(?:bg|ink|body|muted|line-soft|surface2|zone|zone-line)\b", t):
        out("spec.html", f"uses the diagram palette name `--{v}` — use the document names here")
        break

    for pat, cased in PLACEHOLDERS:
        for m in re.finditer(pat, prose, 0 if cased else re.I):
            ctx = " ".join(prose[max(0, m.start() - 50):m.end() + 50].split())
            out("spec.html", f"placeholder text: …{ctx}…")
            break
    for w in FILLER:
        n = len(re.findall(rf"\b{re.escape(w)}\b", prose, re.I))
        if n:
            out("spec.html", f"filler word '{w}' x{n} — replace with a number, a name, or a decision")

    if not re.search(r'href="architecture\.html"', t):
        out("spec.html", "does not link to architecture.html")
    for m in re.finditer(r'href="(\./|\.\./|file://|/)[^"]*"', t):
        out("spec.html", f"non-relative cross-link {m.group(0)} — use a bare filename")
        break

    # A technology used by the design should carry a version. Require 2+ mentions so a
    # technology named once as a rejected alternative isn't flagged.
    for tech in ["PostgreSQL", "Postgres", "MySQL", "SQLite", "Redis", "Kafka", "Node", "Python", "Java",
                 "Spring Boot", "Django", "Flask", "React", "Nginx", "Caddy", "Docker"]:
        if len(re.findall(rf"\b{tech}\b", prose)) >= 2 and not re.search(rf"\b{tech}\b[^.\n]{{0,24}}\d", prose):
            out("spec.html", f"'{tech}' is used but never versioned — pin it")

    ids = {}
    for pre in ("FR", "NFR", "ADR", "BR", "R", "OQ"):
        ids[pre] = sorted(set(re.findall(rf"\b{pre}-(\d+)\b", prose)))
    if not ids["FR"]:
        out("spec.html", "no FR- requirement ids found — the todo and the tests have nothing to point at")
    # Only a real leading zero is padding. FR-9 next to FR-10 is just counting past nine.
    for pre in ids:
        if re.search(rf"\b{pre}-0\d", prose):
            out("spec.html", f"{pre}- ids are zero-padded ({pre}-07) — use the bare form ({pre}-7)")

    check_tags(prose, t.count("\n") + 1, out)
    check_requirements(prose, ids, out)
    check_codebase_facts(t, out)
    return ids


def check_arch(t, out):
    if not t:
        return
    for name, ok in (("html.dark block", re.search(r"html\.dark\s*\{", t)),
                     ("theme toggle", "themeToggle" in t),
                     ("localStorage persistence", "localStorage" in t)):
        if not ok:
            out("architecture.html", f"missing {name}")
    si, ti = t.find("<script"), t.find("<style")
    if si == -1 or (ti != -1 and si > ti):
        out("architecture.html", "theme script must come before <style> in <head>, or the page flashes white")
    if re.search(r"--ivory|--gray-\d", t):
        out("architecture.html", "uses document palette names (--ivory/--gray-*) — use the diagram names")

    m = re.search(r"<svg\b.*?</svg>", t, re.S)
    if not m:
        out("architecture.html", "no inline <svg>")
        return
    svg = m.group(0)

    n = len(re.findall(r"(?<!&)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z-])", svg))
    if n:
        out("architecture.html", f"{n} hard-coded hex colour(s) inside the <svg> — the diagram won't follow the theme")
    if re.search(r'fill="var\(--', svg):
        out("architecture.html", 'fill="var(--…)" does not resolve — write style="fill: var(--…)"')

    # Scope to the animated rule: the dasharray that matters is the one on the .lit edge,
    # not the dashed zone border or the .edge.dash variant.
    lit = re.search(r"\.lit\s*\{[^}]*\}", t, re.S)
    da = re.search(r"stroke-dasharray:\s*(\d+)\s+(\d+)", lit.group(0)) if lit else None
    do = re.search(r"stroke-dashoffset:\s*-(\d+)", t)
    if da and do and int(da.group(1)) + int(da.group(2)) != int(do.group(1)):
        out("architecture.html", f"marching ants stutter: lit-edge dash {da.group(1)}+{da.group(2)} "
                                 f"must equal dashoffset {do.group(1)}")

    svg_ids = set(re.findall(r'id="(e-[^"]+)"', svg))
    data_ks = set(re.findall(r'data-k="([^"]+)"', svg))
    fe, fn = set(), set()
    fl = re.search(r"FLOWS\s*=\s*\{(.*?)\n\s*\};", t, re.S)
    if fl:
        for b in re.findall(r"edges:\s*\[(.*?)\]", fl.group(1), re.S):
            fe |= set(re.findall(r'"([^"]+)"', b))
        for b in re.findall(r"nodes:\s*\[(.*?)\]", fl.group(1), re.S):
            fn |= set(re.findall(r'"([^"]+)"', b))
    dk = set()
    dt = re.search(r"DETAIL\s*=\s*\{(.*?)\n\s*\};", t, re.S)
    if dt:
        dk = set(re.findall(r"^\s*([A-Za-z0-9_]+)\s*:", dt.group(1), re.M))
    if fe - svg_ids:
        out("architecture.html", f"FLOWS edge ids not in the SVG (they light nothing, silently): {sorted(fe - svg_ids)}")
    if fn - data_ks:
        out("architecture.html", f"FLOWS node keys with no data-k: {sorted(fn - data_ks)}")
    if data_ks - dk:
        out("architecture.html", f"nodes with no DETAIL entry (clicking does nothing): {sorted(data_ks - dk)}")


BASE_ROWS = ["users-and-job", "core-flow", "scale", "data", "stack-and-constraints",
             "distribution", "anti-scope", "v1-line"]
DEPTH_ROWS = {"standard": ["integrations", "failure-behaviour", "operations", "rollout"],
              "enterprise": ["integrations", "failure-behaviour", "operations", "rollout",
                             "regulator", "retention-and-residency", "audit", "cutover", "on-call"]}


# A row is settled by one of these. The first four say someone or something told you, and each
# owes an evidence clause; `assumed` says you decided it, which is honest and still unfinished.
EVIDENCED = ("answered", "repo", "research", "n/a")
UNSETTLED = ("assumed", "open")


def split_row(rest):
    """'answered (round 3) — they run it themselves' -> ('answered', 'they run it themselves')."""
    rest = rest.replace("*", "").strip()  # ledgers get written with bold/italic emphasis
    m = re.match(r"(n/a|[a-z-]+)\s*(\([^)]*\))?\s*[—–:-]*\s*(.*)$", rest, re.I)
    if not m:
        return rest.strip().lower(), ""
    return m.group(1).lower(), m.group(3).strip()


def check_interview(t, ids, out):
    """The interview ends on coverage or an explicit stop — never on a question count.
    So this checks the coverage ledger, not how many questions were asked."""
    if not t:
        out("interview-notes.md", "missing — no record of what was covered or assumed")
        return
    m = re.search(r"^depth:\s*(\w+)", t, re.M)
    depth = m.group(1).lower() if m else "standard"
    expected = BASE_ROWS + DEPTH_ROWS.get(depth, [])

    block = re.search(r"^##\s*Coverage\s*$(.*?)(?=^##\s|\Z)", t, re.M | re.S)
    if not block:
        out("interview-notes.md", "no '## Coverage' block — nothing records which floor rows were covered")
        return
    rows = {r: split_row(rest) for r, rest in
            re.findall(r"^\s*-\s*([a-z0-9-]+)\s*:\s*(.+?)\s*$", block.group(1), re.M)}

    missing = [r for r in expected if r not in rows]
    if missing:
        out("interview-notes.md", f"coverage rows never recorded at {depth} depth: {', '.join(missing)}")

    answers = re.search(r"^##\s*Answers\s*$(.*?)(?=^##\s|\Z)", t, re.M | re.S)
    answers = answers.group(1).lower() if answers else ""

    def traced(row):
        """Evidence can live on the row, or under ## Answers as a logged answer."""
        return any(w in answers for w in row.split("-") if len(w) >= 4)

    unevidenced = []
    for r, (verdict, evidence) in sorted(rows.items()):
        if verdict not in EVIDENCED + UNSETTLED:
            out("interview-notes.md",
                f"row '{r}' has an unrecognised verdict '{verdict}' — use answered | repo | research | "
                f"n/a | assumed | open")
        elif verdict in EVIDENCED and len(evidence) < 8 and not traced(r):
            unevidenced.append(f"{r} ({verdict})")
    if unevidenced:
        out("interview-notes.md",
            f"nothing records how these rows were settled — no evidence on the row, nothing under "
            f"## Answers: {', '.join(unevidenced)}. Write the evidence after a dash (their answer, a "
            f"path:line, the source, or why it doesn't apply), or mark the row 'assumed' so "
            f"/r:spec-brainstorm --continue knows to offer the decision back")

    status = re.search(r"^status:\s*([\w-]+)", t, re.M)
    status = status.group(1).lower() if status else ""
    unfinished = sorted(r for r, (v, _) in rows.items() if v in UNSETTLED)
    if unfinished and status not in ("generated-partial", "interviewing"):
        out("interview-notes.md",
            f"rows still open or assumed ({', '.join(unfinished)}) but status is '{status or 'unset'}' — set "
            f"status: generated-partial so /r:spec-brainstorm --continue can find this, or settle the rows")

    oq = len({n for n in re.findall(r"\bOQ-(\d+)\b", t)} | set((ids or {}).get("OQ", [])))
    answerable = len([r for r, (v, _) in rows.items() if v in EVIDENCED])
    if oq and answerable and oq > max(2, answerable // 2):
        out("interview-notes.md",
            f"{oq} open questions against {answerable} covered rows — anything the user could answer "
            f"in one line belongs in the interview, not the open-questions table")


def main():
    d = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    if not d.is_dir():
        print(f"not a directory: {d}")
        return 2

    problems = []

    def out(f, msg):
        problems.append((f, msg))

    def read(n):
        p = d / n
        return p.read_text(encoding="utf-8", errors="replace") if p.exists() else ""

    spec, arch = read("spec.html"), read("architecture.html")
    if not spec:
        out("spec.html", "missing")

    ids = check_spec(spec, out)
    if arch:
        check_arch(arch, out)
    check_interview(read("interview-notes.md"), ids, out)

    if not problems:
        print(f"clean — {d}")
        return 0
    print(f"{len(problems)} problem(s) in {d}\n")
    cur = None
    for f, msg in problems:
        if f != cur:
            print(f"  {f}")
            cur = f
        print(f"    - {msg}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
