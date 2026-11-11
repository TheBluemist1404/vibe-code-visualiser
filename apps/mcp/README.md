# @vcv/mcp: local read-only MCP server

A thin [MCP](https://modelcontextprotocol.io) adapter over VCV's Semantic Query API
(`@vcv/query`). It lets any MCP-compatible coding agent (Claude Code, Codex, others) read the
versioned declared model (draft or approved) of **one** local model store, or of one
repository checkout's `.vcv/` project together with its read-only source evidence (`--repo`,
M2.5). Single user, local, stdio only.

It is transport only: each tool forwards its arguments to one `@vcv/query` operation and
returns that operation's result unchanged. Validation, limits, revision checks, cursors, errors
and diagnostics come from `@vcv/query`; the advertised input schemas are generated from its zod
request contracts. The evidence tools forward to `@vcv/repo`'s evidence API in the same way, and
`vcv evidence` in the CLI calls the same functions. The server behaves the same whichever client
calls it. See ADR 0006.

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

`snapshotStatus` is `draft` or `approved`. A draft may hold unresolved references, which appear
as edge targets `{ "unresolved": "..." }` and as `UNRESOLVED_REF` diagnostics; agents are told
to check it rather than treat a draft as agreed intent.

Error codes are the query package's `INVALID_REQUEST`, `UNKNOWN_ID`, `REVISION_MISMATCH`,
`INVALID_CURSOR`, plus the adapter's `STORE_ERROR` (the store could not be read) and
`INVALID_REQUEST` for an unknown tool name. Errors are returned as tool results with
`isError: true`; the server keeps running.

### Source-evidence tools (`--repo` only)

| MCP tool | Evidence operation | CLI |
|---|---|---|
| `vcv_get_evidence_overview` | `getEvidenceOverview` | `vcv evidence <path> overview` |
| `vcv_get_object_evidence` | `getObjectEvidence` | `vcv evidence <path> object <id>` |
| `vcv_get_binding_evidence` | `getBindingEvidence` | `vcv evidence <path> binding <bindingId>` |
| `vcv_refresh_evidence` | `refreshEvidence` | `vcv evidence <path> refresh` |

Read-only too (`vcv_refresh_evidence` is marked not idempotent because the working tree may have
changed between calls, but it never writes). Results, error codes (`UNKNOWN_BINDING`,
`PROJECT_NOT_READY`, `UNSAFE_PATH`, `STATE_CHANGED` in addition to the query codes) and limits
are described in [docs/evidence.md](../../docs/evidence.md). A claim is never presented as
verified meaning or approval: `context.meaning` is `"unverified"` and every claim has
`approval.approved: false`.

### Proposal tools (`--repo` only, M3.1)

| MCP tool | Operation | CLI |
|---|---|---|
| `vcv_list_proposals` | `listProposals` | `vcv proposal list <path>` |
| `vcv_preview_proposal` | `previewProposal` | `vcv proposal preview <path> <changeId>` (or `--file`) |

Read-only: they list recorded model change proposals with their derived lifecycle and preview
one (submitted, or a dry run of a change object) before anyone approves it. Submitting is not
offered over MCP; agents use the host's proposal-only `vcv proposal submit`. Details in
[docs/proposals.md](../../docs/proposals.md); extra error codes `UNKNOWN_CHANGE`,
`INVALID_RECORD`.

## Run it

Node 22.18+. From a VCV checkout:

```sh
npm ci
npm run vcv -- init /path/to/your-repo/.vcv-store examples/enrollment/model.rev-1.yaml   # once
node --experimental-strip-types apps/mcp/src/main.ts --store /path/to/your-repo/.vcv-store
```

- `--store <dir>` (or `VCV_STORE=<dir>`), or `--repo <checkout>` (or `VCV_REPO=<checkout>`), is
  **required**. There is no discovery of stores in the working directory or repository; one
  server serves one store. With `--repo`, the server serves the checkout's `.vcv/` (which must be
  `ready`, see `vcv project status`) and adds the four evidence tools.
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

1. `vcv_get_project_overview`, note `context.modelRevision` and `context.snapshotStatus`
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

- `apps/mcp/test/evidence.test.ts` checks that the CLI and the MCP evidence tools give identical
  results for the same requests on Course Desk, including malformed requests, conflicted and
  symlinked claim storage, and a project that stops being ready.

## Not included

No write, propose or approve tools; no HTTP or remote transport; no authentication; no source
indexing or repository-to-model mapping; no watcher (evidence is computed per call).
