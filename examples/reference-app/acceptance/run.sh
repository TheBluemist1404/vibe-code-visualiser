#!/usr/bin/env bash
# The M5.7 acceptance walkthrough on the real Course Desk (Issue #46), end to end.
#
#   sudo env PATH="$PATH" examples/reference-app/acceptance/setup.sh <work-dir>
#   sudo env PATH="$PATH" examples/reference-app/acceptance/run.sh   <work-dir> <new-out-dir>
#
# Runs as root only to start each context as its OS user (common.sh); it runs no step itself.
#   owner     walkthrough.ts (the explorer in Chromium) and the owner's Git, as $WS_USER
#   agent     agent.sh in <work>/ws/agent/course-desk as agent:coder, as $WS_USER
#   host      premerge/ci.sh (identity, the app's own tests, the gate), as $WS_USER
#   reviewer  reviewer.sh with the fixture key, in its own clone, as $RV_USER (TEST ONLY)
# $WS_USER cannot open the fixture key; this is checked here, in agent.sh and in every browser phase.
# Root never opens, writes or removes a file in the workspace (<work>/ws) or the output directory:
# every such access goes through W (the workspace user). The trust anchor the reviewer signs against
# was pinned by the reviewer at setup in <work>/reviewer, which the workspace cannot modify.
#
# <new-out-dir> must not exist: nothing from an earlier run can stand in for this one. Every step
# must succeed; the first one that does not stops the run with exit 3 and no summary. A gate verdict
# (exit 0 pass or warn, 1 block) is a result and is compared with what the step expects; any other
# exit, or a missing verdict, is an execution error and stops the run.
set -Eeuo pipefail
trap 'echo "run.sh: FAILED at line $LINENO: $BASH_COMMAND" >&2; exit 3' ERR
die() { echo "run.sh: FAILED: $*" >&2; exit 3; }
[ "$(id -u)" = 0 ] || die "run as root (see the usage above): each context starts as its own OS user"
work=$(cd "${1:?usage: run.sh <work-dir> <new-out-dir>}" && pwd)
outArg=${2:?usage: run.sh <work-dir> <new-out-dir>}
[ ! -e "$outArg" ] || die "$outArg exists; give a new output directory"
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[ -s "$anchor_file" ] || die "run setup.sh first"
install -d -o "$WS_USER" -g "$WS_USER" -m 0755 "$outArg"
out=$(cd "$outArg" && pwd)
CHANGE=chg-full-course-notice
W() { as "$WS_USER" "$@"; }                       # the workspace user
Wvcv() { W node --experimental-strip-types --no-warnings "$vcv_home/apps/cli/src/main.ts" "$@"; }
Wgit() {
  W env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$here/gitconfig" \
    GIT_AUTHOR_NAME="$GIT_AUTHOR_NAME" GIT_AUTHOR_EMAIL="$GIT_AUTHOR_EMAIL" GIT_COMMITTER_NAME="$GIT_COMMITTER_NAME" \
    GIT_COMMITTER_EMAIL="$GIT_COMMITTER_EMAIL" git "$@"
}
R() { as "$RV_USER" "$@"; }                       # the fixture reviewer
ui() { W node --experimental-strip-types --no-warnings "$here/walkthrough.ts" "$1" "$ws" "$out"; }
base=$(W cat "$ws/main.sha"); upstream=$(R cat "$work/reviewer/upstream.sha")
[ "$base" = "$(R cat "$anchor_file")" ] || die "the workspace's test base differs from the anchor the reviewer pinned"
gate() { # gate <step> <expected exit 0|1> <expected reason code>
  local step=$1 want=$2 code=$3 rc=0 got
  ! W test -e "$out/gate/$step" || die "$step: $out/gate/$step already exists"
  W bash "$vcv_home/examples/reference-app/premerge/ci.sh" "$ws" "$out/gate/$step" > /dev/null || rc=$?
  case "$rc" in 0 | 1) ;; *) die "$step: the gate did not run to a verdict (exit $rc; see $out/gate/$step)" ;; esac
  W test -s "$out/gate/$step/exit-code" || die "$step: no verdict written (an execution error, not a result)"
  got=$(W cat "$out/gate/$step/exit-code")
  [ "$got" = "$rc" ] || die "$step: the verdict file says $got, the gate exited $rc"
  [ "$got" = "$want" ] || die "$step: gate exit $got, expected $want"
  W grep -q "$code" "$out/gate/$step/gate.txt" || die "$step: gate output lacks $code"
  echo "  gate $step: exit $got as expected; $(W head -1 "$out/gate/$step/gate.txt")"
}
owner_sync() { Wgit -C "$repo" fetch -q "$1" "$2" && Wgit -C "$repo" merge -q --ff-only FETCH_HEAD; }

if [ "${NO_BUILD:-}" != 1 ]; then (cd "$vcv_home" && npm run -s build -w @vcv/ui > /dev/null); fi
W mkdir -p "$out/review" "$out/integrity"

echo "== the fixture key is out of the workspace's reach"
{
  echo "workspace: $(W id)"
  echo "reviewer:  $(R id)"
  echo "key dir:   $(stat -c '%A %U:%G' "$keys")  key file: $(stat -c '%A %U:%G' "$key_file")"
  code=0; W cat "$key_file" > /dev/null 2>&1 || code=$?
  [ "$code" != 0 ] || die "the workspace user can read the fixture key"
  echo "workspace reads the key: refused ($(W cat "$key_file" 2>&1 | sed "s|$work|<work>|g" || true))"
  code=0; W sudo -n true > /dev/null 2>&1 || code=$?
  [ "$code" != 0 ] || die "the workspace user has sudo"
  echo "workspace sudo: refused (exit $code)"
  R test -r "$key_file" || die "the reviewer cannot read its own key"
  echo "reviewer reads the key: yes"
} | W tee "$out/integrity/key-isolation.txt"

echo "== 0. the protected test base passes its own gate"
gate 0-base 0 "PASS"

echo "== 1. owner: explore, stage a draft, restart, recover and hand it off (browser)"
ui explore
ui draft
ui recover

echo "== 2. agent: integrate the handoff with its own draft and submit one fresh proposal"
W bash "$here/agent.sh" "$work" "$out" integrate
Wgit -C "$repo" fetch -q "$agent_repo" agent/full-course-notice
Wgit -C "$repo" checkout -q -B feature/full-course-notice FETCH_HEAD
Wvcv proposal preview "$repo" "$CHANGE" | scrub | W tee "$out/review/preview.txt" > /dev/null
digest=$(Wvcv proposal preview "$repo" "$CHANGE" --json | json data.proposal.proposalDigest)
echo "$digest" | W tee "$out/agent/digest.txt" > /dev/null
echo "  digest $digest"

echo "== 3. owner: the inbox shows the same digest and what is unverified (browser)"
ui inbox

echo "== 4. reviewer (TEST-ONLY fixture key, its own OS user and clone) approves while the pages are open"
ui approve &
browser=$!
for _ in $(seq 1 240); do W test -e "$out/ui/approve.ready" && break; kill -0 "$browser" 2> /dev/null || break; sleep 0.5; done
W test -e "$out/ui/approve.ready" || die "the approve phase did not open its pages"
R bash "$here/reviewer.sh" "$work" approve "$CHANGE" "$digest" | W tee "$out/review/approval.txt"
owner_sync "$reviewer_repo" feature/full-course-notice
wait "$browser" || die "the approve phase failed"
R bash "$here/reviewer.sh" "$work" verify | W tee "$out/integrity/test-anchor.txt" > /dev/null
W head -1 "$out/integrity/test-anchor.txt"
# The same history against the real repository's trust anchor (the owner's key only) must fail, and
# for the right reason: the fixture key is not trusted there. A fixture signature is not the owner's.
code=0; res=$(Wvcv integrity "$repo" --trust-commit "$upstream" --require-attestation 2>&1) || code=$?
printf '%s\n' "$res" | scrub | W tee "$out/integrity/owner-anchor.txt" > /dev/null
[ "$code" = 1 ] || die "integrity against the owner's trust anchor exited $code, expected 1"
W grep -q "APPROVAL_NOT_ATTESTED: rev-5-[0-9a-f]* (change $CHANGE): approval untrusted-key: key [0-9a-f]* is not listed for $FIXTURE_REVIEWER" "$out/integrity/owner-anchor.txt" ||
  die "integrity against the owner's anchor failed, but not with the untrusted fixture key"
[ "$(W grep -c '✗' "$out/integrity/owner-anchor.txt")" = 1 ] || die "integrity against the owner's anchor reports other errors too"
echo "  against the owner's real trust anchor: FAILED, APPROVAL_NOT_ATTESTED untrusted-key for $FIXTURE_REVIEWER (expected)"

echo "== 5. host: the gate on the approved but unimplemented branch (the discrepancy)"
gate 1-approved 1 "CRITERION_STALE"

echo "== 6. agent: implement from the handoff; the host gates it before the claims are updated"
W bash "$here/agent.sh" "$work" "$out" implement
owner_sync "$agent_repo" agent/full-course-notice
gate 2-implemented-claims-stale 1 "TEST_NOT_RUN"

echo "== 7. agent: reassert the moved claims and record its report; the host gates it again"
W bash "$here/agent.sh" "$work" "$out" claims
owner_sync "$agent_repo" agent/full-course-notice
gate 3-implemented 0 "PASS\|WARN"
Wvcv tests capture "$repo" --junit "$out/gate/3-implemented/junit.xml" --root server --runner vitest \
  --invocation "npx vitest run (premerge/ci.sh)" --out "$out/gate/3-implemented/test-run.json" > /dev/null
Wvcv implementation show "$repo" "$CHANGE" | scrub | W tee "$out/agent/implementation-show.txt" > /dev/null
Wvcv reconcile "$repo" --base "$base" --trust-commit "$base" --require-attestation | scrub | W tee "$out/gate/3-implemented/reconcile.txt" > /dev/null

echo "== 8. owner: implementation, evidence and the pre-merge page (browser)"
Wgit -C "$repo" show "$base:.github/vcv-policy.json" | W tee "$out/gate/base-policy.json" > /dev/null
ui evidence

echo "== 9. owner: empty, invalid and conflicted copies of the checkout (browser)"
states="$ws/states"
W rm -rf "$states"; W mkdir -p "$states"
Wgit init -q "$states/empty"
Wgit clone -q --branch test-base "$repo" "$states/invalid"
rev=$(W node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).revision)' "$states/invalid/.vcv/HEAD")
W sh -c "printf 'not: [a model\n' > '$states/invalid/.vcv/revisions/$rev.yaml'"
Wgit clone -q --branch test-base "$repo" "$states/conflicted"
Wgit -C "$states/conflicted" checkout -q -b competing
W sed -i "s/\"revision\": \"$rev\"/\"revision\": \"$rev\" /" "$states/conflicted/.vcv/HEAD"
Wgit -C "$states/conflicted" commit -qam "a competing edit of .vcv/HEAD"
Wgit -C "$states/conflicted" fetch -q origin feature/full-course-notice
if Wgit -C "$states/conflicted" merge -q FETCH_HEAD > /dev/null 2>&1; then die "the conflicted copy merged cleanly"; fi
ui states

{
  echo "M5.7 acceptance walkthrough: all steps ran and every verdict matched its expectation."
  echo "test base: $base (TEST ONLY: adds $FIXTURE_REVIEWER to the owner's trust list; never pushed)"
  echo "upstream:  $upstream (TheBluemist1404/course-desk main, rev-4, approved by user:hoang)"
  echo "users:     workspace $WS_USER (explorer, agent, gate); reviewer $RV_USER (the only one that can open the key)"
  echo "branch:    feature/full-course-notice"
  Wgit -C "$repo" log --format='  %h %an: %s' "$base"..HEAD
  for s in 0-base 1-approved 2-implemented-claims-stale 3-implemented; do echo "gate $s: $(W head -1 "$out/gate/$s/gate.txt")"; done
} | W tee "$out/summary.txt"
