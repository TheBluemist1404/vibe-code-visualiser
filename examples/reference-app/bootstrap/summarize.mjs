// Condense a Claude Code stream-json transcript into Markdown and audit agent isolation.
//   node summarize.mjs <transcript.jsonl> <vcv-checkout-path>
// Exit code 2 if any tool call touched the VCV checkout or mentioned the reviewer oracle.
import { readFileSync } from "node:fs";

const [file, vcvHome] = process.argv.slice(2);
const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
const forbidden = [vcvHome, "ORACLE", "reference-app"].filter(Boolean);
const out = [];
const violations = [];
let calls = 0;
const clip = (s, n = 400) => (s.length > n ? s.slice(0, n) + ` … (${s.length - n} more chars)` : s);

for (const line of lines) {
  const m = JSON.parse(line);
  if (m.type === "system" && m.subtype === "init") {
    out.push(
      "# Agent transcript (condensed)",
      "",
      `- model: \`${m.model}\``,
      `- cwd: \`${m.cwd}\``,
      `- tools: ${m.tools.join(", ")}`,
      `- MCP servers: ${JSON.stringify(m.mcp_servers)}`,
      `- memory: ${JSON.stringify(m.memory_paths ?? null)}; additional directories: ${JSON.stringify(m.additional_directories ?? [])}`,
      "",
    );
  }
  if (m.type === "assistant") {
    for (const c of m.message.content) {
      if (c.type === "text" && c.text.trim()) out.push("", `> ${clip(c.text.trim(), 1200).replace(/\n/g, "\n> ")}`, "");
      if (c.type === "tool_use") {
        calls++;
        const input = JSON.stringify(c.input);
        const hit = forbidden.find((f) => input.includes(f));
        if (hit) violations.push(`${c.name} ${input}`);
        const shown =
          c.name === "Bash" ? c.input.command : c.name === "Write" ? `${c.input.file_path} (${(c.input.content ?? "").length} chars)` : input;
        out.push(`${calls}. **${c.name}** \`${clip(String(shown), 300).replace(/`/g, "'").replace(/\n/g, " ⏎ ")}\`${hit ? " ⚠ ISOLATION" : ""}`);
      }
    }
  }
  if (m.type === "user" && Array.isArray(m.message?.content)) {
    for (const c of m.message.content) {
      if (c.type !== "tool_result") continue;
      const text = Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join("") : String(c.content ?? "");
      // Keep VCV's own feedback to the agent (validation, status), not file dumps.
      if (/: (valid|invalid)\n|project: |✗ [A-Z_]+|! [A-Z_]+ at /.test(text) && text.length < 6000) {
        out.push("   ```", "   " + clip(text.trim(), 2000).replace(/\n/g, "\n   "), "   ```");
      }
    }
  }
  if (m.type === "result") {
    out.push("", `## Result (${m.subtype})`, "", `turns: ${m.num_turns}, duration: ${Math.round(m.duration_ms / 1000)} s, cost: $${m.total_cost_usd?.toFixed(2)}`, "", m.result ?? "");
  }
}
out.push(
  "",
  "## Isolation audit",
  "",
  `${calls} tool calls checked for ${forbidden.map((f) => `\`${f}\``).join(", ")}: ${violations.length ? `${violations.length} violation(s)` : "none found"}.`,
);
for (const v of violations) out.push(`- ${clip(v)}`);
console.log(out.join("\n"));
if (violations.length) process.exitCode = 2;
