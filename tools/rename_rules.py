"""Single source of truth for the pack's rename and rewrite rules.

Imported by build-pack.py (which applies them) and validate.py (which checks the
result). Keeping them in one module is what stops the builder and the validator
from disagreeing about what "rewritten" means.

  BR-1  directory names match NAME_RE, domain first, <= 3 kebab segments
  BR-2  RENAME is exactly the sixteen pairs; an unmapped source dir is an error
  BR-2  packed_skills() is RENAME's targets plus PACK_NATIVE — the whole pack
  BR-3  only the four bounded patterns in ref_patterns() are rewritten
  BR-5  a reference to a packed skill carries the "r:" prefix
  FR-19 absolute ~/.claude/skills/... paths become substituted variables
"""
import re

NAMESPACE = "r"
DESC_CAP = 1536          # BR-4, per skill: len(description) + len(when_to_use)
LISTING_CAP = 16000      # NFR-1, across the model-invocable skills only

NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+){0,2}$")

# BR-2 — old flat directory -> packed directory.
RENAME = {
    "adversarial-review": "code-adversarial",
    "brainstorm":         "spec-brainstorm",
    "claudemd-compact":   "claudemd-compact",
    "claudemd-patch":     "claudemd-patch",
    "code-quality":       "code-quality",
    "commit":             "git-commit",
    "create-test-app":    "test-app-create",
    "find-bugs":          "code-bugs",
    "fix-gh-issues":      "issues-fix",
    # Named for its subject rather than <domain>-<action>: the pack has one architecture
    # rulebook and "hexagonal" is the term a user reaches for. Two segments, so BR-1 holds.
    "hexagonal-architecture": "hexagonal-architecture",
    "local-scan":         "code-scan",
    "post-task-review":   "task-review",
    "refactor":           "code-refactor",
    "run-task":           "task-run",
    "spec-to-todo":       "spec-plan",
    "write-tests":        "tests-write",
}

# Skills born in the pack. They have no pre-pack original and never did, so they belong in
# neither half of RENAME: putting one there would send install.sh hunting an ancestor that
# never existed and make validate report an R-4 cut-over that has nothing to cut over from.
# They are part of the pack all the same, which is what packed_skills() is for.
PACK_NATIVE = frozenset({"issues-draft"})


def packed_skills() -> set:
    """Every skill directory the pack carries — renamed originals plus pack-native ones.

    Layout, name-resolution and the r:-prefix rule all ask "is this one of ours", and the
    answer has to include a skill that never had a flat twin. R-4's machinery deliberately
    keeps reading RENAME alone: it counts *originals still installed elsewhere*, and a
    pack-native skill contributes none.
    """
    return set(RENAME.values()) | set(PACK_NATIVE)


# FR-5 / ADR-6 — the agents packed skills dispatch.
AGENTS = [
    "bug-hunter",
    "bug-hunter-docs",
    "bug-hunter-pattern",
    "bug-hunter-security",
    "bug-hunter-ui",
    "gradle-build-runner",
    "htmx-thymeleaf-dev",
    "java-backend-developer",
    "maven-build-runner",
]

# Old names that are also ordinary English. BR-3's backtick pattern is skipped
# for these; see ref_patterns().
AMBIGUOUS_IN_BACKTICKS = {"commit", "refactor"}

# R-4 / ADR-13 — every skills root a pre-pack original can still be sitting in, under its old
# flat name. The pack renames what it carries and installs it under one namespaced root, so until
# these are empty each packed skill has a twin: an edit can land in the wrong copy, and the old
# name still resolves to the old behaviour. install.sh removes them; validate.py reports whatever
# survives. Both read THIS list, because a root one of them checks and the other does not is how
# the gate certifies a risk shut while it is still open.
ORIGINAL_ROOTS = ("~/.claude/skills", "~/.agents/skills")

# FR-16 — skills whose own text says they must never fire on their own AND that
# nothing else in the pack has to invoke. task-review is deliberately NOT here:
# its own text says the same thing, but `disable-model-invocation` does not
# distinguish "auto-loaded" from "explicitly told to run", so it also blocked
# /r:task-run's mandatory Step 5 from reaching the review through the Skill tool.
# There, the rule is held by the description and the non-negotiables instead.
NO_AUTO_FIRE = {"task-run", "issues-fix"}

# Files worth rewriting at all; everything else is copied byte-for-byte.
TEXT_SUFFIXES = (".md", ".js", ".mjs", ".py", ".sh", ".json", ".template", ".txt")

# Vendored third-party material — copied verbatim, never rewritten (FR-12).
VENDORED = ("references/html-effectiveness/",)


def target(old: str) -> str:
    return RENAME[old]


def qualified(old: str) -> str:
    """The name a packed reference must use: r:<new>."""
    return f"{NAMESPACE}:{RENAME[old]}"


def ref_patterns(old: str):
    """BR-3 — the only four shapes that count as a reference.

    Yields (compiled_pattern, replacement) pairs. Anything outside these stays
    byte-identical, which is what keeps the 300-odd English uses of "commit"
    and "refactor" out of the rewrite (R-1).
    """
    n = re.escape(old)
    new = qualified(old)
    return [
        # 1. /name as a slash command: nothing word-like on either side. Both
        #    guards were put there by a corruption this rewrite actually
        #    caused. Without the lookbehind, `.claude/skills/post-task-review/`
        #    (a path, FR-19's job) and English "or" slashes like
        #    "compact/refactor/reorganize" and "branch/commit/PR" were all
        #    rewritten as if they were commands. That is R-1, in the flesh.
        (re.compile(rf"(?<![A-Za-z0-9_-])/{n}(?![A-Za-z0-9_-])"), f"/{new}"),
        # 2. `name` in backticks — but not for the two names that are ordinary
        #    English. `commit` appears ~100 times and `refactor` ~35, almost
        #    always as a word: the Conventional Commit *type* list in
        #    git-commit/SKILL.md is literally "`refactor` — code change that
        #    neither fixes a bug nor adds a feature". Where those two really do
        #    name the skill they are written /commit and /refactor, so nothing
        #    is lost by leaving their backticked form alone.
        *([] if old in AMBIGUOUS_IN_BACKTICKS else
          [(re.compile(rf"`{n}`"), f"`{new}`")]),
        # 3. Skill(name) — bare or quoted
        (re.compile(rf"Skill\(\s*(['\"]?){n}\1\s*\)"), rf"Skill(\g<1>{new}\g<1>)"),
        # 4. a subagent_type / agentType / skill key whose quoted value is the name
        (re.compile(rf"((?:subagent_type|agentType|skill)\s*[:=]\s*)(['\"]){n}\2"),
         rf"\g<1>\g<2>{new}\g<2>"),
    ]


BARE = {old: re.compile(rf"(?<![A-Za-z0-9_-]){re.escape(old)}(?![A-Za-z0-9_-])")
        for old in RENAME}


def count_prose(text: str, old: str) -> int:
    """Occurrences of `old` that are NOT references — ordinary English, mostly.

    Masks every BR-3 match first, then counts what is left. This is the number
    NFR-5 requires to survive the build byte-identical: "commit" appears about a
    hundred times in these files and almost all of them are the English verb.
    """
    masked = text
    for pat, _ in ref_patterns(old):
        masked = pat.sub(lambda m: "\x01" * len(m.group(0)), masked)
    return len(BARE[old].findall(masked))


# FR-19 — an absolute path into a skill directory. Note the leading (^|[^.\w])
# guard: it makes the match require $HOME or ~, so a *project-relative*
# `.claude/skills/test-app/...` (the target project's generated skill, not an
# install path) is left alone. Conflating those two is the failure mode.
ABS_SKILL_PATH = re.compile(
    r"""(?P<prefix>"?\$HOME"?|~)/\.claude/skills/(?P<skill>[A-Za-z0-9_-]+)"""
)


def rewrite_paths(text: str, owner_old: str) -> tuple[str, int, int]:
    """Replace absolute skill paths with substituted variables.

    `owner_old` is the old name of the skill the file belongs to, which is what
    decides self vs cross: ${CLAUDE_SKILL_DIR} is "the skill's subdirectory
    within the plugin, not the plugin root", so it cannot reach a sibling.

    Returns (new_text, self_count, cross_count).
    """
    counts = [0, 0]

    def sub(m):
        skill = m.group("skill")
        if skill == owner_old:
            counts[0] += 1
            return "${CLAUDE_SKILL_DIR}"
        if skill in RENAME:
            counts[1] += 1
            return "${CLAUDE_PLUGIN_ROOT}/skills/" + RENAME[skill]
        # A path into a skill the pack does not carry — leave it visible.
        return m.group(0)

    return ABS_SKILL_PATH.sub(sub, text), counts[0], counts[1]


def rewrite_refs(text: str) -> tuple[str, dict]:
    """Apply BR-3 to every old name. Returns (new_text, {old_name: count})."""
    hits = {}
    for old in sorted(RENAME, key=len, reverse=True):
        n = 0
        for pat, repl in ref_patterns(old):
            text, k = pat.subn(repl, text)
            n += k
        if n:
            hits[old] = n
    return text, hits
