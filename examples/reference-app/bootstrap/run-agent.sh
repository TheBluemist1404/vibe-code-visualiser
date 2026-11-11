#!/usr/bin/env bash
# Independent agent bootstrap of Course Desk (Issue #11, M2.3).
#
#   examples/reference-app/bootstrap/run-agent.sh <out-dir> [--model <model>]
#
# 1. Materializes Course Desk as a standalone Git repo and checks VCV reports it `absent`.
# 2. Builds a VCV toolkit with only the engine and docs/agent-bootstrap.md (toolkit.sh).
# 3. Runs a fresh, headless Claude Code session in that repo: empty HOME, scrubbed environment
#    (no user settings, memory or project instructions) and the generic prompt in prompt.md.
#    Least privilege: writes only inside the repo (never into .vcv/), shell limited to the VCV
#    CLI, npm scripts and read-only Git/ls; no web tools; this VCV checkout is denied.
# 4. Records the transcript and the outcome (draft, report, project status, a query read back
#    in a new process) in <out-dir>, plus an isolation audit of every tool call.
# Requires the `claude` CLI (signed in) and Node 22.22.2+ (the fixture's own minimum).
set -euo pipefail

out=${1:?usage: run-agent.sh <out-dir> [--model <model>]}
shift
model_args=()
[ "${1:-}" = "--model" ] && model_args=(--model "${2:?}")
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
vcv_home=$(cd "$here/../../.." && pwd)
mkdir -p "$out"
out=$(cd "$out" && pwd)
work=$(mktemp -d)
repo="$work/course-desk"
toolkit="$work/vcv"

echo "== materialize"
commit=$("$here/../materialize.sh" "$repo")
"$here/toolkit.sh" "$toolkit" >/dev/null
vcv() { "$toolkit/bin/vcv" "$@"; }
before=$(vcv project status "$repo" --json || true)
node -e 'const s=JSON.parse(process.argv[1]); if (s.state!=="absent"||s.git.dirty) { console.error(s); process.exit(1) }' "$before"
echo "baseline $commit in $repo; VCV: absent, clean"

echo "== agent"
mkdir -p "$work/home"
prompt=$(sed "s|\$VCV_GUIDE|$toolkit/AGENT_GUIDE.md|g" "$here/prompt.md")
printf '%s\n' "$prompt" > "$out/prompt.txt"
# Least privilege (absolute paths in permission rules take a leading "//"): read anything,
# write only inside the repo, and run only the VCV CLI,
# npm scripts and read-only Git/ls commands. No web, no other shell commands, no VCV checkout.
allow=("Read" "Glob" "Grep" "Write(/$repo/**)" "Edit(/$repo/**)"
  "Bash(vcv:*)" "Bash(npm ci:*)" "Bash(npm install:*)" "Bash(npm test:*)" "Bash(npm run:*)" "Bash(npx tsc:*)" "Bash(npx vitest:*)"
  "Bash(git status:*)" "Bash(git log:*)" "Bash(git diff:*)" "Bash(git ls-files:*)" "Bash(ls:*)" "Bash(mkdir:*)")
deny=("WebFetch" "WebSearch" "Read(/$vcv_home/**)" "Grep(/$vcv_home/**)" "Glob(/$vcv_home/**)" "Write(/$vcv_home/**)" "Edit(/$vcv_home/**)"
  "Write(/$repo/.vcv/**)" "Edit(/$repo/.vcv/**)" "Bash(git commit:*)" "Bash(git push:*)")
started=$(date -u +%FT%TZ)
(
  cd "$repo"
  env -i HOME="$work/home" PATH="$toolkit/bin:$PATH" LANG=C.UTF-8 \
    ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-}" ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
    HTTPS_PROXY="${HTTPS_PROXY:-}" HTTP_PROXY="${HTTP_PROXY:-}" NO_PROXY="${NO_PROXY:-}" \
    NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-}" SSL_CERT_FILE="${SSL_CERT_FILE:-}" \
    claude -p "$prompt" "${model_args[@]}" \
      --setting-sources project --strict-mcp-config \
      --tools Bash Read Glob Grep Write Edit \
      --permission-mode default \
      --allowedTools "${allow[@]}" \
      --disallowedTools "${deny[@]}" \
      --max-turns 150 \
      --output-format stream-json --verbose < /dev/null
) > "$out/transcript.jsonl"
finished=$(date -u +%FT%TZ)

echo "== outcome"
cp -r "$repo/vcv-bootstrap" "$out/agent-output" 2>/dev/null || echo "(no vcv-bootstrap/ directory)"
git -C "$repo" status --porcelain=v1 --untracked-files=all | grep -v node_modules > "$out/git-status.txt" || true
# New process, nothing cached: the project must reopen and answer queries.
vcv project status "$repo" --json > "$out/project-status.json" || true
vcv validate "$repo/vcv-bootstrap/model.yaml" > "$out/validate.txt" 2>&1 || true
vcv query "$repo/.vcv" overview > "$out/query-overview.json" 2>&1 || true
node "$here/summarize.mjs" "$out/transcript.jsonl" "$vcv_home" > "$out/transcript.md"
cat > "$out/run.json" <<JSON
{ "baselineCommit": "$commit", "started": "$started", "finished": "$finished", "node": "$(node --version)", "claude": "$(claude --version | head -1)" }
JSON
echo "recorded in $out (work dir: $work)"
