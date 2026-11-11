# Shared by the golden-path scripts (Issue #17, M3.4). Source it; do not run it.
#   work=<work dir>; source common.sh
# Layout of <work>: course-desk/ (the checkout), keys/ (the reviewer's key: never visible to an
# agent), toolkit/ (VCV engine copy for agents), agent-bin/ (identity-fixing vcv wrappers),
# notes/ (the agents' own files, outside the checkout), home-*/ (empty agent homes).
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
vcv_home=$(cd "$here/../../.." && pwd)
repo="$work/course-desk"
keys="$work/keys"
notes="$work/notes"
BRANCH=feature/rejection-reason
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME="Course Desk Fixture" GIT_AUTHOR_EMAIL="fixture@course-desk.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

# The trusted VCV CLI (this checkout), as the person and the host use it.
vcv() { node --experimental-strip-types --no-warnings "$vcv_home/apps/cli/src/main.ts" "$@"; }
# The agents' CLI: the toolkit copy, with the host-fixed identity of each role.
agent_vcv() { local role=$1; shift; "$work/agent-bin/vcv-$role" "$@"; }
scrub() { sed "s|$repo|<repo>|g; s|$keys|<keys>|g; s|$notes|<notes>|g; s|$work|<work>|g; s|$vcv_home|<vcv>|g"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];console.log(typeof v==="string"?v:JSON.stringify(v))})' "$1"; }

# Build the toolkit and the two agent identities once per work dir.
#   proposer:    agent:proposer     model:propose
#   implementer: agent:implementer  model:propose, binding:record
# Neither can apply or approve: VCV_HOST_* fixes the identity, --as/--perm are refused, and
# `review approve` refuses to run under an agent host at all.
prepare_agents() {
  [ -x "$work/agent-bin/vcv-proposer" ] && return
  local guide="$work/guide.md"
  cat "$vcv_home/docs/proposals.md" "$vcv_home/docs/agent-maintenance.md" "$vcv_home/docs/implementation.md" "$vcv_home/docs/bindings.md" > "$guide"
  "$vcv_home/examples/reference-app/bootstrap/toolkit.sh" "$work/toolkit" "$guide" >/dev/null
  mkdir -p "$work/agent-bin" "$notes"
  for role in proposer:model:propose implementer:model:propose,binding:record; do
    local name=${role%%:*} perms=${role#*:}
    cat > "$work/agent-bin/vcv-$name" <<WRAP
#!/usr/bin/env bash
export VCV_HOST_PRINCIPAL=agent:$name VCV_HOST_PERMISSIONS=$perms
exec "$work/toolkit/bin/vcv" "\$@"
WRAP
    chmod +x "$work/agent-bin/vcv-$name"
    mkdir -p "$work/bin-$name"
    ln -sf "$work/agent-bin/vcv-$name" "$work/bin-$name/vcv"
  done
}

# Everything an agent could change outside its notes: .vcv/ and the source tree.
hashes() {
  (cd "$repo" && { find .vcv -type f ! -name audit.jsonl; git ls-files --others --modified --exclude-standard; git ls-files; } \
    | sort -u | while read -r f; do [ -f "$f" ] && sha256sum "$f"; done)
}

# Run a fresh, headless Claude Code session in the checkout (as in M2.3/M2.5): empty HOME,
# scrubbed environment, no MCP, no web, this VCV checkout and the reviewer's keys denied.
#   run_claude <role> <prompt> <transcript> <allow...> -- <deny...>
run_claude() {
  local role=$1 prompt=$2 transcript=$3; shift 3
  local allow=() deny=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do allow+=("$1"); shift; done
  [ "${1:-}" = "--" ] && shift
  deny=("$@" "WebFetch" "WebSearch"
    "Read(/$vcv_home/**)" "Grep(/$vcv_home/**)" "Glob(/$vcv_home/**)" "Write(/$vcv_home/**)" "Edit(/$vcv_home/**)"
    "Read(/$keys/**)" "Grep(/$keys/**)" "Glob(/$keys/**)"
    "Write(/$repo/.vcv/**)" "Edit(/$repo/.vcv/**)"
    "Bash(git commit:*)" "Bash(git push:*)" "Bash(git checkout:*)" "Bash(git switch:*)" "Bash(git stash:*)" "Bash(git reset:*)" "Bash(git apply:*)" "Bash(git merge:*)")
  mkdir -p "$work/home-$role"
  (
    cd "$repo"
    env -i HOME="$work/home-$role" PATH="$work/bin-$role:$PATH" LANG=C.UTF-8 \
      ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-}" ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
      HTTPS_PROXY="${HTTPS_PROXY:-}" HTTP_PROXY="${HTTP_PROXY:-}" NO_PROXY="${NO_PROXY:-}" \
      NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-}" SSL_CERT_FILE="${SSL_CERT_FILE:-}" \
      claude -p "$prompt" "${MODEL_ARGS[@]}" \
        --setting-sources project --strict-mcp-config \
        --tools Bash Read Glob Grep Write Edit \
        --permission-mode default \
        --allowedTools "${allow[@]}" \
        --disallowedTools "${deny[@]}" \
        --max-turns 200 \
        --output-format stream-json --verbose < /dev/null
  ) > "$transcript"
}
MODEL_ARGS=()

# fill <template> NAME=value...: replace $NAME in the template (no shell evaluation).
fill() {
  node -e 'let t=require("fs").readFileSync(process.argv[1],"utf8");for(const a of process.argv.slice(2)){const i=a.indexOf("=");t=t.split("$"+a.slice(0,i)).join(a.slice(i+1))}process.stdout.write(t)' "$@"
}
