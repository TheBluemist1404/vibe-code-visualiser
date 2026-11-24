#!/usr/bin/env bash
# The real Course Desk repository with a protected TEST base, for the M5.7 acceptance walkthrough
# (Issue #46).
#
#   sudo env PATH="$PATH" examples/reference-app/acceptance/setup.sh <work-dir>
#
# Runs as root, because it creates two OS users (common.sh): the workspace user, which runs the
# explorer, the agent and the gate, and the fixture reviewer, the only user that can open the
# fixture key. Neither gets sudo. <work-dir> must not exist or be empty, and every directory above it
# must be traversable by both users (for example under /tmp). Steps:
#  1. the users, and <work> (0755, the workspace's) with reviewer/ (0755, the reviewer's);
#  2. as the reviewer: create the key in reviewer/key (0700, key 0600); only the public entry leaves;
#  3. as the workspace: clone Course Desk (COURSE_DESK_URL, default the public repository) at
#     COURSE_DESK_COMMIT (default 5d966ed, its main after M4.5: rev-4, approved by the owner);
#  4. one local commit, `test-base`, ADDS the fixture reviewer's public entry to .vcv/reviewers.json
#     next to the owner's. It is the protected base of this rehearsal only: the gate, the integrity
#     checks and the approval are pinned to it. It is never pushed; the real repository's trust
#     list stays the owner's alone, and a fixture approval fails integrity against it (see run.sh);
#  5. the coding agent's own clone in <work>/agent, and `npm ci` in both (skipped with NO_INSTALL=1).
set -euo pipefail
work=${1:?usage: setup.sh <work-dir>}
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

if [ "$(id -u)" = 0 ]; then
  if [ -e "$work" ] && [ -n "$(ls -A "$work")" ]; then echo "setup: $work exists and is not empty" >&2; exit 1; fi
  for u in "$WS_USER" "$RV_USER"; do id -u "$u" > /dev/null 2>&1 || useradd -m -s /usr/sbin/nologin "$u"; done
  install -d -o "$WS_USER" -g "$WS_USER" -m 0755 "$work"
  work=$(cd "$work" && pwd)
  install -d -o "$RV_USER" -g "$RV_USER" -m 0755 "$work/reviewer"
  for u in "$WS_USER" "$RV_USER"; do
    as "$u" test -x "$work" -a -r "$vcv_home/package.json" || {
      echo "setup: $u cannot reach $work or read $vcv_home; put both where every user can traverse" >&2; exit 1; }
  done
  echo "== the fixture reviewer (OS user $RV_USER; TEST ONLY)"
  as "$RV_USER" bash "$here/reviewer.sh" "$work" init
  echo "== the workspace (OS user $WS_USER)"
  as "$WS_USER" bash "$0" "$work"
  exit
fi

require_user "$WS_USER"
work=$(cd "$work" && pwd)
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
export GIT_AUTHOR_DATE="2026-11-24T00:00:00Z" GIT_COMMITTER_DATE="2026-11-24T00:00:00Z"
url=${COURSE_DESK_URL:-https://github.com/TheBluemist1404/course-desk}
pin=${COURSE_DESK_COMMIT:-5d966ed599e401cd92a04436245998e1aca6a57b}

echo "== the real Course Desk at $pin"
git clone -q --no-checkout "$url" "$repo"
git -C "$repo" checkout -q -B test-base "$pin"
git -C "$repo" remote rename origin upstream
git -C "$repo" branch -q -D main 2>/dev/null || true
vcv project status "$repo" | scrub
vcv integrity "$repo" --trust-commit "$pin" --require-attestation | head -1
echo "$pin" > "$work/upstream.sha"

echo "== the test base: the fixture reviewer's public entry next to the owner's"
node -e '
  const fs = require("fs");
  const [file, entryFile] = process.argv.slice(1);
  const list = JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = JSON.parse(fs.readFileSync(entryFile, "utf8"));
  if (list.reviewers.some((r) => r.id === entry.id)) throw new Error("already listed");
  list.reviewers.push(entry);
  fs.writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
' "$repo/.vcv/reviewers.json" "$work/reviewer/fixture-reviewer.public.json"
git -C "$repo" add .vcv/reviewers.json
git -C "$repo" commit -q -m "TEST ONLY: trust the fixture reviewer for the M5.7 rehearsal (never push)"
git -C "$repo" rev-parse HEAD > "$work/main.sha"
echo "test base: $(cat "$work/main.sha") (trust list: user:hoang, $FIXTURE_REVIEWER)"

echo "== the coding agent's own clone"
mkdir -p "$work/agent" "$work/state"
git clone -q --branch test-base "$repo" "$agent_repo"

if [ "${NO_INSTALL:-}" != 1 ]; then
  echo "== install the app in both checkouts (for its own test runner)"
  for d in "$repo" "$agent_repo"; do (cd "$d" && npm ci --no-audit --no-fund --loglevel=error >/dev/null); done
fi
echo "setup: ok"
