#!/usr/bin/env bash
# Golden path, step 3 (Issue #17, M3.4): the separate reviewer's decision.
#
#   examples/reference-app/golden-path/review.sh <work-dir> <out-dir> show
#   examples/reference-app/golden-path/review.sh <work-dir> <out-dir> approve <proposalDigest>
#
# `show` prints the read-only preview of the pending change (operations, delta, cross-module
# impact, affected claims, diagnostics, the implementation request) and its digest. A person
# reads it and decides. `approve <digest>` is the reviewer's own invocation: it runs as the
# person, not under an agent identity, with the reviewer's key from <work>/keys and the trust
# list pinned to main's commit ID (what a hosting service supplies as the protected base). It
# approves exactly the content with that digest, then commits the resulting canonical .vcv/
# revision, change record and attestation on the feature branch.
#
# SIMULATION: here the reviewer key is a file on the same machine and the person is whoever runs
# this script. That demonstrates the protocol and its checks, not a production trust boundary;
# the authorization gate is the host's integrity check (docs/approvals.md).
set -euo pipefail
work=$(cd "${1:?usage: review.sh <work-dir> <out-dir> show|approve <digest>}" && pwd)
out=$(cd "${2:?}" && pwd)
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
id=$(cat "$work/change.id")
o="$out/2-review"; mkdir -p "$o"
case "${3:?show|approve}" in
  show)
    vcv proposal preview "$repo" "$id" | scrub | tee "$o/preview-reviewed.txt"
    echo "digest: $(vcv proposal preview "$repo" "$id" --json | json data.proposal.proposalDigest)"
    ;;
  approve)
    digest=${4:?approve needs the proposal digest you reviewed}
    main=$(cat "$work/main.sha")
    {
      echo "\$ vcv review approve <repo> $id --digest $digest --key <keys>/reviewer.pem --trust-ref main --trust-commit $main"
      vcv review approve "$repo" "$id" --digest "$digest" --key "$keys/reviewer.pem" --trust-ref main --trust-commit "$main"
    } 2>&1 | scrub | tee "$o/approve.txt"
    git -C "$repo" add .vcv
    git -C "$repo" commit -q -m "vcv: approve $id (reviewed proposal digest $digest)"
    git -C "$repo" show --stat --format='%H %s' HEAD | scrub > "$o/approval-commit.txt"
    vcv project status "$repo" | scrub > "$o/project-status.txt"
    vcv handoff "$repo" "$id" > "$notes/handoff.json"
    cp "$notes/handoff.json" "$o/handoff.json"
    echo "approved and committed; handoff in $o/handoff.json. Next: implement.sh"
    ;;
esac
