#!/usr/bin/env bash
# Regressions for the scenario harness itself (Issue #22, M4.5 review): a failed required operation
# must stop scenarios.sh with exit 3, never end in "scenarios: 0 unexpected result(s)".
#
#   examples/reference-app/premerge/selfcheck.sh <work-dir> <out-dir>
#
# Run it after scenarios.sh on the same <work-dir> (it needs the branches that run created). It
# rewrites model-first/quiet-rejections, so keep the evidence of the real run elsewhere.
#
# Each injected failure prints a unique marker. A case passes only if scenarios.sh stopped with
# exit 3 at the injected step and the marker shows the injection was actually reached; any other
# failure (a setup or prerequisite error) fails the selfcheck instead of satisfying it.
set -uo pipefail
work=$(cd "${1:?usage: selfcheck.sh <work-dir> <out-dir>}" && pwd)
mkdir -p "${2:?}"
out=$(cd "$2" && pwd)
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
failures=0
bad() { echo "selfcheck $1: UNEXPECTED: $2"; tail -8 "$out/$1.log" | sed 's/^/    /'; failures=$((failures + 1)); }
# run <name> <env...> -- <steps...>: run scenarios.sh, leaving its exit code in $code.
run() {
  local name=$1; shift
  local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  rm -rf "${out:?}/$name"; code=0
  env "${envs[@]}" bash "$here/scenarios.sh" "$work" "$out/$name" "$@" > "$out/$name.log" 2>&1 || code=$?
}
# stopped <name>: exit 3, a FAILED line, no success summary.
stopped() {
  [ "$code" = 3 ] || { bad "$1" "exit $code, expected 3"; return 1; }
  grep -q "scenarios: 0 unexpected" "$out/$1.log" && { bad "$1" "printed a success summary"; return 1; }
  grep -q "scenarios: FAILED" "$out/$1.log" || { bad "$1" "no FAILED line"; return 1; }
}

# 1. The merge itself fails: a git that refuses `merge` (exit 42), everything else is real git.
mkdir -p "$out/bin"
real_git=$(command -v git)
printf '#!/bin/sh\nfor a in "$@"; do [ "$a" = merge ] && { echo "SELFCHECK-MERGE-REFUSED" >&2; exit 42; }; done\nexec "%s" "$@"\n' "$real_git" > "$out/bin/git"
chmod +x "$out/bin/git"
run failed-merge "PATH=$out/bin:$PATH" -- merge
if stopped failed-merge; then
  if ! grep -q "SELFCHECK-MERGE-REFUSED" "$out/failed-merge.log"; then bad failed-merge "the refusing git was never asked to merge"
  elif ! grep -q "scenarios: FAILED at line [0-9]*: git -C \"\$repo\" merge" "$out/failed-merge.log"; then bad failed-merge "stopped somewhere other than the merge"
  else echo "selfcheck failed-merge: stopped at the refused merge with exit 3: ok"; fi
fi

# 2. The approval fails: an approval command that prints a marker and refuses.
printf '#!/bin/sh\necho "SELFCHECK-APPROVAL-REFUSED for $2 ($3)"\nexit 1\n' > "$out/bin/refuse-approval"
chmod +x "$out/bin/refuse-approval"
run failed-approval "APPROVE_CMD=$out/bin/refuse-approval" -- intent approved
if stopped failed-approval; then
  if ! grep -q "== intent" "$out/failed-approval.log" || ! grep -q "expected exit 1: ok" "$out/failed-approval.log"; then bad failed-approval "the intent step (the prerequisite) did not complete"
  elif ! grep -q "^SELFCHECK-APPROVAL-REFUSED for chg-quiet-rejections ([0-9a-f]\{64\})" "$out/failed-approval/approved/approval.txt" 2>/dev/null; then bad failed-approval "the refusing approval command was never run"
  elif grep -q "expected exit 0: ok" "$out/failed-approval.log"; then bad failed-approval "the approved step went on to a gate run"
  else echo "selfcheck failed-approval: stopped at the refused approval with exit 3: ok"; fi
fi

if [ "$failures" = 0 ]; then echo "selfcheck: ok"; else echo "selfcheck: $failures unexpected"; exit 1; fi
