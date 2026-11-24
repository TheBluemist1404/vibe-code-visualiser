#!/usr/bin/env bash
# The fixture reviewer (Issue #46, M5.7). TEST-ONLY. It runs as its own OS user ($RV_USER), the only
# one that can open the fixture key; its signature rehearses the trusted approval protocol and is
# not the owner's approval.
#
#   reviewer.sh <work-dir> init                  create the key in <work>/reviewer/key (0700, key 0600)
#                                                and publish only its trust-list entry
#   reviewer.sh <work-dir> pin                   in its own clone of the owner's checkout: resolve
#                                                `test-base`, check that its trust list there holds this
#                                                key, and pin that commit in reviewer/trust-anchor.sha
#                                                (setup only; refuses to re-pin)
#   reviewer.sh <work-dir> approve <changeId> <digest>
#                                                in the reviewer's own clone: fetch the owner's branch,
#                                                preview the change, approve exactly <digest> against
#                                                the trust list at the pinned test base, commit
#   reviewer.sh <work-dir> verify                integrity with attestation required, pinned to the
#                                                test base, in the reviewer's clone
# The anchor is read only from reviewer/trust-anchor.sha: the reviewer's file, in a directory the
# workspace user can neither write nor replace (its parent is root's).
# run.sh starts it with `as $RV_USER`. The workspace user (explorer, agent, gate) cannot open the key
# directory; run.sh and walkthrough.ts check that.
set -euo pipefail
work=$(cd "${1:?usage: reviewer.sh <work-dir> init|approve|verify}" && pwd)
cmd=${2:?usage: reviewer.sh <work-dir> init|approve|verify}
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_user "$RV_USER"
[ -z "${VCV_HOST_PRINCIPAL:-}" ] || { echo "reviewer.sh: refused under a host-fixed identity ($VCV_HOST_PRINCIPAL)" >&2; exit 2; }
export GIT_AUTHOR_NAME="$FIXTURE_REVIEWER (TEST ONLY)" GIT_AUTHOR_EMAIL="fixture-reviewer@course-desk.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
umask 022
case "$cmd" in
  init)
    [ ! -e "$keys" ] || { echo "reviewer.sh: $keys exists" >&2; exit 1; }
    mkdir -m 700 "$keys"
    vcv reviewer init "$key_file" --id "$FIXTURE_REVIEWER" > "$keys/init.txt"
    # Only the public entry leaves the key directory.
    sed -n '/^{/,/^}/p' "$keys/init.txt" > "$work/reviewer/fixture-reviewer.public.json"
    echo "fixture reviewer key created by $(id -un) (TEST ONLY): $(stat -c '%A %U' "$keys") key/, $(stat -c '%A %U' "$key_file") key file"
    ;;
  pin)
    [ ! -e "$anchor_file" ] || { echo "reviewer.sh: the anchor is already pinned" >&2; exit 1; }
    git clone -q --no-checkout "$repo" "$reviewer_repo"
    sha=$(git -C "$reviewer_repo" rev-parse --verify origin/test-base^{commit})
    public=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).publicKey)' "$work/reviewer/fixture-reviewer.public.json")
    git -C "$reviewer_repo" show "$sha:.vcv/reviewers.json" | grep -qF "$public" ||
      { echo "reviewer.sh: test-base $sha does not list this key" >&2; exit 1; }
    echo "$sha" > "$anchor_file"
    chmod 0444 "$anchor_file"
    echo "trust anchor pinned by $(id -un): $sha ($(stat -c '%A %U' "$anchor_file"))"
    ;;
  approve)
    change=${3:?approve <changeId> <digest>}
    digest=${4:?approve <changeId> <digest>}
    git -C "$reviewer_repo" fetch -q origin feature/full-course-notice
    git -C "$reviewer_repo" checkout -q -B feature/full-course-notice FETCH_HEAD
    echo "TEST-ONLY REHEARSAL: $FIXTURE_REVIEWER (OS user $(id -un)) signs $change. This is not the owner's approval."
    seen=$(vcv proposal preview "$reviewer_repo" "$change" --json | json data.proposal.proposalDigest)
    [ "$seen" = "$digest" ] || { echo "reviewer.sh: previewed digest $seen, asked to sign $digest" >&2; exit 1; }
    vcv review approve "$reviewer_repo" "$change" --digest "$digest" --key "$key_file" --trust-commit "$(cat "$anchor_file")" | scrub
    git -C "$reviewer_repo" add .vcv
    git -C "$reviewer_repo" commit -q -m "vcv: approve $change (TEST-ONLY fixture reviewer; digest ${digest:0:12})"
    echo "approval commit: $(git -C "$reviewer_repo" rev-parse HEAD)"
    ;;
  verify)
    base=$(cat "$anchor_file")
    vcv integrity "$reviewer_repo" --base "$base" --trust-commit "$base" --require-attestation | scrub
    ;;
  *) echo "reviewer.sh: unknown command $cmd" >&2; exit 2 ;;
esac
