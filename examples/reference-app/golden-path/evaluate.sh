#!/usr/bin/env bash
# Independent assessment of a recorded golden-path run (Issue #17, M3.4).
#
#   examples/reference-app/golden-path/evaluate.sh <work-dir> <out-dir> [--model <model>]
#
# A third fresh, headless Claude Code session with read-only tools (Read, Glob, Grep), no shell,
# no web, judges the run against the request, the code before the change and the reviewer
# oracle. It sees only a staging copy of those files; it did not take part in the run and has no
# access to this VCV checkout. Writes <out-dir>/5-independent-assessment.md and its transcript.
set -euo pipefail
work=$(cd "${1:?usage: evaluate.sh <work-dir> <out-dir> [--model <model>]}" && pwd)
out=$(cd "${2:?}" && pwd)
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[ "${3:-}" = "--model" ] && MODEL_ARGS=(--model "${4:?}")
stage=$(mktemp -d)/review
mkdir -p "$stage/before" "$work/home-evaluator"
cp "$here/request.md" "$here/../ORACLE.md" "$stage/"
for d in 1-propose 2-review 3-implement 4-verify; do
  mkdir -p "$stage/$d"
  (cd "$out/$d" && find . -type f ! -name '*.jsonl' | while read -r f; do mkdir -p "$stage/$d/$(dirname "$f")"; cp "$f" "$stage/$d/$f"; done)
done
git -C "$repo" diff --name-only main..HEAD -- . ':(exclude).vcv' | while read -r f; do
  mkdir -p "$stage/before/$(dirname "$f")"; git -C "$repo" show "main:$f" > "$stage/before/$f"
done
git -C "$repo" show "main:.vcv/revisions/$(git -C "$repo" show main:.vcv/HEAD | json revision).yaml" > "$stage/before/model.yaml"
prompt=$(cat "$here/evaluate-prompt.md")
(
  cd "$stage"
  env -i HOME="$work/home-evaluator" PATH="$PATH" LANG=C.UTF-8 \
    ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-}" ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
    HTTPS_PROXY="${HTTPS_PROXY:-}" HTTP_PROXY="${HTTP_PROXY:-}" NO_PROXY="${NO_PROXY:-}" \
    NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-}" SSL_CERT_FILE="${SSL_CERT_FILE:-}" \
    claude -p "$prompt" "${MODEL_ARGS[@]}" \
      --setting-sources project --strict-mcp-config \
      --tools Read Glob Grep \
      --permission-mode default \
      --allowedTools Read Glob Grep \
      --disallowedTools "Read(/$vcv_home/**)" "Grep(/$vcv_home/**)" "Glob(/$vcv_home/**)" "Read(/$keys/**)" \
      --max-turns 80 \
      --output-format stream-json --verbose < /dev/null
) > "$out/5-evaluator-transcript.jsonl"
node -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const r = lines.find((m) => m.type === "result");
  const init = lines.find((m) => m.type === "system" && m.subtype === "init");
  process.stdout.write(`<!-- independent evaluator: ${init.model}, tools ${init.tools.join(", ")}, ${r.num_turns} turns -->\n\n${r.result}\n`);
' "$out/5-evaluator-transcript.jsonl" > "$out/5-independent-assessment.md"
echo "wrote $out/5-independent-assessment.md"
