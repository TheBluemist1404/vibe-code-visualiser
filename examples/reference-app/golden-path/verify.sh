#!/usr/bin/env bash
# Golden path, step 6 (Issue #17, M3.4): what the branch now holds, and the negative paths.
#
#   examples/reference-app/golden-path/verify.sh <work-dir> <out-dir>
#
# Read-only for the checkout (everything that mutates runs in throwaway clones under <work>):
#  - the host authorization gate (scripts/vcv-host-gate.sh: trusted CLI, candidate as data, base
#    and trust list from main's commit) on the feature branch;
#  - the model each checkout sees: the approved revision on the feature branch, the old one on
#    main, and the new one after a simulated local merge, without regenerating anything;
#  - the evidence and the implementation report as VCV recomputes them now;
#  - the negative paths, each with its expected outcome (the script fails if one does not hold).
set -euo pipefail
work=$(cd "${1:?usage: verify.sh <work-dir> <out-dir>}" && pwd)
out=$(cd "${2:?}" && pwd)
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
id=$(cat "$work/change.id")
main=$(cat "$work/main.sha")
o="$out/4-verify"; mkdir -p "$o"
rev() { vcv project status "$1" --json | json model.revision; }

echo "== host authorization gate on the feature branch"
"$vcv_home/scripts/vcv-host-gate.sh" "$vcv_home" "$repo" "$main" 2>&1 | scrub | tee "$o/host-gate.txt"

echo "== the model each checkout sees (.vcv/ in Git is the source of truth)"
rm -rf "$work/view-main" "$work/view-merged"
git clone -q -b main "$repo" "$work/view-main"
git clone -q -b main "$repo" "$work/view-merged"
git -C "$work/view-merged" fetch -q origin "$BRANCH"
git -C "$work/view-merged" merge -q --no-ff -m "simulated local merge of $BRANCH" FETCH_HEAD
{
  echo "feature branch ($BRANCH): $(rev "$repo")"
  echo "main:                       $(rev "$work/view-main")"
  echo "main after a simulated local merge (no model regeneration): $(rev "$work/view-merged")"
  echo
  echo "\$ vcv project status <feature>"; vcv project status "$repo"
  echo "\$ vcv project status <main>"; vcv project status "$work/view-main"
  echo "\$ vcv project status <merged>"; vcv project status "$work/view-merged"
  echo "\$ vcv integrity <merged> --base <old main> --trust-ref <old main> --trust-commit <old main> --require-attestation"
  vcv integrity "$work/view-merged" --base "$main" --trust-ref "$main" --trust-commit "$main" --require-attestation
} 2>&1 | scrub | tee "$o/branch-views.txt"
[ "$(rev "$repo")" = "$(rev "$work/view-merged")" ] && [ "$(rev "$repo")" != "$(rev "$work/view-main")" ]
vcv proposal list "$repo" | scrub > "$o/proposal-list.txt"
vcv evidence "$repo" refresh | scrub > "$o/evidence-refresh.json"
vcv implementation show "$repo" "$id" 2>&1 | scrub > "$o/implementation-show.txt"
vcv implementation show "$repo" "$id" --json | scrub > "$o/implementation-show.json"
git -C "$repo" log --format='%h %an: %s' HEAD | scrub > "$o/git-log.txt"

echo "== negative paths (each in a throwaway clone)"
neg="$o/negative-paths.md"
: > "$neg"
fails=0
# [want=<regex>] check <expect ok|fail> <title> <dir> <command...>: run in <dir>, record, and
# compare the outcome (and, with want, that the output names the expected reason).
check() {
  local expect=$1 title=$2 dir=$3; shift 3
  local output status=0
  output=$(cd "$dir" && "$@" 2>&1) || status=$?
  local got=ok; [ $status -ne 0 ] && got=fail
  local mark="as expected"
  if [ "$got" != "$expect" ] || { [ -n "${want:-}" ] && ! grep -qE -e "$want" <<<"$output"; }; then mark="UNEXPECTED"; fails=$((fails + 1)); fi
  { echo "### $title"; echo; echo "expected: $expect${want:+ with /$want/}, got: $got (exit $status), $mark"; echo; echo '```'; printf '%s\n' "$output" | scrub | head -40; echo '```'; echo; } >> "$neg"
}
clone() { rm -rf "$work/neg-$1"; git clone -q -b "$BRANCH" "$repo" "$work/neg-$1"; git -C "$work/neg-$1" branch -q main origin/main 2>/dev/null || true; echo "$work/neg-$1"; }
model_hash() { (cd "$1/.vcv" && cat HEAD revisions/* | sha256sum); }
P() { VCV_HOST_PRINCIPAL=agent:proposer VCV_HOST_PERMISSIONS=model:propose vcv "$@"; }
cur=$(rev "$repo")
mkchange() { # mkchange <file> <changeId> <expectedRevision> <operation yaml>
  printf 'changeId: %s\nprojectId: prj-course-desk\nexpectedRevision: %s\nrationale: negative-path test\noperations:\n  - %s\n' "$2" "$3" "$4" > "$1"
}

d=$(clone agent); h=$(model_hash "$d")
mkchange "$work/apply.yaml" chg-neg-apply "$cur" "{ type: setRuleStatement, ruleId: rul-recipient-required, statement: Listing notifications requires a recipientId. }"
want="pending" check ok "a model:apply shortcut through the legacy propose command only records a pending change" "$d" P propose .vcv "$work/apply.yaml"
check ok "  … and .vcv/HEAD and the revisions did not move" "$d" test "$(model_hash "$d")" = "$h"
want="NOT_AUTHORIZED" check fail "the proposer cannot approve a pending change (vcv approve as agent:proposer)" "$d" P approve .vcv chg-neg-apply
want="--as and --perm are not accepted" check fail "the proposer cannot pass --as/--perm under a host identity" "$d" P approve .vcv chg-neg-apply --as user:reviewer --perm approve
want="refuses to run under VCV_HOST" check fail "review approve refuses to run under an agent host identity" "$d" P review approve . chg-neg-apply --digest "$(printf '0%.0s' {1..64})" --key "$keys/reviewer.pem" --trust-commit "$main"
mkchange "$work/stale.yaml" chg-neg-stale "rev-1" "{ type: setRuleStatement, ruleId: rul-recipient-required, statement: x. }"
want="STALE|stale|expectedRevision" check fail "a stale expectedRevision is rejected" "$d" P proposal submit . "$work/stale.yaml"
mkchange "$work/missing.yaml" chg-neg-missing "$cur" "{ type: setRuleStatement, ruleId: rul-does-not-exist, statement: x. }"
want="rejected" check fail "an operation on a missing reference is rejected" "$d" P proposal submit . "$work/missing.yaml"
mkchange "$work/invalid.yaml" chg-neg-invalid "$cur" "{ type: removeObject, objectId: mod-notifications }"
want="rejected" check fail "a change that violates an invariant (removing a module still referenced) is rejected" "$d" P proposal submit . "$work/invalid.yaml"
cp "$work/apply.yaml" "$work/replay.yaml"; sed -i "s/chg-neg-apply/$id/" "$work/replay.yaml"
want="DUPLICATE_CHANGE" check fail "a replayed change ID is refused" "$d" P proposal submit . "$work/replay.yaml"
check ok "rejected and pending proposals left .vcv/HEAD and the revisions unchanged" "$d" test "$(model_hash "$d")" = "$h"

d=$(clone self)
mkchange "$work/self.yaml" chg-neg-self "$cur" "{ type: setRuleStatement, ruleId: rul-recipient-required, statement: Listing notifications requires a recipientId. }"
VCV_HOST_PRINCIPAL=user:reviewer VCV_HOST_PERMISSIONS=model:propose vcv proposal submit "$d" "$work/self.yaml" >/dev/null
dg=$(vcv proposal preview "$d" chg-neg-self --json | json data.proposal.proposalDigest)
want="SELF_APPROVAL" check fail "self-approval: the reviewer cannot approve a change they proposed" "$d" vcv review approve . chg-neg-self --digest "$dg" --key "$keys/reviewer.pem" --trust-commit "$main"
mkdir -p "$work/other-keys"; rm -f "$work/other-keys/mallory.pem"
vcv reviewer init "$work/other-keys/mallory.pem" --id user:mallory >/dev/null
mkchange "$work/unauth.yaml" chg-neg-unauth "$cur" "{ type: setRuleStatement, ruleId: rul-recipient-required, statement: Listing notifications requires a recipientId. }"
P proposal submit "$d" "$work/unauth.yaml" >/dev/null
dg=$(vcv proposal preview "$d" chg-neg-unauth --json | json data.proposal.proposalDigest)
want="UNTRUSTED_KEY" check fail "an unauthorized reviewer (key not in main's trust list) cannot approve" "$d" vcv review approve . chg-neg-unauth --digest "$dg" --key "$work/other-keys/mallory.pem" --trust-commit "$main"
want="DIGEST_MISMATCH" check fail "the right reviewer cannot approve content other than the digest they reviewed" "$d" vcv review approve . chg-neg-unauth --digest "$(printf 'f%.0s' {1..64})" --key "$keys/reviewer.pem" --trust-commit "$main"

d=$(clone head)
node -e '
  const fs=require("fs"), d=process.argv[1], h=JSON.parse(fs.readFileSync(d+"/.vcv/HEAD","utf8"));
  const text=fs.readFileSync(d+"/.vcv/revisions/"+h.revision+".yaml","utf8").split(h.revision).join("rev-4-handmade").replace("statement: ","statement: (no review) ");
  fs.writeFileSync(d+"/.vcv/revisions/rev-4-handmade.yaml",text); h.revision="rev-4-handmade"; h.history.push("rev-4-handmade");
  fs.writeFileSync(d+"/.vcv/HEAD",JSON.stringify(h,null,2)+"\n");' "$d"
git -C "$d" add -A; git -C "$d" commit -qm "hand-made revision and HEAD, no change record"
want="FAILED" check fail "a hand-made revision with a hand-edited .vcv/HEAD fails the host gate" "$d" "$vcv_home/scripts/vcv-host-gate.sh" "$vcv_home" "$d" "$main"
d=$(clone record)
node -e 'const f=process.argv[1],r=JSON.parse(require("fs").readFileSync(f,"utf8"));r.approverId="user:forged";require("fs").writeFileSync(f,JSON.stringify(r,null,2)+"\n")' "$d/.vcv/changes/$id.json"
git -C "$d" commit -qam "forge the approver"
want="FAILED" check fail "a forged applied change record fails the host gate" "$d" "$vcv_home/scripts/vcv-host-gate.sh" "$vcv_home" "$d" "$main"
d=$(clone revision)
last=$(json revision < "$d/.vcv/HEAD"); sed -i 's/statement: /statement: (edited) /' "$d/.vcv/revisions/$last.yaml"; git -C "$d" commit -qam "hand-edit the approved revision"
want="does not match its ID" check fail "a hand-edited approved revision fails the host gate" "$d" "$vcv_home/scripts/vcv-host-gate.sh" "$vcv_home" "$d" "$main"
d=$(clone attestation)
git -C "$d" rm -q ".vcv/approvals/$id.json"; git -C "$d" commit -qm "drop the attestation"
want="FAILED" check fail "an applied change without its attestation fails the host gate" "$d" "$vcv_home/scripts/vcv-host-gate.sh" "$vcv_home" "$d" "$main"

d=$(clone report)
I() { VCV_HOST_PRINCIPAL=agent:implementer VCV_HOST_PERMISSIONS=model:propose,binding:record vcv "$@"; }
node -e '
  const fs=require("fs"), r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")), c=r.agentClaims;
  const out={changeId:r.changeId,baseCommit:r.vcvObserved.baseCommit,handoffDigest:r.handoffDigest,confidence:"low",
    testsRun:[{command:"npm test",outcome:"failed",summary:"1 failing (simulated for the negative path)"}],
    acceptance:(r.approvedIntent.request?.acceptanceCriteria??[]).map((criterion,i)=>({criterion,status:i===0?"unknown":"met"}))};
  fs.writeFileSync(process.argv[2],JSON.stringify(out,null,2));' "$d/.vcv/implementations/$id.json" "$work/failed-report.json"
echo "unrelated" >> "$d/README.md"
dg=$(sha256sum "$d/.vcv/implementations/$id.json" | cut -d' ' -f1)
want="TEST_FAILED" check ok "a reported test failure is recorded as a warning, not a pass" "$d" I implementation record . --report "$work/failed-report.json" --expect "$dg"
want="OUT_OF_SCOPE: README.md" check ok "  … an edit outside the approved scope is a warning" "$d" vcv implementation show . "$id"
want="CRITERION_UNKNOWN" check ok "  … and a criterion the agent could not confirm is a warning" "$d" vcv implementation show . "$id"
want="REPORT_EXISTS" check fail "a second report without --expect is refused" "$d" I implementation record . --report "$work/failed-report.json"

grep -c "as expected" "$neg" | sed 's/$/ negative-path checks as expected/' | tee "$o/negative-summary.txt"
[ $fails -eq 0 ] || { echo "$fails negative-path checks did not hold (see $neg)" >&2; exit 1; }
