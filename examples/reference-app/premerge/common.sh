# Shared by the pre-merge golden-path scripts (Issue #22, M4.5). Source it; do not run it.
#   work=<work dir>; source common.sh
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
vcv_home=$(cd "$here/../../.." && pwd)
repo="$work/course-desk"
keys="$work/keys"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME="Course Desk Fixture" GIT_AUTHOR_EMAIL="fixture@course-desk.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

# The trusted VCV CLI (this checkout), as a person or the host uses it.
vcv() { node --experimental-strip-types --no-warnings "$vcv_home/apps/cli/src/main.ts" "$@"; }
scrub() { sed "s|$repo|<repo>|g; s|$keys|<keys>|g; s|$work|<work>|g; s|$vcv_home|<vcv>|g"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];console.log(typeof v==="string"?v:JSON.stringify(v))})' "$1"; }
