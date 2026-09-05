#!/usr/bin/env bash
# Behaviour tests for the pack's config reader.
#
#   bash lib/tests/config.test.sh
#
# The reader decides what model and effort the pack's most expensive step runs on, and it decides
# it from a file a human hand-edits. Both halves of that fail by returning a confident wrong
# answer: a typo'd key that silently reads as "use the default" is indistinguishable from a
# working config, and a `provider: codex` honoured on a machine with no Codex plugin dispatches an
# agent that dies. So the promise under test is narrow and absolute — every unreadable thing
# resolves to the built-in value AND says so in `notes`, and the script still exits 0.
#
# `--check` is the one mode allowed to fail, because validate.py uses it to refuse a shipped
# defaults file this reader would reject. A defaults file that silently falls through would be a
# green gate over a setting nobody is running.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

READER=lib/read-config.py
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok() {
  if [[ "$2" == "$3" ]]; then
    pass=$((pass + 1)); printf '  ok   %-58s %s\n' "$1" "$2"
  else
    fail=$((fail + 1)); printf '  FAIL %-58s %s, wanted %s\n' "$1" "$2" "$3"
  fi
}
has() {
  if [[ "$2" == *"$3"* ]]; then
    pass=$((pass + 1)); printf '  ok   %-58s names it\n' "$1"
  else
    fail=$((fail + 1)); printf '  FAIL %-58s no note matching %s\n' "$1" "$3"
    printf '       got: %s\n' "$2"
  fi
}
# A HOME with no Codex plugin, so the codex branch is exercised deterministically rather than
# depending on whether the machine running the tests happens to have the plugin installed.
NOCODEX="$TMP/nocodex-home"; mkdir -p "$NOCODEX"
# And one with the companion in place, built at the marketplace path check-prereqs.sh looks at.
HASCODEX="$TMP/hascodex-home"
mkdir -p "$HASCODEX/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts"
: > "$HASCODEX/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs"

# Run the reader with a chosen HOME, pack root and repo root, and pull one field out. The step is
# optional and defaults to `implement`, which most of the cases below are written against.
read_cfg() {  # <home> <pack> <repo> <jq-ish key> [step]
  HOME="$1" python3 - "$2" "$3" "$4" "${5:-implement}" <<'PY'
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("rc", "lib/read-config.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
out = m.resolve(sys.argv[4], repo=sys.argv[2], pack=sys.argv[1])
v = out[sys.argv[3]]
print(json.dumps(v) if isinstance(v, list) else v)
PY
}
mkcfg() { mkdir -p "$(dirname "$1")"; cat > "$1"; }

# The bare-scalar mode shell callers use — cmux-fanout.sh resolves its cap through it, and a JSON
# document would need a parser the script cannot assume is installed.
field() {  # <home> <pack> <repo> <step> <field>
  HOME="$1" python3 "$READER" --pack "$2" --repo "$3" --step "$4" --field "$5" 2>/dev/null
}
field_err() { HOME="$1" python3 "$READER" --pack "$2" --repo "$3" --step "$4" --field "$5" 2>&1 >/dev/null; }

# --- no files at all --------------------------------------------------------
EMPTY="$TMP/empty"; mkdir -p "$EMPTY"
ok "no config anywhere: provider"   "$(read_cfg "$NOCODEX" "$EMPTY" "$EMPTY" provider)" claude
ok "no config anywhere: model"      "$(read_cfg "$NOCODEX" "$EMPTY" "$EMPTY" model)"    opus
ok "no config anywhere: effort"     "$(read_cfg "$NOCODEX" "$EMPTY" "$EMPTY" effort)"   medium
ok "no config anywhere: no sources" "$(read_cfg "$NOCODEX" "$EMPTY" "$EMPTY" sources)"  '[]'
has "the absent config is named" "$(read_cfg "$NOCODEX" "$EMPTY" "$EMPTY" notes)" "no .config file found"

# --- the pack default alone -------------------------------------------------
PACK="$TMP/pack"
mkcfg "$PACK/.config/defaults.yaml" <<'YAML'
steps:
  implement:
    provider: claude
    model: sonnet
    effort: high
YAML
ok "pack default is read: model"   "$(read_cfg "$NOCODEX" "$PACK" "$EMPTY" model)"  sonnet
ok "pack default is read: effort"  "$(read_cfg "$NOCODEX" "$PACK" "$EMPTY" effort)" high
ok "pack default leaves no notes"  "$(read_cfg "$NOCODEX" "$PACK" "$EMPTY" notes)"  '[]'

# --- a project file overriding ONE key --------------------------------------
# The point of key-by-key layering: naming `effort` must not reset the model to the built-in.
REPO="$TMP/repo"
mkcfg "$REPO/.config/skill-pack.yaml" <<'YAML'
steps:
  implement:
    effort: xhigh
YAML
ok "project overrides the key it names"     "$(read_cfg "$NOCODEX" "$PACK" "$REPO" effort)" xhigh
ok "project inherits the keys it omits"     "$(read_cfg "$NOCODEX" "$PACK" "$REPO" model)"  sonnet
ok "both files are reported as sources"     "$(read_cfg "$NOCODEX" "$PACK" "$REPO" sources | tr -cd , | wc -c | tr -d ' ')" 1

# --- a value outside its enum -----------------------------------------------
BADENUM="$TMP/badenum"
mkcfg "$BADENUM/.config/skill-pack.yaml" <<'YAML'
steps:
  implement:
    effort: ultra
YAML
ok  "a bad effort falls back"  "$(read_cfg "$NOCODEX" "$PACK" "$BADENUM" effort)" medium
has "and the key is named"     "$(read_cfg "$NOCODEX" "$PACK" "$BADENUM" notes)" "steps.implement.effort"
has "and the bad value quoted" "$(read_cfg "$NOCODEX" "$PACK" "$BADENUM" notes)" "'ultra'"

BADPROV="$TMP/badprov"
mkcfg "$BADPROV/.config/skill-pack.yaml" <<'YAML'
steps:
  implement:
    provider: codx
YAML
ok  "a bad provider falls back" "$(read_cfg "$NOCODEX" "$PACK" "$BADPROV" provider)" claude
has "and names the provider"    "$(read_cfg "$NOCODEX" "$PACK" "$BADPROV" notes)" "steps.implement.provider"

# --- an unknown key ---------------------------------------------------------
# Named, never fatal: this is the typo that would otherwise read as a working config.
UNKNOWN="$TMP/unknown"
mkcfg "$UNKNOWN/.config/skill-pack.yaml" <<'YAML'
steps:
  implement:
    efort: high
    provider: claude
YAML
ok  "an unknown key does not break the file" "$(read_cfg "$NOCODEX" "$PACK" "$UNKNOWN" provider)" claude
has "an unknown key is named"                "$(read_cfg "$NOCODEX" "$PACK" "$UNKNOWN" notes)" "efort"
UNKSTEP="$TMP/unkstep"
mkcfg "$UNKSTEP/.config/skill-pack.yaml" <<'YAML'
tsteps:
  implement:
    effort: high
YAML
ok  "an unknown top-level key is ignored" "$(read_cfg "$NOCODEX" "$PACK" "$UNKSTEP" effort)" high
has "and named"                           "$(read_cfg "$NOCODEX" "$PACK" "$UNKSTEP" notes)" "tsteps"

# --- a malformed document ---------------------------------------------------
BROKEN="$TMP/broken"
mkcfg "$BROKEN/.config/skill-pack.yaml" <<'YAML'
steps:
  implement:
    - effort high
YAML
ok  "a malformed file falls back rather than throwing" "$(read_cfg "$NOCODEX" "$PACK" "$BROKEN" effort)" high
has "and the bad line is named"                        "$(read_cfg "$NOCODEX" "$PACK" "$BROKEN" notes)" "is not a"

# --- comments and quotes ----------------------------------------------------
QUOTED="$TMP/quoted"
mkcfg "$QUOTED/.config/skill-pack.yaml" <<'YAML'
# a leading comment
steps:
  implement:
    model: "haiku"      # trailing comment
    provider: 'claude'
YAML
ok "quoted values are unquoted"      "$(read_cfg "$NOCODEX" "$PACK" "$QUOTED" model)"    haiku
ok "trailing comments are stripped"  "$(read_cfg "$NOCODEX" "$PACK" "$QUOTED" provider)" claude
ok "comments produce no notes"       "$(read_cfg "$NOCODEX" "$PACK" "$QUOTED" notes)"    '[]'

# --- provider: codex, both ways ---------------------------------------------
CODEX="$TMP/codex"
mkcfg "$CODEX/.config/skill-pack.yaml" <<'YAML'
steps:
  implement:
    provider: codex
    model: gpt5.6-sol
    effort: low
YAML
ok "codex present: provider honoured"       "$(read_cfg "$HASCODEX" "$PACK" "$CODEX" provider)" codex
ok "codex present: model passes through"    "$(read_cfg "$HASCODEX" "$PACK" "$CODEX" model)"    gpt5.6-sol
ok "codex present: effort honoured"         "$(read_cfg "$HASCODEX" "$PACK" "$CODEX" effort)"   low
ok "codex present: nothing to report"       "$(read_cfg "$HASCODEX" "$PACK" "$CODEX" notes)"    '[]'
# The whole row moves together — a codex model name means nothing to a Claude subagent, and
# carrying `low` across would re-tier the Claude path by accident.
ok "codex absent: provider falls back"      "$(read_cfg "$NOCODEX" "$PACK" "$CODEX" provider)" claude
ok "codex absent: model falls back too"     "$(read_cfg "$NOCODEX" "$PACK" "$CODEX" model)"    opus
ok "codex absent: effort falls back too"    "$(read_cfg "$NOCODEX" "$PACK" "$CODEX" effort)"   medium
has "codex absent: the fallback is named"   "$(read_cfg "$NOCODEX" "$PACK" "$CODEX" notes)" "Codex plugin is not installed"
has "codex absent: install line is given"   "$(read_cfg "$NOCODEX" "$PACK" "$CODEX" notes)" "plugin install codex@openai-codex"
# The cache path check-prereqs.sh falls back to counts as installed too.
CACHED="$TMP/cached-home"
mkdir -p "$CACHED/.claude/plugins/cache/openai-codex/codex/0.146.0/scripts"
: > "$CACHED/.claude/plugins/cache/openai-codex/codex/0.146.0/scripts/codex-companion.mjs"
ok "the version-cache path counts as installed" "$(read_cfg "$CACHED" "$PACK" "$CODEX" provider)" codex

# --- the wrapper is tuned apart from the writer ------------------------------
# Under `provider: codex` two agents run: Codex writes the code, and a Claude subagent drives the
# CLI and collects a run past the ~600s cap. They are separate settings because they fail
# differently — a cheap writer writes worse code, a cheap wrapper halts the run over work Codex
# actually finished.
ok "the wrapper has its own default model"  "$(field "$HASCODEX" "$PACK" "$CODEX" implement wrapperModel)"  haiku
ok "and its own default effort"             "$(field "$HASCODEX" "$PACK" "$CODEX" implement wrapperEffort)" medium
WRAP="$TMP/wrap"
mkcfg "$WRAP/.config/skill-pack.yaml" <<'YAML'
steps:
  implement:
    provider: codex
    model: gpt5.6-sol
    effort: low
    wrapperModel: opus
    wrapperEffort: high
YAML
# `opus`, deliberately NOT the built-in `haiku`: a fixture that repeats the default cannot tell a
# key that was read apart from one that was ignored.
ok "the wrapper model is configurable"      "$(field "$HASCODEX" "$PACK" "$WRAP" implement wrapperModel)"  opus
ok "the wrapper effort is configurable"     "$(field "$HASCODEX" "$PACK" "$WRAP" implement wrapperEffort)" high
ok "and tuning it leaves the writer alone"  "$(field "$HASCODEX" "$PACK" "$WRAP" implement model)"         gpt5.6-sol
ok "and leaves the writer's effort alone"   "$(field "$HASCODEX" "$PACK" "$WRAP" implement effort)"        low
# It is ALWAYS a Claude subagent, whatever the writer is — so a codex model name is wrong here even
# under provider: codex, unlike `model`.
BADWRAP="$TMP/badwrap"
mkcfg "$BADWRAP/.config/skill-pack.yaml" <<'YAML'
steps:
  implement:
    provider: codex
    wrapperModel: gpt5.6-sol
YAML
ok  "a codex model is refused for the wrapper" "$(field "$HASCODEX" "$PACK" "$BADWRAP" implement wrapperModel)" haiku
has "and named"                                "$(field_err "$HASCODEX" "$PACK" "$BADWRAP" implement wrapperModel)" "steps.implement.wrapperModel"
# The codex-absent fallback moves the WRITER's three fields; the wrapper describes an agent that is
# not dispatched at all on claude, so resetting it would discard a setting for no reason and make
# the reported row disagree with the file the user is reading.
ok "codex absent: the wrapper setting survives" "$(field "$NOCODEX" "$PACK" "$WRAP" implement wrapperModel)" opus
ok "codex absent: the writer still falls back"  "$(field "$NOCODEX" "$PACK" "$WRAP" implement model)"        opus

# --- model validation is provider-dependent ---------------------------------
# Under claude the model must be one the dispatcher accepts; under codex the CLI validates it and
# a list pinned here would go stale the week it changes.
BADMODEL="$TMP/badmodel"
mkcfg "$BADMODEL/.config/skill-pack.yaml" <<'YAML'
steps:
  implement:
    provider: claude
    model: gpt5.6-sol
YAML
ok  "a codex model under claude falls back" "$(read_cfg "$NOCODEX" "$PACK" "$BADMODEL" model)" opus
has "and is named"                          "$(read_cfg "$NOCODEX" "$PACK" "$BADMODEL" notes)" "steps.implement.model"

# --- the fan-out cap --------------------------------------------------------
# Shared by /r:plan-run and /r:issues-fix through one script, which reads it with --field because
# it is bash and cannot assume a JSON parser. An empty or non-numeric cap is the dangerous shape:
# the script compares with `-ge`, so a blank would let every spawn through and cap nothing.
FANOUT="$TMP/fanout"
mkcfg "$FANOUT/.config/skill-pack.yaml" <<'YAML'
steps:
  fanout:
    maxUnits: 5
YAML
ok "the fan-out cap is read"        "$(field "$NOCODEX" "$PACK" "$FANOUT" fanout maxUnits)" 5
ok "and defaults without a file"    "$(field "$NOCODEX" "$EMPTY" "$EMPTY" fanout maxUnits)" 3
BADUNITS="$TMP/badunits"
mkcfg "$BADUNITS/.config/skill-pack.yaml" <<'YAML'
steps:
  fanout:
    maxUnits: many
YAML
ok  "a non-numeric cap falls back"  "$(field "$NOCODEX" "$PACK" "$BADUNITS" fanout maxUnits)" 3
has "and is named on stderr"        "$(field_err "$NOCODEX" "$PACK" "$BADUNITS" fanout maxUnits)" "steps.fanout.maxUnits"
for bad in 0 -1 17; do
  mkcfg "$BADUNITS/.config/skill-pack.yaml" <<YAML
steps:
  fanout:
    maxUnits: $bad
YAML
  ok "a cap of $bad is out of range"  "$(field "$NOCODEX" "$PACK" "$BADUNITS" fanout maxUnits)" 3
done
mkcfg "$BADUNITS/.config/skill-pack.yaml" <<'YAML'
steps:
  fanout:
    maxUnits: 1
YAML
ok "a cap of 1 is legal — serial by config" "$(field "$NOCODEX" "$PACK" "$BADUNITS" fanout maxUnits)" 1
# The steps are independent: naming one must not disturb the other.
ok "naming fanout leaves implement alone"   "$(read_cfg "$NOCODEX" "$PACK" "$FANOUT" model)" sonnet
ok "an unknown step is named, not guessed"  "$(field "$NOCODEX" "$PACK" "$FANOUT" nosuchstep maxUnits)" ""
has "and says which steps exist"            "$(field_err "$NOCODEX" "$PACK" "$FANOUT" nosuchstep maxUnits)" "known steps are"
has "an unknown field is named"             "$(field_err "$NOCODEX" "$PACK" "$FANOUT" fanout nosuchfield)" "no such setting"

# --- steps.fix, the /r:task-review fixers -----------------------------------
# Same five keys and the same machinery as implement, so what is worth testing is that the row is
# actually WIRED — a step present in SPEC but absent from a caller's read resolves to the built-in
# values and looks, from the outside, exactly like a setting that works.
FIXPACK="$TMP/fixpack"
mkcfg "$FIXPACK/.config/defaults.yaml" <<'YAML'
steps:
  implement:
    provider: claude
    model: opus
    effort: medium
  fix:
    provider: codex
    model: gpt5.6-sol
    effort: low
    wrapperModel: sonnet
    wrapperEffort: medium
YAML
ok "fix: the shipped row is read"        "$(read_cfg "$HASCODEX" "$FIXPACK" "$EMPTY" model fix)"    gpt5.6-sol
ok "fix: and its effort"                 "$(read_cfg "$HASCODEX" "$FIXPACK" "$EMPTY" effort fix)"   low
ok "fix: and its wrapper"                "$(read_cfg "$HASCODEX" "$FIXPACK" "$EMPTY" wrapperModel fix)" sonnet
ok "fix: no notes on a clean read"       "$(read_cfg "$HASCODEX" "$FIXPACK" "$EMPTY" notes fix)"    '[]'
# The two steps are independent rows, and the shipped file deliberately puts them on different
# providers. Reading one must never pick up the other's values.
ok "fix and implement do not bleed"      "$(read_cfg "$HASCODEX" "$FIXPACK" "$EMPTY" provider implement)" claude
ok "and the implement model stays put"   "$(read_cfg "$HASCODEX" "$FIXPACK" "$EMPTY" model implement)"    opus

FIXREPO="$TMP/fixrepo"
mkcfg "$FIXREPO/.config/skill-pack.yaml" <<'YAML'
steps:
  fix:
    effort: high
YAML
ok "fix: a project overrides one key"    "$(read_cfg "$HASCODEX" "$FIXPACK" "$FIXREPO" effort fix)"   high
ok "fix: and inherits the rest"          "$(read_cfg "$HASCODEX" "$FIXPACK" "$FIXREPO" model fix)"    gpt5.6-sol
ok "fix: including the provider"         "$(read_cfg "$HASCODEX" "$FIXPACK" "$FIXREPO" provider fix)" codex

# codex asked for on a machine with no plugin: the WHOLE writer row moves, because a codex model
# name means nothing to a Claude subagent and carrying `low` across would re-tier it by accident.
ok "fix: no plugin, provider falls back" "$(read_cfg "$NOCODEX" "$FIXPACK" "$EMPTY" provider fix)" claude
ok "fix: and the model with it"          "$(read_cfg "$NOCODEX" "$FIXPACK" "$EMPTY" model fix)"    opus
ok "fix: and the effort with it"         "$(read_cfg "$NOCODEX" "$FIXPACK" "$EMPTY" effort fix)"   medium
has "fix: the substitution is named"     "$(read_cfg "$NOCODEX" "$FIXPACK" "$EMPTY" notes fix)"    "steps.fix.provider"

FIXTYPO="$TMP/fixtypo"
mkcfg "$FIXTYPO/.config/skill-pack.yaml" <<'YAML'
steps:
  fix:
    modell: haiku
    effort: ultra
YAML
ok  "fix: a typo'd key is ignored"       "$(read_cfg "$HASCODEX" "$FIXPACK" "$FIXTYPO" model fix)"  gpt5.6-sol
has "fix: and named"                     "$(read_cfg "$HASCODEX" "$FIXPACK" "$FIXTYPO" notes fix)"  "steps.fix.modell"
ok  "fix: a bad effort falls back"       "$(read_cfg "$HASCODEX" "$FIXPACK" "$FIXTYPO" effort fix)" medium
has "fix: and the key is named"          "$(read_cfg "$HASCODEX" "$FIXPACK" "$FIXTYPO" notes fix)"  "steps.fix.effort"

# --- steps.plan, the /r:task-run planning half -------------------------------
# Three tiers under one row — the planner, its explorers, and the judges that triage the plan
# review — so the case that matters is that they stay INDEPENDENT: a project raising the planner
# must not drag the judges up with it, which is the one thing the row's standing rule forbids.
PLANPACK="$TMP/planpack"
mkcfg "$PLANPACK/.config/defaults.yaml" <<'YAML'
steps:
  plan:
    model: opus
    effort: high
    exploreModel: sonnet
    exploreEffort: medium
    judgeModel: sonnet
    judgeEffort: high
  implement:
    provider: claude
    model: opus
    effort: medium
YAML
ok "plan: the planner row is read"       "$(read_cfg "$NOCODEX" "$PLANPACK" "$EMPTY" model plan)"         opus
ok "plan: and its effort"                "$(read_cfg "$NOCODEX" "$PLANPACK" "$EMPTY" effort plan)"        high
ok "plan: the explorers are their own"   "$(read_cfg "$NOCODEX" "$PLANPACK" "$EMPTY" exploreModel plan)"  sonnet
ok "plan: the judges are their own"      "$(read_cfg "$NOCODEX" "$PLANPACK" "$EMPTY" judgeEffort plan)"   high
ok "plan: no notes on a clean read"      "$(read_cfg "$NOCODEX" "$PLANPACK" "$EMPTY" notes plan)"         '[]'
ok "plan and implement do not bleed"     "$(read_cfg "$NOCODEX" "$PLANPACK" "$EMPTY" effort implement)"   medium

PLANREPO="$TMP/planrepo"
mkcfg "$PLANREPO/.config/skill-pack.yaml" <<'YAML'
steps:
  plan:
    effort: xhigh
YAML
ok "plan: a project deepens the planner" "$(read_cfg "$NOCODEX" "$PLANPACK" "$PLANREPO" effort plan)"      xhigh
ok "and the judges stay where they were" "$(read_cfg "$NOCODEX" "$PLANPACK" "$PLANREPO" judgeEffort plan)" high
ok "and the explorers too"               "$(read_cfg "$NOCODEX" "$PLANPACK" "$PLANREPO" exploreEffort plan)" medium

# The row carries no `provider`, so the codex branch must not fire on it — and the model is still
# enum-checked, by the rule's own enum rather than by the provider-gated path the other rows use.
# A codex model name reaching a planner would break the dispatch outright.
PLANBAD="$TMP/planbad"
mkcfg "$PLANBAD/.config/skill-pack.yaml" <<'YAML'
steps:
  plan:
    model: gpt5.6-sol
    judgeModel: haiku
    judgeEffort: turbo
    provider: codex
YAML
ok  "plan: a codex model falls back"     "$(read_cfg "$NOCODEX" "$PLANPACK" "$PLANBAD" model plan)"       fable
has "plan: and the substitution is named" "$(read_cfg "$NOCODEX" "$PLANPACK" "$PLANBAD" notes plan)"      "steps.plan.model"
ok  "plan: a bad judge effort falls back" "$(read_cfg "$NOCODEX" "$PLANPACK" "$PLANBAD" judgeEffort plan)" high
ok  "plan: a good judge model is kept"   "$(read_cfg "$NOCODEX" "$PLANPACK" "$PLANBAD" judgeModel plan)"  haiku
has "plan: a provider key is not read here" "$(read_cfg "$NOCODEX" "$PLANPACK" "$PLANBAD" notes plan)"   "steps.plan.provider"
# Having the plugin present must change nothing, since there is no provider to honour.
ok  "plan: the codex plugin changes nothing" "$(read_cfg "$HASCODEX" "$PLANPACK" "$PLANBAD" model plan)"  fable

# --- the exit-0 promise -----------------------------------------------------
for dir in "$EMPTY" "$BROKEN" "$BADENUM" "$UNKNOWN" "$CODEX"; do
  HOME="$NOCODEX" python3 "$READER" --pack "$PACK" --repo "$dir" >/dev/null 2>&1
  ok "exit 0 on $(basename "$dir")" "$?" 0
done
out=$(HOME="$NOCODEX" python3 "$READER" --pack "$PACK" --repo "$BROKEN" 2>/dev/null)
ok "stdout is one line of JSON" "$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["provider"])')" claude

# --- --check, the one mode allowed to fail ----------------------------------
python3 "$READER" --check "$PACK/.config/defaults.yaml" >/dev/null 2>&1
ok "--check accepts a valid file" "$?" 0
python3 "$READER" --check "$BROKEN/.config/skill-pack.yaml" >/dev/null 2>&1
ok "--check rejects a malformed file" "$?" 1
python3 "$READER" --check "$BADENUM/.config/skill-pack.yaml" >/dev/null 2>&1
ok "--check rejects a bad enum" "$?" 1
# --check walks EVERY step, not just implement: a defaults file whose unchecked half the reader
# would reject falls through to the built-in row on every run, and from the outside that reads
# exactly like a setting that works.
mkcfg "$TMP/badfanout/.config/defaults.yaml" <<'YAML'
steps:
  implement:
    provider: claude
  fanout:
    maxUnits: 40
YAML
python3 "$READER" --check "$TMP/badfanout/.config/defaults.yaml" >/dev/null 2>&1
ok "--check rejects a bad cap in a step it is not asked about" "$?" 1
mkcfg "$TMP/badfix/.config/defaults.yaml" <<'YAML'
steps:
  implement:
    provider: claude
  fix:
    provider: claude
    model: gpt5.6-sol
YAML
python3 "$READER" --check "$TMP/badfix/.config/defaults.yaml" >/dev/null 2>&1
ok "--check rejects a codex model under a claude fix row" "$?" 1
mkcfg "$TMP/badplan/.config/defaults.yaml" <<'YAML'
steps:
  implement:
    provider: claude
  plan:
    model: gpt5.6-sol
YAML
python3 "$READER" --check "$TMP/badplan/.config/defaults.yaml" >/dev/null 2>&1
ok "--check rejects a codex model on the plan row" "$?" 1
# The plan row has no `provider`, so the provider-gated model check cannot run for it — reaching
# that branch at all would be a KeyError, which --check would report as a pass by crashing.
mkcfg "$TMP/okplan/.config/defaults.yaml" <<'YAML'
steps:
  plan:
    model: sonnet
    judgeEffort: low
YAML
python3 "$READER" --check "$TMP/okplan/.config/defaults.yaml" >/dev/null 2>&1
ok "--check accepts a valid provider-less plan row" "$?" 0
python3 "$READER" --check "$TMP/no-such-file.yaml" >/dev/null 2>&1
ok "--check rejects a missing file" "$?" 1
# The gate that matters: the file this pack actually ships.
python3 "$READER" --check .config/defaults.yaml >/dev/null 2>&1
ok "--check accepts the SHIPPED defaults" "$?" 0

printf '\n  %d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
