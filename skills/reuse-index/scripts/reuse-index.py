#!/usr/bin/env python3
"""Mechanical half of /r:reuse-index — extract, count, resolve, diff.

Everything here is deterministic: pulling `## Reuse map` sections out of a plan corpus,
counting how many DISTINCT plans cite each exemplar, resolving each to a real path in the
repo, and diffing all of that against an index doc that already exists. The judgment half
— deciding which rows describe the same pattern, and writing the prose — is the skill's.

The split matters for cost: a refresh runs this script every time and only needs a model
when the diff says something actually changed.

Reads nothing but the plan corpus, the repo file list, and the index. Writes nothing.
"""
import argparse
import json
import os
import re
import sys

HEADING = re.compile(r'^(#{1,6})\s+(.*)$')
REUSE_HEADING = re.compile(r'reuse\s+map', re.I)

# The corpus was written by many runs and the column headings never settled — 30 different
# spellings across 37 tables in the reference corpus, plus 11 sections that are bullet lists
# instead. Nothing downstream may depend on a heading's wording, so rows are read positionally
# and the header row is identified structurally (the line before the |---| separator).
SEPARATOR = re.compile(r'^\|[\s:|-]+\|?\s*$')

PATH_TOKEN = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_/.-]*\.(?:java|kt|html|sql|md|js|mjs|css|py|yml|yaml|xml)\b')
IDENT = re.compile(r'`([^`]+)`')
IDENT_OK = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{3,}$')
BACKTICKED = re.compile(r'`([^`]+)`')
FILE_SUFFIX = re.compile(r'\.(?:java|kt|html|sql|md|js|mjs|css|py|yml|yaml|xml)$')
CLASSY = re.compile(r'^[A-Z][A-Za-z0-9_]*$')

SKIP_DIRS = {'.git', 'target', 'node_modules', '.idea', '.gradle', '.task-plans'}

# Only ever build output, and only where build output actually lands. Skipping any directory
# NAMED build/out/dist costs a hexagonal project its entire out-port package
# (`core/.../port/out/`), which is exactly the layer a reuse index is most wanted for.
BUILD_DIRS = {'build', 'out', 'dist'}


def read(path):
    with open(path, encoding='utf-8', errors='replace') as fh:
        return fh.read()


def sections(text, matcher):
    """Yield the body of every section whose heading matches, ending at the next heading
    of the same or higher level. Level-aware because a reuse map may carry ### subheadings."""
    lines = text.splitlines()
    out, i = [], 0
    while i < len(lines):
        m = HEADING.match(lines[i])
        if m and matcher.search(m.group(2)):
            level, body, i = len(m.group(1)), [], i + 1
            while i < len(lines):
                h = HEADING.match(lines[i])
                if h and len(h.group(1)) <= level:
                    break
                body.append(lines[i])
                i += 1
            out.append('\n'.join(body))
        else:
            i += 1
    return out


def rows_of(body):
    """Rows from a reuse-map section, in either shape it is written in."""
    lines = body.splitlines()
    out = []
    header_at = None
    for n, line in enumerate(lines):
        s = line.strip()
        if SEPARATOR.match(s) and n and lines[n - 1].strip().startswith('|'):
            header_at = n - 1
            continue
        if s.startswith('|'):
            if header_at is not None and n in (header_at, header_at + 1):
                continue
            cells = [c.strip() for c in s.strip('|').split('|')]
            if any(cells):
                out.append(cells)
        elif s.startswith('- ') or s.startswith('* '):
            out.append([s[2:].strip()])
    return out


def repo_index(repo):
    """basename -> sorted list of repo-relative paths. Elided anchors (`jpa-adapter/.../X.java`)
    are the norm in the corpus, so the basename is the only key that reliably joins."""
    idx = {}
    for root, dirs, files in os.walk(repo):
        depth = 0 if root == repo else root[len(repo):].strip(os.sep).count(os.sep) + 1
        dirs[:] = [d for d in dirs
                   if d not in SKIP_DIRS
                   and not d.startswith('.claude')
                   and not (d in BUILD_DIRS and depth <= 1)]
        for f in files:
            idx.setdefault(f, []).append(os.path.relpath(os.path.join(root, f), repo))
    for v in idx.values():
        v.sort(key=lambda p: (p.count(os.sep), len(p)))
    return idx


def collect(plans_dir):
    """Every reuse-map row in the corpus, tagged with the plan it came from."""
    corpus = []
    plan_files = sorted(f for f in os.listdir(plans_dir) if f.endswith('.md'))
    with_map = 0
    for name in plan_files:
        bodies = sections(read(os.path.join(plans_dir, name)), REUSE_HEADING)
        if not bodies:
            continue
        with_map += 1
        for body in bodies:
            for cells in rows_of(body):
                corpus.append({'plan': name, 'cells': cells, 'text': ' | '.join(cells)})
    return plan_files, with_map, corpus


def candidates(corpus, repo, idx, min_cited):
    """Group rows by the exemplar file they cite, and keep those enough plans agree on."""
    by_file = {}
    for row in corpus:
        for base in {os.path.basename(t) for t in PATH_TOKEN.findall(row['text'])}:
            by_file.setdefault(base, {'rows': [], 'plans': set()})
            by_file[base]['rows'].append(row)
            by_file[base]['plans'].add(row['plan'])

    out = []
    for base, hit in sorted(by_file.items()):
        cited = len(hit['plans'])
        if cited < min_cited:
            continue
        paths = idx.get(base, [])
        symbols = set()
        for row in hit['rows']:
            for tok in IDENT.findall(row['text']):
                tok = tok.strip().lstrip('.').split('(')[0].split('#')[0].strip()
                if IDENT_OK.match(tok) and tok != os.path.splitext(base)[0]:
                    symbols.add(tok)
        verified = []
        if paths:
            content = read(os.path.join(repo, paths[0]))
            verified = sorted(s for s in symbols if s in content)
        out.append({
            'exemplar': base,
            'path': paths[0] if paths else None,
            'alsoAt': paths[1:6],
            'resolved': bool(paths),
            'cited': cited,
            'citedBy': sorted(hit['plans']),
            'symbols': sorted(symbols)[:20],
            'symbolsVerified': verified[:20],
            'rows': [{'plan': r['plan'], 'cells': r['cells']} for r in hit['rows']],
        })
    out.sort(key=lambda c: (-c['cited'], c['exemplar']))
    return out


def resolve_anchor(tok, repo, idx):
    """Resolve one anchor token to a repo path.

    Anchors are written the way the doc prescribes — elided (`core/.../calculator/Foo`) and
    without a file extension — so they cannot be `isfile`-tested directly. Resolving them the
    same way candidates are resolved (by basename, then filtered on the segments that survived
    the elision) is what keeps a refresh idempotent: read them literally instead and every
    entry in a correctly-written index reads back as new, and every anchor as stale.
    """
    tok = tok.strip().rstrip('.')
    base = os.path.basename(tok)
    names = [base] if FILE_SUFFIX.search(base) else (
        [base + s for s in ('.java', '.kt')] if CLASSY.match(base) else [])
    for name in names:
        hits = idx.get(name)
        if not hits:
            continue
        keep = [s for s in tok.split('/') if s and s != '...']
        picked = [h for h in hits
                  if all(s.rsplit('.', 1)[0] in h for s in keep)] or hits
        return picked[0]
    return None


def index_entries(index_path, repo, idx):
    """Parse the index doc back into entries. The doc is its own state file: the anchors and
    the Cited counts are all a refresh needs, so there is no marker file to fall out of sync."""
    if not index_path or not os.path.isfile(index_path):
        return None
    entries = []
    section = None
    for line in read(index_path).splitlines():
        h = HEADING.match(line)
        if h:
            section = h.group(2).strip()
            continue
        s = line.strip()
        if not s.startswith('|') or SEPARATOR.match(s):
            continue
        cells = [c.strip() for c in s.strip('|').split('|')]
        if len(cells) < 4 or cells[3].lower() in ('cited', ''):
            continue
        # The format is "path — symbol", so split on the em dash rather than guessing per token:
        # everything before it names files, everything after names things INSIDE them. Guessing
        # instead is unresolvable — a bare `RowCursor` and a bare `TestUsers` look identical,
        # and reading the first as a file reports a live inner record as a dead anchor.
        # The format is "path — symbol", and the two halves get opposite treatment, because a bare
        # `RowCursor` and a bare `TestUsers` are syntactically identical and only their position
        # and resolvability tell them apart:
        #   before the dash, a token that will not resolve is a STALE anchor;
        #   after it, one that resolves is a secondary exemplar and one that does not is a symbol.
        # Read the whole cell one way and you either report live inner records as dead anchors,
        # or you report the secondary exemplars as new on every refresh, forever.
        head, _, tail = cells[1].partition('—')
        namey = lambda x: (FILE_SUFFIX.search(os.path.basename(x.strip().rstrip('.')))
                           or CLASSY.match(os.path.basename(x.strip().rstrip('.'))))
        anchors = [(x, resolve_anchor(x, repo, idx)) for x in BACKTICKED.findall(head) if namey(x)]
        anchors += [(x, r) for x, r in
                    ((x, resolve_anchor(x, repo, idx)) for x in BACKTICKED.findall(tail) if namey(x))
                    if r]
        try:
            cited = int(re.sub(r'\D', '', cells[3]) or 0)
        except ValueError:
            cited = 0
        entries.append({
            'section': section,
            'pattern': cells[0],
            'anchor': cells[1],
            'paths': [r for _, r in anchors if r],
            'unresolved': [x for x, r in anchors if not r],
            'cited': cited,
        })
    return entries


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--plans', required=True, help='the plan corpus directory')
    ap.add_argument('--repo', default='.', help='repo root the anchors resolve against')
    ap.add_argument('--index', default=None, help='the index doc, when one already exists')
    ap.add_argument('--min-cited', type=int, default=2,
                    help='how many DISTINCT plans must cite an exemplar (default 2)')
    args = ap.parse_args()

    if not os.path.isdir(args.plans):
        print(json.dumps({'error': 'no-corpus', 'plans': args.plans}))
        return 0

    plan_files, with_map, corpus = collect(args.plans)
    idx = repo_index(args.repo)
    cands = candidates(corpus, args.repo, idx, args.min_cited)
    existing = index_entries(args.index, args.repo, idx)

    # Anything the doc NAMES has been considered, whether it became an entry or was written into
    # a "considered and not carried" note. Counting only table anchors makes every deliberate
    # omission read as a new candidate on every future refresh, so the same rejected exemplars
    # get re-proposed forever and `changed` is never false.
    known = set()
    if existing:
        for e in existing:
            known.update(os.path.basename(p) for p in e['paths'])
        doc = read(args.index)
        for tok in BACKTICKED.findall(doc):
            base = os.path.basename(tok.strip().rstrip('.'))
            if FILE_SUFFIX.search(base):
                known.add(base)

    stale = []
    if existing:
        for e in existing:
            if e['unresolved']:
                alt = {x: idx.get(os.path.basename(x) + '.java', [])[:3] for x in e['unresolved']}
                stale.append({'pattern': e['pattern'], 'anchor': e['anchor'],
                              'missing': e['unresolved'], 'candidates': alt})

    fresh = [c for c in cands if c['exemplar'] not in known]
    counts = []
    if existing:
        by_base = {c['exemplar']: c for c in cands}
        for e in existing:
            # An entry may name several exemplars, so its count is the MAX across them, never the
            # first one that happens to match: a pattern is as well attested as its best-attested
            # exemplar, and picking arbitrarily makes the number depend on anchor order.
            seen = [by_base[os.path.basename(p)]['cited'] for p in e['paths']
                    if os.path.basename(p) in by_base]
            if seen and max(seen) != e['cited']:
                counts.append({'pattern': e['pattern'], 'was': e['cited'], 'now': max(seen)})

    print(json.dumps({
        'corpus': {'dir': args.plans, 'plans': len(plan_files), 'withReuseMap': with_map,
                   'rows': len(corpus)},
        'minCited': args.min_cited,
        'index': {'path': args.index, 'exists': existing is not None,
                  'entries': len(existing or [])},
        'candidates': cands,
        'new': [c['exemplar'] for c in fresh],
        'unresolved': [c['exemplar'] for c in cands if not c['resolved']],
        'countChanged': counts,
        'stale': stale,
        'changed': bool(fresh or counts or stale) if existing is not None else True,
    }, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
