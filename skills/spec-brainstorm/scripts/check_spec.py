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
FILEISH = re.compile(r"\b[\w][\w./-]*\.(?:java|kt|kts|py|ts|tsx|js|jsx|sql|go|rb|rs|cs|php|"
                     r"yaml|yml|xml|json|gradle|toml|md|html|css|tf|proto)\b(:\d+)?")

# The document's ceiling: modules, technologies, stories, API. Anything below it belongs to
# /r:spec-plan or /r:task-run, and its arrival is what turns a design doc into a bad schema.
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


def check_stories(t, out):
    """Story names are the handle /r:spec-plan builds phases against, so they have to be
    findable and each has to say when it is done."""
    blk = section(t, "user stor", "stories")
    if not blk:
        out("spec.html", "no 'User stories' section — /r:spec-plan has nothing to build phases "
                         "against, and the v1 line has nothing to name")
        return []

    names = [strip(m.group(1)).strip() for m in re.finditer(r"<h3\b[^>]*>(.*?)</h3>", blk, re.S | re.I)]
    if not names:
        out("spec.html", "User stories section has no <h3> story names — each story is an <h3> "
                         "whose text is its handle. See sections.md §5")
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
        out("spec.html", "no v1 section — say which stories ship first; /r:spec-plan has nothing "
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

    names = check_stories(t, out)
    check_v1(t, names, out)
    check_codebase_facts(t, out)
    if explained:
        check_tags(prose, t.count("\n") + 1, out)
    return names


BASE_ROWS = ["users-and-job", "core-flow", "process", "domain-model", "scale", "anti-scope",
             "boundaries", "api", "stack-and-constraints", "integrations", "failure-behaviour",
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
