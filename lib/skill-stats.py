#!/usr/bin/env python3
"""Read the pack-wide stats store and answer: which skill, and which review track, earns its keep?

    skill-stats.py                   # print the summary
    skill-stats.py --review          # only the review-pipeline section
    skill-stats.py --import-legacy   # copy the pre-pack-wide store in, once
    skill-stats.py --backfill        # mine past review runs out of Claude Code transcripts, then print
    skill-stats.py --path FILE       # use a different store
    skill-stats.py --legacy-path F   # use a different pre-pack-wide store (or /dev/null to ignore it)
    skill-stats.py --json            # machine-readable rows

TWO STORES, ONE REPORT
----------------------
~/.claude/skill-stats.jsonl is the live store every skill writes to. ~/.claude/review-stats.jsonl
is the review-only store that predates it, and it is never written.

`--import-legacy` copies its rows into the live store, normalised on the way (`skill` derived from
`kind`, `event` = result) and each stamped with `mid`, a hash of the line it came from — so a
second import appends nothing. From the first imported row on, the legacy file is no longer read:
counting a run from both stores would double every historical number. Until then it is read in
place, so no history goes missing in between. The original file is left untouched either way, which
is what makes the import safe to run: it is a copy, never a move.

WHAT THE NUMBERS CAN AND CANNOT TELL YOU
----------------------------------------
Runs are counted from `invoke` rows, which the hook writes once per invocation. `result` rows carry
what a skill found and are never counted as runs: the same run already produced an invoke row, and
counting both would double every number. The two are correlated only by (skill, repo, order) — the
prose side has no session id — so "this run found that" is an inference, not a recorded fact.

`fixes by source` is the one table worth acting on: it counts correctness items that
survived triage (i.e. were judged real and handed to a fixer), attributed to the track
that found them. A track sitting at zero across many runs is a candidate for retirement.

Three honesty caveats the summary repeats, because they decide whether a zero means anything:

  * A skill with no invoke rows was never OBSERVED, which is not the same as never used. The hook
    records from the moment it is installed; everything before that is invisible here.
  * Back-filled rows have NO attribution. Attribution was added on 2026-07-27; every
    run before it is recoverable only as aggregate counts. Those rows are marked
    origin=backfill and are excluded from the per-track table.
  * A track that did not RUN cannot find anything. `logic` scores zero on every
    standard-tier run because standard does not dispatch it — the per-track table
    therefore reports opportunities (runs where the track ran) alongside hits.

The local-scan track is absent from that table by construction, not by scoring zero: it applies
its own fixes instead of handing them to triage, so no fix can be attributed to it. Its
yield is the separate self-fix line below the status counts.
"""
import argparse
import collections
import glob
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

DEFAULT_PATH = os.path.expanduser("~/.claude/skill-stats.jsonl")
LEGACY_PATH = os.path.expanduser("~/.claude/review-stats.jsonl")
PROJECTS = os.path.expanduser("~/.claude/projects")
PACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The task-review return object as it appears (JSON-escaped) inside a transcript line.
# Anchored on both ends so a partial match can't parse into a misleading half-record.
RETURN_RE = re.compile(r'\{"reviewed":true.*?"step9":"main-agent"\}')

# The two skills that identify themselves by `kind` rather than by name — every row the store held
# before it went pack-wide, and anything still sending the older payload.
KIND_SKILL = {"review": "r:task-review", "implement": "r:task-run"}

# Which tracks each tier actually dispatches — needed to turn "0 findings" into either
# "found nothing" or "never asked". Mirrors HUNTER_SET / codexMode / wantQuality.
#
# This is versioned because the track SET changes over time, and a store spanning the change would
# otherwise lie in both directions: a track retired last month looks like it "ran" in runs after it
# was gone, and a track added last week looks like it ran in every historical row and found nothing
# — which lands it straight in the "never produced a fix, consider retiring" list on evidence that
# does not exist. `record-run.py` stamps every new review row with PIPELINE_REV; rows written before
# the stamp existed have no key and resolve to rev 1.
#
# rev 1 — the original five hunters.
# rev 2 — `concurrency` + `silent-failures` merged into `runtime-and-failures` (they returned 0.25
#         and 0.12 fixes/run for two whole contexts re-reading the same diff).
TRACK_REVS = {
    1: {
        "light":    set(),
        "standard": {"codex", "security", "docs"},
        "full":     {"codex", "security", "docs", "logic", "concurrency", "silent-failures"},
    },
    2: {
        "light":    set(),
        "standard": {"codex", "security", "docs"},
        "full":     {"codex", "security", "docs", "logic", "runtime-and-failures"},
    },
}
LATEST_REV = max(TRACK_REVS)


def tier_tracks(row):
    """The tracks this row's tier dispatched, as of the pipeline revision that wrote it."""
    rev = row.get("pipeline")
    if not isinstance(rev, int) or rev not in TRACK_REVS:
        rev = 1 if rev is None else LATEST_REV
    return TRACK_REVS[rev].get(row.get("profile") or "", set())


def packed_skills():
    """The r:-prefixed names of the skills that ship in this pack, read from the pack itself.

    Read rather than listed so a renamed or added skill cannot silently drop out of the
    never-observed line — which is the one place a missing name reads as good news.
    """
    d = os.path.join(PACK, "skills")
    if not os.path.isdir(d):
        return set()
    return {"r:" + n for n in os.listdir(d) if os.path.isdir(os.path.join(d, n))}


def normalise(row):
    """Give a pre-pack-wide row the two fields every reader now keys on."""
    row.setdefault("event", "result")
    if "skill" not in row and row.get("kind") in KIND_SKILL:
        row["skill"] = KIND_SKILL[row["kind"]]
    return row


def load(path, legacy=False):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8", errors="replace") as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                print(f"  ! skipping unparseable line {n} of {path}", file=sys.stderr)
                continue
            if legacy:
                normalise(row)
                row["store"] = "legacy"
            rows.append(row)
    return rows


def import_legacy(path, legacy):
    """Copy the pre-pack-wide store into the live one, normalised, once.

    Each copied row carries `mid`, a hash of the line it came from, so a second run appends
    nothing. That id is also what stops the two stores being counted together afterwards: once
    any imported row exists, the reader ignores the legacy file entirely (see main). Without
    that, importing would double every historical number — the failure this whole store exists
    to make impossible.
    """
    if not os.path.exists(legacy):
        print(f"import: nothing at {legacy}\n")
        return
    have = {r["mid"] for r in load(path) if r.get("mid")}
    already, out = len(have), []
    with open(legacy, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            mid = hashlib.md5(line.encode()).hexdigest()
            if mid in have:
                continue
            try:
                row = normalise(json.loads(line))
            except Exception:
                continue
            have.add(mid)
            row["mid"] = mid
            # Where it came from, kept on the row: these predate the pack-wide store, so they
            # can never carry an `invoke` row and must not be read as "this skill ran once".
            row["store"] = "legacy"
            out.append(row)
    if out:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            for r in out:
                fh.write(json.dumps(r, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(f"import: {len(out)} row(s) copied from {legacy}, "
          f"{already} already there\n")


def backfill(path, known_bfids):
    """Recover pre-instrumentation review runs from transcripts. Idempotent: each recovered
    record carries a content hash, and one already in either store is skipped."""
    existing = set(known_bfids)
    already = len(existing)
    # `found` counts raw matches, which over-counts: one return object is echoed across several
    # transcript lines (queue-operation, user, assistant). `unique` is the real run count.
    found, unique, out = 0, set(), []
    for fn in sorted(glob.glob(os.path.join(PROJECTS, "*", "*.jsonl"))):
        try:
            mtime = datetime.fromtimestamp(os.path.getmtime(fn), timezone.utc)
        except OSError:
            mtime = None
        project = os.path.basename(os.path.dirname(fn))
        with open(fn, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if "tracksBlocked" not in line:
                    continue
                try:
                    blob = json.dumps(json.loads(line))
                except Exception:
                    continue
                for m in RETURN_RE.finditer(blob.replace('\\"', '"').replace("\\\\", "\\")):
                    raw = m.group(0)
                    try:
                        d = json.loads(raw)
                    except Exception:
                        continue
                    found += 1
                    bfid = hashlib.md5(raw.encode()).hexdigest()
                    unique.add(bfid)
                    if bfid in existing:
                        continue
                    existing.add(bfid)
                    fixed = d.get("fixed") or {}
                    out.append({
                        "ts": mtime.isoformat(timespec="seconds") if mtime else None,
                        "tsApprox": True,          # the transcript's mtime, not the run's clock
                        "origin": "backfill",
                        # Mined from a past transcript, so it is by definition a rev-1 run. Stated
                        # rather than left to the default so a later rev bump can't reinterpret it.
                        "pipeline": 1,
                        "bfid": bfid,
                        "kind": "review",
                        "skill": "r:task-review",
                        # An outcome, not an observed invocation: the hook did not exist when this
                        # ran, so it must not be counted as a run.
                        "event": "result",
                        "repo": project.split("-")[-1] or project,
                        # Pre-tier runs carry `trivial` instead of `profile`.
                        "profile": d.get("profile") or ("light" if d.get("trivial") else None),
                        "tracksBlocked": d.get("tracksBlocked") or [],
                        "fixedCorrectness": fixed.get("correctness"),
                        "fixedReadability": fixed.get("readability"),
                        "docDriftCount": len(d.get("docDrift") or []),
                        "endVerify": d.get("endVerify"),
                        "localScan": d.get("localScan"),
                        "build": d.get("build"),
                        # Carried only when the mined return object actually had it. Writing an
                        # explicit null for older transcripts would claim "no scan completed" for
                        # runs where one did — the key's ABSENCE is what says "not measured here".
                        **({"scanChangedCode": d["scanChangedCode"]}
                           if "scanChangedCode" in d else {}),
                        # deliberately NO fixedBySource — it did not exist yet, and an empty
                        # dict here would read as "every track found nothing"
                    })
    if out:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            for r in out:
                fh.write(json.dumps(r, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(f"backfill: {found} transcript match(es) → {len(unique)} distinct run(s); "
          f"{len(out)} appended, {len(unique) - len(out)} already in the store "
          f"(stores held {already} back-filled row(s))\n")


def pct(n, d):
    return f"{100 * n / d:.0f}%" if d else "—"


def summarize_skills(rows):
    """The pack-wide half: who runs, where, and by which route."""
    invokes = [r for r in rows if r.get("event") == "invoke"]
    results = [r for r in rows if r.get("event") != "invoke"]

    print(f"SKILL INVOCATIONS  {len(invokes)}   ({len(results)} outcome row(s) alongside)")
    print()

    if not invokes:
        print("no invocation rows yet — hooks/record-skill-run.py records from the moment it is")
        print("installed, so an empty table here means the hook has not run, not that nothing has.")
        print()
    else:
        by_skill = collections.Counter(r.get("skill") or "<unattributed>" for r in invokes)
        vias = collections.defaultdict(collections.Counter)
        for r in invokes:
            vias[r.get("skill") or "<unattributed>"][r.get("via") or "?"] += 1
        print("runs by skill")
        for name, n in by_skill.most_common():
            route = " · ".join(f"{k} {v}" for k, v in sorted(vias[name].items()))
            print(f"  {name:<24}{n:>5}   {route}")
        print()

        by_repo = collections.Counter(r.get("repo") or "unknown" for r in invokes)
        print("runs by repo")
        for name, n in by_repo.most_common(10):
            print(f"  {name:<24}{n:>5}")
        if len(by_repo) > 10:
            print(f"  … and {len(by_repo) - 10} more")
        print()

    packed = packed_skills()
    if packed:
        # Judged on EVERY row, not just invoke rows. A skill that wrote an outcome plainly ran,
        # and calling it unobserved on the line above the table listing its outcomes is the false
        # zero this store exists to prevent — the one that retires a skill on evidence of nothing.
        dark = sorted(packed - {r.get("skill") for r in rows})
        outcome_only = sorted(({r.get("skill") for r in results} & packed)
                              - {r.get("skill") for r in invokes})
        if dark:
            print(f"never observed ({len(dark)}/{len(packed)}): {', '.join(dark)}")
            print("  (no row of any kind — that is 'not measured', not 'not useful')")
            print()
        if outcome_only:
            print(f"ran, but with no invocation recorded: {', '.join(outcome_only)}")
            print("  (the skill reported an outcome while the hook was not yet live — its runs")
            print("   are real, its run COUNT is not, so read the outcome table for these)")
            print()

    # Outcome rows are the only place a skill says what it FOUND. Which fields mean what is the
    # skill's business, so this reports the shape it can see — how many rows, from whom — and
    # leaves interpretation to the per-skill sections below.
    if results:
        by_skill = collections.Counter(r.get("skill") or "<unattributed>" for r in results)
        print("outcome rows by skill   (never counted as runs — see the header)")
        for name, n in by_skill.most_common():
            print(f"  {name:<24}{n:>5}")
        print()


def summarize_reviews(rows):
    reviews = [r for r in rows if r.get("kind") == "review"]
    impls = [r for r in rows if r.get("kind") == "implement"]
    if not reviews and not impls:
        print("no review or implement rows yet.")
        return
    live = [r for r in reviews if r.get("origin") != "backfill"]
    back = [r for r in reviews if r.get("origin") == "backfill"]

    print(f"REVIEW RUNS  {len(reviews)}   ({len(live)} instrumented · {len(back)} back-filled)")
    if impls:
        print(f"IMPLEMENT RUNS  {len(impls)}")
    print()

    # A forced tier is what someone TYPED, not what the classifier decided. Mixing the two makes
    # the distribution look like evidence about classification when it isn't — so they're split.
    # Back-filled rows have no profileForced field at all, so they can't be vouched for either.
    # Mutually exclusive, most-specific first: a back-filled row we've since confirmed was forced
    # counts as forced, not as unknown provenance.
    classified, forced, unknown = [], [], []
    for r in reviews:
        if r.get("profileForced"):
            forced.append(r)
        elif r.get("origin") == "backfill" or "profileForced" not in r:
            unknown.append(r)
        else:
            classified.append(r)

    print("tier distribution")
    for label, group in (("classified", classified), ("forced by a flag", forced),
                         ("provenance unknown (back-filled)", unknown)):
        if not group:
            continue
        c = collections.Counter(r.get("profile") or "<none>" for r in group)
        line = " · ".join(f"{k} {v}" for k, v in
                          sorted(c.items(), key=lambda kv: ("light standard full <none>".split()
                                                            .index(kv[0]) if kv[0] in
                                                            "light standard full <none>".split() else 9)))
        print(f"  {label:<34}{len(group):>4}   {line}")
    if not classified:
        print("  -> nothing here measures the classifier yet: every row is forced or back-filled.")
    print()

    direct = [r for r in reviews if r.get("invokedBy") == "direct"]
    if direct:
        print(f"note: {len(direct)} run(s) were invoked directly rather than by /r:task-run. Some of")
        print("those are RE-reviews of an already-fixed diff — their findings are not comparable")
        print("to a first pass, and this store cannot tell which. Weigh them accordingly.\n")

    # ---- the table this whole thing exists for -----------------------------
    print("fixes by source track   (instrumented runs only — back-filled runs have no attribution)")
    if not live:
        print("  no instrumented runs yet. Attribution starts accruing from the next review.")
    else:
        hits = collections.Counter()
        for r in live:
            for k, v in (r.get("fixedBySource") or {}).items():
                hits[k] += v
        # A track can only score on a run that dispatched it.
        opps = collections.Counter()
        for r in live:
            for t in tier_tracks(r):
                opps[t] += 1
            if r.get("endVerify") in ("passed", "findings-unresolved"):
                opps["end-verify"] += 1
        names = sorted(set(hits) | set(opps), key=lambda k: (-hits[k], k))
        print(f"  {'track':<16}{'fixes':>7}{'runs it ran in':>16}{'fixes/run':>12}")
        for t in names:
            rate = f"{hits[t] / opps[t]:.2f}" if opps[t] else "—"
            print(f"  {t:<16}{hits[t]:>7}{opps[t]:>16}{rate:>12}")
        dark = [t for t in names if opps[t] >= 5 and hits[t] == 0]
        if dark:
            print(f"\n  ran >=5 times and never produced a fix: {', '.join(dark)}")
            print("  (candidates for retirement — confirm the sample is big enough first)")
    print()

    blocked = collections.Counter()
    for r in reviews:
        for t in r.get("tracksBlocked") or []:
            blocked[t] += 1
    if blocked:
        print("blocked tracks  (the tool did not run — these runs certified less than they look)")
        for t, n in blocked.most_common():
            print(f"  {t:<26}{n:>4}")
        print()

    for field, title in (("endVerify", "end-verify outcome"),
                         ("localScan", "local-scan status"),
                         ("build", "build")):
        c = collections.Counter(r.get(field) for r in reviews if r.get(field))
        if c:
            print(f"{title}: " + " · ".join(f"{k} {v}" for k, v in c.most_common()))

    # The one yield number local-scan can produce. It never appears in `fixes by source` because it
    # applies its OWN fixes rather than handing them to the triage fix-list — so a zero there says
    # nothing about it, exactly like the docs hunter. What it can say is how often the scan rewrote
    # the code, which is also the expensive branch (it owes a rebuild and forces an end-verify).
    #
    # `in` and not `.get()`: a MISSING key is a row written before the field existed, and null is a
    # run where no scan completed. Neither is a scan that found nothing, and counting either as one
    # would manufacture the quiet-tool verdict this table exists to avoid.
    measured = [r for r in reviews
                if "scanChangedCode" in r and r["scanChangedCode"] is not None]
    if measured:
        hit = sum(1 for r in measured if r["scanChangedCode"])
        line = (f"local-scan self-fixed the code in {hit}/{len(measured)} "
                f"completed scan(s) ({pct(hit, len(measured))})")
        older = sum(1 for r in reviews
                    if "scanChangedCode" not in r and r.get("localScan"))
        if older:
            line += f"; {older} earlier row(s) predate the field"
        print(line)
    print()

    if impls:
        print("implement side")
        it = collections.Counter(r.get("profile") or "<none>" for r in impls)
        print("  tiers: " + " · ".join(f"{k} {v}" for k, v in it.most_common()))
        forced = sum(1 for r in impls if r.get("profileForced"))
        esc = sum(1 for r in impls if r.get("profileEscalated"))
        print(f"  forced by a flag: {forced}/{len(impls)}   escalated by riskFlags: {esc}/{len(impls)}")
        ap = sum(r.get("planApplied") or 0 for r in impls)
        dr = sum(r.get("planDropped") or 0 for r in impls)
        if ap or dr:
            print(f"  plan review: {ap} finding(s) folded in, {dr} judged false-positive")
        print()

    if back and not live:
        print("NOTE: every row here is back-filled, so the per-track table is empty by")
        print("construction. It fills in as instrumented reviews accumulate.")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--path", default=DEFAULT_PATH)
    ap.add_argument("--legacy-path", default=LEGACY_PATH,
                    help="the review-only store that predates the pack-wide one; never written")
    ap.add_argument("--import-legacy", action="store_true",
                    help="copy the legacy store's rows into the live one (idempotent, run once)")
    ap.add_argument("--backfill", action="store_true",
                    help="mine past review runs out of ~/.claude/projects transcripts first")
    ap.add_argument("--review", action="store_true",
                    help="print only the review-pipeline section")
    ap.add_argument("--json", action="store_true", help="dump the merged rows instead of a summary")
    args = ap.parse_args()

    path = os.path.expanduser(args.path)
    legacy = os.path.expanduser(args.legacy_path)

    if args.import_legacy:
        import_legacy(path, legacy)

    rows = load(path)
    # Once the legacy rows have been copied in, the file they came from is NOT read again — the
    # same run would otherwise be counted from both stores and every historical number would
    # double. Before the import it is read in place, so no history is invisible in between.
    imported = sum(1 for r in rows if r.get("mid"))
    if imported:
        print(f"note: {imported} row(s) imported from {legacy}; that file is no longer read.\n")
    else:
        rows += load(legacy, legacy=True)

    if args.backfill:
        backfill(path, {r["bfid"] for r in rows if r.get("bfid")})
        rows = load(path) + ([] if imported else load(legacy, legacy=True))

    if not rows:
        print(f"no records yet at {path}")
        print("run any /r: skill, or pass --backfill to recover past reviews from transcripts.")
        return 0
    if args.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return 0
    if not args.review:
        summarize_skills(rows)
        print("=" * 72)
        print()
    summarize_reviews(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
