#!/usr/bin/env bash
# Golden path, steps 4-5 (Issue #17, M3.4): explicit implementation of the approved change.
#
#   examples/reference-app/golden-path/implement.sh <work-dir> <out-dir> [--model <model>]
#
# Invoked by the person after the approval (review.sh approve); nothing starts it automatically.
# 1. Installs the app's dependencies (npm ci) so the agent can run the app's own checks.
# 2. Runs a second fresh, headless Claude Code session as agent:implementer (model:propose and
#    binding:record): it reads the handoff, implements source and tests, reasserts binding claims
#    through VCV, runs the tests, writes its report and records it. It may edit the checkout's
#    source, but not .vcv/ (only through vcv), not commit, not read this VCV checkout or the key.
# 3. The host then runs the app's checks itself (typecheck, tests, build, HTTP smoke): these
#    outcomes are the host's, recorded next to the agent's claims, not VCV's.
# 4. Commits source, tests and .vcv/ (claims, implementation report) together on the branch.
set -euo pipefail
work=$(cd "${1:?usage: implement.sh <work-dir> <out-dir> [--model <model>]}" && pwd)
out=$(cd "${2:?}" && pwd)
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[ "${3:-}" = "--model" ] && MODEL_ARGS=(--model "${4:?}")
id=$(cat "$work/change.id")
o="$out/3-implement"; mkdir -p "$o"
[ -f "$notes/handoff.json" ] || { echo "no handoff: run review.sh approve first" >&2; exit 1; }

echo "== app dependencies"
(cd "$repo" && npm ci --no-audit --no-fund --loglevel=error >/dev/null)
vcv binding list "$repo" | scrub > "$o/bindings-before.txt"
hashes > "$work/hashes-before-implement.txt"

echo "== implementer agent"
prompt=$(fill "$here/implement-prompt.md" "VCV_GUIDE=$work/toolkit/AGENT_GUIDE.md" "NOTES=$notes")
printf '%s\n' "$prompt" | scrub > "$o/prompt.txt"
allow=("Read" "Glob" "Grep" "Write(/$notes/**)" "Edit(/$notes/**)" "Write(/$repo/server/**)" "Edit(/$repo/server/**)" "Write(/$repo/web/**)" "Edit(/$repo/web/**)"
  "Bash(vcv:*)" "Bash(npm test:*)" "Bash(npm run typecheck:*)" "Bash(npm run build:*)" "Bash(npx vitest:*)" "Bash(npx tsc:*)"
  "Bash(git status:*)" "Bash(git log:*)" "Bash(git diff:*)" "Bash(git show:*)" "Bash(git ls-files:*)" "Bash(ls:*)")
started=$(date -u +%FT%TZ)
run_claude implementer "$prompt" "$o/transcript.jsonl" "${allow[@]}" -- "Write(/$repo/node_modules/**)" "Write(/$repo/package.json)" "Write(/$repo/package-lock.json)"
finished=$(date -u +%FT%TZ)

echo "== outcome"
mkdir -p "$o/agent-notes"
cp "$notes"/report.json "$o/agent-notes/" 2>/dev/null || true
hashes > "$work/hashes-after-implement.txt"
diff "$work/hashes-before-implement.txt" "$work/hashes-after-implement.txt" | scrub > "$o/hash-diff.txt" || true
git -C "$repo" status --porcelain=v1 --untracked-files=all | grep -v node_modules > "$o/git-status.txt" || true
vcv binding list "$repo" | scrub > "$o/bindings-after.txt"
vcv implementation show "$repo" "$id" 2>&1 | scrub > "$o/implementation-show.txt" || true

echo "== the host's own run of the app's checks (not the agent's claim, not VCV's)"
(cd "$repo" && { npm run -s typecheck && echo "typecheck: passed"; } && npm test --silent 2>&1 | grep -E "Test Files|Tests |FAIL" && { npm run -s build >/dev/null && echo "build: passed"; } && npm run -s smoke | tail -1) 2>&1 | scrub | tee "$o/host-checks.txt"

echo "== commit source, tests and .vcv/ together"
git -C "$repo" add -A
git -C "$repo" commit -q -m "feat: rejection reason on notifications ($id)

Implemented by agent:implementer from the approved handoff; see .vcv/implementations/$id.json."
git -C "$repo" show --stat --format='%H %s' HEAD | scrub > "$o/implementation-commit.txt"
git -C "$repo" diff main..HEAD -- . ':(exclude).vcv' > "$o/source.diff"
git -C "$repo" diff --stat main..HEAD > "$o/diffstat.txt"
# What replay.sh needs to reproduce this step without an agent: the claims the agent changed.
mkdir -p "$o/bindings-changed"
git -C "$repo" diff --name-only main..HEAD -- .vcv/bindings | while read -r f; do cp "$repo/$f" "$o/bindings-changed/"; done
node "$vcv_home/examples/reference-app/bootstrap/summarize.mjs" "$o/transcript.jsonl" "$vcv_home" | scrub > "$o/transcript.md" || echo "isolation audit failed (see transcript.md)"
printf '{ "started": "%s", "finished": "%s" }\n' "$started" "$finished" > "$o/run.json"
echo "committed. Next: verify.sh"
