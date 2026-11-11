#!/usr/bin/env bash
# Course Desk with a model, binding claims and a controlled source change (Issue #15, M2.5).
#
#   examples/reference-app/maintenance/setup.sh <empty-dir> [--app-tests]
#
# 1. Materializes Course Desk, creates .vcv/ from the M2.3 agent draft with `vcv project init`,
#    and records eight binding claims as the bootstrap agent, all through the public CLI.
# 2. Commits that as the explicit Git baseline (fixed identity and dates: same commit every run).
# 3. Applies changes/waitlist.patch to the working tree, uncommitted: a full course now waitlists
#    instead of rejecting (ORACLE.md, planned change C3), with the app's tests updated.
# 4. With --app-tests, runs the app's own `npm ci`, typecheck, tests, build and HTTP smoke run
#    on the changed tree, so the change is known to be internally consistent.
# The model is not touched after step 1; bringing it in line is the maintainer's job.
set -euo pipefail

repo=${1:?usage: setup.sh <empty-dir> [--app-tests]}
app_tests=${2:-}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
vcv_home=$(cd "$here/../../.." && pwd)
vcv() { node --experimental-strip-types --no-warnings "$vcv_home/apps/cli/src/main.ts" "$@"; }
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME="Course Desk Fixture" GIT_AUTHOR_EMAIL="fixture@course-desk.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_DATE="2026-01-02T00:00:00Z" GIT_COMMITTER_DATE="2026-01-02T00:00:00Z"

echo "== materialize and create the draft project"
bash "$here/../materialize.sh" "$repo" >/dev/null
vcv project init "$repo" "$vcv_home/docs/samples/m2.3-bootstrap/agent-output/model.yaml" | sed "s|$repo|<repo>|g"

echo "== binding claims (made by the bootstrap agent)"
svc=server/src/enrollment/enrollment.service.ts
claim() { vcv binding add "$repo" --as agent:bootstrap --source agent --confidence 0.8 "$@" | head -1; }
claim --id impl.cap-enroll --object cap-enroll --relation implements --locator "$svc#symbol:EnrollmentService.enroll" --rationale "enroll() decides, records and announces each request"
claim --id impl.rul-seat-limit --object rul-seat-limit --relation implements --locator "$svc#symbol:EnrollmentService.enroll" --rationale "the capacity check is in enroll()"
claim --id impl.rul-no-double-enroll --object rul-no-double-enroll --relation implements --locator "$svc#symbol:EnrollmentService.enroll" --rationale "the repeat check is in enroll()"
claim --id impl.cap-list-courses --object cap-list-courses --relation implements --locator "$svc#symbol:EnrollmentService.courses" --rationale "courses() computes seats left"
claim --id expose.cap-enroll --object cap-enroll --relation exposes --locator "server/src/enrollment/enrollment.controller.ts#route:POST /enrollments" --rationale "the HTTP handler for enrollment requests"
claim --id test.rul-seat-limit --object rul-seat-limit --relation tests --locator "server/src/enrollment/enrollment.service.spec.ts#test:EnrollmentService > rejects an enrollment into a full course and notifies the student" --rationale "the unit test for a full course"
claim --id persist.dat-enrollment --object dat-enrollment --relation persists --locator "server/src/enrollment/enrollment.types.ts#symbol:Enrollment" --rationale "the stored enrollment record"
claim --id persist.dat-notification --object dat-notification --relation persists --locator "server/src/notifications/notification.types.ts#symbol:NotificationKind" --rationale "the kinds of notification the app sends"

git -C "$repo" add -A
git -C "$repo" commit -q -m "vcv: draft model and binding claims"
echo "baseline: $(git -C "$repo" rev-parse HEAD) (model and claims committed; working tree clean)"

echo "== controlled source change (uncommitted): changes/waitlist.patch"
git -C "$repo" apply "$here/../changes/waitlist.patch"
git -C "$repo" status --porcelain=v1 | sed 's/^/  /'

if [ "$app_tests" = "--app-tests" ]; then
  echo "== the app's own checks on the changed tree"
  (cd "$repo" && npm ci --no-audit --no-fund --loglevel=error >/dev/null && npm run -s typecheck && npm test --silent 2>&1 | grep -E "Test Files|Tests " && npm run -s build >/dev/null && npm run -s smoke | tail -1)
fi
