#!/usr/bin/env bash
# Build a self-contained VCV toolkit for an isolated agent run (Issue #11):
#
#   examples/reference-app/bootstrap/toolkit.sh <dest> [<guide.md>]
#
# <dest>/bin/vcv runs the CLI; <dest>/AGENT_GUIDE.md is the guide (default
# docs/agent-bootstrap.md; the maintenance run passes docs/agent-maintenance.md). Only the
# engine sources and their runtime dependencies are copied: no examples/, tests, other docs,
# ADRs or the reviewer oracle, so the agent cannot see an answer key or sample models.
set -euo pipefail

dest=${1:?usage: toolkit.sh <dest> [<guide.md>]}
guide=docs/agent-bootstrap.md
[ -n "${2:-}" ] && guide=$(realpath "$2")
vcv_home=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
if [ -e "$dest" ] && [ -n "$(ls -A "$dest")" ]; then
  echo "toolkit: $dest exists and is not empty" >&2
  exit 1
fi
mkdir -p "$dest/bin"

cd "$vcv_home"
[ -d node_modules ] || { echo "toolkit: run npm ci in $vcv_home first" >&2; exit 1; }
paths=(package.json node_modules apps/cli/package.json apps/cli/src)
for p in packages/*; do
  paths+=("$p/package.json" "$p/src")
  # A package-local dependency (e.g. @vcv/repo's pinned TypeScript parser) is not hoisted.
  [ -d "$p/node_modules" ] && paths+=("$p/node_modules")
done
# node_modules/@vcv/mcp would dangle (apps/mcp is not copied); everything else is real.
tar -cf - --exclude=node_modules/@vcv/mcp --exclude=node_modules/.cache "${paths[@]}" | tar -C "$dest" -xf -
cp "$guide" "$dest/AGENT_GUIDE.md"

cat > "$dest/bin/vcv" <<SH
#!/usr/bin/env bash
exec node --experimental-strip-types --no-warnings "$dest/apps/cli/src/main.ts" "\$@"
SH
chmod +x "$dest/bin/vcv"
echo "$dest"
