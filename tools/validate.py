#!/usr/bin/env python3
"""FR-17 — every static check the pack has, run before every push.

    python3 tools/validate.py [--refresh-drift-baseline]

CI was declined (ADR-10), so these are the same checks a workflow file would
have run, in a script that has to be remembered instead. Every one is static and
the whole run takes under a second — that is what makes declining CI survivable
rather than merely cheaper.

Two checks in the test strategy cannot live here. The real-install check needs a
Claude Code session, so it stays a manual gate once per release. The eval suites
need a model, so they run deliberately — after editing any description, and
before a release — not on every push.
"""
import argparse
import glob
import hashlib
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rename_rules as R  # noqa: E402

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required: python3 -m pip install pyyaml")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILLS = os.path.join(REPO, "skills")
FAILURES = []
NOTES = []


def fail(check, detail):
    FAILURES.append(f"{check}: {detail}")


def frontmatter(path):
    text = open(path, encoding="utf-8").read()
    if not text.startswith("---\n"):
        return None, text
    end = text.find("\n---\n", 3)
    if end == -1:
        return None, text
    return text[4:end + 1], text[end + 5:]


def skill_dirs():
    return sorted(d for d in os.listdir(SKILLS) if os.path.isdir(os.path.join(SKILLS, d)))


# --- FR-1 -------------------------------------------------------------------
def check_manifest():
    path = os.path.join(REPO, ".claude-plugin", "plugin.json")
    if not os.path.isfile(path):
        return fail("FR-1", ".claude-plugin/plugin.json is missing — no manifest, no namespace")
    try:
        man = json.load(open(path))
    except json.JSONDecodeError as e:
        return fail("FR-1", f"plugin.json does not parse: {e}. Every /r: command would "
                            "vanish with no error.")
    if man.get("name") != "r":
        fail("FR-1", f'plugin.json name is {man.get("name")!r}, expected "r"')


# --- FR-2, FR-3, BR-1, BR-2, ADR-4 ------------------------------------------
def check_layout():
    dirs = skill_dirs()
    expected = set(R.RENAME.values())
    if set(dirs) != expected:
        missing, extra = expected - set(dirs), set(dirs) - expected
        if missing:
            fail("FR-3/BR-2", f"skills missing from the pack: {sorted(missing)}")
        if extra:
            fail("FR-3/BR-2", f"skill directories not in the rename map: {sorted(extra)}")
    for d in dirs:
        if not R.NAME_RE.match(d):
            fail("BR-1", f"{d} does not match {R.NAME_RE.pattern}")
        if not os.path.isfile(os.path.join(SKILLS, d, "SKILL.md")):
            fail("FR-2", f"skills/{d} has no SKILL.md")
    stray = [p for p in glob.glob(os.path.join(SKILLS, "*", "*", "SKILL.md"))]
    for p in stray:
        fail("ADR-4", f"{os.path.relpath(p, REPO)} is three levels deep; skills/ is flat")


# --- FR-7, FR-8, FR-10, FR-16, BR-4, NFR-1 ----------------------------------
def check_frontmatter():
    total = 0
    for d in skill_dirs():
        path = os.path.join(SKILLS, d, "SKILL.md")
        fm, _ = frontmatter(path)
        if fm is None:
            fail("FR-7", f"{d}/SKILL.md has no frontmatter block")
            continue
        try:
            data = yaml.safe_load(fm) or {}
        except yaml.YAMLError as e:
            fail("FR-7", f"{d}/SKILL.md frontmatter is not valid YAML: {str(e).splitlines()[0]}")
            continue
        if "version" in data:
            fail("FR-10", f"{d}/SKILL.md still carries version:, which is not a documented field")
        desc = (data.get("description") or "") + (data.get("when_to_use") or "")
        if not desc:
            fail("FR-8", f"{d}/SKILL.md has no description — the router has nothing to read")
        if len(desc) > R.DESC_CAP:
            fail("FR-8/BR-4", f"{d} description+when_to_use is {len(desc)} chars, "
                              f"{len(desc) - R.DESC_CAP} over the {R.DESC_CAP} cap. The tail is "
                              "dropped from the listing and never reaches the model.")
        total += min(len(desc), R.DESC_CAP)
        if d in R.NO_AUTO_FIRE and data.get("disable-model-invocation") is not True:
            fail("FR-16", f"{d} says in its own text that it must never fire on its own, "
                          "but carries no disable-model-invocation: true")
    if total > R.LISTING_CAP:
        fail("NFR-1", f"always-on listing cost is {total} chars, over the {R.LISTING_CAP} ceiling")
    NOTES.append(f"always-on listing cost: {total} / {R.LISTING_CAP} chars")


# --- FR-4, BR-3, BR-5 -------------------------------------------------------
ASSERT_LINE = re.compile(r"^.*assert\.(?:match|doesNotMatch)\(.*$", re.M)


def check_references():
    leftovers = []
    for path in pack_text_files():
        text = open(path, encoding="utf-8", errors="ignore").read()
        if path.endswith(".mjs"):
            text = ASSERT_LINE.sub("", text)   # regex literals, not slash commands
        for old in R.RENAME:
            for pat, _ in R.ref_patterns(old):
                for m in pat.finditer(text):
                    leftovers.append(f"{os.path.relpath(path, REPO)}: {m.group(0)!r}")
    for hit in leftovers:
        fail("FR-4/BR-5", f"un-prefixed reference to an old skill name — {hit}")


# --- FR-9 -------------------------------------------------------------------
# Every skill name a body mentions must be packed, bundled with Claude Code, or
# listed in the README as an external prerequisite. Anything else is a name the
# model will try to invoke and fail to reach, mid-run.
BUNDLED = {
    "security-review", "simplify", "init", "review", "run", "loop", "schedule",
    "claude-api", "dataviz", "artifact-design", "artifact-capabilities",
    "update-config", "keybindings-help", "fewer-permission-prompts", "find-skills",
    "compact", "clear", "help", "config", "model", "plugin", "reload-plugins",
    "workflows", "context", "resume", "agents", "doctor", "memory", "rewind",
    "status", "vim", "terminal-setup", "export", "hooks", "mcp", "ide",
    "permissions", "add-dir", "bug", "cost", "login", "logout", "upgrade",
    "sandbox", "usage", "todos", "output-style", "statusline", "privacy-settings",
    "release-notes", "install", "migrate-installer", "exit", "quit",
}
EXTERNAL = {"test-app", "agent-browser", "frontend-design", "skill-creator", "sonar",
            "deploy", "codex", "html", "html-diagram", "html-plan", "htmx",
            "todo-creator-pro", "sdd-idea", "sdd-impl", "sdd-feature", "sdd-change",
            "sdd-undo", "code-reviewer", "comment-cleaner"}
# Named but never invoked: claudemd-patch's job is to find and DELETE the
# leftovers of this retired skill, so the name has to appear for the search to
# work. Not a dangling reference — the opposite of one.
RETIRED = {"verify-diff", "verify-diff-agent"}
SLASH = re.compile(r"(?<![A-Za-z0-9_-])/([a-z][a-z0-9-]{2,})(?![A-Za-z0-9_./-])")
KNOWN = set(R.RENAME) | set(R.RENAME.values()) | BUNDLED | EXTERNAL | RETIRED


def candidates(text):
    """`/word` tokens that are plausibly skill invocations rather than path
    segments. A blanket "any /word" sweep reports /etc, /usr, /tmp, /src and
    forty more, which buries the one line that matters. Two things qualify a
    token: it is a name we already know is a skill, or it is hyphenated AND its
    line is talking about a skill."""
    for line in text.splitlines():
        mentions_skill = re.search(r"\bskills?\b", line, re.I)
        for m in SLASH.finditer(line):
            name = m.group(1)
            if name in KNOWN or ("-" in name and mentions_skill):
                yield name


def check_dangling():
    packed = set(R.RENAME.values())
    unknown = {}
    for path in pack_text_files():
        text = open(path, encoding="utf-8", errors="ignore").read()
        if path.endswith(".mjs"):
            text = ASSERT_LINE.sub("", text)
        for name in candidates(text):
            if name in packed or name in BUNDLED or name in EXTERNAL or name in RETIRED:
                continue
            unknown.setdefault(name, os.path.relpath(path, REPO))
    for name, where in sorted(unknown.items()):
        fail("FR-9", f"/{name} (first seen in {where}) resolves to nothing — it is neither "
                     "packed, bundled with Claude Code, nor a documented external prerequisite")


def check_r_prefix():
    """BR-5 — a packed name written without the r: prefix would silently resolve
    to its flat twin outside the pack, which ADR-13 keeps installed forever."""
    packed = set(R.RENAME.values())
    for path in pack_text_files():
        text = open(path, encoding="utf-8", errors="ignore").read()
        if path.endswith(".mjs"):
            text = ASSERT_LINE.sub("", text)
        for name in candidates(text):
            if name in packed:
                fail("BR-5", f"{os.path.relpath(path, REPO)}: /{name} is missing the r: "
                             "prefix and would resolve to the flat twin outside the pack")


# A bare agent name that quotes text living OUTSIDE the pack — a rule a user's own
# CLAUDE.md might carry, which is written flat because that user never saw the pack.
# Prefixing those would make the search heuristic miss the very lines it exists to find.
FOREIGN_TEXT = {
    "skills/claudemd-patch/SKILL.md",
    "skills/code-bugs/references/documentation-consistency.md",
}
BARE_AGENT = re.compile(r"(?<![\w:/-])(" + "|".join(sorted(R.AGENTS, key=len, reverse=True))
                        + r")(?![\w-])")


def check_agent_prefix():
    """BR-5, for agents — a bundled agent resolves as `r:<name>`. Written bare it either
    dispatches a same-named agent outside the pack (a different persona and toolset, with
    no error) or, where no such twin exists, dies with 'agent type not found' and takes
    that track of the fan-out with it."""
    for path in pack_text_files():
        rel = os.path.relpath(path, REPO)
        if rel in FOREIGN_TEXT:
            continue
        for i, line in enumerate(open(path, encoding="utf-8", errors="ignore"), 1):
            # An agent's own frontmatter `name:` is what the r: prefix is built FROM, and
            # its memory directory is a path on disk, not a dispatch target.
            if re.match(r"^name:\s", line) or "agent-memory/" in line:
                continue
            m = BARE_AGENT.search(line)
            if m:
                fail("BR-5", f"{rel}:{i}: agent {m.group(1)} is missing the r: prefix — "
                             "it resolves to a flat twin outside the pack, or to nothing")


# --- FR-5, ADR-6 ------------------------------------------------------------
def check_agents():
    adir = os.path.join(REPO, "agents")
    if not os.path.isdir(adir):
        return fail("FR-5", "agents/ is missing")
    shipped = sorted(f[:-3] for f in os.listdir(adir) if f.endswith(".md"))
    if shipped != sorted(R.AGENTS):
        fail("FR-5", f"agents/ holds {shipped}, expected {sorted(R.AGENTS)}")
    corpus = "\n".join(open(p, encoding="utf-8", errors="ignore").read()
                       for p in pack_text_files())
    for a in shipped:
        if a not in corpus:
            fail("ADR-6", f"agent {a} is dispatched by no packed skill — it is orphaned "
                          "and should be dropped rather than shipped")
        # An agent's frontmatter has to parse for the same reason a skill's does,
        # and it fails harder: `claude plugin validate` reports that an agent with
        # unparsable frontmatter "loads with empty metadata (all frontmatter
        # fields silently dropped)", so its name, tools and model are gone and
        # FR-5's promise that the agent resolves rather than failing as unknown
        # does not hold. Two shipped agents had exactly this defect.
        fm, _ = frontmatter(os.path.join(adir, a + ".md"))
        if fm is None:
            fail("FR-5", f"agents/{a}.md has no frontmatter block")
            continue
        try:
            data = yaml.safe_load(fm) or {}
        except yaml.YAMLError as e:
            fail("FR-5", f"agents/{a}.md frontmatter is not valid YAML "
                         f"({str(e).splitlines()[0]}) — every field is silently dropped at runtime")
            continue
        if data.get("name") != a:
            fail("FR-5", f"agents/{a}.md declares name {data.get('name')!r}, which does not "
                         "match its filename — dispatch resolves by name")


# --- FR-11 ------------------------------------------------------------------
def check_evals():
    for d in skill_dirs():
        path = os.path.join(SKILLS, d, "evals", "evals.json")
        if not os.path.isfile(path):
            fail("FR-11", f"{d} has no evals/evals.json")
            continue
        try:
            suite = json.load(open(path))
        except json.JSONDecodeError as e:
            fail("FR-11", f"{d}/evals/evals.json does not parse: {e}")
            continue
        kinds = {e.get("kind") for e in suite.get("evals", [])}
        if "trigger" not in kinds:
            fail("FR-11", f"{d} has no trigger case — nothing checks it still fires on its "
                          "own phrasing")
        if "neighbour-exclusion" not in kinds:
            fail("FR-11", f"{d} has no neighbour-exclusion case — nothing catches it "
                          "mis-routing against its nearest neighbour")


# --- FR-13 ------------------------------------------------------------------
def check_artifacts():
    try:
        tracked = subprocess.run(["git", "ls-files"], cwd=REPO, capture_output=True,
                                 text=True, check=True).stdout.split()
    except (subprocess.CalledProcessError, FileNotFoundError):
        NOTES.append("FR-13 skipped: not a git checkout")
        return
    bad = [f for f in tracked if f.endswith(".pyc") or "__pycache__" in f or f.endswith(".DS_Store")]
    for f in bad:
        fail("FR-13", f"{f} is tracked but is a build artefact")


# --- FR-19 ------------------------------------------------------------------
ABS = re.compile(r'(\$HOME|~)"?/\.claude/skills/[A-Za-z0-9_-]')
# Any path into a specific machine's home. Narrower checks miss these: an agent
# shipped four `/Users/<name>/.claude/agent-memory/...` paths, which the
# .claude/skills check above had no reason to look at. They leak one machine's
# layout and resolve to nothing on any other.
HOMEDIR = re.compile(r'/(?:Users|home)/[a-z][a-z0-9._-]*/')


def check_home_paths():
    for path in tracked_files():
        rel = os.path.relpath(path, REPO)
        if rel.startswith("docs/") or rel == "tools/build-pack.py":
            continue    # the design write-up, and the patch table that fixes them
        try:
            text = open(path, encoding="utf-8").read()
        except (UnicodeDecodeError, OSError):
            continue
        for m in HOMEDIR.finditer(text):
            fail("FR-19", f"{rel} hard-codes an absolute home path ({m.group(0)}…). It leaks one "
                          "machine's layout and resolves to nothing on any other — use ~/ instead")


def tracked_files():
    try:
        out = subprocess.run(["git", "ls-files"], cwd=REPO, capture_output=True,
                             text=True, check=True).stdout.split()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    return [os.path.join(REPO, f) for f in out]


def check_paths():
    for path in pack_text_files():
        text = open(path, encoding="utf-8", errors="ignore").read()
        for m in ABS.finditer(text):
            rel = os.path.relpath(path, REPO)
            fail("FR-19", f"{rel} carries an absolute path into a skill directory "
                          f"({m.group(0)}…); it must resolve through a substituted variable")
    # FR-19's pack-root rule, inverted by evidence. This used to REQUIRE the
    # `|| '${CLAUDE_PLUGIN_ROOT}'` fallback, on the reasoning that without it a run missing
    # args.packRoot would build /skills/... paths "that point nowhere and look plausible".
    # That is exactly what the fallback itself produced: the placeholder is substituted in skill
    # MARKDOWN only — never inside a workflow script, and never in a subagent's shell, where it is
    # unset and bash expands it to the empty string. Observed on a real run: every one of
    # task-review's seven PACK-derived paths resolved under "/", and only the stats sink said so,
    # because it is the one step best-effort enough to swallow its own failure.
    # So the rule now demands the opposite: resolve packRoot from the parsed options, and HALT when
    # it is unusable. A pipeline that cannot locate its own tools must not certify anything.
    for name, script in (("task-review", "task-review.workflow.js"),
                         ("task-run", "task-run-implement.workflow.js")):
        wf = os.path.join(SKILLS, name, script)
        if not os.path.isfile(wf):
            continue
        text = open(wf, encoding="utf-8").read()
        if "|| '${CLAUDE_PLUGIN_ROOT}'" in text:
            fail("FR-19", f"{script} falls back to the literal ${{CLAUDE_PLUGIN_ROOT}} placeholder. "
                          "It is not substituted inside a workflow script and reaches bash as the "
                          "empty string, so every tool path resolves under '/'. Halt instead.")
        if "stopped: 'no-pack-root'" not in text:
            fail("FR-19", f"{script} does not halt on a missing/unusable packRoot. A run that "
                          "cannot locate run.sh, the deploy helper or its reference files must "
                          "stop rather than certify a review it never performed.")


# --- FR-12 ------------------------------------------------------------------
def check_vendored():
    lic = os.path.join(SKILLS, "spec-brainstorm", "references", "html-effectiveness", "LICENSE")
    if not os.path.isfile(lic):
        fail("FR-12", "the vendored html-effectiveness LICENSE is missing")


# --- R-4 --------------------------------------------------------------------
# Every skills root a pre-pack original can still be sitting in. R-4 is the risk that an edit
# lands in one of those instead of the pack, so "closed" may only be claimed when NO root holds
# a twin. Checking one root and announcing the pack is the only copy is how the risk stays open
# while the gate certifies it shut — which is worse than not checking, because it is believed.
OTHER_SKILL_ROOTS = ("~/.agents/skills",)


def surviving_elsewhere(source_root):
    """(root, names) for every root outside the scanned one that still holds flat originals."""
    scanned = os.path.realpath(os.path.join(source_root, "skills"))
    out = []
    for root in OTHER_SKILL_ROOTS:
        base = os.path.expanduser(root)
        if os.path.realpath(base) == scanned or not os.path.isdir(base):
            continue
        live = sorted(o for o in R.RENAME if os.path.isdir(os.path.join(base, o)))
        if live:
            out.append((root, live))
    return out


def drift_hashes(source_root):
    out = {}
    base = os.path.join(source_root, "skills")
    for old in sorted(R.RENAME):
        for root, dirs, files in os.walk(os.path.join(base, old)):
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            for f in sorted(files):
                if f in (".DS_Store",) or f.endswith(".pyc"):
                    continue
                p = os.path.join(root, f)
                out[os.path.relpath(p, base)] = hashlib.sha256(open(p, "rb").read()).hexdigest()
    return out


def check_drift(source_root, refresh):
    """R-4 is the risk that an edit lands in a flat original instead of the pack.

    The originals under the scanned source were backed up and deleted on 2026-07-31, so this
    check has three outcomes and only the last is silent:

      * an original present in the scanned source -> a partial cut-over, or a machine that never
        deleted them. Those are checked against the baseline, because while a twin exists an
        edit can still land in it.
      * an original present in ANOTHER skills root -> the risk is open there too. Reported by
        name, not compared: those copies have their own lineage, and per-file drift against a
        baseline taken elsewhere is noise, while their mere existence is the signal.
      * no original anywhere -> R-4 is closed, and only then may that be said.

    A wholesale deletion is reported, not failed. Reporting it as 79 failures — one per file —
    would make the pre-push script useless rather than informative.
    """
    path = os.path.join(REPO, "tools", "drift-baseline.json")
    elsewhere = surviving_elsewhere(source_root)
    for root, live in elsewhere:
        NOTES.append(f"R-4 STILL OPEN: {len(live)} of {len(R.RENAME)} pre-pack originals are "
                     f"installed at {root} ({', '.join(live)}) — the pack is NOT the only copy "
                     f"on this machine, so an edit can still land in the wrong one")
    if not os.path.isdir(os.path.join(source_root, "skills")):
        NOTES.append("R-4 drift check skipped: the flat originals are not in the scanned source")
        return
    now = drift_hashes(source_root)
    if refresh or not os.path.isfile(path):
        json.dump(now, open(path, "w"), indent=1, sort_keys=True)
        NOTES.append(f"R-4 drift baseline written: {len(now)} files")
        return
    base = json.load(open(path))

    surviving = sorted(o for o in R.RENAME
                       if os.path.isdir(os.path.join(source_root, "skills", o)))
    if not surviving:
        if not elsewhere:
            NOTES.append(f"R-4 closed: all {len(R.RENAME)} flat originals are gone, so the pack "
                         "is the only copy and an edit can no longer land in the wrong one")
        return
    if len(surviving) < len(R.RENAME):
        NOTES.append(f"R-4 partial cut-over: {len(surviving)} of {len(R.RENAME)} flat originals "
                     f"still installed ({', '.join(surviving)}) — those are still checked")

    live = {o + "/" for o in surviving}
    scoped = {rel: h for rel, h in base.items() if any(rel.startswith(p) for p in live)}
    for rel, h in sorted(now.items()):
        if rel not in base:
            fail("R-4", f"a new file appeared in the flat original {rel} — the pack is the "
                        "only copy that should be edited")
        elif base[rel] != h:
            fail("R-4", f"the flat original {rel} has changed since the pack was built. An edit "
                        "went to the wrong copy: it works under the old name and is missing "
                        "under the new one.")
    for rel in sorted(set(scoped) - set(now)):
        fail("R-4", f"{rel} was deleted from a flat original that is otherwise still installed — "
                    "delete the whole skill or none of it, so its state is unambiguous")


# --- §16 --------------------------------------------------------------------
WORD = re.compile(r"[a-z]{4,}")
STOP = {"when", "that", "this", "with", "from", "your", "user", "wants", "into", "over",
        "them", "have", "what", "code", "skill", "uses", "each", "onto", "than", "also"}


def check_near_duplicates():
    """Two descriptions whose opening sentence says nearly the same thing are two
    skills the router has to guess between."""
    leads = {}
    for d in skill_dirs():
        fm, _ = frontmatter(os.path.join(SKILLS, d, "SKILL.md"))
        try:
            desc = (yaml.safe_load(fm) or {}).get("description", "") if fm else ""
        except yaml.YAMLError:
            continue
        first = re.split(r"(?<=[.!?])\s", desc.strip())[0] if desc else ""
        leads[d] = {w for w in WORD.findall(first.lower())} - STOP
    names = sorted(leads)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if not leads[a] or not leads[b]:
                continue
            overlap = len(leads[a] & leads[b]) / min(len(leads[a]), len(leads[b]))
            if overlap > 0.6:
                fail("§16", f"{a} and {b} open with nearly the same sentence "
                            f"({overlap:.0%} shared significant words) — the router has to "
                            "guess between them")


def pack_text_files():
    out = []
    for base in ("skills", "agents", "lib"):
        for root, dirs, files in os.walk(os.path.join(REPO, base)):
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            for f in sorted(files):
                rel = os.path.relpath(os.path.join(root, f), REPO)
                if any(v in rel for v in R.VENDORED) or not f.endswith(R.TEXT_SUFFIXES):
                    continue
                out.append(os.path.join(root, f))
    for f in ("hooks/guard-workflow.py", "hooks/record-skill-run.py", "hooks/hooks.json"):
        p = os.path.join(REPO, f)
        if os.path.isfile(p):
            out.append(p)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=os.path.expanduser("~/.claude"))
    ap.add_argument("--refresh-drift-baseline", action="store_true")
    args = ap.parse_args()

    check_manifest()
    check_layout()
    check_frontmatter()
    check_references()
    check_r_prefix()
    check_agent_prefix()
    check_dangling()
    check_agents()
    check_evals()
    check_artifacts()
    check_paths()
    check_home_paths()
    check_vendored()
    check_near_duplicates()
    check_drift(args.source, args.refresh_drift_baseline)

    for n in NOTES:
        print(f"  · {n}")
    if FAILURES:
        print(f"\n{len(FAILURES)} problem(s):\n")
        for f in FAILURES:
            print(f"  ✗ {f}")
        return 1
    print("\n  ✓ every static check passes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
