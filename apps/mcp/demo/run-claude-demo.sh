#!/usr/bin/env bash
# Manual M1 demo: ask Claude Code the M1 question against a throwaway repo that has a VCV
# store, the opt-in CLAUDE.md template and a tiny invented code sample (lms-sample/).
# Requires the `claude` CLI, signed in. Prints a condensed transcript of tool calls.
#
#   apps/mcp/demo/run-claude-demo.sh [--no-guidance] [--no-code]
set -euo pipefail
VCV_HOME="$(cd "$(dirname "$0")/../../.." && pwd)"
DEMO="$(mktemp -d)/demo-lms"
mkdir -p "$DEMO"
[[ " $* " == *" --no-code "* ]] || cp -r "$VCV_HOME/apps/mcp/demo/lms-sample/src" "$DEMO/src"
[[ " $* " == *" --no-guidance "* ]] || cp "$VCV_HOME/apps/mcp/templates/CLAUDE.md" "$DEMO/CLAUDE.md"
cp "$VCV_HOME/apps/mcp/examples/claude-code.mcp.json" "$DEMO/.mcp.json"
(cd "$VCV_HOME" && node --experimental-strip-types apps/cli/src/main.ts init "$DEMO/.vcv-store" examples/enrollment/model.rev-1.yaml)
git -C "$DEMO" init -q

export VCV_HOME VCV_STORE="$DEMO/.vcv-store"
cd "$DEMO"
claude -p "Which module handles rejected enrollment, and how does Notifications depend on it?" \
  --strict-mcp-config --mcp-config "$DEMO/.mcp.json" --setting-sources project \
  --allowedTools "mcp__vcv__*" Read Glob Grep \
  --output-format stream-json --verbose > "$DEMO/transcript.jsonl"

node -e '
const fs = require("fs");
for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  if (m.type === "system" && m.subtype === "init") console.log("servers:", JSON.stringify(m.mcp_servers), "\nvcv tools:", m.tools.filter((t) => t.includes("vcv")).join(", "));
  if (m.type === "assistant") for (const c of m.message.content) if (c.type === "tool_use") console.log("→", c.name, JSON.stringify(c.input));
  if (m.type === "result") console.log("\n" + m.result);
}' "$DEMO/transcript.jsonl"
echo; echo "full transcript: $DEMO/transcript.jsonl"
