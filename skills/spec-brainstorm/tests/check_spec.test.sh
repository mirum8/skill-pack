#!/usr/bin/env bash
# Behaviour tests for check_spec.py — the mechanical gate Step 4 runs over a written spec.html.
#
#   bash skills/spec-brainstorm/tests/check_spec.test.sh
#
# What this protects: the checker is the only thing between a spec that reads well and a spec
# /r:spec-design cannot build phases against. Every problem it reports is one a human would have
# to find by reading, and a checker that silently stops reporting one looks exactly like a clean
# document. There is no CI, so this is the only thing standing between an edit and that.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
CHECK="skills/spec-brainstorm/scripts/check_spec.py"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# Every fixture is a WHOLE spec, written out in full rather than patched from a base. A spec is
# 20 lines and the defect under test is one of them; a shared base with an override would make
# each case's actual input something the reader has to reconstruct. KISS > DRY in tests.
#
# The content fixtures (stories, v1, versions) deliberately carry no part spine, so each isolates
# one check. They therefore also report the missing parts — `says` only asserts that its own
# pattern appears, which is exactly what makes that harmless. GOOD_SPEC below is the one fixture
# that must come back completely clean, so it is a real seven-part document.
spec()  { cat > "$TMP/spec.html"; }
notes() { cat > "$TMP/interview-notes.md"; }

# The coverage floor, fully settled. Every fixture below is about spec.html, so the notes are held
# clean and constant — a spec case that also tripped the interview checks would report two problems
# and the test could not say which check found which.
good_notes() {
  notes <<'EOF'
mode: full
scope: new-service

## Coverage
- users-and-job: answered (round 1) — finance ops staff, daily
- core-flow: answered (round 1) — request, review, transfer
- process: answered (round 2) — reviewed above 10k
- domain-model: answered (round 2) — payout, merchant, balance
- scale: answered (round 2) — under 1k payouts a day
- anti-scope: answered (round 3) — no multi-currency
- arch-characteristics: answered (round 2) — chose holding over rejecting; transfer within 60s
- boundaries: answered (round 2) — one service, Payouts owns the payout
- style-and-topology: answered (round 2) — layered, one deployable
- api: answered (round 3) — REST over JSON
- stack-and-constraints: answered (round 1) — existing Spring stack
- integrations: answered (round 2) — the bank transfer API
- failure-behaviour: answered (round 3) — retry then hold
- decisions: answered (round 2) — 1 logged, the hold-versus-reject choice
- stories-and-v1: answered (round 3) — merchant request ships first

## Answers
Round 1 — finance ops staff run this daily on the existing Spring stack.
Round 2 — a payout belongs to a merchant and draws down a balance; the bank transfer API moves it.
Round 2 — scale is under 1k payouts a day and the boundaries are one service, layered.
Round 2 — arch-characteristics: hold rather than reject, and a transfer within 60s.
Round 3 — REST over JSON, no multi-currency, the merchant request story ships first.
Round 3 — failure-behaviour is retry then hold for manual review.

## Decisions
- **Hold rather than reject when the bank is down** — proposed rejecting; corrected. Alternative
  on the table: reject and let the merchant retry. Decided by the 60s transfer target. *(round 2)*
EOF
}

run() { python3 "$CHECK" "$TMP" 2>&1; }

# says <name> <pattern> — the checker reports it
says() {
  local out; out=$(run)
  grep -qiE "$2" <<<"$out" && ok "$1" || bad "$1" "no match for /$2/ in:${out:0:400}"
}
# silent <name> <pattern> — the checker does NOT report it
silent() {
  local out; out=$(run)
  grep -qiE "$2" <<<"$out" && bad "$1" "unexpected /$2/ in:${out:0:400}" || ok "$1"
}
# exits <name> <expected-code>
exits() {
  run >/dev/null 2>&1; local rc=$?
  [[ $rc == "$2" ]] && ok "$1" || bad "$1" "exit $rc, wanted $2"
}

# A whole seven-part document, small but structurally complete: this is the shape the skill now
# writes, so it is the shape the checker's clean case has to be. Everything the five structural
# checks read is here — part headings with ids, a linked contents list, a marked driving row, an
# Owns column, and an ADR the technologies table points at.
GOOD_SPEC='<h1>Payouts</h1>
<nav class="sidenav">
<ol class="toc">
  <li class="p"><a href="#p1">Business requirements</a></li>
  <li class="s"><a href="#stories">User stories</a></li>
  <li class="p"><a href="#p2">Domain</a></li>
  <li class="p"><a href="#p3">Architectural characteristics</a></li>
  <li class="p"><a href="#p4">Logical components</a></li>
  <li class="p"><a href="#p5">Architectural style</a></li>
  <li class="p"><a href="#p6">Decisions</a></li>
  <li class="p"><a href="#p7">Technical details</a></li>
</ol>
</nav>

<h2 class="part" id="p1">Part 1 Business requirements</h2>
<p class="lede">Finance ops move money to merchants by hand today.</p>
<h2 id="stories">User stories</h2>
<h3>Merchant requests a payout</h3>
<p>Given a merchant with a positive balance, when they request a payout,
then a pending payout is created and the balance is reduced.</p>
<h3>Finance reviews a held payout</h3>
<p>Given a payout held for review, when finance approves it,
then it moves to pending and is queued for transfer.</p>
<h2 id="v1">The v1 line</h2>
<p>v1 ships <strong>Merchant requests a payout</strong>. Deferred:
<strong>Finance reviews a held payout</strong>.</p>

<h2 class="part" id="p2">Part 2 Domain</h2>
<p class="lede">A payout moves money from a merchant balance to a bank account.</p>
<h2 id="model">Domain model</h2>
<p>A <code>Payout</code> draws down a <code>Balance</code> and ends paid or rejected.</p>

<h2 class="part" id="p3">Part 3 Architectural characteristics</h2>
<p class="lede">One number wins arguments here: money leaves within a minute.</p>
<h2 id="driving">Driving characteristics</h2>
<table>
  <tr><th>Characteristic</th><th>Target</th><th>How we would know</th></tr>
  <tr class="driving"><td>Transfer latency</td><td>under 60 s from approval</td>
      <td>timed against the bank sandbox nightly</td></tr>
</table>

<h2 class="part" id="p4">Part 4 Logical components</h2>
<p class="lede">Two components, and only one of them writes a payout.</p>
<h2 id="cut">The component cut</h2>
<table>
  <tr><th>Component</th><th>Owns</th><th>Forced by</th></tr>
  <tr><td>Payouts</td><td><code>Payout</code></td><td>Merchant requests a payout</td></tr>
  <tr><td>Ledger</td><td><code>Balance</code></td><td>Transfer latency</td></tr>
</table>

<h2 class="part" id="p5">Part 5 Architectural style</h2>
<p class="lede">A layered service in one deployable; four engineers, one release cadence.</p>
<h2 id="topology">Topology</h2>
<p>One deployable. See <a href="#adr-1">ADR-1</a>.</p>

<h2 class="part" id="p6">Part 6 Decisions</h2>
<p class="lede">One decision had a live alternative worth writing down.</p>
<h3 id="adr-1">ADR-1 — Hold a payout when the bank is unreachable</h3>
<p><b>Status</b> accepted. <b>Context</b> Transfer latency is the driving characteristic.
<b>Decision</b> An unreachable bank holds the payout. <b>Alternatives</b> Reject and let the
merchant retry — rejected, it loses the 60 s target on every retry. <b>Consequences</b> Held
payouts accumulate and need a queue nobody watches today. <b>Revisit when</b> holds exceed 200.</p>

<h2 class="part" id="p7">Part 7 Technical details</h2>
<p class="lede">The existing Spring stack, one new endpoint.</p>
<h2 id="tech">Technologies</h2>
<table>
  <tr><th>Technology</th><th>Version</th><th>Why / ADR</th></tr>
  <tr><td>Spring Boot</td><td>3.3.4</td><td>already run here</td></tr>
  <tr><td>PostgreSQL</td><td>16.4</td><td><a href="#adr-1">ADR-1</a></td></tr>
</table>
<h2 id="api">API</h2>
<p>POST /api/payouts returns 201.</p>'

echo "== a clean spec =="
good_notes
spec <<EOF
$GOOD_SPEC
EOF
silent "clean spec reports no problems" "problem"
exits   "clean spec exits 0" 0

echo
echo "== the story handles /r:spec-design builds phases against =="
good_notes
spec <<'EOF'
<h1>Payouts</h1>
<h2>Domain model</h2><p>A payout moves money.</p>
<h2>v1 scope</h2><p>v1 ships the first thing.</p>
<h2>Technology</h2><p>Spring Boot 3.3.4.</p>
EOF
says "a spec with no User stories section is reported" "user stor"

good_notes
spec <<'EOF'
<h1>Payouts</h1>
<h2>User stories</h2>
<p>Merchants can request payouts and finance can review them.</p>
<h2>v1 scope</h2><p>v1 ships payouts.</p>
<h2>Technology</h2><p>Spring Boot 3.3.4.</p>
EOF
says "stories written as prose with no <h3> handles are reported" "h3|story name"

good_notes
spec <<'EOF'
<h1>Payouts</h1>
<h2>User stories</h2>
<h3>Merchant requests a payout</h3>
<p>Given a balance, when they ask, then a payout is created.</p>
<h3>Merchant requests a payout</h3>
<p>Given a balance, when they ask again, then nothing happens.</p>
<h2>v1 scope</h2><p>v1 ships <strong>Merchant requests a payout</strong>.</p>
<h2>Technology</h2><p>Spring Boot 3.3.4.</p>
EOF
says "a duplicate story name is reported — a handle must be unique" "duplicate"

echo
echo "== a story with no acceptance criteria is a wish =="
good_notes
spec <<'EOF'
<h1>Payouts</h1>
<h2>User stories</h2>
<h3>Merchant requests a payout</h3>
<p>The merchant should be able to request a payout easily.</p>
<h2>v1 scope</h2><p>v1 ships <strong>Merchant requests a payout</strong>.</p>
<h2>Technology</h2><p>Spring Boot 3.3.4.</p>
EOF
says "a story with no Given/Then is reported" "acceptance criteria|wish"

echo
echo "== the v1 line has to name real stories =="
good_notes
spec <<'EOF'
<h1>Payouts</h1>
<h2>User stories</h2>
<h3>Merchant requests a payout</h3>
<p>Given a balance, when they ask, then a payout is created.</p>
<h2>Technology</h2><p>Spring Boot 3.3.4.</p>
EOF
says "a spec with no v1 section is reported" "v1"

good_notes
spec <<'EOF'
<h1>Payouts</h1>
<h2>User stories</h2>
<h3>Merchant requests a payout</h3>
<p>Given a balance, when they ask, then a payout is created.</p>
<h2>v1 scope</h2>
<p>v1 ships <strong>Bulk payout scheduling</strong> first.</p>
<h2>Technology</h2><p>Spring Boot 3.3.4.</p>
EOF
says "a v1 line naming a story nothing defines is reported" "no story defines|names no story"

echo
echo "== named technology carries a version =="
good_notes
spec <<'EOF'
<h1>Payouts</h1>
<h2>User stories</h2>
<h3>Merchant requests a payout</h3>
<p>Given a balance, when they ask, then a payout is created.</p>
<h2>v1 scope</h2><p>v1 ships <strong>Merchant requests a payout</strong>.</p>
<h2>Technology</h2>
<p>PostgreSQL holds the payouts. Every read and write goes through PostgreSQL directly.</p>
EOF
says "an unversioned technology is reported" "version"

echo
# The structural fixtures below mutate GOOD_SPEC with one sed expression each rather than
# restating seventy-five lines eight times over. The whole-fixture rule above still holds where a
# fixture is short; here the defect under test IS the one-line diff, and printing a full document
# around it hides the thing the case is about.
mutant() { good_notes; sed "$1" <<<"$GOOD_SPEC" > "$TMP/spec.html"; }

echo
echo "== the seven parts, and the order that makes the document readable top-down =="
mutant '/id="p3">Part 3/d; /href="#p3"/d'
says "a deleted part is reported" "part\(s\) missing.*characteristic"

mutant 's/Part 4 Logical components/Part 4 Architectural style/; s/Part 5 Architectural style/Part 5 Logical components/'
says "parts in the wrong order are reported" "out of order"

mutant 's/<h2 class="part" id="p6">/<h2 class="part">/'
says "a part heading with no id is reported" "no id"

echo
echo "== navigation: the contents list is the only way around a document this long =="
mutant 's|<a href="#p3">Architectural characteristics</a>|Architectural characteristics|'
says "an unlinked contents entry is reported" "not links"

mutant 's|<ol class="toc">|<ol>|'
says "a document with no contents list is reported" "no contents list"

mutant 's|<nav class="sidenav">||'
says "a document with no contents sidebar is reported" "no contents sidebar"

mutant 's|#adr-1|#adr-99|g'
says "an anchor pointing at no id is reported" "no id|#adr-99"

echo
echo "== Part 3: at most three driving characteristics, every one of them a number =="
mutant 's|<tr class="driving">|<tr class="driving"><td>a</td><td>1 s</td><td>x</td></tr><tr class="driving"><td>b</td><td>2 s</td><td>y</td></tr><tr class="driving"><td>c</td><td>3 s</td><td>z</td></tr><tr class="driving">|'
says "more than three driving characteristics is reported" "three is the ceiling"

mutant 's|<tr class="driving">|<tr>|'
says "driving characteristics left unmarked are reported" "driving.*rows|mark the"

mutant 's|<td>under 60 s from approval</td>|<td>fast</td>|; s|<td>timed against the bank sandbox nightly</td>|<td>we would know</td>|'
says "a characteristic that is an adjective with no number is reported" "carries no number"

echo
echo "== Part 4: ownership is exclusive, and it has to be stated =="
mutant 's|<td>Ledger</td><td><code>Balance</code></td>|<td>Ledger</td><td><code>Payout</code></td>|'
says "an entity owned by two components is reported" "ownership is exclusive"

mutant 's|<th>Owns</th>|<th>Writes</th>|'
says "a components table with no Owns column is reported" "no .Owns. column"

echo
echo "== Part 6: every ADR pointed at exists, and every ADR had an alternative =="
mutant 's|<a href="#adr-1">ADR-1</a></td>|<a href="#adr-4">ADR-4</a></td>|'
says "an ADR referenced but never written is reported" "ADR-4 referenced"

mutant 's|<b>Alternatives</b>|<b>Other notes</b>|'
says "an ADR with no Alternatives field is reported" "no Alternatives"

mutant '/adr-1">ADR-1/d'
says "a Decisions part with no ADR is reported" "carries no ADR"


echo "== a missing spec.html is a problem, not a clean run =="
rm -f "$TMP/spec.html"
says  "a missing spec.html is reported" "missing"
exits "a missing spec.html exits non-zero" 1

echo
echo "== a path that is not a directory exits 2, distinctly from a failed check =="
python3 "$CHECK" "$TMP/nope" >/dev/null 2>&1; rc=$?
[[ $rc == 2 ]] && ok "a non-directory argument exits 2" \
               || bad "a non-directory argument exits 2" "exit $rc, wanted 2"

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ $fail == 0 ]]
