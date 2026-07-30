#!/usr/bin/env python3
"""Read ~/.claude/review-stats.jsonl and answer: which review track earns its keep?

    review-stats.py                 # print the summary
    review-stats.py --backfill      # mine past runs out of Claude Code transcripts, then print
    review-stats.py --path FILE     # use a different store
    review-stats.py --json          # machine-readable summary

WHAT THE NUMBERS CAN AND CANNOT TELL YOU
----------------------------------------
`fixes by source` is the one table worth acting on: it counts correctness items that
survived triage (i.e. were judged real and handed to a fixer), attributed to the track
that found them. A track sitting at zero across many runs is a candidate for retirement.

Two honesty caveats the summary repeats, because they decide whether a zero means
anything:

  * Back-filled rows have NO attribution. Attribution was added on 2026-07-27; every
    run before it is recoverable only as aggregate counts. Those rows are marked
    origin=backfill and are excluded from the per-track table.
  * A track that did not RUN cannot find anything. `logic` scores zero on every
    standard-tier run because standard does not dispatch it — the per-track table
    therefore reports opportunities (runs where the track ran) alongside hits.
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

DEFAULT_PATH = os.path.expanduser("~/.claude/review-stats.jsonl")
PROJECTS = os.path.expanduser("~/.claude/projects")

# The post-task-review return object as it appears (JSON-escaped) inside a transcript line.
# Anchored on both ends so a partial match can't parse into a misleading half-record.
RETURN_RE = re.compile(r'\{"reviewed":true.*?"step9":"main-agent"\}')

# Which tracks each tier actually dispatches — needed to turn "0 findings" into either
# "found nothing" or "never asked". Mirrors HUNTER_SET / codexMode / wantQuality.
#
# This is versioned because the track SET changes over time, and a store spanning the change would
# otherwise lie in both directions: a track retired last month looks like it "ran" in runs after it
# was gone, and a track added last week looks like it ran in every historical row and found nothing
# — which lands it straight in the "never produced a fix, consider retiring" list on evidence that
# does not exist. `record-run.py` stamps every new row with PIPELINE_REV; rows written before the
# stamp existed have no key and resolve to rev 1.
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


def load(path):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8", errors="replace") as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                print(f"  ! skipping unparseable line {n}", file=sys.stderr)
    return rows


def backfill(path):
    """Recover pre-instrumentation runs from transcripts. Idempotent: each recovered
    record carries a content hash, and one already in the store is skipped."""
    existing = {r.get("bfid") for r in load(path) if r.get("bfid")}
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
                        # deliberately NO fixedBySource — it did not exist yet, and an empty
                        # dict here would read as "every track found nothing"
                    })
    if out:
        with open(path, "a", encoding="utf-8") as fh:
            for r in out:
                fh.write(json.dumps(r, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(f"backfill: {found} transcript match(es) → {len(unique)} distinct run(s); "
          f"{len(out)} appended, {len(unique) - len(out)} already in the store "
          f"(store had {already} back-filled row(s))\n")


def pct(n, d):
    return f"{100 * n / d:.0f}%" if d else "—"


def summarize(rows):
    reviews = [r for r in rows if r.get("kind", "review") == "review"]
    impls = [r for r in rows if r.get("kind") == "implement"]
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
    ap.add_argument("--backfill", action="store_true",
                    help="mine past runs out of ~/.claude/projects transcripts first")
    ap.add_argument("--json", action="store_true", help="dump the raw rows instead of a summary")
    args = ap.parse_args()

    path = os.path.expanduser(args.path)
    if args.backfill:
        backfill(path)
    rows = load(path)
    if not rows:
        print(f"no records yet at {path}")
        print("run a review, or pass --backfill to recover past runs from transcripts.")
        return 0
    if args.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return 0
    summarize(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
