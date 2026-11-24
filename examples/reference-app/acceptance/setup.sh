#!/usr/bin/env bash
# The real Course Desk repository with a protected TEST base, for the M5.7 acceptance walkthrough
# (Issue #46).
#
#   sudo env PATH="$PATH" examples/reference-app/acceptance/setup.sh <work-dir>
#
# Runs as root, because it creates two OS users (common.sh): the workspace user, which runs the
# explorer, the agent and the gate, and the fixture reviewer, the only user that can open the
# fixture key. Neither gets sudo. <work-dir> must not exist or be empty, and every directory above it
# must be traversable by both users (for example under /tmp). Steps, in this order:
#  1. the users, and <work> (0755, root's) with ws/ (the workspace's) and reviewer/ (the reviewer's);
#  2. as the reviewer: create the key in reviewer/key (0700, key 0600); only the public entry leaves;
#  3. as the reviewer, before the workspace exists: clone Course Desk (COURSE_DESK_URL, default the
#     public repository) at COURSE_DESK_COMMIT (default 5d966ed, its main after M4.5: rev-4, approved
#     by the owner) into its own clone, and make the TEST base there: one commit that ADDS the fixture
#     reviewer's public entry to .vcv/reviewers.json next to the owner's. It checks that the commit's
#     only parent is that upstream commit and that its only change is that one added entry, then pins
#     it in reviewer/trust-anchor.sha. It is the protected base of this rehearsal only: the gate, the
#     integrity checks and the approval are pinned to it. It is never pushed; the real repository's
#     trust list stays the owner's alone, and a fixture approval fails integrity against it (run.sh);
#  4. as the workspace, in ws/: clone that pinned commit from the reviewer's clone (no ref of its own
#     is ever selected as the anchor) and check it is the pinned one; the agent's own clone in ws/agent;
#  5. as the workspace, only now: `npm ci` in both (dependency lifecycle scripts run after the anchor
#     is fixed; skipped with NO_INSTALL=1).
set -euo pipefail
work=${1:?usage: setup.sh <work-dir>}
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

if [ "$(id -u)" = 0 ]; then
  if [ -e "$work" ] && [ -n "$(ls -A "$work")" ]; then echo "setup: $work exists and is not empty" >&2; exit 1; fi
  for u in "$WS_USER" "$RV_USER"; do id -u "$u" > /dev/null 2>&1 || useradd -m -s /usr/sbin/nologin "$u"; done
  install -d -o root -g root -m 0755 "$work"
  work=$(cd "$work" && pwd)
  source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
  install -d -o "$WS_USER" -g "$WS_USER" -m 0755 "$ws"
  install -d -o "$RV_USER" -g "$RV_USER" -m 0755 "$work/reviewer"
  for u in "$WS_USER" "$RV_USER"; do
    as "$u" test -x "$ws" -a -x "$work/reviewer" -a -r "$vcv_home/package.json" || {
      echo "setup: $u cannot reach $work or read $vcv_home; put both where every user can traverse" >&2; exit 1; }
  done
  echo "== the fixture reviewer (OS user $RV_USER; TEST ONLY)"
  as "$RV_USER" bash "$here/reviewer.sh" "$work" init
  echo "== the reviewer makes and pins the test base (OS user $RV_USER)"
  as "$RV_USER" bash "$here/reviewer.sh" "$work" pin
  echo "== the workspace (OS user $WS_USER)"
  as "$WS_USER" bash "$0" "$work" prepare
  if [ "${NO_INSTALL:-}" != 1 ]; then
    echo "== install the app in the workspace's checkouts (after the anchor is pinned)"
    as "$WS_USER" bash "$0" "$work" install
  fi
  echo "setup: ok"
  exit
fi

require_user "$WS_USER"
work=$(cd "$work" && pwd)
step=${2:?setup.sh <work-dir> prepare|install (as the workspace user)}
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

case "$step" in
  prepare)
    anchor=$(cat "$anchor_file")
    echo "== the pinned test base, from the reviewer's clone"
    git clone -q --branch test-base "$reviewer_repo" "$repo"
    git -C "$repo" remote remove origin
    [ "$(git -C "$repo" rev-parse HEAD)" = "$anchor" ] || { echo "setup: test-base is not the pinned $anchor" >&2; exit 1; }
    echo "$anchor" > "$ws/main.sha"
    cp "$work/reviewer/upstream.sha" "$ws/upstream.sha"
    vcv project status "$repo" | scrub
    echo "test base: $anchor (trust list: user:hoang, $FIXTURE_REVIEWER)"
    echo "== the coding agent's own clone"
    mkdir -p "$ws/agent" "$ws/state"
    git clone -q --branch test-base "$repo" "$agent_repo"
    echo "workspace: ok"
    ;;
  install)
    for d in "$repo" "$agent_repo"; do (cd "$d" && npm ci --no-audit --no-fund --loglevel=error >/dev/null); done
    echo "install: ok"
    ;;
  *) echo "setup: unknown step $step" >&2; exit 2 ;;
esac
