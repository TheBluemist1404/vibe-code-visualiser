# Shared by the M5.7 acceptance scripts (Issue #46). Source it; do not run it.
#   work=<work dir>; source common.sh
# Layout of <work>:
#   course-desk/   the owner's checkout of the real Course Desk repository (the UI points here)
#   agent/         the coding agent's own clone: a distinct working context, no reviewer key
#   reviewer/      the fixture reviewer's private key: only reviewer.sh reads it
#   state/         the explorer's state (drafts, layout), outside every checkout
#   main.sha       the protected test base (the commit the gate and the trust anchor are pinned to)
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
vcv_home=$(cd "$here/../../.." && pwd)
repo="$work/course-desk"
agent_repo="$work/agent/course-desk"
keys="$work/reviewer"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME="Course Desk Fixture" GIT_AUTHOR_EMAIL="fixture@course-desk.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
# The fixture reviewer. Never the owner's principal: a test signature is not the owner's approval.
FIXTURE_REVIEWER=user:fixture-reviewer

# The trusted VCV CLI (this checkout), as a person or the host uses it.
vcv() { node --experimental-strip-types --no-warnings "$vcv_home/apps/cli/src/main.ts" "$@"; }
scrub() { sed "s|$agent_repo|<agent>|g; s|$repo|<repo>|g; s|$keys|<reviewer>|g; s|$work|<work>|g; s|$vcv_home|<vcv>|g"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];console.log(typeof v==="string"?v:JSON.stringify(v))})' "$1"; }
