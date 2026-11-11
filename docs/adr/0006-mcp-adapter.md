# ADR 0006: Local read-only MCP adapter (M1)

Status: proposed for review (2026-11-11). Implements M1 of the local-first MVP roadmap
(Issue #4) on top of ADR 0005.

## Context

VCV is interface-agnostic: the canvas, the integrated consultant, the CLI and external MCP
agents are callers of the same application contracts. M1 gives external coding agents read
access to the model, draft or approved (each result's `context.snapshotStatus` says
which, and guidance tells agents not to treat a draft as agreed intent); it must not introduce agent-specific domain logic or a second state model.

## Decisions

1. **Package.** `apps/mcp` (`@vcv/mcp`) depends on `@vcv/query`, `@vcv/core` (for the store
   reader only) and `@modelcontextprotocol/sdk` 1.32.2. `createVcvMcpServer(api)` takes any
   `QueryApi`, so the same server can be built over a `MemoryStore` or a future store.
2. **Transport only.** Each tool calls one `@vcv/query` function with the raw arguments and
   returns the `QueryResult` unchanged (as `structuredContent` and as JSON text). No traversal,
   ranking, validation or data access lives in the adapter.
3. **Schemas come from the query contracts.** Tool `inputSchema`s are generated with
   `z.toJSONSchema(<request schema>, { io: "input" })`. A test asserts they are identical, so
   the advertised schema cannot drift from what `@vcv/query` accepts.
4. **Low-level SDK `Server`, not `McpServer`.** `McpServer.registerTool` validates arguments
   itself and answers with its own error text. Using the low-level server keeps validation in
   one place and returns the query package's structured `INVALID_REQUEST` details to the agent.
   (`Server` is marked "for advanced use" in SDK 1.x; revisit if SDK 2 changes this.)
5. **Errors are tool results.** Query errors, unknown tool names and store read failures
   (`STORE_ERROR`) come back with `isError: true` so the agent can read and recover; the
   process keeps serving. Only startup problems (no store, uninitialized or unreadable store,
   unknown flag) exit, with status 2 and a message on stderr.
6. **One explicit store.** `--store <dir>` or `VCV_STORE`. No discovery, no multi-project
   access.
7. **Read-only store access: `FileStoreReader`.** Added to `@vcv/core`. Unlike `FileStore` it
   never writes (no recovery, no directory creation, no audit) and re-reads `HEAD` on each
   `current()`, caching the parsed revision by ID. This is safe without recovery because a
   revision file is written before `HEAD` names it and never rewritten, and `HEAD` is replaced
   atomically; interrupted-commit leftovers are not in `HEAD` and are never read. Consequences:
   a long-running server sees revisions committed by the CLI, `expectedRevision` works across
   that boundary, and querying a store changes nothing on disk. Recovery still happens when a
   writer (`FileStore`) next opens the store.
8. **Guidance at three levels**, all provider-neutral: tool descriptions (each states IR-only,
   bounds and `expectedRevision`), the MCP `instructions` sent at initialize, and opt-in
   `AGENTS.md` / `CLAUDE.md` templates the user copies in themselves.
9. **No identity in M1.** Read-only queries need no principal. Write tools in a later milestone
   must get the principal from the trusted host and go through `ModelEngine`, as the CLI does.

## Risks / open points

- **Discoverability.** Claude Code may defer MCP tool schemas behind a tool search; in the
  recorded demo the agent found and loaded the VCV tools unprompted, with and without the
  `CLAUDE.md` template, but other clients and vaguer questions may not. The templates are the
  mitigation; their wording is a first draft.
- **Agents rarely page.** In the demo the agent never followed a `truncated` context result
  with a larger budget. Fine on the small fixture; on a large model this could hide neighbours.
- **File-store lifecycle.** Single writer is still assumed (ADR 0003). A reader racing a writer
  is safe for the reasons above, but each call re-reads `HEAD` and may parse a new revision file;
  for very large models a cheaper change check (mtime) may be needed.
- **Input budgets.** Tool arguments reach zod validation, so the zod minimum is `^4.6.6` in
  every package that imports it (past GHSA-mrhx-c7xc-m3w5, memory exhaustion validating
  oversized collections), and every request array is capped in `@vcv/query`: `kinds` ≤ 11 and
  `relations` ≤ 19 (one entry per value), `ids` ≤ 20. An oversized array is refused with one
  `INVALID_REQUEST` detail before its elements are checked.
