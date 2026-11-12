#!/usr/bin/env bash
# VCV pre-merge policy gate (docs/premerge-gate.md, Issue #22 M4.4).
#
#   scripts/vcv-premerge-gate.sh <trusted-vcv-checkout> <candidate-checkout> <base-commit> [vcv gate options...]
#
# Runs `vcv gate` from a TRUSTED VCV build (checked out at a commit the protected base pins,
# installed with `npm ci --ignore-scripts`) against the CANDIDATE checkout, used only as data:
# nothing from the candidate is installed, imported or executed by this script. Only read-only git
# commands run in the candidate. The tests were run by the host BEFORE this script, in a separate
# job; pass their JUnit report with --junit (and --root, --runner, --invocation): it is captured
# here, in this process. Pass --before with the identity the host read BEFORE the tests ran (in a
# step no candidate code had run in); only then, and only if the candidate still has exactly that
# identity, is the run host-observed.
#
# The host identity is fixed here (VCV_HOST_PRINCIPAL, permission tests:observe), so options on
# the command line cannot change it.
#
# Exit 0: pass or warn. 1: block. 2: usage or setup problem (never a pass).
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <trusted-vcv-checkout> <candidate-checkout> <base-commit> [vcv gate options...]" >&2
  exit 2
fi
trusted=$1 candidate=$2 base=$3
shift 3

if [[ ! $base =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
  echo "vcv-premerge-gate: <base-commit> must be a full commit ID" >&2
  exit 2
fi
cli="$trusted/apps/cli/src/main.ts"
if [[ ! -f $cli || ! -d $trusted/node_modules ]]; then
  echo "vcv-premerge-gate: $trusted is not an installed VCV checkout (run npm ci --ignore-scripts there)" >&2
  exit 2
fi
real() { (cd "$1" && pwd -P); }
case "$(real "$trusted")/" in "$(real "$candidate")"/*)
  echo "vcv-premerge-gate: the trusted VCV checkout is inside the candidate checkout" >&2
  exit 2
esac
if ! git -C "$candidate" cat-file -e "$base^{commit}" 2>/dev/null; then
  echo "vcv-premerge-gate: the candidate checkout does not contain $base; fetch the base first" >&2
  exit 2
fi
for arg in "$@"; do
  case "$arg" in --as|--as=*|--perm|--perm=*|--base|--base=*)
    echo "vcv-premerge-gate: $arg is set by this script" >&2
    exit 2
  esac
done

# Run from the trusted checkout so Node resolves modules there, never in the candidate.
cd "$trusted"
export VCV_HOST_PRINCIPAL="${VCV_GATE_PRINCIPAL:-ci:vcv-premerge-gate}"
export VCV_HOST_PERMISSIONS="tests:observe"
exec node --experimental-strip-types --no-warnings "$cli" gate "$candidate" --base "$base" "$@"
