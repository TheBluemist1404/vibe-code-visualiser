#!/usr/bin/env bash
# Course Desk on `main` with approved acceptance criteria and test mappings, for the code-first
# pre-merge golden path (Issue #22, M4.5).
#
#   examples/reference-app/premerge/setup.sh <work-dir>
#
# <work-dir> must not exist or be empty. It gets:
#   course-desk/  a standalone Git checkout on `main`
#   keys/         the baseline reviewer's key (outside the checkout)
# Steps, all through the public CLI:
#  1. the M3.4 baseline (golden-path/setup.sh): approved model, binding claims, trust list;
#  2. three acceptance criteria, proposed by an agent and approved by the reviewer (model-first);
#  3. test mappings for them, recorded by an agent (evidence claims, no approval);
#  4. the gate policy (.github/vcv-policy.json), read by the gate from the base commit only;
#  5. with VCV_PIN=<full VCV commit ID>: the pre-merge workflow (.github/workflows/vcv-premerge.yml)
#     that trusts that VCV commit, for a hosted copy of this repository;
#  6. `npm ci`, so the candidate's tests can run here (skipped with NO_INSTALL=1).
# REVIEWER_ID names the reviewer (default user:reviewer). By default the reviewer is simulated (a
# key this script creates on this machine). For a hosted demonstration, the person who will
# approve model changes runs this script with their own REVIEWER_ID, so every approval and the trust
# list on main are theirs, and keeps <work-dir>/keys to themselves.
set -euo pipefail
work=${1:?usage: setup.sh <work-dir>}
if [ -e "$work" ] && [ -n "$(ls -A "$work")" ]; then echo "setup: $work exists and is not empty" >&2; exit 1; fi
mkdir -p "$work"
work=$(cd "$work" && pwd)
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
export GIT_AUTHOR_DATE="2026-01-03T00:00:00Z" GIT_COMMITTER_DATE="2026-01-03T00:00:00Z"

bash "$vcv_home/examples/reference-app/golden-path/setup.sh" "$repo" "$keys" | scrub
trust=$(git -C "$repo" log --format=%H --grep="reviewer trust list" -1)

echo "== acceptance criteria (model-first: proposed by an agent, approved by the reviewer)"
changes="$work/changes"; mkdir -p "$changes"
cat > "$changes/criteria.yaml" <<'YAML'
changeId: chg-enrollment-criteria
projectId: prj-course-desk
expectedRevision: REV
rationale: Make the announcement policy checkable before merge, per decision kind.
operations:
  - type: createCriterion
    criterion:
      id: crt-rejection-notified
      kind: criterion
      owner: mod-enrollment
      name: A rejected enrollment is announced
      statement: A request for a full course is recorded as rejected with COURSE_FULL, and the student receives exactly one enrollment-rejected notification for that enrollment.
      verifies: [rul-announce-every-decision, rul-seat-limit, cap-enroll]
      verification: required
  - type: createCriterion
    criterion:
      id: crt-confirmation-notified
      kind: criterion
      owner: mod-enrollment
      name: A confirmed enrollment is announced
      statement: A request while seats are left is confirmed, takes a seat, and the student receives exactly one enrollment-confirmed notification for that enrollment.
      verifies: [rul-announce-every-decision, cap-enroll]
      verification: required
  - type: createCriterion
    criterion:
      id: crt-repeat-rejected
      kind: criterion
      owner: mod-enrollment
      name: A repeat request takes no second seat
      statement: A student already enrolled in a course is rejected with ALREADY_ENROLLED and no second seat is taken.
      verifies: [rul-no-double-enroll]
      verification: optional
YAML
rev=$(vcv project status "$repo" --json | json model.revision)
sed -i "s/^expectedRevision: REV/expectedRevision: $rev/" "$changes/criteria.yaml"
VCV_HOST_PRINCIPAL=agent:bootstrap VCV_HOST_PERMISSIONS=model:propose vcv proposal submit "$repo" "$changes/criteria.yaml" | head -2
digest=$(vcv proposal preview "$repo" chg-enrollment-criteria --json | json data.proposal.proposalDigest)
vcv review approve "$repo" chg-enrollment-criteria --digest "$digest" --key "$keys/reviewer.pem" --trust-commit "$trust" | tail -2 | scrub

echo "== test mappings (agent evidence claims; no approval needed)"
unit=server/src/enrollment/enrollment.service.spec.ts
e2e=server/test/app.e2e-spec.ts
map() { VCV_HOST_PRINCIPAL=agent:bootstrap VCV_HOST_PERMISSIONS=binding:record vcv binding add "$repo" --source agent --confidence 0.9 --relation tests "$@" | head -1; }
map --id test.rejection.unit --object crt-rejection-notified --locator "$unit#test:EnrollmentService > rejects an enrollment into a full course and notifies the student" --rationale "asserts COURSE_FULL and one enrollment-rejected notification for that enrollment"
map --id test.rejection.e2e --object crt-rejection-notified --locator "$e2e#test:Course Desk API (e2e) > confirms, then rejects when full; each student is notified of their outcome" --rationale "over HTTP: the rejected student's notifications are exactly one enrollment-rejected entry"
map --id test.confirmation.unit --object crt-confirmation-notified --locator "$unit#test:EnrollmentService > confirms an enrollment while seats are left and notifies the student" --rationale "asserts the confirmation, the seat, and one enrollment-confirmed notification"
map --id test.confirmation.e2e --object crt-confirmation-notified --locator "$e2e#test:Course Desk API (e2e) > confirms, then rejects when full; each student is notified of their outcome" --rationale "over HTTP: the confirmed student's notifications are exactly one enrollment-confirmed entry"
map --id test.repeat.unit --object crt-repeat-rejected --locator "$unit#test:EnrollmentService > rejects a repeat enrollment without taking a second seat" --rationale "asserts ALREADY_ENROLLED and the unchanged seat count"

echo "== gate policy, read from the base commit only"
mkdir -p "$repo/.github"
cat > "$repo/.github/vcv-policy.json" <<'JSON'
{
  "format": "vcv-policy-1",
  "observations": { "contradiction": "block" },
  "requireEvidence": [{ "object": "rul-announce-every-decision", "reason": "every enrollment decision must reach the student" }]
}
JSON
if [ -n "${VCV_PIN:-}" ]; then
  [[ $VCV_PIN =~ ^[0-9a-f]{40}$ ]] || { echo "setup: VCV_PIN must be a full commit ID" >&2; exit 2; }
  mkdir -p "$repo/.github/workflows"
  sed "s/VCV_PIN/$VCV_PIN/" "$here/vcv-premerge.yml" > "$repo/.github/workflows/vcv-premerge.yml"
  echo "workflow: .github/workflows/vcv-premerge.yml trusts VCV $VCV_PIN"
fi
git -C "$repo" add -A
git -C "$repo" commit -q -m "vcv: approve chg-enrollment-criteria; map criteria to test cases; gate policy"
rm -r "$changes"
vcv criteria "$repo" | scrub
git -C "$repo" rev-parse HEAD > "$work/main.sha"
echo "main: $(cat "$work/main.sha")"

if [ "${NO_INSTALL:-}" != 1 ]; then
  echo "== install the app (for its own test runner)"
  (cd "$repo" && npm ci --no-audit --no-fund --loglevel=error >/dev/null)
fi
echo "setup: ok. Keep $keys private; it holds the reviewer's private key."
