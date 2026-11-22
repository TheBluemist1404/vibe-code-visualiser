# Design and browser tooling for agents

Vendored Claude Code skills that support UI/design work. Claude Code picks them
up from `.claude/skills/` and `.claude/agents/` when the repo is opened.

## Impeccable

- Upstream: https://github.com/pbakaus/impeccable (commit `b49177d`, skill v4.10.0, engine 0.1.27)
- License: Apache-2.0, copy at `.claude/skills/impeccable/LICENSE`; third-party notices at `.claude/skills/impeccable/NOTICE.md`
- Copied: `.claude/skills/impeccable/` (the Claude Code build) and `.claude/agents/impeccable-*.md` (its subagents), unmodified
- Use: `/impeccable [sub-command] [target]`, e.g. `/impeccable critique apps/web`, `/impeccable polish`

Not copied: the upstream `.claude/settings.json` design hook (SessionStart/PostToolUse/Stop).
Those hooks run outside model approval and download the engine binary on first run.
To opt in, run `npx impeccable install` locally or copy the hook block from upstream.

The skill's `scripts/impeccable` launcher downloads a checksum-verified engine binary
into `~/.impeccable/bin/` on first use. New-design flows fetch visual directions from
impeccable.style; disable its telemetry with `DO_NOT_TRACK=1` or
`npx impeccable telemetry off`.

## Chrome DevTools skills

- Upstream: https://github.com/ChromeDevTools/chrome-devtools-mcp (commit `ab911a6`, v1.13.0)
- License: Apache-2.0, copy at `docs/third-party/chrome-devtools-mcp.LICENSE`
- Copied, unmodified: `chrome-devtools`, `chrome-devtools-cli`, `a11y-debugging`,
  `debug-optimize-lcp`, `inspect-in-devtools`, `memory-leak-debugging`,
  `cookie-debugging`, `troubleshooting`

These skills drive the `chrome-devtools-mcp` server, which is **not** configured in
the repo. Add it locally (pinned to match the skills, usage statistics off):

```bash
claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@1.13.0 --no-usage-statistics
```

## Updating

Re-copy from a fresh upstream clone and update the commits above. Keep the
Chrome DevTools skills in step with the MCP server version, since they describe
that version's tools.
