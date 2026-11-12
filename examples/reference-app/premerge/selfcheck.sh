#!/usr/bin/env bash
# Regressions for the scenario harness itself (Issue #22, M4.5 review): a failed required operation
# must stop scenarios.sh with exit 3, never end in "scenarios: 0 unexpected result(s)".
#
#   examples/reference-app/premerge/selfcheck.sh <work-dir> <out-dir>
#
# Run it after scenarios.sh on the same <work-dir> (it needs the branches that run created). It
# rewrites model-first/quiet-rejections, so keep the evidence of the real run elsewhere.
set -uo pipefail
work=$(cd "${1:?usage: selfcheck.sh <work-dir> <out-dir>}" && pwd)
mkdir -p "${2:?}"
out=$(cd "$2" && pwd)
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
failures=0
# must_fail <name> <env...> -- <steps...>: scenarios.sh must exit 3 and print no success summary.
must_fail() {
  local name=$1; shift
  local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  local code=0
  env "${envs[@]}" bash "$here/scenarios.sh" "$work" "$out/$name" "$@" > "$out/$name.log" 2>&1 || code=$?
  if [ "$code" = 3 ] && ! grep -q "scenarios: 0 unexpected" "$out/$name.log" && grep -q "scenarios: FAILED" "$out/$name.log"; then
    echo "selfcheck $name: stopped with exit 3: ok ($(grep -m1 'scenarios: FAILED' "$out/$name.log"))"
  else
    echo "selfcheck $name: UNEXPECTED exit $code"; tail -5 "$out/$name.log"; failures=$((failures + 1))
  fi
}

# 1. The merge itself fails: a git that refuses `merge` (exit 42), everything else is real git.
mkdir -p "$out/bin"
real_git=$(command -v git)
printf '#!/bin/sh\nfor a in "$@"; do [ "$a" = merge ] && { echo "git: merge refused (selfcheck)" >&2; exit 42; }; done\nexec "%s" "$@"\n' "$real_git" > "$out/bin/git"
chmod +x "$out/bin/git"
must_fail failed-merge "PATH=$out/bin:$PATH" -- merge

# 2. The approval fails: APPROVE_CMD exits nonzero.
must_fail failed-approval "APPROVE_CMD=false" -- intent approved

[ "$failures" = 0 ] && echo "selfcheck: ok" || { echo "selfcheck: $failures unexpected"; exit 1; }
