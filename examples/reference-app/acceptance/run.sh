#!/usr/bin/env bash
# The M5.7 acceptance walkthrough on the real Course Desk (Issue #46), end to end.
#
#   examples/reference-app/acceptance/setup.sh <work-dir>
#   examples/reference-app/acceptance/run.sh   <work-dir> <out-dir>
#
# Who does what (each in its own process and, for the agent, its own clone):
#   owner     the explorer (walkthrough.ts) on <work>/course-desk: explore, draft, hand off, review
#   agent     agent.sh in <work>/agent/course-desk as agent:coder: integrate, submit, implement, claims
#   reviewer  reviewer.sh with the fixture key in <work>/reviewer: TEST-ONLY approval
#   host      premerge/ci.sh (identity, the app's own tests, the gate) against the test base
#
# Every step must succeed; the first one that does not stops the run with exit 3 and no summary.
# The gate's verdicts are results, each compared with what the step expects.
set -Eeuo pipefail
trap 'echo "run.sh: FAILED at line $LINENO: $BASH_COMMAND" >&2; exit 3' ERR
die() { echo "run.sh: FAILED: $*" >&2; exit 3; }
work=$(cd "${1:?usage: run.sh <work-dir> <out-dir>}" && pwd)
mkdir -p "${2:?usage: run.sh <work-dir> <out-dir>}"
out=$(cd "$2" && pwd)
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[ -s "$work/main.sha" ] || die "run setup.sh first"
base=$(cat "$work/main.sha")
CHANGE=chg-full-course-notice
ui() { node --experimental-strip-types --no-warnings "$here/walkthrough.ts" "$1" "$work" "$out"; }
gate() { # gate <step> <expected exit> <expected reason code>
  local step=$1 want=$2 code=$3 got
  bash "$vcv_home/examples/reference-app/premerge/ci.sh" "$work" "$out/gate/$step" > /dev/null || true
  [ -s "$out/gate/$step/exit-code" ] || die "$step: no gate exit code (a setup error, not a result)"
  got=$(cat "$out/gate/$step/exit-code")
  [ "$got" = "$want" ] || die "$step: gate exit $got, expected $want"
  grep -q "$code" "$out/gate/$step/gate.txt" || die "$step: gate output lacks $code"
  echo "  gate $step: exit $got as expected; $(head -1 "$out/gate/$step/gate.txt")"
}
owner_sync() { git -C "$repo" merge -q --ff-only agent/full-course-notice; }

if [ "${NO_BUILD:-}" != 1 ]; then (cd "$vcv_home" && npm run -s build -w @vcv/ui > /dev/null); fi
mkdir -p "$out/review" "$out/integrity"

echo "== 0. the protected test base passes its own gate"
gate 0-base 0 "PASS"

echo "== 1. owner: explore, stage a draft, restart, recover and hand it off (browser)"
ui explore
ui draft
ui recover

echo "== 2. agent: integrate the handoff with its own draft and submit one fresh proposal"
bash "$here/agent.sh" "$work" "$out" integrate
git -C "$repo" checkout -q -B feature/full-course-notice agent/full-course-notice
vcv proposal preview "$repo" "$CHANGE" | scrub > "$out/review/preview.txt"
vcv proposal preview "$repo" "$CHANGE" --json | json data.proposal.proposalDigest > "$out/agent/digest.txt"
echo "  digest $(cat "$out/agent/digest.txt")"

echo "== 3. owner: the inbox shows the same digest and what is unverified (browser)"
ui inbox

echo "== 4. reviewer (TEST-ONLY fixture key, separate process) approves while the pages are open"
ui approve
bash "$here/reviewer.sh" "$work" verify > "$out/integrity/test-anchor.txt"
head -1 "$out/integrity/test-anchor.txt"
# The same history against the real repository's trust anchor (the owner's key only) must fail:
# a fixture signature is not the owner's approval.
code=0
vcv integrity "$repo" --trust-commit "$(cat "$work/upstream.sha")" --require-attestation > "$out/integrity/owner-anchor.txt" 2>&1 || code=$?
scrub < "$out/integrity/owner-anchor.txt" > "$out/integrity/owner-anchor.scrubbed" && mv "$out/integrity/owner-anchor.scrubbed" "$out/integrity/owner-anchor.txt"
[ "$code" = 1 ] || die "integrity against the owner's trust anchor exited $code, expected 1"
echo "  against the owner's real trust anchor: $(head -1 "$out/integrity/owner-anchor.txt") (expected)"

echo "== 5. host: the gate on the approved but unimplemented branch (the discrepancy)"
gate 1-approved 1 "CRITERION_STALE"

echo "== 6. agent: implement from the handoff; the host gates it before the claims are updated"
bash "$here/agent.sh" "$work" "$out" implement
owner_sync
gate 2-implemented-claims-stale 1 "TEST_NOT_RUN"

echo "== 7. agent: reassert the moved claims and record its report; the host gates it again"
bash "$here/agent.sh" "$work" "$out" claims
owner_sync
gate 3-implemented 0 "PASS\|WARN"
vcv tests capture "$repo" --junit "$out/gate/3-implemented/junit.xml" --root server --runner vitest \
  --invocation "npx vitest run (premerge/ci.sh)" --out "$out/gate/3-implemented/test-run.json" > /dev/null
vcv implementation show "$repo" "$CHANGE" | scrub > "$out/agent/implementation-show.txt"
vcv reconcile "$repo" --base "$base" --trust-commit "$base" --require-attestation | scrub > "$out/gate/3-implemented/reconcile.txt"

echo "== 8. owner: implementation, evidence and the pre-merge page (browser)"
git -C "$repo" show "$base:.github/vcv-policy.json" > "$out/gate/base-policy.json"
ui evidence

echo "== 9. owner: empty, invalid and conflicted copies of the checkout (browser)"
states="$work/states"
rm -rf "$states"; mkdir -p "$states"
git init -q "$states/empty"
git clone -q --branch test-base "$repo" "$states/invalid"
rev=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).revision)' "$states/invalid/.vcv/HEAD")
printf 'not: [a model\n' > "$states/invalid/.vcv/revisions/$rev.yaml"
git clone -q --branch test-base "$repo" "$states/conflicted"
git -C "$states/conflicted" checkout -q -b competing
sed -i "s/\"revision\": \"$rev\"/\"revision\": \"$rev\" /" "$states/conflicted/.vcv/HEAD"
git -C "$states/conflicted" commit -qam "a competing edit of .vcv/HEAD"
git -C "$states/conflicted" fetch -q origin feature/full-course-notice
if git -C "$states/conflicted" merge -q FETCH_HEAD > /dev/null 2>&1; then die "the conflicted copy merged cleanly"; fi
ui states

{
  echo "M5.7 acceptance walkthrough: all steps ran and every verdict matched its expectation."
  echo "test base: $base (TEST ONLY: adds $FIXTURE_REVIEWER to the owner's trust list; never pushed)"
  echo "upstream:  $(cat "$work/upstream.sha") (TheBluemist1404/course-desk main, rev-4, approved by user:hoang)"
  echo "branch:    feature/full-course-notice"
  git -C "$repo" log --format='  %h %an: %s' "$base"..HEAD
  for s in 0-base 1-approved 2-implemented-claims-stale 3-implemented; do echo "gate $s: $(head -1 "$out/gate/$s/gate.txt")"; done
} | tee "$out/summary.txt"
