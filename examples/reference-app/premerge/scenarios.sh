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
#   stale-report  a passing report left in the output directory from an earlier run is never
#                 reused: with no runner it blocks (no run); with a failing runner it blocks on the
#                 new report's failures
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
# Every required operation (an edit, a Git step, a proposal, an approval, a reassertion, an
# integrity check) must succeed: the first one that fails stops the run with exit 3 and the summary
# line is never printed. Only the gate's and the runner's verdicts are expected to be nonzero, and
# each one is compared with what the step expects.
set -Eeuo pipefail
trap 'echo "scenarios: FAILED at line $LINENO: $BASH_COMMAND" >&2; exit 3' ERR
die() { echo "scenarios: FAILED: $*" >&2; exit 3; }
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

# ci <step> [ci.sh options]: the gate's exit code is a result, compared later by expect.
ci() { local step=$1; shift; rm -f "$out/$step/exit-code"; bash "$here/ci.sh" "$work" "$out/$step" "$@" || true; }
branch() { git -C "$repo" checkout -q -B "$1" "${2:-$main}"; git -C "$repo" clean -qfd -e node_modules; }
commit() { git -C "$repo" add -A && git -C "$repo" commit -q -m "$1"; }
# edit <file> <old> <new>: exact, single replacement (fails if <old> is not there exactly once).
edit() {
  node -e 'const fs=require("fs");const [f,a,b]=process.argv.slice(1);const t=fs.readFileSync(f,"utf8");if(t.split(a).length!==2){console.error("edit: not exactly one match in "+f);process.exit(1)}fs.writeFileSync(f,t.replace(a,()=>b))' "$repo/$1" "$2" "$3"
}
diff_of() { git -C "$repo" diff "$1" -- . ':!.vcv' > "$out/$2/source.diff"; git -C "$repo" diff --stat "$1" > "$out/$2/diffstat.txt"; }
expect() { # expect <step> <exit code>
  [ -s "$out/$1/exit-code" ] || die "$1: ci.sh wrote no gate exit code (a setup error, not a result)"
  local got; got=$(cat "$out/$1/exit-code")
  if [ "$got" = "$2" ]; then echo "  expected exit $2: ok"; else echo "  UNEXPECTED: exit $got, expected $2"; failures=$((failures + 1)); fi
}
# reassert <bindingId> <locator> <rationale>: the agent re-points a mapping (no approval needed).
reassert() {
  local id=$1 loc=$2 d r
  d=$(vcv binding list "$repo" --json | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const id=process.argv[1];const all=JSON.parse(s);const list=Array.isArray(all)?all:(all.data?.claims??all.claims??all.entries??[]);const e=list.find(c=>(c.bindingId??c.claim?.bindingId)===id);console.log(e?.digest??"")})' "$id")
  [ -n "$d" ] || die "reassert: no claim $id"
  r=$(VCV_HOST_PRINCIPAL=agent:coder VCV_HOST_PERMISSIONS=binding:record vcv binding reassert "$repo" "$id" --locator "$loc" --expect "$d" --source agent --rationale "$3")
  case "$r" in "$id: reasserted"*) printf '%s\n' "${r%%$'\n'*}" ;; *) die "reassert $id: $r" ;; esac
}
# revision: the checkout's approved model revision.
revision() { vcv project status "$repo" --json | json model.revision; }
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

step_stale_report() {
  echo "== stale-report: a report left from an earlier run is never reused"
  local d="$out/stale-report"
  branch negative/stale-report code-first/quiet-rejections~1 # the broken commit
  # (a) The runner cannot start (npx exits 127 before writing anything); main's passing report is
  #     already in the output directory.
  mkdir -p "$d/no-runner" "$work/no-npx"
  printf '#!/bin/sh\necho "npx: not available" >&2\nexit 127\n' > "$work/no-npx/npx"; chmod +x "$work/no-npx/npx"
  cp "$out/main/junit.xml" "$d/no-runner/junit.xml"
  rm -f "$d/no-runner/exit-code"; PATH="$work/no-npx:$PATH" bash "$here/ci.sh" "$work" "$d/no-runner" || true
  expect stale-report/no-runner 1
  if grep -q "unverified: no runs were supplied" "$d/no-runner/gate.txt"; then echo "  old report not reused: ok"; else echo "  UNEXPECTED: the old report was used"; failures=$((failures + 1)); fi
  # (b) The runner runs and fails (nonzero exit, a new failing report); main's report is there too.
  mkdir -p "$d/failing-runner"
  cp "$out/main/junit.xml" "$d/failing-runner/junit.xml"
  rm -f "$d/failing-runner/exit-code"; bash "$here/ci.sh" "$work" "$d/failing-runner" || true
  expect stale-report/failing-runner 1
  if grep -q "TEST_FAILED" "$d/failing-runner/gate.txt"; then echo "  new failing report used: ok"; else echo "  UNEXPECTED: no TEST_FAILED"; failures=$((failures + 1)); fi
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
  # Everything else that still says a rejection is announced (as in the live run, course-desk#4).
  edit "$svc" ' * Enrollment rules. Every decision is recorded and announced to the student:' ' * Enrollment rules. Every decision is recorded; only a confirmed one is announced to the student:'
  edit scripts/smoke.mjs '  assert.equal(results[4].body[0].kind, "enrollment-rejected");' '  assert.deepEqual(results[4].body, []); // a rejection is not announced'
  edit README.md 'Students enroll in courses; every enrollment decision is announced to the student as a
notification.' 'Students enroll in courses; every enrollment decision is recorded, and a confirmed one is
announced to the student as a notification.'
  edit README.md '3. `stu-ada` has one notification (`enrollment-confirmed`), `stu-bob` one
   (`enrollment-rejected`).' '3. `stu-ada` has one notification (`enrollment-confirmed`); `stu-bob` has none, since the
   enrollment response already says the request was rejected.'
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
    objectId: rul-announce-every-decision
    name: Only a confirmed decision is notified
  - type: renameObject
    objectId: crt-rejection-notified
    name: A rejected enrollment is not announced
  - type: reviseCriterion
    criterionId: crt-rejection-notified
    statement: A request for a full course is recorded as rejected with COURSE_FULL, and the student receives no notification for it.
  - type: setDescription
    objectId: prj-course-desk
    description: Draft bootstrapped from the repository at commit adb423c; not reviewed. Students enroll in courses; every enrollment decision is recorded, and a confirmed one is announced as a notification. NestJS API (server/, in-memory storage) plus a React page (web/). Based on README.md and the sources.
YAML
  mkdir -p "$out/intent"
  VCV_HOST_PRINCIPAL=agent:coder VCV_HOST_PERMISSIONS=model:propose vcv proposal submit "$repo" "$work/changes/quiet-rejections.yaml" > "$out/intent/proposal.full.txt"
  grep -q '^chg-quiet-rejections: pending' "$out/intent/proposal.full.txt" || die "intent: the proposal is not pending: $(cat "$out/intent/proposal.full.txt")"
  sed -n 1,2p "$out/intent/proposal.full.txt" | tee "$out/intent/proposal.txt"; rm "$out/intent/proposal.full.txt"
  [ "$(revision)" = "$rev" ] || die "intent: submitting moved the approved revision"
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
  [[ $digest =~ ^[0-9a-f]{64}$ ]] || die "approved: no pending proposal digest"
  local before; before=$(revision)
  echo "proposal digest: $digest" > "$out/approved/approval.txt"
  if [ -n "${APPROVE_CMD:-}" ]; then
    echo "approval: APPROVE_CMD (a person's own approval)" >> "$out/approved/approval.txt"
    $APPROVE_CMD "$repo" chg-quiet-rejections "$digest" 2>&1 | scrub >> "$out/approved/approval.txt"
  else
    local trust; trust=$(git -C "$repo" log --format=%H --grep="reviewer trust list" -1)
    echo "approval: SIMULATED (the fixture's reviewer key on this machine; not a real person's approval)" >> "$out/approved/approval.txt"
    vcv review approve "$repo" chg-quiet-rejections --digest "$digest" --key "$keys/reviewer.pem" --trust-commit "$trust" 2>&1 | scrub >> "$out/approved/approval.txt"
  fi
  # The approval must have produced a new approved revision whose history verifies against main.
  local after; after=$(revision)
  [ "$after" != "$before" ] || die "approved: the approved revision did not move ($before)"
  vcv integrity "$repo" --base "$main" --trust-ref "$main" --require-attestation > "$out/approved/integrity.txt" 2>&1 || die "approved: integrity: $(head -3 "$out/approved/integrity.txt")"
  scrub < "$out/approved/integrity.txt" > "$out/approved/integrity.tmp" && mv "$out/approved/integrity.tmp" "$out/approved/integrity.txt"
  commit "vcv: approve chg-quiet-rejections"
  # The tests were renamed with the approved intent: the agent reasserts their mappings.
  {
    reassert test.rejection.unit "$spec#test:EnrollmentService > rejects an enrollment into a full course without notifying the student" "asserts COURSE_FULL and no notification, per the approved revision"
    reassert test.rejection.e2e "$e2e#test:Course Desk API (e2e) > confirms, then rejects when full; only the confirmed student is notified" "over HTTP: the rejected student has no notifications"
    reassert test.confirmation.e2e "$e2e#test:Course Desk API (e2e) > confirms, then rejects when full; only the confirmed student is notified" "over HTTP: the confirmed student has exactly one enrollment-confirmed notification"
    reassert test.rul-seat-limit "$spec#test:EnrollmentService > rejects an enrollment into a full course without notifying the student" "the unit test for a full course, renamed"
    # The enroll() claims went stale with the code change; the agent re-reads and refreshes them.
    reassert impl.rul-announce-every-decision "$svc#symbol:EnrollmentService.enroll" "enroll() notifies only a confirmed decision, as the approved revision says"
    reassert impl.cap-enroll "$svc#symbol:EnrollmentService.enroll" "enroll() still records and returns every decision"
    reassert impl.rul-seat-limit "$svc#symbol:EnrollmentService.enroll" "the seat check in enroll() is unchanged"
  } | scrub | tee "$out/approved/reassert.txt"
  commit "Reassert the renamed tests' mappings"
  ci approved; expect approved 0
  git -C "$repo" log --format='%h %s' "$main"..HEAD > "$out/approved/branch-log.txt"
}

step_negatives() {
  echo "== negatives"
  local n="$out/negatives"; mkdir -p "$n"
  : > "$n/summary.txt"
  gate() { "$vcv_home/scripts/vcv-premerge-gate.sh" "$vcv_home" "$repo" "$main" --policy-at-base .github/vcv-policy.json "$@"; }
  # neg <label> <output file> <expected exit> <pattern>...: record the case and check that the gate
  # exited as expected and its output shows every pattern (the reason, not just "nonzero").
  neg() {
    local label=$1 f=$2 want=$3 code; shift 3
    code=$(cat "$f.code"); rm "$f.code"
    printf '%-58s %s\n' "$label" "exit $code: $(sed -n 1p "$f")" >> "$n/summary.txt"
    if [ "$code" != "$want" ]; then echo "  UNEXPECTED: $label: exit $code, expected $want"; failures=$((failures + 1)); return; fi
    local p; for p in "$@"; do
      grep -qE -- "$p" "$f" || { echo "  UNEXPECTED: $label: no \"$p\""; failures=$((failures + 1)); }
    done
  }
  # run_gate <output file> <gate options...>: the gate's exit code is the result.
  run_gate() { local f=$1 code=0; shift; gate "$@" > "$f" 2>&1 || code=$?; echo "$code" > "$f.code"; }
  # fresh_run <name>: the identity first (no candidate code has run), then this candidate's own tests
  # into a report that did not exist before.
  fresh_run() {
    local id; id=$(vcv tests identity "$repo" --json | json identityDigest)
    [[ $id =~ ^[0-9a-f]{64}$ ]] || die "negatives: no identity"
    rm -f "$n/$1-junit.xml"
    (cd "$repo/server" && npx vitest run --reporter=junit --outputFile="$n/$1-junit.xml" > /dev/null 2>&1) || true
    [ -s "$n/$1-junit.xml" ] || die "negatives: case $1: the runner wrote no report"
    echo "$id"
  }

  # 1. The broken candidate ships its own passing record, captured by the agent.
  branch negative/broken-with-records code-first/quiet-rejections~1 # the broken commit
  VCV_HOST_PRINCIPAL=agent:coder VCV_HOST_PERMISSIONS=model:propose vcv tests capture "$repo" --junit "$out/main/junit.xml" --root server --runner vitest --invocation "npx vitest run (claimed by the agent)" --out "$n/agent-record.json" > /dev/null
  run_gate "$n/1-agent-record.txt" --run "$n/agent-record.json"
  neg "1 broken code + agent-supplied passing record" "$n/1-agent-record.txt" 1 "BLOCK RESULT_CLAIMED" "BLOCK EVIDENCE_REQUIRED"

  # 2. The same record relabelled as host-observed.
  node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1]));r.observedBy="host";fs.writeFileSync(process.argv[2],JSON.stringify(r))' "$n/agent-record.json" "$n/relabelled-record.json"
  run_gate "$n/2-relabelled.txt" --run "$n/relabelled-record.json"
  neg "2 relabelled record (observedBy: host)" "$n/2-relabelled.txt" 2 "RUN_INVALID"

  # 3. main's green report, presented as this candidate's run with main's identity.
  local mainid; mainid=$(json identityDigest < "$out/main/identity.json")
  run_gate "$n/3-report-from-main.txt" --junit "$out/main/junit.xml" --root server --runner vitest --invocation "npx vitest run" --before "$mainid"
  neg "3 main's report with main's identity, on the broken commit" "$n/3-report-from-main.txt" 2 "TEST_RUN_RACED"
  # 4. The same report without a pre-run identity: it can only be a claim.
  run_gate "$n/4-report-unbound.txt" --junit "$out/main/junit.xml" --root server --runner vitest --invocation "npx vitest run"
  neg "4 main's report without a pre-run identity" "$n/4-report-unbound.txt" 1 "BLOCK RESULT_CLAIMED" "BLOCK EVIDENCE_REQUIRED"

  # 5. A silent model edit: the candidate rewrites the approved criterion in its revision file.
  branch negative/silent-model-edit
  local revfile; revfile=$(ls "$repo"/.vcv/revisions/rev-3-*.yaml)
  [ -f "$revfile" ] || die "negatives: no rev-3 revision file"
  edit "${revfile#$repo/}" "and the student receives exactly one enrollment-rejected notification for that enrollment" "and the student receives no notification for it"
  edit "$svc" "$QUIET_OLD" "$QUIET_NEW"
  commit "Quietly change the criterion and the code"
  run_gate "$n/5-silent-model-edit.txt"
  neg "5 revision file edited in place (no proposal, no approval)" "$n/5-silent-model-edit.txt" 1 "PROJECT_NOT_READY"

  # 6. The candidate relaxes the policy file it carries; the base's policy still applies.
  branch negative/relaxed-policy
  edit "$svc" "$QUIET_OLD" "$QUIET_NEW"
  printf '{ "format": "vcv-policy-1", "observations": { "contradiction": "warn" }, "requireEvidence": [] }\n' > "$repo/.github/vcv-policy.json"
  commit "Relax the gate policy and stop announcing rejections"
  local id6; id6=$(fresh_run 6)
  run_gate "$n/6-relaxed-policy.txt" --junit "$n/6-junit.xml" --root server --runner vitest --invocation "npx vitest run" --before "$id6"
  neg "6 candidate relaxes .github/vcv-policy.json" "$n/6-relaxed-policy.txt" 1 "BLOCK TEST_FAILED" "BLOCK EVIDENCE_REQUIRED" "warn +POLICY_CHANGED"

  # 7. A pending proposal with the code change, before any approval (the intent step).
  [ -s "$out/intent/exit-code" ] || die "negatives: case 7 needs the intent step"
  cp "$out/intent/gate.txt" "$n/7-intent-pending.txt"; cp "$out/intent/exit-code" "$n/7-intent-pending.txt.code"
  neg "7 intended change, proposal pending (see intent/)" "$n/7-intent-pending.txt" 1 "BLOCK TEST_NOT_RUN" "BLOCK EVIDENCE_REQUIRED" "warn +PROPOSAL_PENDING"

  # 8. The intended change WITHOUT the model change: code and tests changed, the agent re-points
  #    the required criterion's mappings at the new (opposite) tests, no proposal, no approval.
  branch negative/remap-without-approval
  local intent; intent=$(git -C "$repo" log --format=%H --grep="propose the model change" -1 model-first/quiet-rejections)
  [ -n "$intent" ] || die "negatives: case 8 needs the intent commit"
  git -C "$repo" checkout -q "$intent" -- server # the intent step's code and tests, without its proposal
  commit "Stop announcing rejected enrollments (no model change)"
  {
    reassert test.rejection.unit "$spec#test:EnrollmentService > rejects an enrollment into a full course without notifying the student" "renamed"
    reassert test.rejection.e2e "$e2e#test:Course Desk API (e2e) > confirms, then rejects when full; only the confirmed student is notified" "renamed"
    reassert test.confirmation.e2e "$e2e#test:Course Desk API (e2e) > confirms, then rejects when full; only the confirmed student is notified" "renamed"
  } > "$n/8-reassert.txt"
  commit "Reassert the mappings"
  local id8; id8=$(fresh_run 8)
  run_gate "$n/8-remap-without-approval.txt" --junit "$n/8-junit.xml" --root server --runner vitest --invocation "npx vitest run" --before "$id8"
  # The documented limit: it passes, with MAPPING_CHANGED for the PR reviewer to judge.
  neg "8 behaviour change + remapped tests, no model change" "$n/8-remap-without-approval.txt" 0 "^vcv gate: WARN" "2/2 required criteria passed" "warn +MAPPING_CHANGED"

  for f in "$n"/*.txt; do scrub < "$f" > "$f.tmp" && mv "$f.tmp" "$f"; done
  cat "$n/summary.txt"
}

step_merge() {
  echo "== merge: old base, candidate and a simulated merge, without regeneration"
  local m="$out/merge"; mkdir -p "$m"
  local cand=code-first/quiet-rejections
  git -C "$repo" rev-parse -q --verify "$cand^{commit}" > /dev/null || die "merge: no $cand (run broken and fixed first)"
  # view <label>: the model as this checkout loads it, and its history checked against main.
  view() {
    echo "-- $1 ($(git -C "$repo" rev-parse --short HEAD))"
    vcv project status "$repo" | scrub
    local r; r=$(vcv integrity "$repo" --base "$main" --trust-ref "$main" --require-attestation 2>&1) || die "merge: integrity failed on $1: $r"
    printf '%s\n' "$r" | sed -n 1,3p | scrub
  }
  {
    git -C "$repo" checkout -q main; view main; local base_rev; base_rev=$(revision)
    git -C "$repo" checkout -q "$cand"; view "$cand"; local cand_rev; cand_rev=$(revision)
    git -C "$repo" checkout -q -B simulated-merge "$main"
    git -C "$repo" merge -q --no-ff -m "Merge $cand" "$cand"
    [ "$(git -C "$repo" rev-parse HEAD^2)" = "$(git -C "$repo" rev-parse "$cand")" ] || die "merge: HEAD is not a merge of $cand"
    view "simulated merge of $cand into main"
    local merged_rev; merged_rev=$(revision)
    [ "$merged_rev" = "$cand_rev" ] || die "merge: the merged model is $merged_rev, the candidate's $cand_rev"
    [ "$merged_rev" = "$base_rev" ] || die "merge: a code-first fix moved the model ($base_rev -> $merged_rev)"
    echo "-- .vcv/ differences between main and the merge (none expected for a code-first fix)"
    git -C "$repo" diff --quiet "$main" HEAD -- .vcv || die "merge: .vcv/ differs between main and the merge"
    echo "(none)"
    echo "-- source differences between the candidate and the merge (none expected)"
    git -C "$repo" diff --quiet "$cand" HEAD || die "merge: the merged tree differs from the candidate"
    echo "(none)"
  } > "$m/views.txt"
  cat "$m/views.txt"
  git -C "$repo" checkout -q main
}

steps=("$@")
[ ${#steps[@]} -gt 0 ] || steps=(main broken explained fixed stale-report harmless weak-evidence intent approved negatives merge)
for s in "${steps[@]}"; do "step_${s//-/_}"; done
git -C "$repo" checkout -q main
echo "scenarios: $failures unexpected result(s)"
[ "$failures" = 0 ] || exit 1
