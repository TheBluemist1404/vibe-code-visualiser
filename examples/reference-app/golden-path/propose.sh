#!/usr/bin/env bash
# Golden path, steps 1-2 (Issue #17, M3.4): the user request becomes a pending typed proposal.
#
#   examples/reference-app/golden-path/propose.sh <work-dir> <out-dir> [--model <model>]
#
# 1. setup.sh: a fresh Course Desk checkout with an approved baseline model on main; the
#    reviewer's key in <work>/keys (outside the checkout).
# 2. Creates the feature branch, then runs a fresh, headless Claude Code session as
#    agent:proposer (model:propose only) with request.md: it reads the model, the evidence and the
#    code, writes a typed change file (with an implementation request) outside the checkout,
#    previews and submits it. It may not edit source or .vcv/, commit, read this VCV checkout
#    or the reviewer's key.
# 3. Records the transcript, the agent's notes, the pending record, the preview the reviewer
#    will see, hashes before/after and the agent's own (denied) approval attempts.
# Requires the `claude` CLI (signed in) and Node 22.22.2+.
set -euo pipefail
work=${1:?usage: propose.sh <work-dir> <out-dir> [--model <model>]}
out=${2:?usage: propose.sh <work-dir> <out-dir> [--model <model>]}
mkdir -p "$work" "$out"
work=$(cd "$work" && pwd); out=$(cd "$out" && pwd)
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[ "${3:-}" = "--model" ] && MODEL_ARGS=(--model "${4:?}")
mkdir -p "$out/1-propose"; o="$out/1-propose"

echo "== setup (main: approved baseline)"
"$here/setup.sh" "$repo" "$keys" | scrub | tee "$out/0-setup.txt"
git -C "$repo" checkout -q -b "$BRANCH"
git -C "$repo" rev-parse main > "$work/main.sha"
prepare_agents

echo "== proposer agent"
hashes > "$work/hashes-before-propose.txt"
request=$(cat "$here/request.md")
prompt=$(fill "$here/propose-prompt.md" "REQUEST=$request" "VCV_GUIDE=$work/toolkit/AGENT_GUIDE.md" "NOTES=$notes")
printf '%s\n' "$prompt" | scrub > "$o/prompt.txt"
allow=("Read" "Glob" "Grep" "Write(/$notes/**)" "Edit(/$notes/**)" "Bash(vcv:*)"
  "Bash(git status:*)" "Bash(git log:*)" "Bash(git diff:*)" "Bash(git show:*)" "Bash(git ls-files:*)" "Bash(ls:*)")
started=$(date -u +%FT%TZ)
run_claude proposer "$prompt" "$o/transcript.jsonl" "${allow[@]}" -- "Write(/$repo/**)" "Edit(/$repo/**)"
finished=$(date -u +%FT%TZ)

echo "== outcome"
mkdir -p "$o/agent-notes" "$o/change-records"
cp -r "$notes"/. "$o/agent-notes/" 2>/dev/null || true
for f in "$repo"/.vcv/changes/*.json; do cp "$f" "$o/change-records/"; done
hashes > "$work/hashes-after-propose.txt"
diff "$work/hashes-before-propose.txt" "$work/hashes-after-propose.txt" > "$o/hash-diff.txt" || true
vcv proposal list "$repo" | scrub > "$o/proposal-list.txt"
vcv project status "$repo" | scrub > "$o/project-status.txt"
git -C "$repo" status --porcelain=v1 --untracked-files=all | grep -v node_modules > "$o/git-status.txt" || true
# The proposer cannot apply or approve, whatever it passes.
for f in "$repo"/.vcv/changes/*.json; do
  id=$(basename "$f" .json)
  [ "$id" = chg-baseline ] && continue
  echo "$id" > "$work/change.id"
  { echo "\$ vcv approve .vcv $id   # as agent:proposer"; agent_vcv proposer approve "$repo/.vcv" "$id" 2>&1 || true
    echo "\$ vcv approve .vcv $id --as user:reviewer --perm approve"; agent_vcv proposer approve "$repo/.vcv" "$id" --as user:reviewer --perm approve 2>&1 || true
    echo "\$ vcv review approve . $id --digest <d> --key <keys>/reviewer.pem --trust-commit <main>"; agent_vcv proposer review approve "$repo" "$id" --digest 0000000000000000000000000000000000000000000000000000000000000000 --key "$keys/reviewer.pem" --trust-commit "$(cat "$work/main.sha")" 2>&1 || true
  } | scrub >> "$o/agent-approve-attempt.txt"
  vcv proposal preview "$repo" "$id" | scrub > "$o/preview.txt"
  vcv proposal preview "$repo" "$id" --json | scrub > "$o/preview.json"
done
node "$vcv_home/examples/reference-app/bootstrap/summarize.mjs" "$o/transcript.jsonl" "$vcv_home" | scrub > "$o/transcript.md" || echo "isolation audit failed (see transcript.md)"
printf '{ "started": "%s", "finished": "%s", "node": "%s", "claude": "%s" }\n' "$started" "$finished" "$(node --version)" "$(claude --version | head -1)" > "$o/run.json"
echo "pending change: $(cat "$work/change.id" 2>/dev/null || echo none). Review: $o/preview.txt, then review.sh"
