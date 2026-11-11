#!/usr/bin/env bash
# Reproduce the recorded golden path without any agent (Issue #17, M3.4): for CI and reviewers.
#
#   examples/reference-app/golden-path/replay.sh <work-dir> [--app-tests] [--sample <dir>]
#
# Replays docs/samples/m3.4-golden-path through the same public commands, in the same order and
# under the same identities, from a fresh checkout and a fresh reviewer key:
#  1. setup.sh (approved baseline on main), feature branch;
#  2. as agent:proposer: submit the recorded proposal (from its change record);
#  3. as the reviewer (simulated, key in <work>/keys): approve exactly the previewed digest, commit;
#  4. as agent:implementer: apply the recorded source diff, re-make the recorded claims through
#     `vcv binding reassert/add`, record the recorded report (base commit and handoff digest
#     taken from this run's handoff); with --app-tests the app's own checks run first;
#  5. commit source, tests and .vcv/ together, then verify.sh (host gate, branch views, simulated
#     merge, negative paths). Fails if any step or expectation does not hold.
# The agents' decisions are replayed, not remade: the recorded transcripts are the evidence that
# a fresh agent made them (docs/samples/m3.4-golden-path/README.md).
set -euo pipefail
work=${1:?usage: replay.sh <work-dir> [--app-tests] [--sample <dir>]}
shift
app_tests=""; sample=""
while [ $# -gt 0 ]; do
  case "$1" in --app-tests) app_tests=1 ;; --sample) sample=${2:?}; shift ;; *) echo "unknown option $1" >&2; exit 2 ;; esac
  shift
done
mkdir -p "$work"; work=$(cd "$work" && pwd)
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
sample=${sample:-$vcv_home/docs/samples/m3.4-golden-path}
out="$work/out"; mkdir -p "$out"
P() { VCV_HOST_PRINCIPAL=agent:proposer VCV_HOST_PERMISSIONS=model:propose vcv "$@"; }
I() { VCV_HOST_PRINCIPAL=agent:implementer VCV_HOST_PERMISSIONS=model:propose,binding:record vcv "$@"; }
mkdir -p "$notes"

echo "== 1. setup"
"$here/setup.sh" "$repo" "$keys" | scrub | tail -2
git -C "$repo" checkout -q -b "$BRANCH"
git -C "$repo" rev-parse main > "$work/main.sha"

echo "== 2. the recorded proposal, as agent:proposer"
record=$(ls "$sample/1-propose/change-records/"*.json | grep -v chg-baseline)
id=$(basename "$record" .json); echo "$id" > "$work/change.id"
json change < "$record" > "$notes/change.json"
P proposal submit "$repo" "$notes/change.json" | head -2
digest=$(vcv proposal preview "$repo" "$id" --json | json data.proposal.proposalDigest)
recorded=$(sed -n 's/^  digest: *//p' "$sample/1-propose/preview.txt")
[ "$digest" = "$recorded" ] || { echo "the proposal digest $digest differs from the recorded $recorded" >&2; exit 1; }

echo "== 3. the reviewer approves the reviewed digest (simulated reviewer)"
"$here/review.sh" "$work" "$out" approve "$digest" | tail -1

echo "== 4. the recorded implementation, as agent:implementer"
git -C "$repo" apply "$sample/3-implement/source.diff"
for f in "$sample/3-implement/bindings-changed/"*.json; do
  node --experimental-strip-types --no-warnings -e '
    import("'"$vcv_home"'/packages/repo/src/locator.ts").then(({ formatLocator }) => {
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      console.log([c.bindingId, c.modelObjectId, c.relation, formatLocator(c.locator), c.provenance.rationale ?? ""].join("\t"));
    });' "$f"
done > "$work/claims.tsv"
while IFS=$'\t' read -r bid obj rel loc why; do
  current=$(vcv binding list "$repo" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s).find(x=>x.bindingId===process.argv[1]);console.log(e?e.digest:"")})' "$bid")
  if [ -n "$current" ]; then I binding reassert "$repo" "$bid" --locator "$loc" --expect "$current" --source agent --rationale "$why" | head -1
  else I binding add "$repo" --id "$bid" --object "$obj" --relation "$rel" --locator "$loc" --source agent --rationale "$why" | head -1; fi
done < "$work/claims.tsv"
if [ -n "$app_tests" ]; then
  echo "== the app's own checks on the implemented tree"
  (cd "$repo" && npm ci --no-audit --no-fund --loglevel=error >/dev/null && npm run -s typecheck && npm test --silent 2>&1 | grep -E "Test Files|Tests " && npm run -s build >/dev/null && npm run -s smoke | tail -1)
fi
node -e '
  const fs = require("fs"), [rep, handoff, dest] = process.argv.slice(1);
  const r = JSON.parse(fs.readFileSync(rep, "utf8")), h = JSON.parse(fs.readFileSync(handoff, "utf8"));
  fs.writeFileSync(dest, JSON.stringify({ ...r, baseCommit: h.git.baseCommit, handoffDigest: h.digest }, null, 2));' \
  "$sample/3-implement/agent-notes/report.json" "$notes/handoff.json" "$notes/report.json"
I implementation record "$repo" --report "$notes/report.json" | scrub
git -C "$repo" add -A
git -C "$repo" commit -q -m "feat: rejection reason on notifications ($id) [replayed]"

echo "== 5. verify"
"$here/verify.sh" "$work" "$out" | tail -1
echo "replay: ok (records in $out)"
