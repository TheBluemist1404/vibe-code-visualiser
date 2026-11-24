# Shared by the M5.7 acceptance scripts (Issue #46). Source it; do not run it.
#   work=<work dir>; source common.sh
# Two OS users keep the fixture key away from everything else (created by setup.sh, as root):
#   $WS_USER   the workspace: the owner's explorer and Git, the coding agent, the host's gate.
#              No sudo, no group in common with the reviewer.
#   $RV_USER   the fixture reviewer: the only user that can open reviewer/key/ (mode 0700).
# Layout of <work> (mode 0755, owned by $WS_USER):
#   course-desk/      the owner's checkout of the real Course Desk repository (the UI points here)
#   agent/            the coding agent's own clone: a distinct working context
#   state/            the explorer's state (drafts, layout), outside every checkout
#   reviewer/         owned by $RV_USER: its own clone (course-desk/) and key/ (0700, the key 0600)
#   main.sha          the protected test base (the commit the gate and the trust anchor are pinned to)
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
vcv_home=$(cd "$here/../../.." && pwd)
repo="$work/course-desk"
agent_repo="$work/agent/course-desk"
keys="$work/reviewer/key"
key_file="$keys/fixture-reviewer.pem"
reviewer_repo="$work/reviewer/course-desk"
WS_USER=${VCV_ACCEPTANCE_WS_USER:-vcv-acc-workspace}
RV_USER=${VCV_ACCEPTANCE_RV_USER:-vcv-acc-reviewer}
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$here/gitconfig"
export GIT_AUTHOR_NAME="Course Desk Fixture" GIT_AUTHOR_EMAIL="fixture@course-desk.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
# The fixture reviewer. Never the owner's principal: a test signature is not the owner's approval.
FIXTURE_REVIEWER=user:fixture-reviewer

# The trusted VCV CLI (this checkout), as a person or the host uses it.
vcv() { node --experimental-strip-types --no-warnings "$vcv_home/apps/cli/src/main.ts" "$@"; }
scrub() { sed "s|$agent_repo|<agent>|g; s|$reviewer_repo|<reviewer-repo>|g; s|$repo|<repo>|g; s|$keys|<reviewer-key>|g; s|$work|<work>|g; s|$vcv_home|<vcv>|g"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];console.log(typeof v==="string"?v:JSON.stringify(v))})' "$1"; }

# as <user> <command...>: run a command as one of the two users (from root), with a clean
# environment: nothing of the caller's leaks in except what is listed here.
# Network settings (a proxy and its CA file, which must be readable by both users) pass through.
PASS_ENV=(HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NO_PROXY no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE GIT_SSL_CAINFO)
as() {
  local user=$1 v net=(); shift
  for v in "${PASS_ENV[@]}"; do [ -z "${!v:-}" ] || net+=("$v=${!v}"); done
  runuser -u "$user" -- env -i HOME="$(getent passwd "$user" | cut -d: -f6)" PATH="$PATH" LANG=C.UTF-8 "${net[@]}" \
    ${PLAYWRIGHT_BROWSERS_PATH:+PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH"} \
    ${COURSE_DESK_URL:+COURSE_DESK_URL="$COURSE_DESK_URL"} ${COURSE_DESK_COMMIT:+COURSE_DESK_COMMIT="$COURSE_DESK_COMMIT"} \
    ${NO_INSTALL:+NO_INSTALL="$NO_INSTALL"} "$@"
}
# require_user <user>: a script meant for one context refuses to run in another.
require_user() {
  [ "$(id -un)" = "$1" ] || { echo "$(basename "$0"): must run as $1 (now $(id -un)); run.sh starts it" >&2; exit 2; }
}
