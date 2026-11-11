#!/usr/bin/env bash
# End-to-end check of the reference app as an unknown repository (Issue #9):
# materialize → npm ci → typecheck → test → build → HTTP smoke run → VCV reports no project.
#
#   examples/reference-app/check.sh [dest]      (default: a new temporary directory)
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
vcv_root=$(cd "$here/../.." && pwd)
dest=${1:-$(mktemp -d)/course-desk}

commit=$("$here/materialize.sh" "$dest")
echo "== baseline $commit in $dest"
cd "$dest"
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run build
npm run smoke

echo "== VCV project status (expected: absent)"
status=$(node --experimental-strip-types "$vcv_root/apps/cli/src/main.ts" project status "$dest" --json || true)
node -e '
  const s = JSON.parse(process.argv[1]);
  const want = { state: "absent", root: process.argv[2], commit: process.argv[3], dirty: false };
  const got = { state: s.state, root: s.root, commit: s.git && s.git.commit, dirty: s.git && s.git.dirty };
  console.log(JSON.stringify(got));
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.error("expected " + JSON.stringify(want)); process.exit(1); }
' "$status" "$(pwd -P)" "$commit"
test ! -e .vcv
echo "reference app: ok"
