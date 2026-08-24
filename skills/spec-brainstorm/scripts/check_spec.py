#!/usr/bin/env python3
"""Check a generated spec.html for the defects a read-through misses.

    python3 check_spec.py docs/<topic>/

Exit 0 when clean, 1 when anything is reported. Every check here is mechanical; judgment
calls (is this proportionate? does the domain model explain the domain?) stay with the model.
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
TECH = ["PostgreSQL", "Postgres", "MySQL", "SQLite", "Redis", "Kafka", "RabbitMQ", "Node", "Python",
        "Java", "Spring Boot", "Django", "Flask", "FastAPI", "React", "Vue", "Nginx", "Caddy",
        "Docker", "Kubernetes", "Terraform"]
TAG = re.compile(r"\[(verified|likely|unverified|assumption)\b([^\]]*)\]", re.I)

# The seven parts, in the order sections.md §1 fixes them. Matched on a keyword rather than the
# full title so a document may say "Domain model" or "The decisions" without failing; the order
# is what is actually being checked, because the order is what makes the document readable
# top-down. A part is never dropped — only shortened — so a missing one is a real report.
PARTS = [("business requirement", "Business requirements"), ("domain", "Domain"),
         ("characteristic", "Architectural characteristics"), ("component", "Logical components"),
         ("style", "Architectural style"), ("decision", "Decisions"),
         ("technical detail", "Technical details")]

# Adjectives that are not measurements. Flagged only inside Part 3 and only in a row carrying no
# digit at all — that part's entire job is turning "fast" into "repaint under 16 ms", and a row
# with a number beside the word is doing exactly that. Deliberately excludes the -ility nouns
# (availability, scalability): those are characteristic *names* and belong in the first column.
ADJ = re.compile(r"\b(fast|quick|snappy|instant|scalable|secure|reliable|responsive|"
                 r"performant|lightweight|flexible|easy)\b", re.I)
FILEISH = re.compile(r"\b[\w][\w./-]*\.(?:java|kt|kts|py|ts|tsx|js|jsx|sql|go|rb|rs|cs|php|"
                     r"yaml|yml|xml|json|gradle|toml|md|html|css|tf|proto)\b(:\d+)?")

# The document's ceiling: modules, technologies, stories, API. Anything below it belongs to
# /r:spec-design's design pass (schema, signatures, boundaries) or to /r:task-run. Its arrival
# here is what turns a design doc into a bad schema: decided before the build order exists, so
# without knowing which decisions are even shared between the units that will use them.
BELOW_CEILING = [(r"\bVARCHAR\s*\(", "column types"), (r"\bNOT NULL\b", "column constraints"),
                 (r"\bCREATE\s+(TABLE|INDEX)\b", "DDL"), (r"\bALTER\s+TABLE\b", "DDL"),
                 (r"\bPhase\s+\d+\s*[—–:-]", "build phases")]


def strip(h):
    h = re.sub(r"<script\b.*?</script>", " ", h, flags=re.S | re.I)
    h = re.sub(r"<style\b.*?</style>", " ", h, flags=re.S | re.I)
    return html.unescape(re.sub(r"<[^>]+>", " ", h))


def section(t, *words):
    """The HTML between the <h2> matching `words` and the next <h2>.

    Words are tried in priority order, not document order: "Scope edges" must not win the
    v1 lookup just because it appears above "The v1 line"."""
    heads = [(m.start(), m.end(), strip(m.group(1)).lower()) for m in
             re.finditer(r"<h2\b[^>]*>(.*?)</h2>", t, re.S | re.I)]
    for w in words:
        for i, (_, end, title) in enumerate(heads):
            if w in title:
                nxt = heads[i + 1][0] if i + 1 < len(heads) else len(t)
                return t[end:nxt]
    return ""


def part(t, word):
    """The HTML of one whole part — its <h2 class="part"> to the next one.

    Not the same unit as section(): a part heading is immediately followed by its first section
    heading, so section() on a part title returns only its lede. Everything Parts 3, 4 and 6 are
    checked for lives below that."""
    heads = [(m.start(), m.end(), strip(m.group(2)).lower())
             for m in re.finditer(r"<h2\b([^>]*)>(.*?)</h2>", t, re.S | re.I)
             if re.search(r'class="[^"]*\bpart\b', m.group(1), re.I)]
    for i, (_, end, title) in enumerate(heads):
        if word in title:
            nxt = heads[i + 1][0] if i + 1 < len(heads) else len(t)
            return t[end:nxt]
    return ""


def cells(row):
    return [strip(c) for c in re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", row, re.S | re.I)]


def check_parts(t, out):
    """sections.md §1: seven parts, always all seven, always in this order.

    The order is the deliverable — each part is the summary of the one below it, so a reordered
    document is not a stylistic variant, it is one a reader cannot stop reading partway through."""
    found = [strip(m.group(2)).lower().strip()
             for m in re.finditer(r"<h2\b([^>]*)>(.*?)</h2>", t, re.S | re.I)
             if re.search(r'class="[^"]*\bpart\b', m.group(1), re.I)]
    if not found:
        out("spec.html", 'no parts — the document is written as seven <h2 class="part"> parts in '
                         'this order: ' + " · ".join(n for _, n in PARTS) + ". See sections.md §1")
        return
    missing, out_of_order, i = [], [], 0
    for word, name in PARTS:
        at = next((j for j, title in enumerate(found) if word in title), None)
        if at is None:
            missing.append(name)
        elif at < i:
            out_of_order.append(name)
        else:
            i = at
    if missing:
        out("spec.html", f"part(s) missing: {', '.join(missing)} — a part is shortened to three "
                         f"sentences, never dropped; a missing one reads exactly like a question "
                         f"nobody asked")
    if out_of_order:
        out("spec.html", f"part(s) out of order: {', '.join(out_of_order)} — the order is "
                         f"{' → '.join(n for _, n in PARTS)}, and it is what lets a reader stop "
                         f"at any part boundary with a true picture")
    noid = [strip(m.group(2)) for m in re.finditer(r"<h2\b([^>]*)>(.*?)</h2>", t, re.S | re.I)
            if re.search(r'class="[^"]*\bpart\b', m.group(1), re.I)
            and not re.search(r'\bid="', m.group(1), re.I)]
    if noid:
        out("spec.html", f"part heading(s) with no id: {', '.join(noid[:3])} — every <h2> carries "
                         f"one, because the contents list is the only navigation this document has")


def check_nav(t, out):
    """html.md §4: one contents list, in the sidebar, all links, every anchor resolving.

    A several-thousand-word document whose contents is plain text tells a reader what exists and
    then makes them scroll for it anyway — which is most of what makes a long spec read as a wall.
    The sidebar is checked for because a run that drops it usually drops the contents entirely
    rather than falling back to an inline list."""
    ids = set(re.findall(r'\bid="([^"]+)"', t))
    dead = sorted({a for a in re.findall(r'href="#([^"]+)"', t) if a not in ids})
    if dead:
        out("spec.html", f"anchor(s) pointing at no id: {', '.join('#' + d for d in dead[:4])} — "
                         f"this document is one file, so a dead anchor goes nowhere at all")

    if not re.search(r'class="[^"]*\bsidenav\b', t, re.I):
        out("spec.html", 'no contents sidebar — html.md §4 wants a <nav class="sidenav"> holding '
                         'the one contents list, sticky on screen and un-stuck for print')
    toc = re.search(r'<(ol|ul)\b[^>]*class="[^"]*\btoc\b[^"]*"[^>]*>(.*?)</\1>', t, re.S | re.I)
    if not toc:
        out("spec.html", 'no contents list — html.md §4 wants one <ol class="toc"> of linked parts '
                         'and sections, inside the sidebar')
        return
    items = len(re.findall(r"<li\b", toc.group(2), re.I))
    links = len(re.findall(r'<a\b[^>]*href="#', toc.group(2), re.I))
    if links < items:
        out("spec.html", f"{items - links} of {items} contents entries are not links — a contents "
                         f"list that cannot be clicked is a list of names")
    elif links < 7:
        out("spec.html", f"the contents list has {links} link(s) — all seven parts belong in it")


def check_characteristics(t, out):
    """sections.md §5: at most three driving characteristics, every one of them a number."""
    blk = part(t, "characteristic")
    if not blk:
        return
    driving = re.findall(r'<tr\b[^>]*class="[^"]*\bdriving\b[^"]*"[^>]*>', blk, re.I)
    if not driving:
        out("spec.html", 'no <tr class="driving"> rows in Architectural characteristics — mark the '
                         'two or three that win an argument; the class is how they are counted')
    elif len(driving) > 3:
        out("spec.html", f"{len(driving)} driving characteristics — three is the ceiling. A longer "
                         f"list says nothing and licenses everything below it, because every later "
                         f"decision can point at whichever one suits it")
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", blk, re.S | re.I):
        text = " ".join(strip(row).split())
        m = ADJ.search(text)
        if m and not re.search(r"\d", text):
            out("spec.html", f"characteristic row says '{m.group(1)}' and carries no number: "
                             f"…{text[:90]}… — this is the part whose job is turning an adjective "
                             f"into a target and a way to measure it")
            break


def check_components(t, out):
    """sections.md §6: ownership is exclusive. Two components writing one entity is the defect
    this part exists to prevent, and it is invisible on a read-through of a ten-row table."""
    blk = part(t, "component")
    if not blk:
        return
    rows = re.findall(r"<tr\b[^>]*>(.*?)</tr>", blk, re.S | re.I)
    head = next((r for r in rows if re.search(r"<th\b", r, re.I)), None)
    col = next((i for i, c in enumerate(cells(head)) if "owns" in c.lower()), None) if head else None
    if col is None:
        out("spec.html", "the components table has no 'Owns' column — naming the entities each "
                         "component writes is what this part is for; without it the cut is a "
                         "list of nouns")
        return
    owners = {}
    for row in rows:
        if re.search(r"<th\b", row, re.I):
            continue
        c = re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", row, re.S | re.I)
        if len(c) <= col:
            continue
        who = strip(c[0]).strip()
        for ent in re.findall(r"<code\b[^>]*>(.*?)</code>", c[col], re.S | re.I):
            owners.setdefault(strip(ent).strip(), []).append(who)
    shared = {e: w for e, w in owners.items() if len(set(w)) > 1}
    if shared:
        e, w = sorted(shared.items())[0]
        out("spec.html", f"`{e}` is owned by {' and '.join(sorted(set(w)))} — ownership is "
                         f"exclusive; two components writing one entity is either a merge or a "
                         f"boundary in the wrong place")


def check_adrs(t, out):
    """sections.md §8: Part 6 is the only place a 'why' is argued, so every ADR the rest of the
    document points at has to exist, and every ADR has to have had a live alternative."""
    blk = part(t, "decision")
    if not blk:
        return
    defined, missing_alt = [], []
    heads = [(m.start(), strip(m.group(1)).strip()) for m in
             re.finditer(r"<h3\b[^>]*>(.*?)</h3>", blk, re.S | re.I)]
    bounds = [h[0] for h in heads] + [len(blk)]
    for (_, title), a, b in zip(heads, bounds, bounds[1:]):
        m = re.match(r"ADR-(\d+)\b", title)
        if not m:
            continue
        defined.append(m.group(1))
        if not re.search(r"alternativ", strip(blk[a:b]), re.I):
            missing_alt.append(f"ADR-{m.group(1)}")
    if not defined:
        out("spec.html", "the Decisions part carries no ADR — each is an <h3> reading "
                         "'ADR-<n> — <title>'. If the interview's ## Decisions log was empty, say "
                         "so here rather than leaving the part shaped like an oversight")
        return
    dupes = sorted({n for n in defined if defined.count(n) > 1})
    if dupes:
        out("spec.html", f"duplicate ADR number(s): {', '.join('ADR-' + d for d in dupes)} — the "
                         f"number is what every other part points at")
    undefined = sorted({n for n in re.findall(r"\bADR-(\d+)\b", strip(t))} - set(defined), key=int)
    if undefined:
        out("spec.html", f"{', '.join('ADR-' + n for n in undefined[:4])} referenced but never "
                         f"written — a row that points at a missing ADR states a decision and "
                         f"hides its reason, which is worse than inlining the reason")
    if missing_alt:
        out("spec.html", f"{', '.join(missing_alt[:4])} has no Alternatives field — a decision "
                         f"with no live alternative was a default, and belongs in the Technologies "
                         f"table with one clause of why")


def check_stories(t, out):
    """Story names are the handle /r:spec-design builds phases against, so they have to be
    findable and each has to say when it is done."""
    blk = section(t, "user stor", "stories")
    if not blk:
        out("spec.html", "no 'User stories' section — /r:spec-design has nothing to build phases "
                         "against, and the v1 line has nothing to name")
        return []

    names = [strip(m.group(1)).strip() for m in re.finditer(r"<h3\b[^>]*>(.*?)</h3>", blk, re.S | re.I)]
    if not names:
        out("spec.html", "User stories section has no <h3> story names — each story is an <h3> "
                         "whose text is its handle. See sections.md §3")
        return []

    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        out("spec.html", f"duplicate story name(s): {', '.join(dupes)} — a name is a handle and "
                         f"must be unique, or an Implements: line points at two things")

    # Each story's block runs to the next <h3>. Acceptance criteria are what make it checkable.
    starts = [m.start() for m in re.finditer(r"<h3\b", blk, re.I)] + [len(blk)]
    for name, a, b in zip(names, starts, starts[1:]):
        body = strip(blk[a:b])
        if not (re.search(r"\bgiven\b", body, re.I) and re.search(r"\bthen\b", body, re.I)):
            out("spec.html", f"story '{name}' has no acceptance criteria — every story carries "
                             f"Given/When/Then, or it is a wish")
    return names


def check_v1(t, names, out):
    blk = section(t, "v1", "scope")
    if not blk:
        out("spec.html", "no v1 section — say which stories ship first; /r:spec-design has nothing "
                         "to order phases against without it")
        return
    prose = strip(blk)
    named = [n for n in names if n and n.lower() in prose.lower()]
    if names and not named:
        out("spec.html", "the v1 section names no story — it must say which stories ship first "
                         "and which are deferred, by name")
    # A name in the v1 line that no story defines is a phase pointing at nothing.
    quoted = {strip(m.group(1)).strip() for m in re.finditer(r"<(?:strong|b|code)\b[^>]*>(.*?)</(?:strong|b|code)>",
                                                             blk, re.S | re.I)}
    unknown = sorted(q for q in quoted if len(q) > 8 and q not in names
                     and not re.search(r"\d", q) and " " in q)
    if unknown:
        out("spec.html", f"v1 section names something no story defines: {', '.join(unknown[:4])} "
                         f"— every name here matches a story <h3> exactly")


def check_tags(prose, lines, out):
    """research.md §3: under --explain every third-party claim carries exactly one confidence
    tag. Tags are a convention rather than a slot, so they degrade as the document grows."""
    tags = [(m.group(1).lower(), m.group(2)) for m in TAG.finditer(prose)]
    if not tags:
        out("spec.html", "research ran but the document carries no confidence tags — every price, "
                         "limit, version or third-party claim carries one of [verified: <url>, read "
                         "<date>] / [likely: …] / [unverified] / [assumption]. See research.md §3")
        return
    if lines > 800 and len(tags) < 5:
        out("spec.html", f"only {len(tags)} confidence tag(s) in a {lines}-line document — the "
                         f"tagging almost certainly stopped partway; re-check every section that "
                         f"names a product")

    sourced = re.compile(r"https?://|\b[\w-]+\.[a-z]{2,}(?:\.[a-z]{2,})*(?:/|\b)", re.I)
    verified = [r for k, r in tags if k == "verified"]
    unsourced = [r for r in verified if not sourced.search(r)]
    undated = [r for r in verified if sourced.search(r) and not re.search(r"\d{4}-\d{2}-\d{2}", r)]
    if unsourced:
        out("spec.html", f"{len(unsourced)} [verified …] tag(s) name no source, e.g. "
                         f"[verified{unsourced[0][:60]}] — verified means you fetched a url this "
                         f"session; downgrade to [likely: …] if you didn't")
    if undated:
        out("spec.html", f"{len(undated)} [verified …] tag(s) have a url but no read date, e.g. "
                         f"[verified{undated[0][:60]}] — the date is what tells a reader the price "
                         f"or limit has since moved")
    if [r for k, r in tags if k == "likely" and len(r.strip(" :—-")) < 3]:
        out("spec.html", "[likely] with no stated inference — write [likely: <what you reasoned from>]")


def check_codebase_facts(t, out):
    """interview.md §7: no claim about the existing system enters the document without path:line."""
    blk = re.search(r"Codebase facts(.*?)(?=<h[123]\b|\Z)", t, re.S | re.I)
    if not blk:
        return
    hits = FILEISH.findall(strip(blk.group(1)))
    cited = [h for h in hits if h]
    if len(hits) >= 4 and len(cited) * 2 < len(hits):
        out("spec.html", f"Codebase facts cites {len(hits)} file(s) but only {len(cited)} with a "
                         f"line number — a claim about existing code needs path:line, or it is an "
                         f"open question, not a fact")


def check_spec(t, explained, out):
    if not t:
        return []
    prose = strip(t)

    if re.search(r"<script\b", t, re.I):
        out("spec.html", "contains a <script> — the document is static and must print")
    for bad in ("html.dark", "localStorage"):
        if bad in t:
            out("spec.html", f"contains `{bad}` — the document is light-mode only, with no script")

    for pat, cased in PLACEHOLDERS:
        for m in re.finditer(pat, prose, 0 if cased else re.I):
            ctx = " ".join(prose[max(0, m.start() - 50):m.end() + 50].split())
            out("spec.html", f"placeholder text: …{ctx}…")
            break
    for w in FILLER:
        n = len(re.findall(rf"\b{re.escape(w)}\b", prose, re.I))
        if n:
            out("spec.html", f"filler word '{w}' x{n} — replace with a number, a name, or a decision")

    for pat, what in BELOW_CEILING:
        if re.search(pat, prose, re.I):
            out("spec.html", f"{what} in the document — that is below its ceiling; modules, "
                             f"technologies, stories and the API are as low as this goes")

    # This is one self-contained file. Any local link is dead or points at something unwritten.
    for m in re.finditer(r'href="(?!https?:|mailto:|#)([^"]+)"', t):
        out("spec.html", f"local link href=\"{m.group(1)}\" — spec.html is the only file; there is "
                         f"nothing beside it to link to")
        break

    # A technology the design uses should carry a version. Require 2+ mentions so a technology
    # named once as a rejected alternative isn't flagged.
    for tech in TECH:
        if len(re.findall(rf"\b{tech}\b", prose)) >= 2 and not re.search(rf"\b{tech}\b[^.\n]{{0,24}}\d", prose):
            out("spec.html", f"'{tech}' is used but never versioned — pin it")

    check_parts(t, out)
    check_nav(t, out)
    check_characteristics(t, out)
    check_components(t, out)
    check_adrs(t, out)
    names = check_stories(t, out)
    check_v1(t, names, out)
    check_codebase_facts(t, out)
    if explained:
        check_tags(prose, t.count("\n") + 1, out)
    return names


BASE_ROWS = ["users-and-job", "core-flow", "process", "domain-model", "scale", "anti-scope",
             "arch-characteristics", "boundaries", "style-and-topology", "api",
             "stack-and-constraints", "integrations", "failure-behaviour", "decisions",
             "stories-and-v1"]
EXPLAIN_ROWS = ["actors", "vocabulary"]

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


def check_interview(t, out):
    """The interview ends on coverage or an explicit stop — never on a question count.
    So this checks the coverage ledger, not how many questions were asked."""
    if not t:
        out("interview-notes.md", "missing — no record of what was covered or assumed")
        return False

    m = re.search(r"^mode:\s*(\w+)", t, re.M)
    explained = bool(m) and m.group(1).lower() == "explain"
    m = re.search(r"^scope:\s*([\w-]+)", t, re.M)
    scope = m.group(1).lower() if m else "new-service"

    expected = list(BASE_ROWS)
    if explained:
        expected += EXPLAIN_ROWS
    if scope != "new-service":
        expected.append("rollout")

    block = re.search(r"^##\s*Coverage\s*$(.*?)(?=^##\s|\Z)", t, re.M | re.S)
    if not block:
        out("interview-notes.md", "no '## Coverage' block — nothing records which floor rows were covered")
        return explained
    rows = {r: split_row(rest) for r, rest in
            re.findall(r"^\s*-\s*([a-z0-9-]+)\s*:\s*(.+?)\s*$", block.group(1), re.M)}

    missing = [r for r in expected if r not in rows]
    if missing:
        out("interview-notes.md", f"coverage rows never recorded: {', '.join(missing)}")

    answers = re.search(r"^##\s*Answers\s*$(.*?)(?=^##\s|\Z)", t, re.M | re.S)
    answers = answers.group(1).lower() if answers else ""

    def traced(row):
        """Evidence can live on the row, or under ## Answers as a logged answer."""
        return any(w in answers for w in row.split("-") if len(w) >= 4)

    unevidenced = []
    for r, (verdict, evidence) in sorted(rows.items()):
        if verdict not in EVIDENCED + UNSETTLED:
            out("interview-notes.md",
                f"row '{r}' has an unrecognised verdict '{verdict}' — use answered | repo | "
                f"research | n/a | assumed | open")
        elif verdict in EVIDENCED and len(evidence) < 8 and not traced(r):
            unevidenced.append(f"{r} ({verdict})")
    if unevidenced:
        out("interview-notes.md",
            f"nothing records how these rows were settled — no evidence on the row, nothing under "
            f"## Answers: {', '.join(unevidenced)}. Write the evidence after a dash (their answer, "
            f"a path:line, the source, or why it doesn't apply), or mark the row 'assumed' so "
            f"/r:spec-brainstorm --continue knows to offer the decision back")

    status = re.search(r"^status:\s*([\w-]+)", t, re.M)
    status = status.group(1).lower() if status else ""
    unfinished = sorted(r for r, (v, _) in rows.items() if v in UNSETTLED)
    if unfinished and status not in ("generated-partial", "interviewing"):
        out("interview-notes.md",
            f"rows still open or assumed ({', '.join(unfinished)}) but status is "
            f"'{status or 'unset'}' — set status: generated-partial so /r:spec-brainstorm "
            f"--continue can find this, or settle the rows")

    oq = len(re.findall(r"^\s*-\s", re.search(r"^##\s*Open questions\s*$(.*?)(?=^##\s|\Z)", t,
                                              re.M | re.S).group(1), re.M)) \
        if re.search(r"^##\s*Open questions\s*$", t, re.M) else 0
    settled = len([r for r, (v, _) in rows.items() if v in EVIDENCED])
    if oq and settled and oq > max(2, settled // 2):
        out("interview-notes.md",
            f"{oq} open questions against {settled} settled rows — anything the user could answer "
            f"in one line belongs in the interview, not the open-questions list")
    return explained


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

    spec = read("spec.html")
    if not spec:
        out("spec.html", "missing")

    explained = check_interview(read("interview-notes.md"), out)
    check_spec(spec, explained, out)

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
