#!/usr/bin/env bash
# The fixture reviewer: a separate process, and the only one that reads the fixture private key
# (Issue #46, M5.7). TEST-ONLY. Its signature rehearses the trusted approval protocol; it is not
# the owner's approval and must never be presented as one.
#
#   reviewer.sh <work-dir> init                       create the key in <work>/reviewer (mode 0700/0600)
#                                                     and write only its public trust-list entry
#   reviewer.sh <work-dir> approve <changeId> <digest>
#                                                     approve exactly <digest> in <work>/course-desk,
#                                                     against the trust list at the protected test base
#   reviewer.sh <work-dir> verify                     integrity with attestation required, pinned to
#                                                     the test base (the fixture trust anchor)
# The browser host and the agent never get the key: the host is started without it, the agent runs
# in its own clone, and this script refuses to run under an agent identity (VCV_HOST_PRINCIPAL).
set -euo pipefail
work=$(cd "${1:?usage: reviewer.sh <work-dir> init|approve|verify}" && pwd)
cmd=${2:?usage: reviewer.sh <work-dir> init|approve|verify}
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[ -z "${VCV_HOST_PRINCIPAL:-}" ] || { echo "reviewer.sh: refused under a host-fixed identity ($VCV_HOST_PRINCIPAL)" >&2; exit 2; }
case "$cmd" in
  init)
    [ ! -e "$keys" ] || { echo "reviewer.sh: $keys exists" >&2; exit 1; }
    mkdir -m 700 "$keys"
    vcv reviewer init "$keys/fixture-reviewer.pem" --id "$FIXTURE_REVIEWER" > "$keys/init.txt"
    # Only the public entry leaves this directory.
    sed -n '/^{/,/^}/p' "$keys/init.txt" > "$work/fixture-reviewer.public.json"
    echo "fixture reviewer key created (TEST ONLY); public entry: <work>/fixture-reviewer.public.json"
    ;;
  approve)
    change=${3:?approve <changeId> <digest>}
    digest=${4:?approve <changeId> <digest>}
    echo "TEST-ONLY REHEARSAL: $FIXTURE_REVIEWER signs $change. This is not the owner's approval."
    vcv review approve "$repo" "$change" --digest "$digest" --key "$keys/fixture-reviewer.pem" --trust-commit "$(cat "$work/main.sha")" | scrub
    ;;
  verify)
    base=$(cat "$work/main.sha")
    vcv integrity "$repo" --base "$base" --trust-commit "$base" --require-attestation | scrub
    ;;
  *) echo "reviewer.sh: unknown command $cmd" >&2; exit 2 ;;
esac
