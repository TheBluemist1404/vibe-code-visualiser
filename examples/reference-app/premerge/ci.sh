#!/usr/bin/env bash
# The pre-merge check for one candidate, run locally the way the three CI jobs run it
# (docs/ci/vcv-premerge.example.yml, Issue #22 M4.5).
#
#   examples/reference-app/premerge/ci.sh <work-dir> <out-dir> [--observations <file>] [--no-tests]
#
# 1. identity:        the trusted VCV reads the candidate's identity before any of its code runs;
# 2. candidate-tests: the candidate's own Vitest run, with the ordinary console summary and the
#                     per-case JUnit report (written to <out-dir>, outside the checkout);
# 3. vcv-gate:        scripts/vcv-premerge-gate.sh (trusted VCV, candidate as data) with the report,
#                     the pre-run identity, the policy read from the base commit and, if given, the
#                     agent's observations.
# The base is <work>/main.sha. Writes identity.json, tests.txt, junit.xml, gate.txt, gate.json and
# exit-code (the gate's) to <out-dir>. Exits with the gate's code.
set -uo pipefail
work=$(cd "${1:?usage: ci.sh <work-dir> <out-dir> [--observations <file>] [--no-tests]}" && pwd)
mkdir -p "${2:?}"
out=$(cd "$2" && pwd)
shift 2
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
obs=() tests=1
while [ $# -gt 0 ]; do
  case "$1" in
    --observations) obs=(--observations "$2"); cp "$2" "$out/observations.json"; shift 2 ;;
    --no-tests) tests=0; shift ;;
    *) echo "ci.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
base=$(cat "$work/main.sha")

# 1. identity (no candidate code has run)
vcv tests identity "$repo" --json > "$out/identity.json"
before=$(json identityDigest < "$out/identity.json")
[[ $before =~ ^[0-9a-f]{64}$ ]] || { echo "ci.sh: no identity" >&2; exit 2; }

# 2. candidate-tests (the candidate's own runner; its exit code is not the decision)
# Only a report written by this invocation is evidence. A report left in <out-dir> by an earlier run
# is removed first, and the runner writes to a name that did not exist before it started; if it
# writes nothing (it could not start, or crashed), there is no run and required criteria stay
# unverified.
junit=()
rm -f "$out/junit.xml"
[ ! -e "$out/junit.xml" ] || { echo "ci.sh: cannot clear $out/junit.xml" >&2; exit 2; }
if [ "$tests" = 1 ]; then
  report="$out/junit.$$.$RANDOM.xml"
  [ ! -e "$report" ] || { echo "ci.sh: $report already exists" >&2; exit 2; }
  (cd "$repo/server" && npx vitest run --reporter=default --reporter=junit --outputFile.junit="$report") > "$out/tests.raw" 2>&1
  echo "npx vitest run exited $?" >> "$out/tests.raw"
  if [ -s "$report" ]; then
    mv "$report" "$out/junit.xml"
    junit=(--junit "$out/junit.xml" --root server --runner vitest --invocation "npx vitest run --reporter=junit (job candidate-tests)" --before "$before")
  else
    rm -f "$report"
    echo "ci.sh: the runner wrote no JUnit report; this run is no test evidence" >> "$out/tests.raw"
  fi
  # The console summary as a developer sees it, without colour codes or timings.
  sed -E 's/\x1b\[[0-9;]*m//g; s/ [0-9]+ms//g; s/\([0-9.]+m?s\)//g; /Start at|Duration/d; s|'"$out"'|<out>|g; s|<out>/junit\.[0-9]+\.[0-9]+\.xml|<out>/junit.xml|g' "$out/tests.raw" | scrub > "$out/tests.txt"
  rm "$out/tests.raw"
fi

# 3. vcv-gate (trusted VCV; the candidate is data)
gate() { "$vcv_home/scripts/vcv-premerge-gate.sh" "$vcv_home" "$repo" "$base" "${junit[@]}" "${obs[@]}" --policy-at-base .github/vcv-policy.json "$@"; }
gate --json > "$out/gate.json" 2> "$out/gate.stderr"
code=$?
gate 2>&1 | scrub > "$out/gate.txt"
[ -s "$out/gate.stderr" ] || rm "$out/gate.stderr"
echo "$code" > "$out/exit-code"
echo "gate exit $code: $(head -1 "$out/gate.txt")"
exit "$code"
