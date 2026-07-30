#!/usr/bin/env bash
# Resolve the codex companion script and run an adversarial review through it.
# This is the SAME real tool that the user-only `/codex:adversarial-review`
# slash command wraps — we just call it directly so a subagent/model can invoke
# it (the slash command sets disable-model-invocation and is unreachable here).
set -euo pipefail

# --help must answer in milliseconds and touch nothing. It is checked FIRST, before the companion
# is even resolved, because the companion has no help path of its own: `lib/args.mjs` folds any
# unrecognized flag into the review's positionals, so `adversarial-review --help` starts a REAL
# Codex review with the focus text "--help" and runs for minutes. An agent probing this script's
# usage then hangs and has to be pkill'd — observed, ~2.5 minutes lost. Nothing below this block
# may run for --help.
usage() {
  cat <<'EOF'
run.sh — run the REAL Codex reviewer over the current diff and print its findings.

  run.sh [--mode review|adversarial-review] [--base <ref>] [--scope auto|working-tree|branch]
         [--wait] ["extra focus text"]

  --mode adversarial-review  (default) strict challenge review: a prompt-driven Codex session that
                             questions the approach and the design, not just defects.
  --mode review              Codex's lighter BUILT-IN reviewer (the one /codex:review wraps).
                             It rejects trailing focus text — pass only --base/--scope with it.
  --base <ref>               review against a base ref.      --scope auto|working-tree|branch
  --wait                     accepted and forwarded; reviews always run in the foreground anyway.
  -h, --help                 print this and exit 0 without starting Codex.

Exit codes: 0 = the review ran (findings on stdout, followed by a provenance block saying what it
examined) · 3 = the Codex plugin is not installed · 4 = Codex could not inspect the diff after 3
attempts (NOT a clean review) · anything else = the wrapper itself failed; stdout is not findings.

Env: ADVERSARIAL_REVIEW_TIMEOUT (per-attempt seconds, default 600).
EOF
}
# Only the two real flags — NOT a bare `help`, which could plausibly be trailing focus text.
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
  esac
done

MARKET="$HOME/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs"
COMPANION=""

if [[ -f "$MARKET" ]]; then
  COMPANION="$MARKET"
else
  # Fall back to the newest version-pinned cache install.
  COMPANION="$(ls -1d "$HOME"/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null | sort -V | tail -n1 || true)"
fi

if [[ -z "$COMPANION" || ! -f "$COMPANION" ]]; then
  # The Codex plugin is OPTIONAL. Absent, this is a SKIP the caller records
  # and moves past — not a failure that stops it. Exit 0 so no caller can
  # mistake it for a hard error; the CODEX SKIPPED marker on the first line
  # is what tells a skip apart from a clean review.
  echo "CODEX SKIPPED: the OpenAI Codex plugin is not installed, so NO Codex review ran."
  echo "CODEX SKIPPED: add it with  /plugin marketplace add openai-codex  then  /plugin install codex@openai-codex"
  echo "CODEX SKIPPED: report this step as skipped. Do NOT fake a review or substitute an LLM imitation." >&2
  exit 0
fi

# Which Codex reviewer to run. Defaults to the strict adversarial/challenge
# review (what every existing caller wants). Pass `--mode review` for the lighter
# built-in reviewer — the same one the user-only `/codex:review` wraps — e.g. a
# regression-only end-verify pass that just needs to catch breaks the fixes
# introduced, not re-challenge the whole approach. It's a per-invocation flag
# (parsed out here, not an env var) so concurrent runs can't clobber each other.
MODE="adversarial-review"
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)   MODE="${2:-}"; shift 2 ;;
    --mode=*) MODE="${1#--mode=}"; shift ;;
    *)        ARGS+=("$1"); shift ;;
  esac
done
case "$MODE" in
  review|adversarial-review) ;;
  *) echo "ERROR: invalid --mode='$MODE' (use 'review' or 'adversarial-review')" >&2; exit 2 ;;
esac

# The Codex CLI runtime occasionally rejects its own shell tool calls with a
# schema-validation error, so Codex "completes" but never inspects the diff and
# emits a phantom "Review blocked" finding. That failure is transient — retrying
# clears it. Detect it and retry up to 3 times before giving up.
BLOCKED_RE='Review blocked|could not be inspected|rejected tool calls|execution environment rejected|before any repository inspection|Re-run the review in an environment'
# The companion's OWN degraded-render strings (scripts/lib/render.mjs). Every one of
# these means "no review happened", and none matched the list above — the first is
# emitted on the exact phantom-clean path: Codex exits 0 having produced no review text.
BLOCKED_RE="$BLOCKED_RE"'|completed without any stdout output|Codex review failed|did not return valid structured JSON|unexpected review shape'
# Generic "it didn't happen" phrasing, as backup. This is a blacklist, so it is the
# LAST line of defence, not the mechanism — REVIEW_RE below is what actually decides.
BLOCKED_RE="$BLOCKED_RE"'|unable to (run|inspect|complete)|could not (run|complete|inspect)'

# The positive marker. Every render path in the companion opens with `# Codex <label>`
# (render.mjs: renderReviewResult x3, renderNativeReviewResult). Its ABSENCE proves the
# companion never rendered a review at all, whatever the exit code says. Asking "did a
# review actually happen?" is the only check that can't be evaded by unanticipated
# wording — the blacklist above only ever catches phrasing someone already thought of.
REVIEW_RE='^# Codex '
# Hard failures seen on STDERR while the companion still exits 0 — a recursion into a
# mirrored skill copy dying on mktemp is the case this exists for. Deliberately much
# narrower than BLOCKED_RE: stderr carries incidental noise, and the original reason
# for ignoring it (an unrelated line forcing a false block) is still a real risk.
HARD_FAIL_RE='mktemp: |cannot create temp|Operation not permitted|Permission denied|EACCES|recursion (limit|depth)|maximum call stack'
# Codex's app-server can fail to come up cleanly — a cold-start / config-load
# race (seen as "failed to load configuration") or a dropped IPC connection.
# These exit non-zero but are TRANSIENT: a fresh attempt brings the app-server up
# and the review runs. Treat them like the blocked/timeout cases (retry), not
# like a permanent wrapper failure (bad flag, node missing) which must surface.
TRANSIENT_RE='failed to load configuration|app-server (exited|closed|terminated|failed)|ECONNREFUSED|connection refused|broker (session|endpoint)|unexpected end of (JSON|stream)|stream closed|write EPIPE'
MAX_ATTEMPTS=3
ATTEMPT_TIMEOUT="${ADVERSARIAL_REVIEW_TIMEOUT:-600}"
out=""
rc=0

# --- what this run actually examined -----------------------------------------------------------
# A bare "Verdict: approve / No material findings." is byte-identical whether Codex read every line
# of the diff or barely looked, and the companion hides the difference. Concretely (lib/git.mjs):
# for `r:code-adversarial` the diff TEXT is embedded in the prompt only when the change is
# <= DEFAULT_INLINE_DIFF_MAX_FILES (2) files AND <= DEFAULT_INLINE_DIFF_MAX_BYTES (256K); above
# either bound the prompt carries just a file list + shortstat and tells Codex to "inspect the
# target diff yourself with read-only git commands". `--mode review` embeds nothing at all — the
# built-in reviewer fetches its own target. So an ordinary 12-file diff reaches the adversarial
# reviewer as a FILE LIST, and whether it then read the code is Codex's own business.
# None of that is visible in the verdict, so print it alongside: the caller can then tell "ran and
# found nothing" from "ran over a summary". Nothing here changes the exit-code contract.
INLINE_MAX_FILES=2
INLINE_MAX_BYTES=$((256 * 1024))
BASE_REF=""
if [[ "${#ARGS[@]}" -gt 0 ]]; then
  for ((i = 0; i < ${#ARGS[@]}; i++)); do
    case "${ARGS[$i]}" in
      --base)   BASE_REF="${ARGS[$((i + 1))]:-}" ;;
      --base=*) BASE_REF="${ARGS[$i]#--base=}" ;;
    esac
  done
fi
# Every helper below must succeed even outside a git repo — provenance is a courtesy, and killing
# a finished review over a failed `git diff` would trade a real result for a cosmetic one.
diff_range() { if [[ -n "$BASE_REF" ]]; then printf '%s...HEAD' "$BASE_REF"; else printf 'HEAD'; fi; }
git_stat()   { git diff --shortstat "$1" 2>/dev/null || true; }
git_files()  { git diff --name-only "$1" 2>/dev/null | grep -c . || true; }
git_bytes()  { git diff "$1" 2>/dev/null | wc -c || true; }

# provenance <attempt> <secs> [blocked]
# A third argument marks this as the record of a run that never reviewed anything. That case gets
# the same target/context lines — they say what the run was AIMING at, which is worth recording —
# but the "reading:" footer is inverted. Emitting the normal footer on a blocked run would be
# worse than emitting nothing at all: a caller reads this block as evidence the review happened,
# so "a clean verdict says Codex reported nothing" under a run that produced no verdict is exactly
# the phantom-clean reading the exit-4 trailer exists to prevent.
provenance() {
  local attempt="$1" secs="$2" blocked="${3:-}" range stat nfiles nbytes ctx
  range="$(diff_range)"
  stat="$(git_stat "$range" | sed 's/^[[:space:]]*//')"
  nfiles="$(git_files "$range" | tr -d '[:space:]')"; nfiles="${nfiles:-0}"
  nbytes="$(git_bytes "$range" | tr -d '[:space:]')"; nbytes="${nbytes:-0}"
  if [[ "$MODE" == "review" ]]; then
    ctx="Codex's built-in reviewer fetched the target itself — the wrapper sends no diff text"
  elif [[ "$nfiles" -eq 0 ]]; then
    ctx="the wrapper saw NO change in this range — whatever Codex reviewed, it chose the target itself"
  elif [[ "$nfiles" -le "$INLINE_MAX_FILES" && "$nbytes" -le "$INLINE_MAX_BYTES" ]]; then
    ctx="the diff TEXT was embedded in the prompt (${nfiles} file(s), ${nbytes} bytes)"
  else
    ctx="diff too large to embed (${nfiles} files / ${nbytes} bytes vs the ${INLINE_MAX_FILES}-file, ${INLINE_MAX_BYTES}-byte cap) — Codex got a file list + shortstat and had to read the code itself"
  fi
  printf '\n--- adversarial-review: what this run examined ---\n'
  printf 'reviewer:  %s\n' "$MODE"
  printf 'range:     %s\n' "$range"
  printf 'diff:      %s\n' "${stat:-(none visible to the wrapper — nothing changed, or not a git repo)}"
  printf 'context:   %s\n' "$ctx"
  printf 'run:       attempt %s/%s, %ss, %s lines of Codex output\n' \
    "$attempt" "$MAX_ATTEMPTS" "$secs" "$(printf '%s\n' "$out" | wc -l | tr -d '[:space:]')"
  if [[ -n "$blocked" ]]; then
    printf 'reading:   NOTHING WAS REVIEWED. This block records the target this run was trying to\n'
    printf '           read, not a review of it. Do NOT report this as a clean pass — the lines\n'
    printf '           above are what went unexamined.\n'
  else
    printf 'reading:   a clean verdict says Codex reported nothing over THIS context. Quote these\n'
    printf '           lines with the verdict — they are provenance, not findings.\n'
  fi
}

# Resolve a per-attempt timeout command. Stock macOS ships neither `timeout` nor
# `gtimeout` (those come from GNU coreutils), so fall back to running node
# directly — the timeout is a safety net, not a correctness requirement, and a
# missing one must NOT turn into a phantom exit-127 "review failed".
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT=(timeout "$ATTEMPT_TIMEOUT")
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT=(gtimeout "$ATTEMPT_TIMEOUT")
else
  TIMEOUT=()
fi

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  rc=0
  err=""
  t0="$(date +%s)"
  # Guarded: an unguarded `err="$(mktemp)"` under `set -e` aborts the whole wrapper with
  # mktemp's exit 1 — a code outside this script's documented 0/3/4 contract, which
  # callers then have no rule for. A temp file we can't create is a transient
  # environment problem, so treat it like any other transient: retry, then exit 4.
  if ! err="$(mktemp 2>/dev/null)"; then
    echo "adversarial-review: mktemp failed (attempt $attempt/$MAX_ATTEMPTS) — retrying…" >&2
    if [[ "$attempt" -lt "$MAX_ATTEMPTS" ]]; then sleep 3; fi
    continue
  fi
  out="$(${TIMEOUT[@]+"${TIMEOUT[@]}"} node "$COMPANION" "$MODE" ${ARGS[@]+"${ARGS[@]}"} 2>"$err")" || rc=$?
  errtext="$(cat "$err")"
  rm -f "$err"

  if [[ "$rc" -eq 0 ]]; then
    # A clean verdict requires POSITIVE evidence that a review happened — not merely the
    # absence of known-bad wording. Exit 0 here is the one path a caller banks as "the
    # review ran clean", so it is the one path that must not be reachable by a run that
    # produced nothing. Four gates, all of which must pass:
    if [[ -z "${out//[[:space:]]/}" ]]; then
      # Empty stdout used to pass as clean. It is the plainest possible proof of the
      # opposite: the companion emits a header on every render path, so no output at
      # all means nothing was rendered.
      echo "adversarial-review: Codex exited 0 with EMPTY stdout — no review was produced (attempt $attempt/$MAX_ATTEMPTS)" >&2
    elif ! grep -qE "$REVIEW_RE" <<<"$out"; then
      echo "adversarial-review: Codex exited 0 but stdout carries no '# Codex' review header — this is not a review result (attempt $attempt/$MAX_ATTEMPTS)" >&2
    elif grep -qiE "$BLOCKED_RE" <<<"$out"; then
      : # known blocked / degraded wording on stdout — fall through to the retry below
    elif grep -qiE "$HARD_FAIL_RE" <<<"$errtext"; then
      # stderr is consulted ONLY for hard failures, and only to downgrade to a retry.
      echo "adversarial-review: Codex exited 0 but stderr shows a hard failure — treating as not-run (attempt $attempt/$MAX_ATTEMPTS)" >&2
    else
      printf '%s\n' "$out"
      provenance "$attempt" "$(( $(date +%s) - t0 ))"
      exit 0
    fi
    # rc==0 but no usable review: transient — retry.
  elif [[ "$rc" -eq 124 ]]; then
    # Per-attempt timeout: transient — retry.
    echo "adversarial-review: Codex attempt timed out after ${ATTEMPT_TIMEOUT}s (attempt $attempt/$MAX_ATTEMPTS)" >&2
  elif grep -qiE "$TRANSIENT_RE" <<<"$out"$'\n'"$errtext"; then
    # Transient Codex app-server startup / IPC error — retry like a block/timeout.
    echo "adversarial-review: transient Codex app-server error (rc $rc, attempt $attempt/$MAX_ATTEMPTS) — retrying…" >&2
  else
    # Any other non-zero rc is a PERMANENT failure (bad flag, node missing,
    # companion throws). Surface it immediately — do NOT mislabel as exit 4.
    printf '%s\n' "$out"
    printf '%s\n' "$errtext" >&2
    echo "CODEX-${MODE}: FAILED — Codex companion exited $rc; the wrapper itself failed, this is NOT a review result" >&2
    exit "$rc"
  fi

  if [[ "$attempt" -lt "$MAX_ATTEMPTS" ]]; then
    echo "adversarial-review: Codex run did not inspect the diff (attempt $attempt/$MAX_ATTEMPTS) — retrying…" >&2
    sleep 3
  fi
done

# Exhausted retries: surface what Codex said, then a greppable trailer + exit 4
# so callers can tell "review never ran" apart from real findings (0) and a
# missing plugin (3).
#
# The provenance block goes out on THIS path too. A caller judges "did the review run?" partly by
# whether this block is present, and its absence used to be ambiguous — it meant either "the
# wrapper died before it could report" or "the wrapper ran, tried three times, and could not get
# Codex to read anything". Those deserve the same verdict (not-run) but not the same silence: a
# blocked run should still record WHAT it was trying to review, so the caller can see the target
# was real and the failure was environmental.
printf '%s\n' "$out"
provenance "$MAX_ATTEMPTS" "0" blocked
echo "CODEX-${MODE}: BLOCKED — Codex could not inspect the diff after $MAX_ATTEMPTS attempts (environment/tool error); review did NOT run"
exit 4
