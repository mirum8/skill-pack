#!/usr/bin/env python3
"""
Server-free static analysis orchestrator.

Runs PMD, SpotBugs (+ find-sec-bugs), and Semgrep against a JVM project,
scopes the findings to a slice of the codebase (git diff by default),
normalizes the three different output formats into one list, prints a
triage table, and writes findings.json next to where it is run.

No SonarQube server, no project-file changes. Each tool is optional: if a
binary is missing the orchestrator skips it with a notice and keeps going,
so partial coverage still produces a useful list.

Usage:
  local-scan.py                       # diff scope (default)
  local-scan.py --scope all           # whole project
  local-scan.py --filter <dir|file|ClassName>
  local-scan.py --files A.java B.java # explicit list (post-task-review)
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

CACHE = Path(os.path.expanduser("~/.cache/local-scan"))
SRC_EXTS = (".java", ".kt")
NO_DIFF_BASE = []
COMPILE_FAILED_STALE = []


def run(cmd, **kw):
    kw.setdefault("timeout", 300)
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


# Per-tool run status, surfaced in findings.json so the caller can tell a
# clean scan from a scan where analyzers never ran. Values: ran / skipped / errored.
TOOL_STATUS = {}


def run_analyzer(name, cmd, **kw):
    """Invoke an analyzer command, catching TimeoutExpired so one stalled tool
    is recorded as errored and skipped instead of crashing the whole scan.
    Returns the CompletedProcess, or None if it timed out."""
    try:
        return run(cmd, **kw)
    except subprocess.TimeoutExpired:
        note(f"{name} timed out — recording as errored and continuing")
        TOOL_STATUS[name] = "errored"
        return None


def have(tool):
    return run(["bash", "-lc", f"command -v {tool}"]).returncode == 0


def note(msg):
    print(f"→ {msg}", file=sys.stderr)


# ---------------------------------------------------------------- scope ----

def git(*args):
    return run(["git", *args], timeout=60).stdout.strip()


def diff_files():
    """Files changed on this branch + uncommitted, mirroring /sonar's logic."""
    base = ""
    for ref in ("origin/main", "origin/master", "main", "master"):
        b = run(["git", "merge-base", "HEAD", ref], timeout=60).stdout.strip()
        if b:
            base = b
            break
    sets = []
    if base:
        sets.append(git("diff", "--name-only", f"{base}..HEAD"))
    else:
        note("No diff base resolved (origin/main|master, main|master all absent) "
             "— scope is uncommitted/untracked changes only; a narrowed scope is "
             "NOT a clean-project result")
        NO_DIFF_BASE.append(True)
    sets.append(git("diff", "--name-only", "HEAD"))
    sets.append(git("diff", "--name-only", "--cached"))
    # New files a developer just added are part of "my changes" too — a local
    # diff scan should cover them even though they aren't tracked yet.
    sets.append(git("ls-files", "--others", "--exclude-standard"))
    files = set()
    for s in sets:
        files.update(x for x in s.splitlines() if x.strip())
    return sorted(files)


def commit_files(ref):
    """Files touched by a single commit (works for merges and the root commit)."""
    out = run(["git", "diff-tree", "--no-commit-id", "--name-only", "-r", ref], timeout=60)
    if out.returncode != 0:
        note(f"'{ref}' is not a valid commit")
        sys.exit(2)
    return sorted(x for x in out.stdout.splitlines() if x.strip())


def range_files(spec):
    """Files changed across a commit range, e.g. HEAD~3..HEAD or main...HEAD."""
    out = run(["git", "diff", "--name-only", spec], timeout=60)
    if out.returncode != 0:
        note(f"'{spec}' is not a valid commit range")
        sys.exit(2)
    return sorted(x for x in out.stdout.splitlines() if x.strip())


def resolve_filter(value):
    """A directory, a file, or a bare class name -> list of source files."""
    p = Path(value)
    if p.is_dir():
        return [str(f) for f in p.rglob("*") if f.suffix in SRC_EXTS and is_source(f)]
    if p.is_file():
        return [value]
    matches = [str(f) for f in Path(".").rglob(f"{value}.*")
               if f.suffix in SRC_EXTS and is_source(f)]
    return matches


def is_source(path):
    parts = set(Path(path).parts)
    return not (parts & {"target", "build", "node_modules", ".git"})


def scoped_sources(args):
    """Return (target_files, scope_label). target_files=None means whole project."""
    if args.files:
        return [f for f in args.files if Path(f).suffix in SRC_EXTS], "explicit list"
    if args.filter:
        files = resolve_filter(args.filter)
        if not files:
            note(f"'{args.filter}' did not resolve to a directory, file, or class")
            sys.exit(2)
        return files, f"filter '{args.filter}'"
    if args.commit:
        files = [f for f in commit_files(args.commit)
                 if Path(f).suffix in SRC_EXTS and Path(f).exists()]
        return files, f"commit {args.commit}"
    if args.range:
        files = [f for f in range_files(args.range)
                 if Path(f).suffix in SRC_EXTS and Path(f).exists()]
        return files, f"range {args.range}"
    if args.scope == "all":
        return None, "whole project"
    files = [f for f in diff_files() if Path(f).suffix in SRC_EXTS]
    return files, "git diff"


# ------------------------------------------------------------- normalize ---

def finding(severity, tool, category, file, line, rule, message):
    return {
        "severity": severity, "tool": tool, "category": category,
        "file": file, "line": line, "rule": rule,
        "message": " ".join((message or "").split()),
    }


def relpath(p):
    try:
        return str(Path(p).resolve().relative_to(Path.cwd().resolve()))
    except ValueError:
        return str(p)


# -------------------------------------------------------------------- PMD --

def run_pmd(targets):
    if not have("pmd"):
        note("PMD not installed — skipping (brew install pmd)")
        TOOL_STATUS["pmd"] = "skipped"
        return []
    java = [t for t in targets] if targets is not None else ["."]
    java = [t for t in java if targets is None or Path(t).suffix == ".java"]
    if targets is not None and not java:
        TOOL_STATUS["pmd"] = "skipped"
        return []
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as out:
        report = out.name
    cmd = ["pmd", "check", "--no-cache", "-f", "json",
           "-R", "rulesets/java/quickstart.xml", "-r", report]
    if targets is None:
        cmd += ["-d", "."]
    else:
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fl:
            fl.write("\n".join(java))
            listfile = fl.name
        cmd += ["--file-list", listfile]
    res = run_analyzer("pmd", cmd, timeout=900)
    if res is None:
        return []
    # exit 0 == clean, 4 == violations found; any other code means PMD failed to
    # run (config error, crash) — that must NOT be reported as a clean result.
    if res.returncode not in (0, 4):
        note(f"PMD exited {res.returncode} (not 0/4) — marking errored, not clean")
        TOOL_STATUS["pmd"] = "errored"
        return []
    try:
        data = json.loads(Path(report).read_text() or "{}")
    except json.JSONDecodeError:
        note("PMD produced no parseable report — marking errored, not clean")
        TOOL_STATUS["pmd"] = "errored"
        return []
    TOOL_STATUS["pmd"] = "ran"
    out = []
    for f in data.get("files", []):
        for v in f.get("violations", []):
            pr = v.get("priority", 3)
            sev = "HIGH" if pr <= 2 else "MEDIUM" if pr == 3 else "LOW"
            out.append(finding(sev, "pmd", "smell", relpath(f["filename"]),
                               v.get("beginline"), v.get("rule"), v.get("description")))
    return out


# --------------------------------------------------------------- Semgrep ---

def run_semgrep(targets):
    if not have("semgrep"):
        note("Semgrep not installed — skipping (brew install semgrep)")
        TOOL_STATUS["semgrep"] = "skipped"
        return []
    paths = ["."] if targets is None else [t for t in targets if Path(t).exists()]
    if not paths:
        TOOL_STATUS["semgrep"] = "skipped"
        return []
    # p/security-audit pulls in the broader security ruleset (hardcoded secrets,
    # crypto misuse, injection) that p/java + p/secrets alone leave on the table.
    # --metrics=off keeps it offline-friendly: named packs are fetched once and
    # cached, with no per-scan telemetry (unlike --config=auto).
    cmd = ["semgrep", "scan", "--quiet", "--json", "--metrics=off",
           "--config", "p/java", "--config", "p/secrets",
           "--config", "p/security-audit"]
    cmd += paths
    res = run_analyzer("semgrep", cmd, timeout=600)
    if res is None:
        return []
    try:
        data = json.loads(res.stdout or "{}")
    except json.JSONDecodeError:
        note("Semgrep produced no parseable output (offline? rules unfetched?) "
             "— marking errored, not clean")
        TOOL_STATUS["semgrep"] = "errored"
        return []
    # 0 == no findings, 1 == findings; anything else (incl. internal errors that
    # still emit JSON) means Semgrep did not run cleanly — don't call it clean.
    if res.returncode not in (0, 1) or data.get("errors"):
        note(f"Semgrep exited {res.returncode} or reported internal errors "
             "— marking errored, not clean")
        TOOL_STATUS["semgrep"] = "errored"
        return []
    TOOL_STATUS["semgrep"] = "ran"
    sevmap = {"ERROR": "HIGH", "WARNING": "MEDIUM", "INFO": "LOW"}
    out = []
    for r in data.get("results", []):
        sev = sevmap.get(r.get("extra", {}).get("severity", "WARNING"), "MEDIUM")
        rule = r.get("check_id", "").split(".")[-1]
        cat = "security" if "security" in r.get("check_id", "") or "secrets" in r.get("check_id", "") else "smell"
        out.append(finding(sev, "semgrep", cat, relpath(r.get("path")),
                           r.get("start", {}).get("line"), rule,
                           r.get("extra", {}).get("message")))
    return out


# -------------------------------------------------------------- SpotBugs ---

def class_dirs():
    dirs = []
    for pat in ("target/classes", "build/classes/java/main"):
        dirs += [str(p) for p in Path(".").rglob(pat) if p.is_dir()]
    return sorted(set(dirs))


def ensure_compiled():
    """SpotBugs analyzes bytecode, so recompile every run — never only when no
    .class files exist. On that condition a re-scan after fixes reads stale
    bytecode and re-reports issues that are already fixed, at their old line
    numbers. An incremental compile is cheap and keeps findings honest."""
    cmd = None
    if Path("pom.xml").exists():
        cmd = "mvn -q -DskipTests compile"
    elif any(Path(".").glob("build.gradle*")):
        cmd = "gradle -q compileJava"
    if cmd:
        note(f"Compiling ({cmd}) so SpotBugs sees current bytecode…")
        r = run(["bash", "-lc", cmd], timeout=900)
        if r.returncode != 0 and class_dirs():
            note("Compile failed; falling back to existing (possibly stale) classes")
            COMPILE_FAILED_STALE.append(True)
    return bool(class_dirs())


def findsecbugs_jar():
    CACHE.mkdir(parents=True, exist_ok=True)
    jar = CACHE / "findsecbugs-plugin.jar"
    if jar.exists():
        return str(jar)
    ver = "1.13.0"
    url = ("https://repo1.maven.org/maven2/com/h3xstream/findsecbugs/"
           f"findsecbugs-plugin/{ver}/findsecbugs-plugin-{ver}.jar")
    note("Downloading find-sec-bugs plugin (one-time, cached)…")
    r = run(["curl", "-fsSL", "-o", str(jar), url], timeout=120)
    return str(jar) if r.returncode == 0 and jar.exists() else ""


def run_spotbugs(targets):
    if not have("spotbugs"):
        note("SpotBugs not installed — skipping (brew install spotbugs)")
        TOOL_STATUS["spotbugs"] = "skipped"
        return []
    if not ensure_compiled():
        note("No compiled classes and compile failed — skipping SpotBugs "
             "(findings are PMD + Semgrep only)")
        TOOL_STATUS["spotbugs"] = "skipped"
        return []
    cdirs = class_dirs()
    with tempfile.NamedTemporaryFile("w", suffix=".sarif", delete=False) as o:
        sarif = o.name
    cmd = ["spotbugs", "-textui", "-effort:max", "-low", f"-sarif={sarif}"]
    jar = findsecbugs_jar()
    if jar:
        cmd += ["-pluginList", jar]
    else:
        note("find-sec-bugs jar unavailable — running SpotBugs core rules only")
    cmd += cdirs
    # The Homebrew spotbugs launcher unconditionally adds -Xdock:name/-Xdock:icon
    # on macOS (even for -textui), which registers the JVM as a GUI app, pops a
    # Dock icon, and steals keyboard focus from the active window. Force headless
    # + accessory mode so the analysis JVM never grabs focus.
    env = {**os.environ,
           "JAVA_TOOL_OPTIONS": "-Djava.awt.headless=true -Dapple.awt.UIElement=true"}
    res = run_analyzer("spotbugs", cmd, timeout=900, env=env)
    if res is None:
        return []
    try:
        data = json.loads(Path(sarif).read_text() or "{}")
    except (json.JSONDecodeError, FileNotFoundError):
        note("SpotBugs produced no parseable SARIF (OOM? plugin failure?) "
             "— marking errored, not clean")
        TOOL_STATUS["spotbugs"] = "errored"
        return []
    if not data.get("runs"):
        note("SpotBugs SARIF has no runs (analysis did not complete) "
             "— marking errored, not clean")
        TOOL_STATUS["spotbugs"] = "errored"
        return []
    TOOL_STATUS["spotbugs"] = "ran"
    out = []
    for r in data.get("runs", []):
        rules = {x["id"]: x for x in r.get("tool", {}).get("driver", {}).get("rules", [])}
        for res in r.get("results", []):
            level = res.get("level", "warning")
            sev = {"error": "HIGH", "warning": "MEDIUM", "note": "LOW"}.get(level, "MEDIUM")
            rid = res.get("ruleId", "")
            cat = "security" if "SECURITY" in rid.upper() or rid.startswith("SECBUG") \
                or "secbug" in rid.lower() else "bug"
            loc = (res.get("locations") or [{}])[0].get("physicalLocation", {})
            uri = loc.get("artifactLocation", {}).get("uri", "")
            line = loc.get("region", {}).get("startLine")
            msg = res.get("message", {}).get("text", "")
            out.append(finding(sev, "spotbugs", cat, uri or "?", line, rid, msg))
    return out


# ------------------------------------------------------------------ main ---

SEV_ORDER = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}


def in_scope(f, targets):
    if targets is None:
        return True
    # Match on resolved relative path, not basename: two same-named classes in
    # different modules must not be confused with each other.
    wanted = {relpath(t) for t in targets}
    return relpath(f["file"]) in wanted


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scope", choices=["diff", "all"], default="diff")
    ap.add_argument("--filter")
    ap.add_argument("--commit", help="files touched by a single commit (e.g. HEAD~2, a1b2c3d)")
    ap.add_argument("--range", help="files changed across a range (e.g. HEAD~3..HEAD, main...HEAD)")
    ap.add_argument("--files", nargs="*")
    ap.add_argument("-o", "--out", default="findings.json")
    args = ap.parse_args()

    targets, label = scoped_sources(args)
    note(f"Scope: {label}" + (f" ({len(targets)} source files)" if targets is not None else ""))
    if targets is not None and not targets:
        print("→ No source files in scope. Nothing to scan.")
        Path(args.out).write_text(json.dumps(
            {"status": "ok", "scope": label, "tools": {}, "errors": [],
             "warnings": list(_warnings()), "findings": []}, indent=2))
        return

    findings = []
    findings += run_pmd(targets)
    findings += run_semgrep(targets)
    findings += run_spotbugs(targets)

    # SpotBugs reports project-relative class paths; keep only in-scope findings
    # when the scan was bounded (diff / filter / explicit list).
    if targets is not None:
        findings = [f for f in findings if in_scope(f, targets)]

    findings.sort(key=lambda f: (SEV_ORDER.get(f["severity"], 9), f["file"], f["line"] or 0))

    errors = [f"{t} errored" for t, s in TOOL_STATUS.items() if s == "errored"]
    warnings = list(_warnings())
    ran = [t for t, s in TOOL_STATUS.items() if s == "ran"]
    no_analyzers = not ran
    if no_analyzers:
        errors.append("no analyzers ran (none installed or all errored)")

    fail = bool(errors) or COMPILE_FAILED_STALE
    status = "error" if fail else "ok"
    Path(args.out).write_text(json.dumps(
        {"status": status, "scope": label, "tools": dict(TOOL_STATUS),
         "errors": errors, "warnings": warnings, "findings": findings}, indent=2))

    for w in warnings:
        note(f"WARNING: {w}")

    if no_analyzers:
        print("✗ NO analyzers available/ran — this is NOT a clean result. "
              "Install/repair pmd, spotbugs, or semgrep and re-run.")
        sys.exit(3)

    if findings:
        print(f"\n{len(findings)} findings (written to {args.out}):\n")
        width = max((len(f"{f['file']}:{f['line']}") for f in findings), default=20)
        for f in findings:
            loc = f"{f['file']}:{f['line']}"
            print(f"{f['severity']:<6} {f['tool']:<9} {f['category']:<9} "
                  f"{loc:<{width}}  {f['rule']:<28} {f['message']}")
    elif fail:
        print(f"✗ Scan did NOT complete cleanly — {'; '.join(errors + warnings)}. "
              f"NOT a clean result (see {args.out}).")
    else:
        print("✓ No findings in scope.")

    if fail:
        sys.exit(1)


def _warnings():
    if COMPILE_FAILED_STALE:
        yield ("compile failed; SpotBugs ran against stale .class files — "
               "build is broken, findings may be inaccurate (stop here per skill)")
    if NO_DIFF_BASE:
        yield ("no diff base resolved; scope narrowed to uncommitted/untracked "
               "changes only — not a whole-branch result")


if __name__ == "__main__":
    main()
