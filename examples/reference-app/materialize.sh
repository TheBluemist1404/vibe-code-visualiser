#!/usr/bin/env bash
# Materialize the Course Desk fixture as a standalone Git repository (Issue #9).
#
#   examples/reference-app/materialize.sh <dest>
#
# Copies template/ (without node_modules, build output or this directory's evaluation files)
# into <dest>, which must not exist or be empty, runs `git init` there, and commits the result
# as the baseline. Identity, dates and Git config are fixed, so the same template always yields
# the same baseline commit ID. Prints that commit ID. Never creates .vcv/.
set -euo pipefail

dest=${1:?usage: materialize.sh <dest>}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [ -e "$dest" ] && [ -n "$(ls -A "$dest")" ]; then
  echo "materialize: $dest exists and is not empty" >&2
  exit 1
fi
mkdir -p "$dest"
tar -C "$here/template" \
  --exclude=node_modules --exclude=dist --exclude=coverage --exclude='*.tsbuildinfo' --exclude=.vcv \
  -cf - . | tar -C "$dest" -xf -

export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME="Course Desk Fixture" GIT_AUTHOR_EMAIL="fixture@course-desk.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
git -C "$dest" init -q -b main
git -C "$dest" add -A
git -C "$dest" commit -q -m "Course Desk baseline"
git -C "$dest" rev-parse HEAD
