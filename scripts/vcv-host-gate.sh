#!/usr/bin/env bash
# VCV host authorization gate (docs/approvals.md, "In CI: the authorization gate").
#
#   scripts/vcv-host-gate.sh <trusted-vcv-checkout> <candidate-checkout> <base-commit>
#
# Runs the integrity check of a TRUSTED VCV build (a checkout of the protected base, installed
# with `npm ci --ignore-scripts`) against the CANDIDATE checkout, which is used only as data:
# nothing from the candidate is installed, imported or executed (no package.json scripts, no
# modules, no verifier). Only read-only git commands run inside the candidate. The base and the
# trust list both come from <base-commit>, a full commit ID the host supplies (for GitHub:
# github.event.pull_request.base.sha), which must already be present in the candidate's
# object store (fetch it first). Exit 0 only for a consistent, attested history under the
# base's trust list; 1 on any integrity error; 2 on a usage or setup problem.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <trusted-vcv-checkout> <candidate-checkout> <base-commit>" >&2
  exit 2
fi
trusted=$1 candidate=$2 base=$3

if [[ ! $base =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
  echo "vcv-host-gate: <base-commit> must be a full commit ID" >&2
  exit 2
fi
cli="$trusted/apps/cli/src/main.ts"
if [[ ! -f $cli || ! -d $trusted/node_modules ]]; then
  echo "vcv-host-gate: $trusted is not an installed VCV checkout (run npm ci --ignore-scripts there)" >&2
  exit 2
fi
# The trusted build must not live inside the candidate, or the candidate could supply it.
real() { (cd "$1" && pwd -P); }
case "$(real "$trusted")/" in "$(real "$candidate")"/*)
  echo "vcv-host-gate: the trusted VCV checkout is inside the candidate checkout" >&2
  exit 2
esac
if ! git -C "$candidate" cat-file -e "$base^{commit}" 2>/dev/null; then
  echo "vcv-host-gate: the candidate checkout does not contain $base; fetch the base first" >&2
  exit 2
fi

# Run from the trusted checkout so Node resolves modules there, never in the candidate.
cd "$trusted"
exec node --experimental-strip-types --no-warnings "$cli" integrity "$candidate" \
  --base "$base" --trust-ref "$base" --trust-commit "$base" --require-attestation
