#!/usr/bin/env bash
# The fixture reviewer (Issue #46, M5.7). TEST-ONLY. It runs as its own OS user ($RV_USER), the only
# one that can open the fixture key; its signature rehearses the trusted approval protocol and is
# not the owner's approval.
#
#   reviewer.sh <work-dir> init                  create the key in <work>/reviewer/key (0700, key 0600)
#                                                and publish only its trust-list entry
#   reviewer.sh <work-dir> pin                   setup only, before the workspace exists: clone Course
#                                                Desk at COURSE_DESK_COMMIT, commit the test base (that
#                                                commit + this key's trust-list entry), check it is
#                                                exactly that, and pin it in reviewer/trust-anchor.sha
#                                                (refuses to re-pin); the workspace clones it from here
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
work=$(cd "${1:?usage: reviewer.sh <work-dir> init|pin|approve|verify}" && pwd)
cmd=${2:?usage: reviewer.sh <work-dir> init|pin|approve|verify}
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
    url=${COURSE_DESK_URL:-https://github.com/TheBluemist1404/course-desk}
    upstream=${COURSE_DESK_COMMIT:-5d966ed599e401cd92a04436245998e1aca6a57b}
    entry="$work/reviewer/fixture-reviewer.public.json"
    echo "== the real Course Desk at $upstream, in the reviewer's own clone"
    git clone -q --no-checkout "$url" "$reviewer_repo"
    upstream=$(git -C "$reviewer_repo" rev-parse --verify "$upstream^{commit}")
    git -C "$reviewer_repo" checkout -q -B test-base "$upstream"
    vcv integrity "$reviewer_repo" --trust-commit "$upstream" --require-attestation | head -1
    echo "== the test base: the fixture reviewer's public entry next to the owner's"
    node -e '
      const fs = require("fs");
      const [file, entryFile] = process.argv.slice(1);
      const list = JSON.parse(fs.readFileSync(file, "utf8"));
      const entry = JSON.parse(fs.readFileSync(entryFile, "utf8"));
      if (list.reviewers.some((r) => r.id === entry.id)) throw new Error("already listed");
      list.reviewers.push(entry);
      fs.writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
    ' "$reviewer_repo/.vcv/reviewers.json" "$entry"
    git -C "$reviewer_repo" add .vcv/reviewers.json
    GIT_AUTHOR_NAME="Course Desk Fixture" GIT_AUTHOR_EMAIL="fixture@course-desk.invalid" \
      GIT_COMMITTER_NAME="Course Desk Fixture" GIT_COMMITTER_EMAIL="fixture@course-desk.invalid" \
      GIT_AUTHOR_DATE="2026-11-24T00:00:00Z" GIT_COMMITTER_DATE="2026-11-24T00:00:00Z" \
      git -C "$reviewer_repo" commit -q -m "TEST ONLY: trust the fixture reviewer for the M5.7 rehearsal (never push)"
    sha=$(git -C "$reviewer_repo" rev-parse HEAD)
    # The pin must be exactly the intended base: one parent, the upstream commit; one changed file,
    # the trust list; and that list is the upstream list plus this key's entry, nothing else.
    [ "$(git -C "$reviewer_repo" rev-list --parents -n 1 "$sha")" = "$sha $upstream" ] ||
      { echo "reviewer.sh: $sha is not a single-parent child of $upstream" >&2; exit 1; }
    [ "$(git -C "$reviewer_repo" diff --name-only "$upstream" "$sha")" = ".vcv/reviewers.json" ] ||
      { echo "reviewer.sh: $sha changes more than .vcv/reviewers.json" >&2; exit 1; }
    node -e '
      const { execFileSync } = require("child_process"), fs = require("fs");
      const [repo, up, sha, entryFile] = process.argv.slice(1);
      const show = (c) => JSON.parse(execFileSync("git", ["-C", repo, "show", `${c}:.vcv/reviewers.json`], { encoding: "utf8" }));
      const want = show(up); want.reviewers.push(JSON.parse(fs.readFileSync(entryFile, "utf8")));
      if (JSON.stringify(show(sha)) !== JSON.stringify(want)) { console.error("reviewer.sh: the trust list is not upstream plus this key"); process.exit(1); }
    ' "$reviewer_repo" "$upstream" "$sha" "$entry"
    echo "$upstream" > "$work/reviewer/upstream.sha"
    echo "$sha" > "$anchor_file"
    chmod 0444 "$anchor_file" "$work/reviewer/upstream.sha"
    echo "trust anchor pinned by $(id -un): $sha = $upstream + the fixture entry ($(stat -c '%A %U' "$anchor_file"))"
    ;;
  approve)
    change=${3:?approve <changeId> <digest>}
    digest=${4:?approve <changeId> <digest>}
    git -C "$reviewer_repo" fetch -q "$repo" feature/full-course-notice
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
