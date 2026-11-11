#!/usr/bin/env bash
# Reproducible M2.1 demo (Issue #6): a .vcv/ project on two Git branches, a conflicting merge,
# a one-sided resolution, and recovery by aborting. Runs in a fresh temp directory.
#   bash packages/repo/demo/branch-demo.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
vcv() { node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" "$@"; }
export GIT_AUTHOR_NAME=demo GIT_AUTHOR_EMAIL=demo@example.invalid GIT_COMMITTER_NAME=demo GIT_COMMITTER_EMAIL=demo@example.invalid
WORK="$(mktemp -d)"; cd "$WORK"; git init -q -b main
change() { printf 'changeId: %s\nprojectId: prj-lms\nexpectedRevision: rev-1\noperations:\n  - type: renameState\n    behaviorId: beh-enrollment-approval\n    stateId: st-pending\n    name: "%s"\n' "$1" "$2" > "$WORK/../$1.yaml"; }
change ch-a "Waiting (A)"; change ch-b "Waiting (B)"
step() { printf '\n$ %s\n' "$*"; }

step vcv project status . ; vcv project status . || true
step vcv project init . model.rev-1.yaml; vcv project init . "$ROOT/examples/enrollment/model.rev-1.yaml"
git add -A; git commit -qm "init vcv project"
git checkout -qb feature-a; step "(feature-a) vcv propose .vcv ch-a"; vcv propose .vcv "$WORK/../ch-a.yaml"; git add -A; git commit -qm A
git checkout -q main; git checkout -qb feature-b; step "(feature-b) vcv propose .vcv ch-b"; vcv propose .vcv "$WORK/../ch-b.yaml"; git add -A; git commit -qm B
step git merge feature-a; git merge -q feature-a || true
step vcv project status .; vcv project status . || true
step "vcv show .vcv   # writers and readers refuse a conflicted store"; vcv show .vcv || true
step "git checkout --ours -- .vcv/HEAD && vcv project status ."; git checkout --ours -- .vcv/HEAD; vcv project status . || true
step "git merge --abort && vcv project status ."; git merge --abort; vcv project status .
