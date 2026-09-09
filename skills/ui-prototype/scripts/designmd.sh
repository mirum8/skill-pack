#!/usr/bin/env bash
#
# designmd.sh — the only way /r:ui-prototype reaches the DESIGN.md CLI.
#
# It wraps `@google/design.md`, which is what makes a proposed visual identity REAL rather
# than asserted: the linter checks WCAG contrast, a missing primary palette, section order,
# broken token references and orphaned tokens, and the exporter turns the frontmatter into
# the CSS the comparison page is built from. A model cannot do either by reading its own
# output, which is why nothing here may be substituted by a prose imitation.
#
# Subcommands pass straight through:
#
#   lint   <file> [--format json|text]   validate a DESIGN.md
#   export <file> --format <fmt>         css-vars | css-tailwind | json-tailwind | tailwind | dtcg
#   diff   <a> <b>                       what one candidate changes against another
#   spec                                 print the format specification
#
# Exit codes are the whole contract. Each exists because the failure it names otherwise
# returns a confident wrong answer:
#
#   0    the command ran and produced real output — see "positive evidence" below
#   1    the CLI ran and the file has lint ERRORS (a real result, passed through)
#   2    the file is unreadable (the CLI's own code, passed through)
#   3    RESERVED, never returned. A caller that branches on it fails loud instead of
#        mistaking a skip for something else.
#   4    node/npx absent, or the package could not be fetched. First stdout line is
#        "DESIGNMD SKIPPED: ...". Read that marker, never the code alone.
#   64   usage
#   any other code — the wrapper itself failed; stdout is NOT lint output.
#
# WHY THE SKIP EXITS NON-ZERO, unlike the Codex wrapper's skip. Codex is an OPTIONAL
# reviewer: a caller carries on with its other reviewers, so a missing plugin must not read
# as a hard error. This tool is not optional here — it is the entire mechanism that makes a
# candidate real, and there is no degraded path that continues "just less thoroughly". A
# caller must be UNABLE to walk past the skip without noticing. The marker line stays the
# detection mechanism regardless: "npx could not fetch" and "the CLI rejected the file" are
# different failures that an exit code alone cannot tell apart.
#
# POSITIVE EVIDENCE, never the absence of an error. `lint --format json` must produce JSON
# carrying a `summary` object; `export --format css-vars` must produce at least one `--`
# custom-property declaration. An empty response under a zero exit is the shape of "no
# findings" — an invalid DESIGN.md banked as clean, then rendered, picked and committed —
# and an empty export becomes a blank <style> block that renders every candidate identically.
#
# No retry loop. The Codex wrapper retries because it has a documented transient class
# (app-server startup races); this is a synchronous local CLI invocation with none, and a
# retry would only turn a real "no network" into an intermittent one.
set -uo pipefail

PKG="@google/design.md@0.4.0"     # PINNED: the format declares version "alpha" and the CLI is
                                  # 0.x, so an unpinned npx picks up a breaking minor and changes
                                  # what lints clean — which reads as "the palette got worse",
                                  # never as "the tool changed".
E_LINT=1 E_UNREADABLE=2 E_SKIP=4 E_USAGE=64

usage() {
  sed -n '3,47p' "$0" | sed 's/^# \{0,1\}//'
  exit $E_USAGE
}

# --help before anything resolves. Probing the wrapper must never start a package fetch.
for a in "$@"; do
  case "$a" in -h|--help|help) usage ;; esac
done
[ $# -ge 1 ] || usage

SUB="$1"; shift
case "$SUB" in
  lint|export|diff|spec) ;;
  *) echo "designmd.sh: unknown subcommand '$SUB'" >&2; usage ;;
esac

# Resolution order: a project-local install, then a global one, then npx. The first two make a
# project that vendored the CLI work offline; npx is the fallback that needs the network once.
if [ -x "./node_modules/.bin/design.md" ]; then
  RUN=(./node_modules/.bin/design.md)
elif command -v design.md >/dev/null 2>&1; then
  RUN=(design.md)
elif command -v designmd >/dev/null 2>&1; then
  RUN=(designmd)
elif command -v npx >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  RUN=(npx --yes "$PKG")
else
  echo "DESIGNMD SKIPPED: no node/npx and no local design.md — the DESIGN.md CLI could not run."
  echo "DESIGNMD SKIPPED: report every file it would have checked as UNLINTED, never as clean." >&2
  exit $E_SKIP
fi

OUT=$(mktemp); ERR=$(mktemp)
trap 'rm -f "$OUT" "$ERR"' EXIT
"${RUN[@]}" "$SUB" "$@" >"$OUT" 2>"$ERR"; rc=$?

# npx failing to resolve or fetch the package is a SKIP, not a verdict on the file. It surfaces
# as a non-zero rc with npm's resolution wording on stderr and nothing usable on stdout — the
# same shape as a real CLI failure unless the text is read.
if [ $rc -ne 0 ] && [ ! -s "$OUT" ] &&
   grep -qiE 'ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|network|registry|404 Not Found|could not determine executable|npm error' "$ERR"; then
  echo "DESIGNMD SKIPPED: could not fetch $PKG — the DESIGN.md CLI could not run."
  sed 's/^/DESIGNMD SKIPPED: /' "$ERR" >&2
  exit $E_SKIP
fi

[ $rc -eq $E_UNREADABLE ] && { cat "$ERR" >&2; exit $E_UNREADABLE; }

# Positive evidence, per subcommand.
case "$SUB" in
  lint)
    if grep -q -- '--format[= ]*text' <<<"$*"; then
      [ -s "$OUT" ] || { echo "designmd.sh: lint produced no output; the CLI did not report on this file" >&2; exit 5; }
    elif ! python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if isinstance(d.get("summary"),dict) and "errors" in d["summary"] else 1)' <"$OUT" 2>/dev/null; then
      echo "designmd.sh: lint returned no parseable report (no summary object)." >&2
      echo "designmd.sh: this is NOT a clean file — nothing checked it." >&2
      head -c 2000 "$OUT" >&2
      exit 5
    fi
    ;;
  export)
    if ! grep -q -- '--[A-Za-z0-9_-]\+[[:space:]]*:' "$OUT"; then
      echo "designmd.sh: export produced no custom-property declarations; refusing to hand back" >&2
      echo "designmd.sh: an empty token set that would render every candidate identically." >&2
      exit 5
    fi
    ;;
  diff|spec)
    [ -s "$OUT" ] || { echo "designmd.sh: $SUB produced no output" >&2; exit 5; }
    ;;
esac

cat "$OUT"; cat "$ERR" >&2
[ $rc -ne 0 ] && exit $([ $rc -eq $E_LINT ] && echo $E_LINT || echo $rc)
exit 0
