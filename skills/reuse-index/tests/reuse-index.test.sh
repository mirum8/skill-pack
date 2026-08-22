#!/usr/bin/env bash
# Behaviour tests for reuse-index.py — the mechanical half of /r:reuse-index.
#
#   bash skills/reuse-index/tests/reuse-index.test.sh
#
# What this protects: everything this script decides is decided WITHOUT a model, and the skill
# writes prose on top of its answer. A wrong count, an anchor that fails to resolve, or a `changed`
# that never goes false does not look wrong downstream — it looks like a project whose conventions
# keep shifting. There is no CI, so this is the only thing standing between an edit and that.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
SCRIPT="skills/reuse-index/scripts/reuse-index.py"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# Each case builds a WHOLE corpus and repo from scratch. Both are a handful of files and the thing
# under test is one of them; a shared fixture with an override would make each case's actual input
# something the reader has to reconstruct. KISS > DRY in tests.
fresh() {
  rm -rf "$TMP/plans" "$TMP/repo" "$TMP/index.md"
  mkdir -p "$TMP/plans" \
           "$TMP/repo/core/src/main/java/app/deal" \
           "$TMP/repo/jpa-adapter/src/main/java/app/jpa" \
           "$TMP/repo/web-adapter/src/main/resources/templates/fragments"
  cat > "$TMP/repo/core/src/main/java/app/deal/DealService.java" <<'EOF'
package app.deal;
public class DealService {
    public void createDeal() {}
    public void archiveDeal() {}
}
EOF
  cat > "$TMP/repo/jpa-adapter/src/main/java/app/jpa/DealJpaAdapter.java" <<'EOF'
package app.jpa;
public class DealJpaAdapter {
    public void save() {}
}
EOF
  cat > "$TMP/repo/web-adapter/src/main/resources/templates/fragments/offer-card.html" \
      <<'EOF'
<div th:fragment="offerCard">card</div>
EOF
}

# plan <name> <reuse-map-body...>
plan() { local n="$1"; shift; { printf '# Plan %s\n\n## Reuse map\n\n' "$n"; cat; } > "$TMP/plans/$n.md"; }

run() { python3 "$SCRIPT" --plans "$TMP/plans" --repo "$TMP/repo" "$@" 2>&1; }

# bash 3.2 (macOS) expands "${A[@]}" on an EMPTY array to one empty argument under `set -u`, which
# argparse then rejects — every assertion would fail with a JSON parse error rather than a diff.
with_args() { if [[ ${#RUN_ARGS[@]} -eq 0 ]]; then run; else run "${RUN_ARGS[@]}"; fi; }

# jq-free field read: <json> <python-expression over `d`>
field() { python3 -c 'import json,sys;d=json.load(sys.stdin);print(eval(sys.argv[1]))' "$1"; }

# is <name> <expr> <expected>
is() {
  local got; got=$(with_args | field "$2")
  [[ "$got" == "$3" ]] && ok "$1" || bad "$1" "$2 = $got, wanted $3"
}

echo "== the threshold: two DISTINCT plans, not two mentions =="
fresh
plan a <<'EOF'
| what | exemplar |
|---|---|
| service shape | `core/.../deal/DealService.java` — copy `createDeal` |
| service shape again | `core/.../deal/DealService.java` — and `archiveDeal` |
EOF
RUN_ARGS=()
is "one plan citing an exemplar twice is still one plan" "len(d['candidates'])" 0

plan b <<'EOF'
| what | exemplar |
|---|---|
| service shape | `core/.../deal/DealService.java` — copy `createDeal` |
EOF
is "a second plan citing it makes it a candidate" "len(d['candidates'])" 1
is "cited counts distinct plans, never rows"      "d['candidates'][0]['cited']" 2

echo
echo "== rows are read positionally, because the column headings never settled =="
fresh
plan a <<'EOF'
| Pattern | Canonical example | Notes |
|---|---|---|
| service | `core/.../deal/DealService.java` | uses `createDeal` |
EOF
plan b <<'EOF'
- reuse the deal service at `core/.../deal/DealService.java`, see `archiveDeal`
EOF
RUN_ARGS=()
is "a table and a bullet list are both read"  "len(d['candidates'])" 1
is "and both count toward the threshold"     "d['candidates'][0]['cited']" 2

echo
echo "== anchors resolve elided, and symbols are verified against the file =="
fresh
plan a <<'EOF'
| service | `core/.../deal/DealService.java` — `createDeal`, `archiveDeal` |
EOF
plan b <<'EOF'
| service | `core/.../deal/DealService.java` — `createDeal`, `noSuchMethod` |
EOF
RUN_ARGS=()
is "an elided anchor resolves to a real repo path" \
   "d['candidates'][0]['path']" "core/src/main/java/app/deal/DealService.java"
is "a symbol present in the file is verified" \
   "'createDeal' in d['candidates'][0]['symbolsVerified']" "True"
is "a symbol the file does not contain is NOT verified" \
   "'noSuchMethod' in d['candidates'][0]['symbolsVerified']" "False"

echo
echo "== an exemplar no longer in the repo is reported unresolved, not dropped silently =="
fresh
plan a <<'EOF'
| gone | `core/.../deal/DeletedService.java` — `oldThing` |
EOF
plan b <<'EOF'
| gone | `core/.../deal/DeletedService.java` — `oldThing` |
EOF
RUN_ARGS=()
is "it still appears as a candidate"     "len(d['candidates'])" 1
is "with resolved false"                 "d['candidates'][0]['resolved']" "False"
is "and is named in unresolved"          "d['unresolved']" "['DeletedService.java']"

echo
echo "== --min-cited is honoured =="
fresh
plan a <<'EOF'
| service | `core/.../deal/DealService.java` |
EOF
plan b <<'EOF'
| service | `core/.../deal/DealService.java` |
EOF
RUN_ARGS=(--min-cited 3)
is "raising the threshold above the citation count drops the candidate" "len(d['candidates'])" 0
RUN_ARGS=(--min-cited 2)
is "and lowering it back brings it in"                                  "len(d['candidates'])" 1

echo
echo "== a refresh is idempotent: an index that already names everything reports changed=false =="
fresh
plan a <<'EOF'
| service | `core/.../deal/DealService.java` — `createDeal` |
EOF
plan b <<'EOF'
| service | `core/.../deal/DealService.java` — `createDeal` |
EOF
cat > "$TMP/index.md" <<'EOF'
# Reuse index

## Core

| Pattern | Canonical example | Reach for it when | Cited | Plan |
|---|---|---|---|---|
| Deal service shape | `core/.../deal/DealService` — `createDeal` | Adding a core service | 2 | a, b |
EOF
RUN_ARGS=(--index "$TMP/index.md")
is "an existing index is read back"                    "d['index']['exists']" "True"
is "its entries are parsed"                            "d['index']['entries']" 1
is "a fully-covered corpus reports no new exemplars"   "d['new']" "[]"
is "and changed is false — this is what makes a refresh cheap" "d['changed']" "False"

echo
echo "== a rising citation count is reported, so an entry's Cited line can be corrected =="
plan c <<'EOF'
| service | `core/.../deal/DealService.java` — `createDeal` |
EOF
RUN_ARGS=(--index "$TMP/index.md")
is "the new citation is noticed"  "d['countChanged'][0]['was'], d['countChanged'][0]['now']" "(2, 3)"
is "and changed flips to true"    "d['changed']" "True"

echo
echo "== an exemplar the doc names but does not tabulate is still 'known' =="
# Otherwise every deliberate omission is re-proposed on every future refresh and `changed`
# is never false again.
fresh
plan a <<'EOF'
| adapter | `jpa-adapter/.../DealJpaAdapter.java` |
EOF
plan b <<'EOF'
| adapter | `jpa-adapter/.../DealJpaAdapter.java` |
EOF
cat > "$TMP/index.md" <<'EOF'
# Reuse index

## Core

| Pattern | Canonical example | Reach for it when | Cited | Plan |
|---|---|---|---|---|
| Deal service shape | `core/.../deal/DealService` — `createDeal` | Adding a core service | 2 | a |

## Considered and not carried

`DealJpaAdapter.java` is cited twice, but the two plans copied it for different reasons.
EOF
RUN_ARGS=(--index "$TMP/index.md")
is "an exemplar named only in prose is not re-proposed" "d['new']" "[]"
is "so changed stays false"                             "d['changed']" "False"

echo
echo "== a missing corpus is an error, never an empty-but-clean answer =="
rm -rf "$TMP/plans"
out=$(python3 "$SCRIPT" --plans "$TMP/plans" --repo "$TMP/repo" 2>&1)
[[ "$(field "d['error']" <<<"$out")" == "no-corpus" ]] \
  && ok "a missing plans dir reports error: no-corpus" \
  || bad "a missing plans dir reports error: no-corpus" "$out"

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ $fail == 0 ]]
