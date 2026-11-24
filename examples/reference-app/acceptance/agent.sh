#!/usr/bin/env bash
# The coding agent, in its own clone (<work>/agent/course-desk): a distinct working context with no
# reviewer key and no access to the explorer's state (Issue #46, M5.7).
#
#   agent.sh <work-dir> <out-dir> integrate   read the owner's exported handoff and the agent's own
#                                             draft, integrate them into one fresh typed proposal,
#                                             check it with the engine, submit it, try to approve it
#                                             (refused), push the branch to the owner's repository
#   agent.sh <work-dir> <out-dir> implement   after approval: read the handoff, change the code and
#                                             tests, run the app's own checks, commit, push
#   agent.sh <work-dir> <out-dir> claims      reassert the test mappings and code claims the change
#                                             moved, record the implementation report, commit, push
#
# The agent's decisions are this repository's recorded work (agent/: own-draft.json,
# integrate.mjs, implement.mjs, reassert.tsv, report.json), written by the Claude Code session that
# built M5.7 acting as agent:coder, and replayed here. VCV runs none of it: every VCV call below is
# the agent's, with an identity the host fixes (VCV_HOST_PRINCIPAL), so --as/--perm are refused.
set -Eeuo pipefail
trap 'echo "agent.sh: FAILED at line $LINENO: $BASH_COMMAND" >&2; exit 3' ERR
work=$(cd "${1:?usage: agent.sh <work-dir> <out-dir> integrate|implement|claims}" && pwd)
mkdir -p "${2:?}"
out=$(cd "$2" && pwd)
step=${3:?usage: agent.sh <work-dir> <out-dir> integrate|implement|claims}
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
export GIT_AUTHOR_NAME="agent:coder" GIT_AUTHOR_EMAIL="agent-coder@course-desk.invalid"
export GIT_AUTHOR_DATE="2026-11-24T12:00:00Z" GIT_COMMITTER_DATE="2026-11-24T12:00:00Z"
CHANGE=chg-full-course-notice
BRANCH=agent/full-course-notice      # where the agent pushes in the owner's repository
OWNER_BRANCH=feature/full-course-notice # the owner's branch, where the approval is committed
notes="$out/agent"
mkdir -p "$notes"
A() { VCV_HOST_PRINCIPAL=agent:coder VCV_HOST_PERMISSIONS=model:propose,binding:record vcv "$@"; }
cd "$agent_repo"

case "$step" in
  integrate)
    git checkout -q -B "$BRANCH" origin/test-base
    cp "$here/agent/own-draft.json" "$notes/own-draft.json"
    echo "== the agent's own draft (never submitted on its own)"
    A proposal preview "$agent_repo" --file "$notes/own-draft.json" | scrub > "$notes/own-draft-preview.txt"
    head -3 "$notes/own-draft-preview.txt"
    echo "== integrate it with the owner's handoff"
    node "$here/agent/integrate.mjs" "$out/handoff/change.json" "$notes/own-draft.json" "$notes/proposal.json" "$notes/integration.md"
    A proposal preview "$agent_repo" --file "$notes/proposal.json" | scrub > "$notes/preview-file.txt"
    head -3 "$notes/preview-file.txt"
    grep -q "(applies)" "$notes/preview-file.txt"
    if grep -qE "^(errors|  ✗)" "$notes/preview-file.txt"; then echo "agent.sh: the engine found errors" >&2; exit 3; fi
    echo "== submit (proposal-only)"
    A proposal submit "$agent_repo" "$notes/proposal.json" | scrub | tee "$notes/submit.txt"
    echo "== the agent tries to approve its own proposal"
    code=0
    A review approve "$agent_repo" "$CHANGE" --digest 0000 --key /dev/null --trust-commit "$(cat "$work/main.sha")" > "$notes/self-approve.txt" 2>&1 || code=$?
    echo "exit $code" >> "$notes/self-approve.txt"
    [ "$code" != 0 ] || { echo "agent.sh: the agent's approval was not refused" >&2; exit 3; }
    echo "refused (exit $code): $(head -1 "$notes/self-approve.txt" | scrub)"
    git add .vcv
    git commit -q -m "vcv: propose $CHANGE (agent:coder; integrates the owner's UI handoff)"
    git push -q origin "$BRANCH"
    git -C "$agent_repo" diff --stat origin/test-base HEAD | scrub > "$notes/proposal-diffstat.txt"
    ;;
  implement)
    git fetch -q origin "$OWNER_BRANCH"   # the owner's branch, now with the reviewer's approval
    git checkout -q -B "$BRANCH" FETCH_HEAD
    echo "== the approved request"
    A handoff "$agent_repo" "$CHANGE" > "$notes/handoff.json"
    node -e 'const h=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log("handoff "+h.digest.slice(0,12)+": "+h.change.changeId+", approved by "+h.approval.approverId+", base "+h.git.baseCommit.slice(0,12))' "$notes/handoff.json"
    node "$here/agent/implement.mjs" "$agent_repo"
    echo "== the app's own checks, run by the agent (its claim)"
    { npm run -s typecheck && npm test --silent 2>&1 | grep -E "Test Files|Tests " && npm run -s build >/dev/null && npm run -s smoke | tail -1; } > "$notes/agent-checks.txt" 2>&1
    cat "$notes/agent-checks.txt"
    git add -A server README.md scripts
    git commit -q -m "feat: announce full-course rejections ($CHANGE)"
    git diff HEAD~1 HEAD -- . ':!.vcv' > "$notes/source.diff"
    git push -q origin "$BRANCH"
    ;;
  claims)
    git fetch -q origin "$BRANCH"
    git checkout -q -B "$BRANCH" FETCH_HEAD
    echo "== reassert the claims the change moved (no approval needed; each one is the agent's claim)"
    while IFS=$'\t' read -r bid loc why; do
      digest=$(vcv binding list "$agent_repo" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s).find(x=>x.bindingId===process.argv[1]);console.log(e?e.digest:"")})' "$bid")
      [ -n "$digest" ] || { echo "agent.sh: no claim $bid" >&2; exit 3; }
      A binding reassert "$agent_repo" "$bid" --locator "$loc" --expect "$digest" --source agent --rationale "$why" | head -1
    done < "$here/agent/reassert.tsv" | tee "$notes/reassert.txt"
    echo "== record the implementation report"
    node -e '
      const fs = require("fs"), [rep, handoff, checks, dest] = process.argv.slice(1);
      const r = JSON.parse(fs.readFileSync(rep, "utf8")), h = JSON.parse(fs.readFileSync(handoff, "utf8"));
      const summary = fs.readFileSync(checks, "utf8").trim().split("\n").map((l) => l.trim()).join("; ");
      const testsRun = [{ command: "npm run typecheck && npm test && npm run build && npm run smoke", outcome: /failed/i.test(summary) ? "failed" : "passed", summary }];
      fs.writeFileSync(dest, JSON.stringify({ ...r, baseCommit: h.git.baseCommit, handoffDigest: h.digest, testsRun }, null, 2) + "\n");' \
      "$here/agent/report.json" "$notes/handoff.json" "$notes/agent-checks.txt" "$notes/report.json"
    A implementation record "$agent_repo" --report "$notes/report.json" | scrub | tee "$notes/implementation-record.txt"
    git add .vcv
    git commit -q -m "vcv: reassert claims and record the implementation of $CHANGE"
    git push -q origin "$BRANCH"
    ;;
  *) echo "agent.sh: unknown step $step" >&2; exit 2 ;;
esac
