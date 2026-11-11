#!/usr/bin/env bash
# Course Desk with an authorized baseline model, for the model-first golden path (Issue #17, M3.4).
#
#   examples/reference-app/golden-path/setup.sh <empty-dir> <reviewer-key-dir>
#
# Builds a fresh, standalone Course Desk checkout on `main`, entirely through the public CLI:
#  1. materializes the app; `.gitattributes` keeps .vcv/ byte-exact on every platform;
#  2. creates .vcv/ from the M2.3 agent draft and records the bootstrap agent's binding claims;
#  3. creates the reviewer's Ed25519 key in <reviewer-key-dir> (outside the checkout, never shown
#     to an agent) and commits its public entry to .vcv/reviewers.json: the trust list on main;
#  4. authorizes the baseline: the bootstrap agent proposes `approveDraft`, the reviewer approves
#     it against the pinned trust commit, and the result is committed on main.
# Identity, dates and Git config are fixed. The reviewer is simulated (a key on this machine),
# which demonstrates the protocol, not a production trust boundary (docs/approvals.md).
set -euo pipefail

repo=${1:?usage: setup.sh <empty-dir> <reviewer-key-dir>}
keys=${2:?usage: setup.sh <empty-dir> <reviewer-key-dir>}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
vcv_home=$(cd "$here/../../.." && pwd)
vcv() { node --experimental-strip-types --no-warnings "$vcv_home/apps/cli/src/main.ts" "$@"; }
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME="Course Desk Fixture" GIT_AUTHOR_EMAIL="fixture@course-desk.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_DATE="2026-01-02T00:00:00Z" GIT_COMMITTER_DATE="2026-01-02T00:00:00Z"
commit() { git -C "$repo" add -A && git -C "$repo" commit -q -m "$1"; }

echo "== materialize and create the draft project"
bash "$here/../materialize.sh" "$repo" >/dev/null
printf '.vcv/** -text\n' > "$repo/.gitattributes"
vcv project init "$repo" "$vcv_home/docs/samples/m2.3-bootstrap/agent-output/model.yaml" | sed "s|$repo|<repo>|g"

echo "== binding claims (made by the bootstrap agent)"
svc=server/src/enrollment/enrollment.service.ts
ntf=server/src/notifications
claim() { vcv binding add "$repo" --as agent:bootstrap --source agent --confidence 0.8 "$@" | head -1; }
claim --id impl.cap-enroll --object cap-enroll --relation implements --locator "$svc#symbol:EnrollmentService.enroll" --rationale "enroll() decides, records and announces each request"
claim --id impl.rul-seat-limit --object rul-seat-limit --relation implements --locator "$svc#symbol:EnrollmentService.enroll" --rationale "the capacity check is in enroll()"
claim --id impl.rul-announce-every-decision --object rul-announce-every-decision --relation implements --locator "$svc#symbol:EnrollmentService.enroll" --rationale "enroll() sends exactly one notification per recorded decision"
claim --id expose.cap-enroll --object cap-enroll --relation exposes --locator "server/src/enrollment/enrollment.controller.ts#route:POST /enrollments" --rationale "the HTTP handler for enrollment requests"
claim --id test.rul-seat-limit --object rul-seat-limit --relation tests --locator "server/src/enrollment/enrollment.service.spec.ts#test:EnrollmentService > rejects an enrollment into a full course and notifies the student" --rationale "the unit test for a full course"
claim --id persist.dat-enrollment --object dat-enrollment --relation persists --locator "server/src/enrollment/enrollment.types.ts#symbol:Enrollment" --rationale "the stored enrollment record"
claim --id persist.dat-notification --object dat-notification --relation persists --locator "$ntf/notification.types.ts#symbol:Notification" --rationale "the stored notification record"
claim --id impl.cap-list-notifications --object cap-list-notifications --relation implements --locator "$ntf/notifications.service.ts#symbol:NotificationsService.forRecipient" --rationale "forRecipient() returns a recipient's notifications, oldest first"

echo "== the reviewer's key (outside the checkout) and the trust list on main"
mkdir -p "$keys"
chmod 700 "$keys"
vcv reviewer init "$keys/reviewer.pem" --id user:reviewer --add "$repo" | sed "s|$keys|<keys>|g; s|$repo|<repo>|g"
commit "vcv: draft model, binding claims and the reviewer trust list"
trust=$(git -C "$repo" rev-parse HEAD)

echo "== authorize the baseline: proposed by the bootstrap agent, approved by the reviewer"
mkdir -p "$repo.changes"
cat > "$repo.changes/baseline.yaml" <<YAML
changeId: chg-baseline
projectId: prj-course-desk
expectedRevision: rev-1
rationale: The bootstrapped draft was reviewed against the code; it becomes the agreed baseline.
operations:
  - type: approveDraft
YAML
VCV_HOST_PRINCIPAL=agent:bootstrap VCV_HOST_PERMISSIONS=model:propose vcv proposal submit "$repo" "$repo.changes/baseline.yaml" | head -2
digest=$(vcv proposal preview "$repo" chg-baseline --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.proposal.proposalDigest))')
vcv review approve "$repo" chg-baseline --digest "$digest" --key "$keys/reviewer.pem" --trust-commit "$trust" | sed "s|$keys|<keys>|g; s|$repo|<repo>|g"
rm -r "$repo.changes"
commit "vcv: approve chg-baseline (approved baseline model)"
vcv project status "$repo" | sed "s|$repo|<repo>|g"
echo "baseline: $(git -C "$repo" rev-parse HEAD) on main (trust list from $trust)"
