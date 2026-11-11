# @vcv/mcp: local read-only MCP server

A thin [MCP](https://modelcontextprotocol.io) adapter over VCV's Semantic Query API
(`@vcv/query`). It lets any MCP-compatible coding agent (Claude Code, Codex, others) read the
approved architecture model of **one** local model store. Single user, local, stdio only.

It is transport only: each tool forwards its arguments to one `@vcv/query` operation and
returns that operation's result unchanged. Validation, limits, revision checks, cursors, errors
and diagnostics come from `@vcv/query`; the advertised input schemas are generated from its zod
request contracts. The server behaves the same whichever client calls it. See ADR 0006.

## Tools

| MCP tool | `@vcv/query` operation | Use it to |
|---|---|---|
| `vcv_get_project_overview` | `getProjectOverview` | start: modules, dependencies, exposed/consumed contracts, current `modelRevision` |
| `vcv_search_objects` | `searchObjects` | find objects by words (bounded, ranked, paged) |
| `vcv_get_context` | `getContext` | inspect one ID and its declared relationships |
| `vcv_analyze_impact` | `analyzeImpact` | structural change candidates for 1–20 IDs |

All four are annotated `readOnlyHint: true`. Every result is the `QueryResult` JSON, as
`structuredContent` and as a text block:

```jsonc
{ "ok": true,
  "context": { "projectId": "prj-lms", "modelRevision": "rev-1", "snapshotStatus": "approved",
               "source": "canonical-ir", "coverage": "model-only", "implementationChecked": false },
  "data": { /* operation result */ }, "diagnostics": [] }
// or
{ "ok": false, "context": { /* when a snapshot was read */ },
  "error": { "code": "UNKNOWN_ID", "message": "...", "details": [ /* for INVALID_REQUEST */ ] } }
```

Error codes are the query package's `INVALID_REQUEST`, `UNKNOWN_ID`, `REVISION_MISMATCH`,
`INVALID_CURSOR`, plus the adapter's `STORE_ERROR` (the store could not be read) and
`INVALID_REQUEST` for an unknown tool name. Errors are returned as tool results with
`isError: true`; the server keeps running.

## Run it

Node 22.18+. From a VCV checkout:

```sh
npm ci
npm run vcv -- init /path/to/your-repo/.vcv-store examples/enrollment/model.rev-1.yaml   # once
node --experimental-strip-types apps/mcp/src/main.ts --store /path/to/your-repo/.vcv-store
```

- `--store <dir>` (or `VCV_STORE=<dir>`) is **required**. There is no discovery of stores in
  the working directory or repository; one server serves one store.
- The server exits with status 2 and a message on stderr if the store is missing, not
  initialized or unreadable.
- stdout carries JSON-RPC only; all diagnostics go to stderr. Launch it with `node`
  directly, not `npm run`, because npm prints a banner on stdout.
- It never writes to the store (no recovery, no audit lines). It re-reads `HEAD` on every call,
  so a change approved with `vcv approve` while the server runs is visible on the next call,
  and a call that passes the old `expectedRevision` gets `REVISION_MISMATCH`.

## Configure a client

**Claude Code**, project-scoped (`.mcp.json` in your repository, see
[`examples/claude-code.mcp.json`](examples/claude-code.mcp.json); Claude Code expands `${VAR}`):

```json
{ "mcpServers": { "vcv": { "type": "stdio", "command": "node",
  "args": ["--experimental-strip-types", "${VCV_HOME}/apps/mcp/src/main.ts", "--store", "${VCV_STORE}"] } } }
```

or with the CLI:

```sh
claude mcp add --scope project vcv -- node --experimental-strip-types \
  /abs/path/vibe-code-visualiser/apps/mcp/src/main.ts --store /abs/path/your-repo/.vcv-store
```

Claude Code shows the tools as `mcp__vcv__vcv_get_project_overview` and so on.

**Codex CLI**: [`examples/codex.config.toml`](examples/codex.config.toml).
**Any other client** that takes the common `mcpServers` JSON: [`examples/generic.mcp.json`](examples/generic.mcp.json).
Use absolute paths unless the client documents its working directory.

## Agent guidance (opt-in)

The server sends short usage instructions at initialize. For stronger, persistent guidance,
copy a template section into your repository yourself; VCV never edits instruction files:

- [`templates/AGENTS.md`](templates/AGENTS.md) for agents that read `AGENTS.md` (Codex and others)
- [`templates/CLAUDE.md`](templates/CLAUDE.md) for Claude Code

Both describe the same workflow:

1. `vcv_get_project_overview`, note `context.modelRevision`
2. `vcv_search_objects` to find the objects in question
3. `vcv_get_context` on their IDs
4. `vcv_analyze_impact` when a change is being considered
5. pass `expectedRevision` throughout; restart on `REVISION_MISMATCH`
6. verify in the source code and tests, and report model and code findings separately

Results describe declared intent only (`implementationChecked: false`). A successful query
never certifies the repository.

## Tests and demo

- `apps/mcp/test/mcp.test.ts` starts the real server as a child process on a temporary
  Enrollment store and drives it with the official MCP client (`npm test`).
- `apps/mcp/demo/run-claude-demo.sh` runs the manual Claude Code demo; a recorded run is in
  [`docs/samples/mcp-agent-demo.md`](../../docs/samples/mcp-agent-demo.md).

## Not included (M1 boundaries)

No write, propose or approve tools; no HTTP or remote transport; no authentication; no source
indexing or repository-to-model mapping.
