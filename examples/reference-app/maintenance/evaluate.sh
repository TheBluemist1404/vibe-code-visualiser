#!/usr/bin/env bash
# Independent evaluation of a recorded maintenance run (Issue #15, M2.5).
#
#   examples/reference-app/maintenance/evaluate.sh <run-dir> [--model <model>]
#
# A second fresh, headless Claude Code session, with read-only tools (Read, Glob, Grep) and no
# shell, judges the run against the patch, the model before the change and the reviewer oracle.
# It sees only a staging directory with copies of those files; it did not take part in the run
# and has no access to this VCV checkout. Writes <run-dir>/independent-evaluation.md and the
# evaluator's own transcript.
set -euo pipefail

run=$(cd "${1:?usage: evaluate.sh <run-dir> [--model <model>]}" && pwd)
shift
model_args=()
[ "${1:-}" = "--model" ] && model_args=(--model "${2:?}")
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
vcv_home=$(cd "$here/../../.." && pwd)
work=$(mktemp -d)
stage="$work/review"
mkdir -p "$stage/run" "$work/home"
cp "$here/../changes/waitlist.patch" "$stage/"
cp "$vcv_home/docs/samples/m2.3-bootstrap/agent-output/model.yaml" "$stage/model-before.yaml"
cp "$here/../ORACLE.md" "$stage/"
(cd "$run" && cp -r agent-output change-records evidence setup.txt transcript.md hash-diff.txt git-status.txt agent-approve-attempt.txt "$stage/run/")
prompt=$(cat "$here/evaluate-prompt.md")
(
  cd "$stage"
  env -i HOME="$work/home" PATH="$PATH" LANG=C.UTF-8 \
    ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-}" ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
    HTTPS_PROXY="${HTTPS_PROXY:-}" HTTP_PROXY="${HTTP_PROXY:-}" NO_PROXY="${NO_PROXY:-}" \
    NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-}" SSL_CERT_FILE="${SSL_CERT_FILE:-}" \
    claude -p "$prompt" "${model_args[@]}" \
      --setting-sources project --strict-mcp-config \
      --tools Read Glob Grep \
      --permission-mode default \
      --allowedTools Read Glob Grep \
      --disallowedTools "Read(/$vcv_home/**)" "Grep(/$vcv_home/**)" "Glob(/$vcv_home/**)" \
      --max-turns 60 \
      --output-format stream-json --verbose < /dev/null
) > "$run/evaluator-transcript.jsonl"
node -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const r = lines.find((m) => m.type === "result");
  const init = lines.find((m) => m.type === "system" && m.subtype === "init");
  process.stdout.write(`<!-- independent evaluator: ${init.model}, tools ${init.tools.join(", ")}, ${r.num_turns} turns -->\n\n${r.result}\n`);
' "$run/evaluator-transcript.jsonl" > "$run/independent-evaluation.md"
echo "wrote $run/independent-evaluation.md"
