#!/usr/bin/env bash
# The code-first pre-merge golden path and its negative cases (Issue #22, M4.5).
#
#   examples/reference-app/premerge/scenarios.sh <work-dir> <out-dir> [step...]
#
# <work-dir> comes from setup.sh. Each step starts a branch from `main` (the protected base),
# makes a real source, test or model change, and runs the local equivalent of the three CI jobs
# (ci.sh). Results go to <out-dir>/<step>/. Steps (default: all, in this order):
#
#   main          the base itself: every required criterion passes in a run captured here
#   broken        code-first: rejected requests are no longer announced. Blocks, naming
#                 crt-rejection-notified and its two failing test cases (not just "2 failed")
#   explained     the same candidate with the agent's observation (a contradiction citing the
#                 code, the rule and the failing cases): VCV checks the references, labels it a claim
#   fixed         a later commit on that branch restores the announcement: fresh run, gate passes
#   harmless      a comment-only edit of a bound file: not a violation (passes)
#   weak-evidence an error-message change no criterion covers, with an agent's speculative concern:
#                 passes with a warning, never a proven contradiction
#   intent        the same behaviour change as `broken`, now intended: the test is updated and the
#                 agent submits a typed proposal. Blocks until a person approves it through M3
#   approved      after the separate approval (APPROVE_CMD, see below), with the mapping reasserted
#   negatives     forged/agent records, a report from another commit, a silent model edit, a
#                 relaxed policy in the candidate, a pending (unapproved) proposal
#   merge         a simulated merge of `fixed` into main: old base, candidate and merged views
#
# The `approved` step needs the M3 approval of the intent change. By default it is the fixture's
# simulated reviewer key (labelled SIMULATED in the output). Set APPROVE_CMD to a command that
# performs a real person's approval instead; it is run as `$APPROVE_CMD <repo> <changeId> <digest>`.
set -uo pipefail
work=$(cd "${1:?usage: scenarios.sh <work-dir> <out-dir> [step...]}" && pwd)
mkdir -p "${2:?}"
out=$(cd "$2" && pwd)
shift 2
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
export GIT_AUTHOR_DATE="2026-01-04T00:00:00Z" GIT_COMMITTER_DATE="2026-01-04T00:00:00Z"
main=$(cat "$work/main.sha")
svc=server/src/enrollment/enrollment.service.ts
spec=server/src/enrollment/enrollment.service.spec.ts
e2e=server/test/app.e2e-spec.ts
unit_reject="EnrollmentService > rejects an enrollment into a full course and notifies the student"
e2e_both="Course Desk API (e2e) > confirms, then rejects when full; each student is notified of their outcome"

ci() { local step=$1; shift; bash "$here/ci.sh" "$work" "$out/$step" "$@"; }
branch() { git -C "$repo" checkout -q -B "$1" "${2:-$main}"; git -C "$repo" clean -qfd -e node_modules; }
commit() { git -C "$repo" add -A && git -C "$repo" commit -q -m "$1"; }
# edit <file> <old> <new>: exact, single replacement (fails if <old> is not there exactly once).
edit() {
  node -e 'const fs=require("fs");const [f,a,b]=process.argv.slice(1);const t=fs.readFileSync(f,"utf8");if(t.split(a).length!==2){console.error("edit: not exactly one match in "+f);process.exit(1)}fs.writeFileSync(f,t.replace(a,()=>b))' "$repo/$1" "$2" "$3"
}
diff_of() { git -C "$repo" diff "$1" -- . ':!.vcv' > "$out/$2/source.diff"; git -C "$repo" diff --stat "$1" > "$out/$2/diffstat.txt"; }
expect() { # expect <step> <exit code>
  local got; got=$(cat "$out/$1/exit-code")
  if [ "$got" = "$2" ]; then echo "  expected exit $2: ok"; else echo "  UNEXPECTED: exit $got, expected $2"; failures=$((failures + 1)); fi
}
# reassert <bindingId> <locator> <rationale>: the agent re-points a mapping (no approval needed).
reassert() {
  local id=$1 loc=$2 d
  d=$(vcv binding list "$repo" --json | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const id=process.argv[1];const all=JSON.parse(s);const list=Array.isArray(all)?all:(all.data?.claims??all.claims??all.entries??[]);const e=list.find(c=>(c.bindingId??c.claim?.bindingId)===id);console.log(e?.digest??"")})' "$id")
  VCV_HOST_PRINCIPAL=agent:coder VCV_HOST_PERMISSIONS=binding:record vcv binding reassert "$repo" "$id" --locator "$loc" --expect "$d" --source agent --rationale "$3" | head -1
}
failures=0

# The deliberate code-first change: a rejected request is recorded but no longer announced.
QUIET_OLD='    if (reason) {
      this.notifications.notify(
        enrollment.studentId,
        "enrollment-rejected",
        enrollment.id,
        reason === "COURSE_FULL" ? `${course.title} is full; your enrollment was not accepted.` : `You are already enrolled in ${course.title}.`,
      );
    } else {
      this.notifications.notify(enrollment.studentId, "enrollment-confirmed", enrollment.id, `You are enrolled in ${course.title}.`);
    }'
QUIET_NEW='    // Only confirmations are announced; the response already tells the student about a rejection.
    if (!reason) {
      this.notifications.notify(enrollment.studentId, "enrollment-confirmed", enrollment.id, `You are enrolled in ${course.title}.`);
    }'

step_main() {
  echo "== main: the protected base"
  branch main "$main"
  ci main; expect main 0
}

step_broken() {
  echo "== broken: code-first, rejected requests are no longer announced"
  branch code-first/quiet-rejections
  edit "$svc" "$QUIET_OLD" "$QUIET_NEW"
  commit "Only announce confirmed enrollments"
  ci broken; expect broken 1
  diff_of "$main" broken
}

step_explained() {
  echo "== explained: the same candidate, with the agent's observation"
  branch code-first/quiet-rejections code-first/quiet-rejections
  local line; line=$(grep -n 'if (!reason) {' "$repo/$svc" | cut -d: -f1)
  cat > "$work/observations.json" <<JSON
{
  "format": "vcv-observations-1",
  "observations": [
    {
      "id": "obs-rejection-not-announced",
      "kind": "contradiction",
      "statement": "enroll() still records a rejected enrollment but no longer calls notifications.notify() for it, so a student turned away from a full course gets no enrollment-rejected notification. The approved rule says every decision, confirmed or rejected, results in exactly one notification.",
      "objects": ["rul-announce-every-decision", "crt-rejection-notified", "cap-enroll"],
      "locations": [{ "path": "$svc", "startLine": $((line - 1)), "endLine": $((line + 2)) }],
      "tests": [
        { "path": "$spec", "name": "$unit_reject" },
        { "path": "$e2e", "name": "$e2e_both" }
      ],
      "resolution": "fix-code",
      "author": "${OBSERVATION_AUTHOR:-agent:coder (scripted stand-in)}"
    }
  ]
}
JSON
  ci explained --observations "$work/observations.json"; expect explained 1
}

step_fixed() {
  echo "== fixed: a later commit restores the announcement"
  branch code-first/quiet-rejections code-first/quiet-rejections
  edit "$svc" "$QUIET_NEW" "$QUIET_OLD"
  commit "Announce rejected enrollments again (rul-announce-every-decision)"
  ci fixed; expect fixed 0
  diff_of "$main" fixed
  git -C "$repo" log --format='%h %s' "$main"..HEAD > "$out/fixed/branch-log.txt"
}

step_harmless() {
  echo "== harmless: a comment-only edit of a bound file"
  branch code-first/comment
  edit "$svc" "Enrollment rules. Every decision is recorded and announced to the student:" "Enrollment rules. Each decision is recorded and announced to the student:"
  commit "Reword the EnrollmentService comment"
  ci harmless; expect harmless 0
  diff_of "$main" harmless
}

step_weak_evidence() {
  echo "== weak-evidence: an error-message change no criterion covers, with a speculative concern"
  branch code-first/error-wording
  local ctl=server/src/notifications/notifications.controller.ts
  edit "$ctl" '"recipientId is required"' '"the recipientId query parameter is required"'
  commit "Clarify the missing-recipient error message"
  local line; line=$(grep -n 'the recipientId query parameter is required' "$repo/$ctl" | cut -d: -f1)
  cat > "$work/observations-wording.json" <<JSON
{
  "format": "vcv-observations-1",
  "observations": [
    {
      "id": "obs-error-wording",
      "kind": "concern",
      "statement": "The 400 message for a missing recipientId changed. A client that matches on the old text could break; no criterion covers this message and no test asserts it, so this is a judgement for the reviewer, not a checked fact.",
      "objects": ["rul-recipient-required", "cap-list-notifications"],
      "locations": [{ "path": "$ctl", "startLine": $line, "endLine": $line }],
      "resolution": "inspect",
      "author": "${OBSERVATION_AUTHOR:-agent:coder (scripted stand-in)}"
    }
  ]
}
JSON
  ci weak-evidence --observations "$work/observations-wording.json"; expect weak-evidence 0
  diff_of "$main" weak-evidence
}

step_intent() {
  echo "== intent: the same behaviour, now intended; the agent proposes the model change"
  branch model-first/quiet-rejections
  edit "$svc" "$QUIET_OLD" "$QUIET_NEW"
  edit "$spec" '  it("rejects an enrollment into a full course and notifies the student", async () => {
    const { enrollment, notifications } = await setup();
    enrollment.enroll({ studentId: "stu-ada", courseId: "crs-poetry" });
    const e = enrollment.enroll({ studentId: "stu-bob", courseId: "crs-poetry" });
    expect(e).toMatchObject({ status: "rejected", reason: "COURSE_FULL" });
    expect(notifications.forRecipient("stu-bob")).toEqual([
      expect.objectContaining({ kind: "enrollment-rejected", enrollmentId: e.id }),
    ]);
  });' '  it("rejects an enrollment into a full course without notifying the student", async () => {
    const { enrollment, notifications } = await setup();
    enrollment.enroll({ studentId: "stu-ada", courseId: "crs-poetry" });
    const e = enrollment.enroll({ studentId: "stu-bob", courseId: "crs-poetry" });
    expect(e).toMatchObject({ status: "rejected", reason: "COURSE_FULL" });
    expect(notifications.forRecipient("stu-bob")).toEqual([]);
  });'
  edit "$e2e" '    const bob = await request(server).get("/api/notifications").query({ recipientId: "stu-bob" }).expect(200);
    expect(bob.body).toEqual([
      { id: "ntf-2", recipientId: "stu-bob", kind: "enrollment-rejected", enrollmentId: "enr-2", message: "Modern Poetry is full; your enrollment was not accepted." },
    ]);' '    const bob = await request(server).get("/api/notifications").query({ recipientId: "stu-bob" }).expect(200);
    expect(bob.body).toEqual([]);'
  edit "$e2e" 'confirms, then rejects when full; each student is notified of their outcome' 'confirms, then rejects when full; only the confirmed student is notified'
  local rev; rev=$(vcv project status "$repo" --json | json model.revision)
  mkdir -p "$work/changes"
  cat > "$work/changes/quiet-rejections.yaml" <<YAML
changeId: chg-quiet-rejections
projectId: prj-course-desk
expectedRevision: $rev
rationale: Product decision - a rejection is shown in the enrollment response; only confirmations are sent as notifications.
operations:
  - type: setRuleStatement
    ruleId: rul-announce-every-decision
    statement: Each enrollment decision is recorded; a confirmed decision results in exactly one notification to the student, a rejected one in none.
  - type: renameObject
    objectId: crt-rejection-notified
    name: A rejected enrollment is not announced
  - type: reviseCriterion
    criterionId: crt-rejection-notified
    statement: A request for a full course is recorded as rejected with COURSE_FULL, and the student receives no notification for it.
YAML
  VCV_HOST_PRINCIPAL=agent:coder VCV_HOST_PERMISSIONS=model:propose vcv proposal submit "$repo" "$work/changes/quiet-rejections.yaml" | head -2 | tee "$out/intent-proposal.txt"
  mkdir -p "$out/intent"; mv "$out/intent-proposal.txt" "$out/intent/proposal.txt"
  cp "$work/changes/quiet-rejections.yaml" "$out/intent/proposal.yaml"
  vcv proposal preview "$repo" chg-quiet-rejections | scrub > "$out/intent/preview.txt"
  commit "Stop announcing rejected enrollments; propose the model change (chg-quiet-rejections)"
  ci intent; expect intent 1
  diff_of "$main" intent
}

step_approved() {
  echo "== approved: the separate approval of chg-quiet-rejections, then the mappings are reasserted"
  branch model-first/quiet-rejections model-first/quiet-rejections
  mkdir -p "$out/approved"
  local digest; digest=$(vcv proposal preview "$repo" chg-quiet-rejections --json | json data.proposal.proposalDigest)
  echo "proposal digest: $digest" > "$out/approved/approval.txt"
  if [ -n "${APPROVE_CMD:-}" ]; then
    echo "approval: APPROVE_CMD (a person's own approval)" >> "$out/approved/approval.txt"
    $APPROVE_CMD "$repo" chg-quiet-rejections "$digest" 2>&1 | scrub >> "$out/approved/approval.txt"
  else
    local trust; trust=$(git -C "$repo" log --format=%H --grep="reviewer trust list" -1)
    echo "approval: SIMULATED (the fixture's reviewer key on this machine; not a real person's approval)" >> "$out/approved/approval.txt"
    vcv review approve "$repo" chg-quiet-rejections --digest "$digest" --key "$keys/reviewer.pem" --trust-commit "$trust" 2>&1 | scrub >> "$out/approved/approval.txt"
  fi
  commit "vcv: approve chg-quiet-rejections"
  # The tests were renamed with the approved intent: the agent reasserts their mappings.
  {
    reassert test.rejection.unit "$spec#test:EnrollmentService > rejects an enrollment into a full course without notifying the student" "asserts COURSE_FULL and no notification, per the approved revision"
    reassert test.rejection.e2e "$e2e#test:Course Desk API (e2e) > confirms, then rejects when full; only the confirmed student is notified" "over HTTP: the rejected student has no notifications"
    reassert test.confirmation.e2e "$e2e#test:Course Desk API (e2e) > confirms, then rejects when full; only the confirmed student is notified" "over HTTP: the confirmed student has exactly one enrollment-confirmed notification"
    reassert test.rul-seat-limit "$spec#test:EnrollmentService > rejects an enrollment into a full course without notifying the student" "the unit test for a full course, renamed"
  } | scrub | tee "$out/approved/reassert.txt"
  commit "Reassert the renamed tests' mappings"
  ci approved; expect approved 0
  git -C "$repo" log --format='%h %s' "$main"..HEAD > "$out/approved/branch-log.txt"
}

step_negatives() {
  echo "== negatives"
  local n="$out/negatives"; mkdir -p "$n"
  : > "$n/summary.txt"
  row() { printf '%-58s %s\n' "$1" "$2" >> "$n/summary.txt"; }
  gate() { "$vcv_home/scripts/vcv-premerge-gate.sh" "$vcv_home" "$repo" "$main" --policy-at-base .github/vcv-policy.json "$@"; }
  local code

  # 1. The broken candidate ships its own passing record, captured by the agent.
  branch negative/broken-with-records code-first/quiet-rejections~1 # the broken commit
  VCV_HOST_PRINCIPAL=agent:coder VCV_HOST_PERMISSIONS=model:propose vcv tests capture "$repo" --junit "$out/main/junit.xml" --root server --runner vitest --invocation "npx vitest run (claimed by the agent)" --out "$n/agent-record.json" > /dev/null 2>&1
  gate --run "$n/agent-record.json" > "$n/1-agent-record.txt" 2>&1; code=$?
  row "1 broken code + agent-supplied passing record" "exit $code: $(head -1 "$n/1-agent-record.txt")"

  # 2. The same record relabelled as host-observed.
  node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1]));r.observedBy="host";fs.writeFileSync(process.argv[2],JSON.stringify(r))' "$n/agent-record.json" "$n/relabelled-record.json"
  gate --run "$n/relabelled-record.json" > "$n/2-relabelled.txt" 2>&1; code=$?
  row "2 relabelled record (observedBy: host)" "exit $code: $(head -1 "$n/2-relabelled.txt")"

  # 3. main's green report, presented as this candidate's run (identity read now).
  local now; now=$(vcv tests identity "$repo" --json | json identityDigest)
  local mainid; mainid=$(json identityDigest < "$out/main/identity.json")
  gate --junit "$out/main/junit.xml" --root server --runner vitest --invocation "npx vitest run" --before "$mainid" > "$n/3-report-from-main.txt" 2>&1; code=$?
  row "3 main's report with main's identity, on the broken commit" "exit $code: $(head -1 "$n/3-report-from-main.txt")"
  gate --junit "$out/main/junit.xml" --root server --runner vitest --invocation "npx vitest run" > "$n/4-report-unbound.txt" 2>&1; code=$?
  row "4 main's report without a pre-run identity" "exit $code: $(head -1 "$n/4-report-unbound.txt")"

  # 5. A silent model edit: the candidate rewrites the approved criterion in its revision file.
  branch negative/silent-model-edit
  local revfile; revfile=$(ls "$repo"/.vcv/revisions/rev-3-*.yaml | head -1)
  edit "${revfile#$repo/}" "and the student receives exactly one enrollment-rejected notification for that enrollment" "and the student receives no notification for it"
  edit "$svc" "$QUIET_OLD" "$QUIET_NEW"
  commit "Quietly change the criterion and the code"
  gate > "$n/5-silent-model-edit.txt" 2>&1; code=$?
  row "5 revision file edited in place (no proposal, no approval)" "exit $code: $(head -1 "$n/5-silent-model-edit.txt")"

  # 6. The candidate relaxes the policy file it carries.
  branch negative/relaxed-policy
  edit "$svc" "$QUIET_OLD" "$QUIET_NEW"
  printf '{ "format": "vcv-policy-1", "observations": { "contradiction": "warn" }, "requireEvidence": [] }\n' > "$repo/.github/vcv-policy.json"
  commit "Relax the gate policy and stop announcing rejections"
  (cd "$repo/server" && npx vitest run --reporter=junit --outputFile="$n/6-junit.xml" > /dev/null 2>&1)
  local id6; id6=$(vcv tests identity "$repo" --json | json identityDigest)
  gate --junit "$n/6-junit.xml" --root server --runner vitest --invocation "npx vitest run" --before "$id6" > "$n/6-relaxed-policy.txt" 2>&1; code=$?
  row "6 candidate relaxes .github/vcv-policy.json" "exit $code: $(head -1 "$n/6-relaxed-policy.txt")"

  # 7. A pending proposal with the code change, before any approval (intent, without approval).
  row "7 intended change, proposal pending (see intent/)" "exit $(cat "$out/intent/exit-code" 2>/dev/null || echo '?'): $(head -1 "$out/intent/gate.txt" 2>/dev/null)"

  # 8. The intended change WITHOUT the model change: code and tests changed, the agent re-points
  #    the required criterion's mappings at the new (opposite) tests, no proposal, no approval.
  branch negative/remap-without-approval
  git -C "$repo" checkout -q model-first/quiet-rejections~2 -- server # the intent step's code and tests, without its proposal
  commit "Stop announcing rejected enrollments (no model change)" >/dev/null
  {
    reassert test.rejection.unit "$spec#test:EnrollmentService > rejects an enrollment into a full course without notifying the student" "renamed"
    reassert test.rejection.e2e "$e2e#test:Course Desk API (e2e) > confirms, then rejects when full; only the confirmed student is notified" "renamed"
    reassert test.confirmation.e2e "$e2e#test:Course Desk API (e2e) > confirms, then rejects when full; only the confirmed student is notified" "renamed"
  } > "$n/8-reassert.txt"
  commit "Reassert the mappings" >/dev/null
  (cd "$repo/server" && npx vitest run --reporter=junit --outputFile="$n/8-junit.xml" > /dev/null 2>&1)
  local id8; id8=$(vcv tests identity "$repo" --json | json identityDigest)
  gate --junit "$n/8-junit.xml" --root server --runner vitest --invocation "npx vitest run" --before "$id8" > "$n/8-remap-without-approval.txt" 2>&1; code=$?
  row "8 behaviour change + remapped tests, no model change" "exit $code: $(head -1 "$n/8-remap-without-approval.txt")"

  scrub < "$n/summary.txt" > "$n/summary.tmp" && mv "$n/summary.tmp" "$n/summary.txt"
  for f in "$n"/*.txt; do scrub < "$f" > "$f.tmp" && mv "$f.tmp" "$f"; done
  cat "$n/summary.txt"
  # Every case blocks or is refused, except 8: the documented limit. A required criterion's mapping
  # re-pointed by an agent passes when the new test passes; the gate warns MAPPING_CHANGED for the
  # PR reviewer, who judges whether the new test still checks the approved criterion.
  grep -v '^8 ' "$n/summary.txt" | grep -q "exit 0" && { echo "  UNEXPECTED: a negative case passed"; failures=$((failures + 1)); }
  grep -q "MAPPING_CHANGED" "$n/8-remap-without-approval.txt" || { echo "  UNEXPECTED: case 8 does not show MAPPING_CHANGED"; failures=$((failures + 1)); }
  true
}

step_merge() {
  echo "== merge: old base, candidate and a simulated merge, without regeneration"
  local m="$out/merge"; mkdir -p "$m"
  {
    for ref in main code-first/quiet-rejections; do
      git -C "$repo" checkout -q "$ref"
      echo "-- $ref ($(git -C "$repo" rev-parse --short HEAD))"
      vcv project status "$repo" | scrub
      vcv integrity "$repo" --base "$main" --trust-ref "$main" --require-attestation 2>&1 | head -3 | scrub
    done
    git -C "$repo" checkout -q -B simulated-merge "$main"
    git -C "$repo" merge -q --no-ff -m "Merge code-first/quiet-rejections" code-first/quiet-rejections
    echo "-- simulated merge of code-first/quiet-rejections into main ($(git -C "$repo" rev-parse --short HEAD))"
    vcv project status "$repo" | scrub
    vcv integrity "$repo" --base "$main" --trust-ref "$main" --require-attestation 2>&1 | head -3 | scrub
    echo "-- .vcv/ differences between main and the merge (none expected for a code-first fix)"
    git -C "$repo" diff --stat "$main" HEAD -- .vcv
    echo "(end)"
  } > "$m/views.txt" 2>&1
  cat "$m/views.txt"
  git -C "$repo" checkout -q main
}

steps=("$@")
[ ${#steps[@]} -gt 0 ] || steps=(main broken explained fixed harmless weak-evidence intent approved negatives merge)
for s in "${steps[@]}"; do "step_${s//-/_}"; done
git -C "$repo" checkout -q main
echo "scenarios: $failures unexpected result(s)"
[ "$failures" = 0 ]
