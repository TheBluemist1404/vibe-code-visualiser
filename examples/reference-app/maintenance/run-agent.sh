#!/usr/bin/env bash
# Agent-led model maintenance on Course Desk (Issue #15, M2.5): the M2 exit proof.
#
#   examples/reference-app/maintenance/run-agent.sh <out-dir> [--model <model>]
#
# 1. setup.sh: Course Desk with the M2.3 draft, eight M2.4 claims, a committed Git baseline and
#    the waitlist change applied (uncommitted); the app's own tests are run on it.
# 2. Records the evidence before the agent starts, and hashes of .vcv/ and the source.
# 3. Runs a fresh, headless Claude Code session in the repo, as in M2.3: empty HOME, scrubbed
#    environment, generic prompt.md, a toolkit with only the engine and docs/agent-maintenance.md.
#    Least privilege: writes only under vcv-maintenance/; shell limited to the VCV CLI, the app's
#    npm test/typecheck and read-only Git/ls; no web; this VCV checkout is denied. The `vcv` on its
#    PATH fixes the host identity to agent:maintainer with model:propose only, so it cannot apply
#    or approve, whatever flags it passes.
# 4. Records the outcome: the agent's files, the pending change record, the evidence afterwards,
#    hashes afterwards, an approval attempt under the agent's identity (denied), the transcript
#    and an isolation audit. No approval is made: that is left to a person.
# Requires the `claude` CLI (signed in) and Node 22.22.2+.
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

echo "== setup"
"$here/setup.sh" "$repo" --app-tests | tee "$out/setup.txt"
"$vcv_home/examples/reference-app/bootstrap/toolkit.sh" "$toolkit" "$vcv_home/docs/agent-maintenance.md" >/dev/null
mkdir -p "$work/agent-bin"
cat > "$work/agent-bin/vcv" <<WRAP
#!/usr/bin/env bash
# The host decides who the agent is; --as and --perm are refused while these are set.
export VCV_HOST_PRINCIPAL=agent:maintainer VCV_HOST_PERMISSIONS=model:propose
exec "$toolkit/bin/vcv" "\$@"
WRAP
chmod +x "$work/agent-bin/vcv"
vcv() { "$work/agent-bin/vcv" "$@"; }
scrub() { sed "s|$repo|<repo>|g; s|$work|<work>|g"; }

# Everything an agent could change: the model store and claims, and the source tree (not node_modules).
hashes() {
  (cd "$repo" && { find .vcv -type f ! -name audit.jsonl; git ls-files --others --modified --exclude-standard; git ls-files; } \
    | sort -u | grep -v '^vcv-maintenance/' | while read -r f; do [ -f "$f" ] && sha256sum "$f"; done)
}

echo "== evidence before"
mkdir -p "$out/evidence"
vcv evidence "$repo" refresh > "$out/evidence/before-refresh.json" || true
vcv evidence "$repo" overview > "$out/evidence/before-overview.json" || true
vcv evidence "$repo" object rul-seat-limit > "$out/evidence/before-object-rul-seat-limit.json" || true
hashes > "$work/hashes-before.txt"

echo "== agent"
mkdir -p "$work/home"
prompt=$(sed "s|\$VCV_GUIDE|$toolkit/AGENT_GUIDE.md|g" "$here/prompt.md")
printf '%s\n' "$prompt" > "$out/prompt.txt"
allow=("Read" "Glob" "Grep" "Write(/$repo/vcv-maintenance/**)" "Edit(/$repo/vcv-maintenance/**)"
  "Bash(vcv:*)" "Bash(npm test:*)" "Bash(npm run typecheck:*)" "Bash(npx vitest:*)"
  "Bash(git status:*)" "Bash(git log:*)" "Bash(git diff:*)" "Bash(git show:*)" "Bash(git ls-files:*)" "Bash(ls:*)" "Bash(mkdir:*)")
deny=("WebFetch" "WebSearch" "Read(/$vcv_home/**)" "Grep(/$vcv_home/**)" "Glob(/$vcv_home/**)" "Write(/$vcv_home/**)" "Edit(/$vcv_home/**)"
  "Write(/$repo/.vcv/**)" "Edit(/$repo/.vcv/**)" "Bash(git commit:*)" "Bash(git push:*)" "Bash(git checkout:*)" "Bash(git stash:*)" "Bash(git reset:*)" "Bash(git apply:*)")
started=$(date -u +%FT%TZ)
(
  cd "$repo"
  env -i HOME="$work/home" PATH="$work/agent-bin:$PATH" LANG=C.UTF-8 \
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
cp -r "$repo/vcv-maintenance" "$out/agent-output" 2>/dev/null || echo "(no vcv-maintenance/ directory)"
mkdir -p "$out/change-records"
cp "$repo"/.vcv/changes/*.json "$out/change-records/" 2>/dev/null || echo "(no change records)"
vcv evidence "$repo" refresh --since "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).data.observationToken)' "$out/evidence/before-refresh.json")" > "$out/evidence/after-refresh.json" || true
vcv project status "$repo" --json | scrub > "$out/project-status.json" || true
hashes > "$work/hashes-after.txt"
diff "$work/hashes-before.txt" "$work/hashes-after.txt" > "$out/hash-diff.txt" || true
# The agent's identity cannot approve its own (or any) change.
for f in "$repo"/.vcv/changes/*.json; do
  [ -f "$f" ] || continue
  id=$(basename "$f" .json)
  { echo "\$ vcv approve .vcv $id   # as agent:maintainer (model:propose)"; vcv approve "$repo/.vcv" "$id" 2>&1 || true;
    echo "\$ vcv approve .vcv $id --perm approve"; vcv approve "$repo/.vcv" "$id" --perm approve 2>&1 || true; } | scrub >> "$out/agent-approve-attempt.txt"
done
git -C "$repo" status --porcelain=v1 --untracked-files=all | grep -v node_modules > "$out/git-status.txt" || true
node "$vcv_home/examples/reference-app/bootstrap/summarize.mjs" "$out/transcript.jsonl" "$vcv_home" > "$out/transcript.md"
cat > "$out/run.json" <<JSON
{ "baselineCommit": "$(git -C "$repo" rev-parse HEAD)", "started": "$started", "finished": "$finished", "node": "$(node --version)", "claude": "$(claude --version | head -1)" }
JSON
echo "recorded in $out (work dir: $work)"
